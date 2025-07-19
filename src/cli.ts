#!/usr/bin/env bun
import { Command } from "commander";
import { loadCommentsCommand } from "./commands/load-comments";
import { condenseCommand } from "./commands/condense";
import { discoverThemesCommand } from "./commands/discover-themes";
import { scoreThemesCommand } from "./commands/score-themes";
import { summarizeThemesCommand } from "./commands/summarize-themes";
import { extractThemeContentCommand } from "./commands/extract-theme-content";
import { summarizeThemesV2Command } from "./commands/summarize-themes-v2";
import { discoverEntitiesV2Command } from "./commands/discover-entities-v2";
import { buildWebsiteCommand } from "./website-build-script";
import { pipelineCommand } from "./commands/pipeline";
import { generateLandingPageCommand } from "./commands/generate-landing-page";
import { cacheCommand } from "./commands/cache";
import { vacuumDbCommand } from "./commands/vacuum-db";

const program = new Command()
  .name("regulations-comment-analysis")
  .description("Analysis pipeline for public comments from regulations.gov")
  .version("3.0.0");

// Register all commands
program.addCommand(loadCommentsCommand);
program.addCommand(condenseCommand);
program.addCommand(discoverThemesCommand);
program.addCommand(scoreThemesCommand);
program.addCommand(summarizeThemesCommand);
program.addCommand(extractThemeContentCommand);
program.addCommand(summarizeThemesV2Command);
program.addCommand(discoverEntitiesV2Command);
program.addCommand(buildWebsiteCommand);
program.addCommand(pipelineCommand);
program.addCommand(generateLandingPageCommand);
program.addCommand(cacheCommand);
program.addCommand(vacuumDbCommand);

// Parse and execute
program.parse();

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
