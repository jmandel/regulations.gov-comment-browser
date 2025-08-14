import { Command } from "commander";
import { openDb, withTransaction } from "../lib/database";
import type { Database } from "bun:sqlite";
import { initDebug } from "../lib/debug";
import { loadComments, enrichComment } from "../lib/comment-processing";
import type { RawComment, Attachment, EnrichedComment } from "../types";

export const clusterCommentsCommand = new Command("cluster-comments")
  .description("Cluster similar comments and store cluster membership in database")
  .argument("<document-id>", "Document ID (e.g., CMS-2025-0050-0031)")
  .option("--similarity-threshold <n>", "Similarity threshold for clustering (default: 0.8)", parseFloat)
  .option("--min-cluster-size <n>", "Minimum cluster size to keep as cluster (default: 4)", parseInt)
  .option("--force", "Recalculate clusters even if they already exist")
  .option("-d, --debug", "Enable debug output")
  .option("--method <method>", "Clustering method (default: jaccard)", "jaccard")
  .action(clusterComments);

async function clusterComments(documentId: string, options: any) {
  await initDebug(options.debug);
  
  const db = openDb(documentId);
  const threshold = options.similarityThreshold || 0.8;
  const minClusterSize = options.minClusterSize || 4;
  const method = options.method || 'jaccard';
  
  console.log(`🔍 Clustering comments for document ${documentId}`);
  console.log(`   Similarity threshold: ${threshold}`);
  console.log(`   Min cluster size: ${minClusterSize}`);
  console.log(`   Method: ${method}`);
  
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
  
  // Load all raw comments and attachments
  console.log(`📊 Loading comments...`);
  const { comments: rawComments, attachments } = loadComments(db);
  console.log(`📊 Loaded ${rawComments.length} raw comments`);
  
  // Enrich comments to get full content including attachments
  console.log(`📊 Enriching comments with attachment content...`);
  const enrichedComments: EnrichedComment[] = [];
  
  for (const rawComment of rawComments) {
    const enriched = await enrichComment(rawComment, attachments, { includePdfs: true });
    if (enriched) {
      enrichedComments.push(enriched);
    }
  }
  
  console.log(`📊 Enriched ${enrichedComments.length} comments for clustering`);
  
  // Perform clustering
  console.log(`🔍 Calculating similarity and clustering...`);
  const clusters = await performClustering(enrichedComments, threshold, method);
  
  // Disaggregate small clusters
  const finalClusters = disaggregateSmallClusters(clusters, minClusterSize);
  
  // Store results in database
  console.log(`💾 Storing cluster data in database...`);
  storeClustersInDatabase(db, finalClusters, threshold, minClusterSize, method, enrichedComments.length);
  
  // Report statistics
  const stats = getClusterStatistics(finalClusters, enrichedComments.length);
  console.log(`\n✅ Clustering complete!`);
  console.log(`   Total comments: ${stats.totalComments}`);
  console.log(`   Unique clusters: ${stats.totalClusters}`);
  console.log(`   Representative comments: ${stats.representativeCount}`);
  console.log(`   Duplicates filtered: ${stats.duplicatesFiltered} (${stats.reductionPercent}% reduction)`);
  console.log(`   Largest cluster: ${stats.largestClusterSize} identical comments`);
  
  if (stats.disaggregatedClusters > 0) {
    console.log(`   Small clusters disaggregated: ${stats.disaggregatedClusters}`);
  }
}

// Clustering implementation with optimization
async function performClustering(
  comments: EnrichedComment[],
  threshold: number,
  method: string
): Promise<Map<number, EnrichedComment[]>> {
  console.log(`   Processing ${comments.length} comments...`);
  
  // First pass: Group by exact content hash for efficiency
  // Include BOTH comment text AND attachments in the hash
  const exactMatches = new Map<string, EnrichedComment[]>();
  
  for (const comment of comments) {
    // Extract both comment text and attachments for hashing
    const parts = comment.content.split('=== COMMENT TEXT ===');
    let contentForHash = '';
    
    if (parts.length > 1) {
      // Get comment text
      const commentText = parts[1].split('=== ATTACHMENTS ===')[0];
      contentForHash += commentText.trim().toLowerCase().replace(/\s+/g, ' ');
      
      // Also include attachment content if present
      const attachmentParts = parts[1].split('=== ATTACHMENTS ===');
      if (attachmentParts.length > 1) {
        // Include attachment text in hash (normalized)
        contentForHash += '|||' + attachmentParts[1].trim().toLowerCase().replace(/\s+/g, ' ');
      }
    } else {
      contentForHash = comment.content.trim().toLowerCase().replace(/\s+/g, ' ');
    }
    
    if (!exactMatches.has(contentForHash)) {
      exactMatches.set(contentForHash, []);
    }
    exactMatches.get(contentForHash)!.push(comment);
  }
  
  console.log(`   Found ${exactMatches.size} unique content patterns`);
  
  // Second pass: Cluster the unique patterns
  const clusters = new Map<number, EnrichedComment[]>();
  let nextClusterId = 0;
  const representatives = Array.from(exactMatches.entries());
  let processed = 0;
  
  for (const [contentHash, groupComments] of representatives) {
    processed++;
    if (processed % 100 === 0) {
      console.log(`   Clustering progress: ${processed}/${representatives.length}`);
    }
    
    let assigned = false;
    // Extract comment text AND attachments for comparison
    const fullContent = groupComments[0].content;
    const parts = fullContent.split('=== COMMENT TEXT ===');
    let textForComparison = '';
    
    if (parts.length > 1) {
      // Include both comment text and attachment content
      textForComparison = parts[1].trim(); // This includes everything after COMMENT TEXT
    } else {
      textForComparison = fullContent.trim();
    }
    
    // Check if this group belongs to any existing cluster
    for (const [clusterId, clusterComments] of clusters.entries()) {
      // Use first comment as representative for comparison
      const representative = clusterComments[0];
      const repParts = representative.content.split('=== COMMENT TEXT ===');
      const representativeText = (repParts.length > 1 ? repParts[1].trim() : representative.content.trim());
      
      const similarity = calculateSimilarity(textForComparison, representativeText, method);
      
      if (similarity >= threshold) {
        // Add all comments from this group to the cluster
        clusterComments.push(...groupComments);
        assigned = true;
        break;
      }
    }
    
    // If not assigned to any cluster, create a new one
    if (!assigned) {
      clusters.set(nextClusterId++, groupComments);
    }
  }
  
  console.log(`   Created ${clusters.size} clusters`);
  
  return clusters;
}

// Calculate similarity based on method
function calculateSimilarity(text1: string, text2: string, method: string): number {
  switch (method) {
    case 'jaccard':
      return calculateJaccardSimilarity(text1, text2);
    default:
      throw new Error(`Unknown clustering method: ${method}`);
  }
}

// Jaccard similarity calculation
function calculateJaccardSimilarity(text1: string, text2: string): number {
  const normalize = (text: string) => 
    text.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 2); // Filter out short words
  
  const words1 = new Set(normalize(text1));
  const words2 = new Set(normalize(text2));
  
  const intersection = new Set([...words1].filter(x => words2.has(x)));
  const union = new Set([...words1, ...words2]);
  
  return union.size === 0 ? 0 : intersection.size / union.size;
}

// Disaggregate small clusters
function disaggregateSmallClusters(
  clusters: Map<number, EnrichedComment[]>,
  minClusterSize: number
): Map<number, EnrichedComment[]> {
  const finalClusters = new Map<number, EnrichedComment[]>();
  let nextClusterId = 0;
  
  for (const [_, clusterComments] of clusters.entries()) {
    if (clusterComments.length >= minClusterSize) {
      // Keep as cluster
      finalClusters.set(nextClusterId++, clusterComments);
    } else {
      // Disaggregate - each comment becomes its own cluster
      for (const comment of clusterComments) {
        finalClusters.set(nextClusterId++, [comment]);
      }
    }
  }
  
  return finalClusters;
}

// Store clusters in database
function storeClustersInDatabase(
  db: Database,
  clusters: Map<number, EnrichedComment[]>,
  threshold: number,
  minClusterSize: number,
  method: string,
  totalComments: number
) {
  withTransaction(db, () => {
    let representativeCount = 0;
    let duplicatesFiltered = 0;
    
    // Insert each cluster
    for (const [_, clusterComments] of clusters.entries()) {
      // Select representative (longest comment)
      const representative = clusterComments.reduce((longest, current) => 
        current.content.length > longest.content.length ? current : longest
      );
      
      // Insert cluster record
      const result = db.prepare(`
        INSERT INTO comment_clusters (
          representative_comment_id,
          cluster_size,
          similarity_threshold,
          cluster_method,
          created_at
        ) VALUES (?, ?, ?, ?, datetime('now'))
      `).run(
        representative.id,
        clusterComments.length,
        threshold,
        method
      );
      
      const clusterId = result.lastInsertRowid;
      representativeCount++;
      
      if (clusterComments.length > 1) {
        duplicatesFiltered += clusterComments.length - 1;
      }
      
      // Insert cluster membership for all comments
      for (const comment of clusterComments) {
        const isRepresentative = comment.id === representative.id;
        // Extract comment text AND attachments for similarity calculation
        const commentParts = comment.content.split('=== COMMENT TEXT ===');
        const commentText = (commentParts.length > 1 ? commentParts[1].trim() : comment.content.trim());
        const repParts = representative.content.split('=== COMMENT TEXT ===');
        const repText = (repParts.length > 1 ? repParts[1].trim() : representative.content.trim());
        const similarity = isRepresentative ? 1.0 : 
          calculateSimilarity(commentText, repText, method);
        
        db.prepare(`
          INSERT INTO comment_cluster_membership (
            comment_id,
            cluster_id,
            is_representative,
            similarity_score,
            created_at
          ) VALUES (?, ?, ?, ?, datetime('now'))
        `).run(
          comment.id,
          clusterId,
          isRepresentative ? 1 : 0,
          similarity
        );
      }
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', datetime('now'), datetime('now'))
    `).run(
      totalComments,
      clusters.size,
      representativeCount,
      duplicatesFiltered,
      threshold,
      minClusterSize,
      method
    );
  });
}

// Get cluster statistics
function getClusterStatistics(
  clusters: Map<number, EnrichedComment[]>,
  totalComments: number
) {
  let largestClusterSize = 0;
  let representativeCount = 0;
  let duplicatesFiltered = 0;
  let disaggregatedClusters = 0;
  
  for (const [_, clusterComments] of clusters.entries()) {
    representativeCount++;
    
    if (clusterComments.length > largestClusterSize) {
      largestClusterSize = clusterComments.length;
    }
    
    if (clusterComments.length > 1) {
      duplicatesFiltered += clusterComments.length - 1;
    }
    
    if (clusterComments.length === 1) {
      // This might have been disaggregated
      disaggregatedClusters++;
    }
  }
  
  const reductionPercent = totalComments > 0 
    ? ((duplicatesFiltered / totalComments) * 100).toFixed(1)
    : "0.0";
  
  return {
    totalComments,
    totalClusters: clusters.size,
    representativeCount,
    duplicatesFiltered,
    reductionPercent,
    largestClusterSize,
    disaggregatedClusters
  };
}