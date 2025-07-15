import { Command } from "commander";
import { basename, extname } from "path";
import { loadCommentsCommand } from "./load-comments";
import { condenseCommand } from "./condense";
import { discoverThemesCommand } from "./discover-themes";
import { extractThemeContentCommand } from "./extract-theme-content";
import { summarizeThemesV2Command } from "./summarize-themes-v2";
import { discoverEntitiesV2Command } from "./discover-entities-v2";
import { buildWebsiteCommand } from "../website-build-script";

export const pipelineCommand = new Command("pipeline")
  .description("Run the complete analysis pipeline: load, condense, discover themes, extract theme content, summarize themes, discover entities, and build website")
  .argument("<source-arg>", "Source argument (e.g., CMS-2025-0050-0031 or path to CSV)")
  .option("-s, --skip-attachments", "Skip downloading attachments")
  .option("-d, --debug", "Enable debug mode for all steps")
  .option("-o, --output <dir>", "Output directory for website files", "dist/data")
  .option("-l, --limit-total-comment-load <N>", "Limit initial number of comments loaded")
  .option("--start-at <step>", "Start at a specific step (1-7): 1=load, 2=condense, 3=discover-themes, 4=extract-theme-content, 5=summarize-themes, 6=discover-entities, 7=build-website")
  .option("-c, --concurrency <N>", "Number of concurrent operations")
  .option("--max-crashes <N>", "Maximum number of crashes before giving up (default: 10)", parseInt)
  .option("-m, --model <model>", "AI model to use (gemini-pro, gemini-flash, gemini-flash-lite, claude)")
  .option("--filter-duplicates", "Filter out duplicate/form letter comments during theme discovery")
  .option("--similarity-threshold <N>", "Similarity threshold for duplicate filtering (default: 0.8)", parseFloat)
  .action(async (sourceArg: string, options: any) => {
    // Detect if first argument is a CSV path (contains '.' or '/' or ends with .csv)
    const isCsv = sourceArg.includes("/") || sourceArg.toLowerCase().endsWith(".csv");
    const loadSource = sourceArg; // Passed to load-comments
    const documentId = isCsv ? basename(sourceArg, extname(sourceArg)) : sourceArg;

    const startStep = options.startAt ? parseInt(options.startAt) : 1;
    const maxCrashes = options.maxCrashes || 10;
    
    if (isNaN(startStep) || startStep < 1 || startStep > 7) {
      console.error("❌ Invalid start step. Please provide a number between 1 and 7.");
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
        name: "Condensing comments",
        icon: "📝",
        execute: async () => {
          await condenseCommand.parseAsync([
            'bun', 'cli.ts', 
            documentId,
            ...(options.debug ? ['--debug'] : []),
            ...(options.concurrency ? ['--concurrency', options.concurrency] : []),
            ...(options.model ? ['--model', options.model] : []),
          ]);
        }
      },
      {
        num: 3,
        name: "Discovering themes",
        icon: "🔍",
        execute: async () => {
          await discoverThemesCommand.parseAsync([
            'bun', 'cli.ts', 
            documentId,
            ...(options.debug ? ['--debug'] : []),
            ...(options.concurrency ? ['--concurrency', options.concurrency] : []),
            ...(options.model ? ['--model', options.model] : []),
            ...(options.filterDuplicates ? ['--filter-duplicates'] : []),
            ...(options.similarityThreshold ? ['--similarity-threshold', options.similarityThreshold] : []),
          ]);
        }
      },
      {
        num: 4,
        name: "Extracting theme content",
        icon: "🎯",
        execute: async () => {
          await extractThemeContentCommand.parseAsync([
            'bun', 'cli.ts', 
            documentId,
            ...(options.debug ? ['--debug'] : []),
            ...(options.concurrency ? ['--concurrency', options.concurrency] : []),
            ...(options.model ? ['--model', options.model] : []),
          ]);
        }
      },
      {
        num: 5,
        name: "Summarizing themes",
        icon: "📄",
        execute: async () => {
          await summarizeThemesV2Command.parseAsync([
            'bun', 'cli.ts', 
            documentId,
            ...(options.debug ? ['--debug'] : []),
            ...(options.concurrency ? ['--concurrency', options.concurrency] : []),
            ...(options.model ? ['--model', options.model] : []),
            ...(options.filterDuplicates ? ['--filter-duplicates'] : []),
            ...(options.similarityThreshold ? ['--similarity-threshold', options.similarityThreshold] : []),
          ]);
        }
      },
      {
        num: 6,
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
        num: 7,
        name: "Building website files",
        icon: "🏗️",
        execute: async () => {
          await buildWebsiteCommand.parseAsync([
            'bun', 'cli.ts', 
            documentId,
            '--output', options.output,
          ]);
        }
      }
    ];
    
    let crashCount = 0;
    let currentStep = startStep;
    
    while (currentStep <= 7 && crashCount < maxCrashes) {
      try {
        // Execute only steps from currentStep onwards
        for (const step of steps) {
          if (step.num >= currentStep) {
            console.log(`\n${step.icon} Step ${step.num}/7: ${step.name}...`);
            await step.execute();
            currentStep = step.num + 1; // Move to next step on success
          } else {
            if (crashCount === 0) { // Only log skipping on first attempt
              console.log(`\n⏭️  Skipping step ${step.num}/7: ${step.name}`);
            }
          }
        }
        
        // If we get here, all steps completed successfully
        console.log("\n✅ Pipeline completed successfully!");
        console.log(`📁 Website files are in: ${options.output}`);
        console.log(`🌐 Copy to dashboard/public/data/ and run the dashboard`);
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
