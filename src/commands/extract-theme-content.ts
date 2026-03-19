import { Command } from "commander";
import { openDb, withTransaction } from "../lib/database";
import { initDebug } from "../lib/debug";
import { AIClient } from "../lib/ai-client";
import { checkClusteringStatus } from "../lib/comment-processing";
import { buildBatchedThemeExtractPrompt } from "../prompts/theme-extract";
import { parseJsonResponse } from "../lib/json-parser";
import { runPool } from "../lib/worker-pool";
import { getTaskConfig, getTaskModel } from "../lib/batch-config";
import { generateWithGemini3FlashWithMetadata, type UsageMetadata } from "../lib/llm-providers";
import { createHash } from "crypto";
import { debugSave } from "../lib/debug";

export const extractThemeContentCommand = new Command("extract-theme-content")
  .description("Extract theme-specific content from individual comments")
  .argument("<document-id>", "Document ID (e.g., CMS-2025-0050-0031)")
  .option("-l, --limit <n>", "Process only N comments", parseInt)
  .option("--retry-failed", "Retry previously failed extractions")
  .option("--use-clustering", "Only extract from representative comments, include cluster sizes")
  .option("-d, --debug", "Enable debug output")
  .option("-c, --concurrency <n>", "Number of parallel API calls (default: 5)", parseInt)
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

// Group themes by top-level parent (e.g., "3.1" -> "3", "3.1.2" -> "3")
interface ThemeGroup {
  parentCode: string;
  themes: { code: string; description: string; detailed_guidelines?: string }[];
  hierarchyText: string;
}

function groupThemesByTopLevel(themes: { code: string; description: string; detailed_guidelines?: string }[]): ThemeGroup[] {
  const groups = new Map<string, ThemeGroup>();

  for (const theme of themes) {
    const parentCode = theme.code.split('.')[0];

    if (!groups.has(parentCode)) {
      groups.set(parentCode, {
        parentCode,
        themes: [],
        hierarchyText: ''
      });
    }
    groups.get(parentCode)!.themes.push(theme);
  }

  // Build hierarchy text for each group
  for (const group of groups.values()) {
    group.hierarchyText = group.themes.map(t => {
      const fullDesc = t.detailed_guidelines
        ? `${t.description}. ${t.detailed_guidelines}`
        : t.description;
      return `${t.code}: ${fullDesc}`;
    }).join("\n");
  }

  return Array.from(groups.values()).sort((a, b) =>
    parseInt(a.parentCode) - parseInt(b.parentCode)
  );
}

// Cache monitoring aggregator
interface CacheStats {
  totalCalls: number;
  totalPromptTokens: number;
  totalCachedTokens: number;
  totalOutputTokens: number;
}

async function extractThemeContent(documentId: string, options: any) {
  await initDebug(options.debug);

  const db = openDb(documentId);

  // Get the effective model from config
  const effectiveModel = getTaskModel('extractThemeContent', options.model);
  const ai = new AIClient(effectiveModel, db);

  console.log(`🎯 Extracting theme-specific content for document ${documentId}`);
  console.log(`   Using model: ${effectiveModel}`);
  console.log(`   Mode: batched by top-level theme group (prompt caching)`);

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

  // Group themes by top-level parent
  const themeGroups = groupThemesByTopLevel(themes);
  console.log(`📊 Loaded ${themes.length} themes in ${themeGroups.length} top-level groups: ${themeGroups.map(g => `${g.parentCode}(${g.themes.length})`).join(', ')}`);

  // Get comments that have been condensed but not yet extracted
  let query: string;

  if (options.useClustering) {
    query = `
      SELECT DISTINCT
        cc.comment_id,
        cc.structured_sections,
        t.markdown,
        ccl.cluster_size
      FROM condensed_comments cc
      INNER JOIN comment_cluster_membership ccm ON cc.comment_id = ccm.comment_id
      INNER JOIN comment_clusters ccl ON ccm.cluster_id = ccl.cluster_id
      LEFT JOIN transcriptions t ON cc.comment_id = t.comment_id AND t.status = 'completed'
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
    query = `
      SELECT DISTINCT
        cc.comment_id,
        cc.structured_sections,
        t.markdown,
        1 as cluster_size
      FROM condensed_comments cc
      LEFT JOIN transcriptions t ON cc.comment_id = t.comment_id AND t.status = 'completed'
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
    markdown: string | null;
    cluster_size: number;
  }[];

  console.log(`🎯 Found ${comments.length} comments to process (${comments.length * themeGroups.length} total API calls)`);

  if (comments.length === 0) {
    console.log("✅ No comments to process");
    return;
  }

  const taskConfig = getTaskConfig('extractThemeContent', effectiveModel);
  const concurrency = options.concurrency || taskConfig?.concurrency || 5;

  let processed = 0;
  let successful = 0;
  let failed = 0;

  // Aggregate cache stats across all calls
  const cacheStats: CacheStats = {
    totalCalls: 0,
    totalPromptTokens: 0,
    totalCachedTokens: 0,
    totalOutputTokens: 0,
  };

  // Prepare DB statements for local llm_cache
  const checkCache = db.prepare(`SELECT result FROM llm_cache WHERE prompt_hash = ?`);
  const checkCacheExists = db.prepare(`SELECT 1 FROM llm_cache WHERE prompt_hash = ?`);
  const insertCache = db.prepare(`
    INSERT INTO llm_cache (prompt_hash, task_type, task_level, task_params, result, model)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  await runPool(
    comments,
    concurrency,
    async (comment, index, total) => {
      console.log(`\n[${index + 1}/${total}] Processing comment ${comment.comment_id} (${themeGroups.length} theme groups)`);

      try {
        // Parse structured sections for commenter profile
        const sections = JSON.parse(comment.structured_sections || '{}');

        // Build comment text: commenter identity + full transcription
        let commentText = '';

        if (sections.commenterProfile) {
          commentText += `## Commenter Profile\n${sections.commenterProfile}\n\n`;
        }
        if (sections.oneLineSummary) {
          commentText += `## Comment Overview\n${sections.oneLineSummary}\n\n`;
        }

        commentText += `## Full Comment\n${comment.markdown || JSON.stringify(sections)}`;

        // Process each theme group sequentially for cache hits
        const allExtracts: Record<string, any> = {};
        let commentCachedTokens = 0;
        let commentPromptTokens = 0;
        let commentGroupsFromCache = 0;

        for (let gi = 0; gi < themeGroups.length; gi++) {
          const group = themeGroups[gi];

          // Build the prompt with comment as prefix (cacheable) and theme group as suffix
          const prompt = buildBatchedThemeExtractPrompt(commentText, group.hierarchyText);

          // Check local llm_cache first
          const promptHash = createHash('sha256').update(prompt).digest('hex');
          const cached = checkCache.get(promptHash) as { result: string } | undefined;

          let rawResult: string;
          if (cached) {
            rawResult = cached.result;
            commentGroupsFromCache++;
          } else {
            // Call LLM - use metadata-returning variant for cache monitoring
            const debugPrefix = options.debug ? `extract_themes_${comment.comment_id}_g${group.parentCode}` : undefined;
            const streamingOptions = debugPrefix ? { debugFilename: `${debugPrefix}_response.txt` } : undefined;

            if (debugPrefix) {
              await debugSave(`${debugPrefix}_prompt.txt`, prompt);
            }

            const result = await generateWithGemini3FlashWithMetadata(prompt, streamingOptions);
            rawResult = result.text;

            // Track cache stats
            if (result.usageMetadata) {
              cacheStats.totalCalls++;
              cacheStats.totalPromptTokens += result.usageMetadata.promptTokenCount;
              cacheStats.totalCachedTokens += result.usageMetadata.cachedContentTokenCount;
              cacheStats.totalOutputTokens += result.usageMetadata.candidatesTokenCount;
              commentCachedTokens += result.usageMetadata.cachedContentTokenCount;
              commentPromptTokens += result.usageMetadata.promptTokenCount;
            }

            // Save to local llm_cache
            try {
              if (!checkCacheExists.get(promptHash)) {
                insertCache.run(
                  promptHash,
                  'theme_extract_batch',
                  0,
                  JSON.stringify({ commentId: comment.comment_id, group: group.parentCode }),
                  rawResult,
                  effectiveModel
                );
              }
            } catch (e) {
              // Ignore cache write errors
            }
          }

          // Parse JSON response
          try {
            const groupExtracts = parseJsonResponse(rawResult);
            Object.assign(allExtracts, groupExtracts);
          } catch (e) {
            console.warn(`  ⚠️  [${comment.comment_id}] Failed to parse group ${group.parentCode}: ${e}`);
          }
        }

        // Log per-comment cache stats
        if (commentPromptTokens > 0) {
          const cacheRate = (commentCachedTokens / commentPromptTokens * 100).toFixed(0);
          console.log(`  📊 Cache: ${cacheRate}% of input tokens cached across ${themeGroups.length} calls`);
        }
        if (commentGroupsFromCache > 0) {
          console.log(`  💾 ${commentGroupsFromCache}/${themeGroups.length} groups from local cache`);
        }

        // Save extracts for each theme (same as before)
        withTransaction(db, () => {
          const insertStmt = db.prepare(`
            INSERT INTO comment_theme_extracts (comment_id, theme_code, extract_json, cluster_size)
            VALUES (?, ?, ?, ?)
          `);

          let relevantThemes = 0;
          let filteredThemes = 0;
          let cleanedSections = 0;

          for (const [themeCode, extract] of Object.entries(allExtracts)) {
            // Only save extracts with relevance score 1 (strongest relevance)
            if (extract.relevance === 1) {
              // Clean the extract by removing weak sections
              const cleanedExtract = cleanExtract(extract);

              if (cleanedExtract) {
                // Count how many sections were filtered
                const originalSections = Object.values(extract.extract || {})
                  .filter(arr => Array.isArray(arr))
                  .reduce((sum: number, arr: any) => sum + arr.length, 0);
                const remainingSections = Object.values(cleanedExtract.extract || {})
                  .filter(arr => Array.isArray(arr))
                  .reduce((sum: number, arr: any) => sum + arr.length, 0);

                if (remainingSections < originalSections) {
                  cleanedSections += (originalSections - remainingSections);
                }

                relevantThemes++;
                insertStmt.run(
                  comment.comment_id,
                  themeCode,
                  JSON.stringify(cleanedExtract),
                  comment.cluster_size
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

  // Cache monitoring summary
  if (cacheStats.totalCalls > 0) {
    const overallCacheRate = (cacheStats.totalCachedTokens / cacheStats.totalPromptTokens * 100).toFixed(1);
    const estimatedInputCost = (cacheStats.totalPromptTokens - cacheStats.totalCachedTokens) * 0.50 / 1_000_000
      + cacheStats.totalCachedTokens * 0.05 / 1_000_000;
    const estimatedOutputCost = cacheStats.totalOutputTokens * 3.00 / 1_000_000;
    const estimatedTotalCost = estimatedInputCost + estimatedOutputCost;

    console.log("\n📈 Gemini cache monitoring:");
    console.log(`  API calls: ${cacheStats.totalCalls}`);
    console.log(`  Input tokens: ${cacheStats.totalPromptTokens.toLocaleString()} (${cacheStats.totalCachedTokens.toLocaleString()} cached, ${overallCacheRate}%)`);
    console.log(`  Output tokens: ${cacheStats.totalOutputTokens.toLocaleString()}`);
    console.log(`  Estimated cost: $${estimatedTotalCost.toFixed(2)} (input: $${estimatedInputCost.toFixed(2)}, output: $${estimatedOutputCost.toFixed(2)})`);

    if (parseFloat(overallCacheRate) < 50) {
      console.warn("  ⚠️  Cache hit rate below 50% — consider upgrading to explicit caching (see RFC-001)");
    }
  }

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
