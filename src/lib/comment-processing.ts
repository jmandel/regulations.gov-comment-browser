import { Database } from "bun:sqlite";
import type { RawComment, CommentAttributes, Attachment, EnrichedComment, ParsedTheme } from "../types";
import { countWords } from "./batch-processor";
import { mkdtemp, writeFile, unlink } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { $ } from "bun";

// Load comments and attachments from database
export function loadComments(db: Database, limit?: number): {
  comments: RawComment[];
  attachments: Map<string, Attachment[]>;
  total: number;
} {
  // Get total count
  const { count: total } = db.prepare("SELECT COUNT(*) as count FROM comments").get() as { count: number };
  
  // Load comments
  const query = limit 
    ? "SELECT id, attributes_json FROM comments LIMIT ?"
    : "SELECT id, attributes_json FROM comments";
  
  const comments = limit
    ? db.prepare(query).all(limit) as RawComment[]
    : db.prepare(query).all() as RawComment[];
  
  // Load attachments grouped by comment
  const attachments = new Map<string, Attachment[]>();
  const attachmentRows = db.prepare(`
    SELECT * FROM attachments 
    WHERE comment_id IN (${comments.map(() => '?').join(',')})
  `).all(...comments.map(c => c.id)) as Attachment[];
  
  for (const att of attachmentRows) {
    if (!attachments.has(att.comment_id)) {
      attachments.set(att.comment_id, []);
    }
    attachments.get(att.comment_id)!.push(att);
  }
  
  return { comments, attachments, total };
}

// Text similarity calculation using Jaccard similarity on words
export function calculateJaccardSimilarity(text1: string, text2: string): number {
  const normalize = (text: string) => 
    text.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 2); // Filter out short words
  
  const words1 = new Set(normalize(text1));
  const words2 = new Set(normalize(text2));
  
  const intersection = new Set([...words1].filter(x => words2.has(x)));
  const union = new Set([...words1, ...words2]);
  
  return intersection.size / union.size;
}

// Cluster similar comments and return detailed cluster info
export async function getDetailedClusterInfo(
  db: Database, 
  threshold: number = 0.8
): Promise<{
  clusters: Map<number, EnrichedComment[]>;
  representativeIds: Set<string>;
  enrichedComments: EnrichedComment[];
}> {
  console.log(`🔍 Clustering comments to filter duplicates (threshold: ${threshold})`);
  
  // Load all raw comments and attachments
  const { comments: rawComments, attachments } = loadComments(db);
  console.log(`📊 Loaded ${rawComments.length} raw comments`);
  
  // Enrich comments to get full content including attachments
  const enrichedComments: EnrichedComment[] = [];
  
  for (const rawComment of rawComments) {
    const enriched = await enrichComment(rawComment, attachments, { includePdfs: true });
    if (enriched) {
      enrichedComments.push(enriched);
    }
  }
  
  console.log(`📊 Enriched ${enrichedComments.length} comments for clustering`);
  
  // Cluster similar comments
  const clusters = new Map<number, EnrichedComment[]>();
  let nextClusterId = 0;
  
  for (const comment of enrichedComments) {
    const commentText = comment.content.trim();
    let assigned = false;
    
    // Check if this comment belongs to any existing cluster
    for (const [clusterId, clusterComments] of clusters.entries()) {
      // Use longest comment as representative for comparison
      const representative = clusterComments.reduce((longest, current) => 
        current.content.length > longest.content.length ? current : longest
      );
      const representativeText = representative.content.trim();
      
      const similarity = calculateJaccardSimilarity(commentText, representativeText);
      
      if (similarity >= threshold) {
        clusterComments.push(comment);
        assigned = true;
        break;
      }
    }
    
    // If not assigned to any cluster, create a new one
    if (!assigned) {
      clusters.set(nextClusterId++, [comment]);
    }
  }
  
  // Get representative IDs (longest comment from each cluster)
  const representativeIds = new Set<string>();
  let totalDuplicates = 0;
  
  for (const [clusterId, clusterComments] of clusters.entries()) {
    const representative = clusterComments.reduce((longest, current) => 
      current.content.length > longest.content.length ? current : longest
    );
    representativeIds.add(representative.id);
    
    if (clusterComments.length > 1) {
      totalDuplicates += clusterComments.length - 1;
    }
  }
  
  const reductionPercent = ((enrichedComments.length - representativeIds.size) / enrichedComments.length * 100).toFixed(1);
  console.log(`📉 Clustering complete: ${enrichedComments.length} → ${representativeIds.size} comments (${reductionPercent}% reduction)`);
  console.log(`🔗 Found ${clusters.size} clusters, filtered ${totalDuplicates} duplicates`);
  
  return { clusters, representativeIds, enrichedComments };
}

// Cluster similar comments and return representative IDs
// Disaggregates clusters smaller than 4 comments (treats all members as individuals)
export async function getRepresentativeCommentIds(
  db: Database, 
  threshold: number = 0.8,
  minClusterSize: number = 4
): Promise<Set<string>> {
  const { clusters } = await getDetailedClusterInfo(db, threshold);
  
  const representativeIds = new Set<string>();
  let totalDuplicates = 0;
  let disaggregatedClusters = 0;
  
  for (const [clusterId, clusterComments] of clusters.entries()) {
    if (clusterComments.length >= minClusterSize) {
      // Large cluster: use only the representative (longest comment)
      const representative = clusterComments.reduce((longest, current) => 
        current.content.length > longest.content.length ? current : longest
      );
      representativeIds.add(representative.id);
      totalDuplicates += clusterComments.length - 1;
    } else {
      // Small cluster: disaggregate and include all members
      for (const comment of clusterComments) {
        representativeIds.add(comment.id);
      }
      if (clusterComments.length > 1) {
        disaggregatedClusters++;
      }
    }
  }
  
  const originalTotal = Array.from(clusters.values()).reduce((sum, cluster) => sum + cluster.length, 0);
  const reductionPercent = ((originalTotal - representativeIds.size) / originalTotal * 100).toFixed(1);
  
  console.log(`📉 Clustering complete: ${originalTotal} → ${representativeIds.size} comments (${reductionPercent}% reduction)`);
  console.log(`🔗 Found ${clusters.size} clusters, filtered ${totalDuplicates} duplicates`);
  if (disaggregatedClusters > 0) {
    console.log(`📤 Disaggregated ${disaggregatedClusters} small clusters (all members included)`);
  }
  
  return representativeIds;
}

// Load condensed comments
export function loadCondensedComments(db: Database, limit?: number, filterIds?: Set<string>): EnrichedComment[] {
  let query = `SELECT c.id, cc.structured_sections, c.attributes_json 
       FROM comments c 
       JOIN condensed_comments cc ON c.id = cc.comment_id 
       WHERE cc.status = 'completed'`;
  
  const params: any[] = [];
  
  // Add filter for specific comment IDs if provided
  if (filterIds && filterIds.size > 0) {
    const placeholders = Array.from(filterIds).map(() => '?').join(',');
    query += ` AND c.id IN (${placeholders})`;
    params.push(...Array.from(filterIds));
  }
  
  if (limit) {
    query += ` LIMIT ?`;
    params.push(limit);
  }
  
  const rows = db.prepare(query).all(...params);
  
  return rows.map((row: any) => {
    const attrs = JSON.parse(row.attributes_json) as CommentAttributes;
    const sections = JSON.parse(row.structured_sections || '{}');
    
    // Use detailedContent as the main content, or fall back to concatenating key sections
    const content = sections.detailedContent || [
      sections.oneSummary || '',
      sections.commenterProfile || '',
      sections.corePosition || '',
      sections.keyRecommendations || '',
      sections.mainConcerns || ''
    ].filter(Boolean).join('\n\n');
    
    return {
      id: row.id,
      content,
      wordCount: countWords(content),
      metadata: extractMetadata(attrs),
      structuredSections: sections
    };
  });
}

// Load condensed comments for entity extraction (metadata + detailed content only)
export function loadCondensedCommentsForEntities(db: Database, limit?: number): EnrichedComment[] {
  const query = limit
    ? `SELECT c.id, cc.structured_sections, c.attributes_json 
       FROM comments c 
       JOIN condensed_comments cc ON c.id = cc.comment_id 
       WHERE cc.status = 'completed' 
       LIMIT ?`
    : `SELECT c.id, cc.structured_sections, c.attributes_json 
       FROM comments c 
       JOIN condensed_comments cc ON c.id = cc.comment_id 
       WHERE cc.status = 'completed'`;
  
  const rows = limit
    ? db.prepare(query).all(limit)
    : db.prepare(query).all();
  
  return rows.map((row: any) => {
    const attrs = JSON.parse(row.attributes_json) as CommentAttributes;
    const sections = JSON.parse(row.structured_sections || '{}');
    const metadata = extractMetadata(attrs);
    
    // Build a condensed representation with metadata and detailed content only
    const parts: string[] = [];
    
    // Add metadata
    parts.push(`[${metadata.submitterType}] ${metadata.submitter}`);
    if (metadata.organization) {
      parts.push(`Organization: ${metadata.organization}`);
    }
    if (metadata.location) {
      parts.push(`Location: ${metadata.location}`);
    }
    parts.push('');
    
    // Add detailed content (the bulletized version)
    if (sections.detailedContent) {
      parts.push(sections.detailedContent);
    }
    
    const content = parts.join('\n');
    
    return {
      id: row.id,
      content,
      wordCount: countWords(content),
      metadata,
      structuredSections: sections
    };
  });
}

// Enrich a comment with its full content including PDFs
export async function enrichComment(
  comment: RawComment,
  attachments: Map<string, Attachment[]>,
  options: { includePdfs?: boolean } = { includePdfs: true }
): Promise<EnrichedComment | null> {
  const attrs = JSON.parse(comment.attributes_json) as CommentAttributes;
  
  // Build comment text parts
  const parts: string[] = [];
  
  // Add metadata header
  parts.push("=== COMMENT METADATA ===");
  parts.push(`ID: ${comment.id}`);
  parts.push(`Date: ${attrs.postedDate || attrs.receiveDate || "Unknown"}`);
  
  const metadata = extractMetadata(attrs);
  parts.push(`Submitter: ${metadata.submitter}`);
  parts.push(`Type: ${metadata.submitterType}`);
  if (metadata.organization) parts.push(`Organization: ${metadata.organization}`);
  if (metadata.location) parts.push(`Location: ${metadata.location}`);
  
  // Add comment text
  parts.push("\n=== COMMENT TEXT ===");
  const commentText = attrs.comment || attrs.text || "";
  if (!commentText || commentText.trim().length === 0) {
    return null; // Skip empty comments
  }
  parts.push(commentText);
  
  // Add attachment content if requested
  if (options.includePdfs) {
    const commentAttachments = attachments.get(comment.id) || [];
    
    // Group attachments by ID to select best format for each
    const attachmentGroups = new Map<string, Attachment[]>();
    for (const attachment of commentAttachments) {
      if (!attachmentGroups.has(attachment.id)) {
        attachmentGroups.set(attachment.id, []);
      }
      attachmentGroups.get(attachment.id)!.push(attachment);
    }
    
    const processedAttachments: Array<{attachment: Attachment, text: string}> = [];
    
    // Process each attachment group (select best format per attachment ID)
    for (const [attachmentId, attachmentFormats] of attachmentGroups) {
      const bestAttachment = selectBestAttachmentFormat(attachmentFormats);
      if (bestAttachment && bestAttachment.blob_data) {
        try {
          const extractedText = await extractTextFromAttachment(bestAttachment);
          processedAttachments.push({ attachment: bestAttachment, text: extractedText });
        } catch (err) {
          console.warn(`Error extracting text from attachment ${attachmentId} (${bestAttachment.format}):`, err);
          processedAttachments.push({ 
            attachment: bestAttachment, 
            text: `(error extracting ${bestAttachment.format})` 
          });
        }
      } else if (attachmentFormats.length > 0) {
        console.warn(`Attachment ${attachmentId} has no supported formats or blob data`);
        const firstAttachment = attachmentFormats[0];
        processedAttachments.push({ 
          attachment: firstAttachment, 
          text: `(unsupported format: ${firstAttachment.format})` 
        });
      }
    }
    
    if (processedAttachments.length > 0) {
      parts.push("\n=== ATTACHMENTS ===");
      
      for (const { attachment, text } of processedAttachments) {
        const displayText = text.trim();
        if (displayText.length > 0 && !displayText.startsWith('(')) {
          parts.push(`\n${attachment.format.toUpperCase()}: ${attachment.file_name}`);
          parts.push(displayText);
        } else {
          parts.push(`\n${attachment.format.toUpperCase()}: ${attachment.file_name} ${displayText || '(no extractable text)'}`);
        }
      }
    }
  }
  
  const content = parts.join("\n");
  
  return {
    id: comment.id,
    content,
    wordCount: countWords(content),
    metadata
  };
}

// Extract metadata from comment attributes
function extractMetadata(attrs: CommentAttributes) {
  // Determine submitter name
  let submitter = "Anonymous";
  if (attrs.organization) {
    submitter = attrs.organization;
  } else if (attrs.firstName && attrs.lastName) {
    submitter = `${attrs.firstName} ${attrs.lastName}`;
  } else if (attrs.firstName || attrs.lastName) {
    submitter = attrs.firstName || attrs.lastName || submitter;
  }
  
  // Determine submitter type
  let submitterType = attrs.category;
  if (!submitterType) {
    submitterType = attrs.organization ? "Organization" : "Individual";
  }
  
  // Build location
  const locationParts: string[] = [];
  if (attrs.city) locationParts.push(attrs.city);
  if (attrs.stateProvinceRegion) locationParts.push(attrs.stateProvinceRegion);
  if (attrs.country && attrs.country !== "United States") locationParts.push(attrs.country);
  const location = locationParts.join(", ") || undefined;
  
  return {
    submitter,
    submitterType,
    organization: attrs.organization,
    location,
    date: attrs.postedDate || attrs.receiveDate
  };
}

// Parse theme hierarchy text into structured format
export function parseThemeHierarchy(text: string): ParsedTheme[] {
  const themes: ParsedTheme[] = [];
  
  // New approach: split by theme patterns to get full paragraphs
  // Match pattern: number at start of line followed by dot and space
  const themePattern = /^(\d+(?:\.\d+)*)\.\s+/gm;
  
  // Find all theme starts
  const themeStarts: Array<{index: number, code: string}> = [];
  let match;
  while ((match = themePattern.exec(text)) !== null) {
    themeStarts.push({
      index: match.index,
      code: match[1]
    });
  }
  
  // Process each theme by extracting its full content
  for (let i = 0; i < themeStarts.length; i++) {
    const start = themeStarts[i];
    const end = i < themeStarts.length - 1 ? themeStarts[i + 1].index : text.length;
    
    // Get the full theme content
    const themeContent = text.substring(start.index, end).trim();
    
    // Parse the content: "1.2. Label. Brief description || Detailed guidelines"
    // First match the theme code, then handle the label separately to avoid issues with "vs."
    const codeMatch = themeContent.match(/^(\d+(?:\.\d+)*)\.\s+/);
    if (!codeMatch) continue;
    
    const code = codeMatch[1];
    const afterCode = themeContent.substring(codeMatch[0].length);
    
    // Find first ". " that's not part of common abbreviations like "vs." or "U.S."
    // Try to intelligently split the label from the rest of the content
    let label = '';
    let restOfContent = '';
    
    // First try to find a clear sentence boundary (period followed by space and capital letter)
    const sentenceMatch = afterCode.match(/^(.+?[^U.S][^vs])\.\s+([A-Z].*)$/s);
    if (sentenceMatch) {
      label = sentenceMatch[1];
      restOfContent = sentenceMatch[2];
    } else {
      // Fallback: look for any period-space, but handle common abbreviations
      const parts = afterCode.split(/\.\s+/);
      if (parts.length >= 2) {
        // Check if first part ends with known abbreviation patterns
        const firstPart = parts[0];
        if (firstPart.endsWith(' U.S') || firstPart.endsWith(' vs')) {
          // This is an abbreviation, include the next part in the label
          label = parts[0] + '. ' + (parts[1] || '');
          restOfContent = parts.slice(2).join('. ');
        } else {
          label = parts[0];
          restOfContent = parts.slice(1).join('. ');
        }
      } else {
        // No clear split point, use the whole thing as label
        label = afterCode;
        restOfContent = '';
      }
    }
    const level = code.split(".").length;
    
    // Determine parent code
    let parent_code: string | null = null;
    if (level > 1) {
      const parts = code.split(".");
      parts.pop();
      parent_code = parts.join(".");
    }
    
    // Parse the rest of the content
    let briefDescription = '';
    let detailedGuidelines = '';
    
    // Check if we have the delimiter format
    if (restOfContent.includes(' || ')) {
      // New delimiter format - split on double pipe
      const parts = restOfContent.split(' || ');
      briefDescription = parts[0].trim();
      detailedGuidelines = parts.slice(1).join(' || ').trim();
    } else {
      // Fallback: everything after the label is the description
      // The label is already captured separately, so use all remaining content
      const fullText = restOfContent.trim();
      
      // If there's a clear sentence boundary after the first sentence, split there
      const firstPeriodIndex = fullText.indexOf('. ');
      if (firstPeriodIndex > 0 && firstPeriodIndex < 200) {
        briefDescription = fullText.substring(0, firstPeriodIndex);
        detailedGuidelines = fullText.substring(firstPeriodIndex + 2).trim();
      } else {
        // Use the entire content as description
        briefDescription = fullText;
      }
    }
    
    // Clean up brief description (remove trailing period if present)
    if (briefDescription.endsWith('.')) {
      briefDescription = briefDescription.slice(0, -1);
    }

    themes.push({
      code,
      description: label.trim(),  // Just the label for the description field
      level,
      parent_code,
      detailed_guidelines: briefDescription + (detailedGuidelines ? '. ' + detailedGuidelines : '')
    });
  }
  
  return themes;
}

// Parse entity taxonomy
export function parseEntityTaxonomy(text: string): Record<string, Array<{
  label: string;
  definition: string;
  terms: string[];
}>> {
  const result: Record<string, Array<{
    label: string;
    definition: string;
    terms: string[];
  }>> = {};
  
  let currentCategory: string | null = null;
  let currentEntity: { label: string; definition: string; terms: string[] } | null = null;
  
  const lines = text.split(/\r?\n/);
  
  for (const line of lines) {
    const trimmed = line.trim();
    
    // Category line: "1. Category Name"
    const categoryMatch = trimmed.match(/^\d+\.\s+(.+)$/);
    if (categoryMatch) {
      currentCategory = categoryMatch[1];
      if (!result[currentCategory]) {
        result[currentCategory] = [];
      }
      currentEntity = null;
      continue;
    }
    
    // Entity line: "* Entity Name: Definition"
    const entityMatch = trimmed.match(/^\*\s+([^:]+):\s+(.+)$/);
    if (entityMatch && currentCategory) {
      currentEntity = {
        label: entityMatch[1].trim(),
        definition: entityMatch[2].trim(),
        terms: []
      };
      result[currentCategory].push(currentEntity);
      continue;
    }
    
    // Term line: '  * "term"' or '  * term'
    const termMatch = trimmed.match(/^\*\s+"?([^"]+)"?$/);
    if (termMatch && currentEntity) {
      currentEntity.terms.push(termMatch[1].trim());
    }
  }
  
  return result;
}

// Format preference order for text extraction (higher index = higher priority)
const FORMAT_PREFERENCE = ['txt', 'docx', 'pdf'] as const;

function selectBestAttachmentFormat(attachments: Attachment[]): Attachment | null {
  if (attachments.length === 0) return null;
  if (attachments.length === 1) return attachments[0];
  
  // Find the format with highest preference
  let bestAttachment: Attachment | null = null;
  let bestPriority = -1;
  
  for (const attachment of attachments) {
    const priority = FORMAT_PREFERENCE.indexOf(attachment.format.toLowerCase() as any);
    if (priority > bestPriority) {
      bestPriority = priority;
      bestAttachment = attachment;
    }
  }
  
  // If no format matches our preferences, use the first one
  return bestAttachment || attachments[0];
}

async function extractTextFromAttachment(attachment: Attachment): Promise<string> {
  if (!attachment.blob_data) {
    return '';
  }
  
  const format = attachment.format.toLowerCase();
  
  switch (format) {
    case 'pdf':
      return extractPdfText(Buffer.from(attachment.blob_data));
    case 'docx':
      return extractDocxText(Buffer.from(attachment.blob_data));
    case 'txt':
      return Buffer.from(attachment.blob_data).toString('utf-8').trim();
    default:
      console.warn(`Unsupported attachment format: ${format}`);
      return '';
  }
}

async function extractDocxText(buffer: Buffer | Uint8Array): Promise<string> {
  // Create a temporary directory and file
  const tempDir = await mkdtemp(join(tmpdir(), 'docx-extract-'));
  const tempDocxPath = join(tempDir, 'temp.docx');
  
  try {
    // Write DOCX buffer to temporary file
    await writeFile(tempDocxPath, buffer);
    
    // Use pandoc to extract plain text from DOCX
    // -t plain for plain text output, --wrap=none to avoid line wrapping
    const result = await $`pandoc -f docx -t plain --wrap=none ${tempDocxPath}`.text();
    
    return result.trim();
  } catch (error) {
    console.error('Error extracting DOCX text:', error);
    // Fallback to empty string if pandoc fails
    return '';
  } finally {
    // Clean up temporary file
    try {
      await unlink(tempDocxPath);
      // Remove the temporary directory
      await $`rmdir ${tempDir}`.quiet();
    } catch {
      // Ignore cleanup errors
    }
  }
}

async function extractPdfText(buffer: Buffer | Uint8Array): Promise<string> {
  // Create a temporary directory and file
  const tempDir = await mkdtemp(join(tmpdir(), 'pdf-extract-'));
  const tempPdfPath = join(tempDir, 'temp.pdf');
  
  try {
    // Write PDF buffer to temporary file
    await writeFile(tempPdfPath, buffer);
    
    // Use pdftotext to extract text
    // -layout preserves the layout, -enc UTF-8 ensures proper encoding
    const result = await $`pdftotext -layout -enc UTF-8 ${tempPdfPath} -`.text();
    
    return result.trim();
  } catch (error) {
    console.error('Error extracting PDF text:', error);
    // Fallback to empty string if pdftotext fails
    return '';
  } finally {
    // Clean up temporary file
    try {
      await unlink(tempPdfPath);
      // Remove the temporary directory
      await $`rmdir ${tempDir}`.quiet();
    } catch {
      // Ignore cleanup errors
    }
  }
}

// ============================================================================
// CLUSTERING HELPER FUNCTIONS FOR STORED CLUSTERS
// ============================================================================

// Check if clustering exists in database
export function checkClusteringStatus(db: Database): boolean {
  const status = db.prepare(
    "SELECT 1 FROM clustering_status WHERE status = 'completed' LIMIT 1"
  ).get();
  return !!status;
}

// Get stored representative IDs from database
export function getStoredRepresentativeIds(db: Database): Set<string> | null {
  if (!checkClusteringStatus(db)) return null;
  
  const reps = db.prepare(`
    SELECT comment_id 
    FROM comment_cluster_membership 
    WHERE is_representative = 1
  `).all() as { comment_id: string }[];
  
  return new Set(reps.map(r => r.comment_id));
}

// Get cluster size for a specific comment
export function getClusterSize(db: Database, commentId: string): number {
  const result = db.prepare(`
    SELECT cc.cluster_size 
    FROM comment_cluster_membership ccm
    JOIN comment_clusters cc ON ccm.cluster_id = cc.cluster_id
    WHERE ccm.comment_id = ?
  `).get(commentId) as { cluster_size: number } | undefined;
  
  return result?.cluster_size || 1;
}

// Get clustering statistics from database
export function getClusteringStatistics(db: Database): {
  totalComments: number;
  totalClusters: number;
  representativeCount: number;
  duplicatesFiltered: number;
  largestClusterSize: number;
  similarityThreshold: number;
  minClusterSize: number;
  createdAt: string;
} | null {
  const status = db.prepare(
    "SELECT * FROM clustering_status WHERE status = 'completed' ORDER BY created_at DESC LIMIT 1"
  ).get() as any;
  
  if (!status) return null;
  
  const largestCluster = db.prepare(
    "SELECT MAX(cluster_size) as max FROM comment_clusters"
  ).get() as { max: number };
  
  return {
    totalComments: status.total_comments,
    totalClusters: status.total_clusters,
    representativeCount: status.representative_count,
    duplicatesFiltered: status.duplicates_filtered,
    largestClusterSize: largestCluster.max,
    similarityThreshold: status.similarity_threshold,
    minClusterSize: status.min_cluster_size,
    createdAt: status.created_at
  };
}

// Load only representative comments from clustering
export function loadRepresentativeComments(
  db: Database,
  limit?: number
): RawComment[] {
  let query = `
    SELECT c.id, c.attributes_json
    FROM comments c
    INNER JOIN comment_cluster_membership ccm ON c.id = ccm.comment_id
    WHERE ccm.is_representative = 1
  `;
  
  if (limit) {
    query += ` LIMIT ${limit}`;
  }
  
  return db.prepare(query).all() as RawComment[];
}

// Check if a comment is a cluster representative
export function isRepresentative(db: Database, commentId: string): boolean {
  const result = db.prepare(`
    SELECT is_representative 
    FROM comment_cluster_membership 
    WHERE comment_id = ? AND is_representative = 1
  `).get(commentId);
  
  return !!result;
}
