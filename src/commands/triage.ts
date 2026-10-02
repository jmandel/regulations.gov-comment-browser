import { Command } from "commander";
import { openDb } from "../lib/database";
import { checkClusteringStatus } from "../lib/comment-processing";
import { getTaskConfig, getTaskModel } from "../lib/batch-config";
import { runLlmRequests, type LlmRequest, type RunSummary } from "../lib/step-runner";
import { htmlToText, wordCount } from "../lib/text";
import { buildTriagePrompt, TRIAGE_LABELS, type TriageLabel } from "../prompts/triage";

// Labels short typed comments so downstream steps can skip the empty ones:
//   no_substance → skipped by condense and theme extraction
//   stance_only  → skipped by condense; theme extraction reads the raw text
//   substantive  → processed normally (as are comments with no triage row)
export const triageCommand = new Command("triage")
  .description("Label short ungrouped typed comments as no_substance / stance_only / substantive")
  .argument("<document-id>", "Document ID (e.g., CMS-2025-0050-0031)")
  .option("-l, --limit <n>", "Triage only N candidates", parseInt)
  .option("--force", "Re-triage comments that already have a triage label")
  .option("-c, --concurrency <n>", "Number of parallel API calls", parseInt)
  .option("-m, --model <model>", "AI model to use (overrides config)")
  .option("--batch", "Use the Gemini Batch API (half price, slower)")
  .action(triageComments);

interface Candidate { id: string; text: string; }
interface TriageResult { label: TriageLabel; topic: string | null; stance: string | null; }

const STANCES = new Set(["support", "oppose", "mixed", "other"]);

// Parse the model's JSON array; falls back to picking out individual {...} objects if the
// array as a whole is malformed (e.g. truncated output)
function parseTriageResponse(text: string): Map<string, TriageResult> {
  const out = new Map<string, TriageResult>();
  let items: any[] = [];
  const body = text.replace(/```(?:json)?/g, "").trim();
  const start = body.indexOf("["), end = body.lastIndexOf("]");
  try {
    const parsed = JSON.parse(start >= 0 && end > start ? body.slice(start, end + 1) : body);
    items = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.results) ? parsed.results : [];
  } catch {
    for (const m of body.matchAll(/\{[^{}]*\}/g)) {
      try { items.push(JSON.parse(m[0])); } catch {}
    }
  }
  for (const it of items) {
    if (!it || typeof it !== "object" || it.id == null) continue;
    const label = String(it.label || "").trim().toLowerCase() as TriageLabel;
    if (!TRIAGE_LABELS.includes(label)) continue;
    const topic = typeof it.topic === "string" && it.topic.trim() && label !== "no_substance" ? it.topic.trim() : null;
    const stanceRaw = typeof it.stance === "string" ? it.stance.trim().toLowerCase() : "";
    const stance = label === "no_substance" ? null : STANCES.has(stanceRaw) ? stanceRaw : stanceRaw ? "other" : null;
    out.set(String(it.id).trim(), { label, topic, stance });
  }
  return out;
}

async function triageComments(documentId: string, options: any) {
  const db = openDb(documentId);
  const model = getTaskModel("triage", options.model);
  const taskConfig = getTaskConfig("triage", options.model);
  const maxWords: number = taskConfig.thresholds?.maxWords ?? 80;
  const batchSize: number = taskConfig.thresholds?.batchSize ?? 100;
  const concurrency: number = options.concurrency || taskConfig.concurrency;
  const mode = options.batch ? "batch" : "live";

  console.log(`🏷️  Triaging short comments for document ${documentId}`);
  console.log(`   Using model: ${model} (comments under ${maxWords} words, ${batchSize} per request)`);

  // Candidates: units that stand alone (singleton clusters, or every comment when the docket
  // wasn't clustered), typed only, and not a form-letter member promoted for its added text
  const clustered = checkClusteringStatus(db);
  const rows = db.prepare(`
    SELECT c.id, COALESCE(json_extract(c.attributes_json, '$.comment'), json_extract(c.attributes_json, '$.text')) AS comment
    FROM comments c
    ${clustered ? "JOIN comment_clusters cc ON cc.representative_comment_id = c.id AND cc.cluster_size = 1" : ""}
    WHERE NOT EXISTS (SELECT 1 FROM attachments a WHERE a.comment_id = c.id)
      AND NOT EXISTS (SELECT 1 FROM form_letter_additions f WHERE f.comment_id = c.id AND f.promoted = 1)
      ${options.force ? "" : "AND NOT EXISTS (SELECT 1 FROM comment_triage t WHERE t.comment_id = c.id)"}
    ORDER BY c.id
  `).all() as { id: string; comment: string | null }[];
  if (!clustered) console.log("   (no clustering data: considering every typed comment)");

  let candidates: Candidate[] = [];
  for (const r of rows) {
    const text = htmlToText(r.comment || "");
    if (wordCount(text) < maxWords) candidates.push({ id: r.id, text });
  }
  if (options.limit) candidates = candidates.slice(0, options.limit);
  console.log(`🎯 ${candidates.length} candidates`);
  if (candidates.length === 0) { db.close(); return; }

  const ruleTitle = (db.prepare("SELECT title FROM document_metadata LIMIT 1").get() as { title?: string } | null)?.title || null;
  const insert = db.prepare(`
    INSERT OR REPLACE INTO comment_triage (comment_id, label, topic, stance, model) VALUES (?, ?, ?, ?, ?)
  `);

  const results = new Map<string, TriageResult>();
  // Empty comment boxes need no model call
  for (const c of candidates) {
    if (!c.text) {
      results.set(c.id, { label: "no_substance", topic: null, stance: null });
      insert.run(c.id, "no_substance", null, null, "rule:empty");
    }
  }

  const summaries: RunSummary[] = [];
  const runPass = async (items: Candidate[], size: number, pass: string) => {
    const batches = new Map<string, Candidate[]>();
    for (let i = 0; i < items.length; i += size) {
      batches.set(`${pass}-${i / size}`, items.slice(i, i + size));
    }
    const requests: LlmRequest[] = [...batches].map(([key, batch]) => ({
      key,
      model,
      // Short local ids: models copy "c17" more reliably than long docket-prefixed ids
      parts: [{ text: buildTriagePrompt(ruleTitle, batch.map((c, j) => ({ id: `c${j + 1}`, text: c.text }))) }],
      config: { responseMimeType: "application/json" },
    }));
    summaries.push(await runLlmRequests(requests, (req, res) => {
      const batch = batches.get(req.key)!;
      const parsed = parseTriageResponse(res.text);
      if (parsed.size === 0) throw new Error(`no parsable triage results in response (${res.text.slice(0, 120)})`);
      batch.forEach((c, j) => {
        const r = parsed.get(`c${j + 1}`);
        if (!r) return;
        results.set(c.id, r);
        insert.run(c.id, r.label, r.topic, r.stance, model);
      });
    }, { db, task: "triage", mode, concurrency, label: `triage-${pass}:${documentId}` }));
  };

  const toSend = candidates.filter(c => c.text);
  await runPass(toSend, batchSize, "p1");
  const missing = toSend.filter(c => !results.has(c.id));
  if (missing.length > 0) {
    console.log(`🔁 ${missing.length} comments missing from responses; retrying in smaller batches`);
    await runPass(missing, Math.max(5, Math.ceil(batchSize / 5)), "p2");
  }
  const untriaged = toSend.filter(c => !results.has(c.id)).length;

  // Summary
  const byLabel = new Map<TriageLabel, Candidate[]>();
  for (const c of candidates) {
    const r = results.get(c.id);
    if (!r) continue;
    if (!byLabel.has(r.label)) byLabel.set(r.label, []);
    byLabel.get(r.label)!.push(c);
  }
  console.log(`\n📊 Triage results (${results.size}/${candidates.length} labeled, ${untriaged} left untriaged → processed normally):`);
  for (const label of TRIAGE_LABELS) {
    const list = byLabel.get(label) || [];
    console.log(`\n  ${label}: ${list.length}`);
    for (const c of list.slice(0, 4)) {
      const r = results.get(c.id)!;
      const tag = r.topic ? ` [${r.stance ?? "?"}: ${r.topic}]` : "";
      console.log(`    ${c.id}${tag}: ${c.text.replace(/\s+/g, " ").slice(0, 140)}`);
    }
  }
  const cost = summaries.reduce((s, x) => s + x.costUsd, 0);
  const tokIn = summaries.reduce((s, x) => s + x.usage.input, 0);
  const tokOut = summaries.reduce((s, x) => s + x.usage.output + x.usage.thoughts, 0);
  console.log(`\n💰 tokens in=${tokIn} out=${tokOut} | ~$${cost.toFixed(3)}${mode === "batch" ? " (batch price)" : ""}`);

  const totals = db.prepare("SELECT label, COUNT(*) AS n FROM comment_triage GROUP BY label").all() as { label: string; n: number }[];
  console.log(`📈 comment_triage totals: ${totals.map(t => `${t.label}=${t.n}`).join(", ")}`);
  db.close();
}
