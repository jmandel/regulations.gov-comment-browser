import { Command } from "commander";
import type { Database } from "bun:sqlite";
import { openDb, withTransaction } from "../lib/database";
import { initDebug, debugLog } from "../lib/debug";
import { extractTextFromAttachment } from "../lib/comment-processing";
import { runPool } from "../lib/worker-pool";
import type { Attachment, CommentAttributes } from "../types";
import { htmlToText } from "../lib/text";

// Form-letter detection for large dockets.
//
// Instead of comparing whole comments (which splits "template + personal story" variants
// away from the bare template), we first find text that is shared across the corpus:
// a 5-word phrase is "shared" if it appears in at least --min-shared-df comments. A comment's
// shared phrases are its "core". Comments whose cores match are grouped (MinHash LSH +
// union-find, so results don't depend on comment order), groups are split around a medoid
// so chained campaigns don't merge, and each member's text beyond the group template is
// stored in form_letter_additions. Members that add a lot (e.g. an organization that used a
// template letter and appended pages of its own) are promoted out to their own singleton
// clusters so they get full processing; their additions row keeps the link to the template.
//
// Writes the same comment_clusters / comment_cluster_membership / clustering_status tables
// as cluster-comments-fast, so downstream steps work unchanged. Every comment gets a
// membership row (ungrouped comments are singleton clusters).

const SHINGLE = 5;              // words per phrase
const MIN_CORE_SHINGLES = 30;   // a comment needs this much shared text to join a group...
const SHORT_SHARED_FRACTION = 0.8; // ...unless it is shorter than that and this much of it is shared
const STUB_WORDS = 40;          // form text this short is dropped when attachments carry the content
const MAX_WORDS = 20000;        // cap very long attachments
const NUM_HASHES = 32;          // MinHash signature length
const BAND_ROWS = 2;            // LSH rows per band (16 bands)
const ADDITION_MIN_RUN = 5;     // ignore uncovered runs shorter than this when storing added text

export const clusterFormLettersCommand = new Command("cluster-form-letters")
  .description("Group form-letter campaigns by shared text in the comment field and attachments, tolerant of personal additions")
  .argument("<document-id>", "Document ID (e.g., CMS-2026-2377-0002)")
  .option("--min-shared-df <n>", "A 5-word phrase counts as shared if it appears in at least N comments (default: 5)", parseInt)
  .option("--min-shared-fraction <n>", "Minimum fraction of a comment's text that must be shared for it to join a group (default: 0.3)", parseFloat)
  .option("--similarity-threshold <n>", "Jaccard similarity of shared text needed to link two comments (default: 0.5)", parseFloat)
  .option("--min-cluster-size <n>", "Groups smaller than this become singletons (default: 4)", parseInt)
  .option("--near-copy-threshold <n>", "Second pass: ungrouped comments whose full text has at least this Jaccard similarity are grouped, even in pairs (default: 0.8)", parseFloat)
  .option("--promote-added-words <n>", "Members adding at least this many words of their own become their own cluster (default: 300)", parseInt)
  .option("-c, --concurrency <n>", "Parallel attachment text extractions (default: 8)", parseInt)
  .option("--force", "Recluster even if clustering exists")
  .option("-d, --debug", "Enable debug output")
  .action(clusterFormLetters);

function fmix32(h: number): number {
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

type Doc = {
  id: string;
  words: string[];          // original tokens (for reconstructing added text)
  shingles: Uint32Array;    // hash of the phrase starting at each word position
  set: Set<number>;
  core: Set<number>;
};

function buildDoc(id: string, text: string): Doc {
  const words: string[] = [];
  const norm: string[] = [];
  for (const tok of text.split(/\s+/)) {
    const n = tok.toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (!n) continue;
    words.push(tok);
    norm.push(n);
    if (words.length >= MAX_WORDS) break;
  }
  // Texts shorter than one phrase ("Strong objection") are hashed whole, so exact repeats still match
  const count = norm.length >= SHINGLE ? norm.length - SHINGLE + 1 : norm.length > 0 ? 1 : 0;
  const shingles = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    shingles[i] = Bun.hash.crc32(norm.slice(i, i + SHINGLE).join(" "));
  }
  return { id, words, shingles, set: new Set(shingles), core: new Set() };
}

function jaccard(a: Set<number>, b: Set<number>): number {
  if (a.size > b.size) [a, b] = [b, a];
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

// Fraction of `template` present in `s`
function coverage(s: Set<number>, template: Set<number>): number {
  if (template.size === 0) return 0;
  let inter = 0;
  for (const x of template) if (s.has(x)) inter++;
  return inter / template.size;
}

// Extract and cache plain text for each attachment (best text format per attachment)
async function ensureAttachmentText(db: Database, concurrency: number) {
  const FORMAT_PREFERENCE = ["txt", "docx", "pdf"];
  const rows = db.prepare(
    "SELECT id, format, comment_id FROM attachments WHERE blob_data IS NOT NULL"
  ).all() as { id: string; format: string; comment_id: string }[];

  const best = new Map<string, { id: string; format: string; comment_id: string }>();
  for (const r of rows) {
    const pref = FORMAT_PREFERENCE.indexOf(r.format.toLowerCase());
    if (pref < 0) continue; // images, spreadsheets, etc. carry no extractable text here
    const cur = best.get(r.id);
    if (!cur || pref < FORMAT_PREFERENCE.indexOf(cur.format.toLowerCase())) best.set(r.id, r);
  }

  const done = new Set(
    (db.prepare("SELECT attachment_id FROM attachment_text").all() as { attachment_id: string }[]).map(r => r.attachment_id)
  );
  const todo = [...best.values()].filter(r => !done.has(r.id));
  console.log(`📎 Attachment text: ${best.size} extractable attachments, ${todo.length} to extract`);
  if (todo.length === 0) return;

  const getBlob = db.prepare("SELECT * FROM attachments WHERE id = ? AND format = ?");
  const insert = db.prepare(
    "INSERT OR REPLACE INTO attachment_text (attachment_id, format, comment_id, text) VALUES (?, ?, ?, ?)"
  );
  let extracted = 0;
  await runPool(todo, concurrency, async (r) => {
    const attachment = getBlob.get(r.id, r.format) as Attachment;
    let text = "";
    try {
      // A hung extraction shouldn't stall the run; it is retried on the next run
      text = await Promise.race([
        extractTextFromAttachment(attachment),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out after 120s")), 120_000)),
      ]);
    } catch (e) {
      console.warn(`\n⚠️  Text extraction failed for ${r.id}.${r.format} (${r.comment_id}): ${(e as Error).message}`);
      if ((e as Error).message.startsWith("timed out")) return;
    }
    insert.run(r.id, r.format, r.comment_id, text);
    extracted++;
    if (extracted % 100 === 0 || extracted === todo.length) {
      process.stdout.write(`\r   Extracted ${extracted}/${todo.length}`);
    }
  });
  console.log();
}

async function clusterFormLetters(documentId: string, options: any) {
  await initDebug(options.debug);
  const minDf = options.minSharedDf || 5;
  const minFraction = options.minSharedFraction ?? 0.3;
  const threshold = options.similarityThreshold || 0.5;
  const minClusterSize = options.minClusterSize || 4;
  const promoteAddedWords = options.promoteAddedWords || 300;
  const nearCopyThreshold = options.nearCopyThreshold || 0.8;

  const db = openDb(documentId);
  try {
    const existing = db.prepare("SELECT created_at FROM clustering_status WHERE status = 'completed' LIMIT 1").get() as any;
    if (existing && !options.force) {
      console.log(`✅ Clustering already exists from ${existing.created_at} (use --force to recluster)`);
      return;
    }

    console.log(`🔍 Form-letter clustering for ${documentId}`);
    console.log(`   Shared phrase: ${SHINGLE} words in ≥${minDf} comments; join if ≥${minFraction * 100}% shared; link at similarity ≥${threshold}`);

    await ensureAttachmentText(db, options.concurrency || 8);

    // Build one text per comment: comment field + attachment text
    console.log(`📊 Building comment texts...`);
    const attachmentText = new Map<string, string[]>();
    for (const r of db.prepare("SELECT comment_id, text FROM attachment_text ORDER BY attachment_id").iterate() as Iterable<{ comment_id: string; text: string }>) {
      if (!r.text) continue;
      if (!attachmentText.has(r.comment_id)) attachmentText.set(r.comment_id, []);
      attachmentText.get(r.comment_id)!.push(r.text);
    }

    const docs: Doc[] = [];
    let stubs = 0;
    for (const r of db.prepare("SELECT id, attributes_json FROM comments ORDER BY id").iterate() as Iterable<{ id: string; attributes_json: string }>) {
      const attrs = JSON.parse(r.attributes_json) as CommentAttributes;
      const form = htmlToText(attrs.comment || attrs.text || "");
      const att = (attachmentText.get(r.id) || []).join("\n");
      // "See attached" and similar stubs would otherwise look like shared text
      const formIsStub = att.length > 0 && form.split(/\s+/).filter(Boolean).length < STUB_WORDS;
      if (formIsStub) stubs++;
      docs.push(buildDoc(r.id, formIsStub ? att : `${form}\n${att}`));
    }
    console.log(`   ${docs.length} comments (${attachmentText.size} with attachment text; ${stubs} stub comment fields dropped)`);

    // Document frequency of each phrase
    const df = new Map<number, number>();
    for (const d of docs) for (const x of d.set) df.set(x, (df.get(x) || 0) + 1);

    const eligible: number[] = [];
    docs.forEach((d, i) => {
      for (const x of d.set) if (df.get(x)! >= minDf) d.core.add(x);
      const longEnough = d.core.size >= MIN_CORE_SHINGLES && d.core.size >= minFraction * d.set.size;
      const shortAndShared = d.set.size > 0 && d.set.size < MIN_CORE_SHINGLES && d.core.size >= SHORT_SHARED_FRACTION * d.set.size;
      if (longEnough || shortAndShared) eligible.push(i);
    });
    console.log(`   ${eligible.length} comments have enough shared text to be form-letter candidates`);

    // MinHash LSH over cores; union candidates that verify
    const parent = docs.map((_, i) => i);
    const find = (x: number): number => {
      while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
      return x;
    };
    const seeds = Array.from({ length: NUM_HASHES }, (_, k) => fmix32(k + 1) | 1);
    const minhash = (set: Set<number>) => {
      const sig = new Uint32Array(NUM_HASHES).fill(0xffffffff);
      for (const x of set) {
        for (let k = 0; k < NUM_HASHES; k++) {
          const h = fmix32(x ^ seeds[k]);
          if (h < sig[k]) sig[k] = h;
        }
      }
      return sig;
    };
    const buckets = new Map<string, number>();
    for (const i of eligible) {
      const sig = minhash(docs[i].core);
      for (let b = 0; b < NUM_HASHES / BAND_ROWS; b++) {
        const key = `${b}:${sig.slice(b * BAND_ROWS, (b + 1) * BAND_ROWS).join(",")}`;
        const rep = buckets.get(key);
        if (rep === undefined) {
          buckets.set(key, i);
        } else if (find(rep) !== find(i) && jaccard(docs[rep].core, docs[i].core) >= threshold) {
          parent[find(i)] = find(rep);
        }
      }
    }

    const components = new Map<number, number[]>();
    for (const i of eligible) {
      const root = find(i);
      if (!components.has(root)) components.set(root, []);
      components.get(root)!.push(i);
    }

    // Split each component around a medoid so chained campaigns don't merge
    const groups: number[][] = [];
    for (let members of components.values()) {
      while (members.length >= minClusterSize) {
        const sample = members.length <= 20 ? members : members.filter((_, k) => k % Math.ceil(members.length / 20) === 0);
        let seed = sample[0], bestScore = -1;
        for (const a of sample) {
          let score = 0;
          for (const b of sample) if (a !== b) score += jaccard(docs[a].core, docs[b].core);
          if (score > bestScore) { bestScore = score; seed = a; }
        }
        const template = docs[seed].core;
        const keep = members.filter(m => coverage(docs[m].set, template) >= 0.5);
        const rest = members.filter(m => coverage(docs[m].set, template) < 0.5);
        if (keep.length >= minClusterSize) groups.push(keep);
        if (rest.length === members.length) break; // no progress
        members = rest;
      }
    }
    groups.sort((a, b) => b.length - a.length);

    // Second pass: near-identical copies among comments still ungrouped. Phrases shared by only
    // 2-3 comments never count as "shared" above, so copies sent by a handful of people (or the same
    // person twice) are compared on their full text instead, and kept even as pairs.
    const inGroup = new Set(groups.flat());
    const nearParent = new Map<number, number>();
    const nearFind = (x: number): number => {
      while (nearParent.get(x)! !== x) { nearParent.set(x, nearParent.get(nearParent.get(x)!)!); x = nearParent.get(x)!; }
      return x;
    };
    const nearBuckets = new Map<string, number>();
    docs.forEach((d, i) => {
      if (inGroup.has(i) || d.set.size === 0) return;
      nearParent.set(i, i);
      const sig = minhash(d.set);
      for (let b = 0; b < NUM_HASHES / BAND_ROWS; b++) {
        const key = `${b}:${sig.slice(b * BAND_ROWS, (b + 1) * BAND_ROWS).join(",")}`;
        const rep = nearBuckets.get(key);
        if (rep === undefined) nearBuckets.set(key, i);
        else if (nearFind(rep) !== nearFind(i) && jaccard(docs[rep].set, d.set) >= nearCopyThreshold) nearParent.set(nearFind(i), nearFind(rep));
      }
    });
    const nearComponents = new Map<number, number[]>();
    for (const i of nearParent.keys()) {
      const root = nearFind(i);
      if (!nearComponents.has(root)) nearComponents.set(root, []);
      nearComponents.get(root)!.push(i);
    }
    const nearCopyGroups = [...nearComponents.values()].filter(m => m.length >= 2);
    const isNearCopy = new Set(nearCopyGroups);
    groups.push(...nearCopyGroups);

    // Template, representative, and per-member additions for each group
    type Stored = { members: number[]; rep: number; scores: Map<number, number>; additions: Map<number, { count: number; text: string }>; promoted: number[] };
    const stored: Stored[] = [];
    for (const members of groups) {
      const counts = new Map<number, number>();
      for (const m of members) for (const x of docs[m].set) counts.set(x, (counts.get(x) || 0) + 1);
      const template = new Set<number>();
      for (const [x, c] of counts) if (c >= members.length / 2) template.add(x);

      const scores = new Map<number, number>();
      const additions = new Map<number, { count: number; text: string }>();
      let rep = members[0], repCost = Infinity;
      for (const m of members) {
        const d = docs[m];
        const covered = new Uint8Array(d.words.length);
        d.shingles.forEach((x, i) => {
          if (template.has(x)) for (let w = i; w < i + SHINGLE; w++) covered[w] = 1;
        });
        const runs: string[] = [];
        let added = 0, run: string[] = [];
        for (let w = 0; w <= d.words.length; w++) {
          if (w < d.words.length && !covered[w]) { run.push(d.words[w]); added++; continue; }
          if (run.length >= ADDITION_MIN_RUN) runs.push(run.join(" "));
          run = [];
        }
        const cov = coverage(d.set, template);
        scores.set(m, cov);
        if (added > 0) additions.set(m, { count: added, text: runs.join(" … ") });
        // Representative: the member closest to the bare template
        const cost = added + (1 - cov) * template.size;
        if (cost < repCost) { repCost = cost; rep = m; }
      }
      const promoted = members.filter(m => m !== rep && (additions.get(m)?.count || 0) >= promoteAddedWords);
      const kept = members.filter(m => !promoted.includes(m));
      if (kept.length >= (isNearCopy.has(members) ? 2 : minClusterSize)) {
        stored.push({ members: kept, rep, scores, additions, promoted });
      }
    }

    // Store: groups, then every remaining comment as a singleton
    console.log(`💾 Storing clusters...`);
    const grouped = new Set(stored.flatMap(g => g.members));
    withTransaction(db, () => {
      db.prepare("DELETE FROM form_letter_additions").run();
      db.prepare("DELETE FROM comment_cluster_membership").run();
      db.prepare("DELETE FROM comment_clusters").run();
      db.prepare("DELETE FROM clustering_status").run();

      const insertCluster = db.prepare(`
        INSERT INTO comment_clusters (representative_comment_id, cluster_size, similarity_threshold, cluster_method, created_at)
        VALUES (?, ?, ?, 'form-letter-core', datetime('now'))
      `);
      const insertMember = db.prepare(`
        INSERT INTO comment_cluster_membership (comment_id, cluster_id, is_representative, similarity_score, created_at)
        VALUES (?, ?, ?, ?, datetime('now'))
      `);
      const insertAddition = db.prepare(
        "INSERT INTO form_letter_additions (comment_id, cluster_id, added_word_count, added_text, promoted) VALUES (?, ?, ?, ?, ?)"
      );

      for (const g of stored) {
        const clusterId = insertCluster.run(docs[g.rep].id, g.members.length, threshold).lastInsertRowid;
        for (const m of g.members) {
          insertMember.run(docs[m].id, clusterId, m === g.rep ? 1 : 0, g.scores.get(m)!);
          const add = g.additions.get(m);
          if (add) insertAddition.run(docs[m].id, clusterId, add.count, add.text, 0);
        }
        for (const m of g.promoted) {
          const add = g.additions.get(m)!;
          insertAddition.run(docs[m].id, clusterId, add.count, add.text, 1);
        }
      }
      docs.forEach((d, i) => {
        if (grouped.has(i)) return;
        const clusterId = insertCluster.run(d.id, 1, threshold).lastInsertRowid;
        insertMember.run(d.id, clusterId, 1, 1.0);
      });

      db.prepare(`
        INSERT INTO clustering_status (total_comments, total_clusters, representative_count, duplicates_filtered,
          similarity_threshold, min_cluster_size, cluster_method, status, created_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, 'form-letter-core', 'completed', datetime('now'), datetime('now'))
      `).run(
        docs.length,
        stored.length + docs.length - grouped.size,
        stored.length + docs.length - grouped.size,
        grouped.size - stored.length,
        threshold,
        minClusterSize
      );
    });

    // Report
    const bigAdditions = stored.reduce((n, g) => n + g.members.filter(m => (g.additions.get(m)?.count || 0) >= 50).length, 0);
    const promotedCount = stored.reduce((n, g) => n + g.promoted.length, 0);
    console.log(`\n✅ Form-letter clustering complete`);
    console.log(`   Comments: ${docs.length}`);
    const nearStored = stored.filter(g => g.members.length < minClusterSize).length;
    console.log(`   Form-letter groups: ${stored.length}, covering ${grouped.size} comments (${nearStored} are near-copy pairs/triples)`);
    console.log(`   Ungrouped comments: ${docs.length - grouped.size}`);
    console.log(`   Units after collapsing: ${stored.length + docs.length - grouped.size} (${((1 - (stored.length + docs.length - grouped.size) / docs.length) * 100).toFixed(1)}% reduction)`);
    console.log(`   Group members adding ≥50 words of their own: ${bigAdditions}`);
    console.log(`   Promoted to their own cluster (≥${promoteAddedWords} added words): ${promotedCount}`);
    console.log(`\n📊 Largest groups:`);
    for (const g of stored.slice(0, 15)) {
      const preview = docs[g.rep].words.slice(0, 18).join(" ");
      console.log(`   ${String(g.members.length).padStart(5)}  ${docs[g.rep].id}  ${preview}…`);
    }
  } finally {
    db.close();
  }
}
