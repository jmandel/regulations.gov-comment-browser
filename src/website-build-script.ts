import { Command } from "commander";
import { openDb } from "./lib/database";
import { mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";

export const buildWebsiteCommand = new Command("build-website")
  .description("Generate static data files for web dashboard")
  .argument("<document-id>", "Document ID (e.g., CMS-2025-0050-0031)")
  .option("-o, --output <dir>", "Output directory", "dist/data")
  .action(buildWebsite);

async function buildWebsite(documentId: string, options: any) {
  const db = openDb(documentId);
  const outputDir = options.output;
  
  console.log(`🏗️  Building website data for ${documentId}`);
  
  // Ensure output directories exist
  await mkdir(outputDir, { recursive: true });
  await mkdir(join(outputDir, "indexes"), { recursive: true });
  
  // Look up docket ID from DB metadata (falls back to document ID)
  const docMeta = db.prepare("SELECT docket_id, title FROM document_metadata LIMIT 1").get() as { docket_id?: string; title?: string } | null;
  const docketId = docMeta?.docket_id || documentId;

  // 1. Generate metadata
  const meta = {
    documentId: docketId,
    sourceDocumentId: documentId,
    title: docMeta?.title || documentId,
    generatedAt: new Date().toISOString(),
    stats: getStats(db),
  };
  await writeJson(join(outputDir, "meta.json"), meta);
  
  // 2. Export theme hierarchy with counts
  const themes = getThemeHierarchy(db);
  await writeJson(join(outputDir, "themes.json"), themes);
  
  // 3. Export theme summaries
  const themeSummaries = getThemeSummaries(db);
  await writeJson(join(outputDir, "theme-summaries.json"), themeSummaries);
  
  // 4. Export entity taxonomy with counts
  const entities = getEntityTaxonomy(db);
  await writeJson(join(outputDir, "entities.json"), entities);
  
  // 5. Export all comments as single file
  await exportAllComments(db, outputDir, docketId);
  
  // 6. Generate cluster report
  await generateClusterReport(db, outputDir);
  
  // 7. Generate indexes for efficient lookups
  await generateIndexes(db, outputDir);

  // 8. Export theme extracts (per-comment, per-theme analysis)
  await exportThemeExtracts(db, outputDir);

  console.log(`✅ Website data built in ${outputDir}`);
  db.close();
}

function getStats(db: any) {
  // Check if clustering tables exist AND have data
  const hasClusteringTables = db.prepare(`
    SELECT name FROM sqlite_master 
    WHERE type='table' AND name='comment_clusters'
  `).get();
  
  const hasClusteringData = hasClusteringTables ? db.prepare(`
    SELECT COUNT(*) as count FROM comment_cluster_membership
  `).get()?.count > 0 : false;
  
  let totalComments;
  if (hasClusteringData) {
    // Get the actual total including cluster sizes
    const clusterStats = db.prepare(`
      SELECT 
        COUNT(*) as total_comments,
        COALESCE(SUM(cluster_size), COUNT(*)) as actual_submissions
      FROM comments c
      LEFT JOIN comment_cluster_membership ccm ON c.id = ccm.comment_id
      LEFT JOIN comment_clusters ccl ON ccm.cluster_id = ccl.cluster_id AND ccm.is_representative = 1
    `).get();
    
    // Use actual_submissions if clustering exists, otherwise fall back to total_comments
    totalComments = clusterStats.actual_submissions || clusterStats.total_comments;
  } else {
    totalComments = db.prepare("SELECT COUNT(*) as count FROM comments").get().count;
  }
  
  return {
    totalComments,
    condensedComments: db.prepare("SELECT COUNT(*) as count FROM condensed_comments WHERE status = 'completed'").get().count,
    totalThemes: db.prepare("SELECT COUNT(*) as count FROM theme_hierarchy").get().count,
    totalEntities: db.prepare("SELECT COUNT(*) as count FROM entity_taxonomy").get().count,
    scoredComments: hasClusteringData 
      ? db.prepare(`
          SELECT COALESCE(SUM(cluster_size), 0) as count
          FROM (
            SELECT DISTINCT ccl.cluster_id, ccl.cluster_size
            FROM comment_theme_extracts cte
            JOIN comment_cluster_membership ccm ON cte.comment_id = ccm.comment_id
            JOIN comment_clusters ccl ON ccm.cluster_id = ccl.cluster_id
            WHERE ccm.is_representative = 1
          )
        `).get().count || db.prepare("SELECT COUNT(DISTINCT comment_id) as count FROM comment_theme_extracts").get().count
      : db.prepare("SELECT COUNT(DISTINCT comment_id) as count FROM comment_theme_extracts").get().count,
    themeSummaries: db.prepare("SELECT COUNT(*) as count FROM theme_summaries").get().count,
  };
}

function getThemeHierarchy(db: any) {
  // Check if detailed_guidelines column exists
  const hasDetailedGuidelines = db.prepare(`
    SELECT COUNT(*) as count 
    FROM pragma_table_info('theme_hierarchy') 
    WHERE name='detailed_guidelines'
  `).get().count > 0;
  
  // Check if clustering data exists
  const hasClusteringData = db.prepare(`
    SELECT COUNT(*) as count 
    FROM pragma_table_info('comment_theme_extracts') 
    WHERE name='cluster_size'
  `).get().count > 0;
  
  let themes;
  if (hasClusteringData) {
    // Include cluster sizes in counts
    themes = db.prepare(`
      SELECT 
        t.code,
        t.description,
        t.level,
        t.parent_code,
        ${hasDetailedGuidelines ? 't.detailed_guidelines' : 'NULL as detailed_guidelines'},
        COALESCE(SUM(cte.cluster_size), COUNT(DISTINCT cte.comment_id)) as comment_count,
        COALESCE(SUM(cte.cluster_size), COUNT(DISTINCT cte.comment_id)) as direct_count,
        0 as touch_count
      FROM theme_hierarchy t
      LEFT JOIN comment_theme_extracts cte ON t.code = cte.theme_code
      GROUP BY t.code
      ORDER BY t.code
    `).all();
  } else {
    // Fallback to simple count
    themes = db.prepare(`
      SELECT 
        t.code,
        t.description,
        t.level,
        t.parent_code,
        ${hasDetailedGuidelines ? 't.detailed_guidelines' : 'NULL as detailed_guidelines'},
        COUNT(DISTINCT cte.comment_id) as comment_count,
        COUNT(DISTINCT cte.comment_id) as direct_count,
        0 as touch_count
      FROM theme_hierarchy t
      LEFT JOIN comment_theme_extracts cte ON t.code = cte.theme_code
      GROUP BY t.code
      ORDER BY t.code
    `).all();
  }
  
  // comment_count rolls up sub-themes: extraction files each point under the most specific theme,
  // so a top-level theme's direct extracts are only a small part of what it covers. Count each
  // comment once per theme (weighted by form-letter cluster size) across the theme and descendants.
  const rollup = new Map<string, Map<string, number>>();
  const extractRows = db.prepare(`SELECT DISTINCT comment_id, theme_code, ${hasClusteringData ? 'COALESCE(cluster_size, 1)' : '1'} AS size FROM comment_theme_extracts`).all() as { comment_id: string; theme_code: string; size: number }[];
  for (const r of extractRows) {
    const parts = r.theme_code.split('.');
    for (let i = 1; i <= parts.length; i++) {
      const code = parts.slice(0, i).join('.');
      if (!rollup.has(code)) rollup.set(code, new Map());
      rollup.get(code)!.set(r.comment_id, r.size);
    }
  }
  for (const t of themes as any[]) {
    let total = 0;
    for (const size of rollup.get(t.code)?.values() ?? []) total += size;
    t.comment_count = total;
  }

  // Build hierarchy without quotes
  return themes.map((t: any) => {
    // Fix truncated descriptions by using the first sentence of detailed_guidelines
    let description = t.description;
    if (t.detailed_guidelines && t.description) {
      // Check if description appears truncated (ends with "U.S" or other incomplete words)
      const seemsTruncated = t.description.match(/\s+\w+\.\w{1,2}$/) || // Ends with abbreviation like "U.S"
                             (!t.description.includes('.') && t.description.length < 50); // Short with no period
      
      if (seemsTruncated) {
        // Try to extract the complete theme name from detailed_guidelines
        // Look for pattern like "Citizen Children. This theme..."
        const match = t.detailed_guidelines.match(/^(.+?)\.\s+This theme/);
        if (match) {
          // Combine truncated description with the completion from guidelines
          const completion = match[1];
          if (!completion.startsWith(t.description)) {
            // The guidelines start with just the completion part
            description = t.description + ". " + completion;
          } else {
            // The guidelines repeat the full description
            description = completion;
          }
        }
      }
    }
    
    return {
      ...t,
      description,
      detailedDescription: t.detailed_guidelines, // Map detailed_guidelines to detailedDescription for frontend
      children: themes.filter((child: any) => child.parent_code === t.code).map((c: any) => c.code)
    };
  });
}

function getThemeSummaries(db: any) {
  // Check if clustering data exists
  const hasClusteringData = db.prepare(`
    SELECT COUNT(*) as count 
    FROM pragma_table_info('comment_theme_extracts') 
    WHERE name='cluster_size'
  `).get().count > 0;
  
  let summaries;
  if (hasClusteringData) {
    // Get cluster-weighted comment count
    summaries = db.prepare(`
      SELECT 
        ts.theme_code,
        ts.structured_sections,
        COALESCE(SUM(cte.cluster_size), ts.comment_count) as comment_count,
        ts.word_count,
        th.description as theme_description
      FROM theme_summaries ts
      JOIN theme_hierarchy th ON ts.theme_code = th.code
      LEFT JOIN comment_theme_extracts cte ON ts.theme_code = cte.theme_code
      GROUP BY ts.theme_code
      ORDER BY ts.theme_code
    `).all();
  } else {
    summaries = db.prepare(`
      SELECT 
        ts.theme_code,
        ts.structured_sections,
        ts.comment_count,
        ts.word_count,
        th.description as theme_description
      FROM theme_summaries ts
      JOIN theme_hierarchy th ON ts.theme_code = th.code
      ORDER BY ts.theme_code
    `).all();
  }
  
  // Parse structured sections and create a map
  const summaryMap: any = {};
  for (const summary of summaries) {
    const sections = JSON.parse(summary.structured_sections);
    
    summaryMap[summary.theme_code] = {
      themeDescription: summary.theme_description,
      commentCount: summary.comment_count,
      wordCount: summary.word_count,
      sections: sections
    };
  }
  
  return summaryMap;
}

function getEntityTaxonomy(db: any) {
  // Check if clustering tables exist AND have data
  const hasClusteringTables = db.prepare(`
    SELECT name FROM sqlite_master 
    WHERE type='table' AND name='comment_cluster_membership'
  `).get();
  
  const hasClusteringData = hasClusteringTables ? db.prepare(`
    SELECT COUNT(*) as count FROM comment_cluster_membership
  `).get()?.count > 0 : false;
  
  let entities;
  if (hasClusteringData) {
    // Include cluster sizes in entity mention counts
    entities = db.prepare(`
      SELECT 
        e.*,
        COALESCE(SUM(COALESCE(ccl.cluster_size, 1)), COUNT(DISTINCT ce.comment_id)) as mention_count
      FROM entity_taxonomy e
      LEFT JOIN comment_entities ce ON e.category = ce.category AND e.label = ce.entity_label
      LEFT JOIN comment_cluster_membership ccm ON ce.comment_id = ccm.comment_id
      LEFT JOIN comment_clusters ccl ON ccm.cluster_id = ccl.cluster_id
      GROUP BY e.category, e.label
      ORDER BY e.category, mention_count DESC
    `).all();
  } else {
    entities = db.prepare(`
      SELECT 
        e.*,
        COUNT(DISTINCT ce.comment_id) as mention_count
      FROM entity_taxonomy e
      LEFT JOIN comment_entities ce ON e.category = ce.category AND e.label = ce.entity_label
      GROUP BY e.category, e.label
      ORDER BY e.category, mention_count DESC
    `).all();
  }
  
  // Group by category
  const taxonomy: any = {};
  for (const entity of entities) {
    if (!taxonomy[entity.category]) {
      taxonomy[entity.category] = [];
    }
    taxonomy[entity.category].push({
      label: entity.label,
      definition: entity.definition,
      terms: JSON.parse(entity.terms),
      mentionCount: entity.mention_count
    });
  }
  
  return taxonomy;
}

// Data layout (version 2), sized for dockets with tens of thousands of comments:
//   comments-index.json        every comment's metadata + one-line summary; form-letter members
//                              point at their representative instead of copying its content
//   comment-details/NNNN.json  { [unitId]: { sections } , [memberId]: { addedText } } (condensed
//                              sections minus oneLineSummary, plus members' full added text)
//   comment-text/NNNN.json     { [unitId]: detailedContent } (full transcription)
//   search/index.json + search/postings.bin   word -> unit inverted index for full-text search
// A "unit" is a comment that carries its own content: a cluster representative, or every
// comment when there is no clustering. Shards hold consecutive units (by ID) and are cut by size.
const DETAIL_SHARD_BYTES = 256 * 1024;
const TEXT_SHARD_BYTES = 512 * 1024;
const ADDED_SNIPPET_CHARS = 160;
const MAX_INDEXED_WORD = 60;
const WORD_RE = /[\p{L}\p{N}]+/gu;

// Must match buildSearchText in dashboard/src/utils/searchParser.ts
function buildSearchText(parts: {
  sections?: any; detailedContent?: string | null; submitter?: string; id: string;
}): string {
  const out: string[] = [];
  const s = parts.sections || {};
  for (const v of [s.oneLineSummary, s.corePosition, parts.detailedContent, s.keyRecommendations, s.mainConcerns, s.commenterProfile]) {
    if (v) out.push(v);
  }
  if (parts.submitter) out.push(parts.submitter);
  out.push(parts.id);
  return out.join(" ").toLowerCase();
}

function writeVarint(buf: number[], n: number) {
  while (n >= 0x80) { buf.push((n & 0x7f) | 0x80); n >>>= 7; }
  buf.push(n);
}

async function exportAllComments(db: any, outputDir: string, documentId: string) {
  console.log("  📄 Exporting comments (index, detail shards, text shards, search index)...");

  for (const stale of ["comments.json", "theme-extracts.json"]) await rm(join(outputDir, stale), { force: true });
  for (const dir of ["comment-details", "comment-text", "search"]) {
    await rm(join(outputDir, dir), { recursive: true, force: true });
    await mkdir(join(outputDir, dir), { recursive: true });
  }

  const hasClusteringData = (db.prepare(`SELECT COUNT(*) as count FROM comment_cluster_membership`).get()?.count || 0) > 0;

  const rows = db.prepare(`
    SELECT
      c.id,
      c.attributes_json,
      ${hasClusteringData ? "ccm.is_representative, ccl.cluster_size, ccl.representative_comment_id" : "NULL as is_representative, NULL as cluster_size, NULL as representative_comment_id"}
    FROM comments c
    ${hasClusteringData ? `LEFT JOIN comment_cluster_membership ccm ON c.id = ccm.comment_id
    LEFT JOIN comment_clusters ccl ON ccm.cluster_id = ccl.cluster_id` : ""}
    ORDER BY c.id
  `).all() as any[];

  const condensed = new Map<string, { s: string; wc: number | null }>();
  for (const r of db.prepare(`SELECT comment_id, structured_sections, word_count FROM condensed_comments WHERE structured_sections IS NOT NULL AND structured_sections != ''`).all() as any[]) {
    condensed.set(r.comment_id, { s: r.structured_sections, wc: r.word_count });
  }
  const getTranscription = db.prepare(`SELECT markdown FROM transcriptions WHERE comment_id = ? AND status = 'completed'`);
  const attachmentCounts = new Map<string, number>();
  for (const r of db.prepare(`SELECT comment_id, COUNT(DISTINCT id) n FROM attachments GROUP BY comment_id`).all() as any[]) {
    attachmentCounts.set(r.comment_id, r.n);
  }
  const themesBy = new Map<string, string[]>();
  for (const r of db.prepare(`SELECT comment_id, theme_code FROM comment_theme_extracts ORDER BY theme_code`).all() as any[]) {
    let a = themesBy.get(r.comment_id); if (!a) themesBy.set(r.comment_id, a = []); a.push(r.theme_code);
  }
  const entityKeys: string[] = [];
  const entityKeyIndex = new Map<string, number>();
  const entitiesBy = new Map<string, number[]>();
  for (const r of db.prepare(`SELECT comment_id, category, entity_label FROM comment_entities ORDER BY category, entity_label`).all() as any[]) {
    if (!r.category || !r.entity_label) continue;
    const key = `${r.category}|${r.entity_label}`;
    let idx = entityKeyIndex.get(key);
    if (idx === undefined) { idx = entityKeys.length; entityKeys.push(key); entityKeyIndex.set(key, idx); }
    let a = entitiesBy.get(r.comment_id); if (!a) entitiesBy.set(r.comment_id, a = []); a.push(idx);
  }
  // Form-letter members' own added text (non-promoted; promoted members are their own units)
  const additions = new Map<string, { words: number; text: string }>();
  const hasAdditions = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='form_letter_additions'`).get();
  if (hasAdditions) {
    for (const r of db.prepare(`SELECT comment_id, added_word_count, added_text FROM form_letter_additions WHERE promoted = 0 AND added_word_count > 0`).all() as any[]) {
      additions.set(r.comment_id, { words: r.added_word_count, text: r.added_text });
    }
  }

  const isMember = (r: any) => hasClusteringData && r.is_representative !== 1 && r.representative_comment_id && r.representative_comment_id !== r.id;

  // Assign units to shards in ID order; members' added text goes in their representative's detail shard
  const membersByRep = new Map<string, string[]>();
  for (const r of rows) if (isMember(r) && additions.has(r.id)) {
    let a = membersByRep.get(r.representative_comment_id); if (!a) membersByRep.set(r.representative_comment_id, a = []); a.push(r.id);
  }

  const index: any[] = [];
  const unitIds: string[] = [];
  const postings = new Map<string, number[]>();
  const detailShardOf = new Map<string, number>();
  const textShardOf = new Map<string, number>();
  let detailShard: Record<string, any> = {}, detailBytes = 0, detailN = 0;
  let textShard: Record<string, string> = {}, textBytes = 0, textN = 0;
  const pad = (n: number) => String(n).padStart(4, "0");
  const flushDetail = async () => {
    if (!detailBytes) return;
    await writeFile(join(outputDir, "comment-details", `${pad(detailN++)}.json`), JSON.stringify(detailShard));
    detailShard = {}; detailBytes = 0;
  };
  const flushText = async () => {
    if (!textBytes) return;
    await writeFile(join(outputDir, "comment-text", `${pad(textN++)}.json`), JSON.stringify(textShard));
    textShard = {}; textBytes = 0;
  };
  const wordCountOf = new Map<string, number>();
  const summaryOf = new Map<string, string>();
  let detailedTotal = 0;

  for (const r of rows) {
    if (isMember(r)) continue;
    const attrs = JSON.parse(r.attributes_json);
    const submitter = attrs.organization || `${attrs.firstName || ''} ${attrs.lastName || ''}`.trim() || 'Anonymous';
    let sections: any = null;
    const cc = condensed.get(r.id);
    if (cc) {
      try { sections = JSON.parse(cc.s); } catch { console.warn(`Failed to parse structured sections for comment ${r.id}`); }
      if (cc.wc != null) wordCountOf.set(r.id, cc.wc);
    }
    const detailedContent = (getTranscription.get(r.id) as any)?.markdown || null;
    if (sections?.oneLineSummary) summaryOf.set(r.id, sections.oneLineSummary);

    // Search index over this unit's text
    const ordinal = unitIds.length;
    unitIds.push(r.id);
    const text = buildSearchText({ sections, detailedContent, submitter, id: r.id });
    for (const w of new Set(text.match(WORD_RE) || [])) {
      if (w.length > MAX_INDEXED_WORD) continue;
      let p = postings.get(w); if (!p) postings.set(w, p = []); p.push(ordinal);
    }

    // Detail shard: condensed sections (minus the one-line summary, which is in the index) + members' added text
    const detail: Record<string, any> = {};
    if (sections) {
      const { oneLineSummary: _omit, ...rest } = sections;
      if (Object.keys(rest).length) detail[r.id] = { sections: rest };
    }
    for (const m of membersByRep.get(r.id) || []) detail[m] = { addedText: additions.get(m)!.text };
    const detailJson = JSON.stringify(detail);
    if (detailJson.length > 2) {
      Object.assign(detailShard, detail);
      detailBytes += detailJson.length;
      detailShardOf.set(r.id, detailN);
      if (detailBytes >= DETAIL_SHARD_BYTES) await flushDetail();
    }
    if (detailedContent) {
      textShard[r.id] = detailedContent;
      textBytes += detailedContent.length;
      detailedTotal++;
      textShardOf.set(r.id, textN);
      if (textBytes >= TEXT_SHARD_BYTES) await flushText();
    }
  }
  await flushDetail();
  await flushText();

  const submitterTypes: string[] = [];
  const typeIdx = new Map<string, number>();
  const typeIndex = (t: string) => {
    let i = typeIdx.get(t);
    if (i === undefined) { i = submitterTypes.length; submitterTypes.push(t); typeIdx.set(t, i); }
    return i;
  };
  for (const r of rows) {
    const attrs = JSON.parse(r.attributes_json);
    const member = isMember(r);
    const repId = member ? r.representative_comment_id : r.id;
    const entry: any = {
      id: r.id,
      submitter: attrs.organization || `${attrs.firstName || ''} ${attrs.lastName || ''}`.trim() || 'Anonymous',
      submitterType: typeIndex(attrs.category || (attrs.organization ? 'Organization' : 'Individual')),
      date: attrs.postedDate || attrs.receiveDate,
    };
    const location = [attrs.city, attrs.stateProvinceRegion, attrs.country].filter(Boolean).join(', ');
    if (location) entry.location = location;
    if ((attachmentCounts.get(r.id) || 0) > 0) entry.hasAttachments = true;
    if (member) {
      entry.rep = repId;
      const add = additions.get(r.id);
      if (add) {
        entry.addedWords = add.words;
        entry.addedSnippet = add.text.length > ADDED_SNIPPET_CHARS ? add.text.slice(0, ADDED_SNIPPET_CHARS).trimEnd() + '…' : add.text;
        entry.detailShard = detailShardOf.get(repId);
      }
    } else {
      if (hasClusteringData) {
        entry.isRep = true;
        if ((r.cluster_size || 1) > 1) entry.clusterSize = r.cluster_size;
      }
      const wc = wordCountOf.get(r.id);
      if (wc != null) entry.wordCount = wc;
      const summary = summaryOf.get(r.id);
      if (summary) entry.summary = summary;
      if (detailShardOf.has(r.id)) entry.detailShard = detailShardOf.get(r.id);
      if (textShardOf.has(r.id)) entry.textShard = textShardOf.get(r.id);
      const themes = themesBy.get(r.id);
      if (themes) entry.themes = themes;
      const ents = entitiesBy.get(r.id);
      if (ents) entry.entities = ents;
    }
    index.push(entry);
  }

  await writeFile(join(outputDir, "comments-index.json"), JSON.stringify({
    version: 2,
    documentId,
    clustered: hasClusteringData,
    submitterTypes,
    entityKeys,
    comments: index,
  }));

  // Inverted index: sorted vocabulary, per-word byte length of its posting list, and the
  // concatenated posting lists in one binary file. A list is unit ordinals, delta + varint
  // encoded; for words in more than 1/8 of units it is a bitmap instead, marked by a negative length.
  const words = [...postings.keys()].sort();
  const bytes: number[] = [];
  const lens: number[] = [];
  const bitmapBytes = Math.ceil(unitIds.length / 8);
  for (const w of words) {
    const list = postings.get(w)!;
    const start = bytes.length;
    if (list.length > unitIds.length / 8) {
      const bm = new Uint8Array(bitmapBytes);
      for (const o of list) bm[o >> 3] |= 1 << (o & 7);
      for (const b of bm) bytes.push(b);
      lens.push(-bitmapBytes);
      continue;
    }
    let prev = -1;
    for (const o of list) { writeVarint(bytes, o - prev); prev = o; }
    lens.push(bytes.length - start);
  }
  await writeFile(join(outputDir, "search", "postings.bin"), new Uint8Array(bytes));
  await writeFile(join(outputDir, "search", "index.json"), JSON.stringify({ version: 1, maxWord: MAX_INDEXED_WORD, units: unitIds, words, lens }));

  console.log(`  ✅ Exported ${index.length} comments (${unitIds.length} units, ${detailedTotal} with full text) in ${detailN} detail + ${textN} text shards; search index ${words.length} words, ${(bytes.length / 1e6).toFixed(1)} MB postings`);
}

async function generateClusterReport(db: any, outputDir: string) {
  console.log("  📊 Generating cluster report...");
  
  // Check if clustering exists
  const hasClusteringData = db.prepare(`
    SELECT COUNT(*) as count FROM comment_cluster_membership
  `).get()?.count > 0;
  
  if (!hasClusteringData) {
    console.log("  ⏭️  No clustering data found, skipping cluster report");
    return;
  }
  
  // Get cluster information
  const clusters = db.prepare(`
    SELECT 
      cc.cluster_id,
      cc.representative_comment_id,
      cc.cluster_size,
      GROUP_CONCAT(ccm.comment_id) as member_ids,
      json_extract(c.attributes_json, '$.submitterType') as submitter_type,
      json_extract(c.attributes_json, '$.organization') as organization,
      substr(json_extract(c.attributes_json, '$.comment'), 1, 200) as snippet
    FROM comment_clusters cc
    JOIN comment_cluster_membership ccm ON cc.cluster_id = ccm.cluster_id
    JOIN comments c ON cc.representative_comment_id = c.id
    GROUP BY cc.cluster_id
    ORDER BY cc.cluster_size DESC, cc.cluster_id
  `).all();
  
  // Get cluster size distribution
  const distribution = db.prepare(`
    SELECT 
      cluster_size,
      COUNT(*) as count
    FROM comment_clusters
    GROUP BY cluster_size
    ORDER BY cluster_size
  `).all();
  
  // Format cluster data
  const clusterReport = {
    summary: {
      totalClusters: clusters.length,
      totalCommentsClustered: db.prepare("SELECT COUNT(*) as count FROM comment_cluster_membership").get().count,
      singletons: distribution.find(d => d.cluster_size === 1)?.count || 0,
      largestClusterSize: Math.max(...distribution.map(d => d.cluster_size)),
      distribution: distribution
    },
    clusters: clusters.map(c => ({
      id: c.cluster_id,
      size: c.cluster_size,
      representative: c.representative_comment_id,
      members: c.member_ids.split(','),
      metadata: {
        submitterType: c.submitter_type,
        organization: c.organization,
        snippetPreview: c.snippet ? c.snippet.substring(0, 100) + (c.snippet.length > 100 ? '...' : '') : null
      }
    }))
  };
  
  await writeJson(join(outputDir, "cluster-report.json"), clusterReport);
  console.log(`  ✅ Generated cluster report with ${clusters.length} clusters`);
}

async function generateIndexes(db: any, outputDir: string) {
  // Theme -> Comment index (all comments with theme extracts)
  const themeIndex = db.prepare(`
    SELECT theme_code, comment_id
    FROM comment_theme_extracts
    ORDER BY theme_code, comment_id
  `).all();
  
  const themeMap: any = {};
  for (const row of themeIndex) {
    if (!themeMap[row.theme_code]) {
      themeMap[row.theme_code] = { direct: [], touches: [] };
    }
    themeMap[row.theme_code].direct.push(row.comment_id);
  }
  
  await writeJson(join(outputDir, "indexes", "theme-comments.json"), themeMap);
  
  // Entity -> Comment index
  const entityIndex = db.prepare(`
    SELECT category, entity_label, comment_id
    FROM comment_entities
    ORDER BY category, entity_label, comment_id
  `).all();
  
  const entityMap: any = {};
  for (const row of entityIndex) {
    const key = `${row.category}|${row.entity_label}`;
    if (!entityMap[key]) {
      entityMap[key] = [];
    }
    entityMap[key].push(row.comment_id);
  }
  
  await writeJson(join(outputDir, "indexes", "entity-comments.json"), entityMap);
}

async function exportThemeExtracts(db: any, outputDir: string) {
  console.log("  📋 Exporting theme extracts...");

  // Check if the table exists
  const hasTable = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type='table' AND name='comment_theme_extracts'
  `).get();

  if (!hasTable) {
    console.log("  ⏭️  No comment_theme_extracts table, skipping");
    return;
  }

  const rows = db.prepare(`
    SELECT theme_code, comment_id, extract_json
    FROM comment_theme_extracts
    ORDER BY theme_code, comment_id
  `).all();

  if (rows.length === 0) {
    console.log("  ⏭️  No theme extracts found, skipping");
    return;
  }

  const extractsMap: any = {};
  for (const row of rows) {
    if (!extractsMap[row.theme_code]) {
      extractsMap[row.theme_code] = {};
    }
    try {
      const parsed = JSON.parse(row.extract_json);
      // Unwrap the { relevance, extract: { ... } } wrapper if present
      extractsMap[row.theme_code][row.comment_id] = parsed.extract || parsed;
    } catch (e) {
      console.warn(`  ⚠️  Failed to parse extract for ${row.comment_id}/${row.theme_code}`);
    }
  }

  // One file per theme, loaded when that theme's page opens (a single file is ~100 MB at 40k comments)
  const dir = join(outputDir, "theme-extracts");
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const [code, map] of Object.entries(extractsMap)) {
    await writeFile(join(dir, `${code}.json`), JSON.stringify(map));
  }
  console.log(`  ✅ Exported theme extracts for ${Object.keys(extractsMap).length} themes (${rows.length} total extracts)`);
}

async function writeJson(path: string, data: any) {
  await writeFile(path, JSON.stringify(data, null, 2));
}
