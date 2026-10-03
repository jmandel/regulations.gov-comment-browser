// Gemini Batch API backend for step-runner.ts (half the price of live calls; target turnaround 24h).
//
// Contract:
// - runGeminiBatch(requests, opts) submits all requests (all share one model) as Gemini batch
//   job(s), polls until done, and calls opts.onResult once per request with its text/usage or error.
// - Jobs are recorded in the batch_jobs table (job_name, task, label, model, request_keys, state)
//   before polling, so if the process restarts, a call with the same label and the same request
//   keys resumes polling the existing job instead of resubmitting.
// - Requests whose key never appears in the results are reported via onResult with an error.
//
// How it works:
// - The installed @google/genai (1.5.x) has no batches API, so job create/get/download go through
//   the REST API directly (https://ai.google.dev/gemini-api/docs/batch-mode, reference:
//   https://ai.google.dev/api/batch-mode). The SDK is only used for the Files API upload.
// - Requests are always submitted as an uploaded JSONL file, one {"key", "request"} line each, and
//   results come back as a JSONL file whose lines carry the same key. That keeps big inline PDFs
//   off the 20 MB inline-request limit and maps results by key rather than by position.
// - Input files are capped at 2 GB by the API; we split at MAX_FILE_BYTES into several jobs.
// - Each job's displayName carries a hash of its requests' content, so a resumed job is only
//   reused when the prompts are unchanged, not merely the keys.

import type { Database } from "bun:sqlite";
import type { GenerateContentConfig, Part } from "@google/genai";
import { createHash } from "crypto";
import { getGeminiClient, resolveGeminiModel, toUsage, type UsageMetadata } from "./llm-providers";
import type { LlmRequest } from "./step-runner";

export interface BatchResult {
  key: string;
  text?: string;
  usage?: UsageMetadata;
  error?: string;
}

export interface BatchOptions {
  db: Database;
  task: string;
  label: string;
  onResult: (res: BatchResult) => void | Promise<void>;
  pollIntervalMs?: number;           // first poll delay; grows 1.5x per poll up to MAX_POLL_MS
}

const API = "https://generativelanguage.googleapis.com";
const MAX_FILE_BYTES = 1_000_000_000; // API limit is 2 GB per input file; stay well under it
const MAX_POLL_MS = 5 * 60_000;
// SUCCEEDED_WITH_ERRORS is ours: the job finished but some requests in it failed. Such a job is
// never reused, so a retry resubmits the failed requests instead of re-reading the same errors.
const FAILED_STATES = new Set(["FAILED", "CANCELLED", "EXPIRED", "SUCCEEDED_WITH_ERRORS"]);

// Fields of the SDK's flat GenerateContentConfig that are top-level in a REST GenerateContentRequest;
// everything else belongs in generationConfig.
const TOP_LEVEL_CONFIG = new Set(["systemInstruction", "safetySettings", "tools", "toolConfig", "cachedContent", "labels"]);
const CLIENT_ONLY_CONFIG = new Set(["httpOptions", "abortSignal"]);

interface Job {
  name: string;
  keys: string[];
  state: string;
  done: boolean;
}

// The API reports e.g. BATCH_STATE_RUNNING (REST) or JOB_STATE_RUNNING (SDK docs); keep the suffix
function normState(s: string | undefined): string {
  return (s || "UNKNOWN").replace(/^(BATCH|JOB)_STATE_/, "");
}

function apiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY environment variable is required");
  return key;
}

// REST call with retries on 429/5xx and network errors
async function rest(method: string, path: string, body?: unknown): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    let status = 0;
    let msg = "";
    try {
      const res = await fetch(`${API}/${path}`, {
        method,
        headers: { "x-goog-api-key": apiKey(), "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.ok) return path.includes(":download") ? await res.text() : await res.json();
      status = res.status;
      msg = `${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 500)}`;
    } catch (e) {
      msg = `${method} ${path}: ${(e as Error).message}`;
    }
    const retryable = status === 0 || status === 429 || status >= 500;
    if (!retryable || attempt >= 5) throw new Error(msg);
    const backoff = Math.min(5000 * Math.pow(2, attempt), 60000);
    console.log(`   🔄 Batch API ${status || "network error"}, retrying in ${backoff / 1000}s...`);
    await new Promise(r => setTimeout(r, backoff));
  }
}

// SDK-style request (model default config + overrides) → REST GenerateContentRequest
function toRestRequest(parts: Part[], config: GenerateContentConfig): any {
  const req: any = { contents: [{ role: "user", parts }] };
  const generationConfig: any = {};
  for (const [k, v] of Object.entries(config)) {
    if (v === undefined || CLIENT_ONLY_CONFIG.has(k)) continue;
    if (k === "systemInstruction" && typeof v === "string") req.systemInstruction = { parts: [{ text: v }] };
    else if (TOP_LEVEL_CONFIG.has(k)) req[k] = v;
    else generationConfig[k] = v;
  }
  if (Object.keys(generationConfig).length) req.generationConfig = generationConfig;
  return req;
}

// Hash of a job's request lines, stored in the job's displayName to validate resumes
function contentHash(lines: string[]): string {
  const h = createHash("sha256");
  for (const l of lines) h.update(l).update("\n");
  return h.digest("hex").slice(0, 16);
}

function jobState(job: any): string {
  return normState(job?.metadata?.state ?? job?.state);
}

// Text of the first candidate, skipping thought parts (matches response.text in the SDK)
function extractText(response: any): { text?: string; error?: string } {
  const cand = response?.candidates?.[0];
  if (!cand) {
    const reason = response?.promptFeedback?.blockReason;
    return { error: `No candidates in response${reason ? ` (blocked: ${reason})` : ""}` };
  }
  const parts: any[] = cand.content?.parts || [];
  return { text: parts.filter(p => typeof p.text === "string" && !p.thought).map(p => p.text).join("") };
}

export async function runGeminiBatch(requests: LlmRequest[], opts: BatchOptions): Promise<void> {
  if (requests.length === 0) return;
  const model = requests[0].model;
  if (requests.some(r => r.model !== model)) throw new Error("runGeminiBatch: all requests must share one model");
  const { id: modelId, config: baseConfig } = resolveGeminiModel(model);
  const { db, task, label } = opts;

  // Build one JSONL line per request (base64 PDFs make these large; never join them all)
  const lineByKey = new Map<string, string>();
  for (const r of requests) {
    if (lineByKey.has(r.key)) throw new Error(`runGeminiBatch: duplicate request key ${r.key}`);
    const request = toRestRequest(r.parts, { ...baseConfig, ...r.config });
    lineByKey.set(r.key, JSON.stringify({ key: r.key, request }));
  }

  const upsert = db.prepare(`
    INSERT INTO batch_jobs (job_name, task, label, model, request_keys, state, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(job_name) DO UPDATE SET state = excluded.state, updated_at = CURRENT_TIMESTAMP`);
  const setState = db.prepare("UPDATE batch_jobs SET state = ?, updated_at = CURRENT_TIMESTAMP WHERE job_name = ?");

  // Resume: reuse recorded jobs for this label that cover still-requested keys. When every key of
  // the job is still requested, its content hash must match (prompts unchanged). When only some
  // are (a previous run saved part of the job's results before stopping), reuse it for the rest
  // rather than paying for those requests again.
  const jobs: Job[] = [];
  const covered = new Set<string>();
  const recorded = db.prepare(
    "SELECT job_name, request_keys, state FROM batch_jobs WHERE label = ? AND model = ? ORDER BY created_at DESC"
  ).all(label, model) as { job_name: string; request_keys: string; state: string }[];
  for (const row of recorded) {
    if (FAILED_STATES.has(row.state)) continue;
    const allKeys: string[] = JSON.parse(row.request_keys);
    const keys = allKeys.filter(k => lineByKey.has(k) && !covered.has(k));
    if (!keys.length) continue;
    const partial = keys.length < allKeys.length;
    let job: any;
    try {
      job = await rest("GET", `v1beta/${row.job_name}`);
    } catch (e) {
      console.log(`   ⚠️  Could not fetch recorded batch ${row.job_name}: ${(e as Error).message.slice(0, 200)}`);
      continue;
    }
    const state = jobState(job);
    setState.run(state, row.job_name);
    const displayName: string = job?.metadata?.displayName ?? job?.displayName ?? "";
    if (FAILED_STATES.has(state)) continue;
    if (!partial && !displayName.endsWith(contentHash(keys.map(k => lineByKey.get(k)!)))) continue;
    console.log(`♻️  [${task}] Resuming batch ${row.job_name} (${keys.length}${partial ? ` of ${allKeys.length} still needed` : ""} requests, ${state})`);
    jobs.push({ name: row.job_name, keys, state, done: false });
    for (const k of keys) covered.add(k);
  }

  // Submit the rest, split so no input file exceeds MAX_FILE_BYTES
  const todo = requests.map(r => r.key).filter(k => !covered.has(k));
  const chunks: string[][] = [];
  let cur: string[] = [];
  let curBytes = 0;
  for (const k of todo) {
    const bytes = Buffer.byteLength(lineByKey.get(k)!) + 1;
    if (cur.length && curBytes + bytes > MAX_FILE_BYTES) { chunks.push(cur); cur = []; curBytes = 0; }
    cur.push(k);
    curBytes += bytes;
  }
  if (cur.length) chunks.push(cur);

  const ai = chunks.length ? getGeminiClient() : null;
  for (const [i, keys] of chunks.entries()) {
    const lines = keys.map(k => lineByKey.get(k)!);
    const hash = contentHash(lines);
    const displayName = `${label}`.replace(/[^\w.:-]/g, "_").slice(0, 80) + `#${hash}`;
    const blob = new Blob(lines.flatMap(l => [l, "\n"]), { type: "application/jsonl" });
    const mb = (blob.size / 1e6).toFixed(1);
    console.log(`📤 [${task}] Uploading batch input ${i + 1}/${chunks.length} (${keys.length} requests, ${mb} MB)...`);
    const file = await ai!.files.upload({ file: blob, config: { mimeType: "application/jsonl", displayName } });
    const job = await rest("POST", `v1beta/models/${modelId}:batchGenerateContent`, {
      batch: { displayName, inputConfig: { fileName: file.name } },
    });
    const state = jobState(job);
    upsert.run(job.name, task, label, model, JSON.stringify(keys), state);
    console.log(`🚀 [${task}] Created batch ${job.name} (${keys.length} requests on ${modelId})`);
    jobs.push({ name: job.name, keys, state, done: false });
  }

  // The request lines (with base64 attachments) aren't needed once uploaded; free them so several
  // large submissions can poll at once
  lineByKey.clear();

  // Poll all jobs until each reaches a terminal state, delivering results as each finishes
  const start = Date.now();
  let delay = opts.pollIntervalMs ?? 30_000;
  const deliver = async (job: Job, body: any) => {
    let errors = 0;
    const onResult = async (r: BatchResult) => { if (r.error) errors++; await opts.onResult(r); };
    const output = body?.response ?? body?.metadata?.output ?? {};
    const seen = new Set<string>();
    const wanted = new Set(job.keys);
    if (output.responsesFile) {
      const text: string = await rest("GET", `download/v1beta/${output.responsesFile}:download?alt=media`);
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let r: any;
        try { r = JSON.parse(line); } catch { continue; }
        const key = r.key ?? r.metadata?.key;
        if (typeof key !== "string" || !wanted.has(key) || seen.has(key)) continue;
        seen.add(key);
        if (r.error) {
          await onResult({ key, error: `Batch request error ${r.error.code ?? ""}: ${r.error.message ?? JSON.stringify(r.error)}` });
          continue;
        }
        const { text: out, error } = extractText(r.response);
        await onResult(error ? { key, error } : { key, text: out, usage: toUsage(r.response?.usageMetadata) });
      }
    }
    for (const key of job.keys) {
      if (!seen.has(key)) await onResult({ key, error: `No result for request in batch ${job.name}` });
    }
    if (errors > 0) setState.run("SUCCEEDED_WITH_ERRORS", job.name);
  };

  while (jobs.some(j => !j.done)) {
    for (const job of jobs.filter(j => !j.done)) {
      let body: any;
      try {
        body = await rest("GET", `v1beta/${job.name}`);
      } catch (e) {
        console.log(`   ⚠️  Polling ${job.name} failed: ${(e as Error).message.slice(0, 200)}`);
        continue;
      }
      const state = jobState(body);
      if (state !== job.state) setState.run(state, job.name);
      job.state = state;
      if (state === "SUCCEEDED") {
        job.done = true;
        console.log(`✅ [${task}] Batch ${job.name} succeeded after ${fmtElapsed(start)}`);
        await deliver(job, body);
        await deleteInputFile(body);
      } else if (FAILED_STATES.has(state) || body?.error) {
        job.done = true;
        const why = body?.error?.message ? `: ${body.error.message}` : "";
        console.log(`❌ [${task}] Batch ${job.name} ended ${state}${why}`);
        for (const key of job.keys) await opts.onResult({ key, error: `Batch ${job.name} ended ${state}${why}` });
        await deleteInputFile(body);
      }
    }
    const waiting = jobs.filter(j => !j.done);
    if (!waiting.length) break;
    const states = waiting.map(j => j.state).join(", ");
    console.log(`   ⏳ [${task}] ${waiting.length}/${jobs.length} batch job(s) ${states}; ${fmtElapsed(start)} elapsed, next check in ${Math.round(delay / 1000)}s`);
    await new Promise(r => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, MAX_POLL_MS);
  }
}

// Input files count against the project's 20 GB file storage until the API expires them (48h);
// large PDF runs can approach that, so delete each one once its job is finished
async function deleteInputFile(job: any): Promise<void> {
  const fileName: string | undefined = job?.metadata?.inputConfig?.fileName ?? job?.inputConfig?.fileName;
  if (!fileName) return;
  try {
    await rest("DELETE", `v1beta/${fileName}`);
  } catch (e) {
    // 403/404: already deleted (e.g. when re-reading a finished job's results after a restart)
    if (!/→ 40[34]/.test((e as Error).message)) console.log(`   ⚠️  Could not delete batch input ${fileName}: ${(e as Error).message.slice(0, 200)}`);
  }
}

function fmtElapsed(start: number): string {
  const s = Math.round((Date.now() - start) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}
