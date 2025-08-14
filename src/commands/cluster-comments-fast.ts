import { Command } from "commander";
import { openDb, withTransaction } from "../lib/database";
import type { Database } from "bun:sqlite";
import { initDebug } from "../lib/debug";
import { loadComments, enrichComment } from "../lib/comment-processing";
import type { EnrichedComment } from "../types";

export const clusterCommentsFastCommand = new Command("cluster-comments-fast")
  .description("Fast clustering using bag-of-words/ngrams approach")
  .argument("<document-id>", "Document ID (e.g., CMS-2025-0050-0031)")
  .option("--similarity-threshold <n>", "Similarity threshold (default: 0.8)", parseFloat)
  .option("--min-cluster-size <n>", "Minimum cluster size (default: 4)", parseInt)
  .option("--force", "Recalculate clusters even if they exist")
  .option("-d, --debug", "Enable debug output")
  .option("--ngram-size <n>", "Word n-gram size (default: 3)", parseInt)
  .option("--max-ngram <n>", "Maximum word n-gram size (default: 5)", parseInt)
  .option("--feature-type <type>", "Feature type: words|word-ngrams|both (default: word-ngrams)", "word-ngrams")
  .action(clusterCommentsFast);

async function clusterCommentsFast(documentId: string, options: any) {
  await initDebug(options.debug);
  
  const db = openDb(documentId);
  const threshold = options.similarityThreshold || 0.8;
  const minClusterSize = options.minClusterSize || 4;
  const ngramSize = options.ngramSize || 3;
  const maxNgram = options.maxNgram || 5;
  const featureType = options.featureType || 'word-ngrams';
  
  console.log(`🔍 Fast clustering for document ${documentId}`);
  console.log(`   Similarity threshold: ${threshold}`);
  console.log(`   Min cluster size: ${minClusterSize}`);
  console.log(`   Feature type: ${featureType}`);
  console.log(`   Word n-gram size: ${ngramSize}-${maxNgram}`);
  
  // Check if clustering already exists
  const existingStatus = db.prepare(
    "SELECT * FROM clustering_status WHERE status = 'completed' ORDER BY created_at DESC LIMIT 1"
  ).get();
  
  if (existingStatus && !options.force) {
    console.log(`✅ Clustering already exists from ${existingStatus.created_at}`);
    return;
  }
  
  if (options.force && existingStatus) {
    console.log(`🔄 Clearing existing clustering data...`);
    withTransaction(db, () => {
      db.prepare("DELETE FROM comment_cluster_membership").run();
      db.prepare("DELETE FROM comment_clusters").run();
      db.prepare("DELETE FROM clustering_status").run();
    });
  }
  
  // Load and enrich comments
  console.log(`📊 Loading and enriching comments...`);
  const { comments: rawComments, attachments } = loadComments(db);
  const enrichedComments: EnrichedComment[] = [];
  
  for (const rawComment of rawComments) {
    const enriched = await enrichComment(rawComment, attachments, { includePdfs: true });
    if (enriched) {
      enrichedComments.push(enriched);
    }
  }
  
  console.log(`📊 Enriched ${enrichedComments.length} comments`);
  
  // Create feature representations
  console.log(`🔍 Creating feature representations...`);
  const commentFeatures = enrichedComments.map(comment => ({
    comment,
    features: createFeatures(extractContentForClustering(comment), featureType, ngramSize, maxNgram)
  }));
  
  // Linear clustering using inverted index
  console.log(`🔗 Clustering using inverted index approach...`);
  const clusters = performLinearClustering(commentFeatures, threshold);
  
  // Disaggregate small clusters
  const finalClusters = disaggregateSmallClusters(clusters, minClusterSize);
  
  // Store results
  console.log(`💾 Storing cluster data...`);
  storeClustersInDatabase(db, finalClusters, threshold, minClusterSize, 'fast-ngram', enrichedComments.length);
  
  // Report statistics
  reportStatistics(finalClusters, enrichedComments.length);
}

// Extract just the content part (comment text + attachments) for clustering
function extractContentForClustering(comment: EnrichedComment): string {
  const parts = comment.content.split('=== COMMENT TEXT ===');
  if (parts.length > 1) {
    // Get everything after COMMENT TEXT (includes both comment and attachments)
    return parts[1].trim();
  }
  return comment.content.trim();
}

// Create feature representation using word n-grams
function createFeatures(text: string, featureType: string, minNgram: number, maxNgram: number): Map<string, number> {
  const features = new Map<string, number>();
  
  // Normalize and tokenize
  const normalizedText = text.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const words = normalizedText.split(' ').filter(w => w.length > 1);
  
  // Add individual word features
  if (featureType === 'words' || featureType === 'both') {
    for (const word of words) {
      if (word.length > 2) {
        features.set(`w:${word}`, (features.get(`w:${word}`) || 0) + 1);
      }
    }
  }
  
  // Add word n-gram features
  if (featureType === 'word-ngrams' || featureType === 'both') {
    // Generate n-grams of various sizes
    for (let n = minNgram; n <= maxNgram && n <= words.length; n++) {
      for (let i = 0; i <= words.length - n; i++) {
        const ngram = words.slice(i, i + n).join(' ');
        features.set(`n${n}:${ngram}`, (features.get(`n${n}:${ngram}`) || 0) + 1);
      }
    }
  }
  
  return features;
}

// Calculate Jaccard similarity between two feature sets
function calculateFeatureSimilarity(features1: Map<string, number>, features2: Map<string, number>): number {
  const keys1 = new Set(features1.keys());
  const keys2 = new Set(features2.keys());
  
  let intersection = 0;
  for (const key of keys1) {
    if (keys2.has(key)) {
      intersection++;
    }
  }
  
  const union = keys1.size + keys2.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// Perform linear clustering using inverted index
function performLinearClustering(
  commentFeatures: Array<{ comment: EnrichedComment; features: Map<string, number> }>,
  threshold: number
): Map<number, EnrichedComment[]> {
  const clusters = new Map<number, EnrichedComment[]>();
  const clusterFeatures = new Map<number, Map<string, number>>();
  const featureToCluster = new Map<string, Set<number>>();
  let nextClusterId = 0;
  let processed = 0;
  
  for (const { comment, features } of commentFeatures) {
    processed++;
    if (processed % 500 === 0) {
      console.log(`   Processing: ${processed}/${commentFeatures.length}`);
    }
    
    // Find candidate clusters using inverted index
    const candidateClusters = new Map<number, number>(); // cluster ID -> shared feature count
    
    for (const [feature] of features) {
      const clustersWithFeature = featureToCluster.get(feature);
      if (clustersWithFeature) {
        for (const clusterId of clustersWithFeature) {
          candidateClusters.set(clusterId, (candidateClusters.get(clusterId) || 0) + 1);
        }
      }
    }
    
    // Find best matching cluster
    let bestCluster = -1;
    let bestSimilarity = 0;
    
    // Only check clusters that share at least some features
    for (const [clusterId, sharedFeatures] of candidateClusters) {
      // Quick check: if shared features are too few, skip detailed calculation
      const maxPossibleSim = sharedFeatures / Math.max(features.size, clusterFeatures.get(clusterId)!.size);
      if (maxPossibleSim < threshold * 0.5) continue; // Optimization: skip if impossible to reach threshold
      
      const clusterRep = clusterFeatures.get(clusterId)!;
      const similarity = calculateFeatureSimilarity(features, clusterRep);
      
      if (similarity >= threshold && similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestCluster = clusterId;
      }
    }
    
    if (bestCluster >= 0) {
      // Add to existing cluster
      clusters.get(bestCluster)!.push(comment);
      
      // IMPORTANT: Don't merge features - keep original cluster representative
      // This ensures new comments are compared against the original representative
      // not an accumulated set of features that would degrade similarity over time
    } else {
      // Create new cluster
      clusters.set(nextClusterId, [comment]);
      clusterFeatures.set(nextClusterId, new Map(features));
      
      // Update inverted index
      for (const [feature] of features) {
        if (!featureToCluster.has(feature)) {
          featureToCluster.set(feature, new Set());
        }
        featureToCluster.get(feature)!.add(nextClusterId);
      }
      
      nextClusterId++;
    }
  }
  
  console.log(`   Created ${clusters.size} clusters`);
  return clusters;
}

// Disaggregate small clusters
function disaggregateSmallClusters(
  clusters: Map<number, EnrichedComment[]>,
  minClusterSize: number
): Map<number, EnrichedComment[]> {
  const finalClusters = new Map<number, EnrichedComment[]>();
  let nextClusterId = 0;
  let disaggregated = 0;
  
  for (const [_, clusterComments] of clusters.entries()) {
    if (clusterComments.length >= minClusterSize) {
      finalClusters.set(nextClusterId++, clusterComments);
    } else {
      // Each comment becomes its own cluster
      for (const comment of clusterComments) {
        finalClusters.set(nextClusterId++, [comment]);
      }
      if (clusterComments.length > 1) {
        disaggregated++;
      }
    }
  }
  
  if (disaggregated > 0) {
    console.log(`   Disaggregated ${disaggregated} small clusters`);
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
    
    for (const [_, clusterComments] of clusters.entries()) {
      // Select longest comment as representative
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
      
      // Insert cluster membership
      for (const comment of clusterComments) {
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
          comment.id === representative.id ? 1 : 0,
          1.0 // We don't track individual similarities in fast clustering
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

// Report statistics
function reportStatistics(clusters: Map<number, EnrichedComment[]>, totalComments: number) {
  let largestClusterSize = 0;
  let duplicatesFiltered = 0;
  const clusterSizes = new Map<number, number>();
  
  for (const [_, clusterComments] of clusters.entries()) {
    const size = clusterComments.length;
    clusterSizes.set(size, (clusterSizes.get(size) || 0) + 1);
    
    if (size > largestClusterSize) {
      largestClusterSize = size;
    }
    
    if (size > 1) {
      duplicatesFiltered += size - 1;
    }
  }
  
  const reductionPercent = ((duplicatesFiltered / totalComments) * 100).toFixed(1);
  
  console.log(`\n✅ Clustering complete!`);
  console.log(`   Total comments: ${totalComments}`);
  console.log(`   Unique clusters: ${clusters.size}`);
  console.log(`   Representatives: ${clusters.size}`);
  console.log(`   Duplicates filtered: ${duplicatesFiltered} (${reductionPercent}% reduction)`);
  console.log(`   Largest cluster: ${largestClusterSize} comments`);
  
  // Show distribution
  console.log(`\n📊 Cluster size distribution:`);
  const sortedSizes = Array.from(clusterSizes.entries()).sort((a, b) => b[0] - a[0]);
  for (const [size, count] of sortedSizes.slice(0, 5)) {
    const totalInSize = size * count;
    console.log(`   Size ${size}: ${count} clusters (${totalInSize} comments)`);
  }
}