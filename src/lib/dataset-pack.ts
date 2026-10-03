// Downloadable analysis databases for one docket, written by build-website next to the site data:
//   <docket>-slim.sqlite.zip  metadata, form-letter groups, campaigns, triage, condensed summaries,
//                             themes, theme reports, per-theme extract points, entities
//   <docket>-full.sqlite.zip  all of that plus full comment text (typed text and attachment
//                             transcripts), members' added text, and a full-text index over it
// Each zip holds README.md and the .sqlite file. The databases use their own normalized schema,
// documented inline (header and per-column comments in every CREATE statement, so `.schema` reads
// as documentation) and in a `_readme` table created first. The pipeline database is only read.
// Output is deterministic: rows are inserted in sorted order, no export timestamp is recorded,
// and zip entries get a fixed mtime.
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, rm, stat, utimes, chmod, writeFile, copyFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { readFileSync } from "fs";
import { readDocumentInfo, type DocumentInfo } from "./document-meta";
import { htmlToText, wordCount } from "./text";
import { reportItems, reportMarkdown } from "./theme-report-markdown";
import { exampleAnalyses, ANALYSIS_TIPS, type ExampleParams } from "./dataset-pack-examples";
import { foldCategory, filedAs, submitterName, normalizeState, loadClassifications, SUBMITTER_TYPES, type SubmitterClassification } from "./submitter-meta";

export type PackKind = "slim" | "full";
export interface PackFile {
  kind: PackKind;
  file: string;        // file name inside the site's data/ directory
  bytes: number;       // zip size
  sqliteBytes: number; // uncompressed database size
  sha256: string;      // of the zip; publish-data-packs.sh compares it with the release asset's digest
}

// Where the zips are downloaded from. Unset (local builds): next to the site data, ./data/<file>.
// CI sets it to the GitHub release that holds the zips (see scripts/publish-data-packs.sh), since
// shipping them inside every Pages deploy stores a new copy of every docket's zips on each push.
export function packDownloadsBaseUrl(): string | undefined {
  return process.env.DATA_DOWNLOADS_URL?.replace(/\/$/, "") || undefined;
}

export const DEFAULT_SITE_URL = "https://joshuamandel.com/regulations.gov-comment-browser";
const MAX_PUBLISHED_BYTES = 100 * 1024 * 1024;
// Zip size limits for including the FTS5 search indexes, which add ~60-70% to a zip. Above them the
// file ships without the indexes and its _readme says how to build them (seconds to a minute).
const SIZE_BUDGET: Record<PackKind, number> = { slim: 50e6, full: 95e6 };
const SEARCH_GROWTH = 1.8;
const ZIP_MTIME = new Date("2000-01-01T00:00:00Z");

// ---------------------------------------------------------------------------------------------
// Reading the pipeline database

const hasTable = (db: Database, name: string) =>
  !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name);
const hasColumn = (db: Database, table: string, col: string) =>
  hasTable(db, table) && !!db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name=?`).get(table, col);
const count = (db: Database, table: string) =>
  hasTable(db, table) ? (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as any).n as number : 0;

type UnitKind = "form_letter" | "near_copy" | "promoted" | "individual";
const EXTRACT_KINDS: Record<string, string> = {
  positions: "position", concerns: "concern", recommendations: "recommendation",
  experiences: "experience", key_quotes: "quote", quotes: "quote",
};
const EXTRACT_ORDER = ["position", "concern", "recommendation", "experience", "quote"];
const CONDENSED_FIELDS: Array<[string, string]> = [
  ["oneLineSummary", "one_line_summary"], ["commenterProfile", "commenter_profile"],
  ["corePosition", "core_position"], ["keyRecommendations", "key_recommendations"],
  ["mainConcerns", "main_concerns"], ["notableExperiences", "notable_experiences"],
  ["keyQuotations", "key_quotations"],
];

interface Submission {
  id: string; attrs: any; unitId: string; isRep: boolean; submitter: string;
}
interface Unit {
  id: string; kind: UnitKind; weight: number; promotedFrom: string | null;
  sections: any | null; text: string | null; textSource: string | null; words: number | null;
}

interface Source {
  info: DocumentInfo;
  clustered: boolean;
  submissions: Submission[];
  units: Map<string, Unit>;              // by representative id, in id order
  attachments: any[];
  attachmentCount: Map<string, number>;
  additions: Map<string, { words: number; text: string; promoted: boolean; clusterId: number }>;
  campaigns: any[];
  campaignOf: Map<string, { id: number; how: string }>;
  triage: Map<string, { label: string; topic: string | null; stance: string | null }>;
  classifications: Map<string, SubmitterClassification>;
  themes: any[];
  summaries: Map<string, any>;
  unitThemes: Map<string, Set<string>>;  // theme code -> units with a direct extract
  extracts: Array<{ unitId: string; code: string; extract: any }>;
  entities: Array<{ id: number; category: string; label: string; definition: string | null; terms: string }>;
  unitEntities: Array<[string, number]>;
  provenance: Array<{ step: string; models: string }>;
  generatedAt: string | null;
  features: Record<string, boolean>;
}

function stepOf(task: string): string {
  const t = task.replace(/_/g, "-");
  if (t.startsWith("theme-discovery")) return "discover-themes";
  if (t.startsWith("theme-extract") || t === "theme-gate") return "extract-theme-content";
  if (t.startsWith("theme-summary") || t.startsWith("theme-group-summary")) return "summarize-themes";
  if (t.startsWith("discover-entities")) return "discover-entities";
  return t;
}
const STEP_ORDER = ["triage", "transcribe", "tag-campaigns", "condense", "classify-submitters", "discover-themes", "extract-theme-content", "summarize-themes", "discover-entities"];

function loadSource(db: Database, documentId: string): Source {
  const info = readDocumentInfo(db, documentId);

  // Form-letter groups: each comment's unit is its group's representative
  const clusterRep = new Map<number, string>();
  const membership = new Map<string, { cluster: number; isRep: boolean }>();
  if (count(db, "comment_cluster_membership") > 0) {
    for (const r of db.prepare(`SELECT cluster_id, representative_comment_id FROM comment_clusters`).all() as any[]) clusterRep.set(r.cluster_id, r.representative_comment_id);
    for (const r of db.prepare(`SELECT comment_id, cluster_id, is_representative FROM comment_cluster_membership`).all() as any[]) {
      membership.set(r.comment_id, { cluster: r.cluster_id, isRep: !!r.is_representative });
    }
  }
  const clustered = membership.size > 0;

  const additions: Source["additions"] = new Map();
  if (hasTable(db, "form_letter_additions")) {
    for (const r of db.prepare(`SELECT comment_id, cluster_id, added_word_count, added_text, promoted FROM form_letter_additions`).all() as any[]) {
      additions.set(r.comment_id, { words: r.added_word_count || 0, text: r.added_text || "", promoted: !!r.promoted, clusterId: r.cluster_id });
    }
  }

  const submissions: Submission[] = [];
  for (const r of db.prepare(`SELECT id, attributes_json FROM comments ORDER BY id`).all() as any[]) {
    let attrs: any = {};
    try { attrs = JSON.parse(r.attributes_json) || {}; } catch {}
    const m = membership.get(r.id);
    const rep = m ? clusterRep.get(m.cluster) : undefined;
    const unitId = rep && rep !== r.id && !m!.isRep ? rep : r.id;
    const submitter = submitterName(attrs);
    submissions.push({ id: r.id, attrs, unitId, isRep: unitId === r.id, submitter });
  }
  const known = new Set(submissions.map(s => s.id));
  for (const s of submissions) if (!known.has(s.unitId)) { s.unitId = s.id; s.isRep = true; } // dangling representative

  const attachments = hasTable(db, "attachments")
    ? db.prepare(`SELECT comment_id, id, format, file_name, url, size FROM attachments ORDER BY comment_id, id, format`).all() as any[]
    : [];
  const attachmentCount = new Map<string, number>();
  {
    const seen = new Set<string>();
    for (const a of attachments) {
      const k = `${a.comment_id}|${a.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      attachmentCount.set(a.comment_id, (attachmentCount.get(a.comment_id) || 0) + 1);
    }
  }

  const condensed = new Map<string, any>();
  for (const r of db.prepare(`SELECT comment_id, structured_sections FROM condensed_comments WHERE structured_sections IS NOT NULL AND structured_sections != ''`).all() as any[]) {
    try { condensed.set(r.comment_id, JSON.parse(r.structured_sections)); } catch {}
  }
  const transcripts = new Map<string, string>();
  if (hasTable(db, "transcriptions")) {
    for (const r of db.prepare(`SELECT comment_id, markdown FROM transcriptions WHERE status = 'completed' AND markdown IS NOT NULL AND markdown != ''`).all() as any[]) transcripts.set(r.comment_id, r.markdown);
  }

  // Units, with their weight (submissions they stand for) and kind
  const weight = new Map<string, number>();
  for (const s of submissions) weight.set(s.unitId, (weight.get(s.unitId) || 0) + 1);
  const units = new Map<string, Unit>();
  for (const s of submissions) {
    if (!s.isRep) continue;
    const w = weight.get(s.id) || 1;
    const add = additions.get(s.id);
    const promoted = w === 1 && add?.promoted;
    const kind: UnitKind = w >= 4 ? "form_letter" : w >= 2 ? "near_copy" : promoted ? "promoted" : "individual";
    const sections = condensed.get(s.id) || null;
    const legacy = typeof sections?.detailedContent === "string" && sections.detailedContent.trim() ? sections.detailedContent : null;
    const typed = htmlToText(String(s.attrs.comment || s.attrs.text || ""));
    const hasAtt = (attachmentCount.get(s.id) || 0) > 0;
    let text: string | null = null, textSource: string | null = null;
    const tr = transcripts.get(s.id);
    if (hasAtt && tr) { text = tr; textSource = "llm_transcript"; }
    else if (hasAtt && legacy) { text = legacy; textSource = "llm_transcript"; }
    else if (typed) { text = typed; textSource = "typed"; }
    else if (tr) { text = tr; textSource = "typed"; }
    units.set(s.id, {
      id: s.id, kind, weight: w,
      promotedFrom: promoted && add ? clusterRep.get(add.clusterId) ?? null : null,
      sections, text, textSource, words: text ? wordCount(text) : null,
    });
  }
  const unitOf = new Map(submissions.map(s => [s.id, s.unitId]));

  const campaigns = hasTable(db, "campaigns")
    ? db.prepare(`SELECT id, name, description, method, evidence, unit_count, exact_count, paraphrase_count, total_count FROM campaigns ORDER BY id`).all() as any[]
    : [];
  const campaignOf = new Map<string, { id: number; how: string }>();
  if (hasTable(db, "comment_campaigns")) {
    for (const r of db.prepare(`SELECT comment_id, campaign_id, how FROM comment_campaigns`).all() as any[]) campaignOf.set(r.comment_id, { id: r.campaign_id, how: r.how });
  }
  const triage = new Map<string, { label: string; topic: string | null; stance: string | null }>();
  if (hasTable(db, "comment_triage")) {
    for (const r of db.prepare(`SELECT comment_id, label, topic, stance FROM comment_triage`).all() as any[]) triage.set(r.comment_id, { label: r.label, topic: r.topic, stance: r.stance });
  }

  const classifications = loadClassifications(db);

  const themes = db.prepare(`SELECT code, description, level, parent_code, ${hasColumn(db, "theme_hierarchy", "detailed_guidelines") ? "detailed_guidelines" : "NULL AS detailed_guidelines"} FROM theme_hierarchy ORDER BY code`).all() as any[];
  const themeCodes = new Set(themes.map(t => t.code));
  const summaries = new Map<string, any>();
  for (const r of db.prepare(`SELECT theme_code, structured_sections FROM theme_summaries ORDER BY theme_code`).all() as any[]) {
    try { summaries.set(r.theme_code, JSON.parse(r.structured_sections)); } catch {}
  }

  // Extracts belong to units; an extract stored on a since-regrouped member is moved to its unit
  const extracts: Source["extracts"] = [];
  const unitThemes = new Map<string, Set<string>>();
  const seenExtract = new Set<string>();
  for (const r of db.prepare(`SELECT comment_id, theme_code, extract_json FROM comment_theme_extracts ORDER BY theme_code, comment_id`).all() as any[]) {
    const unitId = unitOf.get(r.comment_id);
    if (!unitId || !themeCodes.has(r.theme_code)) continue;
    const key = `${unitId}|${r.theme_code}`;
    if (seenExtract.has(key)) continue;
    seenExtract.add(key);
    let extract: any = null;
    try { const p = JSON.parse(r.extract_json); extract = p?.extract || p; } catch {}
    extracts.push({ unitId, code: r.theme_code, extract });
    let set = unitThemes.get(r.theme_code); if (!set) unitThemes.set(r.theme_code, set = new Set()); set.add(unitId);
  }

  const entities: Source["entities"] = [];
  const entityId = new Map<string, number>();
  for (const r of db.prepare(`SELECT category, label, definition, terms FROM entity_taxonomy ORDER BY category, label`).all() as any[]) {
    const id = entities.length + 1;
    entities.push({ id, category: r.category, label: r.label, definition: r.definition, terms: r.terms });
    entityId.set(`${r.category}|${r.label}`, id);
  }
  const unitEntitySet = new Set<string>();
  const unitEntities: Array<[string, number]> = [];
  for (const r of db.prepare(`SELECT comment_id, category, entity_label FROM comment_entities ORDER BY comment_id, category, entity_label`).all() as any[]) {
    const unitId = unitOf.get(r.comment_id);
    const id = entityId.get(`${r.category}|${r.entity_label}`);
    if (!unitId || !id || unitEntitySet.has(`${unitId}|${id}`)) continue;
    unitEntitySet.add(`${unitId}|${id}`);
    unitEntities.push([unitId, id]);
  }
  unitEntities.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]);

  // Which models produced what, from the LLM cache (older databases record fewer steps)
  const modelsByStep = new Map<string, Map<string, number>>();
  const addModel = (step: string, model: string | null, n: number) => {
    if (!model) return;
    let m = modelsByStep.get(step); if (!m) modelsByStep.set(step, m = new Map());
    m.set(model, (m.get(model) || 0) + n);
  };
  if (hasColumn(db, "llm_cache", "model")) {
    for (const r of db.prepare(`SELECT task_type, model, COUNT(*) AS n FROM llm_cache GROUP BY 1, 2`).all() as any[]) addModel(stepOf(r.task_type), r.model, r.n);
  }
  if (hasColumn(db, "comment_triage", "model")) {
    for (const r of db.prepare(`SELECT model, COUNT(*) AS n FROM comment_triage GROUP BY 1`).all() as any[]) addModel("triage", r.model, 0);
  }
  if (hasColumn(db, "comment_embeddings", "model") && count(db, "comment_embeddings") > 0) {
    for (const r of db.prepare(`SELECT DISTINCT model FROM comment_embeddings`).all() as any[]) addModel("tag-campaigns", r.model, 0);
  }
  const provenance = [...modelsByStep.entries()]
    .sort((a, b) => (STEP_ORDER.indexOf(a[0]) + 1 || 99) - (STEP_ORDER.indexOf(b[0]) + 1 || 99) || a[0].localeCompare(b[0]))
    .map(([step, m]) => ({ step, models: [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k).join(", ") }));

  // When the analysis was last updated (not the export time, so re-exports are identical)
  let generatedAt: string | null = null;
  for (const t of ["theme_summaries", "comment_theme_extracts", "condensed_comments", "transcriptions", "campaigns", "entity_taxonomy"]) {
    if (!hasColumn(db, t, "created_at")) continue;
    const v = (db.prepare(`SELECT MAX(created_at) AS v FROM "${t}"`).get() as any)?.v;
    if (v && (!generatedAt || v > generatedAt)) generatedAt = v;
  }

  return {
    info, clustered, submissions, units, attachments, attachmentCount, additions, campaigns, campaignOf, triage, classifications,
    themes, summaries, unitThemes, extracts, entities, unitEntities, provenance, generatedAt,
    features: {
      clustering: clustered,
      additions: additions.size > 0,
      campaigns: campaigns.length > 0,
      triage: triage.size > 0,
      classified: classifications.size > 0,
      transcripts: transcripts.size > 0,
      condensed: condensed.size > 0,
      extracts: extracts.length > 0,
      reports: summaries.size > 0,
      groupReports: [...summaries.values()].some(s => s?.reportType === "group"),
      entities: entities.length > 0,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Schema: every CREATE carries its documentation, so `.schema` explains the database

function table(name: string, header: string[], cols: Array<[string, string]>): string {
  const width = Math.max(...cols.map(([d]) => d.length)) + 1;
  const body = cols.map(([def, doc], i) => {
    const d = i < cols.length - 1 ? `${def},` : def;
    return `  ${d.padEnd(width)} -- ${doc}`;
  });
  return `CREATE TABLE ${name} (\n${header.map(h => `  -- ${h}`.trimEnd()).join("\n")}\n${body.join("\n")}\n)`;
}

function view(name: string, header: string[], cols: Array<[string, string, string]>, from: string): string {
  const width = Math.max(...cols.map(([e, n]) => `${e} AS ${n}`.length)) + 1;
  const body = cols.map(([expr, n, doc], i) => {
    const d = `${expr === n ? n : `${expr} AS ${n}`}${i < cols.length - 1 ? "," : ""}`;
    return `  ${d.padEnd(width)} -- ${doc}`;
  });
  return `CREATE VIEW ${name} AS\n${header.map(h => `-- ${h}`.trimEnd()).join("\n")}\nSELECT\n${body.join("\n")}\n${from}`;
}

function schema(kind: PackKind, docketId: string): string[] {
  const full = kind === "full";
  const out: string[] = [];

  out.push(table("_readme", [
    `ANALYZED PUBLIC COMMENTS ON ${docketId} (${full ? "FULL" : "SLIM"} database). Read the rows of this table first:`,
    `  SELECT section, body FROM _readme ORDER BY ord;`,
    "",
    "What this is: every public comment submitted to regulations.gov on this docket, grouped into",
    "form letters and campaigns, summarized and organized by theme with LLMs (Gemini). See docket",
    "for the rule and the counts.",
    "",
    "Two counting units -- always say which one you report:",
    "  submissions = comments as filed (people). One row each in `submissions`.",
    "  units       = distinct pieces of content that were analyzed. A form letter sent 900 times is",
    "                ONE unit with units.submissions = 900. One row each in `units`.",
    "  Analysis (summaries, themes, extract_items, entities) is attached to units; weight by",
    "  units.submissions (or extract_items.submissions) to count people.",
    "",
    "Start with: docket, themes (+ theme_reports.markdown), units, submissions, extract_items,",
    "campaigns. Full-text search: extract_items_fts, summaries_fts, theme_reports_fts" + (full ? ", units_text_fts" : "") + " -- present",
    "only when docket.search_index = 'included'; otherwise create them with the statements in the",
    "_readme row section = 'enable_search' (SELECT body FROM _readme WHERE section = 'enable_search').",
    "",
    "Original vs LLM-generated: submitter metadata, dates, categories, submissions.typed_text,",
    "submissions.added_text and units.text WHERE text_source = 'typed' are the commenters' own words.",
    "Everything else written in prose is LLM output: units.text WHERE text_source = 'llm_transcript'",
    "(transcription of attached PDF/DOCX/scans), the condensed summary columns on units,",
    "extract_items, theme_reports, theme_report_items, campaign names/descriptions, triage labels.",
    "",
    "Caveats: form-letter members are represented by their group's representative (units.id) plus",
    "their own added text; campaign tags are automatic (hand-checked precision ~73-88%); brief",
    "comments triaged 'no_substance' were not analyzed; theme reports exist only for themes with",
    ">= 5 extracts; top-level themes with sub-themes get a 'group' report synthesized from them.",
  ], [
    ["ord INTEGER PRIMARY KEY", "reading order"],
    ["section TEXT NOT NULL", "short section name: overview, counting, tables, original_vs_llm, provenance, caveats, missing, enable_search, example_analyses, tips"],
    ["body TEXT NOT NULL", "the section text (markdown)"],
  ]));

  out.push(table("docket", [
    "One row: the regulatory proceeding these comments were filed on, and headline counts.",
  ], [
    ["id TEXT PRIMARY KEY", "docket ID, e.g. CMS-2026-2377 (comment IDs start with it)"],
    ["title TEXT", "title of the commented document (the rule), from regulations.gov"],
    ["agency TEXT", "agency name or ID"],
    ["document_type TEXT", "e.g. 'Proposed Rule'; NULL in some older databases"],
    ["comment_start TEXT", "comment period opened (ISO date-time); may be NULL"],
    ["comment_end TEXT", "comment period closed (ISO date-time); may be NULL"],
    ["regulations_gov_url TEXT", "the docket on regulations.gov"],
    ["dashboard_url TEXT", "interactive dashboard for this docket"],
    ["submission_count INTEGER", "comments as filed (= COUNT(*) FROM submissions)"],
    ["unit_count INTEGER", "distinct analyzed units (= COUNT(*) FROM units)"],
    ["form_letter_groups INTEGER", "units standing for 2+ identical/near-identical submissions"],
    ["campaign_count INTEGER", "organized campaigns tagged (0 when campaign tagging was not run)"],
    ["generated_at TEXT", "when the newest analysis result was produced (not the export time)"],
    ["export_code_hash TEXT", "hash of the export code; changes only when the export logic changes (not on every commit), so an unchanged docket re-exports byte-identically"],
    ["pack TEXT", "'slim' (no full text) or 'full'"],
    ["search_index TEXT", "'included' = the *_fts full-text tables exist; 'not_included' = run the statements in _readme section 'enable_search' first"],
  ]));

  out.push(table("submissions", [
    "One row per comment as filed on regulations.gov (one per person/organization submission,",
    "including every copy of a form letter). COUNT(*) here counts people, not distinct content.",
    "Content and analysis live on the unit: JOIN units u ON u.id = submissions.unit_id.",
  ], [
    ["id TEXT PRIMARY KEY", "regulations.gov comment ID, e.g. CMS-2026-2377-0042"],
    ["posted_date TEXT", "date regulations.gov posted it (ISO)"],
    ["received_date TEXT", "date the agency received it (ISO)"],
    ["submitter_name TEXT", "organization if given, else 'First Last', else a name given in the title, else 'Anonymous' (as entered; 'Anonymous Anonymous' becomes 'Anonymous')"],
    ["organization TEXT", "organization field as entered; NULL for most individuals"],
    ["filed_as TEXT", "how it was filed, from the name fields alone: 'organization' (organization field set) | 'person' (a name) | 'anonymous'"],
    ["category TEXT", "submitter category chosen on regulations.gov (raw, two vocabularies mixed); NULL when none was chosen"],
    ["category_group TEXT", "category folded to one plain vocabulary (e.g. 'Physician', 'Provider - Hospital'); 'Not specified' when none was chosen (a blank is not evidence of an individual)"],
    ["ai_speaks_for TEXT", "LLM (classify-submitters): who the submission speaks for, 'individual' | 'organization', judged from the form fields and the start and end of the text; NULL when not classified"],
    ["ai_type TEXT", "LLM: commenter type, a submitter_types.key (e.g. 'physician', 'hospital'); NULL when not classified"],
    ["ai_organization TEXT", "LLM: the organization it speaks for, when ai_speaks_for = 'organization'"],
    ["ai_method TEXT", "'llm' = classified from its own text; 'representative' = form-letter copy with its representative's organization, given the representative's classification; 'filed-category' = other form-letter copy whose own filed category names a role (physician, clinician, health care worker), typed by that role; 'template' = other form-letter copy typed by its template's voice (the representative's type when that is an individual type, else other_individual). Older databases may say 'form-letter-member' for either"],
    ["city TEXT", "as entered; often NULL"],
    ["state TEXT", "state/province as entered; often NULL (US state names are given as postal codes)"],
    ["country TEXT", "as entered"],
    ["unit_id TEXT NOT NULL", "the unit whose content stands for this submission (FK units.id); = id for representatives and individual comments"],
    ["is_unit_representative INTEGER", "1 if this submission is the one whose text was analyzed for its unit"],
    ["campaign_id INTEGER", "organized campaign it was tagged with (FK campaigns.id); NULL if none or not tagged"],
    ["campaign_how TEXT", "'exact' = copy of the campaign's form letter; 'paraphrase' = reworded letter judged part of it; NULL"],
    ["triage_label TEXT", "short ungrouped typed comments only: 'no_substance' | 'stance_only' | 'substantive' (LLM); NULL = not triaged"],
    ["triage_stance TEXT", "for stance_only: support / oppose / mixed / other (LLM)"],
    ["triage_topic TEXT", "for stance_only: what it is about, in a few words (LLM)"],
    ["has_attachments INTEGER", "1 if files were attached (see attachments)"],
    ["added_words INTEGER", "form-letter members: words they added beyond the group template (0/NULL = plain copy)"],
    ...(full ? [
      ["typed_text TEXT", "ORIGINAL comment-box text, HTML stripped, for submissions whose unit text is an LLM transcript. NULL when it would repeat units.text (text_source = 'typed') and for form-letter members (their box holds the group template: see added_text)"],
      ["added_text TEXT", "ORIGINAL words a form-letter member added to the template (NULL if none); promoted members keep it too"],
    ] as Array<[string, string]> : []),
    ["regulations_gov_url TEXT", "the comment on regulations.gov"],
  ]));

  out.push(table("submitter_types", [
    "The commenter types classify-submitters assigns (submissions.ai_type), the same for every docket.",
  ], [
    ["key TEXT PRIMARY KEY", "submissions.ai_type value"],
    ["grp TEXT NOT NULL", "'individual' | 'organization'"],
    ["label TEXT NOT NULL", "plain-language name shown on the dashboard"],
  ]));

  out.push(table("units", [
    "One row per distinct piece of content that was analyzed: a form-letter group (represented by",
    "one member), a member promoted out of a group because it added a lot of its own text, or an",
    "individual comment. id is the representative submission's ID. Weight counts by `submissions`.",
    "The condensed columns are LLM summaries (NULL when not condensed: triaged-out short comments,",
    "or older pipelines). Join submitter details via submissions s ON s.id = units.id.",
  ], [
    ["unit_no INTEGER PRIMARY KEY", "integer key used by the full-text indexes (no other meaning)"],
    ["id TEXT NOT NULL UNIQUE", "representative submission ID (FK submissions.id)"],
    ["kind TEXT NOT NULL", "'form_letter' (4+ copies) | 'near_copy' (2-3 near-identical copies) | 'promoted' (member split out of a form-letter group for its added text) | 'individual'"],
    ["submissions INTEGER NOT NULL", "how many submissions this unit stands for (1 for individual comments)"],
    ["promoted_from TEXT", "for kind='promoted': the unit (form letter) it was split out of"],
    ["word_count INTEGER", "words in the unit's full text"],
    ["one_line_summary TEXT", "LLM: one-sentence summary"],
    ["commenter_profile TEXT", "LLM: who the commenter is, role, stake (markdown bullets)"],
    ["core_position TEXT", "LLM: central argument"],
    ["key_recommendations TEXT", "LLM: specific asks (markdown bullets)"],
    ["main_concerns TEXT", "LLM: problems/risks raised (markdown bullets)"],
    ["notable_experiences TEXT", "LLM: experiences or evidence cited"],
    ["key_quotations TEXT", "LLM-selected quotations from the comment"],
    ...(full ? [
      ["text TEXT", "full content: verbatim comment-box text when text_source='typed', LLM transcription of comment + attachments when 'llm_transcript'; NULL if unavailable"],
      ["text_source TEXT", "'typed' = commenter's own words from the comment box; 'llm_transcript' = Gemini transcription of the comment and its attached PDF/DOCX/scan files"],
    ] as Array<[string, string]> : []),
  ]));

  out.push(table("themes", [
    "The theme taxonomy (LLM-built from a sample of comments): top-level issue areas ('3') and",
    "sub-themes ('3.2'). Content is filed under the most specific theme, so use the rolled-up counts",
    "for a top-level theme. Counts cover units with at least one extract in the theme or its sub-themes.",
  ], [
    ["code TEXT PRIMARY KEY", "theme code; '3.2' is a child of '3'"],
    ["parent_code TEXT", "parent theme code; NULL for top-level"],
    ["level INTEGER", "1 = top-level, 2 = sub-theme, ..."],
    ["label TEXT", "short name"],
    ["description TEXT", "longer description when the taxonomy has one beyond the label; else NULL"],
    ["guidelines TEXT", "LLM-written scope: what belongs in this theme (and what does not)"],
    ["submissions INTEGER", "submissions whose unit discusses this theme or a sub-theme (people)"],
    ["units INTEGER", "distinct units discussing this theme or a sub-theme"],
    ["direct_units INTEGER", "units filed directly under this exact code"],
    ["report_type TEXT", "'theme' = report from its extracts; 'group' = top-level report built from its sub-theme reports; NULL = no report (< 5 extracts)"],
  ]));

  out.push(table("unit_themes", [
    "Which units have extracted content under which theme (the most specific code). To count",
    "people per theme, join submissions on unit_id; for top-level rollups use",
    "theme_code = 'N' OR theme_code LIKE 'N.%' and count DISTINCT units/submissions.",
  ], [
    ["unit_id TEXT NOT NULL", "FK units.id"],
    ["theme_code TEXT NOT NULL", "FK themes.code"],
    ["PRIMARY KEY (unit_id, theme_code)", "one row per pair"],
  ]));

  out.push(table("extract_items", [
    "The core analysis: each point a unit made about a theme, extracted by an LLM (one row per",
    "point). Quotes (kind='quote') are meant to be verbatim but were selected by the LLM; check them",
    "against the full text before quoting. Weight by `submissions` to count people.",
  ], [
    ["id INTEGER PRIMARY KEY", "row key (also the extract_items_fts rowid)"],
    ["unit_id TEXT NOT NULL", "FK units.id (submitter: submissions WHERE id = unit_id)"],
    ["theme_code TEXT NOT NULL", "FK themes.code"],
    ["kind TEXT NOT NULL", "'position' | 'concern' | 'recommendation' | 'experience' | 'quote'"],
    ["ord INTEGER NOT NULL", "order within the unit's extract for this theme and kind"],
    ["text TEXT NOT NULL", "the point, as the LLM extracted it"],
    ["submissions INTEGER NOT NULL", "the unit's weight (copied from units.submissions for easy SUM)"],
  ]));

  out.push(table("theme_reports", [
    "LLM-written synthesis per theme (needs >= 5 extracts). markdown is the readable report; comment",
    "IDs cited in it are annotated with the submitter's name. Structured pieces: theme_report_items.",
  ], [
    ["report_no INTEGER PRIMARY KEY", "integer key used by theme_reports_fts (no other meaning)"],
    ["theme_code TEXT NOT NULL UNIQUE", "FK themes.code"],
    ["report_type TEXT NOT NULL", "'theme' or 'group' (top-level theme synthesized from its sub-theme reports)"],
    ["sub_themes TEXT", "group reports: comma-separated sub-theme codes it covers"],
    ["submissions INTEGER", "submissions the report covers (theme incl. sub-themes)"],
    ["units INTEGER", "distinct units the report covers"],
    ["executive_summary TEXT", "LLM: the report's summary paragraph"],
    ["markdown TEXT NOT NULL", "LLM: the whole report as markdown"],
  ]));

  out.push(table("theme_report_items", [
    "The theme reports' structured sections, one row per point, for filtering across themes.",
  ], [
    ["theme_code TEXT NOT NULL", "FK theme_reports.theme_code"],
    ["section TEXT NOT NULL", "'consensus' | 'debate' | 'debate_position' | 'stakeholder' | 'recommendation' | 'concern' | 'insight' | 'pattern' | 'quotation' | 'analytical_note'"],
    ["ord INTEGER NOT NULL", "order within the report"],
    ["heading TEXT", "debate topic (— position label), stakeholder type, recommendation approach, or concern name"],
    ["text TEXT NOT NULL", "LLM: the point"],
    ["support_level TEXT", "LLM's description of how widely it was held, e.g. 'Supported by 9 of 10 commenters'"],
    ["comment_ids TEXT", "JSON array of the unit IDs the LLM cited for it (FK units.id): json_each(comment_ids)"],
    ["PRIMARY KEY (theme_code, ord)", "one row per point"],
  ]));

  out.push(table("campaigns", [
    "Organized campaigns found by automatic tagging (tag-campaigns): exact form letters and reworded",
    "letters sharing a brief. Members: submissions WHERE campaign_id = campaigns.id. Empty when the",
    "step was not run. Hand-checked precision ~73-88%; the errors are same-topic independent letters.",
  ], [
    ["id INTEGER PRIMARY KEY", "campaign ID"],
    ["name TEXT NOT NULL", "LLM-written short name"],
    ["description TEXT", "LLM-written description of the shared ask"],
    ["method TEXT", "'form-letter' (exact copies only) | 'paraphrase' (includes reworded letters)"],
    ["evidence TEXT", "LLM judge's stated shared features"],
    ["submissions INTEGER", "submissions tagged with it"],
    ["exact_copies INTEGER", "of those, copies of a form letter"],
    ["paraphrased INTEGER", "of those, reworded letters"],
    ["units INTEGER", "distinct units among them"],
  ]));

  out.push(table("entities", [
    "Named organizations, programs, codes, standards etc. (LLM taxonomy; mentions found by term matching).",
  ], [
    ["id INTEGER PRIMARY KEY", "entity key"],
    ["category TEXT NOT NULL", "grouping, e.g. 'Government Bodies'"],
    ["label TEXT NOT NULL", "canonical name"],
    ["definition TEXT", "LLM: short definition"],
    ["terms TEXT", "JSON array of the search terms that were matched"],
    ["units INTEGER", "units mentioning it"],
    ["submissions INTEGER", "submissions whose unit mentions it"],
  ]));

  out.push(table("unit_entities", [
    "Which units mention which entity (term match on the unit's text).",
  ], [
    ["unit_id TEXT NOT NULL", "FK units.id"],
    ["entity_id INTEGER NOT NULL", "FK entities.id"],
    ["PRIMARY KEY (unit_id, entity_id)", "one row per pair"],
  ]));

  out.push(table("attachments", [
    "Files attached to submissions (metadata only; download from url). One row per file format.",
  ], [
    ["submission_id TEXT NOT NULL", "FK submissions.id"],
    ["attachment_id TEXT NOT NULL", "regulations.gov file ID"],
    ["format TEXT", "pdf, docx, ..."],
    ["file_name TEXT", "file name as stored"],
    ["url TEXT", "regulations.gov download URL"],
    ["size_bytes INTEGER", "file size"],
    ["PRIMARY KEY (submission_id, attachment_id, format)", "one row per file and format"],
  ]));

  out.push(view("v_submissions", [
    "Convenience: each submission with its unit's kind, weight and summary (one row per submission).",
  ], [
    ["s.id", "id", "submission ID"],
    ["s.posted_date", "posted_date", "date posted"],
    ["s.submitter_name", "submitter_name", "as entered"],
    ["s.organization", "organization", "as entered"],
    ["s.filed_as", "filed_as", "organization | person | anonymous"],
    ["s.category_group", "category_group", "normalized submitter category ('Not specified' when none chosen)"],
    ["s.ai_type", "ai_type", "LLM-assigned commenter type (submitter_types.key)"],
    ["s.ai_organization", "ai_organization", "LLM: organization it speaks for"],
    ["s.state", "state", "as entered"],
    ["s.unit_id", "unit_id", "unit whose content stands for it"],
    ["u.kind", "unit_kind", "form_letter | near_copy | promoted | individual"],
    ["u.submissions", "unit_submissions", "submissions sharing that unit (form-letter group size)"],
    ["s.campaign_id", "campaign_id", "FK campaigns.id"],
    ["c.name", "campaign_name", "LLM-written campaign name"],
    ["s.campaign_how", "campaign_how", "exact | paraphrase"],
    ["s.triage_label", "triage_label", "no_substance | stance_only | substantive | NULL"],
    ["u.one_line_summary", "one_line_summary", "LLM summary of the unit's content"],
  ], `FROM submissions s\nJOIN units u ON u.id = s.unit_id\nLEFT JOIN campaigns c ON c.id = s.campaign_id`));

  out.push(view("v_extract_points", [
    "Convenience: extract_items with theme label and the representative submitter (one row per point).",
  ], [
    ["e.id", "id", "FK extract_items.id"],
    ["e.theme_code", "theme_code", "FK themes.code"],
    ["t.label", "theme_label", "theme name"],
    ["e.kind", "kind", "position | concern | recommendation | experience | quote"],
    ["e.text", "text", "LLM-extracted point"],
    ["e.unit_id", "unit_id", "FK units.id"],
    ["e.submissions", "submissions", "submissions the unit stands for"],
    ["s.submitter_name", "submitter_name", "representative submission's submitter"],
    ["s.organization", "organization", "representative's organization"],
    ["s.category_group", "category_group", "representative's category"],
    ["s.ai_type", "ai_type", "representative's LLM-assigned commenter type"],
    ["s.ai_organization", "ai_organization", "representative's LLM-assigned organization"],
  ], `FROM extract_items e\nJOIN themes t ON t.code = e.theme_code\nJOIN submissions s ON s.id = e.unit_id`));

  out.push(
    "CREATE INDEX submissions_unit ON submissions(unit_id)",
    "CREATE INDEX submissions_campaign ON submissions(campaign_id)",
    "CREATE INDEX submissions_category ON submissions(category_group)",
    "CREATE INDEX submissions_ai_type ON submissions(ai_type)",
    "CREATE INDEX units_kind ON units(kind, submissions)",
    "CREATE INDEX themes_parent ON themes(parent_code)",
    "CREATE INDEX unit_themes_theme ON unit_themes(theme_code)",
    "CREATE INDEX extract_items_theme ON extract_items(theme_code, kind)",
    "CREATE INDEX extract_items_unit ON extract_items(unit_id)",
    "CREATE INDEX unit_entities_entity ON unit_entities(entity_id)",
  );
  return out;
}

// FTS5 indexes. Included in a file only while it stays within its size budget; otherwise the
// _readme's enable_search section carries these statements for the reader to run.
export function searchSchema(kind: PackKind): string[] {
  const full = kind === "full";
  const fts: string[] = [];
  fts.push(`CREATE VIRTUAL TABLE extract_items_fts USING fts5(
  -- Full-text index (porter stemming) over extract_items.text; rowid = extract_items.id.
  -- SELECT e.* FROM extract_items_fts f JOIN extract_items e ON e.id = f.rowid WHERE extract_items_fts MATCH '"prior authorization"';
  text, -- extract_items.text
  content='extract_items', content_rowid='id', tokenize='porter unicode61'
)`);
  fts.push(`CREATE VIRTUAL TABLE summaries_fts USING fts5(
  -- Full-text index over the units' condensed LLM summaries; rowid = units.unit_no.
  -- SELECT u.id, u.one_line_summary FROM summaries_fts f JOIN units u ON u.unit_no = f.rowid WHERE summaries_fts MATCH 'rural NEAR(access, 5)';
  one_line_summary,    -- units.one_line_summary
  commenter_profile,   -- units.commenter_profile
  core_position,       -- units.core_position
  key_recommendations, -- units.key_recommendations
  main_concerns,       -- units.main_concerns
  notable_experiences, -- units.notable_experiences
  key_quotations,      -- units.key_quotations
  content='units', content_rowid='unit_no', tokenize='porter unicode61'
)`);
  fts.push(`CREATE VIRTUAL TABLE theme_reports_fts USING fts5(
  -- Full-text index over the theme reports; rowid = theme_reports.report_no.
  -- SELECT r.theme_code, snippet(theme_reports_fts, 0, '[', ']', '…', 12) FROM theme_reports_fts f JOIN theme_reports r ON r.report_no = f.rowid WHERE theme_reports_fts MATCH 'telehealth';
  markdown, -- theme_reports.markdown
  content='theme_reports', content_rowid='report_no', tokenize='porter unicode61'
)`);
  if (full) fts.push(`CREATE VIRTUAL TABLE units_text_fts USING fts5(
  -- Full-text index over units.text (complete comment content); rowid = units.unit_no.
  -- SELECT u.id, snippet(units_text_fts, 0, '[', ']', '…', 16) FROM units_text_fts f JOIN units u ON u.unit_no = f.rowid WHERE units_text_fts MATCH 'NEAR("small practice" closure, 10)';
  text, -- units.text
  content='units', content_rowid='unit_no', tokenize='porter unicode61'
)`);

  return fts;
}
const ftsNames = (kind: PackKind) => ["extract_items_fts", "summaries_fts", "theme_reports_fts", ...(kind === "full" ? ["units_text_fts"] : [])];

// ---------------------------------------------------------------------------------------------
// README (the _readme rows; README.md in the zip is the same text)

function readmeSections(src: Source, kind: PackKind, docketUrl: string, dashboardUrl: string, counts: Record<string, number>, params: ExampleParams): Array<[string, string]> {
  const { info, features: f } = src;
  const full = kind === "full";
  const fmt = (n: number) => n.toLocaleString("en-US");
  const day = (s?: string) => (s ? s.slice(0, 10) : null);
  const period = info.commentStartDate || info.commentEndDate ? `Comment period: ${day(info.commentStartDate) || "?"} to ${day(info.commentEndDate) || "?"}.` : "";
  const sections: Array<[string, string]> = [];

  sections.push(["overview", [
    `# ${info.docketId}: analyzed public comments (${full ? "full" : "slim"} database)`,
    "",
    `**${info.title}**`,
    "",
    [`Agency: ${info.agency}.`, info.documentType ? `Document type: ${info.documentType}.` : "", period].filter(Boolean).join(" "),
    `Docket on regulations.gov: ${docketUrl}`,
    `Interactive dashboard: ${dashboardUrl}`,
    "",
    `This SQLite database holds the public comments filed on this docket and an LLM-assisted analysis of them: ` +
      `${fmt(counts.submissions)} submissions, analyzed as ${fmt(counts.units)} distinct units` +
      (f.clustering ? ` (${fmt(counts.groups)} form-letter / near-copy groups cover ${fmt(counts.grouped)} submissions)` : "") +
      (f.campaigns ? `; ${fmt(counts.campaigns)} organized campaigns tagged, covering ${fmt(counts.campaignSubmissions)} submissions` : "") +
      `; ${fmt(counts.themes)} themes, ${fmt(counts.reports)} theme reports, ${fmt(counts.extractItems)} extracted points` +
      (f.entities ? `, ${fmt(counts.entities)} named entities` : "") + ".",
    "",
    full
      ? "This is the FULL database: everything in the slim one plus the full text of every unit (typed comments verbatim, attachments as LLM transcripts), the comment-box text of submissions whose unit text is a transcript, and form-letter members' added text."
      : `This is the SLIM database: metadata, groups, campaigns, summaries, themes, reports and extracted points, without full comment text. The full text is in ${info.docketId}-full.sqlite.zip (same schema plus text columns).`,
    "",
    "Open it with any SQLite client (`sqlite3`, Python's sqlite3, DuckDB's sqlite extension, Datasette). `.schema` prints every table with its documentation.",
    "",
    SEARCH_PLACEHOLDER,
  ].join("\n")]);

  sections.push(["counting", [
    "## Two counting units",
    "",
    "- **Submissions** (`submissions`): comments as filed — one per person or organization, including every copy of a form letter. Use these to count people.",
    "- **Units** (`units`): distinct pieces of content that were analyzed. A form letter sent 900 times is one unit with `units.submissions = 900`; an individual comment is a unit with `submissions = 1`.",
    "",
    "All analysis (summaries, themes, extracted points, entities) is attached to units. To count people, weight by `units.submissions` (also copied onto `extract_items.submissions`) or join `submissions ON unit_id`. To count distinct arguments or documents, count units. Always say which you report.",
  ].join("\n")]);

  sections.push(["tables", [
    "## Tables",
    "",
    "- `docket` — the rule and headline counts (one row).",
    "- `submissions` — one row per comment as filed: submitter, how it was filed (`filed_as`), category (raw and normalized `category_group`), dates, location, its `unit_id`, campaign tag, triage label" + (f.classified ? ", and the LLM-assigned commenter type and organization (`ai_*`; labels in `submitter_types`)" : "") + (full ? ", original comment-box `typed_text` and form-letter `added_text`." : "."),
    "- `units` — one row per analyzed piece of content: kind (form_letter / near_copy / promoted / individual), weight (`submissions`), LLM condensed summary columns" + (full ? ", and the full `text` with its `text_source`." : "."),
    "- `themes` — the theme taxonomy with rolled-up counts (submissions and units). `unit_themes` links units to themes.",
    "- `extract_items` — each position / concern / recommendation / experience / quote a unit made about a theme. The most precise way to answer \"who argued what\".",
    "- `theme_reports` — readable LLM report per theme (`markdown`); `theme_report_items` — the same reports split into rows (consensus points, debates and positions, stakeholder views, recommendations, concerns, quotations), with cited comment IDs.",
    "- `campaigns` — organized campaigns; members are `submissions.campaign_id`.",
    "- `entities`, `unit_entities` — organizations, programs, codes and standards mentioned.",
    "- `attachments` — attached files' names and regulations.gov download URLs (no file contents).",
    "- Views `v_submissions` (submission + unit summary + campaign name) and `v_extract_points` (points with theme label and submitter).",
    "- Full-text search (FTS5, porter stemming): `extract_items_fts`, `summaries_fts`, `theme_reports_fts`" + (full ? ", `units_text_fts` (full text)" : "") + ". Present when `docket.search_index = 'included'`; otherwise see `enable_search`.",
  ].join("\n")]);

  sections.push(["original_vs_llm", [
    "## Original text vs LLM output",
    "",
    "Original (as submitted to regulations.gov): submitter names, organizations, categories, locations, dates" +
      (full ? ", `units.text` where `text_source = 'typed'`, `submissions.typed_text` (the comment box of submissions whose unit text is a transcript) and `submissions.added_text`." : "."),
    "",
    "LLM-generated (Gemini; treat as interpretation and check against the source):",
    full ? "- `units.text` where `text_source = 'llm_transcript'`: transcription of the comment plus its attached PDF/DOCX/scanned files. Usually faithful, but scans and tables can be misread." : "- (full database only) transcriptions of attached files.",
    "- `units` summary columns (`one_line_summary` … `key_quotations`): condensed summaries of each unit.",
    "- `extract_items`: theme-specific points; `kind = 'quote'` rows are meant to be verbatim but verify before quoting.",
    "- `themes` (taxonomy, labels, guidelines), `theme_reports`, `theme_report_items`: synthesized narrative; support levels are the LLM's wording, not counts — use the tables to count.",
    "- `campaigns` names/descriptions/evidence, campaign tags, and `triage_*` labels.",
    "- `submissions.ai_*` (when present): who each submission speaks for, its commenter type and organization, assigned by an LLM from the form fields and the start and end of the text. The filed fields (`organization`, `category`, `filed_as`) are kept unchanged beside them.",
    "- `entities` taxonomy (mentions are found by plain term matching).",
  ].join("\n")]);

  const steps: Record<string, string> = {
    triage: "label short ungrouped typed comments no_substance / stance_only / substantive",
    transcribe: "transcribe comments with attachments into markdown (typed-only comments kept verbatim)",
    "tag-campaigns": "embed units, cluster, and have an LLM judge which groups are organized campaigns",
    condense: "structured summary of each unit",
    "classify-submitters": "who each submission speaks for, commenter type and organization, from the form fields and the start and end of the text",
    "discover-themes": "build the theme taxonomy from a sample of units",
    "extract-theme-content": "extract each unit's points per theme",
    "summarize-themes": "write theme reports from the extracts; group reports for top-level themes",
    "discover-entities": "build an entity taxonomy; tag units by term matching",
  };
  sections.push(["provenance", [
    "## How it was produced",
    "",
    "Pipeline (github.com/jmandel/regulations.gov-comment-browser): load comments and attachments from regulations.gov → group identical and near-identical form letters by shared wording (no LLM) → triage → transcribe → match scanned copies to form letters → tag campaigns (optional) → condense → discover themes → extract theme content → summarize themes → discover entities → export.",
    "",
    "Models recorded in the analysis database, by step:",
    "",
    ...(src.provenance.length
      ? src.provenance.map(p => `- ${p.step}${steps[p.step] ? ` (${steps[p.step]})` : ""}: ${p.models}`)
      : ["- (not recorded in this database)"]),
    ...(src.provenance.some(p => p.step === "transcribe") || !f.transcripts ? [] : ["- transcribe: model not recorded in this database"]),
    "",
    `Analysis last updated: ${src.generatedAt ? `${src.generatedAt} UTC` : "unknown"}.`,
  ].join("\n")]);

  sections.push(["caveats", [
    "## Caveats",
    "",
    "- **Form letters.** Only one member of each form-letter group (the representative, `units.id`) was condensed and analyzed; the other members point to it through `submissions.unit_id`." +
      (f.additions ? " Text a member added to the template is in `submissions.added_text` (full database) and its length in `added_words`; members who added 300+ words were promoted to their own unit (`kind = 'promoted'`)." : " This database predates per-member added text, so members' own additions are not available."),
    "- **Unit kinds.** The pipeline does not record which clustering pass formed a group: groups of 4+ are labelled `form_letter`, groups of 2–3 `near_copy` (often the same sender submitting twice).",
    f.campaigns
      ? "- **Campaigns** are tagged automatically, including reworded (paraphrased) letters that share a brief. In a hand review of accepted campaigns, ~73% were clear campaigns and ~88% clear or plausible; the errors were same-topic independent letters. Recall for reworded letters is partial (personal stories with little shared wording are missed). Each submission is in at most one campaign."
      : "- **Campaigns** were not tagged for this docket (`campaigns` is empty); form-letter groups (`units.kind`) still show exact copying.",
    f.triage
      ? "- **Triage.** Short ungrouped typed comments (<80 words) were labelled by an LLM. `no_substance` ones were not condensed or analyzed; `stance_only` ones were not condensed but still count toward themes."
      : "- **Triage** was not run for this docket; all units were analyzed.",
    "- **Themes.** The taxonomy was built from a sample; extraction files each point under the most specific theme, so top-level counts in `themes` roll up their sub-themes. A unit usually appears under several themes.",
    "- **Reports** exist only for themes with at least 5 extracts (current pipeline)" + (f.groupReports ? "; top-level themes with sub-themes have a `group` report synthesized from the sub-theme reports plus direct extracts." : "."),
    "- **Counts in reports** (\"most commenters\", \"9 of 10\") are LLM wording over the units it read, not submissions; use SQL for numbers.",
    "- **Who commented.** Most submitters choose no category (`category_group = 'Not specified'`); a blank is not evidence of an individual. Chosen categories are often loose: many citizens pick 'Government - Federal' or 'Congressional' because they are writing to the government, and organizations sometimes file under a person's name or as 'Anonymous'." +
      (f.classified ? " `ai_type` / `ai_organization` correct much of this (on a hand-checked, population-weighted sample of 276 submissions from 9 dockets: individual-vs-organization right ~99.9%, type right ~98%), but they are LLM judgments; form-letter copies mostly inherit their representative's type (`ai_method`)." : ""),
    "- Some comments posted on regulations.gov may be missing (withdrawn or unavailable when loaded); attachment files that could not be read have no transcript.",
  ].join("\n")]);

  const missing: string[] = [];
  if (!f.clustering) missing.push("Form-letter clustering was not run (small docket): every submission is its own unit (`kind = 'individual'`).");
  if (f.clustering && !f.additions) missing.push("Per-member added text (`added_words`, `added_text`) is not available; `kind = 'promoted'` does not occur.");
  if (!f.campaigns) missing.push("Campaign tagging was not run: `campaigns` is empty and `submissions.campaign_id` is NULL.");
  if (!f.triage) missing.push("Triage was not run: `triage_*` columns are NULL.");
  if (!f.classified) missing.push("Submitter classification was not run: `submissions.ai_*` columns are NULL; use the filed `category_group` and `filed_as`.");
  if (!f.transcripts) missing.push(full ? "No separate transcription step: `units.text` for comments with attachments is the LLM's full-content rendering from the condense step when available, else only the typed comment." : "No separate transcription step was recorded.");
  if (!f.groupReports) missing.push("No group reports: top-level themes have reports only if built from their own extracts.");
  if (!f.entities) missing.push("Entity tagging was not run: `entities` is empty.");
  if (!f.reports) missing.push("No theme reports.");
  if (missing.length) sections.push(["missing", ["## Not available for this docket", "", ...missing.map(m => `- ${m}`)].join("\n")]);

  sections.push(["enable_search", [
    "## Enable full-text search",
    "",
    "Check `SELECT search_index FROM docket`. If it says `not_included`, run these statements once (they build the FTS5 indexes from the tables already in the file; seconds for most dockets, about a minute for the largest). If it says `included`, they already exist.",
    "",
    "```sql",
    ...searchSchema(kind).map(stmt => stmt + ";"),
    ...ftsNames(kind).map(t => `INSERT INTO ${t}(${t}) VALUES('rebuild');`),
    "```",
    "",
    "From Python: `db.executescript(db.execute(\"SELECT body FROM _readme WHERE section = 'enable_search'\").fetchone()[0].split('```sql')[1].split('```')[0]); db.commit()`.",
  ].join("\n")]);

  const examples = exampleAnalyses(params);
  sections.push(["example_analyses", [
    "## Example analyses",
    "",
    `Worked queries, filled in for this docket. Examples using \`*_fts\` tables need the search indexes (see \`enable_search\`). ${full ? "All run on this (full) database; where the slim database needs a different query, a slim variant follows." : "This is the slim database; a few examples have richer versions in the full database's README."}`,
    "",
    ...examples.flatMap((e, i) => {
      // The slim database gets the slim variant of full-only examples
      const sql = !full && e.fullOnly && e.slimSql ? e.slimSql : e.sql;
      const note = e.fullOnly ? (full ? " The slim database variant follows." : " (This is the slim-database version; the full database's version searches/checks the complete text.)") : "";
      return [
        `### ${i + 1}. ${e.title}`,
        "",
        `*${e.question}*${note}`,
        "",
        "```sql", sql.trim() + ";", "```",
        "",
        ...(full && e.slimSql ? ["Slim database variant:", "", "```sql", e.slimSql.trim() + ";", "```", ""] : []),
        `How to read it: ${!full && e.fullOnly && e.slimRead ? e.slimRead : e.read}`,
        "",
      ];
    }),
  ].join("\n").trim()]);

  sections.push(["tips", [
    "## Tips",
    "",
    ...ANALYSIS_TIPS.map(t => `- ${t}`),
  ].join("\n")]);

  return sections;
}

// ---------------------------------------------------------------------------------------------
// Writing

function themeLabel(description: string): { label: string; description: string | null } {
  const d = (description || "").trim();
  if (d.length <= 100) return { label: d, description: null };
  const m = d.match(/^(.{8,140}?[a-z0-9)])\.\s+(?=[A-Z])/);
  return m ? { label: m[1], description: d.slice(m[0].length).trim() || null } : { label: d, description: null };
}

// Values that make the worked examples concrete for this docket
function exampleParams(src: Source, rollUnits: Map<string, Set<string>>, labels: Map<string, string>,
  entUnits: Map<number, string[]>, weightOf: (s?: Set<string>) => number): ExampleParams {
  const byWeight = (codes: string[]) => codes
    .map(c => ({ c, w: weightOf(rollUnits.get(c)) }))
    .sort((a, b) => b.w - a.w || a.c.localeCompare(b.c, undefined, { numeric: true }))
    .map(x => x.c);
  const tops = byWeight(src.themes.filter(t => !t.parent_code).map(t => t.code));
  const top = tops[0] || src.themes[0]?.code || "1";
  const sub = byWeight(src.themes.filter(t => t.parent_code === top).map(t => t.code))[0] || top;

  // A characteristic topic: the entity most concentrated in the largest theme
  const inTop = rollUnits.get(top) || new Set<string>();
  let best: { score: number; e: Source["entities"][number] } | null = null;
  for (const e of src.entities) {
    const us = entUnits.get(e.id) || [];
    const nIn = us.filter(u => inTop.has(u)).length;
    if (nIn < 3) continue;
    const score = (nIn * nIn) / us.length;
    if (!best || score > best.score) best = { score, e };
  }
  let match = "", matchLabel = "";
  if (best) {
    let terms: string[] = [];
    try { terms = JSON.parse(best.e.terms); } catch {}
    const seen = new Set<string>();
    for (const t of [best.e.label, ...(Array.isArray(terms) ? terms : [])]) {
      const n = String(t).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
      if (!n || seen.has(n) || (!n.includes(" ") && n.length < 4)) continue;
      seen.add(n);
    }
    const list = [...seen].slice(0, 4);
    if (list.length) { match = list.map(t => `"${t}"`).join(" OR "); matchLabel = best.e.label; }
  }
  if (!match) {
    const word = (labels.get(top) || "").toLowerCase().match(/[a-z]{6,}/)?.[0] || "access";
    match = `${word}*`; matchLabel = `"${word}"`;
  }

  // An organization with a substantial comment: most theme extracts
  const extractsPer = new Map<string, number>();
  for (const e of src.extracts) extractsPer.set(e.unitId, (extractsPer.get(e.unitId) || 0) + 1);
  const subById = new Map(src.submissions.map(s => [s.id, s]));
  let org: string | null = null, orgN = 0;
  for (const [u, n] of [...extractsPer.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const o = subById.get(u)?.attrs.organization;
    if (o && typeof o === "string" && o.trim().length > 3 && n > orgN) { org = o; orgN = n; }
  }

  return {
    topTheme: top, topThemeLabel: labels.get(top) || top, subTheme: sub, subThemeLabel: labels.get(sub) || sub,
    match, matchLabel, pivotThemes: tops.slice(0, 6), organization: org, classified: src.features.classified,
  };
}

// Hash of the code that shapes the export, recorded instead of a git commit: a commit id would
// change every zip on every push, and publish-data-packs.sh re-uploads only zips whose bytes change
function exportCodeHash(): string {
  const files = ["dataset-pack.ts", "dataset-pack-examples.ts", "theme-report-markdown.ts", "document-meta.ts", "text.ts", "submitter-meta.ts"];
  const h = new Bun.CryptoHasher("sha256");
  for (const f of files) h.update(readFileSync(join(import.meta.dir, f)));
  return h.digest("hex").slice(0, 12);
}

function writeDatabase(path: string, src: Source, kind: PackKind, siteUrl: string): void {
  const full = kind === "full";
  const { info } = src;
  const out = new Database(path, { create: true });
  out.exec("PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA page_size = 4096;");
  for (const stmt of schema(kind, info.docketId)) out.exec(stmt);

  const docketUrl = `https://www.regulations.gov/docket/${info.docketId}`;
  const dashboardUrl = `${siteUrl.replace(/\/$/, "")}/${info.docketId}/`;
  const unitList = [...src.units.values()];
  const subsOf = (u: string) => src.units.get(u)?.weight ?? 1;

  // Theme rollups: units with an extract in the theme or any descendant
  const rollUnits = new Map<string, Set<string>>();
  for (const [code, set] of src.unitThemes) {
    const parts = code.split(".");
    for (let i = 1; i <= parts.length; i++) {
      const c = parts.slice(0, i).join(".");
      let s = rollUnits.get(c); if (!s) rollUnits.set(c, s = new Set());
      for (const u of set) s.add(u);
    }
  }
  const weightOf = (set?: Set<string>) => { let n = 0; for (const u of set ?? []) n += subsOf(u); return n; };
  const labels = new Map(src.themes.map(t => [t.code, themeLabel(t.description).label]));
  const nameOf = new Map<string, string>();
  for (const s of src.submissions) if (s.submitter !== "Anonymous") nameOf.set(s.id, s.submitter);

  let extractItems = 0;
  const tx = out.transaction(() => {
    // submissions
    const insSub = out.prepare(`INSERT INTO submissions (id, posted_date, received_date, submitter_name, organization, filed_as, category, category_group,
      ai_speaks_for, ai_type, ai_organization, ai_method,
      city, state, country, unit_id, is_unit_representative, campaign_id, campaign_how, triage_label, triage_stance, triage_topic,
      has_attachments, added_words, ${full ? "typed_text, added_text, " : ""}regulations_gov_url)
      VALUES (${Array(full ? 27 : 25).fill("?").join(", ")})`);
    for (const s of src.submissions) {
      const a = s.attrs;
      const add = src.additions.get(s.id);
      const camp = src.campaignOf.get(s.id);
      const tri = src.triage.get(s.id);
      const isMember = !s.isRep;
      const cls = src.classifications.get(s.id);
      const vals: any[] = [
        s.id, a.postedDate || null, a.receiveDate || null, s.submitter, a.organization || null, filedAs(a), a.category || null, foldCategory(a.category),
        cls?.speaksFor ?? null, cls?.type ?? null, cls?.organization ?? null, cls?.method ?? null,
        a.city || null, normalizeState(a.stateProvinceRegion), a.country || null, s.unitId, s.isRep ? 1 : 0, camp?.id ?? null, camp?.how ?? null,
        tri?.label ?? null, tri?.stance ?? null, tri?.topic ?? null,
        (src.attachmentCount.get(s.id) || 0) > 0 ? 1 : 0, add ? add.words : null,
      ];
      if (full) {
        const unit = src.units.get(s.id);
        vals.push(isMember || unit?.textSource === "typed" ? null : (htmlToText(String(a.comment || a.text || "")) || null));
        vals.push(add && add.words > 0 && add.text ? add.text : null);
      }
      vals.push(`https://www.regulations.gov/comment/${s.id}`);
      insSub.run(...vals);
    }

    // units
    const insUnit = out.prepare(`INSERT INTO units (unit_no, id, kind, submissions, promoted_from, word_count, one_line_summary, commenter_profile,
      core_position, key_recommendations, main_concerns, notable_experiences, key_quotations${full ? ", text, text_source" : ""})
      VALUES (${Array(full ? 15 : 13).fill("?").join(", ")})`);
    let n = 0;
    for (const u of unitList) {
      const sec = u.sections || {};
      const vals: any[] = [++n, u.id, u.kind, u.weight, u.promotedFrom, u.words,
        ...CONDENSED_FIELDS.map(([k]) => {
          const v = sec[k];
          if (v == null || v === "") return null;
          return typeof v === "string" ? v : Array.isArray(v) ? v.map(x => `- ${typeof x === "string" ? x : JSON.stringify(x)}`).join("\n") : JSON.stringify(v);
        })];
      if (full) vals.push(u.text, u.textSource);
      insUnit.run(...vals);
    }

    const insType = out.prepare(`INSERT INTO submitter_types VALUES (?, ?, ?)`);
    for (const t of SUBMITTER_TYPES) insType.run(t.key, t.group, t.label);

    // themes
    const insTheme = out.prepare(`INSERT INTO themes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const t of src.themes) {
      const { label, description } = themeLabel(t.description);
      const sum = src.summaries.get(t.code);
      insTheme.run(t.code, t.parent_code || null, t.level ?? t.code.split(".").length, label, description, t.detailed_guidelines || null,
        weightOf(rollUnits.get(t.code)), rollUnits.get(t.code)?.size || 0, src.unitThemes.get(t.code)?.size || 0,
        sum ? (sum.reportType === "group" ? "group" : "theme") : null);
    }
    const insUT = out.prepare(`INSERT INTO unit_themes VALUES (?, ?)`);
    const pairs: Array<[string, string]> = [];
    for (const [code, set] of src.unitThemes) for (const u of set) pairs.push([u, code]);
    pairs.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
    for (const p of pairs) insUT.run(...p);

    // extract items
    const insItem = out.prepare(`INSERT INTO extract_items VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const e of src.extracts) {
      if (!e.extract || typeof e.extract !== "object") continue;
      const byKind = new Map<string, string[]>();
      for (const [key, val] of Object.entries(e.extract)) {
        const kindName = EXTRACT_KINDS[key] || key.replace(/s$/, "");
        const list = (Array.isArray(val) ? val : val == null || val === "" ? [] : [val])
          .map((x: any) => (typeof x === "string" ? x : x && typeof x === "object" ? (x.text || x.quote || JSON.stringify(x)) : String(x)).trim())
          .filter(Boolean);
        if (list.length) byKind.set(kindName, [...(byKind.get(kindName) || []), ...list]);
      }
      const kinds = [...byKind.keys()].sort((a, b) => (EXTRACT_ORDER.indexOf(a) + 1 || 99) - (EXTRACT_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b));
      for (const k of kinds) byKind.get(k)!.forEach((text, i) => insItem.run(++extractItems, e.unitId, e.code, k, i + 1, text, subsOf(e.unitId)));
    }

    // theme reports
    const insReport = out.prepare(`INSERT INTO theme_reports VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    let reportNo = 0;
    const insItemRow = out.prepare(`INSERT INTO theme_report_items VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const [code, sections] of src.summaries) {
      if (!labels.has(code)) continue;
      const isGroup = sections?.reportType === "group";
      const subThemes = Array.isArray(sections?.subThemes) ? sections.subThemes.filter((c: any) => typeof c === "string") : [];
      const md = reportMarkdown({
        code, label: labels.get(code) || code, sections,
        submissions: weightOf(rollUnits.get(code)), units: rollUnits.get(code)?.size || 0,
        subThemes: subThemes.map((c: string) => ({ code: c, label: labels.get(c) || c })),
        nameOf: id => nameOf.get(id) ?? null,
      });
      const exec = typeof sections?.executiveSummary === "string" ? sections.executiveSummary : null;
      insReport.run(++reportNo, code, isGroup ? "group" : "theme", subThemes.length ? subThemes.join(",") : null,
        weightOf(rollUnits.get(code)), rollUnits.get(code)?.size || 0, exec, md);
      reportItems(sections).forEach((it, i) => insItemRow.run(code, it.section, i + 1, it.heading, it.text, it.supportLevel, it.commentIds.length ? JSON.stringify(it.commentIds) : null));
    }

    // campaigns: counts recomputed from the tags so they agree with submissions
    const campCounts = new Map<number, { total: number; exact: number; para: number; units: Set<string> }>();
    for (const s of src.submissions) {
      const c = src.campaignOf.get(s.id);
      if (!c) continue;
      let k = campCounts.get(c.id); if (!k) campCounts.set(c.id, k = { total: 0, exact: 0, para: 0, units: new Set() });
      k.total++; if (c.how === "paraphrase") k.para++; else k.exact++; k.units.add(s.unitId);
    }
    const insCamp = out.prepare(`INSERT INTO campaigns VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const c of src.campaigns) {
      const k = campCounts.get(c.id);
      insCamp.run(c.id, c.name, c.description, c.method, c.evidence, k?.total ?? c.total_count ?? 0, k?.exact ?? c.exact_count ?? 0, k?.para ?? c.paraphrase_count ?? 0, k?.units.size ?? c.unit_count ?? 0);
    }

    // entities
    const entUnits = new Map<number, string[]>();
    for (const [u, id] of src.unitEntities) { let a = entUnits.get(id); if (!a) entUnits.set(id, a = []); a.push(u); }
    const insEnt = out.prepare(`INSERT INTO entities VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const e of src.entities) {
      const us = entUnits.get(e.id) || [];
      insEnt.run(e.id, e.category, e.label, e.definition, e.terms, us.length, us.reduce((n, u) => n + subsOf(u), 0));
    }
    const insUE = out.prepare(`INSERT INTO unit_entities VALUES (?, ?)`);
    for (const p of src.unitEntities) insUE.run(...p);

    // attachments
    const insAtt = out.prepare(`INSERT OR IGNORE INTO attachments VALUES (?, ?, ?, ?, ?, ?)`);
    for (const a of src.attachments) insAtt.run(a.comment_id, a.id, a.format, a.file_name, a.url, a.size);

    // docket + readme
    const groups = unitList.filter(u => u.weight > 1);
    const counts = {
      submissions: src.submissions.length, units: unitList.length, groups: groups.length,
      grouped: groups.reduce((n, u) => n + u.weight, 0), campaigns: src.campaigns.length,
      campaignSubmissions: [...campCounts.values()].reduce((n, k) => n + k.total, 0),
      themes: src.themes.length, reports: src.summaries.size, extractItems, entities: src.entities.length,
    };
    out.prepare(`INSERT INTO docket VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`).run(
      info.docketId, info.title, info.agency, info.documentType ?? null, info.commentStartDate ?? null, info.commentEndDate ?? null,
      docketUrl, dashboardUrl, counts.submissions, counts.units, counts.groups, counts.campaigns, src.generatedAt, exportCodeHash(), kind);
    const insReadme = out.prepare(`INSERT INTO _readme VALUES (?, ?, ?)`);
    readmeSections(src, kind, docketUrl, dashboardUrl, counts, exampleParams(src, rollUnits, labels, entUnits, weightOf)).forEach(([section, body], i) => insReadme.run(i + 1, section, body));
  });
  tx();

  out.exec("ANALYZE");
  out.exec("VACUUM");
  out.close();
}

const SEARCH_INCLUDED = "Full-text search indexes (FTS5) are included in this file.";
const SEARCH_MISSING = "To keep this file small, the full-text search indexes (FTS5) are NOT included: run the statements in the `enable_search` section once (seconds to a minute) before using MATCH queries.";
const SEARCH_PLACEHOLDER = "{{SEARCH_STATUS}}";

// Add the FTS5 indexes to a finished database (or record that they're absent), then compact it
function finishDatabase(path: string, kind: PackKind, withSearch: boolean): string {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;");
  if (withSearch) {
    for (const stmt of searchSchema(kind)) db.exec(stmt);
    for (const t of ftsNames(kind)) {
      db.exec(`INSERT INTO ${t}(${t}) VALUES('rebuild')`);
      db.exec(`INSERT INTO ${t}(${t}) VALUES('optimize')`);
    }
  }
  const status = withSearch ? SEARCH_INCLUDED : SEARCH_MISSING;
  db.prepare(`UPDATE _readme SET body = replace(body, ?, ?)`).run(SEARCH_PLACEHOLDER, status);
  db.prepare(`UPDATE docket SET search_index = ?`).run(withSearch ? "included" : "not_included");
  db.exec("VACUUM");
  const readme = (db.prepare(`SELECT body FROM _readme ORDER BY ord`).all() as any[]).map(r => r.body).join("\n\n");
  db.close();
  return readme;
}

function zipAvailable(): boolean {
  try { return Bun.spawnSync(["zip", "-v"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0; } catch { return false; }
}

async function zipPack(dir: string, dbName: string, readme: string, zipPath: string): Promise<number> {
  await writeFile(join(dir, "README.md"), readme + "\n");
  for (const f of [dbName, "README.md"]) {
    await chmod(join(dir, f), 0o644);
    await utimes(join(dir, f), ZIP_MTIME, ZIP_MTIME);
  }
  await rm(zipPath, { force: true });
  // -X: no extra attributes (uid/gid, extended timestamps), so the zip depends only on content
  const r = Bun.spawnSync(["zip", "-X", "-q", zipPath, "README.md", dbName], { cwd: dir, env: { ...process.env, TZ: "UTC" }, stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`zip failed: ${r.stderr.toString()}`);
  return (await stat(zipPath)).size;
}

export async function buildDatasetPacks(db: Database, opts: { documentId: string; outputDir: string; siteUrl?: string }): Promise<PackFile[]> {
  if (!zipAvailable()) {
    console.warn("  ⚠️  `zip` not found; skipping downloadable databases (install zip, e.g. apt-get install zip)");
    return [];
  }
  const t0 = performance.now();
  const src = loadSource(db, opts.documentId);
  const docketId = src.info.docketId;
  const staging = resolve(await mkdtemp(join(tmpdir(), "dataset-pack-")));
  const files: PackFile[] = [];
  try {
    for (const kind of ["slim", "full"] as PackKind[]) {
      const dbName = `${docketId}-${kind}.sqlite`;
      const plainDir = join(staging, `${kind}-plain`), searchDir = join(staging, `${kind}-search`);
      await mkdir(plainDir, { recursive: true });
      await mkdir(searchDir, { recursive: true });
      writeDatabase(join(plainDir, dbName), src, kind, opts.siteUrl || DEFAULT_SITE_URL);
      await copyFile(join(plainDir, dbName), join(searchDir, dbName));

      // Without search indexes first; add them when the file stays within its budget
      const budget = SIZE_BUDGET[kind];
      let dir = plainDir;
      let zipPath = join(staging, `${kind}-plain.zip`);
      let bytes = await zipPack(plainDir, dbName, finishDatabase(join(plainDir, dbName), kind, false), zipPath);
      if (bytes * SEARCH_GROWTH <= budget) {
        const searchZip = join(staging, `${kind}-search.zip`);
        const searchBytes = await zipPack(searchDir, dbName, finishDatabase(join(searchDir, dbName), kind, true), searchZip);
        if (searchBytes <= budget) { dir = searchDir; zipPath = searchZip; bytes = searchBytes; }
      }
      const zipName = `${dbName}.zip`;
      const outPath = resolve(opts.outputDir, zipName);
      await rm(outPath, { force: true });
      await copyFile(zipPath, outPath);
      const sqliteBytes = (await stat(join(dir, dbName))).size;
      const sha256 = new Bun.CryptoHasher("sha256").update(await Bun.file(outPath).arrayBuffer()).digest("hex");
      files.push({ kind, file: zipName, bytes, sqliteBytes, sha256 });
      console.log(`  📦 ${zipName}: ${(bytes / 1e6).toFixed(1)} MB (database ${(sqliteBytes / 1e6).toFixed(1)} MB, search index ${dir === searchDir ? "included" : "not included"})`);
      if (bytes > MAX_PUBLISHED_BYTES && !packDownloadsBaseUrl()) console.warn(`  ⚠️  ${zipName} is over 100 MB; publish it as a release asset (DATA_DOWNLOADS_URL, scripts/publish-data-packs.sh) rather than inside the site`);
      await rm(plainDir, { recursive: true, force: true });
      await rm(searchDir, { recursive: true, force: true });
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  console.log(`  ✅ Downloadable databases built in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  return files;
}
