import { Command } from "commander";
import { Database } from "bun:sqlite";
import { writeFileSync } from "fs";
import { openDb, getDbPath, initSchema, withTransaction } from "../lib/database";
import { initDebug, debugSave } from "../lib/debug";
import { UsageTally } from "../lib/ai-client";
import { loadUnitsForEntities, seededOrder } from "../lib/comment-processing";
import type { EntityTaxonomy, EnrichedComment } from "../types";
import { parseJsonResponse } from "../lib/json-parser";
import { getTaskModel, getTaskConfig } from "../lib/batch-config";
import { runLlmRequests, type LlmRequest } from "../lib/step-runner";

// Entity discovery builds a taxonomy of entities (each with exact match terms) in phases, then
// every unit is scanned for the terms locally:
//   1. base:        one call designs a taxonomy from a seeded random ~150k-word sample of units
//   2. themes:      one call per top-level theme over that theme's units (long and attachment
//                   letters first, plus some typed comments), asking only for missing entities.
//                   A random sample of a large docket is mostly short typed comments, so the
//                   base call alone misses the technical terms that live in long letters
//   3. sweep:       parallel calls over every unit no earlier call has read. On PFS, rounds of a few
//                   calls kept finding entities in 100+ units even after 5 rounds (only 39% of units
//                   read), so coverage, not a stop rule, is what matters
//   4. gap fill:    one call per top-level theme over the taxonomy and theme titles (no comment
//                   text) for broad, common entities that the comment-reading calls pass over
//   5. consolidate: one call over the entity lists only (with match counts and contexts for short
//                   acronyms) merges duplicates, fixes categories and drops terms likely to match
//                   unrelated text
// Keep an entity if it appears in at least min(1% of units, minUnitsCap) units (and at least 1) and in at
// most 50% of units. A flat 1% floor would need 200 mentions on a 20k-unit docket, dropping most
// organizations and codes that only serious letters mention.
const DEFAULTS = {
  minUnitsCap: 10,
  wordsPerCall: 150000,     // words of comment text per discovery call
  maxWordsPerUnit: 4000,    // long letters are truncated so one 50-page letter can't fill a call
  sweepWordsPerCall: 300000, // words per sweep call; the sweep reads every unit not read yet
  typedShare: 0.15,         // share of a theme/sweep call's words given to short typed comments
  longMinWords: 400,        // units with attachments or more words count as long letters
};
type EntityConfig = typeof DEFAULTS;

export const discoverEntitiesV2Command = new Command("discover-entities-v2")
  .description("Discover named entities (base taxonomy, per-theme and sweep passes for missing entities, consolidation), then tag units by term matching")
  .argument("<document-id>", "Document ID (e.g., CMS-2025-0050-0031)")
  .option("-l, --limit <n>", "Process only N comments", parseInt)
  .option("--word-limit <n>", "Words of comment text per base and theme call (default: wordsPerCall in batch-config, 150000)", parseInt)
  .option("--seed <s>", "Seed for the discovery samples (default: 1)")
  .option("-d, --debug", "Enable debug output")
  .option("-m, --model <model>", "AI model to use (overrides batch-config)")
  .option("--batch", "Use the Gemini Batch API (half price, slower; one batch job per phase)")
  .option("--dry-run <file>", "Open the docket DB read-only and write the discovered taxonomy (with unit counts) to <file> instead of saving it; LLM responses are cached in <file>.cache.sqlite")
  .option("--force", "Re-run discovery even if the docket already has entities (replaces them and their annotations)")
  .option("--discover-only", "Only discover entities, skip annotation")
  .option("--annotate-only", "Only annotate comments with existing entities")
  .action(discoverEntitiesV2);

async function discoverEntitiesV2(documentId: string, options: any) {
  await initDebug(options.debug);
  
  const dryRun: string | undefined = options.dryRun;
  const db = dryRun ? new Database(getDbPath(documentId), { readonly: true }) : openDb(documentId);
  // LLM cache and batch job records go to the docket DB, or in a dry run to a side file
  let cacheDb = db;
  if (dryRun) {
    cacheDb = new Database(`${dryRun}.cache.sqlite`);
    initSchema(cacheDb);
  }
  const cfg: EntityConfig = { ...DEFAULTS, ...((getTaskConfig('discoverEntities') as any).thresholds || {}) };
  if (options.wordLimit) cfg.wordsPerCall = options.wordLimit;
  const model = getTaskModel('discoverEntities', options.model);
  
  // Determine what operations to perform
  const shouldDiscover = !options.annotateOnly;
  const shouldAnnotate = !options.discoverOnly && !dryRun;
  
  if (options.discoverOnly && options.annotateOnly) {
    console.log("❌ Cannot use both --discover-only and --annotate-only");
    db.close();
    return;
  }
  
  console.log(`🔍 Processing entities for document ${documentId} (v2 approach)`);
  console.log(`   Mode: ${dryRun ? `Dry run (read-only; taxonomy to ${dryRun})` : shouldDiscover && shouldAnnotate ? 'Discover and annotate' : shouldDiscover ? 'Discover only' : 'Annotate only'}`);
  console.log(`   Using model: ${model}${options.batch ? ' (batch)' : ''}`);
  if (shouldDiscover) {
    console.log(`   Words per call: ${cfg.wordsPerCall.toLocaleString()}`);
  }
  
  try {
    // Check existing entities
    const existingEntities = db.prepare("SELECT COUNT(*) as count FROM entity_taxonomy").get() as { count: number };
    
    if (shouldDiscover && existingEntities.count > 0 && !dryRun && !options.force) {
      console.log(`⚠️  Entities already discovered (${existingEntities.count} entities)`);
      console.log("   To re-run discovery, pass --force");
      if (!shouldAnnotate) {
        // User only wants to discover, but entities already exist
        db.close();
        return;
      }
      // User wants both discover and annotate, skip discovery
      console.log("   Skipping discovery, proceeding to annotation...");
    }
    
    if (shouldAnnotate && !shouldDiscover && existingEntities.count === 0) {
      console.log("❌ No entities found. Run discovery first.");
      db.close();
      return;
    }
    
    // Load all comments (needed for both discovery and annotation)
    const allComments = loadUnitsForEntities(db, options.limit);
    if (allComments.length === 0) {
      console.log("❌ No transcribed comments found. Run 'transcribe' command first.");
      db.close();
      return;
    }
    
    console.log(`📊 Found ${allComments.length} units (transcribed; representatives only if clustered; no_substance excluded)`);
    
    // Discovery phase
    if (shouldDiscover && (existingEntities.count === 0 || dryRun || options.force)) {
      const result = await discoverEntities(db, cacheDb, model, allComments, cfg, options.seed ?? 1, options.batch ? 'batch' : 'live');
      if (options.debug) await debugSave('entities_v2_taxonomy.json', toTaxonomy(result.entities));
      if (dryRun) {
        const out = result.entities
          .map(e => ({ ...e, units: result.counts.get(e) ?? 0, kept: result.passes(e) }))
          .sort((a, b) => a.category.localeCompare(b.category) || a.label.localeCompare(b.label));
        writeFileSync(dryRun, JSON.stringify({ units: allComments.length, thresholds: result.thresholds, entities: out }, null, 2));
        console.log(`\n📝 Dry run: wrote ${out.filter(e => e.kept).length} kept entities (${out.length} total) to ${dryRun}`);
      } else {
        console.log("\n💾 Saving entity taxonomy...");
        saveEntities(db, result.entities.filter(result.passes));
      }
    }
    
    // Annotation phase
    if (shouldAnnotate) {
      await annotateComments(db, allComments);
    }
    
    if (!dryRun) {
      // Final summary
      const savedEntities = db.prepare("SELECT COUNT(*) as count FROM entity_taxonomy").get() as { count: number };
      const annotationCount = db.prepare("SELECT COUNT(*) as count FROM comment_entities").get() as { count: number };
      
      console.log("\n✅ Entity processing complete!");
      console.log(`   Entities in database: ${savedEntities.count}`);
      console.log(`   Annotations: ${annotationCount.count}`);
    }
    
  } catch (error) {
    console.error("❌ Failed:", error);
    throw error;
  } finally {
    if (cacheDb !== db) cacheDb.close();
    db.close();
  }
}

interface WorkEntity { category: string; label: string; definition: string; terms: string[]; source?: string }
interface SampleUnit { id: string; content: string; words: number; long: boolean }

const entityKey = (e: { category: string; label: string }) => `${e.category}|${e.label}`;
// Labels that differ only in case, punctuation or a plural "s" are the same entity
const normLabel = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '').replace(/s$/, '');

function toTaxonomy(entities: WorkEntity[]): EntityTaxonomy {
  const tax: EntityTaxonomy = {};
  for (const e of entities) (tax[e.category] ||= []).push({ label: e.label, definition: e.definition, terms: e.terms });
  return tax;
}

// Every unit's text starts with a "Location:" line and many letters carry addresses, so a term
// that is a US state or territory abbreviation ("AK" for actinic keratosis, "PA", "MA") matches
// unrelated comments; such terms are dropped
const STATE_CODES = new Set("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR GU VI AS MP".split(' '));

// Well-formed entities from a parsed {Category: [{label, definition, terms}]} response
function parseEntityJson(text: string): WorkEntity[] {
  const parsed = parseJsonResponse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('taxonomy is not a JSON object');
  const out: WorkEntity[] = [];
  for (const [category, list] of Object.entries(parsed)) {
    if (!Array.isArray(list)) continue;
    for (const e of list as any[]) {
      if (!e || typeof e.label !== 'string' || !Array.isArray(e.terms)) continue;
      const terms = [...new Set((e.terms as any[]).filter(t => typeof t === 'string').map(t => t.trim()).filter(t => t && !STATE_CODES.has(t)))];
      if (terms.length === 0) continue;
      const definition = typeof e.definition === 'string' && e.definition.trim()
        ? e.definition.trim()
        : `A ${category.toLowerCase()} entity mentioned in comments`;
      out.push({ category, label: e.label.trim(), definition, terms });
    }
  }
  return out;
}

// Greedy fill up to `budget` words: long letters first (up to 1 - typedShare of it), then short
// typed comments, then more long letters if typed ones ran out. `ranked` is in preference order.
function fillSample(ranked: SampleUnit[], budget: number, typedShare: number, exclude: Set<string>): SampleUnit[] {
  const out: SampleUnit[] = [];
  let used = 0;
  const take = (pool: SampleUnit[], cap: number) => {
    for (const u of pool) {
      if (used >= cap * 0.98) break;
      if (exclude.has(u.id) || used + u.words > cap) continue;
      exclude.add(u.id);
      out.push(u);
      used += u.words;
    }
  };
  const longs = ranked.filter(u => u.long), shorts = ranked.filter(u => !u.long);
  take(longs, budget * (1 - typedShare));
  take(shorts, budget);
  take(longs, budget);
  for (const u of out) exclude.delete(u.id); // callers decide what counts as seen
  return out;
}

const commentBlocks = (units: { id: string; content: string }[]) =>
  units.map(c => `<comment id="${c.id}">\n${c.content}\n</comment>`).join("\n\n");

// Discover entities from comments
async function discoverEntities(
  db: Database,
  cacheDb: Database,
  model: string,
  allComments: EnrichedComment[],
  cfg: EntityConfig,
  seed: string | number,
  mode: 'live' | 'batch'
) {
  console.log("\n🔍 Starting entity discovery...");
  const tally = new UsageTally();
  const concurrency = getTaskConfig('discoverEntities').concurrency;
  const run = async (phase: string, requests: LlmRequest[], handle: (key: string, text: string) => void) => {
    const summary = await runLlmRequests(requests, (req, res) => handle(req.key, res.text),
      { db: cacheDb, task: 'discover-entities', mode, concurrency, label: `discover-entities:${phase}` });
    tally.addSummary(phase, summary);
  };

  // Text per unit, truncated to maxWordsPerUnit for the base and theme calls; the sweep reads the
  // rest of long letters as further pieces (on PFS truncation dropped 2.2M words from 511 letters,
  // the expert letters where specialized terms live; reading them costs ~$1.1 batch)
  const withAttachments = new Set((db.prepare("SELECT DISTINCT comment_id FROM attachments").all() as { comment_id: string }[]).map(r => r.comment_id));
  const units: SampleUnit[] = [];
  const laterPieces: SampleUnit[] = [];
  for (const c of allComments) {
    const words = c.content.split(/\s+/);
    const content = words.length > cfg.maxWordsPerUnit
      ? words.slice(0, cfg.maxWordsPerUnit).join(' ') + ' [...]'
      : c.content;
    units.push({ id: c.id, content, words: Math.min(words.length, cfg.maxWordsPerUnit), long: withAttachments.has(c.id) || words.length > cfg.longMinWords });
    for (let start = cfg.maxWordsPerUnit, part = 2; start < words.length; start += cfg.maxWordsPerUnit, part++) {
      const piece = words.slice(start, start + cfg.maxWordsPerUnit);
      laterPieces.push({ id: `${c.id} (part ${part})`, content: '[...] ' + piece.join(' '), words: piece.length, long: true });
    }
  }
  const seen = new Set<string>();

  // Frequency thresholds and local matching
  const upperThreshold = Math.floor(allComments.length * 0.5);
  const lowerThreshold = Math.max(1, Math.min(Math.floor(allComments.length * 0.01), cfg.minUnitsCap));
  console.log(`   Keeping entities found in ${lowerThreshold}–${upperThreshold} units`);
  const counts = new Map<WorkEntity, number>();
  const passes = (e: WorkEntity) => { const n = counts.get(e) ?? 0; return n >= lowerThreshold && n <= upperThreshold; };
  const recount = (list: Iterable<WorkEntity>) => {
    const matcher = new TermMatcher();
    const byKey = new Map<string, WorkEntity>();
    let i = 0;
    for (const e of list) {
      const k = String(i++);
      byKey.set(k, e);
      counts.set(e, 0);
      for (const t of e.terms) matcher.add(t, k);
    }
    if (byKey.size === 0) return;
    for (const c of allComments) for (const k of matcher.match(c.content)) { const e = byKey.get(k)!; counts.set(e, counts.get(e)! + 1); }
  };

  let entities: WorkEntity[] = [];
  // Merge new entities into the taxonomy: one with the same normalized label extends the existing
  // entity's terms. A shared term alone doesn't make two entities the same ("ACP" is both advance
  // care planning and the American College of Physicians; "prior authorization" was a variant on a
  // new broad entity and on "electronic prior authorization"), so the new entity is added without
  // the terms already taken, or dropped if none are left; consolidation merges real duplicates.
  // Returns the added entities.
  const mergeLocal = (additions: WorkEntity[], source: string): { added: WorkEntity[]; extended: number } => {
    const added: WorkEntity[] = [];
    const changed = new Set<WorkEntity>();
    for (const a of additions) {
      a.source = source;
      const existing = entities.find(e => normLabel(e.label) === normLabel(a.label));
      if (existing) {
        const extra = a.terms.filter(t => !existing.terms.includes(t));
        if (extra.length) { existing.terms.push(...extra); changed.add(existing); }
        continue;
      }
      const terms = new Set(a.terms);
      const taken = new Set(entities.flatMap(e => e.terms.filter(t => terms.has(t))));
      a.terms = a.terms.filter(t => !taken.has(t));
      if (a.terms.length === 0) continue;
      entities.push(a);
      added.push(a);
    }
    const extendedOld = [...changed].filter(e => !added.includes(e));
    recount([...added, ...extendedOld]);
    return { added, extended: extendedOld.length };
  };
  const report = (phase: string, r: { added: WorkEntity[]; extended: number }) => {
    const kept = r.added.filter(passes).length;
    console.log(`   ➕ ${phase}: ${r.added.length} new entities (${kept} pass the frequency threshold), ${r.extended} existing entities got new terms; taxonomy now ${entities.filter(passes).length} kept / ${entities.length}`);
    return kept;
  };

  // ── Phase 1: base taxonomy from a seeded random sample (reruns pick the same sample)
  const selectedComments: { id: string; content: string }[] = [];
  let totalWords = 0;
  for (const comment of seededOrder(units, seed)) {
    if (totalWords + comment.words > cfg.wordsPerCall && totalWords > cfg.wordsPerCall * 0.9) {
      break; // Close enough to target
    }
    if (totalWords + comment.words > cfg.wordsPerCall) continue;
    selectedComments.push({ id: comment.id, content: comment.content });
    totalWords += comment.words;
  }
  for (const c of selectedComments) seen.add(c.id);
  console.log(`\n📝 Phase 1 (base): ${selectedComments.length} comments, ${totalWords.toLocaleString()} words`);
  const prompt = basePrompt(selectedComments.length, totalWords, commentBlocks(selectedComments));
  let base: WorkEntity[] | undefined;
  // Two attempts; the retry asks for JSON output, which also keeps it from hitting a stale cache entry
  for (let attempt = 1; attempt <= 2 && !base; attempt++) {
    await run('base', [{ key: 'entity-taxonomy', model, parts: [{ text: prompt }], config: attempt > 1 ? { responseMimeType: "application/json" } : undefined }],
      (_key, text) => { base = parseEntityJson(text); });
  }
  if (!base) throw new Error('Entity taxonomy generation failed');
  report('base', mergeLocal(base, 'base'));

  // Requests asking for missing entities; parsed results are merged in request order
  const runAdditions = async (phase: string, calls: { key: string; focus: string; sample: SampleUnit[] }[]) => {
    const listing = taxonomyListing(entities);
    const results = new Map<string, WorkEntity[]>();
    const requests: LlmRequest[] = calls.map(c => ({
      key: c.key, model, config: { responseMimeType: "application/json" },
      parts: [{ text: additionsPrompt(listing, c.focus, c.sample) }],
    }));
    await run(phase, requests, (key, text) => { results.set(key, parseEntityJson(text)); });
    if (results.size < calls.length) console.log(`   ⚠️  ${calls.length - results.size} of ${calls.length} ${phase} calls failed; continuing without them`);
    const total = { added: [] as WorkEntity[], extended: 0 };
    for (const c of calls) {
      const r = mergeLocal(results.get(c.key) || [], c.key);
      total.added.push(...r.added);
      total.extended += r.extended;
    }
    return total;
  };

  // ── Phase 2: one call per top-level theme over that theme's units
  const themes = loadTopThemes(db, new Set(units.map(u => u.id)));
  if (themes.length > 0) {
    const order = new Map(seededOrder(units, seed).map((u, i) => [u.id, i]));
    const byId = new Map(units.map(u => [u.id, u]));
    const calls: { key: string; focus: string; sample: SampleUnit[] }[] = [];
    // Each unit is read once: a theme call takes only units no earlier call read, smallest themes
    // first so they keep their own letters, preferring units with the most extracts under the theme
    // (letters centered on it). On a small docket the themes share the unread words instead of
    // each taking wordsPerCall, which would re-read the same letters many times.
    const unreadWords = units.reduce((n, u) => n + (seen.has(u.id) ? 0 : u.words), 0);
    const budget = Math.min(cfg.wordsPerCall, Math.floor(unreadWords / themes.length));
    for (const t of [...themes].sort((a, b) => a.units.size - b.units.size || a.code.localeCompare(b.code, undefined, { numeric: true }))) {
      const ranked = [...t.units.keys()].map(id => byId.get(id)!).filter(u => !seen.has(u.id)).sort((a, b) =>
        t.units.get(b.id)! - t.units.get(a.id)! || order.get(a.id)! - order.get(b.id)!);
      const sample = fillSample(ranked, budget, cfg.typedShare, new Set());
      if (sample.length === 0) continue;
      for (const u of sample) seen.add(u.id);
      calls.push({ key: `theme-${t.code}`, focus: `The comments below were chosen because they discuss this topic: "${t.title}". Look especially for entities related to it, but include any missing entity you find.`, sample });
    }
    calls.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
    const words = calls.reduce((n, c) => n + c.sample.reduce((m, u) => m + u.words, 0), 0);
    console.log(`\n📝 Phase 2 (themes): ${calls.length} calls, one per top-level theme, ${words.toLocaleString()} words; ${seen.size} of ${units.length} units seen so far`);
    report('themes', await runAdditions('themes', calls));
  } else {
    console.log("\n📝 Phase 2 (themes): no theme taxonomy; the sweep reads every unit");
  }

  // ── Phase 3: sweep every unit no call has read yet, in parallel calls
  const unseen = seededOrder([...units.filter(u => !seen.has(u.id)), ...laterPieces], `${seed}:sweep`);
  if (unseen.length > 0) {
    const calls: { key: string; focus: string; sample: SampleUnit[] }[] = [];
    const taken = new Set<string>();
    while (taken.size < unseen.length) {
      const sample = fillSample(unseen, cfg.sweepWordsPerCall, cfg.typedShare, taken);
      if (sample.length === 0) break;
      for (const u of sample) taken.add(u.id);
      calls.push({ key: `sweep-${calls.length + 1}`, focus: "The comments below were not read by earlier passes.", sample });
    }
    for (const id of taken) seen.add(id);
    const words = calls.reduce((n, c) => n + c.sample.reduce((m, u) => m + u.words, 0), 0);
    console.log(`\n📝 Phase 3 (sweep): ${calls.length} calls over the ${taken.size - laterPieces.length} units not read yet and ${laterPieces.length} later pieces of long letters, ${words.toLocaleString()} words`);
    report('sweep', await runAdditions('sweep', calls));
  } else {
    console.log("\n📝 Phase 3 (sweep): every unit has been read");
  }

  // ── Phase 4: gap fill. Calls that read comments list the specific names they notice and pass
  // over broad, common concepts (on PFS no reading call named "prior authorization", in 437
  // units), so calls without comment text, one per top-level theme with its sub-themes, ask what
  // commenters on that theme would name that the taxonomy lacks. One call over all themes was
  // erratic (each run found a different few); local matching keeps only what occurs.
  const themeRows = db.prepare("SELECT code, parent_code, description FROM theme_hierarchy ORDER BY level, code").all() as { code: string; parent_code: string | null; description: string }[];
  const titleOf = (t: { code: string; description: string }) => `${t.code}. ${t.description.split(/(?<=\.)\s/)[0].slice(0, 300)}`;
  const topOf = (code: string) => { let c = code; for (let i = 0; i < 20; i++) { const p = themeRows.find(r => r.code === c)?.parent_code; if (!p) break; c = p; } return c; };
  const groups = themeRows.filter(r => !r.parent_code).map(top => ({ key: `gap-fill-${top.code}`, titles: themeRows.filter(r => topOf(r.code) === top.code).map(titleOf) }));
  if (groups.length === 0) groups.push({ key: 'gap-fill', titles: [] });
  console.log(`\n📝 Phase 4 (gap fill): ${groups.length} calls over the taxonomy and theme titles, no comment text`);
  const gapListing = taxonomyListing(entities.filter(passes));
  const gapResults = new Map<string, WorkEntity[]>();
  await run('gap-fill', groups.map(g => ({ key: g.key, model, config: { responseMimeType: "application/json" },
    parts: [{ text: gapFillPrompt(gapListing, g.titles) }] })),
    (key, text) => { gapResults.set(key, parseEntityJson(text)); });
  const gapTotal = { added: [] as WorkEntity[], extended: 0 };
  for (const g of groups) {
    const r = mergeLocal(gapResults.get(g.key) || [], g.key);
    gapTotal.added.push(...r.added);
    gapTotal.extended += r.extended;
  }
  report('gap fill', gapTotal);

  // ── Phase 5: consolidate the kept entities (lists and counts only, no comment text)
  const kept = entities.filter(passes);
  const termStats = countTerms(allComments, kept);
  console.log(`\n📝 Phase 5 (consolidate): ${kept.length} kept entities`);
  let edits: any;
  await run('consolidate', [{ key: 'consolidate', model, config: { responseMimeType: "application/json" },
    parts: [{ text: consolidatePrompt(kept, counts, termStats, allComments.length) }] }],
    (_key, text) => { edits = parseJsonResponse(text); if (!edits || typeof edits !== 'object') throw new Error('edits are not a JSON object'); });
  if (edits) {
    const before = kept.length;
    const changed = applyEdits(kept, edits, entities);
    entities = entities.filter(e => !changed.removed.has(e));
    recount(changed.touched);
    console.log(`   🧹 merged ${changed.merged}, moved ${changed.moved}, removed ${changed.removedTerms.length} terms and ${changed.removed.size - changed.merged} entities; kept ${entities.filter(passes).length} (was ${before})`);
    if (changed.removedTerms.length) console.log(`      terms removed: ${changed.removedTerms.slice(0, 40).join(', ')}${changed.removedTerms.length > 40 ? ', ...' : ''}`);
  } else {
    console.log("   ⚠️  Consolidation failed; keeping the unconsolidated taxonomy");
  }

  console.log(`\n✅ Discovery read ${units.filter(u => seen.has(u.id)).length} of ${units.length} units`);
  tally.print('discover-entities-v2');
  return { entities, counts, passes, thresholds: { lower: lowerThreshold, upper: upperThreshold } };
}

// Top-level themes with the units that have extracts under each (theme or any descendant) and how many
function loadTopThemes(db: Database, unitIds: Set<string>): { code: string; title: string; units: Map<string, number> }[] {
  const rows = db.prepare("SELECT code, parent_code, description FROM theme_hierarchy").all() as { code: string; parent_code: string | null; description: string }[];
  if (rows.length === 0) return [];
  const parent = new Map(rows.map(r => [r.code, r.parent_code]));
  const top = (code: string) => { let c = code; for (let i = 0; i < 20 && parent.get(c); i++) c = parent.get(c)!; return c; };
  const themes = new Map(rows.filter(r => !r.parent_code).map(r => [r.code, {
    code: r.code,
    title: r.description.split(/(?<=\.)\s/)[0].slice(0, 300), // descriptions open with a title sentence
    units: new Map<string, number>(),
  }]));
  for (const { comment_id, theme_code } of db.prepare("SELECT comment_id, theme_code FROM comment_theme_extracts").all() as { comment_id: string; theme_code: string }[]) {
    const t = themes.get(top(theme_code));
    if (!t || !unitIds.has(comment_id)) continue;
    t.units.set(comment_id, (t.units.get(comment_id) || 0) + 1);
  }
  return [...themes.values()].filter(t => t.units.size > 0);
}

// Short acronyms are the terms most likely to match unrelated text, so the consolidation call sees
// a few contexts for each
const isShortTerm = (t: string) => /^[A-Za-z0-9&-]{1,5}$/.test(t);
const SNIPPETS_PER_TERM = 3;

// Units containing each term, keyed "<entity index>\t<term>", and a few snippets for short terms
function countTerms(comments: EnrichedComment[], entities: WorkEntity[]) {
  const matcher = new TermMatcher();
  entities.forEach((e, i) => { for (const t of e.terms) matcher.add(t, `${i}\t${t}`); });
  const counts = new Map<string, number>();
  const shortHits = new Map<string, EnrichedComment[]>();
  for (const c of comments) {
    for (const k of matcher.match(c.content)) {
      counts.set(k, (counts.get(k) || 0) + 1);
      if (isShortTerm(k.split('\t')[1])) (shortHits.get(k) || shortHits.set(k, []).get(k)!).push(c);
    }
  }
  const snippets = new Map<string, string[]>();
  for (const [k, hits] of shortHits) {
    const term = k.split('\t')[1];
    const re = new RegExp(`\\b${escapeRegex(term)}\\b`);
    const picks = [...new Set(Array.from({ length: SNIPPETS_PER_TERM }, (_, j) => hits[Math.floor(j * hits.length / SNIPPETS_PER_TERM)]))];
    snippets.set(k, picks.map(c => {
      const m = re.exec(c.content)!;
      return c.content.slice(Math.max(0, m.index - 50), m.index + term.length + 50).replace(/\s+/g, ' ').trim();
    }));
  }
  return { counts, snippets };
}

// Apply the consolidation edits to `kept` (IDs are E<index>). Entities that end up with the same
// category and label as another (after moves) are merged too, since that pair is the table key.
function applyEdits(kept: WorkEntity[], edits: any, all: WorkEntity[]) {
  const byId = (id: any) => typeof id === 'string' ? kept[Number(id.replace(/^E/i, ''))] : undefined;
  const removed = new Set<WorkEntity>();
  const touched = new Set<WorkEntity>();
  let merged = 0, moved = 0;
  const removedTerms: string[] = [];
  const absorb = (into: WorkEntity, from: WorkEntity) => {
    for (const t of from.terms) if (!into.terms.includes(t)) into.terms.push(t);
    removed.add(from);
    touched.add(into);
    merged++;
  };
  for (const m of Array.isArray(edits.merge) ? edits.merge : []) {
    const into = byId(m?.into);
    if (!into || removed.has(into)) continue;
    for (const f of Array.isArray(m.from) ? m.from : []) {
      const from = byId(f);
      if (from && from !== into && !removed.has(from)) absorb(into, from);
    }
  }
  for (const m of Array.isArray(edits.move) ? edits.move : []) {
    const e = byId(m?.id);
    if (!e || removed.has(e) || typeof m.category !== 'string' || !m.category.trim() || m.category === e.category) continue;
    e.category = m.category.trim();
    moved++;
  }
  for (const r of Array.isArray(edits.removeTerms) ? edits.removeTerms : []) {
    const e = byId(r?.id);
    if (!e || removed.has(e) || !Array.isArray(r.terms)) continue;
    const drop = new Set(r.terms);
    const left = e.terms.filter(t => !drop.has(t));
    removedTerms.push(...e.terms.filter(t => drop.has(t)));
    e.terms = left;
    touched.add(e);
    if (left.length === 0) removed.add(e);
  }
  for (const id of Array.isArray(edits.remove) ? edits.remove : []) {
    const e = byId(id);
    if (e) removed.add(e);
  }
  const seenKeys = new Map<string, WorkEntity>();
  for (const e of all) {
    if (removed.has(e)) continue;
    const k = entityKey(e);
    const first = seenKeys.get(k);
    if (first) absorb(first, e); else seenKeys.set(k, e);
  }
  for (const e of removed) touched.delete(e);
  return { removed, touched, merged, moved, removedTerms };
}

// Current taxonomy for the prompts, one entity per line (terms capped to keep the prompt small)
function taxonomyListing(entities: WorkEntity[]): string {
  return [...entities]
    .sort((a, b) => a.category.localeCompare(b.category) || a.label.localeCompare(b.label))
    .map(e => `${e.category} | ${e.label} | ${e.terms.slice(0, 8).join('; ')}`)
    .join('\n');
}

function basePrompt(nComments: number, totalWords: number, blocks: string): string {
  return `You are analyzing public comments on a regultions.gov docket. Based on the following ${nComments} comment excerpts (${totalWords.toLocaleString()} words total), create a comprehensive taxonomy of entities mentioned or relevant to this domain.

Generate a JSON taxonomy with the following structure:
{
  "CategoryName": [
    {
      "label": "Brief Name",
      "definition": "Clear definition of what this entity is",
      "terms": ["exact term 1", "exact term 2", "ABBR", "Alternative Name", "alternate spelling"]
    }
  ]
}

CRITICAL Requirements:

1. **MECE Categories**: Categories must be Mutually Exclusive and Collectively Exhaustive. Each entity belongs to exactly ONE category. No overlapping categories.

2. **Brief Entity Labels**: Keep labels SHORT (2-4 words max). These are identifiers, not descriptions.
   - Good: "Medicare Part D", "Prior Authorization", "CMS"  
   - Bad: "Centers for Medicare and Medicaid Services Administrative Processes"

3. **Complete Term Lists for Blind Matching**: The terms array must contain EVERY possible text variation that could appear in comments. This will be used for exact string matching, so include:
   - All spelling variations (e.g., "Prior Authorization", "prior auth", "prior-authorization")
   - All abbreviations (e.g., "PA", "prior auth")
   - All acronyms (e.g., "CMS", "HHS", "MA-PD")
   - Common misspellings if any
   - Both singular and plural forms when appropriate
   - Both hyphenated and non-hyphenated versions
   
   IMPORTANT: The matching will be CASE-SENSITIVE and must match exact word boundaries.
   
   **CRITICAL**: DO NOT include synonym terms that are common words on their own and could cause false matches. For example:
   - For "Prior Authorization", include "PA", "prior auth" but NOT "approval" or "permission"
   - For "Medicare Advantage", include "MA", "MA plan" but NOT "advantage" alone
   - For "Prescription Drug Plan", include "PDP", "Part D plan" but NOT "plan" alone

Additional Guidelines:
- Create up to 500 total entities across all categories
- Categories should be domain-appropriate (e.g., Government Agencies, Programs, Medications, Conditions, Regulations, Processes, etc.)
- **EXCLUDE private/commercial companies**: Do not create categories for vendors, service providers, or commercial entities.
- Each entity needs a brief but informative definition (<20 words)
- Include entities that are directly mentioned AND those you'd expect to see in similar comments
- Make a coherent taxonomy of the domain represented in these comments

Focus on creating a high-quality, comprehensive taxonomy that captures the key entities in this domain, even if some specific terms don't appear in this sample.

<comments>
${blocks}
</comments>

Generate the JSON taxonomy:`;
}

// Instructions and the taxonomy come first and the comments last, so parallel calls share a prefix
function additionsPrompt(listing: string, focus: string, sample: SampleUnit[]): string {
  const words = sample.reduce((n, u) => n + u.words, 0);
  return `You are extending a taxonomy of entities for the public comments on a regulations.gov docket. The current taxonomy is below, one entity per line as "Category | Label | terms". Read the ${sample.length} comment excerpts (${words.toLocaleString()} words) that follow it and find the entities they mention that the taxonomy is missing. ${focus}

<current_taxonomy>
${listing}
</current_taxonomy>

What to add:
- Specific things a reader would want to look up across the docket: programs and payment models, agencies and offices, statutes, regulations and rules, standards and technical specifications, billing codes and code families, quality measures, payment policies and methodologies, named services and care models, professional roles and specialties, associations and standards bodies, conditions, drug and device classes, and named practices, processes and technologies that commenters argue about as policy topics (e.g. "step therapy", "surprise billing", "e-prescribing").
- Only entities explicitly named in these comments. Skip generic words ("patients", "costs", "access to care") and anything an existing entity already covers, even under another name. A narrower or broader entity is not a duplicate: add "step therapy" even if "electronic step therapy" exists.
- For billing codes discussed together, make one entity for the code family with each code as a term rather than one entity per code; give a single code its own entity only when it is discussed on its own.
- Exclude private companies and commercial products.
- If an existing entity lacks a variant that appears in these comments, you may list it again with exactly the same category and label and only the new terms.
- Be exhaustive: list every missing entity these comments name, even ones mentioned only once. Rare ones are filtered out later by counting matches across the whole docket.

Output a JSON object containing only the new entities, in the same structure as the taxonomy:
{
  "CategoryName": [
    { "label": "Brief Name", "definition": "Clear definition (<20 words)", "terms": ["exact term 1", "ABBR", "variant"] }
  ]
}
Use the existing category names wherever an entity fits; add a category only when none does. Labels are short (2-4 words). Output {} if nothing is missing.

Terms are matched against every comment in the docket, CASE-SENSITIVE and on exact word boundaries, so:
- List every variant that appears: full name, acronym, abbreviations, singular and plural, hyphenated and unhyphenated forms.
- Every term must mean this entity wherever it appears. Leave out ordinary words and phrases ("approval", "plan", "advantage") and short acronyms with other common meanings in this domain or in names, credentials, addresses and signatures (e.g. "PA" can mean physician assistant, prior authorization or Pennsylvania; "MA" can mean Medicare Advantage, medical assistant, Massachusetts or a degree). Use the full name and unambiguous longer forms instead.

<comments>
${commentBlocks(sample)}
</comments>

Generate the JSON of missing entities:`;
}

// Taxonomy first so the parallel calls share a cached prefix
function gapFillPrompt(listing: string, themeTitles: string[]): string {
  return `You are completing a taxonomy of entities for the public comments on a regulations.gov docket. Its terms are matched against every comment, CASE-SENSITIVE and on exact word boundaries, to tag the comments that mention each entity. It was built by reading the comments, which tends to catch specific names and miss broad, common ones.

Current taxonomy, one entity per line as "Category | Label | terms":
${listing}

${themeTitles.length ? `This part of the docket's analysis covers the theme below and its sub-themes:\n${themeTitles.join('\n')}\n\nList the entities commenters on this theme would commonly name` : 'List the entities commenters on this docket would commonly name'} that the taxonomy is missing: programs, agencies, statutes and rules, standards, policies and methodologies, and named practices, processes and technologies that are debated as policy topics. Include broad ones as well as narrow ones; a narrower or broader entity is not a duplicate. In particular, where the taxonomy has only a specific form of a concept (e.g. "electronic step therapy", "AI-assisted triage"), add the general concept itself ("step therapy", the technology) if commenters would name it on its own. Entities that never occur in the comments are dropped automatically after matching, so err on the side of listing them.

Output a JSON object of only the new entities, in this structure:
{
  "CategoryName": [
    { "label": "Brief Name", "definition": "Clear definition (<20 words)", "terms": ["exact term 1", "ABBR", "variant"] }
  ]
}
Use the existing category names wherever an entity fits. List every likely variant (full name, acronym, singular and plural, hyphenated and unhyphenated). Every term must mean this entity wherever it appears: leave out ordinary words and short acronyms with other common meanings in this domain or in names, credentials, addresses and signatures (e.g. "PA" can mean physician assistant, prior authorization or Pennsylvania); use full names and unambiguous longer forms instead. Exclude private companies and commercial products.`;
}

function consolidatePrompt(kept: WorkEntity[], counts: Map<WorkEntity, number>, termStats: ReturnType<typeof countTerms>, nUnits: number): string {
  const lines = kept.map((e, i) => {
    const line = `E${i} | ${e.category} | ${e.label} (${counts.get(e) ?? 0}) | ${e.definition} | ${e.terms.map(t => `"${t}" (${termStats.counts.get(`${i}\t${t}`) || 0})`).join(', ')}`;
    const contexts = e.terms.filter(t => termStats.snippets.has(`${i}\t${t}`))
      .map(t => `    "${t}" in context: ${termStats.snippets.get(`${i}\t${t}`)!.map(x => `«${x}»`).join(' ')}`);
    return [line, ...contexts].join('\n');
  });
  return `You are cleaning up a taxonomy of entities for the public comments on a regulations.gov docket. It was built in several passes over different comments, so it has duplicates and inconsistent categories.

Each entity's terms are matched against every comment, CASE-SENSITIVE and on exact word boundaries, to tag the comments that mention it. Below, the number after a label is how many of the ${nUnits.toLocaleString()} comments contain any of its terms, and the number after a term is how many contain that term. Short acronyms are followed by a few passages where they occur, so you can see whether they mean the entity.

Entities, one per line as: ID | Category | Label (comments) | definition | terms

${lines.join('\n')}

Return a JSON object of edits:
{
  "merge": [{ "into": "E12", "from": ["E40", "E77"] }],
  "move": [{ "id": "E5", "category": "Category Name" }],
  "removeTerms": [{ "id": "E9", "terms": ["exact term"] }],
  "remove": ["E3"]
}
- merge: the same entity listed more than once (synonyms, acronym vs. full name, singular vs. plural, a narrower duplicate of the same thing). The terms of "from" are added to "into". Keep genuinely different things apart, e.g. a program and the statute that created it, two different codes, or a broad concept and a narrower form of it ("step therapy" and "electronic step therapy"). When merging, make "into" the entry whose label best names the merged entity.
- move: an entity in the wrong category, or a small or overlapping category that should be folded into another. Aim for a MECE set of categories where each entity has one obvious home; prefer existing category names.
- removeTerms: terms likely to match text that is not about the entity: ordinary words, acronyms that also stand for something else in these comments (another organization, a procedure or body part, a credential, a state), or terms whose count is implausibly high for what they name. If any of a term's passages uses it with a different meaning, remove it; the entity's full name and longer forms still match. Don't remove a term just because it is common if it is unambiguous.
- remove: entries that are not specific entities (generic concepts), or are private companies or commercial products.
Use only IDs from the list. Use empty arrays when there is nothing to change.`;
}

// Save the kept entities
function saveEntities(db: Database, entities: WorkEntity[]) {
  const insertEntity = db.prepare(
    `INSERT INTO entity_taxonomy (category, label, definition, terms)
     VALUES (?, ?, ?, ?)`
  );
  withTransaction(db, () => {
    // Replaces any earlier taxonomy (--force); its annotations go too, and annotation rebuilds them
    db.prepare("DELETE FROM comment_entities").run();
    db.prepare("DELETE FROM entity_taxonomy").run();
    for (const e of entities) insertEntity.run(e.category, e.label, e.definition, JSON.stringify(e.terms));
  });
  console.log(`   ✅ Saved ${entities.length} entities to database`);
}

// Annotate comments with existing entities
async function annotateComments(
  db: Database,
  comments: EnrichedComment[]
) {
  console.log("\n📝 Annotating comments with entities...");
  
  const entityRows = db.prepare(
    "SELECT category, label, terms FROM entity_taxonomy"
  ).all() as Array<{ category: string; label: string; terms: string }>;
  
  if (entityRows.length === 0) {
    console.log("❌ No entities found in database");
    return;
  }
  console.log(`   Found ${entityRows.length} entities to match`);
  
  const matcher = new TermMatcher();
  const byKey = new Map<string, { category: string; label: string }>();
  for (const row of entityRows) {
    const entityKey = `${row.category}|${row.label}`;
    byKey.set(entityKey, { category: row.category, label: row.label });
    for (const term of JSON.parse(row.terms) as string[]) matcher.add(term, entityKey);
  }
  
  db.prepare("DELETE FROM comment_entities").run();
  const insertAnnotation = db.prepare(
    `INSERT OR IGNORE INTO comment_entities (comment_id, category, entity_label)
     VALUES (?, ?, ?)`
  );
  
  let annotationCount = 0;
  withTransaction(db, () => {
    for (const comment of comments) {
      for (const key of matcher.match(comment.content)) {
        const e = byKey.get(key)!;
        insertAnnotation.run(comment.id, e.category, e.label);
        annotationCount++;
      }
    }
  });
  
  console.log(`   💡 Created ${annotationCount} entity annotations over ${comments.length} units`);
}

// Case-sensitive, whole-word term matching (same semantics as /\bTERM\b/) in one pass per text.
// Terms are indexed by their leading word (\w+ run); each word in the text is looked up and the
// candidates verified in place, so the cost is linear in text length rather than texts × terms
// regex scans (which also had a bug: /g regexes reused across texts carried lastIndex over and
// missed matches).
export class TermMatcher {
  private byFirstWord = new Map<string, { term: string; key: string }[]>();
  private fallback: { regex: RegExp; key: string }[] = [];

  add(term: string, key: string) {
    if (!term) return;
    const first = term.match(/^\w+/);
    if (!first) {
      this.fallback.push({ regex: new RegExp(`\\b${escapeRegex(term)}\\b`), key });
      return;
    }
    const list = this.byFirstWord.get(first[0]) || [];
    list.push({ term, key });
    this.byFirstWord.set(first[0], list);
  }

  match(text: string): Set<string> {
    const found = new Set<string>();
    if (!text) return found;
    const word = /\w+/g;
    let m: RegExpExecArray | null;
    while ((m = word.exec(text))) {
      const candidates = this.byFirstWord.get(m[0]);
      if (!candidates) continue;
      for (const c of candidates) {
        if (found.has(c.key) || !text.startsWith(c.term, m.index)) continue;
        // \b after the term: word-ness of its last char differs from the next char's
        const next = text[m.index + c.term.length];
        if (isWordChar(c.term[c.term.length - 1]) !== isWordChar(next)) found.add(c.key);
      }
    }
    for (const f of this.fallback) if (!found.has(f.key) && f.regex.test(text)) found.add(f.key);
    return found;
  }
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /\w/.test(ch);
}

// Escape regex special characters
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
