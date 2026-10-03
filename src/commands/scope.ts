// Scoped analyses (see docs/design/scoped-analysis.md):
//   scope create|show|edit|list   manage a scope (a markdown prompt) in its own scope DB
//   scope-relevance               judge every analysis unit against the scope, keep in-scope excerpts
// Then discover-themes / extract-theme-content / summarize-themes-v2 with --scope <slug>, or
// `pipeline <doc> --scope <slug>` for all four.

import { Command } from "commander";
import type { Database } from "bun:sqlite";
import { readFileSync, existsSync, unlinkSync } from "fs";
import {
  openScopeDb, getScope, getScopeDbPath, listScopeSlugs, promptHash, relevanceIsCurrent, clearScopedResults,
  scopeCounts, analysisUnitSql, hasClustering, SLUG_RE, type ScopeRow,
} from "../lib/scope-db";
import { buildScopeRelevancePrompt, buildScopeLabelPrompt, buildScopeFromCommentPrompt } from "../prompts/scope";
import { runLlmRequests, type LlmRequest, type RunSummary } from "../lib/step-runner";
import { getTaskConfig, getTaskRoleModel } from "../lib/batch-config";
import { parseJsonResponse } from "../lib/json-parser";
import { extractMetadata } from "../lib/comment-processing";
import { htmlToText, wordCount } from "../lib/text";

function parseObject(text: string): Record<string, any> {
  let parsed: any;
  try { parsed = JSON.parse(text.replace(/```(?:json)?/g, "").trim()); } catch { parsed = parseJsonResponse(text); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("response is not a JSON object");
  return parsed;
}

// One small LLM call whose JSON result is returned (cached in the scope DB's llm_cache)
async function callJson(db: Database, task: string, model: string, prompt: string): Promise<{ result: Record<string, any>; summary: RunSummary }> {
  let result: Record<string, any> | null = null;
  const summary = await runLlmRequests([{ key: task, model, parts: [{ text: prompt }], config: { responseMimeType: "application/json" } }],
    (_req, res) => { result = parseObject(res.text); }, { db, task, mode: "live", concurrency: 1 });
  if (!result) throw new Error(`${task}: no usable response`);
  return { result, summary };
}

async function draftLabel(db: Database, promptMd: string): Promise<{ name: string; summary: string }> {
  const model = getTaskRoleModel("scopeRelevance", "label");
  const { result } = await callJson(db, "scope-label", model, buildScopeLabelPrompt(promptMd));
  return { name: String(result.name || "").trim(), summary: String(result.summary || "").trim() };
}

function readPromptFile(path: string): string {
  const text = readFileSync(path, "utf-8").trim();
  if (!text) throw new Error(`${path} is empty`);
  return text;
}

function printScope(s: ScopeRow) {
  console.log(`Name:    ${s.name}`);
  console.log(`Summary: ${s.summary || "(none)"}`);
  if (s.seed_comment_id) console.log(`Seed:    ${s.seed_comment_id}`);
  console.log(`\n--- scope prompt ---\n${s.prompt_md}\n--- end ---`);
}

function statusLine(db: Database, s: ScopeRow): string {
  const tableCount = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM main.${t}`).get() as { n: number }).n;
  if (!relevanceIsCurrent(db, s)) {
    return tableCount("scope_relevance") > 0 ? "STALE: prompt edited since relevance was judged; rerun scope-relevance (results will be cleared)" : "relevance not run yet";
  }
  const c = scopeCounts(db);
  return `relevance: ${c.judgedUnits}/${c.docketUnits} units judged; in scope ${c.inScopeUnits} units = ${c.inScopeSubmissions} of ${c.docketSubmissions} submissions` +
    ` | themes ${tableCount("theme_hierarchy")}, extracts ${tableCount("comment_theme_extracts")}, summaries ${tableCount("theme_summaries")}`;
}

// ── scope create / show / edit / list ──────────────────────────────────────────────────────

const createCmd = new Command("create")
  .description("Create a scope from a markdown prompt file, or draft one from a seed comment")
  .argument("<document-id>", "Document ID (the docket DB)")
  .argument("<slug>", "URL-safe scope name, e.g. interop")
  .option("--prompt-file <md>", "Markdown file with the scope prompt")
  .option("--from-comment <commentId>", "Draft the scope prompt from the issues raised in this comment")
  .option("--name <name>", "Short name (<= ~6 words); drafted by an LLM if omitted")
  .option("--summary <sentence>", "One-sentence summary; drafted by an LLM if omitted")
  .action(async (documentId: string, slug: string, options: any) => {
    if (!SLUG_RE.test(slug)) throw new Error(`Invalid slug "${slug}": lowercase letters, digits and dashes`);
    if (!!options.promptFile === !!options.fromComment) throw new Error("Give exactly one of --prompt-file or --from-comment");
    if (existsSync(getScopeDbPath(documentId, slug))) throw new Error(`Scope "${slug}" already exists (${getScopeDbPath(documentId, slug)}); use 'scope edit'`);
    const promptMd = options.promptFile ? readPromptFile(options.promptFile) : null;
    const db = openScopeDb(documentId, slug, { create: true });
    try {
      let name: string | undefined = options.name, summary: string | undefined = options.summary;
      let prompt = promptMd;
      let seed: string | null = null;
      if (options.fromComment) {
        seed = options.fromComment;
        const row = db.prepare(`SELECT c.attributes_json, t.markdown FROM comments c
          LEFT JOIN transcriptions t ON t.comment_id = c.id AND t.status = 'completed' WHERE c.id = ?`).get(seed) as { attributes_json: string; markdown: string | null } | null;
        if (!row) throw new Error(`Comment ${seed} not found in the docket DB`);
        const attrs = JSON.parse(row.attributes_json);
        const text = row.markdown || htmlToText(attrs.comment || "");
        if (!row.markdown) console.warn(`⚠️  ${seed} has no transcription; drafting from its typed text only (run transcribe for attachment letters)`);
        const meta = extractMetadata(attrs);
        const model = getTaskRoleModel("scopeRelevance", "draft");
        console.log(`✍️  Drafting scope from ${seed} (${meta.submitter}, ${wordCount(text).toLocaleString()} words) with ${model}...`);
        const { result, summary: s } = await callJson(db, "scope-draft", model, buildScopeFromCommentPrompt(
          (db.prepare("SELECT title FROM document_metadata LIMIT 1").get() as { title?: string } | null)?.title || null, seed!, meta.submitter, text));
        if (!result.prompt_md) throw new Error("draft has no prompt_md");
        prompt = String(result.prompt_md).trim();
        name ??= String(result.name || "").trim() || undefined;
        summary ??= String(result.summary || "").trim() || undefined;
        console.log(`   ~$${s.costUsd.toFixed(4)}`);
      }
      if (!name || !summary) {
        const label = await draftLabel(db, prompt!);
        name ??= label.name || slug;
        summary ??= label.summary || undefined;
      }
      db.prepare("INSERT INTO main.scope (slug, name, summary, prompt_md, seed_comment_id) VALUES (?, ?, ?, ?, ?)")
        .run(slug, name!, summary ?? null, prompt!, seed);
      console.log(`✅ Created scope "${slug}" in ${getScopeDbPath(documentId, slug)}\n`);
      printScope(getScope(db));
      console.log(`\nEdit with: scope edit ${documentId} ${slug} [--prompt-file <md>] [--name ...] [--summary ...]`);
      console.log(`Run with:  pipeline ${documentId} --scope ${slug}`);
    } catch (e) {
      db.close();
      // Don't leave a scope DB without a scope row behind
      try { unlinkSync(getScopeDbPath(documentId, slug)); } catch {}
      throw e;
    }
    db.close();
  });

const showCmd = new Command("show")
  .description("Print a scope's name, summary, prompt and status")
  .argument("<document-id>").argument("<slug>")
  .option("--prompt-only", "Print only the prompt markdown (e.g. to redirect into a file for editing)")
  .action((documentId: string, slug: string, options: any) => {
    const db = openScopeDb(documentId, slug);
    const s = getScope(db);
    if (options.promptOnly) { process.stdout.write(s.prompt_md + "\n"); db.close(); return; }
    console.log(`Scope "${s.slug}" (${getScopeDbPath(documentId, slug)}), created ${s.created_at}, updated ${s.updated_at}`);
    console.log(`Status:  ${statusLine(db, s)}`);
    printScope(s);
    db.close();
  });

const editCmd = new Command("edit")
  .description("Change a scope's prompt, name or summary. A changed prompt makes scoped results stale: the next scope-relevance run clears and recomputes them (llm_cache keeps unchanged calls free)")
  .argument("<document-id>").argument("<slug>")
  .option("--prompt-file <md>", "New scope prompt")
  .option("--name <name>", "New short name")
  .option("--summary <sentence>", "New one-sentence summary")
  .option("--relabel", "Redraft name and summary from the (new) prompt with an LLM")
  .action(async (documentId: string, slug: string, options: any) => {
    const db = openScopeDb(documentId, slug);
    const s = getScope(db);
    const prompt = options.promptFile ? readPromptFile(options.promptFile) : s.prompt_md;
    let name: string = options.name ?? s.name, summary: string | null = options.summary ?? s.summary;
    if (options.relabel) {
      const label = await draftLabel(db, prompt);
      if (!options.name) name = label.name || name;
      if (!options.summary) summary = label.summary || summary;
    }
    db.prepare("UPDATE main.scope SET prompt_md = ?, name = ?, summary = ?, updated_at = CURRENT_TIMESTAMP WHERE slug = ?").run(prompt, name, summary, slug);
    const changed = prompt !== s.prompt_md;
    console.log(`✅ Updated scope "${slug}"${changed ? " (prompt changed)" : ""}\n`);
    printScope(getScope(db));
    if (changed && s.relevance_prompt_hash) {
      console.log(`\n⚠️  Scoped results are now stale; rerun: pipeline ${documentId} --scope ${slug}`);
      if (!options.name && !options.summary && !options.relabel) console.log(`   (name/summary kept; pass --relabel to redraft them from the new prompt)`);
    }
    db.close();
  });

const listCmd = new Command("list")
  .description("List a document's scopes")
  .argument("<document-id>")
  .action((documentId: string) => {
    const slugs = listScopeSlugs(documentId);
    if (slugs.length === 0) { console.log(`No scopes for ${documentId}`); return; }
    for (const slug of slugs) {
      try {
        const db = openScopeDb(documentId, slug);
        const s = getScope(db);
        console.log(`${slug.padEnd(20)} ${s.name}\n${"".padEnd(20)} ${s.summary || ""}\n${"".padEnd(20)} ${statusLine(db, s)}`);
        db.close();
      } catch (e) {
        console.log(`${slug.padEnd(20)} ❌ ${(e as Error).message}`);
      }
    }
  });

export const scopeCommand = new Command("scope")
  .description("Manage scoped analyses: create | show | edit | list")
  .addCommand(createCmd)
  .addCommand(showCmd)
  .addCommand(editCmd)
  .addCommand(listCmd);

// ── scope-relevance ────────────────────────────────────────────────────────────────────────

interface RelUnit {
  id: string;
  text: string;
  words: number;
  long: boolean;
  kind: "condensed" | "full" | "stance_only";
  clusterSize: number;
}

function condensedText(sections: Record<string, string>): string {
  const parts: string[] = [];
  const add = (title: string, v?: string) => { if (v && v.trim()) parts.push(`## ${title}\n${v.trim()}`); };
  add("Commenter Profile", sections.commenterProfile);
  add("Overview", sections.oneLineSummary);
  add("Core Position", sections.corePosition);
  add("Key Recommendations", sections.keyRecommendations);
  add("Main Concerns", sections.mainConcerns);
  add("Notable Experiences", sections.notableExperiences);
  return parts.join("\n\n");
}

function loadRelevanceUnits(db: Database, longMinWords: number): RelUnit[] {
  const rows = db.prepare(analysisUnitSql(hasClustering(db)) + " ORDER BY c.id").all() as any[];
  return rows.map(r => {
    const raw = htmlToText(r.raw_comment || "");
    if (r.triage_label === "stance_only") {
      return { id: r.id, text: raw, words: wordCount(raw), long: false, kind: "stance_only", clusterSize: r.cluster_size };
    }
    const full = r.markdown || raw;
    const fullWords = wordCount(full);
    // Long letters, attachments and promoted members: full text (scope passages deep in a letter are
    // what condensing drops). Short typed comments: the condensed summary, or the typed text itself
    // when that is shorter (it usually is for very brief comments, and excerpts are then verbatim)
    if (r.has_att || r.promoted || fullWords > longMinWords) {
      return { id: r.id, text: full, words: fullWords, long: true, kind: "full", clusterSize: r.cluster_size };
    }
    const cond = condensedText(JSON.parse(r.structured_sections || "{}"));
    const useRaw = !cond || fullWords <= wordCount(cond);
    const text = useRaw ? full : cond;
    return { id: r.id, text, words: wordCount(text), long: false, kind: useRaw ? "full" : "condensed", clusterSize: r.cluster_size };
  });
}

function packLong(units: RelUnit[], maxWords: number, maxSize: number): RelUnit[][] {
  const out: RelUnit[][] = [];
  let cur: RelUnit[] = [], words = 0;
  for (const u of units) {
    if (cur.length && (words + u.words > maxWords || cur.length >= maxSize)) { out.push(cur); cur = []; words = 0; }
    cur.push(u); words += u.words;
  }
  if (cur.length) out.push(cur);
  return out;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export const scopeRelevanceCommand = new Command("scope-relevance")
  .description("Judge every analysis unit against a scope: relevant or not, plus the in-scope excerpt (scoped analysis step 1)")
  .argument("<document-id>", "Document ID")
  .requiredOption("--scope <slug>", "Scope slug")
  .option("--force", "Re-judge every unit (clears this scope's themes, extracts and summaries too)")
  .option("-l, --limit <n>", "Judge only the first N unjudged units (testing)", parseInt)
  .option("--batch", "Use the Gemini Batch API (half price, slower)")
  .option("-c, --concurrency <n>", "Parallel API calls", parseInt)
  .option("-m, --model <model>", "Model for every call (overrides config)")
  .option("-d, --debug", "Print the first prompt")
  .action(async (documentId: string, options: any) => {
    const slug: string = options.scope;
    const db = openScopeDb(documentId, slug);
    const scope = getScope(db);
    const taskConfig = getTaskConfig("scopeRelevance", options.model);
    const t = taskConfig.thresholds || {};
    const longMinWords: number = t.longMinWords ?? 400;
    const shortBatchSize: number = t.shortBatchSize ?? 40;
    const longBatchWords: number = t.longBatchWords ?? 12000;
    const longBatchSize: number = t.longBatchSize ?? 4;
    const models = {
      short: getTaskRoleModel("scopeRelevance", "short", options.model),
      long: getTaskRoleModel("scopeRelevance", "long", options.model),
    };
    const mode = options.batch ? "batch" : "live";
    const concurrency: number = options.concurrency || taskConfig.concurrency || 10;

    console.log(`🔭 Scope relevance: ${documentId} / ${slug} (${scope.name})`);
    console.log(`   Models: short=${models.short} long=${models.long} (${mode}); long = attachment, promoted or >${longMinWords} words`);

    // A changed prompt invalidates everything scoped; clear and recompute (the cache absorbs unchanged calls)
    const hash = promptHash(scope.prompt_md);
    if (scope.relevance_prompt_hash !== hash) {
      const had = (db.prepare("SELECT COUNT(*) AS n FROM main.scope_relevance").get() as { n: number }).n;
      if (had > 0 || (db.prepare("SELECT COUNT(*) AS n FROM main.theme_hierarchy").get() as { n: number }).n > 0) {
        console.log(`♻️  Scope prompt changed since the last run: clearing scoped results (relevance, themes, extracts, summaries)`);
      }
      clearScopedResults(db);
      db.prepare("UPDATE main.scope SET relevance_prompt_hash = ? WHERE slug = ?").run(hash, slug);
    }
    // Everything downstream depends on which units are relevant, so re-judging starts the scope over
    if (options.force) {
      console.log(`♻️  --force: clearing scoped results (relevance, themes, extracts, summaries)`);
      clearScopedResults(db);
      db.prepare("UPDATE main.scope SET relevance_prompt_hash = ? WHERE slug = ?").run(hash, slug);
    }

    const all = loadRelevanceUnits(db, longMinWords);
    const judged = new Set((db.prepare("SELECT comment_id FROM main.scope_relevance").all() as { comment_id: string }[]).map(r => r.comment_id));
    let todo = all.filter(u => !judged.has(u.id));
    if (options.limit) todo = todo.slice(0, options.limit);
    const nLong = todo.filter(u => u.long).length;
    console.log(`📊 ${all.length} units (${judged.size} already judged); judging ${todo.length}: ${todo.length - nLong} short (${todo.filter(u => u.kind === "condensed").length} via condensed summary), ${nLong} long (${todo.filter(u => u.long).reduce((s, u) => s + u.words, 0).toLocaleString()} words)`);

    const ruleTitle = (db.prepare("SELECT title FROM document_metadata LIMIT 1").get() as { title?: string } | null)?.title || null;
    const insert = db.prepare(`INSERT OR REPLACE INTO main.scope_relevance (comment_id, relevant, excerpt, note, cluster_size, input_kind, model)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const done = new Set<string>();
    const phases: [string, RunSummary][] = [];

    const runPass = async (items: RelUnit[], pass: string, shortSize: number, longWords: number, longSize: number) => {
      const batches = new Map<string, { role: "short" | "long"; units: RelUnit[] }>();
      chunk(items.filter(u => !u.long), shortSize).forEach((b, i) => batches.set(`rel-${pass}-s${i}`, { role: "short", units: b }));
      packLong(items.filter(u => u.long), longWords, longSize).forEach((b, i) => batches.set(`rel-${pass}-l${i}-${b[0].id}`, { role: "long", units: b }));
      // Both roles at once: in batch mode their jobs wait in the queue together
      await Promise.all((["short", "long"] as const).map(async role => {
        const requests: LlmRequest[] = [...batches].filter(([, b]) => b.role === role).map(([key, b]) => ({
          key,
          model: models[role],
          parts: [{ text: buildScopeRelevancePrompt(ruleTitle, scope.prompt_md, b.units.map((u, j) => ({ id: `c${j + 1}`, text: u.text }))) }],
          config: { responseMimeType: "application/json" },
        }));
        if (requests.length === 0) return;
        if (options.debug && pass === "p1") console.log(requests[0].parts[0].text!.slice(0, 6000));
        phases.push([`${role} ${pass}`, await runLlmRequests(requests, (req, res) => {
          const b = batches.get(req.key)!;
          let parsed = parseObject(res.text);
          if (b.units.length === 1 && !("c1" in parsed) && "relevant" in parsed) parsed = { c1: parsed };
          let got = 0;
          db.transaction(() => {
            b.units.forEach((u, j) => {
              const e = parsed[`c${j + 1}`];
              if (!e || typeof e !== "object") return;
              const excerpt = typeof e.excerpt === "string" ? e.excerpt.trim() : "";
              // Occasionally "relevant" is missing or a string; an excerpt means it found in-scope text
              const relevant = typeof e.relevant === "boolean" ? e.relevant
                : e.relevant === "true" ? true : e.relevant === "false" ? false
                : excerpt ? true : undefined;
              if (relevant === undefined) return;
              insert.run(u.id, relevant ? 1 : 0, relevant ? excerpt : "", typeof e.note === "string" ? e.note.trim() : null, u.clusterSize, u.kind, req.model);
              done.add(u.id);
              got++;
            });
          })();
          // Unusable response: throw so it isn't cached (a retry of the same prompt must call the model again)
          if (got === 0) throw new Error("no usable judgment in response");
        }, { db, task: `scope-relevance-${role}`, mode, concurrency, label: `scope-relevance-${role}-${pass}:${documentId}:${slug}` })]);
      }));
    };

    if (todo.length > 0) {
      await runPass(todo, "p1", shortBatchSize, longBatchWords, longBatchSize);
      const missing = todo.filter(u => !done.has(u.id));
      if (missing.length > 0) {
        console.log(`🔁 ${missing.length} units missing from responses; retrying in smaller batches`);
        await runPass(missing, "p2", Math.max(5, Math.ceil(shortBatchSize / 5)), longBatchWords, 1);
      }
      const still = todo.filter(u => !done.has(u.id)).length;
      if (still > 0) console.warn(`⚠️  ${still} units could not be judged; re-run to retry them`);
    }

    // The seed letter of a seed-comment scope is in scope by definition (its representative, if grouped)
    if (scope.seed_comment_id) {
      const rep = (db.prepare(`SELECT k.representative_comment_id AS id FROM comment_cluster_membership m
        JOIN comment_clusters k ON k.cluster_id = m.cluster_id WHERE m.comment_id = ?`).get(scope.seed_comment_id) as { id: string } | null)?.id || scope.seed_comment_id;
      const r = db.prepare("SELECT relevant FROM main.scope_relevance WHERE comment_id = ?").get(rep) as { relevant: number } | null;
      if (r) {
        if (!r.relevant) console.log(`   seed ${rep} was judged not relevant; marking it relevant`);
        db.prepare("UPDATE main.scope_relevance SET relevant = 1, is_seed = 1, note = COALESCE(NULLIF(note, ''), 'seed letter') WHERE comment_id = ?").run(rep);
      }
    }

    // ── Report ──
    const c = scopeCounts(db);
    const byKind = db.prepare(`SELECT input_kind AS kind, COUNT(*) AS n, SUM(relevant) AS rel FROM main.scope_relevance GROUP BY input_kind`).all() as { kind: string; n: number; rel: number }[];
    console.log(`\n✅ Relevance: ${c.judgedUnits}/${c.docketUnits} units judged`);
    console.log(`   In scope: ${c.inScopeUnits} units (${(c.inScopeUnits / Math.max(1, c.judgedUnits) * 100).toFixed(1)}%) = ${c.inScopeSubmissions} of ${c.docketSubmissions} submissions (${(c.inScopeSubmissions / Math.max(1, c.docketSubmissions) * 100).toFixed(1)}%)`);
    for (const k of byKind) console.log(`   ${String(k.kind).padEnd(12)} ${k.rel}/${k.n} relevant`);
    let cost = 0;
    for (const [name, s] of phases) {
      cost += s.costUsd;
      const u = s.usage;
      console.log(`   ${name.padEnd(10)} calls=${s.ok + s.failed} (cached ${s.cached}, failed ${s.failed}) in=${u.input.toLocaleString()} out=${u.output.toLocaleString()} thoughts=${u.thoughts.toLocaleString()} ~$${s.costUsd.toFixed(3)}`);
    }
    console.log(`   total ~$${cost.toFixed(3)}${mode === "batch" ? " (batch price)" : ""}`);
    if (c.inScopeUnits < 10) console.warn(`⚠️  Fewer than 10 units in scope; theme discovery will have little to work with`);
    db.close();
  });
