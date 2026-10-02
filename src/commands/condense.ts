import { Command } from "commander";
import { openDb, withTransaction, getProcessingStatus } from "../lib/database";
import { initDebug } from "../lib/debug";
import { checkClusteringStatus } from "../lib/comment-processing";
import { CONDENSE_PROMPT } from "../prompts/condense";
import { parseCondensedSections } from "../lib/parse-condensed-sections";
import { getTaskConfig, getTaskRoleModel } from "../lib/batch-config";
import { runLlmRequests, estimateCost, type LlmRequest } from "../lib/step-runner";

export const condenseCommand = new Command("condense")
  .description("Generate condensed versions of comments")
  .argument("<document-id>", "Document ID (e.g., CMS-2025-0050-0031)")
  .option("-l, --limit <n>", "Process only N comments", parseInt)
  .option("--retry-failed", "Retry previously failed comments")
  .option("--use-clustering", "Only condense representative comments from clusters")
  .option("--batch", "Submit through the Gemini Batch API (half price, slower)")
  .option("-d, --debug", "Enable debug output")
  .option("-c, --concurrency <n>", "Number of parallel API calls (default: 5)", parseInt)
  .option("-m, --model <model>", "AI model to use for every comment (overrides config)")
  .action(condenseComments);

interface CondenseRow {
  id: string;
  attributes_json: string;
  markdown: string;
  is_attachment: number;
}

// Comments the triage step judged to carry nothing worth summarizing
const NOT_TRIAGED_OUT = `NOT EXISTS (
  SELECT 1 FROM comment_triage tr
  WHERE tr.comment_id = c.id AND tr.label IN ('no_substance', 'stance_only')
)`;

// Non-representative cluster members are covered by their representative's summary
const REPRESENTATIVE_ONLY = `NOT EXISTS (
  SELECT 1 FROM comment_cluster_membership ccm
  WHERE ccm.comment_id = c.id AND ccm.is_representative = 0
)`;

// Attachment letters and promoted form-letter members (campaign letter + substantial own text)
// get the stronger model; Flash-Lite omitted recommendations in long multi-issue letters
const IS_ATTACHMENT = `(
  EXISTS (SELECT 1 FROM attachments a WHERE a.comment_id = c.id)
  OR EXISTS (SELECT 1 FROM form_letter_additions fa WHERE fa.comment_id = c.id AND fa.promoted = 1)
) AS is_attachment`;

function buildMetadata(attributesJson: string): string {
  const attrs = JSON.parse(attributesJson || '{}');
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
  return metadataParts.length > 0
    ? metadataParts.join('\n')
    : 'No submitter metadata available';
}

async function condenseComments(documentId: string, options: any) {
  await initDebug(options.debug);

  const db = openDb(documentId);

  const typedModel = getTaskRoleModel('condense', 'typed', options.model);
  const attachmentModel = getTaskRoleModel('condense', 'attachment', options.model);

  console.log(`📝 Condensing comments for document ${documentId}`);
  console.log(`   Models: typed=${typedModel}, attachment=${attachmentModel}${options.batch ? ' (batch)' : ''}`);

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

  const triagedOut = (db.prepare(`
    SELECT COUNT(*) as count FROM comment_triage WHERE label IN ('no_substance', 'stance_only')
  `).get() as { count: number }).count;
  if (triagedOut > 0) {
    console.log(`🚦 Skipping ${triagedOut} comments triaged as no_substance/stance_only`);
  }

  // Build query - read from transcriptions, find ones not yet condensed
  const where = [
    options.retryFailed
      ? `cc.status = 'failed'`
      : `(cc.comment_id IS NULL OR cc.status IN ('pending', 'processing'))`,
    NOT_TRIAGED_OUT,
    ...(options.useClustering ? [REPRESENTATIVE_ONLY] : []),
  ];
  let query = `
    SELECT c.id, c.attributes_json, t.markdown, ${IS_ATTACHMENT}
    FROM comments c
    JOIN transcriptions t ON c.id = t.comment_id AND t.status = 'completed'
    LEFT JOIN condensed_comments cc ON c.id = cc.comment_id
    WHERE ${where.join('\n      AND ')}
    ORDER BY ${options.retryFailed ? 'cc.attempt_count ASC, ' : ''}c.id
  `;
  const params: any[] = [];
  if (options.limit) {
    query += " LIMIT ?";
    params.push(options.limit);
  }
  const comments = db.prepare(query).all(...params) as CondenseRow[];
  const attachmentCount = comments.filter(c => c.is_attachment).length;

  console.log(`🎯 Found ${comments.length} comments to process (${attachmentCount} attachment, ${comments.length - attachmentCount} typed)`);

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

  // Mark everything as processing up front; rows left in 'processing' (e.g. after a crash
  // while a batch job is pending) are picked up again on the next run
  withTransaction(db, () => {
    for (const c of comments) markProcessing.run(c.id);
  });

  const byId = new Map(comments.map(c => [c.id, c]));
  const requests: LlmRequest[] = comments.map(c => ({
    key: c.id,
    model: c.is_attachment ? attachmentModel : typedModel,
    parts: [{
      text: CONDENSE_PROMPT
        .replace("{COMMENTER_METADATA}", buildMetadata(c.attributes_json))
        .replace("{COMMENT_TEXT}", c.markdown),
    }],
  }));

  const taskConfig = getTaskConfig('condense', options.model);
  const concurrency = options.concurrency || taskConfig.concurrency;
  const done = new Set<string>();
  // Per-role usage, to keep an eye on what typed vs attachment comments cost
  const roleStats: Record<string, { calls: number; input: number; output: number; thoughts: number; cost: number }> = {};

  const summary = await runLlmRequests(requests, (req, res) => {
    const comment = byId.get(req.key)!;
    const { sections, errors } = parseCondensedSections(res.text);
    if (Object.keys(sections).length === 0) {
      const msg = `No sections parsed from response: ${errors.join('; ')}`;
      updateFailed.run(comment.id, msg);
      done.add(comment.id);
      throw new Error(msg);
    }
    if (errors.length > 0) {
      console.warn(`\n  [${comment.id}] ⚠️  Parsing issues:`);
      errors.forEach(err => console.warn(`    - ${err}`));
    }
    if (options.debug) {
      console.log(`  [${comment.id}] ✅ Condensed with ${req.model}${res.cached ? ' (cached)' : ''}`);
    }
    if (res.usage) {
      const role = comment.is_attachment ? 'attachment' : 'typed';
      const st = roleStats[role] ||= { calls: 0, input: 0, output: 0, thoughts: 0, cost: 0 };
      st.calls++;
      st.input += res.usage.promptTokenCount;
      st.output += res.usage.candidatesTokenCount;
      st.thoughts += res.usage.thoughtsTokenCount || 0;
      st.cost += estimateCost(req.model, res.usage, !!options.batch);
    }
    insertCondensed.run(
      comment.id,
      JSON.stringify(sections),
      comment.markdown.trim().split(/\s+/).length
    );
    done.add(comment.id);
  }, {
    db,
    task: 'condense',
    mode: options.batch ? 'batch' : 'live',
    concurrency,
    label: `condense:${documentId}`,
  });

  // Requests that errored never reached the handler
  const failedIds = comments.filter(c => !done.has(c.id)).map(c => c.id);
  withTransaction(db, () => {
    for (const id of failedIds) updateFailed.run(id, 'LLM request failed (see log)');
  });

  // Final summary
  console.log("\n📊 Condensing complete:");
  console.log(`  ✅ Successful: ${summary.ok} (${summary.cached} from cache)`);
  console.log(`  ❌ Failed: ${summary.failed}`);
  console.log(`  💰 Estimated cost: $${summary.costUsd.toFixed(2)}`);
  for (const [role, st] of Object.entries(roleStats)) {
    const avg = (n: number) => Math.round(n / st.calls);
    console.log(`     ${role} (${role === 'attachment' ? attachmentModel : typedModel}): ${st.calls} calls, avg in=${avg(st.input)} out=${avg(st.output)} thoughts=${avg(st.thoughts)}, $${(st.cost / st.calls).toFixed(4)}/call`);
  }

  // Show updated status
  const finalStatus = getProcessingStatus(db, "condensed_comments");
  console.log("\n📈 Overall progress:");
  console.log(`  ✅ Completed: ${finalStatus.completed}`);
  console.log(`  ❌ Failed: ${finalStatus.failed}`);
  console.log(`  ⏳ Remaining: ${finalStatus.pending}`);

  db.close();
}
