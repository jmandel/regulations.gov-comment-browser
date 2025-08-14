import { Command } from "commander";
import { openDb, withTransaction } from "../lib/database";
import type { Database } from "bun:sqlite";
import { initDebug } from "../lib/debug";

export const clusterCommentsExactCommand = new Command("cluster-comments-exact")
  .description("Cluster identical comments (exact match only) - fast version for testing")
  .argument("<document-id>", "Document ID (e.g., CMS-2025-0050-0031)")
  .option("--force", "Recalculate clusters even if they already exist")
  .option("-d, --debug", "Enable debug output")
  .action(clusterCommentsExact);

async function clusterCommentsExact(documentId: string, options: any) {
  await initDebug(options.debug);
  
  const db = openDb(documentId);
  
  console.log(`🔍 Clustering comments for document ${documentId} (exact match only)`);
  
  // Check if clustering already exists
  const existingStatus = db.prepare(
    "SELECT * FROM clustering_status WHERE status = 'completed' ORDER BY created_at DESC LIMIT 1"
  ).get();
  
  if (existingStatus && !options.force) {
    console.log(`✅ Clustering already exists from ${existingStatus.created_at}`);
    console.log(`   Total clusters: ${existingStatus.total_clusters}`);
    console.log(`   Representatives: ${existingStatus.representative_count}`);
    console.log(`   Duplicates filtered: ${existingStatus.duplicates_filtered}`);
    console.log(`   Use --force to recalculate`);
    return;
  }
  
  if (options.force && existingStatus) {
    console.log(`🔄 Force flag set, clearing existing clustering data...`);
    withTransaction(db, () => {
      db.prepare("DELETE FROM comment_cluster_membership").run();
      db.prepare("DELETE FROM comment_clusters").run();
      db.prepare("DELETE FROM clustering_status").run();
    });
  }
  
  // Group comments by exact text
  console.log(`📊 Grouping comments by exact text...`);
  const groups = db.prepare(`
    SELECT 
      json_extract(attributes_json, '$.comment') as comment_text,
      GROUP_CONCAT(id) as comment_ids,
      COUNT(*) as group_size
    FROM comments
    WHERE json_extract(attributes_json, '$.comment') IS NOT NULL
    GROUP BY comment_text
    ORDER BY group_size DESC
  `).all() as Array<{
    comment_text: string;
    comment_ids: string;
    group_size: number;
  }>;
  
  console.log(`   Found ${groups.length} unique comment texts from ${groups.reduce((sum, g) => sum + g.group_size, 0)} total comments`);
  
  // Store clusters in database
  console.log(`💾 Storing cluster data in database...`);
  
  withTransaction(db, () => {
    let totalComments = 0;
    let duplicatesFiltered = 0;
    let clusterId = 0;
    
    for (const group of groups) {
      const commentIds = group.comment_ids.split(',');
      totalComments += commentIds.length;
      
      // Select the longest comment ID as representative (arbitrary but consistent)
      const representativeId = commentIds[0];
      
      // Insert cluster record
      db.prepare(`
        INSERT INTO comment_clusters (
          cluster_id,
          representative_comment_id,
          cluster_size,
          similarity_threshold,
          cluster_method,
          created_at
        ) VALUES (?, ?, ?, 1.0, 'exact', datetime('now'))
      `).run(
        clusterId,
        representativeId,
        commentIds.length
      );
      
      if (commentIds.length > 1) {
        duplicatesFiltered += commentIds.length - 1;
      }
      
      // Insert cluster membership
      for (const commentId of commentIds) {
        db.prepare(`
          INSERT INTO comment_cluster_membership (
            comment_id,
            cluster_id,
            is_representative,
            similarity_score,
            created_at
          ) VALUES (?, ?, ?, 1.0, datetime('now'))
        `).run(
          commentId,
          clusterId,
          commentId === representativeId ? 1 : 0
        );
      }
      
      clusterId++;
    }
    
    // Insert clustering status
    db.prepare(`
      INSERT INTO clustering_status (
        total_comments,
        total_clusters,
        representative_count,
        duplicates_filtered,
        similarity_threshold,
        min_cluster_size,
        cluster_method,
        status,
        created_at,
        completed_at
      ) VALUES (?, ?, ?, ?, 1.0, 1, 'exact', 'completed', datetime('now'), datetime('now'))
    `).run(
      totalComments,
      groups.length,
      groups.length,  // Each cluster has one representative
      duplicatesFiltered
    );
  });
  
  // Report statistics
  const largestCluster = groups[0];
  const stats = {
    totalComments: groups.reduce((sum, g) => sum + g.group_size, 0),
    totalClusters: groups.length,
    duplicatesFiltered: groups.reduce((sum, g) => sum + Math.max(0, g.group_size - 1), 0),
    largestClusterSize: largestCluster.group_size
  };
  
  const reductionPercent = ((stats.duplicatesFiltered / stats.totalComments) * 100).toFixed(1);
  
  console.log(`\n✅ Clustering complete!`);
  console.log(`   Total comments: ${stats.totalComments}`);
  console.log(`   Unique clusters: ${stats.totalClusters}`);
  console.log(`   Duplicates filtered: ${stats.duplicatesFiltered} (${reductionPercent}% reduction)`);
  console.log(`   Largest cluster: ${stats.largestClusterSize} identical comments`);
  
  // Show top 5 clusters
  console.log(`\n📊 Top 5 largest clusters:`);
  for (let i = 0; i < Math.min(5, groups.length); i++) {
    const group = groups[i];
    const preview = group.comment_text.substring(0, 60).replace(/\n/g, ' ');
    console.log(`   ${i + 1}. ${group.group_size} comments: "${preview}..."`);
  }
}