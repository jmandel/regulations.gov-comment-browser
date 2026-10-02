import { Command } from "commander";
import type { Database } from "bun:sqlite";
import { openDb } from "../lib/database";
import { checkClusteringStatus } from "../lib/comment-processing";
import { getTaskConfig, getTaskRoleModel } from "../lib/batch-config";
import { runLlmRequests, type LlmRequest, type RunSummary } from "../lib/step-runner";
import { embedTexts, DEFAULT_EMBEDDING_MODEL } from "../lib/embeddings";
import { htmlToText, wordCount } from "../lib/text";
import { buildCampaignJudgePrompt, buildFormLetterNamingPrompt, buildCampaignMergePrompt, buildCampaignExpandPrompt } from "../prompts/campaigns";

// Tags comments that belong to organized comment campaigns, including *paraphrased* campaigns
// (senders given a brief or talking points, often AI-personalized) that text-overlap clustering
// can't see. Tags only: form-letter clusters and analysis units are left untouched.
//
//   1. Units = form-letter cluster representatives and ungrouped comments (≥40 words), text =
//      typed comment + attachment text, first 1,500 words. Embedded with gemini-embedding-2
//      (cached in comment_embeddings).
//   2. Candidate groups: average-linkage clustering of the embeddings, cut at `levels[0]` cosine
//      (groups of ≥ minUnits units).
//   3. An LLM judge reads a spread of each group's letters and says campaign / mixed / same_topic.
//      Rejected or mixed groups are split at the next (tighter) level and the parts re-judged.
//   4. Accepted groups become campaigns, as do form-letter groups of ≥ minExact members that no
//      accepted group contains (named by the LLM).
//   5. Merge: campaigns whose centroids are close (average linkage at mergeLevel) are shown to the
//      LLM together, which says which are really one campaign (e.g. a form letter and its reworded
//      versions, or one brief split by sender type).
//   6. Expand: unassigned units with ≥ expandMinNeighbors members of one campaign at ≥ expandLevel
//      cosine are checked against that campaign by the LLM, in batches.
//   7. Tags: a form-letter representative in a campaign brings its whole exact-copy group (and members
//      promoted out of it) as how = 'exact'; other units are 'paraphrase'.
export const tagCampaignsCommand = new Command("tag-campaigns")
  .description("Detect organized comment campaigns, including paraphrased ones, and tag their comments")
  .argument("<document-id>", "Document ID (e.g., CMS-2026-2377-0002)")
  .option("--levels <list>", "Comma-separated cosine cut levels, loosest first (default from config: 0.92,0.94,0.96)")
  .option("--min-units <n>", "Minimum distinct units for a paraphrase campaign", parseInt)
  .option("--min-exact <n>", "Form-letter groups at least this large become campaigns on their own", parseInt)
  .option("-c, --concurrency <n>", "Number of parallel API calls", parseInt)
  .option("-m, --model <model>", "AI model for judging and naming (overrides config)")
  .option("--batch", "Use the Gemini Batch API (half price, slower)")
  .option("--report <file>", "Write every judged group (verdicts, evidence, sample ids) to a JSON file")
  .action(tagCampaigns);

interface Unit {
  id: string;            // representative comment id
  clusterId: number | null;
  size: number;          // comments the unit stands for
  text: string;          // embedded text
}

const MIN_WORDS = 40;          // ungrouped comments shorter than this aren't considered
const MIN_WORDS_REP = 10;      // form-letter representatives: short form letters still anchor campaigns
const MAX_WORDS = 1500;
const JUDGE_WORDS = 300;
const JUDGE_SAMPLE = 10;
const BRIEF_WORDS = 150;       // excerpt length in merge/expand prompts
const MERGE_CHUNK = 25;        // campaigns per merge call
const EXPAND_BATCH = 12;       // candidates per expansion call

function truncateWords(s: string, n: number): string {
  const w = s.split(/\s+/).filter(Boolean);
  return w.length <= n ? w.join(" ") : w.slice(0, n).join(" ") + " …";
}

// "See attached" boxes add nothing; keep the typed text only when it says something
// Scans have no extracted attachment text; their transcript (when transcription has run) stands in
function commentText(comment: string | null, attachments: string | null, transcript?: string | null): string {
  const typed = htmlToText(comment || "");
  const att = (attachments || "").trim() || (transcript || "").trim();
  return att ? (wordCount(typed) >= 15 ? `${typed}\n\n${att}` : att) : typed;
}

// Transcript of a comment that has attachments but no extracted attachment text (a scan)
const scanTranscripts = `(SELECT t.markdown FROM transcriptions t WHERE t.comment_id = c.id AND t.status = 'completed'
           AND EXISTS (SELECT 1 FROM attachments a WHERE a.comment_id = c.id)
           AND NOT EXISTS (SELECT 1 FROM attachment_text x WHERE x.comment_id = c.id AND x.text <> '')) AS transcript`;

function loadUnits(db: Database): { units: Unit[]; clustered: boolean } {
  const clustered = checkClusteringStatus(db);
  const rows = db.prepare(clustered ? `
    SELECT cc.representative_comment_id AS id, cc.cluster_id, cc.cluster_size AS size,
           json_extract(c.attributes_json, '$.comment') AS comment,
           (SELECT group_concat(text, char(10)) FROM attachment_text a WHERE a.comment_id = c.id) AS att,
           ${scanTranscripts}
    FROM comment_clusters cc JOIN comments c ON c.id = cc.representative_comment_id
  ` : `
    SELECT c.id, NULL AS cluster_id, 1 AS size, json_extract(c.attributes_json, '$.comment') AS comment,
           (SELECT group_concat(text, char(10)) FROM attachment_text a WHERE a.comment_id = c.id) AS att,
           ${scanTranscripts}
    FROM comments c
  `).all() as { id: string; cluster_id: number | null; size: number; comment: string | null; att: string | null; transcript: string | null }[];
  const units: Unit[] = [];
  for (const r of rows) {
    const text = commentText(r.comment, r.att, r.transcript);
    if (wordCount(text) < (r.size > 1 ? MIN_WORDS_REP : MIN_WORDS)) continue;
    units.push({ id: r.id, clusterId: r.cluster_id, size: r.size, text: truncateWords(text, MAX_WORDS).replace(/ …$/, "") });
  }
  units.sort((a, b) => a.id < b.id ? -1 : 1);
  return { units, clustered };
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

class UnionFind {
  p: Int32Array;
  constructor(n: number) { this.p = new Int32Array(n).map((_, i) => i); }
  find(x: number): number { while (this.p[x] !== x) { this.p[x] = this.p[this.p[x]]; x = this.p[x]; } return x; }
  union(a: number, b: number) { a = this.find(a); b = this.find(b); if (a !== b) this.p[b] = a; }
}

// Average-linkage merges (NN-chain) within one connected component, stopping below `floor`.
// Returns merges as [itemA, itemB, similarity] in item indices of `members`.
function averageLinkage(vecs: Float32Array[], members: number[], floor: number): [number, number, number][] {
  const k = members.length;
  const M = new Float64Array(k * k);
  for (let i = 0; i < k; i++) {
    for (let j = i + 1; j < k; j++) {
      const s = dot(vecs[members[i]], vecs[members[j]]);
      M[i * k + j] = s; M[j * k + i] = s;
    }
  }
  const size = new Int32Array(k).fill(1);
  const active = new Uint8Array(k).fill(1);
  let remaining = k;
  const merges: [number, number, number][] = [];
  const chain: number[] = [];
  let next = 0;
  while (remaining > 1) {
    if (chain.length === 0) {
      while (next < k && !active[next]) next++;
      if (next >= k) break;
      chain.push(next);
    }
    const a = chain[chain.length - 1];
    const prev = chain.length > 1 ? chain[chain.length - 2] : -1;
    let best = -1, bestSim = -Infinity;
    for (let j = 0; j < k; j++) {
      if (j === a || !active[j]) continue;
      const s = M[a * k + j];
      if (s > bestSim || (s === bestSim && j === prev)) { bestSim = s; best = j; }
    }
    if (best < 0 || bestSim < floor) {
      // Nothing can ever merge with `a` at or above the floor (average of values below it stays below)
      active[a] = 0; remaining--; chain.length = 0;
      continue;
    }
    if (best === prev) {
      chain.pop(); chain.pop();
      merges.push([members[a], members[best], bestSim]);
      const na = size[a], nb = size[best];
      for (let j = 0; j < k; j++) {
        if (!active[j] || j === a || j === best) continue;
        const s = (na * M[a * k + j] + nb * M[best * k + j]) / (na + nb);
        M[a * k + j] = s; M[j * k + a] = s;
      }
      size[a] = na + nb;
      active[best] = 0; remaining--;
    } else {
      chain.push(best);
    }
  }
  return merges;
}

// Groups of items at cut level t (merges with similarity ≥ t), restricted to `subset`
function cut(merges: [number, number, number][], uf: UnionFind, subset: number[], t: number): number[][] {
  const inSet = new Set(subset);
  for (const i of subset) uf.p[i] = i;
  for (const [a, b, s] of merges) if (s >= t && inSet.has(a) && inSet.has(b)) uf.union(a, b);
  const groups = new Map<number, number[]>();
  for (const i of subset) {
    const r = uf.find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(i);
  }
  return [...groups.values()];
}

function centroid(vecs: Float32Array[], idx: number[]): Float32Array {
  const c = new Float32Array(vecs[idx[0]].length);
  for (const i of idx) { const v = vecs[i]; for (let d = 0; d < c.length; d++) c[d] += v[d]; }
  let n = 0;
  for (let d = 0; d < c.length; d++) n += c[d] * c[d];
  n = Math.sqrt(n) || 1;
  for (let d = 0; d < c.length; d++) c[d] /= n;
  return c;
}

interface Judged {
  level: number;
  units: number[];          // unit indices
  sample: number[];         // unit indices shown to the judge, in letter order
  verdict: string;
  members: number[];        // letter numbers the judge said follow the template
  evidence: string;
  name: string | null;
  description: string | null;
}

function parseJson(text: string): any {
  let body = text.replace(/```(?:json)?/g, "").trim();
  try { return JSON.parse(body); } catch {}
  body = body.replace(/\\(?!["\\/bfnrtu])/g, ""); // stray escapes like \'
  try { return JSON.parse(body); } catch {}
  const s = body.search(/[\[{]/), e = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
  return JSON.parse(body.slice(s, e + 1));
}

async function tagCampaigns(documentId: string, options: any) {
  const db = openDb(documentId);
  const cfg = getTaskConfig("tagCampaigns", options.model);
  const th = cfg.thresholds || {};
  const levels: number[] = (options.levels ? String(options.levels).split(",").map(Number) : th.levels) ?? [0.92, 0.94, 0.96];
  const minUnits: number = options.minUnits ?? th.minUnits ?? 4;
  const minExact: number = options.minExact ?? th.minExact ?? 10;
  const mergeLevel: number = th.mergeLevel ?? 0.95;
  const expandLevel: number = th.expandLevel ?? 0.92;
  const expandMinNeighbors: number = th.expandMinNeighbors ?? 2;
  const embeddingModel: string = th.embeddingModel ?? DEFAULT_EMBEDDING_MODEL;
  const judgeModel = getTaskRoleModel("tagCampaigns", "judge", options.model);
  const nameModel = getTaskRoleModel("tagCampaigns", "name", options.model);
  const concurrency: number = options.concurrency || cfg.concurrency || 10;
  const mode = options.batch ? "batch" : "live";
  const ruleTitle = (db.prepare("SELECT title FROM document_metadata LIMIT 1").get() as { title?: string } | null)?.title || null;

  console.log(`📣 Tagging comment campaigns for ${documentId}`);
  console.log(`   levels ${levels.join(" → ")}, ≥${minUnits} units per paraphrase campaign, form-letter groups ≥${minExact} on their own; judge ${judgeModel}`);

  // 1. Units and embeddings
  const { units, clustered } = loadUnits(db);
  if (!clustered) console.log("   (no clustering data: every comment is its own unit)");
  console.log(`🧩 ${units.length} units (ungrouped comments ≥${MIN_WORDS} words, form-letter representatives ≥${MIN_WORDS_REP})`);
  const t0 = Date.now();
  const { vectors, summary: es } = await embedTexts(db, units.map(u => ({ id: u.id, text: u.text })), { model: embeddingModel, concurrency });
  console.log(`   embeddings: ${es.cached} cached, ${es.embedded} new, ${es.failed} failed (~${es.approxTokens} tokens, ~$${es.costUsd.toFixed(2)})`);
  const keep = units.filter(u => vectors.has(u.id));
  const vecs = keep.map(u => vectors.get(u.id)!);
  const n = keep.length;

  // 2. Pairs above the loosest level → connected components → average linkage per component
  const floor = levels[0];
  const uf = new UnionFind(n);
  for (let i = 0; i < n; i++) {
    const a = vecs[i];
    for (let j = i + 1; j < n; j++) if (dot(a, vecs[j]) >= floor) uf.union(i, j);
  }
  console.log(`   similarity graph: ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  const comps = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = uf.find(i);
    if (!comps.has(r)) comps.set(r, []);
    comps.get(r)!.push(i);
  }
  const merges: [number, number, number][] = [];
  for (const members of comps.values()) {
    if (members.length >= minUnits) merges.push(...averageLinkage(vecs, members, floor));
  }
  console.log(`   similarity graph and linkage: ${((Date.now() - t0) / 1000).toFixed(0)}s, ${[...comps.values()].filter(c => c.length >= minUnits).length} components ≥${minUnits}`);

  // 3. Judge level by level, splitting rejected groups at the next level
  const judged: Judged[] = [];
  const accepted: Judged[] = [];
  const summaries: RunSummary[] = [];
  const cutUf = new UnionFind(n);
  let pending = cut(merges, cutUf, [...Array(n).keys()], levels[0]).filter(g => g.length >= minUnits);
  for (let li = 0; li < levels.length && pending.length > 0; li++) {
    const groups = new Map<string, { units: number[]; sample: number[] }>();
    pending.forEach((g, gi) => {
      // Sample spread from most to least typical, so the judge sees the group's fringe too
      const c = centroid(vecs, g);
      const order = [...g].sort((x, y) => dot(vecs[y], c) - dot(vecs[x], c));
      const sample = order.length <= JUDGE_SAMPLE ? order
        : Array.from({ length: JUDGE_SAMPLE }, (_, k) => order[Math.round(k * (order.length - 1) / (JUDGE_SAMPLE - 1))]);
      groups.set(`L${li}-${gi}`, { units: g, sample });
    });
    console.log(`\n⚖️  Level ${levels[li]}: judging ${groups.size} groups (${pending.reduce((s, g) => s + g.length, 0)} units)`);
    const requests: LlmRequest[] = [...groups].map(([key, g]) => ({
      key, model: judgeModel,
      parts: [{ text: buildCampaignJudgePrompt(ruleTitle, g.sample.map(i => truncateWords(keep[i].text, JUDGE_WORDS)), g.units.length) }],
      config: { responseMimeType: "application/json" },
    }));
    const next: number[][] = [];
    summaries.push(await runLlmRequests(requests, (req, res) => {
      const g = groups.get(req.key)!;
      const r = parseJson(res.text);
      const verdict = String(r.verdict || "").toLowerCase();
      if (!["campaign", "mixed", "same_topic"].includes(verdict)) throw new Error(`bad verdict ${r.verdict}`);
      const j: Judged = {
        level: levels[li], units: g.units, sample: g.sample, verdict,
        members: Array.isArray(r.members) ? r.members.map(Number).filter((x: number) => x >= 1 && x <= g.sample.length) : [],
        evidence: String(r.evidence || ""), name: r.name || null, description: r.description || null,
      };
      judged.push(j);
      if (verdict === "campaign" && j.name) accepted.push(j);
      else if (li + 1 < levels.length) {
        next.push(...cut(merges, cutUf, g.units, levels[li + 1]).filter(s => s.length >= minUnits));
      }
    }, { db, task: "tag-campaigns", mode, concurrency, label: `tag-campaigns-L${li}:${documentId}` }));
    const acc = judged.filter(j => j.level === levels[li] && j.verdict === "campaign").length;
    console.log(`   campaign ${acc}, mixed ${judged.filter(j => j.level === levels[li] && j.verdict === "mixed").length}, same_topic ${judged.filter(j => j.level === levels[li] && j.verdict === "same_topic").length}`);
    pending = next;
  }

  // 4. Campaigns: accepted groups, plus large form-letter groups that no accepted group contains
  interface Camp {
    units: number[];                  // unit indices (into keep)
    extraClusters: number[];          // form-letter groups whose representative has no embedding
    name: string; description: string | null; evidence: string | null; level: number | null;
    method: "paraphrase" | "form-letter";
    expanded: number;                 // units added by the expansion pass
  }
  const unitOf = new Map(keep.map((u, i) => [u.id, i]));
  const camps: Camp[] = accepted.map(j => ({
    units: j.units, extraClusters: [], name: j.name!, description: j.description, evidence: j.evidence, level: j.level,
    method: "paraphrase", expanded: 0,
  }));
  const claimedUnits = new Set(accepted.flatMap(j => j.units));
  let exactOnly = clustered ? (db.prepare(`
    SELECT cluster_id, representative_comment_id AS id, cluster_size AS size FROM comment_clusters
    WHERE cluster_size >= ? ORDER BY cluster_size DESC
  `).all(minExact) as { cluster_id: number; id: string; size: number }[]).filter(g => !claimedUnits.has(unitOf.get(g.id) ?? -1)) : [];
  const getText = db.prepare(`SELECT json_extract(attributes_json, '$.comment') AS comment,
    (SELECT group_concat(text, char(10)) FROM attachment_text a WHERE a.comment_id = c.id) AS att,
    ${scanTranscripts} FROM comments c WHERE id = ?`);
  const repText = (id: string) => {
    const r = getText.get(id) as { comment: string | null; att: string | null; transcript: string | null } | null;
    return commentText(r?.comment ?? null, r?.att ?? null, r?.transcript ?? null);
  };
  // A copy group with no readable letter (e.g. identical scans behind "See attached") can't be
  // judged or named as a campaign; leave it as a plain form-letter group
  const unreadable = exactOnly.filter(g => !unitOf.has(g.id) && wordCount(repText(g.id)) < MIN_WORDS_REP);
  if (unreadable.length > 0) console.log(`   Skipping ${unreadable.length} copy groups with no readable text`);
  exactOnly = exactOnly.filter(g => !unreadable.includes(g));
  if (exactOnly.length > 0) {
    const items = exactOnly.map((g, i) => ({
      id: `f${i + 1}`, count: g.size,
      text: truncateWords(unitOf.has(g.id) ? keep[unitOf.get(g.id)!].text : repText(g.id), JUDGE_WORDS),
    }));
    const batches = new Map<string, typeof items>();
    for (let i = 0; i < items.length; i += 20) batches.set(`F${i / 20}`, items.slice(i, i + 20));
    const names = new Map<string, { name: string; description: string | null }>();
    console.log(`\n🏷️  Naming ${exactOnly.length} form-letter campaigns`);
    summaries.push(await runLlmRequests([...batches].map(([key, b]) => ({
      key, model: nameModel, parts: [{ text: buildFormLetterNamingPrompt(ruleTitle, b) }],
      config: { responseMimeType: "application/json" },
    })), (_req, res) => {
      const arr = parseJson(res.text);
      for (const r of (Array.isArray(arr) ? arr : [])) if (r?.id && r.name) names.set(String(r.id), { name: String(r.name), description: r.description || null });
    }, { db, task: "tag-campaigns", mode, concurrency, label: `tag-campaigns-names:${documentId}` }));
    exactOnly.forEach((g, i) => {
      const nm = names.get(`f${i + 1}`);
      const u = unitOf.get(g.id);
      camps.push({
        units: u != null ? [u] : [], extraClusters: u != null ? [] : [g.cluster_id],
        name: nm?.name || `Form letter ${g.id}`, description: nm?.description || null, evidence: null, level: null,
        method: "form-letter", expanded: 0,
      });
    });
  }
  const copiesOf = (c: Camp) => c.units.reduce((s, i) => s + keep[i].size, 0) + c.extraClusters.length * minExact;
  const brief = (c: Camp, id: string, nEx = 2) => {
    const cen = centroid(vecs, c.units);
    const typical = [...c.units].sort((x, y) => dot(vecs[y], cen) - dot(vecs[x], cen));
    return { id, name: c.name, description: c.description, copies: copiesOf(c), excerpts: typical.slice(0, nEx).map(i => truncateWords(keep[i].text, BRIEF_WORDS)) };
  };

  // 5. Merge campaigns that were found as separate groups (centroids close; LLM decides)
  const withUnits = camps.map((c, i) => i).filter(i => camps[i].units.length > 0);
  const cents = withUnits.map(i => centroid(vecs, camps[i].units));
  const campMerges = averageLinkage(cents, cents.map((_, i) => i), mergeLevel);
  const muf = new UnionFind(cents.length);
  const mgroups = cut(campMerges, muf, cents.map((_, i) => i), mergeLevel).filter(g => g.length > 1);
  const parent = camps.map((_, i) => i);
  if (mgroups.length > 0) {
    console.log(`\n🔗 Checking ${mgroups.length} sets of similar campaigns (${mgroups.reduce((s, g) => s + g.length, 0)} campaigns) for duplicates`);
    const sets = new Map<string, number[]>();
    for (const g of mgroups) {
      const ids = g.map(k => withUnits[k]).sort((a, b) => copiesOf(camps[b]) - copiesOf(camps[a]));
      for (let i = 0; i < ids.length; i += MERGE_CHUNK) sets.set(`M${sets.size}`, ids.slice(i, i + MERGE_CHUNK));
    }
    let merged = 0;
    summaries.push(await runLlmRequests([...sets].map(([key, ids]) => ({
      key, model: judgeModel,
      parts: [{ text: buildCampaignMergePrompt(ruleTitle, ids.map((ci, k) => brief(camps[ci], `g${k + 1}`))) }],
      config: { responseMimeType: "application/json" },
    })), (req, res) => {
      const ids = sets.get(req.key)!;
      const r = parseJson(res.text);
      for (const m of (Array.isArray(r.campaigns) ? r.campaigns : [])) {
        const members = (Array.isArray(m.groups) ? m.groups : []).map((g: string) => ids[parseInt(String(g).replace(/\D/g, ""), 10) - 1]).filter((x: number | undefined) => x != null);
        if (members.length < 2) continue;
        const [head, ...rest] = members as number[];
        for (const o of rest) {
          if (parent[o] !== o || parent[head] !== head) continue;
          parent[o] = head;
          const h = camps[head], c = camps[o];
          h.units.push(...c.units); h.extraClusters.push(...c.extraClusters);
          if (c.method === "paraphrase") h.method = "paraphrase";
          if (c.evidence && !h.evidence) h.evidence = c.evidence;
          if (h.level == null) h.level = c.level;
          merged++;
        }
        if (m.name) camps[head].name = String(m.name);
        if (m.description) camps[head].description = String(m.description);
      }
    }, { db, task: "tag-campaigns", mode, concurrency, label: `tag-campaigns-merge:${documentId}` }));
    console.log(`   merged ${merged} campaigns into others`);
  }
  const live = camps.filter((_, i) => parent[i] === i);

  // 6. Expansion: unassigned units with ≥ expandMinNeighbors campaign members at ≥ expandLevel, LLM-verified
  const owner = new Int32Array(n).fill(-1);
  live.forEach((c, ci) => { for (const u of c.units) owner[u] = ci; });
  const candidatesBy = new Map<number, number[]>();
  const owned = [...Array(n).keys()].filter(j => owner[j] >= 0);
  for (let i = 0; i < n; i++) {
    if (owner[i] >= 0) continue;
    const hits = new Map<number, number>();
    for (const j of owned) {
      if (dot(vecs[i], vecs[j]) >= expandLevel) hits.set(owner[j], (hits.get(owner[j]) || 0) + 1);
    }
    let best = -1, bestN = 0;
    for (const [ci, k] of hits) if (k > bestN) { best = ci; bestN = k; }
    if (best >= 0 && bestN >= Math.min(expandMinNeighbors, live[best].units.length)) {
      if (!candidatesBy.has(best)) candidatesBy.set(best, []);
      candidatesBy.get(best)!.push(i);
    }
  }
  const nCand = [...candidatesBy.values()].reduce((s, a) => s + a.length, 0);
  if (nCand > 0) {
    console.log(`\n➕ Checking ${nCand} near-miss comments against ${candidatesBy.size} campaigns`);
    const batches = new Map<string, { ci: number; units: number[] }>();
    for (const [ci, us] of candidatesBy) {
      for (let i = 0; i < us.length; i += EXPAND_BATCH) batches.set(`X${batches.size}`, { ci, units: us.slice(i, i + EXPAND_BATCH) });
    }
    const briefs = new Map<number, ReturnType<typeof brief>>();
    for (const ci of candidatesBy.keys()) briefs.set(ci, brief(live[ci], "campaign", 3));
    // Grounding: the quoted shared phrase must occur in the candidate and in ≥2 campaign members,
    // and be specific to the campaign (in <1% of all units, or mostly in this campaign's units)
    const norm = (t: string) => " " + (t.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).join(" ") + " ";
    const normText = keep.map(u => norm(u.text));
    const grounded = (ci: number, u: number, quote: unknown): boolean => {
      if (typeof quote !== "string") return false;
      const q = norm(quote);
      if (q.trim().split(" ").length < 6 || !normText[u].includes(q)) return false;
      let inside = 0, all = 0;
      const members = new Set(live[ci].units);
      for (let j = 0; j < n; j++) {
        if (j === u || !normText[j].includes(q)) continue;
        all++;
        if (members.has(j)) inside++;
      }
      return inside >= Math.min(2, members.size) && (all < 0.01 * n || inside >= 0.5 * all);
    };
    let ungrounded = 0;
    const added: [number, number][] = [];
    summaries.push(await runLlmRequests([...batches].map(([key, b]) => ({
      key, model: judgeModel,
      parts: [{ text: buildCampaignExpandPrompt(ruleTitle, briefs.get(b.ci)!, b.units.map((u, k) => ({ id: `k${k + 1}`, text: truncateWords(keep[u].text, BRIEF_WORDS) }))) }],
      config: { responseMimeType: "application/json" },
    })), (req, res) => {
      const b = batches.get(req.key)!;
      const r = parseJson(res.text);
      for (const x of (Array.isArray(r.results) ? r.results : [])) {
        const k = parseInt(String(x?.id || "").replace(/\D/g, ""), 10) - 1;
        if (x?.member !== true || b.units[k] == null) continue;
        if (grounded(b.ci, b.units[k], x.shared)) added.push([b.ci, b.units[k]]);
        else ungrounded++;
      }
    }, { db, task: "tag-campaigns", mode, concurrency, label: `tag-campaigns-expand:${documentId}` }));
    for (const [ci, u] of added) { live[ci].units.push(u); live[ci].expanded++; }
    console.log(`   added ${added.length} of ${nCand} (${ungrounded} more said yes without a campaign-specific shared phrase)`);
  }

  // 7. Members: exact-copy groups ride along with their representative
  const clusterMembers = new Map<number, string[]>();
  const promotedFrom = new Map<number, string[]>();
  if (clustered) {
    for (const r of db.prepare("SELECT cluster_id, comment_id FROM comment_cluster_membership").all() as { cluster_id: number; comment_id: string }[]) {
      if (!clusterMembers.has(r.cluster_id)) clusterMembers.set(r.cluster_id, []);
      clusterMembers.get(r.cluster_id)!.push(r.comment_id);
    }
    // Members promoted out of a form-letter group for their added text still sent that letter
    for (const r of db.prepare("SELECT comment_id, cluster_id FROM form_letter_additions WHERE promoted = 1").all() as { comment_id: string; cluster_id: number }[]) {
      if (!promotedFrom.has(r.cluster_id)) promotedFrom.set(r.cluster_id, []);
      promotedFrom.get(r.cluster_id)!.push(r.comment_id);
    }
  }
  const tagsOf = (c: Camp) => {
    const tags = new Map<string, { how: "exact" | "paraphrase"; sim: number | null }>();
    const cen = c.units.length ? centroid(vecs, c.units) : null;
    const addCluster = (cid: number, sim: number | null) => {
      for (const m of clusterMembers.get(cid) || []) tags.set(m, { how: "exact", sim });
      for (const m of promotedFrom.get(cid) || []) tags.set(m, { how: "exact", sim });
    };
    for (const cid of c.extraClusters) addCluster(cid, null);
    for (const i of c.units) {
      const u = keep[i];
      const sim = cen ? Math.round(dot(vecs[i], cen) * 1000) / 1000 : null;
      if (u.size > 1 && u.clusterId != null) addCluster(u.clusterId, sim);
      else if (!tags.has(u.id)) tags.set(u.id, { how: "paraphrase", sim });
    }
    return tags;
  };

  // 8. Store: a comment belongs to at most one campaign (largest first wins)
  const final = live.map(c => ({ c, tags: tagsOf(c) })).sort((a, b) => b.tags.size - a.tags.size);
  const seen = new Set<string>();
  db.transaction(() => {
    db.exec("DELETE FROM comment_campaigns; DELETE FROM campaigns;");
    const insC = db.prepare(`INSERT INTO campaigns (id, name, description, method, evidence, level, unit_count, exact_count, paraphrase_count, total_count, model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insM = db.prepare("INSERT INTO comment_campaigns (comment_id, campaign_id, how, similarity) VALUES (?, ?, ?, ?)");
    let id = 0;
    for (const { c, tags } of final) {
      const fresh = [...tags].filter(([cid]) => !seen.has(cid));
      if (fresh.length === 0) continue;
      id++;
      let exact = 0, para = 0;
      for (const [cid, t] of fresh) {
        seen.add(cid);
        insM.run(cid, id, t.how, t.sim);
        if (t.how === "exact") exact++; else para++;
      }
      // 'paraphrase' once any member is a reworded letter; otherwise one or more exact-copy groups
      const method = para > 0 ? "paraphrase" : "form-letter";
      insC.run(id, c.name, c.description, method, c.evidence, c.level, c.units.length + c.extraClusters.length, exact, para, exact + para,
        c.level != null ? judgeModel : nameModel);
    }
  })();

  if (options.report) {
    await Bun.write(options.report, JSON.stringify({
      judged: judged.map(j => ({
        level: j.level, verdict: j.verdict, name: j.name, description: j.description, evidence: j.evidence,
        unitCount: j.units.length, comments: j.units.reduce((s, i) => s + keep[i].size, 0),
        members: j.members, sample: j.sample.map(i => keep[i].id), units: j.units.map(i => keep[i].id),
      })),
      campaigns: final.map(({ c, tags }) => ({ name: c.name, method: c.method, comments: tags.size, expanded: c.expanded, units: c.units.map(i => keep[i].id) })),
    }, null, 2));
    console.log(`📝 Wrote ${judged.length} judged groups and ${final.length} campaigns to ${options.report}`);
  }

  // Summary
  const stats = db.prepare(`SELECT method, COUNT(*) AS n, SUM(total_count) AS total, SUM(exact_count) AS exact, SUM(paraphrase_count) AS para
    FROM campaigns GROUP BY method`).all() as { method: string; n: number; total: number; exact: number; para: number }[];
  console.log(`\n📊 Campaigns:`);
  for (const s of stats) console.log(`   ${s.method}: ${s.n} campaigns, ${s.total} comments (${s.exact} exact copies, ${s.para} paraphrased)`);
  for (const c of db.prepare("SELECT id, name, total_count, exact_count, paraphrase_count, method FROM campaigns ORDER BY total_count DESC LIMIT 15").all() as any[]) {
    console.log(`   #${c.id} ${c.total_count} (${c.exact_count} exact + ${c.paraphrase_count} paraphrased) [${c.method}] ${c.name}`);
  }
  const cost = summaries.reduce((s, x) => s + x.costUsd, 0) + es.costUsd;
  console.log(`\n💰 ~$${cost.toFixed(3)} (embeddings ~$${es.costUsd.toFixed(3)})${mode === "batch" ? " (batch price for LLM calls)" : ""}`);
  db.close();
}
