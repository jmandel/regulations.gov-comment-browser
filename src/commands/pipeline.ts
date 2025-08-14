import { Command } from "commander";
import { basename, extname } from "path";
import { loadCommentsCommand } from "./load-comments";
import { clusterCommentsFastCommand } from "./cluster-comments-fast";
import { condenseCommand } from "./condense";
import { discoverThemesCommand } from "./discover-themes";
import { extractThemeContentCommand } from "./extract-theme-content";
import { summarizeThemesV2Command } from "./summarize-themes-v2";
import { discoverEntitiesV2Command } from "./discover-entities-v2";
import { buildWebsiteCommand } from "../website-build-script";
import { vacuumDbCommand } from "./vacuum-db";
import { openDb } from "../lib/database";
import { checkClusteringStatus } from "../lib/comment-processing";

export const pipelineCommand = new Command("pipeline")
  .description("Run the complete analysis pipeline: load, cluster, condense, discover themes, extract theme content, summarize themes, discover entities, build website, and vacuum database")
  .argument("<source-arg>", "Source argument (e.g., CMS-2025-0050-0031 or path to CSV)")
  .option("-s, --skip-attachments", "Skip downloading attachments")
  .option("-d, --debug", "Enable debug mode for all steps")
  .option("-o, --output <dir>", "Output directory for website files", "dist/data")
  .option("-l, --limit-total-comment-load <N>", "Limit initial number of comments loaded")
  .option("--start-at <step>", "Start at a specific step (1-9): 1=load, 2=cluster, 3=condense, 4=discover-themes, 5=extract-theme-content, 6=summarize-themes, 7=discover-entities, 8=build-website, 9=vacuum-db")
  .option("-c, --concurrency <N>", "Number of concurrent operations")
  .option("--max-crashes <N>", "Maximum number of crashes before giving up (default: 10)", parseInt)
  .option("-m, --model <model>", "AI model to use (gemini-pro, gemini-flash, gemini-flash-lite, claude)")
  .option("--no-clustering", "Skip clustering entirely (process all comments)")
  .option("--recluster", "Force reclustering even if it exists")
  .option("--similarity-threshold <N>", "Similarity threshold for clustering (default: 0.8)", parseFloat)
  .action(async (sourceArg: string, options: any) => {
    // Detect if first argument is a CSV path (contains '.' or '/' or ends with .csv)
    const isCsv = sourceArg.includes("/") || sourceArg.toLowerCase().endsWith(".csv");
    const loadSource = sourceArg; // Passed to load-comments
    const documentId = isCsv ? basename(sourceArg, extname(sourceArg)) : sourceArg;

    const startStep = options.startAt ? parseInt(options.startAt) : 1;
    const maxCrashes = options.maxCrashes || 10;
    
    if (isNaN(startStep) || startStep < 1 || startStep > 9) {
      console.error("❌ Invalid start step. Please provide a number between 1 and 9.");
      process.exit(1);
    }
    
    console.log(`🚀 Starting pipeline for ${documentId} (source: ${loadSource}) at step ${startStep}\n`);
    console.log(`🛡️  Max crashes allowed: ${maxCrashes}`);
    
    const steps = [
      {
        num: 1,
        name: "Loading comments",
        icon: "📥",
        execute: async () => {
          await loadCommentsCommand.parseAsync([
            'bun', 'cli.ts', 
            loadSource,
            ...(options.skipAttachments ? ['--skip-attachments'] : []),
            ...(options.debug ? ['--debug'] : []),
            ...(options.limitTotalCommentLoad ? ['--limit', options.limitTotalCommentLoad] : []),
          ]);
        }
      },
      {
        num: 2,
        name: "Clustering comments",
        icon: "🔗",
        execute: async () => {
          if (options.noClustering) {
            console.log("⏭️  Skipping clustering (--no-clustering flag)");
            return;
          }
          
          // Check if clustering already exists
          const db = openDb(documentId);
          const clusteringExists = checkClusteringStatus(db);
          db.close();
          
          if (clusteringExists && !options.recluster) {
            console.log("📊 Clustering already exists, skipping");
            return;
          }
          
          await clusterCommentsFastCommand.parseAsync([
            'bun', 'cli.ts',
            documentId,
            ...(options.similarityThreshold ? ['--similarity-threshold', options.similarityThreshold] : []),
            ...(options.debug ? ['--debug'] : []),
            ...(options.recluster ? ['--force'] : [])
          ]);
        }
      },
      {
        num: 3,
        name: "Condensing comments",
        icon: "📝",
        execute: async () => {
          await condenseCommand.parseAsync([
            'bun', 'cli.ts', 
            documentId,
            ...(options.debug ? ['--debug'] : []),
            ...(options.concurrency ? ['--concurrency', options.concurrency] : []),
            ...(options.model ? ['--model', options.model] : []),
            ...(!options.noClustering ? ['--use-clustering'] : []),
          ]);
        }
      },
      {
        num: 4,
        name: "Discovering themes",
        icon: "🔍",
        execute: async () => {
          await discoverThemesCommand.parseAsync([
            'bun', 'cli.ts', 
            documentId,
            ...(options.debug ? ['--debug'] : []),
            ...(options.concurrency ? ['--concurrency', options.concurrency] : []),
            ...(options.model ? ['--model', options.model] : []),
            ...(!options.noClustering ? ['--use-clustering'] : []),
          ]);
        }
      },
      {
        num: 5,
        name: "Extracting theme content",
        icon: "🎯",
        execute: async () => {
          await extractThemeContentCommand.parseAsync([
            'bun', 'cli.ts', 
            documentId,
            ...(options.debug ? ['--debug'] : []),
            ...(options.concurrency ? ['--concurrency', options.concurrency] : []),
            ...(options.model ? ['--model', options.model] : []),
            ...(!options.noClustering ? ['--use-clustering'] : []),
          ]);
        }
      },
      {
        num: 6,
        name: "Summarizing themes",
        icon: "📄",
        execute: async () => {
          await summarizeThemesV2Command.parseAsync([
            'bun', 'cli.ts', 
            documentId,
            ...(options.debug ? ['--debug'] : []),
            ...(options.concurrency ? ['--concurrency', options.concurrency] : []),
            ...(options.model ? ['--model', options.model] : []),
            ...(!options.noClustering ? ['--use-clustering'] : []),
          ]);
        }
      },
      {
        num: 7,
        name: "Discovering entities",
        icon: "🏷️",
        execute: async () => {
          await discoverEntitiesV2Command.parseAsync([
            'bun', 'cli.ts', 
            documentId,
            ...(options.debug ? ['--debug'] : []),
            ...(options.concurrency ? ['--concurrency', options.concurrency] : []),
            ...(options.model ? ['--model', options.model] : []),
          ]);
        }
      },
      {
        num: 8,
        name: "Building website files",
        icon: "🏗️",
        execute: async () => {
          await buildWebsiteCommand.parseAsync([
            'bun', 'cli.ts', 
            documentId,
            '--output', options.output,
          ]);
        }
      },
      {
        num: 9,
        name: "Vacuuming database",
        icon: "🧹",
        execute: async () => {
          await vacuumDbCommand.parseAsync([
            'bun', 'cli.ts', 
            documentId,
            ...(options.debug ? ['--verbose'] : []),
          ]);
        }
      }
    ];
    
    let crashCount = 0;
    let currentStep = startStep;
    
    while (currentStep <= 9 && crashCount < maxCrashes) {
      try {
        // Execute only steps from currentStep onwards
        for (const step of steps) {
          if (step.num >= currentStep) {
            console.log(`\n${step.icon} Step ${step.num}/9: ${step.name}...`);
            await step.execute();
            currentStep = step.num + 1; // Move to next step on success
          } else {
            if (crashCount === 0) { // Only log skipping on first attempt
              console.log(`\n⏭️  Skipping step ${step.num}/9: ${step.name}`);
            }
          }
        }
        
        // If we get here, all steps completed successfully
        console.log("\n✅ Pipeline completed successfully!");
        console.log(`📁 Website files are in: ${options.output}`);
        console.log(`🌐 Copy to dashboard/public/data/ and run the dashboard`);
        console.log(`🧹 Database has been vacuumed and optimized`);
        break; // Exit the retry loop
        
      } catch (error) {
        crashCount++;
        console.error(`💥 Pipeline crashed at step ${currentStep} (crash ${crashCount}/${maxCrashes}):`, error);
        
        if (crashCount >= maxCrashes) {
          console.error(`❌ Pipeline failed after ${maxCrashes} crashes. Giving up.`);
          process.exit(1);
        } else {
          let retryDelaySeconds = 5; // Default retry delay
          try {
            const errorMessage = (error as Error).message || '';
            if (errorMessage.includes('429')) {
              const jsonMatch = errorMessage.match(/{.*}/s);
              if (jsonMatch) {
                const outerJson = JSON.parse(jsonMatch[0]);
                if (outerJson.error && typeof outerJson.error.message === 'string') {
                  const innerJson = JSON.parse(outerJson.error.message);
                  if (innerJson.error && Array.isArray(innerJson.error.details)) {
                    const retryInfo = innerJson.error.details.find(
                      (detail: any) => detail['@type'] === 'type.googleapis.com/google.rpc.RetryInfo'
                    );
                    if (retryInfo && typeof retryInfo.retryDelay === 'string') {
                      const seconds = parseInt(retryInfo.retryDelay.replace('s', ''), 10);
                      if (!isNaN(seconds)) {
                        retryDelaySeconds = seconds + 2; // Add a small buffer
                      }
                    }
                  }
                }
              }
            }
          } catch (e) {
            console.warn('Could not parse retry delay from 429 error, using default 5s.');
          }
          
          console.log(`🔄 Restarting from step ${currentStep} in ${retryDelaySeconds} seconds...`);
          await new Promise(resolve => setTimeout(resolve, retryDelaySeconds * 1000)); // Wait before retry
        }
      }
    }
  }); 
