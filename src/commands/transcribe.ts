import { Command } from "commander";
import { openDb, withTransaction, getProcessingStatus } from "../lib/database";
import { initDebug } from "../lib/debug";
import { AIClient } from "../lib/ai-client";
import { loadComments, checkClusteringStatus } from "../lib/comment-processing";
import { TRANSCRIBE_PROMPT } from "../prompts/transcribe";
import type { RawComment, CommentAttributes, Attachment } from "../types";
import { runPool } from "../lib/worker-pool";
import { getTaskConfig, getTaskModel } from "../lib/batch-config";
import { createPartFromBase64 } from "@google/genai";
import type { Part } from "@google/genai";
import { mkdtemp, writeFile, unlink } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { $ } from "bun";

export const transcribeCommand = new Command("transcribe")
  .description("Transcribe comments and attachments into clean markdown")
  .argument("<document-id>", "Document ID (e.g., CMS-2025-0050-0031)")
  .option("-l, --limit <n>", "Process only N comments", parseInt)
  .option("--retry-failed", "Retry previously failed comments")
  .option("-d, --debug", "Enable debug output")
  .option("-c, --concurrency <n>", "Number of parallel API calls (default: 5)", parseInt)
  .option("-m, --model <model>", "AI model to use (overrides config)")
  .option("--use-clustering", "Only transcribe representative comments from clusters")
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

// Convert a DOCX blob to plain text via pandoc
async function docxToText(blob: Uint8Array): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'docx-'));
  const path = join(dir, 'temp.docx');
  try {
    await writeFile(path, blob);
    return (await $`pandoc -f docx -t plain --wrap=none ${path}`.text()).trim();
  } catch (err) {
    console.warn('    pandoc docx extraction failed:', err);
    return '';
  } finally {
    try { await unlink(path); await $`rmdir ${dir}`.quiet(); } catch {}
  }
}

// Build multimodal Part[] for a comment and its attachments
async function buildTranscriptionParts(
  comment: RawComment,
  attachments: Map<string, Attachment[]>,
): Promise<{ parts: Part[]; description: string } | null> {
  const attrs = JSON.parse(comment.attributes_json) as CommentAttributes;
  const commentText = (attrs.comment || attrs.text || "").trim();

  // Group attachments by attachment ID (same doc may appear as pdf + docx)
  const commentAttachments = attachments.get(comment.id) || [];
  const byId = new Map<string, Attachment[]>();
  for (const a of commentAttachments) {
    if (!byId.has(a.id)) byId.set(a.id, []);
    byId.get(a.id)!.push(a);
  }

  // For each attachment ID, pick the best format:
  //   - If a native format exists (pdf, png, etc.), use it as inline binary
  //   - Else if docx, convert to text
  //   - Else if txt, include as text
  const binaryParts: Part[] = [];
  const textAttachmentParts: string[] = [];
  const partDescriptions: string[] = [];

  for (const [attId, formats] of byId) {
    // Try native format first
    const nativeAtt = formats.find(a => NATIVE_MIME[a.format.toLowerCase()] && a.blob_data);
    if (nativeAtt && nativeAtt.blob_data) {
      const mime = NATIVE_MIME[nativeAtt.format.toLowerCase()];
      binaryParts.push(
        createPartFromBase64(Buffer.from(nativeAtt.blob_data).toString('base64'), mime)
      );
      partDescriptions.push(`${nativeAtt.format.toUpperCase()} ${nativeAtt.file_name} (${(nativeAtt.blob_data.length / 1024).toFixed(0)}KB, native)`);
      continue;
    }

    // Try docx
    const docxAtt = formats.find(a => a.format.toLowerCase() === 'docx' && a.blob_data);
    if (docxAtt && docxAtt.blob_data) {
      const text = await docxToText(Buffer.from(docxAtt.blob_data));
      if (text) {
        textAttachmentParts.push(`=== ATTACHMENT: ${docxAtt.file_name} (converted from DOCX) ===\n${text}`);
        partDescriptions.push(`DOCX ${docxAtt.file_name} (${(docxAtt.blob_data.length / 1024).toFixed(0)}KB, pandoc→text)`);
      }
      continue;
    }

    // Try txt
    const txtAtt = formats.find(a => a.format.toLowerCase() === 'txt' && a.blob_data);
    if (txtAtt && txtAtt.blob_data) {
      const text = Buffer.from(txtAtt.blob_data).toString('utf-8').trim();
      if (text) {
        textAttachmentParts.push(`=== ATTACHMENT: ${txtAtt.file_name} ===\n${text}`);
        partDescriptions.push(`TXT ${txtAtt.file_name}`);
      }
      continue;
    }
  }

  // Must have either comment text or at least one attachment
  if (!commentText && binaryParts.length === 0 && textAttachmentParts.length === 0) {
    return null;
  }

  // Build the text part of the prompt
  let textPrompt = TRANSCRIBE_PROMPT + "\n\n";
  if (commentText) {
    textPrompt += `=== COMMENT TEXT ===\n${commentText}\n\n`;
  } else {
    textPrompt += `=== COMMENT TEXT ===\n(No text entered in comment box — see attached document(s))\n\n`;
  }
  if (textAttachmentParts.length > 0) {
    textPrompt += textAttachmentParts.join("\n\n") + "\n\n";
  }
  if (binaryParts.length > 0) {
    textPrompt += `The following ${binaryParts.length} file(s) are attached as binary document(s) for you to read directly.\n`;
  }

  const parts: Part[] = [{ text: textPrompt }, ...binaryParts];
  const desc = [
    commentText ? `text=${commentText.length}ch` : 'no-text',
    ...partDescriptions,
  ].join(', ');

  return { parts, description: desc };
}

async function transcribeComments(documentId: string, options: any) {
  await initDebug(options.debug);

  const db = openDb(documentId);

  const effectiveModel = getTaskModel('transcribe', options.model);
  const ai = new AIClient(effectiveModel, db);

  console.log(`📜 Transcribing comments for document ${documentId}`);
  console.log(`   Using model: ${effectiveModel}`);

  // Check for clustering if requested
  if (options.useClustering) {
    const clusteringExists = checkClusteringStatus(db);
    if (!clusteringExists) {
      console.error("❌ No clustering data found. Run 'cluster-comments-fast' first.");
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

  if (options.useClustering && !options.retryFailed) {
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

  // Load attachments
  const { attachments } = loadComments(db);

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

  const updateFailed = db.prepare(`
    INSERT INTO transcriptions (comment_id, markdown, status, error_message, attempt_count)
    VALUES (?, '', 'failed', ?, 1)
    ON CONFLICT(comment_id) DO UPDATE SET
      status = 'failed',
      error_message = excluded.error_message,
      attempt_count = attempt_count + 1,
      last_attempt_at = CURRENT_TIMESTAMP
  `);

  const markProcessing = db.prepare(`
    INSERT INTO transcriptions (comment_id, markdown, status)
    VALUES (?, '', 'processing')
    ON CONFLICT(comment_id) DO UPDATE SET
      status = 'processing',
      last_attempt_at = CURRENT_TIMESTAMP
  `);

  let processed = 0;
  let successful = 0;
  let failed = 0;

  const taskConfig = getTaskConfig('transcribe', options.model);
  const concurrency = options.concurrency || taskConfig.concurrency;

  async function processComment(comment: any): Promise<void> {
    const localProcessed = ++processed;
    console.log(`\n[${localProcessed}/${comments.length}] Transcribing comment ${comment.id}`);

    try {
      markProcessing.run(comment.id);

      // Build multimodal parts (comment text + native binary attachments)
      const built = await buildTranscriptionParts(comment, attachments);
      if (!built) {
        console.log(`  [${comment.id}] ⚠️  Skipped (empty content, no attachments)`);
        updateFailed.run(comment.id, "Empty comment content and no attachments");
        failed++;
        return;
      }
      console.log(`  [${comment.id}] Parts: ${built.description}`);

      const response = await ai.generateMultimodal(
        built.parts,
        options.debug ? `transcribe_${comment.id}` : undefined,
        `transcribe_${comment.id}`,
        {
          taskType: 'transcribe',
          taskLevel: 0,
          params: { commentId: comment.id }
        }
      );

      const wordCount = response.trim().split(/\s+/).length;

      withTransaction(db, () => {
        insertTranscription.run(comment.id, response.trim(), wordCount);
      });

      successful++;
      console.log(`  [${comment.id}] ✅ Transcribed (${wordCount} words)`);

    } catch (error) {
      failed++;
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`  [${comment.id}] ❌ Error: ${errorMsg}`);
      updateFailed.run(comment.id, errorMsg);
    }
  }

  await runPool(comments, concurrency, async (comment, index) => {
    await processComment(comment);
  });

  // Final summary
  console.log("\n📊 Transcription complete:");
  console.log(`  ✅ Successful: ${successful}`);
  console.log(`  ❌ Failed: ${failed}`);
  console.log(`  📄 Total processed: ${processed}`);

  const finalStatus = getProcessingStatus(db, "transcriptions");
  console.log("\n📈 Overall progress:");
  console.log(`  ✅ Completed: ${finalStatus.completed}`);
  console.log(`  ❌ Failed: ${finalStatus.failed}`);
  console.log(`  ⏳ Remaining: ${finalStatus.pending}`);

  db.close();
}
