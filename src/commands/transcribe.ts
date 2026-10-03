import { Command } from "commander";
import { openDb, withTransaction, getProcessingStatus } from "../lib/database";
import { initDebug } from "../lib/debug";
import { checkClusteringStatus } from "../lib/comment-processing";
import { TRANSCRIBE_PROMPT } from "../prompts/transcribe";
import type { RawComment, CommentAttributes, Attachment } from "../types";
import { runLlmRequests, type LlmRequest } from "../lib/step-runner";
import { htmlToText, wordCount } from "../lib/text";
import { getTaskConfig, getTaskModel, getTaskRoleModel } from "../lib/batch-config";
import { buildDoc, coverage } from "./cluster-form-letters";
import { createPartFromBase64 } from "@google/genai";
import { mkdtemp, writeFile, readFile, rm } from "fs/promises";
import { readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { $ } from "bun";

export const transcribeCommand = new Command("transcribe")
  .description("Transcribe comments with attachments into clean markdown, one call per attachment (typed-only comments are stored as-is)")
  .argument("<document-id>", "Document ID (e.g., CMS-2025-0050-0031)")
  .option("-l, --limit <n>", "Process only N comments", parseInt)
  .option("--retry-failed", "Retry previously failed comments")
  .option("--ids <ids>", "Re-transcribe these comments (comma-separated), even if already transcribed")
  .option("--ids-file <path>", "Re-transcribe the comments listed in this file (one ID per line)")
  .option("-d, --debug", "Enable debug output")
  .option("-c, --concurrency <n>", "Number of parallel API calls (default: 5)", parseInt)
  .option("-m, --model <model>", "AI model to use (overrides config)")
  .option("--use-clustering", "Only transcribe representative comments from clusters")
  .option("--batch", "Use the Gemini Batch API (half price, slower)")
  .option("--chunk-size <n>", "Comments per chunk of attachment comments (default: 500)", parseInt)
  .action(transcribeComments);

// MIME types that Gemini can ingest natively as inline data
const NATIVE_MIME: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  tiff: "image/tiff",
  tif: "image/tiff",
};

// Attachment formats we can read; comments without one are stored as typed
const READABLE_FORMATS = new Set([...Object.keys(NATIVE_MIME), "docx", "txt"]);

// PDFs over SPLIT_OVER_PAGES are sent in page ranges of at most CHUNK_PAGES. In the PFS run (one
// Flash-Lite call per comment), single-attachment PDFs kept a median 94% of their text-layer words
// up to 30 pages with none under half; at 31-50 pages the 10th percentile fell to 77%, and past 50
// pages to 20%. Whole submissions of up to 25 pages scored as well as single pages on 3.8 Flash.
const SPLIT_OVER_PAGES = 30;
const CHUNK_PAGES = 20;

// Length check: a part whose transcript has under MIN_LENGTH_RATIO of its source's words (PDF text
// layer via pdftotext, or the DOCX/TXT text) is retried once on the fallback model, keeping the
// longer result. A part that still has no transcript (Gemini refuses with RECITATION on attached
// journal articles and published reports, often on retry too) gets its text layer instead, marked
// as such. Below MIN_SOURCE_WORDS (scans have no text layer) the check is skipped. In PFS,
// 2% of single-attachment PDFs up to 30 pages fell under half, against 40% of multi-attachment ones.
const MIN_LENGTH_RATIO = 0.5;
const MIN_SOURCE_WORDS = 150;

// Comment-box text on a comment with attachments is stored as typed unless it's a short pointer to
// the attachment ("See attached file(s)") or mostly repeats an attachment (many paste the letter)
const STUB_WORDS = 40;
const DUPLICATE_COVERAGE = 0.6;

// Keep raw attachment bytes held in memory per runLlmRequests call bounded
const CHUNK_MAX_BYTES = 300_000_000;
const CHUNK_MAX_COMMENTS = 500;

// One LLM request: an attachment, or a page range of a long PDF
interface TranscriptionPart extends LlmRequest {
  sourceWords: number;             // words in the source's text layer; 0 = unknown (scan, image)
  sourceText: string;              // that text layer, used as-is if the model won't transcribe the part
}

// How a comment's transcript is put together once its parts are back
interface CommentPlan {
  id: string;
  typed: string;                   // comment-box text ("" if none)
  attachments: string[][];         // part keys per attachment, in order
}

async function tool(cmd: ReturnType<typeof $>): Promise<string | null> {
  // qpdf exits 3 for warnings on output it still wrote
  const r = await cmd.nothrow().quiet();
  return r.exitCode === 0 || r.exitCode === 3 ? r.stdout.toString() : null;
}

// Convert a DOCX blob to plain text via pandoc
async function docxToText(path: string): Promise<string> {
  return ((await tool($`pandoc -f docx -t plain --wrap=none ${path}`)) || "").trim();
}

function pdfPart(bytes: Uint8Array) {
  return createPartFromBase64(Buffer.from(bytes).toString("base64"), "application/pdf");
}

// Requests for one attachment: a native file (split by page range if long), or converted text
async function attachmentParts(
  att: Attachment, key: string, where: string, model: string, dir: string,
): Promise<TranscriptionPart[]> {
  const format = att.format.toLowerCase();
  const blob = Buffer.from(att.blob_data!);
  const intro = (note: string) => ({ text: [TRANSCRIBE_PROMPT, [where, note].filter(Boolean).join(" ")].filter(Boolean).join("\n\n") });

  if (format === "pdf") {
    const path = join(dir, "in.pdf");
    await writeFile(path, blob);
    const pages = parseInt((await tool($`qpdf --show-npages ${path}`)) || "") || 0;
    const layer = async (from: number, to: number) => {
      const t = ((await tool($`pdftotext -q -f ${from} -l ${to} ${path} -`)) || "").trim();
      return { sourceWords: wordCount(t), sourceText: t };
    };
    if (pages <= SPLIT_OVER_PAGES) {
      return [{ key, model, ...(await layer(1, pages || 1)), parts: [intro(""), pdfPart(blob)] }];
    }
    const n = Math.ceil(pages / CHUNK_PAGES);
    const size = Math.ceil(pages / n);
    const out: TranscriptionPart[] = [];
    for (let from = 1; from <= pages; from += size) {
      const to = Math.min(pages, from + size - 1);
      const chunk = join(dir, `p${from}.pdf`);
      // --deterministic-id keeps the bytes identical across runs, so a resubmitted batch matches
      const ok = await tool($`qpdf --deterministic-id --empty --pages ${path} ${from}-${to} -- ${chunk}`);
      if (ok === null) {
        console.warn(`    qpdf could not split ${att.id}.pdf; sending all ${pages} pages in one call`);
        return [{ key, model, ...(await layer(1, pages)), parts: [intro(""), pdfPart(blob)] }];
      }
      out.push({
        key: `${key}#p${from}-${to}`, model, ...(await layer(from, to)),
        parts: [intro(`These are pages ${from}-${to} of ${pages}: transcribe these pages only, even if they begin or end mid-sentence.`), pdfPart(await readFile(chunk))],
      });
    }
    return out;
  }

  if (NATIVE_MIME[format]) {
    return [{ key, model, sourceWords: 0, sourceText: "", parts: [intro(""), createPartFromBase64(blob.toString("base64"), NATIVE_MIME[format])] }];
  }

  let text = "";
  if (format === "docx") {
    const path = join(dir, "in.docx");
    await writeFile(path, blob);
    text = await docxToText(path);
  } else if (format === "txt") {
    text = blob.toString("utf-8").trim();
  }
  if (!text) return [];
  return [{ key, model, sourceWords: wordCount(text), sourceText: text, parts: [intro(""), { text: `=== DOCUMENT (converted from ${format.toUpperCase()}) ===\n${text}` }] }];
}

// Plan a comment: its comment-box text plus one or more requests per readable attachment
async function planComment(comment: RawComment, attachments: Attachment[], model: string) {
  // The same attachment may come as pdf + docx; prefer a native format, then docx, then txt
  const byId = new Map<string, Attachment[]>();
  for (const a of attachments) {
    if (!a.blob_data || !READABLE_FORMATS.has((a.format || "").toLowerCase())) continue;
    if (!byId.has(a.id)) byId.set(a.id, []);
    byId.get(a.id)!.push(a);
  }
  const rank = (a: Attachment) => {
    const f = a.format.toLowerCase();
    return NATIVE_MIME[f] ? 0 : f === "docx" ? 1 : 2;
  };
  // Some submitters upload the same file twice; transcribe it once
  const seen = new Set<string>();
  const chosen = [...byId.keys()].sort()
    .map(id => byId.get(id)!.sort((a, b) => rank(a) - rank(b))[0])
    .filter(a => {
      const hash = Bun.hash(a.blob_data!).toString();
      return !seen.has(hash) && !!seen.add(hash);
    });

  const plan: CommentPlan = { id: comment.id, typed: htmlToText(commentText(comment)), attachments: [] };
  const parts: TranscriptionPart[] = [];
  const dir = await mkdtemp(join(tmpdir(), "transcribe-"));
  try {
    for (const [i, att] of chosen.entries()) {
      const where = chosen.length > 1 ? `This is attachment ${i + 1} of ${chosen.length}.` : "";
      const p = await attachmentParts(att, `${comment.id}#${att.id}`, where, model, dir);
      if (p.length === 0) continue;
      plan.attachments.push(p.map(x => x.key));
      parts.push(...p);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return { plan, parts };
}

// One markdown document per comment: the comment-box text (unless it only points to or repeats the
// attachments), then each attachment's parts in order, under a heading when there is more than one section
function assemble(plan: CommentPlan, out: Map<string, string>): string {
  const atts = plan.attachments.map(keys => keys.map(k => out.get(k)!).join("\n\n"));
  let typed = plan.typed;
  if (typed && atts.length > 0) {
    const doc = buildDoc("typed", typed);
    const stub = wordCount(typed) < STUB_WORDS && /attach|enclos|upload/i.test(typed);
    if (stub || coverage(buildDoc("atts", atts.join("\n")).set, doc.set) >= DUPLICATE_COVERAGE) typed = "";
  }
  const headed = atts.length + (typed ? 1 : 0) > 1;
  return [typed, ...atts.map((t, i) => (headed ? `## Attachment ${i + 1}\n\n${t}` : t))].filter(Boolean).join("\n\n");
}

function commentText(comment: RawComment): string {
  const attrs = JSON.parse(comment.attributes_json) as CommentAttributes;
  return (attrs.comment || attrs.text || "").trim();
}

async function transcribeComments(documentId: string, options: any) {
  await initDebug(options.debug);

  const db = openDb(documentId);

  const effectiveModel = getTaskModel('transcribe', options.model);
  const mode = options.batch ? "batch" : "live";

  console.log(`📜 Transcribing comments for document ${documentId}`);
  console.log(`   Using model: ${effectiveModel}${mode === "batch" ? " (Batch API)" : ""}`);

  // Check for clustering if requested
  if (options.useClustering) {
    const clusteringExists = checkClusteringStatus(db);
    if (!clusteringExists) {
      console.error("❌ No clustering data found. Run 'cluster-form-letters' first.");
      process.exit(1);
    }
    console.log("🔗 Using stored clustering to transcribe only representative comments");
  }

  // Get processing status
  const status = getProcessingStatus(db, "transcriptions");
  console.log(`📊 Status: ${status.completed} completed, ${status.failed} failed, ${status.pending} pending`);

  // Build query based on options
  let query: string;
  let params: any[] = [];
  let comments: RawComment[];

  // Explicit IDs: redo those comments whatever their status
  let ids: string[] | null = null;
  if (options.ids) ids = String(options.ids).split(",");
  if (options.idsFile) ids = readFileSync(options.idsFile, "utf-8").split(/\s+/);
  if (ids) ids = [...new Set(ids.map(s => s.trim()).filter(Boolean))];

  if (ids) {
    comments = db.prepare(
      "SELECT id, attributes_json FROM comments WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id"
    ).all(JSON.stringify(ids)) as RawComment[];
    if (options.limit) comments = comments.slice(0, options.limit);
    if (comments.length < ids.length && !options.limit) console.log(`⚠️  ${ids.length - comments.length} of ${ids.length} requested IDs are not in this database`);
  } else if (options.useClustering && !options.retryFailed) {
    query = `
      SELECT c.id, c.attributes_json
      FROM comments c
      INNER JOIN comment_cluster_membership ccm ON c.id = ccm.comment_id
      LEFT JOIN transcriptions t ON c.id = t.comment_id
      WHERE ccm.is_representative = 1
        AND (t.comment_id IS NULL OR t.status IN ('pending', 'processing'))
      ORDER BY c.id
    `;
    if (options.limit) {
      query += " LIMIT ?";
      params.push(options.limit);
    }
    comments = db.prepare(query).all(...params) as RawComment[];
  } else if (options.retryFailed) {
    query = `
      SELECT c.id, c.attributes_json
      FROM comments c
      LEFT JOIN transcriptions t ON c.id = t.comment_id
      WHERE t.status = 'failed'
    `;
    if (options.useClustering) {
      query += ` AND EXISTS (
        SELECT 1 FROM comment_cluster_membership ccm
        WHERE ccm.comment_id = c.id AND ccm.is_representative = 1
      )`;
    }
    query += ` ORDER BY t.attempt_count ASC, c.id`;
    if (options.limit) {
      query += " LIMIT ?";
      params.push(options.limit);
    }
    comments = db.prepare(query).all(...params) as RawComment[];
  } else {
    query = `
      SELECT c.id, c.attributes_json
      FROM comments c
      LEFT JOIN transcriptions t ON c.id = t.comment_id
      WHERE t.comment_id IS NULL OR t.status IN ('pending', 'processing')
      ORDER BY c.id
    `;
    if (options.limit) {
      query += " LIMIT ?";
      params.push(options.limit);
    }
    comments = db.prepare(query).all(...params) as RawComment[];
  }

  console.log(`🎯 Found ${comments.length} comments to transcribe`);

  if (comments.length === 0) {
    console.log("✅ No comments to transcribe");
    return;
  }

  // Attachment sizes per comment (readable formats with content only); blobs are loaded per chunk
  const readableBytes = new Map<string, number>();
  const attStmt = db.prepare(
    "SELECT comment_id, format, length(blob_data) AS bytes FROM attachments WHERE comment_id = ? AND blob_data IS NOT NULL"
  );
  for (const c of comments) {
    for (const a of attStmt.all(c.id) as { comment_id: string; format: string | null; bytes: number }[]) {
      if (!READABLE_FORMATS.has((a.format || "").toLowerCase())) continue;
      readableBytes.set(c.id, (readableBytes.get(c.id) || 0) + a.bytes);
    }
  }
  const typedOnly = comments.filter(c => !readableBytes.has(c.id));
  const withAttachments = comments.filter(c => readableBytes.has(c.id));
  console.log(`   ${typedOnly.length} typed-only (stored as-is, no LLM call), ${withAttachments.length} with attachments (LLM)`);

  // Re-transcribed comments keep their current transcript (and status) until a new one replaces it
  const hadTranscript = new Set(
    ids ? (db.prepare("SELECT comment_id FROM transcriptions WHERE status = 'completed'").all() as { comment_id: string }[]).map(r => r.comment_id) : []
  );

  // Prepare statements
  const insertTranscription = db.prepare(`
    INSERT INTO transcriptions (comment_id, markdown, word_count, status)
    VALUES (?, ?, ?, 'completed')
    ON CONFLICT(comment_id) DO UPDATE SET
      markdown = excluded.markdown,
      word_count = excluded.word_count,
      status = 'completed',
      error_message = NULL,
      last_attempt_at = CURRENT_TIMESTAMP
  `);

  const updateFailedStmt = db.prepare(`
    INSERT INTO transcriptions (comment_id, markdown, status, error_message, attempt_count)
    VALUES (?, '', 'failed', ?, 1)
    ON CONFLICT(comment_id) DO UPDATE SET
      status = 'failed',
      error_message = excluded.error_message,
      attempt_count = attempt_count + 1,
      last_attempt_at = CURRENT_TIMESTAMP
  `);
  const updateFailed = { run: (id: string, msg: string) => {
    if (hadTranscript.has(id)) console.log(`  [${id}] ⚠️  ${msg}; keeping the previous transcript`);
    else updateFailedStmt.run(id, msg);
  } };

  const markProcessing = db.prepare(`
    INSERT INTO transcriptions (comment_id, markdown, status)
    VALUES (?, '', 'processing')
    ON CONFLICT(comment_id) DO UPDATE SET
      status = 'processing',
      last_attempt_at = CURRENT_TIMESTAMP
  `);

  let successful = 0;
  let failed = 0;
  let direct = 0;

  // Typed-only comments: the comment box text is the transcription. Unlike the LLM path, we
  // don't strip "see attached" boilerplate; it's stored as typed.
  withTransaction(db, () => {
    for (const c of typedOnly) {
      const text = htmlToText(commentText(c));
      if (!text) {
        updateFailed.run(c.id, "Empty comment content and no attachments");
        failed++;
        continue;
      }
      insertTranscription.run(c.id, text, wordCount(text));
      direct++;
    }
  });
  if (typedOnly.length > 0) console.log(`   ✅ Stored ${direct} typed-only transcriptions`);

  // Attachment comments go to the model, in chunks so we never hold every attachment in memory
  const taskConfig = getTaskConfig('transcribe', options.model);
  const concurrency = options.concurrency || taskConfig.concurrency;
  const loadAttachments = db.prepare("SELECT * FROM attachments WHERE comment_id = ?");
  // The fallback model (tasks.transcribe.models.fallback) retries failed, empty, blocked and short
  // parts, unless the model was forced with -m
  const fallbackModel = getTaskRoleModel('transcribe', 'fallback');
  const retryModel = options.model ? effectiveModel : fallbackModel;
  let costUsd = 0;
  let shortRetries = 0;
  let textLayerParts = 0;

  const chunks: RawComment[][] = [];
  let cur: RawComment[] = [];
  let curBytes = 0;
  for (const c of withAttachments) {
    const bytes = readableBytes.get(c.id)!;
    if (cur.length > 0 && (cur.length >= (options.chunkSize || CHUNK_MAX_COMMENTS) || curBytes + bytes > CHUNK_MAX_BYTES)) {
      chunks.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(c);
    curBytes += bytes;
  }
  if (cur.length > 0) chunks.push(cur);

  const processChunk = async (chunk: RawComment[], i: number) => {
    if (chunks.length > 1) console.log(`\n📦 Chunk ${i + 1}/${chunks.length}: ${chunk.length} comments`);
    const plans: CommentPlan[] = [];
    const requests: TranscriptionPart[] = [];
    for (const c of chunk) {
      const { plan, parts } = await planComment(c, loadAttachments.all(c.id) as Attachment[], effectiveModel);
      if (parts.length === 0 && !plan.typed) {
        console.log(`  [${c.id}] ⚠️  Skipped (empty content, no readable attachments)`);
        updateFailed.run(c.id, "Empty comment content and no attachments");
        failed++;
        continue;
      }
      if (options.debug) console.log(`  [${c.id}] ${parts.length} part(s): ${parts.map(p => `${p.key} (${p.sourceWords} words)`).join(", ")}`);
      if (!hadTranscript.has(c.id)) markProcessing.run(c.id);
      plans.push(plan);
      requests.push(...parts);
    }

    const out = new Map<string, string>();
    const accept = (req: LlmRequest, text: string) => {
      const markdown = text.trim();
      // Blocked responses (RECITATION, safety) come back empty
      if (!markdown) throw new Error("empty transcription");
      if (wordCount(markdown) > wordCount(out.get(req.key) || "")) out.set(req.key, markdown);
    };
    const label = `${documentId}:${chunk[0].id}`;
    const summary = await runLlmRequests(requests, (req, res) => accept(req, res.text), {
      db, task: "transcribe", mode, concurrency, label: `transcribe:${label}`,
    });
    costUsd += summary.costUsd;

    // Retry once on the fallback model: parts that failed, and parts far shorter than their text layer
    const retry = requests.filter(r => {
      const text = out.get(r.key);
      if (!text) return true;
      if (r.sourceWords < MIN_SOURCE_WORDS || wordCount(text) >= MIN_LENGTH_RATIO * r.sourceWords) return false;
      console.log(`  [${r.key}] ⚠️  Short transcript: ${wordCount(text)} words for ${r.sourceWords} in the text layer`);
      shortRetries++;
      return true;
    });
    if (retry.length > 0) {
      console.log(`   🔁 Retrying ${retry.length} part(s) with ${retryModel}`);
      const fallback = await runLlmRequests(retry.map(r => ({ ...r, model: retryModel })), (req, res) => accept(req, res.text), {
        db, task: "transcribe", mode, concurrency, label: `transcribe-fallback:${label}`,
      });
      costUsd += fallback.costUsd;
    }
    // Still nothing (usually a RECITATION refusal on an attached article or report): use the
    // part's own text layer, so its content isn't lost
    for (const r of requests) {
      if (out.has(r.key) || r.sourceWords < MIN_SOURCE_WORDS) continue;
      console.log(`  [${r.key}] 📄 Model declined; using the document's text layer (${r.sourceWords} words)`);
      out.set(r.key, `_The model declined to transcribe this part, likely because it reproduces published material; below is the document's own text, extracted directly._\n\n${r.sourceText}`);
      textLayerParts++;
    }

    withTransaction(db, () => {
      for (const plan of plans) {
        const missing = plan.attachments.flat().filter(k => !out.has(k));
        if (missing.length > 0) {
          updateFailed.run(plan.id, `LLM transcription failed for ${missing.join(", ")} (see run log)`);
          failed++;
          continue;
        }
        const markdown = assemble(plan, out);
        insertTranscription.run(plan.id, markdown, wordCount(markdown));
        successful++;
      }
    });
  };
  // Batch jobs mostly wait in Google's queue, so submit every chunk at once; live mode keeps one
  // chunk at a time so it doesn't multiply the concurrency limit
  if (mode === "batch") await Promise.all(chunks.map((chunk, i) => processChunk(chunk, i)));
  else for (const [i, chunk] of chunks.entries()) await processChunk(chunk, i);

  // Final summary
  console.log("\n📊 Transcription complete:");
  console.log(`  📝 Typed-only (no LLM): ${direct}`);
  console.log(`  ✅ Transcribed by LLM: ${successful}`);
  if (shortRetries > 0) console.log(`  📏 Parts retried for a short transcript: ${shortRetries}`);
  if (textLayerParts > 0) console.log(`  📄 Parts filled from their text layer after the model declined: ${textLayerParts}`);
  console.log(`  ❌ Failed: ${failed}`);
  console.log(`  📄 Total processed: ${comments.length}`);
  if (withAttachments.length > 0) console.log(`  💰 ~$${costUsd.toFixed(3)}${mode === "batch" ? " (batch price)" : ""}`);

  const finalStatus = getProcessingStatus(db, "transcriptions");
  console.log("\n📈 Overall progress:");
  console.log(`  ✅ Completed: ${finalStatus.completed}`);
  console.log(`  ❌ Failed: ${finalStatus.failed}`);
  console.log(`  ⏳ Remaining: ${finalStatus.pending}`);

  db.close();
}
