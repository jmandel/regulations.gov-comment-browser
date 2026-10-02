import { Command } from "commander";
import type { Database } from "bun:sqlite";
import { openDb, withTransaction } from "../lib/database";
import { initDebug, debugSave } from "../lib/debug";
import { checkClusteringStatus } from "../lib/comment-processing";
import { buildThemeExtractPrefix, buildThemeExtractComments } from "../prompts/theme-extract";
import { buildThemeGatePrompt, formatGateGroups, type GateGroup } from "../prompts/theme-gate";
import { parseJsonResponse } from "../lib/json-parser";
import { getTaskConfig, getTaskRoleModel } from "../lib/batch-config";
import { runLlmRequests, type LlmRequest, type RunSummary } from "../lib/step-runner";
import { htmlToText, wordCount } from "../lib/text";

// Two phases per unit (a cluster representative, or every comment without clustering):
//   1. gate:    which top-level theme groups the unit discusses (Flash-Lite; short units batched)
//   2. extract: one call per (group, long unit), or per (group, batch of short units), emitting
//               extracts only for themes the unit substantively discusses
// Units triaged no_substance are skipped; stance_only units (not condensed) use their raw text.
export const extractThemeContentCommand = new Command("extract-theme-content")
  .description("Extract theme-specific content from individual comments")
  .argument("<document-id>", "Document ID (e.g., CMS-2025-0050-0031)")
  .option("-l, --limit <n>", "Process only N comments", parseInt)
  .option("--retry-failed", "Retry previously failed extractions (failed work is always retried; kept for compatibility)")
  .option("--use-clustering", "Only extract from representative comments, include cluster sizes")
  .option("--force", "Re-gate and re-extract units that were already processed")
  .option("--batch", "Use the Gemini Batch API (half price, slower)")
  .option("--gate-only", "Run only the gate phase (which theme groups each unit discusses)")
  .option("-d, --debug", "Enable debug output")
  .option("-c, --concurrency <n>", "Number of parallel API calls", parseInt)
  .option("-m, --model <model>", "AI model to use for every role (overrides config)")
  .action(extractThemeContent);

const SECTIONS = ['positions', 'concerns', 'recommendations', 'experiences', 'key_quotes'];

// Helper function to check if a text item should be filtered
function shouldFilterText(text: string): boolean {
  const lowerText = text.toLowerCase();
  const words = lowerText.split(/\s+/).filter(w => w.length > 0);

  // Filter if <20 words and contains "no"
  if (words.length < 20 && words.includes("no")) {
    return true;
  }

  // Also filter common placeholder phrases
  const placeholderPhrases = [
    "nothing to extract",
    "no relevant",
    "no specific",
    "not addressed",
    "not discussed",
    "not mentioned",
    "no information",
    "no content",
    "the commenter did not",
    "the commenter does not"
  ];

  return placeholderPhrases.some(phrase => lowerText.includes(phrase));
}

// Build the stored extract ({ relevance: 1, extract: { positions, ... } }, the shape
// summarize-themes-v2 and the website build read), dropping weak or placeholder entries.
// Returns null if nothing remains.
function cleanExtract(raw: any): { relevance: number; extract: Record<string, string[]> } | null {
  // Accept both the trimmed format ({ positions, ... }) and the old one ({ relevance, extract })
  const body = raw?.extract && typeof raw.extract === 'object' ? raw.extract : raw;
  const cleaned = { relevance: 1, extract: {} as Record<string, string[]> };
  if (!body || typeof body !== 'object') return null;

  for (const section of SECTIONS) {
    if (!Array.isArray(body[section])) continue;
    const items = body[section].map((item: any) => {
      if (typeof item === 'string') return item;
      console.warn(`[cleanExtract] Warning: non-string value found in '${section}'. Stringifying item: ${JSON.stringify(item)}`);
      return JSON.stringify(item);
    }).filter((text: string) => text.trim() && !shouldFilterText(text));
    if (items.length > 0) cleaned.extract[section] = items;
  }

  return Object.keys(cleaned.extract).length > 0 ? cleaned : null;
}

// Group themes by top-level parent (e.g., "3.1" -> "3", "3.1.2" -> "3")
interface ThemeRow { code: string; description: string; detailed_guidelines?: string | null }
interface ThemeGroup {
  parentCode: string;
  themes: ThemeRow[];
  themeCodes: Set<string>;
  hierarchyText: string;   // full themes with guidelines, for extraction
  gate: GateGroup;         // group description + child names, for the gate
}

function groupThemesByTopLevel(themes: ThemeRow[]): ThemeGroup[] {
  const groups = new Map<string, ThemeGroup>();

  for (const theme of themes) {
    const parentCode = theme.code.split('.')[0];
    if (!groups.has(parentCode)) {
      groups.set(parentCode, {
        parentCode, themes: [], themeCodes: new Set(), hierarchyText: '',
        gate: { code: parentCode, description: '', children: [] },
      });
    }
    const g = groups.get(parentCode)!;
    g.themes.push(theme);
    g.themeCodes.add(theme.code);
  }

  for (const group of groups.values()) {
    group.hierarchyText = group.themes.map(t => {
      const fullDesc = t.detailed_guidelines ? `${t.description}. ${t.detailed_guidelines}` : t.description;
      return `${t.code}: ${fullDesc}`;
    }).join("\n");
    const top = group.themes.find(t => t.code === group.parentCode) || group.themes[0];
    // Gate sees each theme's name and summary sentence, not the "|| It includes ..." detail
    const brief = (t: ThemeRow) => t.description.split(' || ')[0].trim();
    group.gate.description = brief(top);
    group.gate.children = group.themes.filter(t => t !== top).map(t => `${t.code} ${brief(t)}`);
  }

  return Array.from(groups.values()).sort((a, b) => parseInt(a.parentCode) - parseInt(b.parentCode));
}

interface Unit {
  id: string;
  text: string;          // what the model sees: profile + overview + full comment
  words: number;         // words in the comment body, for the short/long split
  gateText: string;      // what the gate sees: long units get their condensed summary up front
  clusterSize: number;
  stanceOnly: boolean;
}

// Units: representatives (with --use-clustering) or all comments that were condensed, plus
// stance_only triaged comments (not condensed; their raw text is used). no_substance is skipped.
// Units with extracts from the old one-call-per-group method (no status rows) count as done.
function loadUnits(db: Database, options: any, shortMaxWords: number): Unit[] {
  const repJoin = options.useClustering ? `
      JOIN comment_cluster_membership ccm ON ccm.comment_id = c.id AND ccm.is_representative = 1
      JOIN comment_clusters ccl ON ccl.cluster_id = ccm.cluster_id` : "";
  const rows = db.prepare(`
    SELECT c.id,
           COALESCE(json_extract(c.attributes_json, '$.comment'), json_extract(c.attributes_json, '$.text')) AS raw_comment,
           cc.structured_sections, t.markdown, tr.label AS triage_label,
           ${options.useClustering ? "ccl.cluster_size" : "1"} AS cluster_size
    FROM comments c
    ${repJoin}
    LEFT JOIN condensed_comments cc ON cc.comment_id = c.id AND cc.status = 'completed'
    LEFT JOIN transcriptions t ON t.comment_id = c.id AND t.status = 'completed'
    LEFT JOIN comment_triage tr ON tr.comment_id = c.id
    WHERE (tr.label IS NULL OR tr.label != 'no_substance')
      AND (cc.comment_id IS NOT NULL OR tr.label = 'stance_only')
      ${options.force ? "" : `AND NOT (
        EXISTS (SELECT 1 FROM comment_theme_extracts e WHERE e.comment_id = c.id)
        AND NOT EXISTS (SELECT 1 FROM comment_theme_extract_status s WHERE s.comment_id = c.id))`}
    ORDER BY c.id
    ${options.limit ? "LIMIT " + Number(options.limit) : ""}
  `).all() as { id: string; raw_comment: string | null; structured_sections: string | null; markdown: string | null; triage_label: string | null; cluster_size: number }[];

  return rows.map(r => {
    if (r.triage_label === 'stance_only') {
      const body = htmlToText(r.raw_comment || '');
      const text = `## Full Comment\n${body}`;
      return { id: r.id, text, gateText: text, words: wordCount(body), clusterSize: r.cluster_size, stanceOnly: true };
    }
    const sections = JSON.parse(r.structured_sections || '{}');
    let text = '';
    if (sections.commenterProfile) text += `## Commenter Profile\n${sections.commenterProfile}\n\n`;
    if (sections.oneLineSummary) text += `## Comment Overview\n${sections.oneLineSummary}\n\n`;
    const body = r.markdown || JSON.stringify(sections);
    text += `## Full Comment\n${body}`;
    // A dense summary of the letter's points before the full text helps the gate catch
    // topics raised briefly deep inside long letters
    const summary = ['corePosition', 'keyRecommendations', 'mainConcerns', 'notableExperiences']
      .filter(k => sections[k]).map(k => `### ${k}\n${sections[k]}`).join('\n\n');
    const gateText = summary && wordCount(body) > shortMaxWords ? `## Summary of the Comment's Points\n${summary}\n\n${text}` : text;
    return { id: r.id, text, gateText, words: wordCount(body), clusterSize: r.cluster_size, stanceOnly: false };
  });
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function parseObject(text: string, singleKey?: string): Record<string, any> {
  let parsed: any;
  try {
    parsed = JSON.parse(text.replace(/```(?:json)?/g, "").trim());
  } catch {
    parsed = parseJsonResponse(text);
  }
  // A one-comment call sometimes answers with the bare value instead of {"c1": ...}
  if (Array.isArray(parsed) && singleKey) parsed = { [singleKey]: parsed };
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error("response is not a JSON object");
  return parsed;
}

function formatPhase(name: string, s: RunSummary): string {
  const u = s.usage;
  const cacheRate = u.input > 0 ? ` (${(u.cachedInput / u.input * 100).toFixed(0)}% cached)` : '';
  return `  ${name.padEnd(14)} calls=${s.ok + s.failed} (cached locally ${s.cached}, failed ${s.failed}) | in=${u.input.toLocaleString()}${cacheRate} out=${u.output.toLocaleString()} thoughts=${u.thoughts.toLocaleString()} | ~$${s.costUsd.toFixed(3)}`;
}

async function extractThemeContent(documentId: string, options: any) {
  await initDebug(options.debug);

  const db = openDb(documentId);

  const models = {
    gate: getTaskRoleModel('extractThemeContent', 'gate', options.model),
    short: getTaskRoleModel('extractThemeContent', 'short', options.model),
    long: getTaskRoleModel('extractThemeContent', 'long', options.model),
  };
  const taskConfig = getTaskConfig('extractThemeContent', options.model);
  const shortMaxWords: number = taskConfig.thresholds?.shortMaxWords ?? 400;
  const shortBatchSize: number = taskConfig.thresholds?.shortBatchSize ?? 15;
  const gateBatchSize: number = taskConfig.thresholds?.gateBatchSize ?? 40;
  const concurrency: number = options.concurrency || taskConfig.concurrency || 5;
  const mode = options.batch ? "batch" : "live";

  console.log(`🎯 Extracting theme-specific content for document ${documentId}`);
  console.log(`   Models: gate=${models.gate}, short=${models.short}, long=${models.long} (${mode})`);
  console.log(`   Short units ≤${shortMaxWords} words: ${gateBatchSize}/gate call, ${shortBatchSize}/extract call`);

  if (options.useClustering) {
    if (!checkClusteringStatus(db)) {
      console.error("❌ No clustering data found. Run 'cluster-comments-fast' first.");
      process.exit(1);
    }
    console.log("🔗 Using stored clustering to process only representative comments");
  }

  const themes = db.prepare(`
    SELECT code, description, detailed_guidelines FROM theme_hierarchy ORDER BY code
  `).all() as ThemeRow[];
  if (themes.length === 0) {
    console.log("❌ No theme hierarchy found. Run 'discover-themes' first.");
    return;
  }
  const themeGroups = groupThemesByTopLevel(themes);
  const groupByCode = new Map(themeGroups.map(g => [g.parentCode, g]));
  console.log(`📊 Loaded ${themes.length} themes in ${themeGroups.length} top-level groups: ${themeGroups.map(g => `${g.parentCode}(${g.themes.length})`).join(', ')}`);

  const units = loadUnits(db, options, shortMaxWords);
  const unitById = new Map(units.map(u => [u.id, u]));
  const isShort = (u: Unit) => u.words <= shortMaxWords;
  const nShort = units.filter(isShort).length;
  console.log(`🎯 ${units.length} units (${nShort} short, ${units.length - nShort} long, ${units.filter(u => u.stanceOnly).length} stance-only)`);
  if (units.length === 0) {
    console.log("✅ No comments to process");
    db.close();
    return;
  }

  if (options.force) {
    const ids = units.map(u => u.id);
    withTransaction(db, () => {
      for (const table of ['comment_theme_group_status', 'comment_theme_groups', 'comment_theme_extract_status', 'comment_theme_extracts']) {
        const del = db.prepare(`DELETE FROM ${table} WHERE comment_id = ?`);
        for (const id of ids) del.run(id);
      }
    });
  }

  const ruleTitle = (db.prepare("SELECT title FROM document_metadata LIMIT 1").get() as { title?: string } | null)?.title || null;
  const phases: [string, RunSummary][] = [];

  // ── Phase 1: gate ────────────────────────────────────────────────────────────────────────
  const gated = new Set((db.prepare("SELECT comment_id FROM comment_theme_group_status").all() as { comment_id: string }[]).map(r => r.comment_id));
  const toGate = units.filter(u => !gated.has(u.id));
  console.log(`\n🚪 Gate: ${toGate.length} units to gate (${units.length - toGate.length} already gated)`);

  if (toGate.length > 0) {
    const gateGroupsText = formatGateGroups(themeGroups.map(g => g.gate));
    const insertGroup = db.prepare("INSERT OR IGNORE INTO comment_theme_groups (comment_id, group_code) VALUES (?, ?)");
    const markGated = db.prepare("INSERT OR REPLACE INTO comment_theme_group_status (comment_id) VALUES (?)");
    const done = new Set<string>();

    const runGatePass = async (items: Unit[], shortSize: number, pass: string) => {
      const batches = new Map<string, Unit[]>();
      chunk(items.filter(isShort), shortSize).forEach((b, i) => batches.set(`gate-${pass}-s${i}`, b));
      for (const u of items.filter(u => !isShort(u))) batches.set(`gate-${pass}-l-${u.id}`, [u]);
      const requests: LlmRequest[] = [...batches].map(([key, batch]) => ({
        key,
        model: models.gate,
        // Short local ids: models copy "c17" more reliably than long docket-prefixed ids
        parts: [{ text: buildThemeGatePrompt(ruleTitle, gateGroupsText, batch.map((u, j) => ({ id: `c${j + 1}`, text: u.gateText }))) }],
        config: { responseMimeType: "application/json" },
      }));
      if (options.debug) for (const r of requests.slice(0, 3)) await debugSave(`theme_${r.key}_prompt.txt`, r.parts[0].text!);
      phases.push([`gate ${pass}`, await runLlmRequests(requests, async (req, res) => {
        const batch = batches.get(req.key)!;
        if (options.debug) await debugSave(`theme_${req.key}_response.txt`, res.text);
        const parsed = parseObject(res.text, batch.length === 1 ? 'c1' : undefined);
        withTransaction(db, () => {
          batch.forEach((u, j) => {
            const codes = parsed[`c${j + 1}`];
            if (!Array.isArray(codes)) return;
            // The gate answers with theme codes ("4.6"); store their top-level groups ("4")
            for (const code of codes) {
              const c = String(code).trim().replace(/\.$/, '').split('.')[0];
              if (groupByCode.has(c)) insertGroup.run(u.id, c);
            }
            markGated.run(u.id);
            done.add(u.id);
          });
        });
      }, { db, task: "theme-gate", mode, concurrency, label: `theme-gate-${pass}:${documentId}` })]);
    };

    await runGatePass(toGate, gateBatchSize, "p1");
    const missing = toGate.filter(u => !done.has(u.id));
    if (missing.length > 0) {
      console.log(`🔁 ${missing.length} units missing from gate responses; retrying in smaller batches`);
      await runGatePass(missing, Math.max(5, Math.ceil(gateBatchSize / 5)), "p2");
    }
    const stillMissing = toGate.filter(u => !done.has(u.id)).length;
    if (stillMissing > 0) console.warn(`⚠️  ${stillMissing} units could not be gated; re-run to retry them`);
  }

  // Gate distribution
  const unitGroups = new Map<string, string[]>();
  for (const r of db.prepare("SELECT comment_id, group_code FROM comment_theme_groups").all() as { comment_id: string; group_code: string }[]) {
    if (!unitById.has(r.comment_id) || !groupByCode.has(r.group_code)) continue;
    if (!unitGroups.has(r.comment_id)) unitGroups.set(r.comment_id, []);
    unitGroups.get(r.comment_id)!.push(r.group_code);
  }
  const gatedNow = new Set((db.prepare("SELECT comment_id FROM comment_theme_group_status").all() as { comment_id: string }[]).map(r => r.comment_id));
  const gatedUnits = units.filter(u => gatedNow.has(u.id));
  const avg = (us: Unit[]) => us.length ? (us.reduce((s, u) => s + (unitGroups.get(u.id)?.length || 0), 0) / us.length).toFixed(1) : '-';
  console.log(`   Groups per unit: short ${avg(gatedUnits.filter(isShort))}, long ${avg(gatedUnits.filter(u => !isShort(u)))} of ${themeGroups.length}; ${gatedUnits.filter(u => !unitGroups.has(u.id)).length} units address no group`);

  if (options.gateOnly) {
    for (const [name, s] of phases) console.log(formatPhase(name, s));
    db.close();
    return;
  }

  // ── Phase 2: extract ─────────────────────────────────────────────────────────────────────
  const extracted = new Set((db.prepare("SELECT comment_id || '|' || group_code AS k FROM comment_theme_extract_status").all() as { k: string }[]).map(r => r.k));
  // Work grouped by theme group so calls sharing a prefix run close together (implicit caching)
  const work = new Map<string, { short: Unit[]; long: Unit[] }>();
  for (const g of themeGroups) work.set(g.parentCode, { short: [], long: [] });
  let pairs = 0;
  const touched = new Set(toGate.map(u => u.id));   // units this run paid for, for the per-unit cost
  for (const u of units) {
    for (const code of unitGroups.get(u.id) || []) {
      if (extracted.has(`${u.id}|${code}`)) continue;
      touched.add(u.id);
      (isShort(u) ? work.get(code)!.short : work.get(code)!.long).push(u);
      pairs++;
    }
  }
  console.log(`\n🧩 Extract: ${pairs} (unit, group) pairs to extract (${extracted.size} already done)`);

  const insertExtract = db.prepare(`
    INSERT OR REPLACE INTO comment_theme_extracts (comment_id, theme_code, extract_json, cluster_size)
    VALUES (?, ?, ?, ?)
  `);
  const markExtracted = db.prepare("INSERT OR REPLACE INTO comment_theme_extract_status (comment_id, group_code) VALUES (?, ?)");
  const doneExtract = new Set<string>();
  let saved = 0, offGroup = 0;

  const runExtractPass = async (byGroup: Map<string, { short: Unit[]; long: Unit[] }>, shortSize: number, pass: string, role: 'short' | 'long') => {
    const batches = new Map<string, { group: ThemeGroup; units: Unit[] }>();
    for (const [code, w] of byGroup) {
      const group = groupByCode.get(code)!;
      if (role === 'short') chunk(w.short, shortSize).forEach((b, i) => batches.set(`g${code}-${pass}-s${i}`, { group, units: b }));
      else for (const u of w.long) batches.set(`g${code}-${pass}-l-${u.id}`, { group, units: [u] });
    }
    if (batches.size === 0) return;
    const prefixes = new Map(themeGroups.map(g => [g.parentCode, buildThemeExtractPrefix(g.hierarchyText)]));
    const requests: LlmRequest[] = [...batches].map(([key, b]) => ({
      key,
      model: models[role],
      parts: [
        { text: prefixes.get(b.group.parentCode)! },
        { text: buildThemeExtractComments(b.units.map((u, j) => ({ id: `c${j + 1}`, text: u.text }))) },
      ],
      config: { responseMimeType: "application/json" },
    }));
    if (options.debug) for (const r of requests.slice(0, 3)) await debugSave(`theme_extract_${r.key}_prompt.txt`, r.parts.map(p => p.text).join(''));

    phases.push([`extract ${role} ${pass}`, await runLlmRequests(requests, async (req, res) => {
      const { group, units: batch } = batches.get(req.key)!;
      if (options.debug) await debugSave(`theme_extract_${req.key}_response.txt`, res.text);
      let parsed = parseObject(res.text);
      // A single-comment response sometimes drops the "c1" wrapper
      if (batch.length === 1 && !('c1' in parsed) && Object.keys(parsed).every(k => group.themeCodes.has(k))) parsed = { c1: parsed };
      withTransaction(db, () => {
        batch.forEach((u, j) => {
          const entry = parsed[`c${j + 1}`];
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
          for (const [themeCode, raw] of Object.entries(entry)) {
            if (!group.themeCodes.has(themeCode)) { offGroup++; continue; }
            const cleaned = cleanExtract(raw);
            if (!cleaned) continue;
            insertExtract.run(u.id, themeCode, JSON.stringify(cleaned), u.clusterSize);
            saved++;
          }
          markExtracted.run(u.id, group.parentCode);
          doneExtract.add(`${u.id}|${group.parentCode}`);
        });
      });
    }, { db, task: `theme-extract-${role}`, mode, concurrency, label: `theme-extract-${role}-${pass}:${documentId}` })]);
  };

  await runExtractPass(work, shortBatchSize, "p1", 'short');
  await runExtractPass(work, shortBatchSize, "p1", 'long');

  // Short units missing from a batched response get a call of their own
  const retry = new Map<string, { short: Unit[]; long: Unit[] }>();
  let nRetry = 0;
  for (const [code, w] of work) {
    const missing = w.short.filter(u => !doneExtract.has(`${u.id}|${code}`));
    if (missing.length > 0 && w.short.length > 1) { retry.set(code, { short: missing, long: [] }); nRetry += missing.length; }
  }
  if (nRetry > 0) {
    console.log(`🔁 ${nRetry} short (unit, group) pairs missing from batched responses; retrying one per call`);
    await runExtractPass(retry, 1, "p2", 'short');
  }
  const failedPairs = pairs - doneExtract.size;
  if (failedPairs > 0) console.warn(`⚠️  ${failedPairs} (unit, group) pairs not extracted; re-run to retry them`);
  if (offGroup > 0) console.warn(`⚠️  ignored ${offGroup} extracts for theme codes outside the requested group`);

  // ── Summary ──────────────────────────────────────────────────────────────────────────────
  console.log("\n📊 Extraction complete:");
  console.log(`  🧾 ${saved} theme extracts saved from ${doneExtract.size} (unit, group) pairs`);
  for (const [name, s] of phases) console.log(formatPhase(name, s));
  const total = phases.reduce((acc, [, s]) => {
    acc.cost += s.costUsd; acc.input += s.usage.input; acc.cached += s.usage.cachedInput;
    acc.output += s.usage.output; acc.thoughts += s.usage.thoughts;
    return acc;
  }, { cost: 0, input: 0, cached: 0, output: 0, thoughts: 0 });
  console.log(`  ${'total'.padEnd(14)} in=${total.input.toLocaleString()} (cached ${total.cached.toLocaleString()}) out=${total.output.toLocaleString()} thoughts=${total.thoughts.toLocaleString()} | ~$${total.cost.toFixed(3)}${mode === "batch" ? " (batch price)" : ""} | ~$${(total.cost / Math.max(1, touched.size)).toFixed(4)}/unit over ${touched.size} units`);

  const coverage = db.prepare(`
    SELECT th.code, COUNT(DISTINCT cte.comment_id) as extracted_count
    FROM theme_hierarchy th
    LEFT JOIN comment_theme_extracts cte ON th.code = cte.theme_code
    GROUP BY th.code
    ORDER BY extracted_count DESC
    LIMIT 10
  `).all() as { code: string; extracted_count: number }[];

  console.log("\n📈 Top themes by extraction count:");
  for (const theme of coverage) {
    console.log(`  ${theme.code}: ${theme.extracted_count} comments with extracted content`);
  }

  db.close();
}
