import { Command } from "commander";
import { openDb } from "../lib/database";
import { getTaskConfig, getTaskModel } from "../lib/batch-config";
import { runLlmRequests, type LlmRequest, type RunSummary } from "../lib/step-runner";
import { htmlToText } from "../lib/text";
import { buildClassifyPrompt, type ClassifyItem } from "../prompts/classify-submitters";
import { personName, titleSubmitter, SUBMITTER_TYPE_BY_KEY, filedRole } from "../lib/submitter-meta";

// Who each submission speaks for (an individual or an organization), the organization's name and a
// commenter type from a fixed taxonomy (SUBMITTER_TYPES), assigned by a cheap model from the filed
// metadata and the start and end of the text. Stored in submitter_classifications next to, never
// instead of, what the submitter filed.
//
// Which comments get a model call:
//   - every unit: form-letter representatives, promoted members and individual comments
//   - form-letter members that name an organization different from their representative's, or added
//     at least MEMBER_ADDED_WORDS of their own words (classified from their metadata and added text)
// Other form-letter members (their text is the group's template) are derived without a call:
//   - the same non-empty organization field as the representative → the representative's
//     classification (the organization sent its own letter more than once)
//   - otherwise an individual campaign participant, typed by the role their own filed category
//     names when it names one (filedRole), else by the template's type when the template speaks
//     as an individual, else other_individual
export const classifySubmittersCommand = new Command("classify-submitters")
  .description("Classify who each submission speaks for (individual or organization), the organization's name and a commenter type")
  .argument("<document-id>", "Document ID (e.g., CMS-2025-0050-0031)")
  .option("-l, --limit <n>", "Classify only N items (testing)", parseInt)
  .option("--force", "Re-classify comments that already have a classification")
  .option("-c, --concurrency <n>", "Number of parallel API calls", parseInt)
  .option("-m, --model <model>", "AI model to use (overrides config)")
  .option("--batch", "Use the Gemini Batch API (half price, slower)")
  .action(classifySubmitters);

const MEMBER_ADDED_WORDS = 40;
const HEAD_CHARS = 1000, TAIL_CHARS = 600;

const clean = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");

// The start and end of a text (letterhead, introduction, signature); short texts whole
export function excerpt(text: string): string {
  const t = text.replace(/\n{3,}/g, "\n\n").trim();
  if (t.length <= HEAD_CHARS + TAIL_CHARS + 200) return t;
  const head = t.slice(0, HEAD_CHARS).replace(/\s+\S*$/, "");
  const tail = t.slice(-TAIL_CHARS).replace(/^\S*\s+/, "");
  return `${head}\n[…]\n${tail}`;
}

export interface Classification { speaksFor: "individual" | "organization"; type: string; organization: string | null; }

export function parseClassifyResponse(text: string): Map<string, Classification> {
  const out = new Map<string, Classification>();
  let items: any[] = [];
  const body = text.replace(/```(?:json)?/g, "").trim();
  const start = body.indexOf("["), end = body.lastIndexOf("]");
  try {
    const parsed = JSON.parse(start >= 0 && end > start ? body.slice(start, end + 1) : body);
    items = Array.isArray(parsed) ? parsed : [];
  } catch {
    for (const m of body.matchAll(/\{[^{}]*\}/g)) { try { items.push(JSON.parse(m[0])); } catch {} }
  }
  for (const it of items) {
    if (!it || typeof it !== "object" || it.id == null) continue;
    const type = String(it.type || "").trim().toLowerCase();
    const def = SUBMITTER_TYPE_BY_KEY.get(type);
    if (!def) continue;
    // The type decides the side; speaks_for is asked for to make the model commit to it first
    const speaksFor = def.group as Classification["speaksFor"];
    const org = speaksFor === "organization" && typeof it.organization === "string" && it.organization.trim() && !/^(null|none|n\/a|unknown)$/i.test(it.organization.trim())
      ? it.organization.trim().slice(0, 200) : null;
    out.set(String(it.id).trim(), { speaksFor, type, organization: org });
  }
  return out;
}

export interface Row { id: string; attrs: any; rep: string | null; isMember: boolean; }

// The docket's submissions, which need a model call, and how to show each one to the model
export function prepareClassification(db: any) {
  const hasTable = (t: string) => !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t);
  const clustered = hasTable("comment_cluster_membership") && ((db.prepare(`SELECT COUNT(*) AS n FROM comment_cluster_membership`).get() as any).n > 0);
  const rows: Row[] = (db.prepare(`
    SELECT c.id, c.attributes_json, ${clustered ? "cc.representative_comment_id AS rep, m.is_representative AS is_rep" : "NULL AS rep, 1 AS is_rep"}
    FROM comments c
    ${clustered ? "LEFT JOIN comment_cluster_membership m ON m.comment_id = c.id LEFT JOIN comment_clusters cc ON cc.cluster_id = m.cluster_id" : ""}
    WHERE COALESCE(json_extract(c.attributes_json, '$.documentType'), 'Public Submission') = 'Public Submission'
    ORDER BY c.id`).all() as any[]).map(r => {
    let attrs: any = {};
    try { attrs = JSON.parse(r.attributes_json) || {}; } catch {}
    const isMember = !!r.rep && r.rep !== r.id && !r.is_rep;
    return { id: r.id, attrs, rep: isMember ? r.rep : null, isMember };
  });
  const byId = new Map(rows.map(r => [r.id, r]));

  const additions = new Map<string, { words: number; text: string }>();
  if (hasTable("form_letter_additions")) {
    for (const r of db.prepare(`SELECT comment_id, added_word_count, added_text FROM form_letter_additions WHERE promoted = 0`).all() as any[]) {
      additions.set(r.comment_id, { words: r.added_word_count || 0, text: r.added_text || "" });
    }
  }
  const sameOrg = (a: Row, b: Row | undefined) => !!b && !!clean(a.attrs.organization) && clean(a.attrs.organization).toLowerCase() === clean(b.attrs.organization).toLowerCase();
  const needsLlm = (r: Row) => !r.isMember
    || (!!clean(r.attrs.organization) && !sameOrg(r, byId.get(r.rep!)))
    || (additions.get(r.id)?.words || 0) >= MEMBER_ADDED_WORDS;

  // Unit text: transcript when there is one; older databases: the condense step's full-content
  // rendering for comments with attachments; else the typed comment
  const hasAttachment = new Set<string>(hasTable("attachments") ? (db.prepare(`SELECT DISTINCT comment_id FROM attachments`).all() as any[]).map(r => r.comment_id) : []);
  const getTranscript = hasTable("transcriptions") ? db.prepare(`SELECT markdown FROM transcriptions WHERE comment_id = ? AND status = 'completed'`) : null;
  const getLegacy = db.prepare(`SELECT json_extract(structured_sections, '$.detailedContent') AS t FROM condensed_comments WHERE comment_id = ?`);
  const item = (r: Row, id: string): ClassifyItem => {
    let text = "", note: string | null = null;
    if (r.isMember) {
      const add = additions.get(r.id);
      text = add?.text ? excerpt(add.text) : "";
      note = "copy of a form letter sent by many people; the text below is only what this sender added (empty if nothing)";
    } else {
      text = (getTranscript?.get(r.id) as any)?.markdown || "";
      if (!text && hasAttachment.has(r.id)) text = (getLegacy.get(r.id) as any)?.t || "";
      if (!text) text = htmlToText(String(r.attrs.comment || r.attrs.text || ""));
      text = excerpt(String(text));
    }
    return {
      id, name: personName(r.attrs) || null, organization: clean(r.attrs.organization) || null,
      category: clean(r.attrs.category) || null, title: titleSubmitter(r.attrs.title), note, text,
    };
  };
  // A form-letter member without its own call, from its representative's classification
  const derive = (r: Row, rep: Classification): Classification & { method: string } => {
    if (sameOrg(r, byId.get(r.rep!))) return { ...rep, method: "representative" };
    const role = filedRole(r.attrs.category);
    if (role) return { speaksFor: "individual", type: role, organization: null, method: "filed-category" };
    return { speaksFor: "individual", type: rep.speaksFor === "individual" ? rep.type : "other_individual", organization: null, method: "template" };
  };
  return { rows, byId, needsLlm, item, derive };
}

async function classifySubmitters(documentId: string, options: any) {
  const db = openDb(documentId);
  const model = getTaskModel("classifySubmitters", options.model);
  const taskConfig = getTaskConfig("classifySubmitters", options.model);
  const batchSize: number = taskConfig.thresholds?.batchSize ?? 30;
  const concurrency: number = options.concurrency || taskConfig.concurrency;
  const mode = options.batch ? "batch" : "live";
  console.log(`🪪 Classifying submitters for ${documentId} (model ${model}, ${batchSize} per request)`);

  const { rows, needsLlm, item, derive } = prepareClassification(db);
  const existing = new Set<string>(options.force ? [] : (db.prepare(`SELECT comment_id FROM submitter_classifications WHERE method = 'llm'`).all() as any[]).map(r => r.comment_id));
  let todo = rows.filter(r => needsLlm(r) && !existing.has(r.id));
  if (options.limit) todo = todo.slice(0, options.limit);

  const ruleTitle = (db.prepare("SELECT title FROM document_metadata LIMIT 1").get() as { title?: string } | null)?.title || null;
  const insert = db.prepare(`INSERT OR REPLACE INTO submitter_classifications (comment_id, speaks_for, type, organization, method, model) VALUES (?, ?, ?, ?, ?, ?)`);
  console.log(`🎯 ${todo.length} submissions to classify (${rows.length} in the docket${existing.size ? `, ${existing.size} already classified` : ""})`);

  const summaries: RunSummary[] = [];
  const done = new Set<string>();
  const runPass = async (items: Row[], size: number, pass: string) => {
    const batches = new Map<string, Row[]>();
    for (let i = 0; i < items.length; i += size) batches.set(`${pass}-${i / size}`, items.slice(i, i + size));
    const requests: LlmRequest[] = [...batches].map(([key, batch]) => ({
      key, model,
      parts: [{ text: buildClassifyPrompt(ruleTitle, batch.map((r, j) => item(r, `s${j + 1}`))) }],
      config: { responseMimeType: "application/json" },
    }));
    summaries.push(await runLlmRequests(requests, (req, res) => {
      const batch = batches.get(req.key)!;
      const parsed = parseClassifyResponse(res.text);
      if (parsed.size === 0) throw new Error(`no parsable classifications in response (${res.text.slice(0, 120)})`);
      db.transaction(() => batch.forEach((r, j) => {
        const c = parsed.get(`s${j + 1}`);
        if (!c) return;
        insert.run(r.id, c.speaksFor, c.type, c.organization, "llm", model);
        done.add(r.id);
      }))();
    }, { db, task: "classify-submitters", mode, concurrency, label: `classify-submitters-${pass}:${documentId}` }));
  };
  if (todo.length) {
    await runPass(todo, batchSize, "p1");
    const missing = todo.filter(r => !done.has(r.id));
    if (missing.length) {
      console.log(`🔁 ${missing.length} submissions missing from responses; retrying in smaller batches`);
      await runPass(missing, Math.max(5, Math.ceil(batchSize / 5)), "p2");
    }
  }

  // Form-letter members without their own call follow their representative (see the rule above)
  const llm = new Map<string, Classification>();
  for (const r of db.prepare(`SELECT comment_id, speaks_for, type, organization FROM submitter_classifications WHERE method = 'llm'`).all() as any[]) {
    llm.set(r.comment_id, { speaksFor: r.speaks_for, type: r.type, organization: r.organization });
  }
  let derived = 0;
  db.transaction(() => {
    for (const r of rows) {
      if (!r.isMember || llm.has(r.id)) continue;
      const rep = llm.get(r.rep!);
      if (!rep) continue;
      const d = derive(r, rep);
      insert.run(r.id, d.speaksFor, d.type, d.organization, d.method, null);
      derived++;
    }
  })();

  const cost = summaries.reduce((s, x) => s + x.costUsd, 0);
  const totals = db.prepare(`SELECT type, COUNT(*) AS n, SUM(method = 'llm') AS llm FROM submitter_classifications GROUP BY type ORDER BY n DESC`).all() as any[];
  const unclassified = rows.length - (db.prepare(`SELECT COUNT(*) AS n FROM submitter_classifications`).get() as any).n;
  console.log(`\n📊 ${done.size} classified by the model, ${derived} form-letter members derived${unclassified > 0 ? `, ${unclassified} left unclassified` : ""}`);
  for (const t of totals) console.log(`   ${t.type.padEnd(20)} ${String(t.n).padStart(7)}  (${t.llm} by model)`);
  console.log(`💰 ~$${cost.toFixed(3)}${mode === "batch" ? " (batch price)" : ""}`);
  db.close();
}
