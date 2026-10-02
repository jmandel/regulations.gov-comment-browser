import { Command } from "commander";
import { openDb, withTransaction } from "../lib/database";
import type { Database } from "bun:sqlite";
import { initDebug, debugSave } from "../lib/debug";
import { UsageTally } from "../lib/ai-client";
import { parseThemeHierarchy, selectThemeDiscoveryUnits, seededOrder, type DiscoveryUnit } from "../lib/comment-processing";
import { createEvenBatches, countWords, DEFAULT_BATCH_OPTIONS } from "../lib/batch-processor";
import { THEME_DISCOVERY_PROMPT, THEME_MERGE_PROMPT } from "../prompts/theme-discovery";
import { getTaskConfig, getBatchOptions, getTaskRoleModel } from "../lib/batch-config";
import { runLlmRequests, type LlmRequest } from "../lib/step-runner";

// Theme discovery runs on a sample of units, not all of them: every form-letter representative,
// promoted member and attachment letter, plus a seeded random sample of typed-only comments
// (tasks.discoverThemes.thresholds.typedSample). Serious letters are almost all attachments, and
// a theme backed only by typed comments shows up in a sample of ~1,000 of them (a topic in 0.3% of
// typed comments is missed with probability ~5%).
const DEFAULT_TYPED_SAMPLE = 1000;

export const discoverThemesCommand = new Command("discover-themes")
  .description("Discover theme hierarchy from condensed comments")
  .argument("<document-id>", "Document ID (e.g., CMS-2025-0050-0031)")
  .option("-l, --limit <n>", "Use only the first N selected units (for testing)", parseInt)
  .option("--typed-sample <n>", "Typed-only units to sample (overrides config; 0 = none)", parseInt)
  .option("--seed <s>", "Seed for the typed-comment sample (default: 1)")
  .option("--batch-limit <n>", "Word limit to trigger batching (default: from config)", parseInt)
  .option("--batch-size <n>", "Target words per batch (default: from config)", parseInt)
  .option("-d, --debug", "Enable debug output")
  .option("-c, --concurrency <n>", "Number of parallel API calls", parseInt)
  .option("-m, --model <model>", "AI model to use for every call (overrides config)")
  .option("--merge-width <n>", "Number of taxonomies to merge at once (default: 10)", parseInt)
  .option("--use-clustering", "Consider only cluster representatives")
  .option("--batch", "Run the per-batch discovery calls through the Gemini Batch API (half price, slower); merges stay live")
  .action(discoverThemes);

async function discoverThemes(documentId: string, options: any) {
  await initDebug(options.debug);

  const db = openDb(documentId);
  const taskConfig = getTaskConfig('discoverThemes', options.model);
  const batchModel = getTaskRoleModel('discoverThemes', 'batch', options.model);
  const mergeModel = getTaskRoleModel('discoverThemes', 'merge', options.model);

  console.log(`🔍 Discovering themes for document ${documentId}`);
  console.log(`   Models: batch=${batchModel} merge=${mergeModel}`);

  const existingThemes = db.prepare("SELECT COUNT(*) as count FROM theme_hierarchy").get() as { count: number };
  if (existingThemes.count > 0) {
    console.log(`⚠️  Themes already discovered (${existingThemes.count} themes in hierarchy)`);
    console.log("   To re-run, clear theme_hierarchy table first");
    db.close();
    return;
  }

  // Select units
  const typedSample: number = options.typedSample ?? taskConfig.thresholds?.typedSample ?? DEFAULT_TYPED_SAMPLE;
  const seed = options.seed ?? taskConfig.thresholds?.sampleSeed ?? 1;
  const { units: selected, composition } = selectThemeDiscoveryUnits(db, { typedSample, seed, repsOnly: !!options.useClustering });
  // --limit takes a seeded random subset across all strata
  const units = options.limit ? seededOrder(selected, seed).slice(0, options.limit) : selected;
  if (units.length === 0) {
    console.log("❌ No condensed comments found. Run 'condense' command first.");
    db.close();
    return;
  }

  for (const u of units) {
    u.content = formatDiscoveryBlock(u);
    u.wordCount = countWords(u.content);
  }
  const totalWords = units.reduce((sum, c) => sum + c.wordCount, 0);
  console.log(`📊 Discovery input (typed sample ${typedSample}, seed ${seed}${options.useClustering ? ', representatives only' : ''}):`);
  for (const [st, c] of Object.entries(composition)) {
    const used = units.filter(u => u.stratum === st);
    console.log(`   ${st.padEnd(12)} ${String(used.length).padStart(6)} of ${String(c.available).padStart(6)} available, ${used.reduce((s, u) => s + u.wordCount, 0).toLocaleString()} prompt words`);
  }
  console.log(`   total        ${String(units.length).padStart(6)} units, ${totalWords.toLocaleString()} prompt words${options.limit ? ` (--limit ${options.limit})` : ''}`);

  // Batches, sized by the words actually sent (the condensed sections), not the full transcript
  const batchOptions = getBatchOptions('discoverThemes');
  const batchLimit = options.batchLimit || batchOptions?.triggerWordLimit || DEFAULT_BATCH_OPTIONS.totalWordLimit;
  const batchWordLimit = options.batchSize || batchOptions?.batchWordLimit || DEFAULT_BATCH_OPTIONS.batchWordLimit;
  const batches = totalWords <= batchLimit
    ? [{ items: units, wordCount: totalWords, number: 1 }]
    : createEvenBatches(units, { batchWordLimit, totalWordLimit: 0 });
  const mergeWidth = options.mergeWidth || taskConfig.mergeWidth;
  console.log(`📋 ${batches.length} discovery batch(es) of ≤${batchWordLimit.toLocaleString()} words; ${mergeWidth}-way merges`);

  const concurrency = options.concurrency || taskConfig.concurrency;
  const tally = new UsageTally();

  // Level 0: one discovery call per batch (independent, so --batch can run them as one job)
  const batchRequests: LlmRequest[] = batches.map((b, i) => ({
    key: `batch_${i}`,
    model: batchModel,
    parts: [{ text: THEME_DISCOVERY_PROMPT.replace("{COMMENTS}", b.items.map(u => u.content).join("\n\n")) }],
  }));
  let current = await runLevel(db, batchRequests, "theme-discovery", options.batch ? "batch" : "live", concurrency, tally, options.debug);

  // Merges: level by level until one taxonomy is left. A single batch still goes through one
  // merge, which applies the two-level reshaping in the merge prompt.
  let level = 1;
  do {
    const groups = splitEvenly(current, mergeWidth);
    const requests: LlmRequest[] = groups.map((g, i) => ({
      key: `merge_L${level}_P${i}`,
      model: mergeModel,
      parts: [{ text: THEME_MERGE_PROMPT.replace("{TAXONOMIES}", g.map((content, j) =>
        `--- INPUT TAXONOMY ${j + 1} ---\n${content}\n--- END OF INPUT TAXONOMY ${j + 1} ---`).join("\n\n")) }],
    }));
    console.log(`🔀 Merge level ${level}: ${current.length} → ${groups.length}`);
    current = await runLevel(db, requests, "theme-discovery-merge", "live", concurrency, tally, options.debug);
    level++;
  } while (current.length > 1);

  console.log("\n💾 Saving theme hierarchy...");
  saveThemeHierarchy(db, current[0]);
  const themeCount = db.prepare("SELECT COUNT(*) as count FROM theme_hierarchy").get() as { count: number };
  console.log("\n✅ Theme discovery complete!");
  console.log(`   Themes: ${themeCount.count}`);
  tally.print(`discover-themes (${units.length} units, ${batches.length} batches, ${level - 1} merge levels)`);

  db.close();
}

// Run one level of independent requests; every request must produce a parseable taxonomy
async function runLevel(
  db: Database, requests: LlmRequest[], task: string, mode: "live" | "batch",
  concurrency: number, tally: UsageTally, debug: boolean
): Promise<string[]> {
  const results = new Map<string, string>();
  const summary = await runLlmRequests(requests, async (req, res) => {
    const text = res.text.trim();
    if (parseThemeHierarchy(text).length === 0) throw new Error("no themes parsed from response");
    results.set(req.key, text);
    if (debug) {
      await debugSave(`themes_${req.key}_prompt.txt`, req.parts[0].text!);
      await debugSave(`themes_${req.key}_response.txt`, text);
    }
  }, { db, task, mode, concurrency, label: `${task}:${requests.length}` });
  tally.addSummary(task, summary);
  const missing = requests.filter(r => !results.has(r.key)).map(r => r.key);
  if (missing.length) throw new Error(`${task}: no usable result for ${missing.join(", ")}`);
  return requests.map(r => results.get(r.key)!);
}

function splitEvenly<T>(items: T[], width: number): T[][] {
  const n = Math.ceil(items.length / Math.max(2, width));
  const groups: T[][] = Array.from({ length: n }, () => []);
  const base = Math.floor(items.length / n), extra = items.length % n;
  let k = 0;
  for (let g = 0; g < n; g++) for (let i = 0; i < base + (g < extra ? 1 : 0); i++) groups[g].push(items[k++]);
  return groups;
}

export function formatDiscoveryBlock(c: DiscoveryUnit): string {
  const sections: any = c.structuredSections || {};
  const metadata = c.metadata;
  let content = `<comment id="${c.id}">
<submitter>${metadata.submitter || 'Anonymous'}</submitter>
<submitter_type>${metadata.submitterType || 'Individual'}</submitter_type>`;
  if (c.groupSize >= 4) content += `\n<form_letter submissions="${c.groupSize}"/>`;
  if (sections.commenterProfile) content += `\n<commenter_profile>${sections.commenterProfile}</commenter_profile>`;
  if (sections.corePosition) content += `\n<core_position>${sections.corePosition}</core_position>`;
  if (sections.keyRecommendations && sections.keyRecommendations !== "No specific recommendations provided") {
    content += `\n<key_recommendations>${sections.keyRecommendations}</key_recommendations>`;
  }
  if (sections.mainConcerns && sections.mainConcerns !== "No specific concerns raised") {
    content += `\n<main_concerns>${sections.mainConcerns}</main_concerns>`;
  }
  return content + `\n</comment>`;
}

// Save theme hierarchy to database
function saveThemeHierarchy(db: Database, themesText: string) {
  const themes = parseThemeHierarchy(themesText);

  const insertTheme = db.prepare(`
    INSERT INTO theme_hierarchy (code, description, level, parent_code, detailed_guidelines)
    VALUES (?, ?, ?, ?, ?)
  `);

  withTransaction(db, () => {
    for (const theme of themes) {
      insertTheme.run(
        theme.code,
        theme.description,
        theme.level,
        theme.parent_code,
        theme.detailed_guidelines || null
      );
    }
  });
}
