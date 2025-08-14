import { Command } from "commander";
import { openDb, withTransaction } from "../lib/database";
import { initDebug } from "../lib/debug";
import { AIClient } from "../lib/ai-client";
import { checkClusteringStatus } from "../lib/comment-processing";
import { THEME_EXTRACT_PROMPT } from "../prompts/theme-extract";
import { parseJsonResponse } from "../lib/json-parser";
import { runPool } from "../lib/worker-pool";
import { getTaskConfig, getTaskModel } from "../lib/batch-config";

export const extractThemeContentCommand = new Command("extract-theme-content")
  .description("Extract theme-specific content from individual comments")
  .argument("<document-id>", "Document ID (e.g., CMS-2025-0050-0031)")
  .option("-l, --limit <n>", "Process only N comments", parseInt)
  .option("--retry-failed", "Retry previously failed extractions")
  .option("--use-clustering", "Only extract from representative comments, include cluster sizes")
  .option("-d, --debug", "Enable debug output")
  .option("-c, --concurrency <n>", "Number of parallel API calls (default: 3)", parseInt)
  .option("-m, --model <model>", "AI model to use (overrides config)")
  .action(extractThemeContent);

// Helper function to check if a text item should be filtered
function shouldFilterText(text: string): boolean {
  const lowerText = text.toLowerCase();
  const words = lowerText.split(/\s+/).filter(w => w.length > 0);
  
  // Filter if <20 words and contains "no"
  if (words.length < 20 && words.includes("no")) {
    return true;
  }
  
  // Also filter common placeholder phrases
  const placeholderPhrases = [
    "nothing to extract",
    "no relevant",
    "no specific",
    "not addressed",
    "not discussed",
    "not mentioned",
    "no information",
    "no content",
    "the commenter did not",
    "the commenter does not"
  ];
  
  return placeholderPhrases.some(phrase => lowerText.includes(phrase));
}

// Helper function to clean extract by removing weak sections
function cleanExtract(extract: any): any {
  const cleaned = {
    relevance: extract.relevance,
    extract: {} as Record<string, any>
  };
  
  // Process each section type
  const sections = ['positions', 'concerns', 'recommendations', 'experiences', 'key_quotes'];
  
  for (const section of sections) {
    if (extract.extract?.[section] && Array.isArray(extract.extract[section])) {
      // Ensure all items are strings, stringifying if necessary
      const stringified = extract.extract[section].map((item: any) => {
        if (typeof item === 'string') {
          return item;
        }
        console.warn(`[cleanExtract] Warning: non-string value found in '${section}'. Stringifying item: ${JSON.stringify(item)}`);
        return JSON.stringify(item);
      });
      
      // Filter out weak entries
      const filtered = stringified.filter((text: string) => !shouldFilterText(text));
      
      // Only include section if it has remaining content
      if (filtered.length > 0) {
        cleaned.extract[section] = filtered;
      }
    }
  }
  
  // Check if any content remains
  const hasContent = sections.some(section => cleaned.extract[section]?.length > 0);
  
  return hasContent ? cleaned : null;
}

async function extractThemeContent(documentId: string, options: any) {
  await initDebug(options.debug);
  
  const db = openDb(documentId);
  
  // Get the effective model from config
  const effectiveModel = getTaskModel('extractThemeContent', options.model);
  const ai = new AIClient(effectiveModel, db);
  
  console.log(`🎯 Extracting theme-specific content for document ${documentId}`);
  console.log(`   Using model: ${effectiveModel}`);
  
  // Check for clustering if requested
  if (options.useClustering) {
    const clusteringExists = checkClusteringStatus(db);
    if (!clusteringExists) {
      console.error("❌ No clustering data found. Run 'cluster-comments-fast' first.");
      process.exit(1);
    }
    console.log("🔗 Using stored clustering to process only representative comments");
  }
  
  // Load theme hierarchy
  const themes = db.prepare(`
    SELECT code, description, detailed_guidelines 
    FROM theme_hierarchy 
    ORDER BY code
  `).all() as { code: string; description: string; detailed_guidelines?: string }[];
  
  if (themes.length === 0) {
    console.log("❌ No theme hierarchy found. Run 'discover-themes' first.");
    return;
  }
  console.log(`📊 Loaded ${themes.length} themes`);
  
  // Build hierarchy text for prompt
  const hierarchyText = themes.map(t => {
    const fullDesc = t.detailed_guidelines 
      ? `${t.description}. ${t.detailed_guidelines}`
      : t.description;
    return `${t.code}: ${fullDesc}`;
  }).join("\n");
  
  // Get comments that have been condensed but not yet extracted
  let query: string;
  
  if (options.useClustering) {
    // Load only representative comments WITH cluster sizes
    query = `
      SELECT DISTINCT 
        cc.comment_id, 
        cc.structured_sections,
        ccl.cluster_size
      FROM condensed_comments cc
      INNER JOIN comment_cluster_membership ccm ON cc.comment_id = ccm.comment_id
      INNER JOIN comment_clusters ccl ON ccm.cluster_id = ccl.cluster_id
      LEFT JOIN (
        SELECT DISTINCT comment_id 
        FROM comment_theme_extracts
      ) cte ON cc.comment_id = cte.comment_id
      WHERE cc.status = 'completed' 
        AND ccm.is_representative = 1
        AND cte.comment_id IS NULL  -- Not yet extracted
      ORDER BY cc.comment_id
    `;
  } else {
    // Standard query - all comments have cluster_size = 1
    query = `
      SELECT DISTINCT 
        cc.comment_id, 
        cc.structured_sections,
        1 as cluster_size
      FROM condensed_comments cc
      LEFT JOIN (
        SELECT DISTINCT comment_id 
        FROM comment_theme_extracts
      ) cte ON cc.comment_id = cte.comment_id
      WHERE cc.status = 'completed' 
        AND cte.comment_id IS NULL  -- Not yet extracted
      ORDER BY cc.comment_id
    `;
  }
  
  const params: any[] = [];
  if (options.limit) {
    query += " LIMIT ?";
    params.push(options.limit);
  }
  
  const comments = db.prepare(query).all(...params) as { 
    comment_id: string; 
    structured_sections: string;
    cluster_size: number;
  }[];
  
  console.log(`🎯 Found ${comments.length} comments to process`);
  
  if (comments.length === 0) {
    console.log("✅ No comments to process");
    return;
  }
  
  const taskConfig = getTaskConfig('extractThemeContent', effectiveModel);
  const concurrency = options.concurrency || taskConfig?.concurrency || 3;
  
  let processed = 0;
  let successful = 0;
  let failed = 0;
  
  await runPool(
    comments,
    concurrency,
    async (comment, index, total) => {
      console.log(`\n[${index}/${total}] Processing comment ${comment.comment_id}`);
      
      try {
        // Parse structured sections
        const sections = JSON.parse(comment.structured_sections || '{}');
        
        // Build comment text with notable quotes included
        let commentText = '';
        
        // Include key quotations if available
        if (sections.keyQuotations && sections.keyQuotations !== "No key quotations provided") {
          commentText += `## Notable Quotes from Commenter\n${sections.keyQuotations}\n\n`;
        }
        
        // Add the detailed content
        commentText += `## Detailed Analysis\n${sections.detailedContent || JSON.stringify(sections)}`;
        
        // Build prompt
        const prompt = THEME_EXTRACT_PROMPT
          .replace("{THEME_HIERARCHY}", hierarchyText)
          .replace("{COMMENT}", commentText);
        
        // Get extracts from LLM
        const extracts = await ai.generateContent<Record<string, any>>(
          prompt,
          options.debug ? `extract_themes_${comment.comment_id}` : undefined,
          undefined,
          {
            taskType: 'theme_extract',
            taskLevel: 0,
            params: {
              commentId: comment.comment_id,
              themeCount: themes.length
            }
          },
          parseJsonResponse
        );
        
        // Save extracts for each theme
        withTransaction(db, () => {
          const insertStmt = db.prepare(`
            INSERT INTO comment_theme_extracts (comment_id, theme_code, extract_json, cluster_size)
            VALUES (?, ?, ?, ?)
          `);
          
          let relevantThemes = 0;
          let filteredThemes = 0;
          let cleanedSections = 0;
          
          for (const [themeCode, extract] of Object.entries(extracts)) {
            // Only save extracts with relevance score 1 (strongest relevance)
            if (extract.relevance === 1) {
              // Clean the extract by removing weak sections
              const cleanedExtract = cleanExtract(extract);
              
              if (cleanedExtract) {
                // Count how many sections were filtered
                const originalSections = Object.values(extract.extract || {})
                  .filter(arr => Array.isArray(arr))
                  .reduce((sum, arr) => sum + arr.length, 0);
                const remainingSections = Object.values(cleanedExtract.extract || {})
                  .filter(arr => Array.isArray(arr))
                  .reduce((sum, arr) => sum + arr.length, 0);
                
                if (remainingSections < originalSections) {
                  cleanedSections += (originalSections - remainingSections);
                }
                
                relevantThemes++;
                insertStmt.run(
                  comment.comment_id,
                  themeCode,
                  JSON.stringify(cleanedExtract),
                  comment.cluster_size  // Store cluster size!
                );
              } else {
                filteredThemes++;
              }
            }
          }
          
          const messages = [`  ✅ Extracted content for ${relevantThemes} themes`];
          if (comment.cluster_size > 1) {
            messages.push(`representing ${comment.cluster_size} similar comments`);
          }
          if (filteredThemes > 0) {
            messages.push(`filtered ${filteredThemes} empty extracts`);
          }
          if (cleanedSections > 0) {
            messages.push(`removed ${cleanedSections} weak sections`);
          }
          console.log(messages.join(", "));
        });
        
        successful++;
        processed++;
        
      } catch (error) {
        failed++;
        processed++;
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(`  ❌ Error: ${errorMsg}`);
      }
    }
  );
  
  // Summary
  console.log("\n📊 Extraction complete:");
  console.log(`  ✅ Successful: ${successful}`);
  console.log(`  ❌ Failed: ${failed}`);
  console.log(`  📄 Total processed: ${processed}`);
  
  // Show extraction coverage
  const coverage = db.prepare(`
    SELECT 
      th.code,
      th.description,
      COUNT(DISTINCT cte.comment_id) as extracted_count
    FROM theme_hierarchy th
    LEFT JOIN comment_theme_extracts cte ON th.code = cte.theme_code
    GROUP BY th.code
    ORDER BY extracted_count DESC
    LIMIT 10
  `).all() as any[];
  
  console.log("\n📈 Top themes by extraction count:");
  for (const theme of coverage) {
    console.log(`  ${theme.code}: ${theme.extracted_count} comments with extracted content`);
  }
  
  db.close();
}