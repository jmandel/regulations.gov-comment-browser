// Scoped analyses: one small SQLite file per (document, scope) holding only the scope's own tables,
// with the docket DB ATTACHed read-only as `base`. SQLite resolves unqualified table names in
// `main` first, then attached DBs, so the existing queries in discover-themes / extract-theme-content
// / summarize-themes-v2 read comments, transcriptions, condensed comments, clusters, triage and
// campaigns from the docket DB and read/write theme tables in the scope DB. The read-only attach
// means a scoped run can never modify the docket DB.
//
// File naming is flat (<DB_DIR>/<documentId>.scope.<slug>.sqlite) because the Drive download
// script flattens folders.

import { Database, constants } from "bun:sqlite";
import { existsSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { createHash } from "crypto";
import { DB_DIR, getDbPath } from "./database";

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function getScopeDbPath(documentId: string, slug: string): string {
  return join(DB_DIR, `${documentId}.scope.${slug}.sqlite`);
}

// Every scope DB of a document, by slug
export function listScopeSlugs(documentId: string, dbDir: string = DB_DIR): string[] {
  const prefix = `${documentId}.scope.`;
  return readdirSync(dbDir)
    .filter(f => f.startsWith(prefix) && f.endsWith(".sqlite"))
    .map(f => f.slice(prefix.length, -".sqlite".length))
    .filter(s => SLUG_RE.test(s))
    .sort();
}

// True for a scope DB file name (callers that treat every dbs/*.sqlite as a docket must skip these)
export function isScopeDbFile(fileName: string): boolean {
  return /\.scope\.[a-z0-9][a-z0-9-]*\.sqlite$/.test(fileName);
}

// Tables a scope DB may contain. Everything else must come from the attached docket DB.
export const SCOPE_TABLES = [
  "scope", "scope_relevance",
  "theme_hierarchy", "comment_theme_extracts", "comment_theme_extract_status",
  "comment_theme_groups", "comment_theme_group_status", "theme_summaries",
  "llm_cache", "batch_jobs",
];

// Scoped results that depend on the scope prompt (cleared when the prompt changes)
const RESULT_TABLES = [
  "theme_summaries", "comment_theme_extracts", "comment_theme_extract_status",
  "comment_theme_groups", "comment_theme_group_status", "theme_hierarchy", "scope_relevance",
];

function initScopeSchema(db: Database) {
  // Theme tables mirror initSchema() in database.ts (minus foreign keys into docket tables, which
  // live in the attached DB). Keep the column sets in sync.
  db.exec(`
    CREATE TABLE IF NOT EXISTS scope (
      slug TEXT PRIMARY KEY,
      name TEXT NOT NULL,            -- short phrase (<= ~6 words) shown on every page
      summary TEXT,                  -- one plain sentence
      prompt_md TEXT NOT NULL,       -- the scope itself: markdown, verbatim in every scoped prompt
      seed_comment_id TEXT,          -- set for scopes drafted from a comment
      relevance_prompt_hash TEXT,    -- hash of prompt_md that scope_relevance (and everything after) was computed with
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- One row per analysis unit judged (cluster representative or ungrouped comment)
    CREATE TABLE IF NOT EXISTS scope_relevance (
      comment_id TEXT PRIMARY KEY,
      relevant INTEGER NOT NULL,     -- 1 = addresses the scope
      excerpt TEXT,                  -- in-scope passages, verbatim where possible
      note TEXT,                     -- one line: what part of the scope it touches
      cluster_size INTEGER NOT NULL DEFAULT 1,  -- submissions this unit stands for
      input_kind TEXT,               -- condensed | full | stance_only: what the judge read
      is_seed INTEGER NOT NULL DEFAULT 0,
      model TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_scope_relevance_relevant ON scope_relevance(relevant);

    CREATE TABLE IF NOT EXISTS theme_hierarchy (
      code TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      level INTEGER NOT NULL,
      parent_code TEXT,
      quotes_json TEXT,
      detailed_guidelines TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (parent_code) REFERENCES theme_hierarchy(code)
    );
    CREATE TABLE IF NOT EXISTS theme_summaries (
      theme_code TEXT PRIMARY KEY,
      structured_sections TEXT NOT NULL,
      comment_count INTEGER NOT NULL,
      word_count INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (theme_code) REFERENCES theme_hierarchy(code)
    );
    CREATE TABLE IF NOT EXISTS comment_theme_extracts (
      comment_id TEXT NOT NULL,
      theme_code TEXT NOT NULL,
      extract_json TEXT NOT NULL,
      cluster_size INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (comment_id, theme_code),
      FOREIGN KEY (theme_code) REFERENCES theme_hierarchy(code)
    );
    CREATE INDEX IF NOT EXISTS idx_theme_extracts_theme ON comment_theme_extracts(theme_code);
    CREATE TABLE IF NOT EXISTS comment_theme_groups (
      comment_id TEXT NOT NULL,
      group_code TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (comment_id, group_code)
    );
    CREATE TABLE IF NOT EXISTS comment_theme_group_status (
      comment_id TEXT PRIMARY KEY,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS comment_theme_extract_status (
      comment_id TEXT NOT NULL,
      group_code TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (comment_id, group_code)
    );
    CREATE TABLE IF NOT EXISTS llm_cache (
      prompt_hash TEXT PRIMARY KEY,
      task_type TEXT NOT NULL,
      task_level INTEGER DEFAULT 0,
      task_params TEXT,
      result TEXT NOT NULL,
      model TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_llm_cache_task_type_level ON llm_cache(task_type, task_level);
    CREATE TABLE IF NOT EXISTS batch_jobs (
      job_name TEXT PRIMARY KEY,
      task TEXT NOT NULL,
      label TEXT NOT NULL,
      model TEXT NOT NULL,
      request_keys TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function sqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

// Open (creating with `create`) the scope DB for documentId/slug and attach the docket DB read-only
export function openScopeDb(documentId: string, slug: string, opts: { create?: boolean } = {}): Database {
  if (!SLUG_RE.test(slug)) throw new Error(`Invalid scope slug "${slug}": use lowercase letters, digits and dashes`);
  const basePath = getDbPath(documentId);
  if (!existsSync(basePath)) throw new Error(`Docket DB not found: ${basePath}`);
  const path = getScopeDbPath(documentId, slug);
  if (!opts.create && !existsSync(path)) {
    throw new Error(`Scope "${slug}" not found (${path}). Create it with: scope create ${documentId} ${slug} --prompt-file <md>`);
  }

  // URI filenames must be enabled on the main connection for ATTACH 'file:...?mode=ro' to work
  const db = new Database(path, constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_CREATE | constants.SQLITE_OPEN_URI);
  db.exec("PRAGMA journal_mode = DELETE");
  initScopeSchema(db);

  const uri = "file:" + resolve(basePath).split("/").map(encodeURIComponent).join("/") + "?mode=ro";
  db.exec(`ATTACH DATABASE ${sqlString(uri)} AS base`);

  // Shadowing guard: a docket table in the scope DB would silently hide the docket's rows
  const mainTables = new Set((db.prepare("SELECT name FROM main.sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(r => r.name));
  const extra = [...mainTables].filter(t => !SCOPE_TABLES.includes(t) && !t.startsWith("sqlite_"));
  if (extra.length) {
    db.close();
    throw new Error(`Scope DB ${path} contains non-scope tables (${extra.join(", ")}), which would shadow the docket DB. Remove them.`);
  }
  return db;
}

export interface ScopeRow {
  slug: string;
  name: string;
  summary: string | null;
  prompt_md: string;
  seed_comment_id: string | null;
  relevance_prompt_hash: string | null;
  created_at: string;
  updated_at: string;
}

export function promptHash(promptMd: string): string {
  return createHash("sha256").update(promptMd).digest("hex").slice(0, 16);
}

export function getScope(db: Database): ScopeRow {
  const row = db.prepare("SELECT * FROM main.scope LIMIT 1").get() as ScopeRow | null;
  if (!row) throw new Error("Scope DB has no scope row");
  return row;
}

// Relevance results exist and were computed with the current prompt
export function relevanceIsCurrent(db: Database, scope: ScopeRow): boolean {
  if (scope.relevance_prompt_hash !== promptHash(scope.prompt_md)) return false;
  const n = (db.prepare("SELECT COUNT(*) AS n FROM main.scope_relevance").get() as { n: number }).n;
  return n > 0;
}

// Delete every result that depends on the scope prompt (llm_cache stays: unchanged calls are free)
export function clearScopedResults(db: Database) {
  db.transaction(() => {
    for (const t of RESULT_TABLES) db.exec(`DELETE FROM main.${t}`);
    db.exec("UPDATE main.scope SET relevance_prompt_hash = NULL");
  })();
}

// Open a scope DB for a scoped theme step (discover/extract/summarize): fails unless relevance is
// current, so stale results from an edited prompt are never extended
export function openScopeForAnalysis(documentId: string, slug: string): { db: Database; scope: ScopeRow } {
  const db = openScopeDb(documentId, slug);
  const scope = getScope(db);
  if (!relevanceIsCurrent(db, scope)) {
    db.close();
    throw new Error(`Scope "${slug}": relevance judgments are missing or out of date with the scope prompt. Run: scope-relevance ${documentId} --scope ${slug}`);
  }
  return { db, scope };
}

export interface ScopeCounts {
  docketSubmissions: number;   // all comments in the docket DB
  docketUnits: number;         // analysis units (representatives / ungrouped comments, minus no_substance)
  inScopeSubmissions: number;  // sum of cluster sizes of relevant units
  inScopeUnits: number;
  judgedUnits: number;
}

export function scopeCounts(db: Database): ScopeCounts {
  const docketSubmissions = (db.prepare("SELECT COUNT(*) AS n FROM comments").get() as { n: number }).n;
  const docketUnits = (db.prepare(`SELECT COUNT(*) AS n FROM (${analysisUnitSql(hasClustering(db))})`).get() as { n: number }).n;
  const r = db.prepare(`SELECT COUNT(*) AS judged, SUM(relevant) AS units, SUM(CASE WHEN relevant = 1 THEN cluster_size ELSE 0 END) AS subs FROM main.scope_relevance`).get() as { judged: number; units: number | null; subs: number | null };
  return { docketSubmissions, docketUnits, inScopeSubmissions: r.subs || 0, inScopeUnits: r.units || 0, judgedUnits: r.judged };
}

export function hasClustering(db: Database): boolean {
  return !!db.prepare("SELECT 1 FROM clustering_status WHERE status = 'completed' LIMIT 1").get();
}

// The analysis units, same selection as extract-theme-content: cluster representatives (when
// clustering ran) that were condensed, plus stance_only triaged comments; no_substance excluded
export function analysisUnitSql(repsOnly: boolean): string {
  return `
    SELECT c.id,
           COALESCE(json_extract(c.attributes_json, '$.comment'), json_extract(c.attributes_json, '$.text')) AS raw_comment,
           c.attributes_json,
           cc.structured_sections, t.markdown, tr.label AS triage_label,
           ${repsOnly ? "ccl.cluster_size" : "1"} AS cluster_size,
           EXISTS(SELECT 1 FROM attachments a WHERE a.comment_id = c.id) AS has_att,
           EXISTS(SELECT 1 FROM form_letter_additions f WHERE f.comment_id = c.id AND f.promoted = 1) AS promoted
    FROM comments c
    ${repsOnly ? `JOIN comment_cluster_membership ccm ON ccm.comment_id = c.id AND ccm.is_representative = 1
    JOIN comment_clusters ccl ON ccl.cluster_id = ccm.cluster_id` : ""}
    LEFT JOIN condensed_comments cc ON cc.comment_id = c.id AND cc.status = 'completed'
    LEFT JOIN transcriptions t ON t.comment_id = c.id AND t.status = 'completed'
    LEFT JOIN comment_triage tr ON tr.comment_id = c.id
    WHERE (tr.label IS NULL OR tr.label != 'no_substance')
      AND (cc.comment_id IS NOT NULL OR tr.label = 'stance_only')`;
}

// Text block stating the scope's denominators, for summary and group-report prompts
export function denominatorText(c: ScopeCounts): string {
  const pct = c.docketSubmissions ? ` (${(c.inScopeSubmissions / c.docketSubmissions * 100).toFixed(1)}%)` : "";
  return `This is a scoped analysis. Of the docket's ${c.docketSubmissions.toLocaleString("en-US")} submissions (${c.docketUnits.toLocaleString("en-US")} distinct comments or form-letter groups), ${c.inScopeSubmissions.toLocaleString("en-US")} submissions${pct} (${c.inScopeUnits.toLocaleString("en-US")} distinct comments or form-letter groups) were judged to address this scope. Counts you state are counts of in-scope submissions; when you give a share, say whether it is a share of in-scope submissions or of the whole docket.`;
}

// Open an existing scope DB read-only (website build, landing page, skill export): no schema
// creation or pragmas, so it works on published files and never writes
export function openScopeDbReadOnly(documentId: string, slug: string, dbDir: string = DB_DIR): Database {
  if (!SLUG_RE.test(slug)) throw new Error(`Invalid scope slug "${slug}"`);
  const basePath = join(dbDir, `${documentId}.sqlite`);
  const path = join(dbDir, `${documentId}.scope.${slug}.sqlite`);
  if (!existsSync(basePath)) throw new Error(`Docket DB not found: ${basePath}`);
  if (!existsSync(path)) throw new Error(`Scope "${slug}" not found (${path})`);
  const toUri = (p: string) => "file:" + resolve(p).split("/").map(encodeURIComponent).join("/") + "?mode=ro";
  const db = new Database(toUri(path), constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI);
  db.exec(`ATTACH DATABASE ${sqlString(toUri(basePath))} AS base`);
  return db;
}

export interface PublishedScopeInfo {
  slug: string;
  name: string;
  summary: string | null;
  seedCommentId: string | null;
  updatedAt: string;
  counts: ScopeCounts;
  themes: number;
  summaries: number;
}

// Scopes of a document that are ready to publish (relevance current with the prompt), with their
// name, summary and denominators. Stale or unreadable scope DBs are skipped with a warning.
export function listPublishableScopes(documentId: string, dbDir: string = DB_DIR): PublishedScopeInfo[] {
  const out: PublishedScopeInfo[] = [];
  for (const slug of listScopeSlugs(documentId, dbDir)) {
    let db: Database | null = null;
    try {
      db = openScopeDbReadOnly(documentId, slug, dbDir);
      const scope = getScope(db);
      if (!relevanceIsCurrent(db, scope)) {
        console.warn(`  ⚠️  Scope "${slug}": relevance missing or stale with its prompt; not published`);
        continue;
      }
      const n = (t: string) => (db!.prepare(`SELECT COUNT(*) AS n FROM main.${t}`).get() as { n: number }).n;
      out.push({
        slug, name: scope.name, summary: scope.summary, seedCommentId: scope.seed_comment_id,
        updatedAt: scope.updated_at, counts: scopeCounts(db), themes: n("theme_hierarchy"), summaries: n("theme_summaries"),
      });
    } catch (e) {
      console.warn(`  ⚠️  Scope "${slug}": ${(e as Error).message}; not published`);
    } finally {
      db?.close();
    }
  }
  return out;
}
