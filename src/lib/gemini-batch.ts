// Gemini Batch API backend for step-runner.ts. (Implementation in progress — see contract below.)
//
// Contract:
// - runGeminiBatch(requests, opts) submits all requests (all share one model) as Gemini batch
//   job(s), polls until done, and calls opts.onResult once per request with its text/usage or error.
// - Jobs are recorded in the batch_jobs table (job_name, task, label, model, request_keys, state)
//   before polling, so if the process restarts, a call with the same label and the same request
//   keys resumes polling the existing job instead of resubmitting.
// - Requests whose key never appears in the results are reported via onResult with an error.

import type { Database } from "bun:sqlite";
import type { UsageMetadata } from "./llm-providers";
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
  pollIntervalMs?: number;
}

export async function runGeminiBatch(_requests: LlmRequest[], _opts: BatchOptions): Promise<void> {
  throw new Error("Gemini Batch API mode is not implemented yet; use live mode");
}
