import { Command } from "commander";
import { basename, extname } from "path";
import { loadCommentsCommand } from "./load-comments";
import { clusterFormLettersCommand } from "./cluster-form-letters";
import { tagCampaignsCommand } from "./tag-campaigns";
import { matchScansCommand } from "./match-scans";
import { triageCommand } from "./triage";
import { transcribeCommand } from "./transcribe";
import { condenseCommand } from "./condense";
import { classifySubmittersCommand } from "./classify-submitters";
import { discoverThemesCommand } from "./discover-themes";
import { extractThemeContentCommand } from "./extract-theme-content";
import { summarizeThemesV2Command } from "./summarize-themes-v2";
import { discoverEntitiesV2Command } from "./discover-entities-v2";
import { buildWebsiteCommand } from "../website-build-script";
import { vacuumDbCommand } from "./vacuum-db";
import { openDb } from "../lib/database";
import { checkClusteringStatus } from "../lib/comment-processing";
import { scopeRelevanceCommand } from "./scope";
import { openScopeDb, getScope, hasClustering } from "../lib/scope-db";

export const pipelineCommand = new Command("pipeline")
  .description("Run the complete analysis pipeline: load, cluster, triage, transcribe, match scanned copies, tag campaigns (optional), classify submitters, condense, discover themes, extract theme content, summarize themes, discover entities, build website, and vacuum database")
  .argument("<source-arg>", "Source argument (e.g., CMS-2025-0050-0031 or path to CSV)")
  .option("-s, --skip-attachments", "Skip downloading attachments")
  .option("--mirrulations", "Load comments from the Mirrulations S3 mirror instead of the regulations.gov API (best for large dockets)")
  .option("--whole-docket", "With --mirrulations: include comments on every document in the docket")
  .option("-d, --debug", "Enable debug mode for all steps")
  .option("-o, --output <dir>", "Output directory for website files", "dist/data")
  .option("-l, --limit-total-comment-load <N>", "Limit initial number of comments loaded")
  .option("--start-at <step>", "Start at a specific step (1-14): 1=load, 2=cluster, 3=triage, 4=transcribe, 5=match-scans, 6=tag-campaigns (only with --tag-campaigns), 7=classify-submitters, 8=condense, 9=discover-themes, 10=extract-theme-content, 11=summarize-themes, 12=discover-entities, 13=build-website, 14=vacuum-db")
  .option("-c, --concurrency <N>", "Number of concurrent operations")
  .option("--batch", "Run LLM steps (triage, transcribe, classify-submitters, condense, theme discovery/extraction/summaries) through the Gemini Batch API: half price, minutes-to-hours per step")
  .option("--max-crashes <N>", "Maximum number of crashes before giving up (default: 10)", parseInt)
  .option("-m, --model <model>", "Override the per-step models in batch-config.json for every step (e.g. gemini-3.8-flash, gemini-3.5-flash-lite)")
  .option("--no-clustering", "Skip clustering entirely (process all comments)")
  .option("--recluster", "Force reclustering even if it exists")
  .option("--tag-campaigns", "Run step 6, tag-campaigns: detect organized (incl. paraphrased) comment campaigns with embeddings + an LLM judge (~$3-4 at 43k comments). Off by default")
  .option("--similarity-threshold <N>", "Similarity threshold for form-letter clustering (default: 0.5)", parseFloat)
  .option("--scope <slug>", "Run a scoped analysis instead (scope-relevance, discover-themes, extract-theme-content, summarize-themes in the scope DB). Requires the docket's steps 1-7 to be done and the scope created with 'scope create'")
  .action(async (sourceArg: string, options: any) => {
    if (options.scope) return runScopedPipeline(sourceArg, options);
    // Detect if first argument is a CSV path (contains '.' or '/' or ends with .csv)
    const isCsv = sourceArg.includes("/") || sourceArg.toLowerCase().endsWith(".csv");
    const loadSource = sourceArg; // Passed to load-comments
    const documentId = isCsv ? basename(sourceArg, extname(sourceArg)) : sourceArg;

    const startStep = options.startAt ? parseInt(options.startAt) : 1;
    const maxCrashes = options.maxCrashes || 10;
    
    const STEP_COUNT = 14;
    if (isNaN(startStep) || startStep < 1 || startStep > STEP_COUNT) {
      console.error(`❌ Invalid start step. Please provide a number between 1 and ${STEP_COUNT}.`);
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
            ...(options.mirrulations ? ['--mirrulations'] : []),
            ...(options.wholeDocket ? ['--whole-docket'] : []),
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
          if (!options.clustering) {
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
          
          await clusterFormLettersCommand.parseAsync([
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
        name: "Triaging short comments",
        icon: "🚦",
        execute: async () => {
          await triageCommand.parseAsync([
            'bun', 'cli.ts',
            documentId,
            ...(options.debug ? ['--debug'] : []),
            ...(options.concurrency ? ['--concurrency', options.concurrency] : []),
            ...(options.model ? ['--model', options.model] : []),
            ...(options.batch ? ['--batch'] : []),
          ]);
        }
      },
      {
        num: 4,
        name: "Transcribing comments",
        icon: "📜",
        execute: async () => {
          await transcribeCommand.parseAsync([
            'bun', 'cli.ts', 
            documentId,
            ...(options.debug ? ['--debug'] : []),
            ...(options.concurrency ? ['--concurrency', options.concurrency] : []),
            ...(options.model ? ['--model', options.model] : []),
            ...(!!options.clustering ? ['--use-clustering'] : []),
            ...(options.batch ? ['--batch'] : []),
          ]);
        }
      },
      {
        num: 5,
        name: "Matching scanned copies to form letters",
        icon: "🖨️",
        execute: async () => {
          if (!options.clustering) {
            console.log("⏭️  Skipping scan matching (--no-clustering flag)");
            return;
          }
          await matchScansCommand.parseAsync(['bun', 'cli.ts', documentId]);
        }
      },
      {
        num: 6,
        name: "Tagging comment campaigns",
        icon: "📣",
        execute: async () => {
          if (!options.tagCampaigns) {
            console.log("⏭️  Skipping campaign tagging (enable with --tag-campaigns)");
            return;
          }
          await tagCampaignsCommand.parseAsync([
            'bun', 'cli.ts',
            documentId,
            ...(options.concurrency ? ['--concurrency', options.concurrency] : []),
            ...(options.model ? ['--model', options.model] : []),
            ...(options.batch ? ['--batch'] : []),
          ]);
        }
      },
      {
        num: 7,
        name: "Classifying submitters",
        icon: "🪪",
        execute: async () => {
          await classifySubmittersCommand.parseAsync([
            'bun', 'cli.ts',
            documentId,
            ...(options.concurrency ? ['--concurrency', options.concurrency] : []),
            ...(options.model ? ['--model', options.model] : []),
            ...(options.batch ? ['--batch'] : []),
          ]);
        }
      },
      {
        num: 8,
        name: "Condensing comments",
        icon: "📝",
        execute: async () => {
          await condenseCommand.parseAsync([
            'bun', 'cli.ts', 
            documentId,
            ...(options.debug ? ['--debug'] : []),
            ...(options.concurrency ? ['--concurrency', options.concurrency] : []),
            ...(options.model ? ['--model', options.model] : []),
            ...(options.batch ? ['--batch'] : []),
            ...(!!options.clustering ? ['--use-clustering'] : []),
          ]);
        }
      },
      {
        num: 9,
        name: "Discovering themes",
        icon: "🔍",
        execute: async () => {
          await discoverThemesCommand.parseAsync([
            'bun', 'cli.ts', 
            documentId,
            ...(options.debug ? ['--debug'] : []),
            ...(options.concurrency ? ['--concurrency', options.concurrency] : []),
            ...(options.model ? ['--model', options.model] : []),
            ...(!!options.clustering ? ['--use-clustering'] : []),
            ...(options.batch ? ['--batch'] : []),
          ]);
        }
      },
      {
        num: 10,
        name: "Extracting theme content",
        icon: "🎯",
        execute: async () => {
          await extractThemeContentCommand.parseAsync([
            'bun', 'cli.ts', 
            documentId,
            ...(options.debug ? ['--debug'] : []),
            ...(options.concurrency ? ['--concurrency', options.concurrency] : []),
            ...(options.model ? ['--model', options.model] : []),
            ...(!!options.clustering ? ['--use-clustering'] : []),
            ...(options.batch ? ['--batch'] : []),
          ]);
        }
      },
      {
        num: 11,
        name: "Summarizing themes",
        icon: "📄",
        execute: async () => {
          await summarizeThemesV2Command.parseAsync([
            'bun', 'cli.ts', 
            documentId,
            ...(options.debug ? ['--debug'] : []),
            ...(options.concurrency ? ['--concurrency', options.concurrency] : []),
            ...(options.model ? ['--model', options.model] : []),
            ...(!!options.clustering ? ['--use-clustering'] : []),
            ...(options.batch ? ['--batch'] : []),
          ]);
        }
      },
      {
        num: 12,
        name: "Discovering entities",
        icon: "🏷️",
        execute: async () => {
          await discoverEntitiesV2Command.parseAsync([
            'bun', 'cli.ts', 
            documentId,
            ...(options.debug ? ['--debug'] : []),
            ...(options.model ? ['--model', options.model] : []),
            ...(options.batch ? ['--batch'] : []),
          ]);
        }
      },
      {
        num: 13,
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
        num: 14,
        name: "Vacuuming database",
        icon: "🧹",
        execute: async () => {
          await vacuumDbCommand.parseAsync([
            'bun', 'cli.ts', 
            documentId,
            ...(options.debug ? ['--verbose'] : []),
          ]);
        }
      },
    ];
    
    let crashCount = 0;
    let currentStep = startStep;
    
    while (currentStep <= STEP_COUNT && crashCount < maxCrashes) {
      try {
        // Execute only steps from currentStep onwards
        for (const step of steps) {
          if (step.num >= currentStep) {
            console.log(`\n${step.icon} Step ${step.num}/${STEP_COUNT}: ${step.name}...`);
            await step.execute();
            currentStep = step.num + 1; // Move to next step on success
          } else {
            if (crashCount === 0) { // Only log skipping on first attempt
              console.log(`\n⏭️  Skipping step ${step.num}/${STEP_COUNT}: ${step.name}`);
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

// Scoped pipeline: S1 relevance, S2 discovery, S3 extraction, S4 summaries, all in the scope DB.
// Every step resumes, so rerunning after a failure continues where it stopped. (Website output for
// scopes is not built here yet.)
async function runScopedPipeline(documentId: string, options: any) {
  const slug: string = options.scope;
  const db = openScopeDb(documentId, slug);
  const scope = getScope(db);
  // The docket's shared steps must be done: units without a condensed row are invisible to scoped
  // steps. Allow a small failure rate (condense errors on a handful of comments).
  const repsOnly = hasClustering(db);
  const r = db.prepare(`
    SELECT COUNT(*) AS units, SUM(cc.comment_id IS NOT NULL) AS condensed
    FROM comments c
    ${repsOnly ? "JOIN comment_cluster_membership m ON m.comment_id = c.id AND m.is_representative = 1" : ""}
    LEFT JOIN condensed_comments cc ON cc.comment_id = c.id AND cc.status = 'completed'
    WHERE c.id NOT IN (SELECT comment_id FROM comment_triage WHERE label IN ('no_substance', 'stance_only'))`).get() as { units: number; condensed: number | null };
  db.close();
  const missing = r.units - (r.condensed || 0);
  if (!r.condensed || missing > Math.max(5, r.units * 0.02)) {
    console.error(`❌ The docket's shared steps aren't done: ${r.condensed || 0} of ${r.units} units condensed. Run them first:\n   bun run src/cli.ts pipeline ${documentId} --start-at 1   (or --start-at <step> to resume; steps 1-8 are needed)`);
    process.exit(1);
  }
  if (missing > 0) console.warn(`⚠️  ${missing} units have no condensed row and won't be in the scoped analysis`);

  console.log(`🔭 Scoped pipeline for ${documentId} / ${slug}: ${scope.name}`);
  const common = [
    ...(options.concurrency ? ['--concurrency', options.concurrency] : []),
    ...(options.model ? ['--model', options.model] : []),
    ...(options.batch ? ['--batch'] : []),
  ];
  const steps: [string, () => Promise<unknown>][] = [
    ["S1 scope-relevance", () => scopeRelevanceCommand.parseAsync(['bun', 'cli.ts', documentId, '--scope', slug, ...common])],
    ["S2 discover-themes", () => discoverThemesCommand.parseAsync(['bun', 'cli.ts', documentId, '--scope', slug, ...common, ...(options.debug ? ['--debug'] : [])])],
    ["S3 extract-theme-content", () => extractThemeContentCommand.parseAsync(['bun', 'cli.ts', documentId, '--scope', slug, ...common, ...(options.debug ? ['--debug'] : [])])],
    ["S4 summarize-themes", () => summarizeThemesV2Command.parseAsync(['bun', 'cli.ts', documentId, '--scope', slug, ...common, ...(options.debug ? ['--debug'] : [])])],
  ];
  for (const [name, run] of steps) {
    console.log(`\n▶️  ${name}`);
    await run();
  }
  console.log(`\n✅ Scoped analysis "${slug}" complete; build-website <doc> --scope ${slug} builds its sub-site`);
}
