import { Command } from "commander";
import { openDb, withTransaction } from "../lib/database";
import type { Database } from "bun:sqlite";
import { initDebug } from "../lib/debug";
import { AIClient } from "../lib/ai-client";
import { loadCondensedComments, parseThemeHierarchy, getRepresentativeCommentIds } from "../lib/comment-processing";
import { createEvenBatches, DEFAULT_BATCH_OPTIONS } from "../lib/batch-processor";
import { THEME_DISCOVERY_PROMPT, THEME_MERGE_PROMPT } from "../prompts/theme-discovery";
import { TaskQueue, buildHierarchicalTasks, type Task } from "../lib/task-queue";
import { getTaskConfig, getBatchOptions, getTaskModel } from "../lib/batch-config";

export const discoverThemesCommand = new Command("discover-themes")
  .description("Discover theme hierarchy from condensed comments")
  .argument("<document-id>", "Document ID (e.g., CMS-2025-0050-0031)")
  .option("-l, --limit <n>", "Process only N comments", parseInt)
  .option("--batch-limit <n>", "Word limit to trigger batching (default: 250000)", parseInt)
  .option("--batch-size <n>", "Target words per batch (default: 150000)", parseInt)
  .option("-d, --debug", "Enable debug output")
  .option("-c, --concurrency <n>", "Number of parallel API calls (default: 5)", parseInt)
  .option("-m, --model <model>", "AI model to use (overrides config)")
  .option("--merge-width <n>", "Number of taxonomies to merge at once (default: 10)", parseInt)
  .option("--filter-duplicates", "Filter out duplicate comments using clustering")
  .option("--similarity-threshold <n>", "Similarity threshold for duplicate filtering (default: 0.8)", parseFloat)
  .action(discoverThemes);

async function discoverThemes(documentId: string, options: any) {
  await initDebug(options.debug);
  
  const db = openDb(documentId);
  
  // Get the effective model from config
  const effectiveModel = getTaskModel('discoverThemes', options.model);
  const ai = new AIClient(effectiveModel, db);
  
  console.log(`🔍 Discovering themes for document ${documentId}`);
  console.log(`   Using model: ${effectiveModel}`);
  
  // Check if themes already exist
  const existingThemes = db.prepare("SELECT COUNT(*) as count FROM theme_hierarchy").get() as { count: number };
  if (existingThemes.count > 0) {
    console.log(`⚠️  Themes already discovered (${existingThemes.count} themes in hierarchy)`);
    console.log("   To re-run, clear theme_hierarchy table first");
    return;
  }
  
  // Optionally filter duplicates using clustering
  let filterIds: Set<string> | undefined;
  if (options.filterDuplicates) {
    const threshold = options.similarityThreshold || 0.8;
    filterIds = await getRepresentativeCommentIds(db, threshold);
  }
  
  // Load condensed comments (filtered if requested)
  const comments = loadCondensedComments(db, options.limit, filterIds);
  if (comments.length === 0) {
    console.log("❌ No condensed comments found. Run 'condense' command first.");
    return;
  }
  
  console.log(`📊 Loaded ${comments.length} condensed comments${filterIds ? ' (filtered for duplicates)' : ''}`);
  
  // Load task configuration
  const taskConfig = getTaskConfig('discoverThemes', options.model);
  const batchOptions = getBatchOptions('discoverThemes');
  
  // Calculate total word count
  const totalWords = comments.reduce((sum, c) => sum + (c.wordCount || 0), 0);
  console.log(`📊 Total words: ${totalWords}`);
  
  // Determine batching strategy
  const batchLimit = options.batchLimit || batchOptions?.triggerWordLimit || DEFAULT_BATCH_OPTIONS.totalWordLimit;
  const batchWordLimit = options.batchSize || batchOptions?.batchWordLimit || DEFAULT_BATCH_OPTIONS.batchWordLimit;
  
  // Create batches
  let batches;
  if (totalWords <= batchLimit) {
    console.log(`✅ Small dataset (${totalWords} ≤ ${batchLimit}) - processing as single batch`);
    batches = [{
      items: comments,
      wordCount: totalWords,
      number: 1
    }];
  } else {
    console.log(`📦 Large dataset (${totalWords} > ${batchLimit}) - will create batches of ~${batchWordLimit} words`);
    batches = createEvenBatches(comments, { 
      batchWordLimit,
      totalWordLimit: 0 // Force batching
    });
  }
  
  console.log(`📋 Created ${batches.length} batch(es)`);
  
  // Build tasks using the hierarchical helper
  // Always force a final merge to apply reshaping/optimization logic
  const mergeWidth = options.mergeWidth || taskConfig.mergeWidth;
  const tasks: Task[] = buildHierarchicalTasks(
    batches,
    (_, i) => `batch_${i}`,
    'merge',
    mergeWidth,
    true  // forceFinalize - ensures merge prompt runs even for single batch
  );
  
  if (mergeWidth !== taskConfig.mergeWidth) {
    console.log(`🔀 Using ${mergeWidth}-way merges`);
  }
  
  // Update batch tasks with actual data
  tasks.forEach(task => {
    if (task.data.type === 'initial') {
      task.data = task.data.item; // The batch data
    }
  });
  
  const totalTasks = tasks.length;
  const mergeTasks = totalTasks - batches.length;
  console.log(`📊 Total tasks: ${totalTasks} (batches: ${batches.length}, merges: ${mergeTasks})`);
  
  if (batches.length === 1 && mergeTasks > 0) {
    console.log(`🔀 Single batch will be finalized through merge for optimization`);
  }
  
  // Find the final task (highest level merge or single batch)
  const finalTaskId = tasks[tasks.length - 1].id;
  
  // Process using TaskQueue
  const concurrency = options.concurrency || taskConfig.concurrency;
  console.log(`\n🚀 Processing with concurrency ${concurrency}`);
  
  const taskQueue = new TaskQueue(tasks, {
    concurrency,
    onTaskStart: (task) => {
      const queueInfo = `${taskQueue['running'].size}/${concurrency} workers`;
      console.log(`   🚀 [${task.id}] Starting (${queueInfo} active)`);
    },
    onTaskComplete: (task) => {
      const progress = `${taskQueue.getCompleted().size}/${totalTasks}`;
      console.log(`   ✅ [${task.id}] Completed (${progress} total)`);
    },
    onTaskError: (task, error) => {
      console.error(`   ❌ [${task.id}] Failed:`, error);
    },
    onQueueUpdate: (queueSize, runningSize, completedSize) => {
      if (queueSize > 0) {
        console.log(`   📋 Queue update: ${queueSize} ready, ${runningSize} running, ${completedSize} completed`);
      }
    }
  });
  
  const results = await taskQueue.process(async (task, getResult) => {
    // Determine task type and process accordingly
    if (task.id.startsWith('batch_')) {
      return processBatch(task, ai, options.debug);
    } else {
      // Merge task - handle N-way merges
      const inputResults = task.data.inputs.map((id: string) => {
        const result = getResult(id);
        if (!result) {
          throw new Error(`Missing dependency ${id} for ${task.id}`);
        }
        return result;
      });
      
      return processMerge(task, inputResults, ai, options.debug);
    }
  });
  
  // Get final result
  const finalThemesText = results.get(finalTaskId);
  if (!finalThemesText) {
    throw new Error("Failed to get final result");
  }
  
  // Save theme hierarchy
  console.log("\n💾 Saving theme hierarchy...");
  saveThemeHierarchy(db, finalThemesText);
  
  // Summary
  const themeCount = db.prepare("SELECT COUNT(*) as count FROM theme_hierarchy").get() as { count: number };
  
  console.log("\n✅ Theme discovery complete!");
  console.log(`   Themes: ${themeCount.count}`);
  
  db.close();
}

async function processBatch(
  task: Task,
  ai: AIClient,
  debug: boolean
): Promise<string> {
  const batch = task.data;
  console.log(`   🔄 [${task.id}] Processing batch (${batch.items.length} comments, ${batch.wordCount} words)`);
  
  // Build prompt with structured comment sections
  const commentBlocks = batch.items.map((c: any) => {
    const sections = c.structuredSections;
    const metadata = c.metadata || {};
    
    if (!sections) {
      return `<comment id="${c.id}">
<submitter>${metadata.submitter || 'Anonymous'}</submitter>
<submitter_type>${metadata.submitterType || 'Individual'}</submitter_type>
<note>No structured content available</note>
</comment>`;
    }
    
    let content = `<comment id="${c.id}">
<submitter>${metadata.submitter || 'Anonymous'}</submitter>
<submitter_type>${metadata.submitterType || 'Individual'}</submitter_type>`;
    
    if (sections.commenterProfile) {
      content += `
<commenter_profile>${sections.commenterProfile}</commenter_profile>`;
    }
    
    if (sections.corePosition) {
      content += `
<core_position>${sections.corePosition}</core_position>`;
    }
    
    if (sections.keyRecommendations && sections.keyRecommendations !== "No specific recommendations provided") {
      content += `
<key_recommendations>${sections.keyRecommendations}</key_recommendations>`;
    }
    
    if (sections.mainConcerns && sections.mainConcerns !== "No specific concerns raised") {
      content += `
<main_concerns>${sections.mainConcerns}</main_concerns>`;
    }
    
    content += `
</comment>`;
    
    return content;
  }).join("\n\n");
  
  const prompt = THEME_DISCOVERY_PROMPT.replace("{COMMENTS}", commentBlocks);
  
  // Generate themes with caching
  const response = await ai.generateContent(
    prompt,
    debug ? `themes_${task.id}` : undefined,
    task.id,
    {
      taskType: 'theme_discovery',
      taskLevel: 0, // Batch tasks are level 0
      params: { 
        taskId: task.id,
        commentCount: batch.items.length,
        wordCount: batch.wordCount
      }
    }
  );
  
  return response.trim();
}

async function processMerge(
  task: Task,
  inputContents: string[],
  ai: AIClient,
  debug: boolean
): Promise<string> {
  console.log(`   🔄 [${task.id}] Merging ${task.data.inputs.join(' + ')}`);
  
  // Build the prompt with N taxonomies
  const taxonomySections = inputContents.map((content, i) => 
    `--- INPUT TAXONOMY ${i + 1} ---\n${content}\n--- END OF INPUT TAXONOMY ${i + 1} ---`
  ).join('\n\n');
  
  const prompt = THEME_MERGE_PROMPT.replace("{TAXONOMIES}", taxonomySections);
  
  // Extract level from task id (e.g., "merge_L1_P0" -> level 1)
  const levelMatch = task.id.match(/_L(\d+)_/);
  const level = levelMatch ? parseInt(levelMatch[1]) : 0;
  
  const response = await ai.generateContent(
    prompt,
    debug ? `themes_${task.id}` : undefined,
    task.id,
    {
      taskType: 'theme_discovery_merge',
      taskLevel: level,
      params: {
        taskId: task.id,
        inputIds: task.data.inputs,
        mergeCount: inputContents.length
      }
    }
  );
  
  return response.trim();
}

// Save theme hierarchy to database
function saveThemeHierarchy(db: Database, themesText: string) {
  const themes = parseThemeHierarchy(themesText);
  
  const insertTheme = db.prepare(`
    INSERT INTO theme_hierarchy (code, description, level, parent_code, detailed_guidelines)
    VALUES (?, ?, ?, ?, ?)
  `);
  
  withTransaction(db, () => {
    for (const theme of themes) {
      insertTheme.run(
        theme.code,
        theme.description,
        theme.level,
        theme.parent_code,
        theme.detailed_guidelines || null
      );
    }
  });
}