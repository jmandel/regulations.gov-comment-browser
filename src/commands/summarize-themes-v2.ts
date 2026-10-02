import { Command } from "commander";
import { openDb, withTransaction } from "../lib/database";
import type { Database } from "bun:sqlite";
import { initDebug, debugSave } from "../lib/debug";
import { UsageTally } from "../lib/ai-client";
import { THEME_SUMMARY_FROM_EXTRACTS_PROMPT, EXTRACT_MERGE_PROMPT } from "../prompts/theme-extract";
import { THEME_SUMMARY_STRUCTURE_PROMPT } from "../prompts/theme-summary";
import { parseJsonResponse } from "../lib/json-parser";
import { getTaskConfig, getTaskRoleModel, getBatchOptions } from "../lib/batch-config";
import { createEvenBatches, countWords } from "../lib/batch-processor";
import { checkClusteringStatus, extractMetadata } from "../lib/comment-processing";
import { runLlmRequests, type LlmRequest } from "../lib/step-runner";

// Summaries run in phases across all themes at once, so independent calls run in parallel and
// each phase can use the Batch API:
//   1. summarize each batch of a theme's extracts (one batch for most themes)
//   2. for themes with several batches, merge the analyses mergeWidth at a time, level by level
//   3. convert each theme's final analysis to the structured JSON stored in theme_summaries
// Every call goes through runLlmRequests, so a rerun reuses finished calls from llm_cache.

export const summarizeThemesV2Command = new Command("summarize-themes-v2")
  .description("Generate theme summaries from pre-extracted theme-specific content")
  .argument("<document-id>", "Document ID (e.g., CMS-2025-0050-0031)")
  .option("--themes <codes>", "Comma-separated list of theme codes to analyze (default: all)")
  .option("--min-comments <n>", "Minimum comments required for a theme (default: 5)", parseInt)
  .option("--batch-limit <n>", "Word limit to trigger batching (default: from config)", parseInt)
  .option("--batch-size <n>", "Target words per batch (default: from config)", parseInt)
  .option("--merge-width <n>", "Batch analyses merged per call (default: from config)", parseInt)
  .option("-d, --debug", "Enable debug output")
  .option("-c, --concurrency <n>", "Number of parallel API calls", parseInt)
  .option("-m, --model <model>", "AI model to use for every call (overrides config)")
  .option("--use-clustering", "Use only cluster representatives' extracts (weighted by cluster size)")
  .option("--batch", "Run calls through the Gemini Batch API (half price, minutes-to-hours per phase)")
  .action(summarizeThemesV2);

interface ExtractRow {
  comment_id: string;
  extract_json: string;
  cluster_size: number;
  structured_sections: string | null;
  attributes_json: string;
}

interface ThemeRow { code: string; description: string; detailed_guidelines?: string; extract_count: number }

interface ThemeWork {
  theme: ThemeRow;
  extracts: ExtractRow[];
  analyses: string[];   // current level's analyses; one left = final
}

async function summarizeThemesV2(documentId: string, options: any) {
  await initDebug(options.debug);

  const db = openDb(documentId);
  const models = {
    summary: getTaskRoleModel('summarizeThemes', 'summary', options.model),
    merge: getTaskRoleModel('summarizeThemes', 'merge', options.model),
    structure: getTaskRoleModel('summarizeThemes', 'structure', options.model),
  };
  console.log(`📝 Summarizing themes (v2) for document ${documentId}`);
  console.log(`   Models: summary=${models.summary} merge=${models.merge} structure=${models.structure}`);

  const repsOnly = !!options.useClustering;
  if (repsOnly && !checkClusteringStatus(db)) {
    console.error("❌ No clustering data found. Run the cluster step first.");
    process.exit(1);
  }
  const repFilter = repsOnly
    ? ` AND cte.comment_id IN (SELECT comment_id FROM comment_cluster_membership WHERE is_representative = 1)`
    : '';

  const taskConfig = getTaskConfig('summarizeThemes', options.model);
  const minComments = options.minComments || taskConfig.thresholds?.minCommentsPerTheme || 5;

  let themeQuery = `
    SELECT th.code, th.description, th.detailed_guidelines, COUNT(DISTINCT cte.comment_id) as extract_count
    FROM theme_hierarchy th
    INNER JOIN comment_theme_extracts cte ON th.code = cte.theme_code
    WHERE 1 = 1 ${repFilter}`;
  const queryParams: any[] = [];
  if (options.themes) {
    const themeCodes = options.themes.split(',').map((t: string) => t.trim());
    themeQuery += ` AND th.code IN (${themeCodes.map(() => '?').join(',')})`;
    queryParams.push(...themeCodes);
  }
  themeQuery += ` GROUP BY th.code HAVING extract_count >= ? ORDER BY extract_count DESC`;
  queryParams.push(minComments);

  const themes = db.prepare(themeQuery).all(...queryParams) as ThemeRow[];
  if (themes.length === 0) {
    console.log("❌ No themes found with sufficient extracts");
    db.close();
    return;
  }
  console.log(`📊 Found ${themes.length} themes with ≥${minComments} extracts`);

  const existingCodes = new Set((db.prepare("SELECT theme_code FROM theme_summaries").all() as { theme_code: string }[]).map(s => s.theme_code));
  const themesToProcess = themes.filter(t => !existingCodes.has(t.code));
  if (themesToProcess.length === 0) {
    console.log("✅ All themes already summarized");
    db.close();
    return;
  }
  console.log(`🆕 ${themesToProcess.length} themes need summarization`);

  const concurrency = options.concurrency || taskConfig.concurrency || 4;
  const mode: "live" | "batch" = options.batch ? "batch" : "live";
  const mergeWidth = Math.max(2, options.mergeWidth || taskConfig.mergeWidth || 4);
  const batchConfig = getBatchOptions('summarizeThemes');
  const triggerWords = options.batchLimit || batchConfig?.triggerWordLimit || 50000;
  const batchWords = options.batchSize || batchConfig?.batchWordLimit || 40000;
  const tally = new UsageTally();

  const extractStmt = db.prepare(`
    SELECT cte.comment_id, cte.extract_json, cte.cluster_size, cc.structured_sections, c.attributes_json
    FROM comment_theme_extracts cte
    JOIN comments c ON c.id = cte.comment_id
    -- LEFT JOIN: stance_only triaged comments have extracts but no condensed row
    LEFT JOIN condensed_comments cc ON cte.comment_id = cc.comment_id
    WHERE cte.theme_code = ? ${repFilter}
    ORDER BY cte.cluster_size DESC, cte.comment_id`);

  // ---- Phase 1: per-batch analyses ----
  const work: ThemeWork[] = [];
  const phase1: LlmRequest[] = [];
  const batchCount = new Map<string, number>();
  for (const theme of themesToProcess) {
    const extracts = extractStmt.all(theme.code) as ExtractRow[];
    const items = extracts.map(e => {
      const block = formatExtractBlock(e);
      return { ...e, block, wordCount: countWords(block) };
    });
    const totalWords = items.reduce((s, i) => s + i.wordCount, 0);
    const batches = totalWords <= triggerWords
      ? [{ items, wordCount: totalWords, number: 1 }]
      : createEvenBatches(items, { batchWordLimit: batchWords, totalWordLimit: 0 });
    batchCount.set(theme.code, batches.length);
    if (batches.length > 1) console.log(`   ${theme.code}: ${extracts.length} extracts, ${totalWords.toLocaleString()} words → ${batches.length} batches`);
    work.push({ theme, extracts, analyses: [] });
    batches.forEach((b, i) => phase1.push({
      key: `${theme.code}|b${i}`,
      model: models.summary,
      parts: [{ text: buildSummaryPrompt(theme, b.items) }],
    }));
  }
  console.log(`📋 Phase 1: ${phase1.length} summary calls for ${work.length} themes (largest theme: ${Math.max(...batchCount.values())} batches)`);
  const byCode = new Map(work.map(w => [w.theme.code, w]));
  const p1 = await runText(db, phase1, 'theme-summary', mode, concurrency, tally, options.debug);
  for (const w of work) {
    const texts = Array.from({ length: batchCount.get(w.theme.code)! }, (_, i) => p1.get(`${w.theme.code}|b${i}`));
    // A theme with a failed batch is skipped; a rerun retries just those calls (the rest are cached)
    if (texts.some(t => t === undefined)) console.error(`   ❌ ${w.theme.code}: summary batch failed; rerun to retry`);
    else w.analyses = texts as string[];
  }
  let active = work.filter(w => w.analyses.length > 0);
  
  // ---- Phase 2: hierarchical merges ----
  for (let level = 1; active.some(w => w.analyses.length > 1); level++) {
    const requests: LlmRequest[] = [];
    for (const w of active) {
      if (w.analyses.length <= 1) continue;
      splitEvenly(w.analyses, mergeWidth).forEach((group, i) => {
        if (group.length > 1) requests.push({
          key: `${w.theme.code}|L${level}|P${i}`,
          model: models.merge,
          parts: [{ text: buildMergePrompt(w.theme, group) }],
        });
      });
    }
    console.log(`🔀 Phase 2, merge level ${level}: ${requests.length} merge calls`);
    const res = await runText(db, requests, 'theme-summary-merge', mode, concurrency, tally, options.debug);
    for (const w of active) {
      if (w.analyses.length <= 1) continue;
      const groups = splitEvenly(w.analyses, mergeWidth);
      const next = groups.map((g, i) => g.length === 1 ? g[0] : res.get(`${w.theme.code}|L${level}|P${i}`));
      if (next.some(x => x === undefined)) {
        console.error(`   ❌ ${w.theme.code}: merge failed at level ${level}; rerun to retry`);
        w.analyses = [];
      } else {
        w.analyses = next as string[];
      }
    }
    active = active.filter(w => w.analyses.length > 0);
  }

  // ---- Phase 3: structure to JSON and save (parse failures are retried once) ----
  const insert = db.prepare(`INSERT INTO theme_summaries (theme_code, structured_sections, comment_count, word_count) VALUES (?, ?, ?, ?)`);
  let pending = active;
  for (let attempt = 1; attempt <= 2 && pending.length > 0; attempt++) {
    const requests: LlmRequest[] = pending.map(w => ({
      key: w.theme.code,
      model: models.structure,
      parts: [{ text: THEME_SUMMARY_STRUCTURE_PROMPT
        .replace('{THEME_ANALYSIS}', () => w.analyses[0])
        .replace('{THEME_CODE}', w.theme.code)
        .replace('{THEME_DESCRIPTION}', () => fullDescription(w.theme)) }],
      // the retry differs from the first attempt so it isn't served from a stale cache
      config: attempt > 1 ? { responseMimeType: "application/json" } : undefined,
    }));
    console.log(`🧱 Phase 3: structuring ${requests.length} summaries${attempt > 1 ? ' (retry)' : ''}`);
    const saved = new Set<string>();
    const summary = await runLlmRequests(requests, async (req, res) => {
      const w = byCode.get(req.key)!;
      const sections = parseJsonResponse(res.text);
      if (!sections || typeof sections !== 'object') throw new Error('structured summary is not a JSON object');
      const fixed = fixPartialCommentIds(sections, new Set(w.extracts.map(e => e.comment_id)));
      if (fixed > 0) console.log(`   🔧 ${req.key}: fixed ${fixed} partial comment IDs`);
      withTransaction(db, () => insert.run(req.key, JSON.stringify(sections), w.extracts.length, 0));
      saved.add(req.key);
      if (options.debug) await debugSave(`theme_summary_v2_structured_${req.key}.json`, sections);
    }, { db, task: 'theme-summary-structure', mode, concurrency, label: `theme-summary-structure:${attempt}` });
    tally.addSummary('theme-summary-structure', summary);
    pending = pending.filter(w => !saved.has(w.theme.code));
  }
  for (const w of pending) console.error(`   ❌ ${w.theme.code}: could not structure summary`);

  const summaryCount = db.prepare("SELECT COUNT(*) as count FROM theme_summaries").get() as { count: number };
  console.log("\n✅ Theme summarization complete!");
  console.log(`   Total summaries: ${summaryCount.count}`);
  tally.print(`summarize-themes-v2 (${work.length} themes${mode === 'batch' ? ', batch price' : ''})`);
  db.close();
}

async function runText(
  db: Database, requests: LlmRequest[], task: string, mode: "live" | "batch",
  concurrency: number, tally: UsageTally, debug: boolean
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (requests.length === 0) return out;
  const summary = await runLlmRequests(requests, async (req, res) => {
    if (!res.text.trim()) throw new Error('empty response');
    out.set(req.key, res.text);
    if (debug) await debugSave(`${task}_${req.key.replace(/\|/g, '_')}_response.txt`, res.text);
  }, { db, task, mode, concurrency, label: `${task}:${requests.length}` });
  tally.addSummary(task, summary);
  return out;
}

function fullDescription(theme: ThemeRow): string {
  return theme.detailed_guidelines ? `${theme.description}. ${theme.detailed_guidelines}` : theme.description;
}

// Who the commenter is: the condensed profile, or for units without a condensed row (stance_only
// triaged comments) the submitter metadata
function commenterProfile(e: ExtractRow): string {
  const sections = JSON.parse(e.structured_sections || '{}');
  if (sections.commenterProfile) return sections.commenterProfile;
  const m = extractMetadata(JSON.parse(e.attributes_json || '{}'));
  return `${m.submitterType}: ${m.submitter}${m.location ? ` (${m.location})` : ''}`;
}

function formatExtractBlock(e: ExtractRow): string {
  const extract = JSON.parse(e.extract_json);
  let clusterLabel: string;
  if (e.cluster_size >= 100) clusterLabel = `[FORM LETTER - ${e.cluster_size} identical submissions]`;
  else if (e.cluster_size >= 10) clusterLabel = `[CLUSTER - ${e.cluster_size} similar submissions]`;
  else if (e.cluster_size > 1) clusterLabel = `[SMALL CLUSTER - ${e.cluster_size} similar comments]`;
  else clusterLabel = '[INDIVIDUAL]';

  const sections: [string, string[] | undefined][] = [
    ['Positions', extract.extract?.positions],
    ['Concerns', extract.extract?.concerns],
    ['Recommendations', extract.extract?.recommendations],
    ['Experiences/Examples', extract.extract?.experiences],
    ['Key Quotes', extract.extract?.key_quotes],
  ];
  const formatted = sections
    .filter(([, list]) => list && list.length > 0)
    .map(([title, list]) => `**${title}:**\n${list!.map(x => `- ${x}`).join('\n')}`)
    .join('\n\n');

  return `<comment id="${e.comment_id}">
${clusterLabel}
<commenter_profile>
${commenterProfile(e)}
</commenter_profile>

<theme_specific_content relevance="${extract.relevance}">
${formatted || 'No specific content extracted for this theme'}
</theme_specific_content>
</comment>`;
}

function buildSummaryPrompt(theme: ThemeRow, items: (ExtractRow & { block: string })[]): string {
  const totalComments = items.reduce((sum, e) => sum + e.cluster_size, 0);
  let clusteringContext = '';
  if (totalComments > items.length) {
    clusteringContext = `
IMPORTANT CONTEXT:
- You are analyzing ${items.length} unique perspectives
- These represent ${totalComments} total comments (including duplicates/similar submissions)
- Larger clusters (form letters, campaigns) should be weighted more heavily in your analysis
- When a perspective is marked as [FORM LETTER - N submissions] or [CLUSTER - N submissions], this means N people submitted identical or very similar comments
- Consider both the diversity of viewpoints AND the volume of support for each viewpoint
`;
  }
  // Function replacements: extract text may contain "$&"-style patterns
  return THEME_SUMMARY_FROM_EXTRACTS_PROMPT
    .replace('{THEME_CODE}', theme.code)
    .replace('{THEME_DESCRIPTION}', () => fullDescription(theme))
    .replace('{EXTRACTS}', () => clusteringContext + items.map(i => i.block).join('\n\n---\n\n'));
}

function buildMergePrompt(theme: ThemeRow, analyses: string[]): string {
  const blocks = analyses.map((r, i) => `<batch_analysis number="${i + 1}">\n${r}\n</batch_analysis>`).join('\n\n');
  return EXTRACT_MERGE_PROMPT
    .replace('{THEME_CODE}', theme.code)
    .replace('{THEME_DESCRIPTION}', () => fullDescription(theme))
    .replace('{EXTRACT_SETS}', () => blocks);
}

function splitEvenly<T>(items: T[], width: number): T[][] {
  const n = Math.ceil(items.length / width);
  const groups: T[][] = Array.from({ length: n }, () => []);
  const base = Math.floor(items.length / n), extra = items.length % n;
  let k = 0;
  for (let g = 0; g < n; g++) for (let i = 0; i < base + (g < extra ? 1 : 0); i++) groups[g].push(items[k++]);
  return groups;
}

/**
 * Fix partial/abbreviated comment IDs in structured JSON.
 * The LLM sometimes outputs just the suffix (e.g., "0232", "-0241")
 * instead of the full ID (e.g., "HHS-ONC-2026-0001-0232").
 * We match partial IDs against the known set of full IDs from the extracts.
 */
function fixPartialCommentIds(obj: any, knownIds: Set<string>): number {
  let fixedCount = 0;

  function fixId(id: string): string {
    if (typeof id !== 'string' || !id.trim()) return id;
    if (knownIds.has(id)) return id; // Already a full valid ID

    // Strip leading dash if present (e.g., "-0241" → "0241")
    const suffix = id.replace(/^-/, '');

    // Find all known IDs ending with this suffix
    const matches = [...knownIds].filter(full => full.endsWith('-' + suffix));
    if (matches.length === 1) {
      fixedCount++;
      return matches[0];
    }
    // Ambiguous or no match — return original
    return id;
  }

  function walk(node: any) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((_, i) => {
        if (typeof node[i] === 'object') walk(node[i]);
      });
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'commentId' && typeof value === 'string') {
        node[key] = fixId(value);
      } else if (key === 'commentIds' && Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          if (typeof value[i] === 'string') {
            value[i] = fixId(value[i]);
          }
        }
      } else if (typeof value === 'object' && value !== null) {
        walk(value);
      }
    }
  }

  walk(obj);
  return fixedCount;
}
