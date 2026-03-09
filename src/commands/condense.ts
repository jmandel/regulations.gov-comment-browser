import { Command } from "commander";
import { openDb, withTransaction, getProcessingStatus } from "../lib/database";
import { initDebug } from "../lib/debug";
import { AIClient } from "../lib/ai-client";
import { checkClusteringStatus } from "../lib/comment-processing";
import { CONDENSE_PROMPT } from "../prompts/condense";
import { parseCondensedSections } from "../lib/parse-condensed-sections";
import { runPool } from "../lib/worker-pool";
import { getTaskConfig, getTaskModel } from "../lib/batch-config";

export const condenseCommand = new Command("condense")
  .description("Generate condensed versions of comments")
  .argument("<document-id>", "Document ID (e.g., CMS-2025-0050-0031)")
  .option("-l, --limit <n>", "Process only N comments", parseInt)
  .option("--retry-failed", "Retry previously failed comments")
  .option("--use-clustering", "Only condense representative comments from clusters")
  .option("-d, --debug", "Enable debug output")
  .option("-c, --concurrency <n>", "Number of parallel API calls (default: 5)", parseInt)
  .option("-m, --model <model>", "AI model to use (overrides config)")
  .action(condenseComments);

async function condenseComments(documentId: string, options: any) {
  await initDebug(options.debug);
  
  const db = openDb(documentId);
  
  // Get the effective model from config
  const effectiveModel = getTaskModel('condense', options.model);
  const ai = new AIClient(effectiveModel, db);
  
  console.log(`📝 Condensing comments for document ${documentId}`);
  console.log(`   Using model: ${effectiveModel}`);
  
  // Check for clustering if requested
  if (options.useClustering) {
    const clusteringExists = checkClusteringStatus(db);
    if (!clusteringExists) {
      console.error("❌ No clustering data found. Run 'cluster-comments-fast' first.");
      process.exit(1);
    }
    console.log("🔗 Using stored clustering to process only representative comments");
  }
  
  // Get processing status
  const status = getProcessingStatus(db, "condensed_comments");
  console.log(`📊 Status: ${status.completed} completed, ${status.failed} failed, ${status.pending} pending`);
  
  // Check that transcriptions exist
  const transcriptionCount = db.prepare(
    `SELECT COUNT(*) as count FROM transcriptions WHERE status = 'completed'`
  ).get() as { count: number };
  if (transcriptionCount.count === 0) {
    console.error("❌ No transcriptions found. Run 'transcribe' first.");
    process.exit(1);
  }

  // Build query - read from transcriptions, find ones not yet condensed
  let query: string;
  let params: any[] = [];
  let comments: { id: string; attributes_json: string; markdown: string }[];

  if (options.retryFailed) {
    query = `
      SELECT c.id, c.attributes_json, t.markdown
      FROM comments c
      JOIN transcriptions t ON c.id = t.comment_id AND t.status = 'completed'
      LEFT JOIN condensed_comments cc ON c.id = cc.comment_id
      WHERE cc.status = 'failed'
      ORDER BY cc.attempt_count ASC, c.id
    `;
    if (options.limit) {
      query += " LIMIT ?";
      params.push(options.limit);
    }
    comments = db.prepare(query).all(...params) as any[];
  } else {
    query = `
      SELECT c.id, c.attributes_json, t.markdown
      FROM comments c
      JOIN transcriptions t ON c.id = t.comment_id AND t.status = 'completed'
      LEFT JOIN condensed_comments cc ON c.id = cc.comment_id
      WHERE cc.comment_id IS NULL OR cc.status IN ('pending', 'processing')
      ORDER BY c.id
    `;
    if (options.limit) {
      query += " LIMIT ?";
      params.push(options.limit);
    }
    comments = db.prepare(query).all(...params) as any[];
  }
  
  console.log(`🎯 Found ${comments.length} comments to process`);
  
  if (comments.length === 0) {
    console.log("✅ No comments to process");
    return;
  }
  
  // Prepare statements
  const insertCondensed = db.prepare(`
    INSERT INTO condensed_comments (comment_id, structured_sections, word_count, status)
    VALUES (?, ?, ?, 'completed')
    ON CONFLICT(comment_id) DO UPDATE SET 
      structured_sections = excluded.structured_sections,
      word_count = excluded.word_count,
      status = 'completed',
      error_message = NULL,
      last_attempt_at = CURRENT_TIMESTAMP
  `);
  
  const updateFailed = db.prepare(`
    INSERT INTO condensed_comments (comment_id, structured_sections, status, error_message, attempt_count)
    VALUES (?, '{}', 'failed', ?, 1)
    ON CONFLICT(comment_id) DO UPDATE SET 
      status = 'failed',
      error_message = excluded.error_message,
      attempt_count = attempt_count + 1,
      last_attempt_at = CURRENT_TIMESTAMP
  `);
  
  const markProcessing = db.prepare(`
    INSERT INTO condensed_comments (comment_id, structured_sections, status)
    VALUES (?, '{}', 'processing')
    ON CONFLICT(comment_id) DO UPDATE SET 
      status = 'processing',
      last_attempt_at = CURRENT_TIMESTAMP
  `);
  
  let processed = 0;
  let successful = 0;
  let failed = 0;
  
  const taskConfig = getTaskConfig('condense', options.model);
  const concurrency = options.concurrency || taskConfig.concurrency;
  
  const activeWorkers = new Set<string>();
  
  // Process a single comment
  async function processComment(comment: any): Promise<void> {
    const localProcessed = ++processed;
    console.log(`\n[${localProcessed}/${comments.length}] Processing comment ${comment.id} (${activeWorkers.size} workers active)`);
    
    try {
      // Mark as processing
      markProcessing.run(comment.id);
      
      // Build metadata from API attributes
      const attrs = JSON.parse(comment.attributes_json || '{}');
      const metadataParts: string[] = [];
      if (attrs.firstName || attrs.lastName) {
        metadataParts.push(`Submitter Name: ${[attrs.firstName, attrs.lastName].filter(Boolean).join(' ')}`);
      }
      if (attrs.organization) {
        metadataParts.push(`Organization: ${attrs.organization}`);
      }
      if (attrs.category) {
        metadataParts.push(`Category: ${attrs.category}`);
      }
      const metadataStr = metadataParts.length > 0
        ? metadataParts.join('\n')
        : 'No submitter metadata available';

      // Build prompt using the transcription + metadata
      const prompt = CONDENSE_PROMPT
        .replace("{COMMENTER_METADATA}", metadataStr)
        .replace("{COMMENT_TEXT}", comment.markdown);
      
      // Generate condensed version with caching metadata
      const response = await ai.generateContent(
        prompt,
        options.debug ? `condense_${comment.id}` : undefined,
        `condense_${comment.id}`,
        {
          taskType: 'condense',
          taskLevel: 0,
          params: { commentId: comment.id }
        }
      );
      
      // Parse the response into sections
      const { sections, errors } = parseCondensedSections(response);
      
      // Log any parsing errors
      if (errors.length > 0) {
        console.warn(`  [${comment.id}] ⚠️  Parsing issues:`);
        errors.forEach(err => console.warn(`    - ${err}`));
      }
      
      // Save result with structured sections
      withTransaction(db, () => {
        // Don't add the full response as detailedContent - it's already parsed from the response
        insertCondensed.run(
          comment.id, 
          JSON.stringify(sections),
          comment.markdown.trim().split(/\s+/).length
        );
      });
      
      successful++;
      console.log(`  [${comment.id}] ✅ Condensed successfully${errors.length > 0 ? ' (with warnings)' : ''}`);
      
    } catch (error) {
      failed++;
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`  [${comment.id}] ❌ Error: ${errorMsg}`);
      
      updateFailed.run(comment.id, errorMsg);
    }
  }
  
  // Run pool
  await runPool(comments, concurrency, async (comment, index) => {
    activeWorkers.add(comment.id);
    await processComment(comment);
    activeWorkers.delete(comment.id);
  });
  
  // Final summary
  console.log("\n📊 Condensing complete:");
  console.log(`  ✅ Successful: ${successful}`);
  console.log(`  ❌ Failed: ${failed}`);
  console.log(`  📄 Total processed: ${processed}`);
  
  // Show updated status
  const finalStatus = getProcessingStatus(db, "condensed_comments");
  console.log("\n📈 Overall progress:");
  console.log(`  ✅ Completed: ${finalStatus.completed}`);
  console.log(`  ❌ Failed: ${finalStatus.failed}`);
  console.log(`  ⏳ Remaining: ${finalStatus.pending}`);
  
  db.close();
}
