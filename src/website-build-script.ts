import { Command } from "commander";
import { openDb } from "./lib/database";
import { mkdir, writeFile } from "fs/promises";
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
  
  // 1. Generate metadata
  const meta = {
    documentId,
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
  await exportAllComments(db, outputDir, documentId);
  
  // 6. Generate cluster report
  await generateClusterReport(db, outputDir);
  
  // 7. Generate indexes for efficient lookups
  await generateIndexes(db, outputDir);
  
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

async function exportAllComments(db: any, outputDir: string, documentId: string) {
  console.log("  📄 Exporting all comments...");
  
  // Check if clustering tables exist AND have data
  const hasClusteringTables = db.prepare(`
    SELECT name FROM sqlite_master 
    WHERE type='table' AND name='comment_cluster_membership'
  `).get();
  
  const hasClusteringData = hasClusteringTables ? db.prepare(`
    SELECT COUNT(*) as count FROM comment_cluster_membership
  `).get()?.count > 0 : false;
  
  let comments;
  if (hasClusteringData) {
    // Include clustering data if tables exist
    comments = db.prepare(`
      SELECT 
        c.id,
        c.attributes_json,
        COALESCE(cc.structured_sections, cc_rep.structured_sections) as structured_sections,
        COALESCE(cc.word_count, cc_rep.word_count) as word_count,
        GROUP_CONCAT(DISTINCT cte.theme_code) as theme_codes,
        GROUP_CONCAT(DISTINCT ce.category || '|' || ce.entity_label) as entities,
        COUNT(DISTINCT a.id) as attachment_count,
        ccl.cluster_size,
        ccm.is_representative,
        ccl.representative_comment_id as cluster_representative_id,
        CASE WHEN cc.structured_sections IS NULL AND cc_rep.structured_sections IS NOT NULL THEN 1 ELSE 0 END as uses_representative_summary
      FROM comments c
      LEFT JOIN condensed_comments cc ON c.id = cc.comment_id
      LEFT JOIN comment_cluster_membership ccm ON c.id = ccm.comment_id
      LEFT JOIN comment_clusters ccl ON ccm.cluster_id = ccl.cluster_id
      LEFT JOIN condensed_comments cc_rep ON ccl.representative_comment_id = cc_rep.comment_id
      LEFT JOIN comment_theme_extracts cte ON c.id = cte.comment_id
      LEFT JOIN comment_entities ce ON c.id = ce.comment_id
      LEFT JOIN attachments a ON c.id = a.comment_id
      GROUP BY c.id
      ORDER BY c.id
    `).all();
  } else {
    // Fallback query without clustering tables
    comments = db.prepare(`
      SELECT 
        c.id,
        c.attributes_json,
        cc.structured_sections,
        cc.word_count,
        GROUP_CONCAT(DISTINCT cte.theme_code) as theme_codes,
        GROUP_CONCAT(DISTINCT ce.category || '|' || ce.entity_label) as entities,
        COUNT(DISTINCT a.id) as attachment_count,
        NULL as cluster_size,
        NULL as is_representative
      FROM comments c
      LEFT JOIN condensed_comments cc ON c.id = cc.comment_id
      LEFT JOIN comment_theme_extracts cte ON c.id = cte.comment_id
      LEFT JOIN comment_entities ce ON c.id = ce.comment_id
      LEFT JOIN attachments a ON c.id = a.comment_id
      GROUP BY c.id
      ORDER BY c.id
    `).all();
  }
  
  // Process comments
  const processedComments = comments.map((c: any) => {
    const attrs = JSON.parse(c.attributes_json);
    
    // Parse theme codes - all themes that have extracts for this comment
    const themeScores: any = {};
    if (c.theme_codes) {
      for (const code of c.theme_codes.split(',')) {
        themeScores[code] = 1;  // Use 1 to indicate presence
      }
    }
    
    // Parse entities
    const entities: any[] = [];
    if (c.entities) {
      for (const entity of c.entities.split(',')) {
        const [category, label] = entity.split('|');
        if (category && label) {  // Only add if both category and label are defined
          entities.push({ category, label });
        }
      }
    }
    
    const wordCount = c.word_count ?? 0

    // Parse structured sections if available
    let structuredSections = null;
    if (c.structured_sections) {
      try {
        structuredSections = JSON.parse(c.structured_sections);
      } catch (e) {
        console.warn(`Failed to parse structured sections for comment ${c.id}:`, e);
      }
    }
    
    return {
      id: c.id,
      documentId,
      submitter: attrs.organization || `${attrs.firstName || ''} ${attrs.lastName || ''}`.trim() || 'Anonymous',
      submitterType: attrs.category || (attrs.organization ? 'Organization' : 'Individual'),
      date: attrs.postedDate || attrs.receiveDate,
      location: [attrs.city, attrs.stateProvinceRegion, attrs.country].filter(Boolean).join(', '),
      structuredSections,
      themeScores,
      entities,
      hasAttachments: c.attachment_count > 0,
      wordCount,
      clusterSize: c.cluster_size || 1,
      isClusterRepresentative: c.is_representative === 1,
      clusterRepresentativeId: c.cluster_representative_id || null,
      isAlignedSummary: c.uses_representative_summary === 1,
    };
  });
  
  await writeJson(join(outputDir, "comments.json"), processedComments);
  console.log(`  ✅ Exported ${processedComments.length} comments`);
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

async function writeJson(path: string, data: any) {
  await writeFile(path, JSON.stringify(data, null, 2));
}
