import { debugSave } from "./debug";
import { parseJsonResponse } from "./json-parser";
import { createHash } from "crypto";
import { Database } from "bun:sqlite";
import { getGenerationFunction, getMultimodalGenerationFunction, generateGeminiContent, GEMINI_MODELS, DEFAULT_MODEL, type UsageMetadata } from "./llm-providers";
import { estimateCost, type RunSummary } from "./step-runner";
import type { Part } from "@google/genai";

// Token/cost totals per label (a step phase or task type), printed at the end of a step.
export interface UsageRow { calls: number; cached: number; failed: number; input: number; cachedInput: number; output: number; thoughts: number; costUsd: number }

export class UsageTally {
  rows = new Map<string, UsageRow>();
  private started = Date.now();

  private row(label: string): UsageRow {
    if (!this.rows.has(label)) this.rows.set(label, { calls: 0, cached: 0, failed: 0, input: 0, cachedInput: 0, output: 0, thoughts: 0, costUsd: 0 });
    return this.rows.get(label)!;
  }

  // One runLlmRequests summary
  addSummary(label: string, s: RunSummary) {
    const r = this.row(label);
    r.calls += s.ok + s.failed - s.cached; r.cached += s.cached; r.failed += s.failed;
    r.input += s.usage.input; r.cachedInput += s.usage.cachedInput; r.output += s.usage.output; r.thoughts += s.usage.thoughts;
    r.costUsd += s.costUsd;
  }

  // One live call
  addUsage(label: string, model: string, u: UsageMetadata | undefined, batch = false) {
    const r = this.row(label);
    r.calls++;
    if (!u) return;
    r.input += u.promptTokenCount; r.cachedInput += u.cachedContentTokenCount; r.output += u.candidatesTokenCount; r.thoughts += u.thoughtsTokenCount || 0;
    r.costUsd += estimateCost(model, u, batch);
  }

  addCached(label: string) { this.row(label).cached++; }

  total(): UsageRow {
    const t: UsageRow = { calls: 0, cached: 0, failed: 0, input: 0, cachedInput: 0, output: 0, thoughts: 0, costUsd: 0 };
    for (const r of this.rows.values()) for (const k of Object.keys(t) as (keyof UsageRow)[]) t[k] += r[k];
    return t;
  }

  print(title: string) {
    if (this.rows.size === 0) return;
    const fmt = (label: string, r: UsageRow) =>
      `  ${label.padEnd(22)} calls=${r.calls} (cached ${r.cached}, failed ${r.failed}) | in=${r.input.toLocaleString()} (cached ${r.cachedInput.toLocaleString()}) out=${r.output.toLocaleString()} thoughts=${r.thoughts.toLocaleString()} | ~$${r.costUsd.toFixed(3)}`;
    console.log(`\n💰 ${title} — ${((Date.now() - this.started) / 60000).toFixed(1)} min`);
    for (const [label, r] of this.rows) console.log(fmt(label, r));
    if (this.rows.size > 1) console.log(fmt("total", this.total()));
  }
}

export interface CacheMetadata {
  taskType: string;
  taskLevel?: number;
  params?: any;
}

export type PostProcessFn<T = string> = (response: string) => T;

export class AIClient {
  private static activeJobs = new Set<string>();
  private db?: Database;
  private modelKey?: string;
  // Tokens and estimated cost of the live calls this client made, by metadata.taskType
  readonly usage = new UsageTally();
  
  constructor(modelKey?: string, db?: Database) {
    this.modelKey = modelKey;
    this.db = db;
  }
  
  async generateContent<T = string>(
    prompt: string, 
    debugPrefix?: string, 
    jobId?: string,
    metadata?: CacheMetadata,
    postProcess?: PostProcessFn<T>,
    timeout?: number
  ): Promise<T> {
    const workerId = jobId || debugPrefix || `worker_${Date.now()}`;
    const modelName = this.modelKey || DEFAULT_MODEL;
    // The model is part of the key, so switching models doesn't return another model's answer
    const promptHash = createHash('sha256').update(`${modelName}\n${prompt}`).digest('hex');
    
    // Check cache if database is available
    if (this.db && metadata) {
      
      try {
        const cached = this.db.prepare(`
          SELECT result FROM llm_cache 
          WHERE prompt_hash = ?
        `).get(promptHash) as { result: string } | undefined;
        
        if (cached) {
          console.log(`   ✅ [${workerId}] Using cached result [${promptHash.substring(0, 8)}...]`);
          this.usage.addCached(metadata.taskType);
          // Apply postprocessing to cached result if provided
          if (postProcess) {
            try {
              return postProcess(cached.result);
            } catch (error) {
              console.warn(`   ⚠️  [${workerId}] Cached result failed postprocessing, will regenerate:`, error);
              // Fall through to regenerate
            }
          } else {
            return cached.result as T;
          }
        }
      } catch (error) {
        console.warn(`   ⚠️  [${workerId}] Cache check failed:`, error);
      }
    }
    
    // Track active job
    AIClient.activeJobs.add(workerId);
    const activeCount = AIClient.activeJobs.size;
    const activeList = Array.from(AIClient.activeJobs).join(', ');
    
    console.log(`🤖 [${workerId}] Starting ${modelName} call (${activeCount} active: ${activeList})`);
    
    try {
      if (debugPrefix) {
        await debugSave(`${debugPrefix}_prompt.txt`, prompt);
      }
      
      // Gemini: non-streaming call that reports token usage. Other providers: plain text.
      const isGemini = !!GEMINI_MODELS[modelName];
      const call: Promise<string> = isGemini
        ? generateGeminiContent(modelName, [{ text: prompt }]).then(r => {
            this.usage.addUsage(metadata?.taskType || 'llm', modelName, r.usageMetadata);
            return r.text;
          })
        : getGenerationFunction(this.modelKey)(prompt);
      
      let rawResult: string;
      if (timeout) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`AI generation timed out after ${timeout}ms`)), timeout);
        });
        try {
          rawResult = await Promise.race([call, timeoutPromise]);
        } finally {
          clearTimeout(timer);
        }
      } else {
        rawResult = await call;
      }
      
      if (debugPrefix) {
        await debugSave(`${debugPrefix}_response.txt`, rawResult);
      }
      
      // Apply postprocessing if provided
      let result: T;
      if (postProcess) {
        try {
          result = postProcess(rawResult);
          if (debugPrefix) {
            await debugSave(`${debugPrefix}_processed.json`, result as any);
          }
        } catch (error) {
          console.error(`   ❌ [${workerId}] Postprocessing failed:`, error);
          throw error;
        }
      } else {
        result = rawResult as T;
      }
      
      // Cache the raw result if database is available
      if (this.db && metadata) {
        try {
          // Check if this entry already exists
          const existing = this.db.prepare(`
            SELECT task_type, task_level, task_params, model, created_at 
            FROM llm_cache 
            WHERE prompt_hash = ?
          `).get(promptHash) as any;
          
          if (existing) {
            console.warn(`   ⚠️  [${workerId}] Cache entry already exists for hash ${promptHash.substring(0, 8)}...`);
            console.warn(`      Existing: ${existing.task_type} (level ${existing.task_level}) with model ${existing.model}, created at ${existing.created_at}`);
            console.warn(`      Attempted: ${metadata.taskType} (level ${metadata.taskLevel || 0}) with model ${modelName}`);
            console.warn(`      Params match: ${JSON.stringify(existing.task_params) === JSON.stringify(metadata.params || {})}`);
          } else {
            this.db.prepare(`
              INSERT INTO llm_cache (prompt_hash, task_type, task_level, task_params, result, model)
              VALUES (?, ?, ?, ?, ?, ?)
            `).run(
              promptHash,
              metadata.taskType,
              metadata.taskLevel || 0,
              JSON.stringify(metadata.params || {}),
              rawResult,  // Always cache the raw result
              modelName
            );
            console.log(`   💾 [${workerId}] Cached result [${promptHash.substring(0, 8)}...]`);
          }
        } catch (error) {
          console.warn(`   ⚠️  [${workerId}] Failed to cache result:`, error);
        }
      }
      
      return result;
      
    } finally {
      AIClient.activeJobs.delete(workerId);
      const remainingCount = AIClient.activeJobs.size;
      const remainingList = Array.from(AIClient.activeJobs).join(', ') || 'none';
      console.log(`✅ [${workerId}] Completed ${modelName} call (${remainingCount} remaining: ${remainingList})`);
    }
  }
  
  async generateMultimodal(
    parts: Part[],
    debugPrefix?: string,
    jobId?: string,
    metadata?: CacheMetadata,
    timeout?: number
  ): Promise<string> {
    const workerId = jobId || debugPrefix || `worker_${Date.now()}`;

    // Build a cache key from all text parts (binary parts are too large to hash efficiently,
    // but we include their mime types + sizes as a fingerprint)
    if (this.db && metadata) {
      const cacheInput = parts.map(p => {
        if (p.text) return `text:${p.text}`;
        if (p.inlineData) return `blob:${p.inlineData.mimeType}:${(p.inlineData.data || '').length}`;
        return 'unknown';
      }).join('|');
      const promptHash = createHash('sha256').update(cacheInput).digest('hex');

      try {
        const cached = this.db.prepare(`
          SELECT result FROM llm_cache
          WHERE prompt_hash = ?
        `).get(promptHash) as { result: string } | undefined;

        if (cached) {
          console.log(`   ✅ [${workerId}] Using cached result [${promptHash.substring(0, 8)}...]`);
          return cached.result;
        }
      } catch (error) {
        console.warn(`   ⚠️  [${workerId}] Cache check failed:`, error);
      }
    }

    AIClient.activeJobs.add(workerId);
    const activeCount = AIClient.activeJobs.size;
    const activeList = Array.from(AIClient.activeJobs).join(', ');
    const modelName = this.modelKey || DEFAULT_MODEL;
    console.log(`🤖 [${workerId}] Starting ${modelName} multimodal call (${activeCount} active: ${activeList})`);

    try {
      if (debugPrefix) {
        // Save only the text parts for debugging
        const textContent = parts.filter(p => p.text).map(p => p.text).join('\n---\n');
        const binarySummary = parts.filter(p => p.inlineData).map(p =>
          `[${p.inlineData!.mimeType}, ${(p.inlineData!.data || '').length} base64 chars]`
        ).join(', ');
        await debugSave(`${debugPrefix}_prompt.txt`, `${textContent}\n\n--- Binary parts: ${binarySummary}`);
      }

      const generateFn = getMultimodalGenerationFunction(modelName);
      const streamingOptions = debugPrefix ? { debugFilename: `${debugPrefix}_response.txt` } : undefined;

      let rawResult: string;
      if (timeout) {
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(`AI generation timed out after ${timeout}ms`)), timeout);
        });
        rawResult = await Promise.race([generateFn(parts, streamingOptions), timeoutPromise]);
      } else {
        rawResult = await generateFn(parts, streamingOptions);
      }

      // Cache the result
      if (this.db && metadata) {
        const cacheInput = parts.map(p => {
          if (p.text) return `text:${p.text}`;
          if (p.inlineData) return `blob:${p.inlineData.mimeType}:${(p.inlineData.data || '').length}`;
          return 'unknown';
        }).join('|');
        const promptHash = createHash('sha256').update(cacheInput).digest('hex');

        try {
          const existing = this.db.prepare(`SELECT 1 FROM llm_cache WHERE prompt_hash = ?`).get(promptHash);
          if (!existing) {
            this.db.prepare(`
              INSERT INTO llm_cache (prompt_hash, task_type, task_level, task_params, result, model)
              VALUES (?, ?, ?, ?, ?, ?)
            `).run(
              promptHash,
              metadata.taskType,
              metadata.taskLevel || 0,
              JSON.stringify(metadata.params || {}),
              rawResult,
              modelName
            );
            console.log(`   💾 [${workerId}] Cached result [${promptHash.substring(0, 8)}...]`);
          }
        } catch (error) {
          console.warn(`   ⚠️  [${workerId}] Failed to cache result:`, error);
        }
      }

      return rawResult;
    } finally {
      AIClient.activeJobs.delete(workerId);
      const remainingCount = AIClient.activeJobs.size;
      const remainingList = Array.from(AIClient.activeJobs).join(', ') || 'none';
      console.log(`✅ [${workerId}] Completed ${modelName} multimodal call (${remainingCount} remaining: ${remainingList})`);
    }
  }

  // Extract JSON from AI response (handles markdown code blocks)
  extractJson(text: string): any {
    return parseJsonResponse(text);
  }
}