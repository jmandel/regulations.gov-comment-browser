import { Command } from "commander";
import { openDb, withTransaction, getProcessingStatus } from "../lib/database";
import { initDebug } from "../lib/debug";
import { AIClient } from "../lib/ai-client";
import { loadComments, enrichComment, checkClusteringStatus } from "../lib/comment-processing";
import { TRANSCRIBE_PROMPT } from "../prompts/transcribe";
import type { RawComment } from "../types";
import { runPool } from "../lib/worker-pool";
import { getTaskConfig, getTaskModel } from "../lib/batch-config";

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

      // Enrich comment with attachments
      const enriched = await enrichComment(comment, attachments);
      if (!enriched) {
        console.log(`  [${comment.id}] ⚠️  Skipped (empty content)`);
        updateFailed.run(comment.id, "Empty comment content");
        failed++;
        return;
      }

      const prompt = TRANSCRIBE_PROMPT.replace("{COMMENT_TEXT}", enriched.content);

      const response = await ai.generateContent(
        prompt,
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
