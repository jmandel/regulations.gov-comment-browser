import { Command } from "commander";
import { openDb, withTransaction } from "../lib/database";
import { htmlToText, wordCount } from "../lib/text";
import { buildDoc, jaccard, coverage, type Doc } from "./cluster-form-letters";

// Scanned submissions have no text until they are transcribed, so form-letter clustering can only
// group them when two comments attach a byte-identical file. A campaign letter that people printed,
// signed and scanned therefore shows up as many separate units. After transcription, this step
// compares each ungrouped scan's transcript with the form-letter groups and moves matches into
// their group, so only the group's representative goes on to condense and theme extraction. Scans
// that match each other but no existing group form new groups.

const STUB_WORDS = 40;           // same stub rule as cluster-form-letters
const TEMPLATE_COVERAGE = 0.5;   // share of a group's template text that must appear in the scan...
const SCAN_SHARE = 0.3;          // ...and share of the scan's text that comes from the template, so a
                                 // full letter that merely quotes a short template (e.g. the rule's
                                 // title) doesn't match it
const MIN_TEMPLATE = 40;         // templates shorter than this (in 5-word phrases) are too generic
const NEAR_COPY = 0.8;           // full-text Jaccard for scans matching each other

export const matchScansCommand = new Command("match-scans")
  .description("After transcription, move scanned submissions that are copies of a form letter into its group")
  .argument("<document-id>", "Document ID (e.g., CMS-2026-2377-0002)")
  .option("--min-coverage <n>", `Share of a group's template that must appear in the scan (default: ${TEMPLATE_COVERAGE})`, parseFloat)
  .option("--dry-run", "Report matches without changing clusters")
  .action(matchScans);

async function matchScans(documentId: string, options: any) {
  const db = openDb(documentId);
  const minCoverage = options.minCoverage ?? TEMPLATE_COVERAGE;
  try {
    const clustered = db.prepare("SELECT 1 FROM clustering_status WHERE status = 'completed' LIMIT 1").get();
    if (!clustered) {
      console.log("⏭️  No form-letter clustering; nothing to match");
      return;
    }

    // Ungrouped scans: singleton units with attachments but no extracted attachment text, a stub
    // comment box, and a completed transcription
    const scans = db.prepare(`
      SELECT c.id, json_extract(c.attributes_json, '$.comment') AS comment, t.markdown, k.cluster_id
      FROM comment_clusters k
      JOIN comments c ON c.id = k.representative_comment_id
      JOIN transcriptions t ON t.comment_id = c.id AND t.status = 'completed'
      WHERE k.cluster_size = 1
        AND EXISTS (SELECT 1 FROM attachments a WHERE a.comment_id = c.id)
        AND NOT EXISTS (SELECT 1 FROM attachment_text x WHERE x.comment_id = c.id AND x.text <> '')
    `).all() as { id: string; comment: string | null; markdown: string; cluster_id: number }[];
    const scanDocs = scans
      .filter(s => wordCount(htmlToText(s.comment || "")) < STUB_WORDS)
      .map(s => ({ ...s, doc: buildDoc(s.id, s.markdown.replace(/[#*_>`|-]+/g, " ")) }))
      .filter(s => s.doc.set.size > 0);
    console.log(`🔎 ${scanDocs.length} ungrouped scanned submissions with transcripts`);
    if (scanDocs.length === 0) return;

    // Templates: each multi-member group's representative text (the same text clustering used,
    // or the transcript for a scanned representative)
    const reps = db.prepare(`
      SELECT k.cluster_id, k.cluster_size, c.id, json_extract(c.attributes_json, '$.comment') AS comment,
        (SELECT group_concat(text, char(10)) FROM attachment_text a WHERE a.comment_id = c.id) AS att,
        (SELECT markdown FROM transcriptions t WHERE t.comment_id = c.id AND t.status = 'completed') AS markdown
      FROM comment_clusters k JOIN comments c ON c.id = k.representative_comment_id
      WHERE k.cluster_size >= 2
    `).all() as { cluster_id: number; cluster_size: number; id: string; comment: string | null; att: string | null; markdown: string | null }[];
    const templates: { clusterId: number; size: number; doc: Doc }[] = [];
    for (const r of reps) {
      const form = htmlToText(r.comment || "");
      const att = (r.att || "").trim();
      const text = att ? (wordCount(form) < STUB_WORDS ? att : `${form}\n${att}`) : (r.markdown && wordCount(form) < STUB_WORDS ? r.markdown : form);
      const doc = buildDoc(r.id, text);
      if (doc.set.size >= MIN_TEMPLATE) templates.push({ clusterId: r.cluster_id, size: r.cluster_size, doc });
    }

    // Inverted index over template phrases → candidate groups for each scan
    const index = new Map<number, number[]>();
    templates.forEach((t, i) => { for (const x of t.doc.set) { if (!index.has(x)) index.set(x, []); index.get(x)!.push(i); } });
    const joins: { scan: typeof scanDocs[number]; clusterId: number; coverage: number }[] = [];
    const unmatched: typeof scanDocs = [];
    for (const s of scanDocs) {
      const shared = new Map<number, number>();
      for (const x of s.doc.set) for (const i of index.get(x) || []) shared.set(i, (shared.get(i) || 0) + 1);
      let best = -1, bestCov = 0;
      for (const [i, n] of shared) {
        if (n / templates[i].doc.set.size < minCoverage || n / s.doc.set.size < SCAN_SHARE) continue;
        const cov = coverage(s.doc.set, templates[i].doc.set);
        if (cov > bestCov) { bestCov = cov; best = i; }
      }
      if (best >= 0) joins.push({ scan: s, clusterId: templates[best].clusterId, coverage: bestCov });
      else unmatched.push(s);
    }

    // Scans that are copies of each other but of no existing group
    const newGroups: (typeof scanDocs)[] = [];
    const used = new Set<number>();
    for (let i = 0; i < unmatched.length; i++) {
      if (used.has(i)) continue;
      const group = [unmatched[i]];
      for (let j = i + 1; j < unmatched.length; j++) {
        if (!used.has(j) && jaccard(unmatched[i].doc.set, unmatched[j].doc.set) >= NEAR_COPY) { group.push(unmatched[j]); used.add(j); }
      }
      if (group.length > 1) { used.add(i); newGroups.push(group); }
    }

    const byGroup = new Map<number, number>();
    for (const j of joins) byGroup.set(j.clusterId, (byGroup.get(j.clusterId) || 0) + 1);
    console.log(`   ${joins.length} scans match an existing form-letter group (${byGroup.size} groups); ${newGroups.reduce((n, g) => n + g.length, 0)} form ${newGroups.length} new groups`);
    for (const [clusterId, n] of [...byGroup].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      const t = templates.find(t => t.clusterId === clusterId)!;
      console.log(`     +${n} → group of ${t.size} (${t.doc.id}): ${t.doc.words.slice(0, 14).join(" ")}…`);
    }
    if (options.dryRun || (joins.length === 0 && newGroups.length === 0)) return;

    withTransaction(db, () => {
      const move = db.prepare("UPDATE comment_cluster_membership SET cluster_id = ?, is_representative = 0, similarity_score = ? WHERE comment_id = ?");
      const dropCluster = db.prepare("DELETE FROM comment_clusters WHERE cluster_id = ?");
      const grow = db.prepare("UPDATE comment_clusters SET cluster_size = cluster_size + ? WHERE cluster_id = ?");
      for (const j of joins) {
        move.run(j.clusterId, j.coverage, j.scan.id);
        dropCluster.run(j.scan.cluster_id);
      }
      for (const [clusterId, n] of byGroup) grow.run(n, clusterId);
      for (const g of newGroups) {
        const [rep, ...members] = g;
        for (const m of members) {
          move.run(rep.cluster_id, jaccard(rep.doc.set, m.doc.set), m.id);
          dropCluster.run(m.cluster_id);
        }
        grow.run(members.length, rep.cluster_id);
      }
    });
    console.log(`✅ Moved ${joins.length + newGroups.reduce((n, g) => n + g.length - 1, 0)} scanned submissions into form-letter groups`);
  } finally {
    db.close();
  }
}
