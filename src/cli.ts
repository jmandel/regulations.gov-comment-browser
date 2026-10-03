#!/usr/bin/env bun
import { Command } from "commander";
import { loadCommentsCommand } from "./commands/load-comments";
import { clusterFormLettersCommand } from "./commands/cluster-form-letters";
import { tagCampaignsCommand } from "./commands/tag-campaigns";
import { matchScansCommand } from "./commands/match-scans";
import { transcribeCommand } from "./commands/transcribe";
import { triageCommand } from "./commands/triage";
import { classifySubmittersCommand } from "./commands/classify-submitters";
import { condenseCommand } from "./commands/condense";
import { discoverThemesCommand } from "./commands/discover-themes";
import { extractThemeContentCommand } from "./commands/extract-theme-content";
import { summarizeThemesV2Command } from "./commands/summarize-themes-v2";
import { discoverEntitiesV2Command } from "./commands/discover-entities-v2";
import { buildWebsiteCommand } from "./website-build-script";
import { pipelineCommand } from "./commands/pipeline";
import { generateLandingPageCommand } from "./commands/generate-landing-page";
import { cacheCommand } from "./commands/cache";
import { vacuumDbCommand } from "./commands/vacuum-db";
import { buildSkillCommand } from "./commands/build-skill";
import { scopeCommand, scopeRelevanceCommand } from "./commands/scope";

const program = new Command()
  .name("regulations-comment-analysis")
  .description("Analysis pipeline for public comments from regulations.gov")
  .version("3.0.0");

// Register all commands
program.addCommand(loadCommentsCommand);
program.addCommand(clusterFormLettersCommand);
program.addCommand(tagCampaignsCommand);
program.addCommand(matchScansCommand);
program.addCommand(transcribeCommand);
program.addCommand(triageCommand);
program.addCommand(condenseCommand);
program.addCommand(classifySubmittersCommand);
program.addCommand(discoverThemesCommand);
program.addCommand(extractThemeContentCommand);
program.addCommand(summarizeThemesV2Command);
program.addCommand(discoverEntitiesV2Command);
program.addCommand(buildWebsiteCommand);
program.addCommand(pipelineCommand);
program.addCommand(generateLandingPageCommand);
program.addCommand(cacheCommand);
program.addCommand(vacuumDbCommand);
program.addCommand(buildSkillCommand);
program.addCommand(scopeCommand);
program.addCommand(scopeRelevanceCommand);

// Parse and execute
program.parse();

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
