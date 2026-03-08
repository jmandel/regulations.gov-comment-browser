import { debugSave } from "./debug";
import { parseJsonResponse } from "./json-parser";
import { createHash } from "crypto";
import { Database } from "bun:sqlite";
import { getGenerationFunction, getMultimodalGenerationFunction } from "./llm-providers";
import type { Part } from "@google/genai";

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
    
    // Check cache if database is available
    if (this.db && metadata) {
      const promptHash = createHash('sha256').update(prompt).digest('hex');
      
      try {
        const cached = this.db.prepare(`
          SELECT result FROM llm_cache 
          WHERE prompt_hash = ?
        `).get(promptHash) as { result: string } | undefined;
        
        if (cached) {
          console.log(`   ✅ [${workerId}] Using cached result [${promptHash.substring(0, 8)}...]`);
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
    
    const modelName = this.modelKey || "gemini-pro";
    console.log(`🤖 [${workerId}] Starting ${modelName} call (${activeCount} active: ${activeList})`);
    
    try {
      if (debugPrefix) {
        await debugSave(`${debugPrefix}_prompt.txt`, prompt);
      }
      
      // Get the appropriate generation function
      const generateFn = getGenerationFunction(this.modelKey);
      
      // Set up streaming options if debug is enabled
      const streamingOptions = debugPrefix ? { 
        debugFilename: `${debugPrefix}_response.txt` 
      } : undefined;
      
      let rawResult: string;
      if (timeout) {
        // Create a timeout promise
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(`AI generation timed out after ${timeout}ms`)), timeout);
        });
        
        // Race between the actual call and timeout
        rawResult = await Promise.race([
          generateFn(prompt, streamingOptions),
          timeoutPromise
        ]);
      } else {
        rawResult = await generateFn(prompt, streamingOptions);
      }
      
      // No need to save response again if we streamed it
      if (debugPrefix && !streamingOptions) {
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
        const promptHash = createHash('sha256').update(prompt).digest('hex');
        
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
    const modelName = this.modelKey || "gemini-3-flash";
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