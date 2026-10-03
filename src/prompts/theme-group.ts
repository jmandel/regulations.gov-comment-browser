import { THEME_SUMMARY_FROM_EXTRACTS_PROMPT } from "./theme-extract";

// Report for a top-level theme, synthesized from its sub-themes' reports (plus any comments filed
// directly under the top-level theme). Theme extraction files each point under the most specific
// theme, so a top-level theme's own extracts are a small, unrepresentative slice; this is the
// group-level view. It uses the same sections as sub-theme reports so the same structuring step
// and dashboard view apply.
const REQUIRED_SECTIONS = (() => {
  const start = THEME_SUMMARY_FROM_EXTRACTS_PROMPT.indexOf("## Required Analysis Sections");
  const end = THEME_SUMMARY_FROM_EXTRACTS_PROMPT.indexOf("## Theme-Specific Extracts");
  if (start < 0 || end < 0) throw new Error("theme summary prompt changed: section headings not found");
  return THEME_SUMMARY_FROM_EXTRACTS_PROMPT.slice(start, end).trim();
})();

export const THEME_GROUP_SUMMARY_PROMPT = `You are a senior policy analyst writing the overview report for a top-level theme in an analysis of public comments on a federal regulation.

## Theme Being Analyzed
{THEME_CODE}: {THEME_DESCRIPTION}

## Size of This Theme
This theme as a whole covers {TOTAL_SUBMISSIONS} submissions ({TOTAL_UNITS} distinct comments or form-letter groups). Use exactly this figure whenever you state the theme's total. Sub-theme counts overlap — the same commenter often appears under several sub-themes — so NEVER add sub-theme counts together or derive any other total from them.

## What You Are Given
Reports already written for each of this theme's sub-themes, with how many submissions each covers, followed by any comments filed directly under the top-level theme. Submission counts include form-letter campaigns: a campaign of N identical letters counts as N submissions.

## Your Task
Write the report for the theme as a whole. Synthesize across sub-themes rather than summarizing them one by one:
- What do commenters across this theme most broadly agree on, and how strongly (use the submission counts)?
- Where do they disagree, and along what lines (stakeholder type, specialty, setting, campaign vs. individual)?
- How do the sub-themes relate — which concerns drive the others, which recommendations recur across sub-themes?
- Name sub-themes by code and title when you attribute a point to them, so readers can drill down.
- Keep comment IDs, figures and quotations exactly as they appear in the sub-theme reports; do not invent new ones.

${REQUIRED_SECTIONS}

## Sub-Theme Reports
{SUBTHEME_REPORTS}

## Comments Filed Directly Under This Theme
{DIRECT_EXTRACTS}
`;
