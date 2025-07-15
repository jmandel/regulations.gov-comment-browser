import { Command } from "commander";
import { openDb, withTransaction } from "../lib/database";
import type { Database } from "bun:sqlite";
import { initDebug } from "../lib/debug";
import { AIClient } from "../lib/ai-client";
import { THEME_SUMMARY_FROM_EXTRACTS_PROMPT, EXTRACT_MERGE_PROMPT } from "../prompts/theme-extract";
import { THEME_SUMMARY_STRUCTURE_PROMPT } from "../prompts/theme-summary";
import { parseJsonResponse } from "../lib/json-parser";
import { runPool } from "../lib/worker-pool";
import { getTaskConfig, getTaskModel, getBatchOptions } from "../lib/batch-config";
import { createEvenBatches } from "../lib/batch-processor";
import { getRepresentativeCommentIds } from "../lib/comment-processing";

export const summarizeThemesV2Command = new Command("summarize-themes-v2")
  .description("Generate theme summaries from pre-extracted theme-specific content")
  .argument("<document-id>", "Document ID (e.g., CMS-2025-0050-0031)")
  .option("--themes <codes>", "Comma-separated list of theme codes to analyze (default: all)")
  .option("--min-comments <n>", "Minimum comments required for a theme (default: 5)", parseInt)
  .option("--batch-limit <n>", "Word limit to trigger batching (default: 150000)", parseInt)
  .option("--batch-size <n>", "Target words per batch (default: 75000)", parseInt)
  .option("-d, --debug", "Enable debug output")
  .option("-c, --concurrency <n>", "Number of parallel API calls (default: 3)", parseInt)
  .option("-m, --model <model>", "AI model to use (overrides config)")
  .option("--filter-duplicates", "Only use extracts from representative comments (filters form letters)")
  .option("--similarity-threshold <n>", "Similarity threshold for duplicate filtering (default: 0.8)", parseFloat)
  .action(summarizeThemesV2);

async function summarizeThemesV2(documentId: string, options: any) {
  await initDebug(options.debug);
  
  const db = openDb(documentId);
  
  // Get the effective model from config
  const effectiveModel = getTaskModel('summarizeThemes', options.model);
  const ai = new AIClient(effectiveModel, db);
  
  console.log(`📝 Summarizing themes (v2) for document ${documentId}`);
  console.log(`   Using model: ${effectiveModel}`);
  
  // Optionally filter to representative comments only
  let representativeIds: Set<string> | undefined;
  if (options.filterDuplicates) {
    const threshold = options.similarityThreshold || 0.8;
    representativeIds = await getRepresentativeCommentIds(db, threshold);
    console.log(`🔍 Using only representative comments for filtering (${representativeIds.size} comments)`);
  }
  
  // Load task configuration  
  const taskConfig = getTaskConfig('summarizeThemes', effectiveModel);
  const minComments = options.minComments || taskConfig.thresholds?.minCommentsPerTheme || 5;
  
  // Get themes with sufficient extracts (optionally filtered to representative comments)
  let themeQuery = `
    SELECT 
      th.code,
      th.description,
      th.detailed_guidelines,
      COUNT(DISTINCT cte.comment_id) as extract_count
    FROM theme_hierarchy th
    INNER JOIN comment_theme_extracts cte ON th.code = cte.theme_code
  `;
  const queryParams: any[] = [];
  
  // Add filter for representative comments if requested
  if (representativeIds && representativeIds.size > 0) {
    const placeholders = Array.from(representativeIds).map(() => '?').join(',');
    themeQuery += ` WHERE cte.comment_id IN (${placeholders})`;
    queryParams.push(...Array.from(representativeIds));
  }
  
  themeQuery += `
    GROUP BY th.code
    HAVING extract_count >= ?
  `;
  queryParams.push(minComments);
  
  if (options.themes) {
    const themeCodes = options.themes.split(',').map((t: string) => t.trim());
    const placeholders = themeCodes.map(() => '?').join(',');
    themeQuery += ` AND th.code IN (${placeholders})`;
    queryParams.push(...themeCodes);
  }
  
  themeQuery += ` ORDER BY extract_count DESC`;
  
  const themes = db.prepare(themeQuery).all(...queryParams) as {
    code: string;
    description: string;
    detailed_guidelines?: string;
    extract_count: number;
  }[];
  
  if (themes.length === 0) {
    console.log("❌ No themes found with sufficient extracts");
    return;
  }
  
  console.log(`📊 Found ${themes.length} themes to analyze`);
  
  // Check for existing summaries
  const existingSummaries = db.prepare("SELECT theme_code FROM theme_summaries").all() as { theme_code: string }[];
  const existingCodes = new Set(existingSummaries.map(s => s.theme_code));
  
  const themesToProcess = themes.filter(t => !existingCodes.has(t.code));
  
  if (themesToProcess.length === 0) {
    console.log("✅ All themes already summarized");
    return;
  }
  
  console.log(`🆕 ${themesToProcess.length} themes need summarization`);
  
  const concurrency = options.concurrency || taskConfig.concurrency || 3;
  const batchConfig = getBatchOptions('summarizeThemes');
  const batchOptions = {
    totalWordLimit: options.batchLimit || batchConfig?.triggerWordLimit || 200000,
    batchWordLimit: options.batchSize || batchConfig?.batchWordLimit || 125000
  };
  
  await runPool(
    themesToProcess,
    concurrency,
    async (theme, index, total) => {
      console.log(`\n[${index}/${total}] Processing theme ${theme.code}: ${theme.description}`);
      console.log(`   Extracts: ${theme.extract_count}`);
      
      try {
        // Get extracts for this theme with commenter metadata (optionally filtered to representatives)
        let extractQuery = `
          SELECT 
            cte.comment_id,
            cte.extract_json,
            cc.structured_sections
          FROM comment_theme_extracts cte
          JOIN condensed_comments cc ON cte.comment_id = cc.comment_id
          WHERE cte.theme_code = ?
        `;
        const extractParams: any[] = [theme.code];
        
        // Add filter for representative comments if requested
        if (representativeIds && representativeIds.size > 0) {
          const placeholders = Array.from(representativeIds).map(() => '?').join(',');
          extractQuery += ` AND cte.comment_id IN (${placeholders})`;
          extractParams.push(...Array.from(representativeIds));
        }
        
        extractQuery += ` ORDER BY cte.comment_id`;
        
        const extracts = db.prepare(extractQuery).all(...extractParams) as {
          comment_id: string;
          extract_json: string;
          structured_sections: string;
        }[];
        
        // Calculate total word count from extracts and structured sections
        const totalWords = extracts.reduce((sum, e) => {
          const extract = JSON.parse(e.extract_json);
          const sections = JSON.parse(e.structured_sections || '{}');
          
          // Count words in extract content
          const extractText = [
            ...(extract.extract.positions || []),
            ...(extract.extract.concerns || []),
            ...(extract.extract.recommendations || []),
            ...(extract.extract.experiences || []),
            ...(extract.extract.key_quotes || [])
          ].join(' ');
          
          // Count words in commenter profile
          const profileText = sections.commenterProfile || '';
          
          const totalText = extractText + ' ' + profileText;
          return sum + totalText.split(/\s+/).filter(w => w.length > 0).length;
        }, 0);
        
        console.log(`   Total word count: ${totalWords}`);
        
        let finalAnalysis: string;
        
        if (totalWords <= batchOptions.totalWordLimit) {
          // Process in single batch
          console.log(`   Processing as single batch`);
          finalAnalysis = await analyzeThemeExtracts(ai, theme, extracts, options.debug, 1, 1);
        } else {
          // Process in batches and merge
          console.log(`   Large theme - using batching`);
          finalAnalysis = await processThemeInBatches(ai, theme, extracts, batchOptions, options.debug);
        }
        
        // Structure the final summary into JSON
        console.log(`   Structuring final summary...`);
        const fullThemeDescription = theme.detailed_guidelines 
          ? `${theme.description}. ${theme.detailed_guidelines}`
          : theme.description;
          
        const structurePrompt = THEME_SUMMARY_STRUCTURE_PROMPT
          .replace('{THEME_ANALYSIS}', finalAnalysis)
          .replace('{THEME_CODE}', theme.code)
          .replace('{THEME_DESCRIPTION}', fullThemeDescription);
        
        const finalSections = await ai.generateContent<any>(
          structurePrompt,
          options.debug ? `theme_summary_v2_structured_${theme.code}` : undefined,
          undefined,
          {
            taskType: 'theme_summary_structure',
            taskLevel: 0,
            params: {
              themeCode: theme.code,
              extractCount: extracts.length
            }
          },
          parseJsonResponse
        );
        
        // Save summary
        withTransaction(db, () => {
          db.prepare(`
            INSERT INTO theme_summaries (
              theme_code, structured_sections, 
              comment_count, word_count
            )
            VALUES (?, ?, ?, ?)
          `).run(
            theme.code,
            JSON.stringify(finalSections),
            extracts.length,
            0 // We don't track word count in v2
          );
        });
        
        console.log(`   ✅ Summary generated successfully`);
        
      } catch (error) {
        console.error(`   ❌ Error:`, error);
      }
    }
  );
  
  // Summary
  const summaryCount = db.prepare("SELECT COUNT(*) as count FROM theme_summaries").get() as { count: number };
  
  console.log("\n✅ Theme summarization complete!");
  console.log(`   Total summaries: ${summaryCount.count}`);
  
  db.close();
}

async function analyzeThemeExtracts(
  ai: AIClient,
  theme: { code: string; description: string; detailed_guidelines?: string },
  extracts: { comment_id: string; extract_json: string; structured_sections: string }[],
  debug: boolean,
  batchNum?: number,
  totalBatches?: number
): Promise<string> {
  // Build extract blocks with commenter metadata and formatted content
  const extractBlocks = extracts.map(e => {
    const extract = JSON.parse(e.extract_json);
    const sections = JSON.parse(e.structured_sections || '{}');
    
    // Format the extract data as readable markdown
    let formattedExtract = '';
    
    if (extract.extract.positions?.length > 0) {
      formattedExtract += '**Positions:**\n';
      extract.extract.positions.forEach((pos: string) => {
        formattedExtract += `- ${pos}\n`;
      });
      formattedExtract += '\n';
    }
    
    if (extract.extract.concerns?.length > 0) {
      formattedExtract += '**Concerns:**\n';
      extract.extract.concerns.forEach((concern: string) => {
        formattedExtract += `- ${concern}\n`;
      });
      formattedExtract += '\n';
    }
    
    if (extract.extract.recommendations?.length > 0) {
      formattedExtract += '**Recommendations:**\n';
      extract.extract.recommendations.forEach((rec: string) => {
        formattedExtract += `- ${rec}\n`;
      });
      formattedExtract += '\n';
    }
    
    if (extract.extract.experiences?.length > 0) {
      formattedExtract += '**Experiences/Examples:**\n';
      extract.extract.experiences.forEach((exp: string) => {
        formattedExtract += `- ${exp}\n`;
      });
      formattedExtract += '\n';
    }
    
    if (extract.extract.key_quotes?.length > 0) {
      formattedExtract += '**Key Quotes:**\n';
      extract.extract.key_quotes.forEach((quote: string) => {
        formattedExtract += `- ${quote}\n`;
      });
    }
    
    return `<comment id="${e.comment_id}">
<commenter_profile>
${sections.commenterProfile || 'No profile information provided'}
</commenter_profile>

<theme_specific_content relevance="${extract.relevance}">
${formattedExtract.trim() || 'No specific content extracted for this theme'}
</theme_specific_content>
</comment>`;
  }).join('\n\n---\n\n');
  
  const fullThemeDescription = theme.detailed_guidelines 
    ? `${theme.description}. ${theme.detailed_guidelines}`
    : theme.description;
    
  const prompt = THEME_SUMMARY_FROM_EXTRACTS_PROMPT
    .replace('{THEME_CODE}', theme.code)
    .replace('{THEME_DESCRIPTION}', fullThemeDescription)
    .replace('{EXTRACTS}', extractBlocks);
  
  const debugId = batchNum 
    ? `theme_summary_v2_${theme.code}_batch_${batchNum}-of-${totalBatches}` 
    : `theme_summary_v2_${theme.code}`;
  
  const response = await ai.generateContent(
    prompt,
    debug ? debugId : undefined,
    undefined,
    {
      taskType: 'theme_summary_v2',
      taskLevel: 0,
      params: {
        themeCode: theme.code,
        batchNum: batchNum || 1,
        totalBatches: totalBatches || 1,
        extractCount: extracts.length
      }
    }
  );
  
  return response;
}

async function processThemeInBatches(
  ai: AIClient,
  theme: { code: string; description: string; detailed_guidelines?: string },
  extracts: { comment_id: string; extract_json: string; structured_sections: string }[],
  batchOptions: any,
  debug: boolean
): Promise<string> {
  // Create extract items with word counts
  const items = extracts.map(e => {
    const extract = JSON.parse(e.extract_json);
    const sections = JSON.parse(e.structured_sections || '{}');
    
    // Count words in extract content
    const extractText = [
      ...(extract.extract.positions || []),
      ...(extract.extract.concerns || []),
      ...(extract.extract.recommendations || []),
      ...(extract.extract.experiences || []),
      ...(extract.extract.key_quotes || [])
    ].join(' ');
    
    // Count words in commenter profile
    const profileText = sections.commenterProfile || '';
    
    const totalText = extractText + ' ' + profileText;
    const wordCount = totalText.split(/\s+/).filter(w => w.length > 0).length;
    
    return {
      ...e,
      wordCount
    };
  });
  
  // Create batches based on word count
  const batches = createEvenBatches(items, {
    batchWordLimit: batchOptions.batchWordLimit,
    totalWordLimit: 0 // Force batching
  });
  
  console.log(`   Split into ${batches.length} batches`);
  batches.forEach((batch, i) => {
    console.log(`   Batch ${i + 1}: ${batch.items.length} extracts, ${batch.wordCount} words`);
  });
  
  // Process each batch
  const batchResults: string[] = [];
  for (let i = 0; i < batches.length; i++) {
    console.log(`   Processing batch ${i + 1}/${batches.length}`);
    const result = await analyzeThemeExtracts(ai, theme, batches[i].items, debug, i + 1, batches.length);
    batchResults.push(result);
  }
  
  // Merge results
  console.log(`   Merging ${batchResults.length} batch results...`);
  
  const fullThemeDescription = theme.detailed_guidelines 
    ? `${theme.description}. ${theme.detailed_guidelines}`
    : theme.description;
  
  // For merging, format the batch results
  const mergeBlocks = batchResults.map((result, i) => 
    `<batch_analysis number="${i + 1}">\n${result}\n</batch_analysis>`
  ).join('\n\n');
  
  const mergePrompt = EXTRACT_MERGE_PROMPT
    .replace('{THEME_CODE}', theme.code)
    .replace('{THEME_DESCRIPTION}', fullThemeDescription)
    .replace('{EXTRACT_SETS}', mergeBlocks);
  
  const finalAnalysis = await ai.generateContent(
    mergePrompt,
    debug ? `theme_summary_v2_merge_${theme.code}_final` : undefined,
    undefined,
    {
      taskType: 'theme_summary_v2_merge',
      taskLevel: 0,
      params: {
        themeCode: theme.code,
        batchCount: batches.length
      }
    }
  );
  
  return finalAnalysis;
}