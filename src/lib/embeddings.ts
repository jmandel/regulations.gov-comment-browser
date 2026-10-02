// Gemini text embeddings with a per-comment cache in the DB.
//
// Vectors are stored L2-normalized as Float32 blobs in `comment_embeddings`, keyed by comment,
// model and dimensionality, with a hash of the embedded text so an edited input is re-embedded.
// Reruns only pay for comments whose text changed.

import type { Database } from "bun:sqlite";
import { createHash } from "crypto";
import { runPool } from "./worker-pool";

export const DEFAULT_EMBEDDING_MODEL = "gemini-embedding-2";
// $ per 1M input tokens
const EMBED_PRICE: Record<string, number> = { "gemini-embedding-2": 0.20, "gemini-embedding-001": 0.15 };

export interface EmbedItem { id: string; text: string; }
export interface EmbedSummary { embedded: number; cached: number; failed: number; approxTokens: number; costUsd: number; }

export function ensureEmbeddingTable(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS comment_embeddings (
      comment_id TEXT NOT NULL,
      model TEXT NOT NULL,
      dims INTEGER NOT NULL,
      text_hash TEXT NOT NULL,
      vector BLOB NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (comment_id, model, dims)
    );
  `);
}

const hashText = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);

function normalize(v: number[]): Float32Array {
  const out = new Float32Array(v.length);
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

async function embedBatch(model: string, dims: number, texts: string[], apiKey: string): Promise<number[][]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents?key=${apiKey}`;
  const body = JSON.stringify({
    requests: texts.map(t => ({ model: `models/${model}`, content: { parts: [{ text: t }] }, outputDimensionality: dims })),
  });
  let lastErr = "";
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
      if (res.ok) {
        const json = await res.json() as { embeddings: { values: number[] }[] };
        if (json.embeddings?.length !== texts.length) throw new Error(`expected ${texts.length} embeddings, got ${json.embeddings?.length}`);
        return json.embeddings.map(e => e.values);
      }
      lastErr = `${res.status} ${(await res.text()).slice(0, 200)}`;
      if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
    } catch (e) {
      lastErr = (e as Error).message;
    }
    await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
  }
  throw new Error(`embedding batch failed: ${lastErr}`);
}

// Returns a map id → normalized vector for every item that could be embedded (cached or new)
export async function embedTexts(
  db: Database,
  items: EmbedItem[],
  opts: { model?: string; dims?: number; concurrency?: number; batchSize?: number } = {}
): Promise<{ vectors: Map<string, Float32Array>; summary: EmbedSummary }> {
  const model = opts.model || DEFAULT_EMBEDDING_MODEL;
  const dims = opts.dims || 768;
  const batchSize = opts.batchSize || 50;
  ensureEmbeddingTable(db);
  const apiKey = process.env.GEMINI_API_KEY;

  const vectors = new Map<string, Float32Array>();
  const summary: EmbedSummary = { embedded: 0, cached: 0, failed: 0, approxTokens: 0, costUsd: 0 };
  const get = db.prepare("SELECT text_hash, vector FROM comment_embeddings WHERE comment_id = ? AND model = ? AND dims = ?");
  const put = db.prepare("INSERT OR REPLACE INTO comment_embeddings (comment_id, model, dims, text_hash, vector) VALUES (?, ?, ?, ?, ?)");

  const todo: (EmbedItem & { hash: string })[] = [];
  for (const it of items) {
    const hash = hashText(it.text);
    const row = get.get(it.id, model, dims) as { text_hash: string; vector: Uint8Array } | null;
    if (row && row.text_hash === hash) {
      vectors.set(it.id, new Float32Array(row.vector.buffer.slice(row.vector.byteOffset, row.vector.byteOffset + row.vector.byteLength)));
      summary.cached++;
    } else todo.push({ ...it, hash });
  }
  if (todo.length === 0) return { vectors, summary };
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  const batches: (typeof todo)[] = [];
  for (let i = 0; i < todo.length; i += batchSize) batches.push(todo.slice(i, i + batchSize));
  let done = 0;
  await runPool(batches, opts.concurrency || 8, async (batch) => {
    try {
      const vals = await embedBatch(model, dims, batch.map(b => b.text), apiKey);
      db.transaction(() => {
        batch.forEach((b, i) => {
          const v = normalize(vals[i]);
          vectors.set(b.id, v);
          put.run(b.id, model, dims, b.hash, new Uint8Array(v.buffer));
        });
      })();
      summary.embedded += batch.length;
      // Rough token estimate (~1.33 tokens per word) for the cost line
      for (const b of batch) summary.approxTokens += Math.round(b.text.split(/\s+/).length * 1.33);
    } catch (e) {
      summary.failed += batch.length;
      console.error(`\n❌ [embed] ${(e as Error).message}`);
    }
    done += batch.length;
    if (done % 1000 < batchSize || done === todo.length) process.stdout.write(`\r   [embed] ${done}/${todo.length}`);
  });
  console.log();
  summary.costUsd = summary.approxTokens * (EMBED_PRICE[model] ?? 0.2) / 1e6;
  return { vectors, summary };
}
