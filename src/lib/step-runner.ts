// Shared runner for per-item LLM steps (triage, transcribe, condense, theme gating/extraction).
//
// A step builds a list of requests and a handler; the runner sends them either live (parallel
// calls with retries) or through the Gemini Batch API (50% cheaper, minutes-to-hours latency),
// and calls the handler once per finished request. Text-only requests are cached in llm_cache,
// so re-running a step only pays for what changed.

import type { Database } from "bun:sqlite";
import type { Part, GenerateContentConfig } from "@google/genai";
import { createHash } from "crypto";
import { generateGeminiContent, GEMINI_MODELS, type UsageMetadata } from "./llm-providers";
import { runGeminiBatch } from "./gemini-batch";
import { runPool } from "./worker-pool";

export interface LlmRequest {
  key: string;                       // unique within one run; returned with the response
  model: string;                     // a GEMINI_MODELS name, e.g. "gemini-3.5-flash-lite"
  parts: Part[];
  config?: GenerateContentConfig;    // merged over the model's default config
}

export interface LlmResponse {
  key: string;
  text: string;
  usage?: UsageMetadata;
  cached?: boolean;
}

export interface RunOptions {
  db: Database;
  task: string;                      // step name, used for llm_cache.task_type and batch job labels
  mode?: "live" | "batch";
  concurrency?: number;              // live mode
  label?: string;                    // batch mode: identifies this submission so it can be resumed
}

export interface RunSummary {
  ok: number;
  failed: number;
  cached: number;
  usage: { input: number; cachedInput: number; output: number; thoughts: number };
  costUsd: number;
}

// $ per 1M tokens [input, output, cached input]; batch mode is billed at half
const PRICES: Record<string, [number, number, number]> = {
  "gemini-3.8-flash": [0.75, 3.75, 0.075],
  "gemini-3.5-flash-lite": [0.30, 2.50, 0.03],
  "gemini-3-flash": [0.50, 3.00, 0.05],
};

export function estimateCost(model: string, u: UsageMetadata, batch = false): number {
  const p = PRICES[model];
  if (!p) return 0;
  const fresh = u.promptTokenCount - u.cachedContentTokenCount;
  const cost = (fresh * p[0] + u.cachedContentTokenCount * p[2] + (u.candidatesTokenCount + (u.thoughtsTokenCount || 0)) * p[1]) / 1e6;
  return batch ? cost / 2 : cost;
}

function cacheKey(req: LlmRequest): string | null {
  if (req.parts.some(p => !p.text)) return null; // binary parts: not cached
  const h = createHash("sha256");
  h.update(req.model);
  h.update(JSON.stringify(req.config || {}));
  for (const p of req.parts) h.update(p.text!);
  return h.digest("hex");
}

export async function runLlmRequests(
  requests: LlmRequest[],
  handle: (req: LlmRequest, res: LlmResponse) => void | Promise<void>,
  opts: RunOptions
): Promise<RunSummary> {
  const mode = opts.mode || "live";
  const summary: RunSummary = { ok: 0, failed: 0, cached: 0, usage: { input: 0, cachedInput: 0, output: 0, thoughts: 0 }, costUsd: 0 };
  for (const r of requests) {
    if (!GEMINI_MODELS[r.model]) throw new Error(`Unknown model ${r.model} for request ${r.key}`);
  }

  const getCached = opts.db.prepare("SELECT result FROM llm_cache WHERE prompt_hash = ?");
  const putCached = opts.db.prepare(
    "INSERT OR REPLACE INTO llm_cache (prompt_hash, task_type, task_level, task_params, result, model) VALUES (?, ?, 0, ?, ?, ?)"
  );

  const finish = async (req: LlmRequest, res: LlmResponse) => {
    try {
      await handle(req, res);
      summary.ok++;
    } catch (e) {
      summary.failed++;
      console.error(`\n❌ [${opts.task}] ${req.key}: handler failed: ${(e as Error).message}`);
      return;
    }
    if (res.cached) { summary.cached++; return; }
    const key = cacheKey(req);
    if (key) putCached.run(key, opts.task, JSON.stringify({ key: req.key }), res.text, req.model);
    if (res.usage) {
      summary.usage.input += res.usage.promptTokenCount;
      summary.usage.cachedInput += res.usage.cachedContentTokenCount;
      summary.usage.output += res.usage.candidatesTokenCount;
      summary.usage.thoughts += res.usage.thoughtsTokenCount || 0;
      summary.costUsd += estimateCost(req.model, res.usage, mode === "batch");
    }
  };

  // Serve cache hits first
  const pending: LlmRequest[] = [];
  for (const req of requests) {
    const key = cacheKey(req);
    const hit = key ? (getCached.get(key) as { result: string } | null) : null;
    if (hit) await finish(req, { key: req.key, text: hit.result, cached: true });
    else pending.push(req);
  }

  const total = pending.length;
  console.log(`🤖 [${opts.task}] ${requests.length} requests: ${summary.cached} cached, ${total} to run (${mode})`);

  if (mode === "live") {
    let done = 0;
    await runPool(pending, opts.concurrency || 10, async (req) => {
      try {
        const result = await generateGeminiContent(req.model, req.parts, req.config);
        await finish(req, { key: req.key, text: result.text, usage: result.usageMetadata });
      } catch (e) {
        summary.failed++;
        console.error(`\n❌ [${opts.task}] ${req.key}: ${(e as Error).message?.slice(0, 300)}`);
      }
      done++;
      if (done % 25 === 0 || done === total) {
        process.stdout.write(`\r   [${opts.task}] ${done}/${total} done, ${summary.failed} failed, ~$${summary.costUsd.toFixed(2)}`);
      }
    });
    if (total > 0) console.log();
  } else {
    // One batch job per model
    const byModel = new Map<string, LlmRequest[]>();
    for (const req of pending) {
      if (!byModel.has(req.model)) byModel.set(req.model, []);
      byModel.get(req.model)!.push(req);
    }
    for (const [model, reqs] of byModel) {
      const byKey = new Map(reqs.map(r => [r.key, r]));
      await runGeminiBatch(reqs, {
        db: opts.db,
        task: opts.task,
        label: `${opts.label || opts.task}:${model}`,
        onResult: async (res) => {
          const req = byKey.get(res.key);
          if (!req) return;
          if (res.error) {
            summary.failed++;
            console.error(`\n❌ [${opts.task}] ${res.key}: ${res.error.slice(0, 300)}`);
            return;
          }
          await finish(req, { key: res.key, text: res.text || "", usage: res.usage });
        },
      });
    }
  }

  const u = summary.usage;
  console.log(`   [${opts.task}] ok=${summary.ok} failed=${summary.failed} cached=${summary.cached} | tokens in=${u.input} (cached ${u.cachedInput}) out=${u.output} thoughts=${u.thoughts} | ~$${summary.costUsd.toFixed(2)}${mode === "batch" ? " (batch price)" : ""}`);
  return summary;
}
