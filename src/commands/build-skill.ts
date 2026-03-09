import { Command } from "commander";
import { openDb } from "../lib/database";
import { mkdir, writeFile, readdir } from "fs/promises";
import { join } from "path";
import { $ } from "bun";

export const buildSkillCommand = new Command("build-skill")
  .description("Generate AI skill package from regulation databases")
  .option("-d, --db-dir <dir>", "Directory containing SQLite databases", "dbs")
  .option("-o, --output <dir>", "Output directory for skill files", "dist/skill")
  .option("--base-url <url>", "Base URL for published data", "https://joshuamandel.com/regulations.gov-comment-browser")
  .action(buildSkill);

interface DocketInfo {
  id: string;
  title: string;
  agency: string;
  commentCount: number;
  themeCount: number;
  entityCount: number;
  generatedAt: string;
}

async function buildSkill(options: { dbDir: string; output: string; baseUrl: string }) {
  console.log("🧠 Building AI skill package...");

  const dbDir = options.dbDir;
  const outputDir = options.output;
  const baseUrl = options.baseUrl;

  await mkdir(outputDir, { recursive: true });

  // Find all SQLite databases
  const files = await readdir(dbDir);
  const dbFiles = files.filter(f => {
    if (!f.endsWith('.sqlite')) return false;
    if (f.includes('.sqlite-')) return false;
    if (f.endsWith('.sqlite.sqlite')) return false;
    if (f.includes('.sqlite.')) return false;
    return true;
  });

  if (dbFiles.length === 0) {
    console.log("❌ No databases found in", dbDir);
    return;
  }

  // Collect docket metadata
  const dockets: DocketInfo[] = [];

  for (const dbFile of dbFiles) {
    const documentId = dbFile.replace('.sqlite', '');
    try {
      const db = openDb(documentId);

      let title = documentId;
      let agency = "Unknown Agency";

      try {
        const hasMetadata = db.prepare(`
          SELECT name FROM sqlite_master
          WHERE type='table' AND name='document_metadata'
        `).get();

        if (hasMetadata) {
          const metadata = db.prepare(`
            SELECT title, agency_name, agency_id
            FROM document_metadata
            WHERE document_id = ?
          `).get(documentId) as any;

          if (metadata) {
            title = metadata.title || documentId;
            agency = metadata.agency_name || metadata.agency_id || "Unknown Agency";
          }
        }
      } catch (_) {}

      const commentCount = (db.prepare("SELECT COUNT(*) as count FROM comments").get() as any).count;
      const themeCount = (db.prepare("SELECT COUNT(*) as count FROM theme_hierarchy").get() as any).count;

      let entityCount = 0;
      try {
        entityCount = (db.prepare("SELECT COUNT(*) as count FROM entity_taxonomy").get() as any).count;
      } catch (_) {}

      dockets.push({
        id: documentId,
        title,
        agency,
        commentCount,
        themeCount,
        entityCount,
        generatedAt: new Date().toISOString(),
      });

      db.close();
    } catch (error) {
      console.warn(`  ⚠️  Skipping ${documentId}:`, error);
    }
  }

  dockets.sort((a, b) => b.commentCount - a.commentCount);

  const skillMd = generateSkillMd(dockets, baseUrl);

  // Write standalone SKILL.md
  await writeFile(join(outputDir, "SKILL.md"), skillMd);
  console.log(`  ✅ SKILL.md written`);

  // Create zip
  const zipDir = join(outputDir, "regulations-comment-browser");
  await mkdir(zipDir, { recursive: true });
  await writeFile(join(zipDir, "SKILL.md"), skillMd);

  const zipPath = join(outputDir, "regulations-comment-browser.zip");
  await $`cd ${outputDir} && zip -r regulations-comment-browser.zip regulations-comment-browser/`;
  // Clean up temp dir
  await $`rm -rf ${zipDir}`;

  console.log(`  ✅ ${zipPath} created`);
  console.log(`🧠 Skill package built with ${dockets.length} docket(s)`);
}

function generateSkillMd(dockets: DocketInfo[], baseUrl: string): string {
  const docketTable = dockets.map(d =>
    `| ${d.id} | ${d.title} | ${d.agency} | ${d.commentCount.toLocaleString()} | ${d.themeCount} | ${d.entityCount} |`
  ).join('\n');

  const generatedDate = new Date().toISOString().split('T')[0];

  return `---
name: regulations-comment-browser
description: |
  Search and analyze public comments on U.S. federal regulations from regulations.gov.
  Use this skill whenever the user asks about public comments on federal rules, regulatory
  feedback, stakeholder positions, or health IT policy. Use when users mention regulations.gov,
  docket IDs, rulemaking, notice-and-comment, or want to understand what commenters said about
  a proposed rule. Also use when someone asks about themes or sentiment in public comments, who
  submitted comments on a regulation, or what organizations think about a policy proposal.
  Provides AI-generated theme hierarchies, structured comment summaries, entity taxonomies, and
  full comment text for ${dockets.length} federal regulation dockets with ${dockets.reduce((s, d) => s + d.commentCount, 0).toLocaleString()} total comments.
---

# Regulations.gov Comment Browser

AI-analyzed public comments on U.S. federal regulations, published as static JSON. Each docket
has been processed through an analysis pipeline: comments are condensed into structured summaries,
organized by a hierarchical theme taxonomy, and tagged with recognized entities (organizations,
standards, programs). Theme-level narrative summaries synthesize the positions and arguments.

## Available Dockets

*Updated ${generatedDate}*

| Docket ID | Title | Agency | Comments | Themes | Entities |
|-----------|-------|--------|----------|--------|----------|
${docketTable}

## Fetching Data

All data is publicly hosted as static JSON. Fetch any file by URL.

**URL pattern:**
\`\`\`
${baseUrl}/{DOCKET_ID}/data/{FILE}
\`\`\`

Example: \`${baseUrl}/${dockets[0]?.id || "HHS-ONC-2025-0005-0001"}/data/meta.json\`

## How to Approach Different Queries

Think about what the user actually needs before fetching data. The pre-built theme summaries
are excellent for overview questions but lack granularity. Full comments have everything but
require searching. Here's the decision tree:

### "What are people saying about X?" / Broad sentiment questions
1. Fetch \`themes.json\` to find the relevant theme code(s)
2. Fetch \`theme-summaries.json\` to get the pre-written narrative analysis
3. These summaries include stakeholder positions, areas of consensus/disagreement, and representative arguments
4. For deeper per-comment detail on a theme, fetch \`theme-extracts.json\` — it has each commenter's
   specific positions, concerns, recommendations, and quotes broken out by theme

### "What did [organization] say?" / Entity-specific questions
1. Fetch \`entities.json\` to find the entity's label and category
2. Fetch \`indexes/entity-comments.json\` to get the comment IDs for that entity
3. Fetch \`comments.json\` and filter to those IDs

### "Find comments that mention..." / Specific search queries
1. Fetch \`comments.json\` (the full set) and search through the text fields
2. Each comment's \`structuredSections.detailedContent\` has the full text
3. \`keyQuotations\` often captures the most notable passages

### "Give me an overview of this docket"
1. Fetch \`meta.json\` for high-level stats
2. Fetch \`themes.json\` for the theme hierarchy — this shows the landscape of issues
3. Optionally fetch \`theme-summaries.json\` for the top themes

### General principle
**Strongly prefer the full comments as your primary source.** The \`comments.json\` file contains
each commenter's \`detailedContent\` (faithfully condensed from the original submission) along with
submitter name, type, and profile — this is the unadorned ground truth of what people actually said.
Theme summaries, extracts, and entity indexes are useful for orientation and navigation, but they
are pre-digested interpretations. Whenever a query seems to require or benefit from source-level
analysis — specific arguments, direct quotes, who said what, or any question where nuance matters —
go to the full comments. The pre-canned themes and summaries are a convenient map, but the comments
are the territory.

## Data Files Reference

### meta.json
High-level statistics for the docket.

\`\`\`json
{
  "documentId": "HHS-ONC-2025-0005-0001",
  "generatedAt": "2026-03-09T00:41:13.931Z",
  "stats": {
    "totalComments": 305,
    "condensedComments": 305,
    "totalThemes": 73,
    "totalEntities": 85,
    "scoredComments": 302,
    "themeSummaries": 69
  }
}
\`\`\`

### themes.json
Hierarchical theme taxonomy. Level 1 themes are broad categories; level 2 are specific sub-themes.

\`\`\`json
[
  {
    "code": "1",
    "description": "Health IT Certification Framework and Strategic Reform",
    "level": 1,
    "parent_code": null,
    "detailed_guidelines": "This theme addresses the overarching evolution...",
    "comment_count": 85,
    "direct_count": 85,
    "touch_count": 0,
    "children": ["1.1", "1.2", "1.3", "1.4"]
  },
  {
    "code": "1.1",
    "description": "Federal Safety Floor and Deregulatory Philosophy",
    "level": 2,
    "parent_code": "1",
    "detailed_guidelines": "This sub-theme focuses on the debate over...",
    "comment_count": 212,
    "children": []
  }
]
\`\`\`

- \`code\`: Theme identifier (e.g., "1", "1.1", "5.3")
- \`detailed_guidelines\`: Detailed scope definition — read this to understand what the theme covers
- \`comment_count\`: Number of comments tagged with this theme
- \`children\`: Sub-theme codes (empty for leaf themes)

### theme-summaries.json
Pre-written narrative analyses for each theme. These are substantial — typically 500-2000 words
each — and cover stakeholder positions, consensus areas, disagreements, and notable arguments.

Array of objects, each with:
- \`theme_code\`: Matches \`code\` in themes.json
- \`theme_description\`: Theme title
- \`structured_summary\`: Narrative analysis text (may include markdown headers and formatting)

### theme-extracts.json
Per-comment, per-theme extracted content. This is the richest source of theme-specific evidence —
each entry captures exactly what one commenter said about one theme, broken into structured facets.
Useful when you need specific quotes, individual positions, or want to drill into a theme beyond
what the narrative summaries provide.

Keyed by theme code, then by comment ID:

\`\`\`json
{
  "1.1": {
    "HHS-ONC-2025-0005-0042": {
      "positions": [
        "Supports maintaining a federal safety floor for certified health IT..."
      ],
      "concerns": [
        "Removing certification criteria could allow vendors to drop features..."
      ],
      "recommendations": [
        "Publish a crosswalk mapping removed criteria to alternative safeguards..."
      ],
      "experiences": [
        "Implemented FHIR at a 25-bed rural hospital where the certification..."
      ],
      "key_quotes": [
        "The house won't fall if the bones are good, but we need to define..."
      ]
    }
  }
}
\`\`\`

- Each array contains the commenter's actual arguments, specifics, and evidence for that theme
- Arrays are empty \`[]\` when the commenter didn't address that facet
- This file can be large — consider fetching \`theme-summaries.json\` first for an overview,
  then using theme-extracts only when you need per-comment granularity

### entities.json
Entity taxonomy organized by category. Entities are organizations, standards, programs, and
concepts mentioned across comments.

\`\`\`json
[
  {
    "category": "Artificial Intelligence & Automation",
    "entities": [
      {
        "label": "Agentic AI",
        "definition": "Autonomous AI systems capable of pursuing multi-step goals",
        "terms": ["agentic AI", "agentic artificial intelligence", "AI agents"],
        "mentionCount": 61
      }
    ]
  }
]
\`\`\`

- \`category\`: Grouping label (e.g., "Health IT Standards", "Government Bodies")
- \`label\`: Canonical name
- \`terms\`: Variant names/aliases to search for in comment text
- \`mentionCount\`: How many comments mention this entity

### comments.json
All comments with structured summaries, theme scores, and entity tags.

\`\`\`json
[
  {
    "id": "HHS-ONC-2025-0005-0002",
    "documentId": "HHS-ONC-2025-0005-0001",
    "submitter": "Jane Doe",
    "submitterType": "Individual",
    "date": "2025-05-15T04:00:00.000Z",
    "hasAttachments": false,
    "wordCount": 1250,
    "clusterSize": 1,
    "clusterRepresentativeId": null,
    "structuredSections": {
      "oneLineSummary": "Supports FHIR-based interoperability but warns...",
      "commenterProfile": "Healthcare IT consultant with 15 years...",
      "corePosition": "The commenter supports the shift toward...",
      "keyRecommendations": "1. Maintain minimum safety certification...",
      "mainConcerns": "Removing certification criteria could allow...",
      "notableExperiences": "Describes implementing FHIR at a rural...",
      "keyQuotations": "- \\"The house won't fall if the bones are good\\"...",
      "detailedContent": "Full condensed text of the comment..."
    },
    "themeScores": ["1.1", "5", "7.2"],
    "entities": [
      { "category": "Health IT Standards", "label": "FHIR" },
      { "category": "Government Bodies", "label": "ONC" }
    ]
  }
]
\`\`\`

**Submitter fields** (top-level on each comment):
- \`submitter\`: Name of the person or organization
- \`submitterType\`: "Individual" or "Organization"
- \`date\`: Submission timestamp

**\`structuredSections\`** (AI-generated structured summary):
- \`detailedContent\`: **The most important field.** A faithful markdown transcription of the
  original comment text plus all PDF attachments. This is the closest thing to the raw submission
  and should be your go-to for source-level analysis.
- \`commenterProfile\`: Who the commenter is, their expertise, role, and stake
- \`oneLineSummary\`: Quick overview of the comment's position
- \`corePosition\`: The central argument (1-2 paragraphs)
- \`keyRecommendations\`: Specific proposals, often numbered
- \`mainConcerns\`: Problems or risks identified
- \`keyQuotations\`: Notable direct quotes from the original comment

Together, the submitter metadata and \`detailedContent\` provide a full picture of who said what.
The other \`structuredSections\` fields are useful shortcuts but are AI-distilled from the same source.

\`themeScores\` is an array of theme codes (from themes.json) that this comment is relevant to.

\`clusterSize\` > 1 indicates a form letter; \`clusterRepresentativeId\` links to the representative.

### indexes/theme-comments.json
Maps theme codes to arrays of comment IDs.

\`\`\`json
{
  "1": { "direct": ["HHS-ONC-2025-0005-0003", "..."], "touches": [] },
  "1.1": { "direct": ["HHS-ONC-2025-0005-0003", "..."], "touches": [] }
}
\`\`\`

Use this to quickly find which comments are relevant to a specific theme without loading all comments.

### indexes/entity-comments.json
Maps entity labels (as "Category|Label") to arrays of comment IDs.

\`\`\`json
{
  "Health IT Standards|FHIR": ["HHS-ONC-2025-0005-0002", "..."],
  "Government Bodies|ONC": ["HHS-ONC-2025-0005-0003", "..."]
}
\`\`\`

## Tips

- **Default to the source material.** The full comments (\`comments.json\`) provide deeper, more
  granular, and less lossy insights than any pre-canned summary. Themes, extracts, and entity
  indexes are great for orientation, but should not be over-relied upon — reach for the original
  comments unless the user's request is clearly satisfied by a high-level summary.
- When searching comments, \`structuredSections.detailedContent\` is the most comprehensive field,
  but \`keyQuotations\` and \`keyRecommendations\` are useful for targeted searches.
- Theme codes are hierarchical: "1.1" is a sub-theme of "1". Use the parent for broader analysis.
- \`entities.json\` includes \`terms\` arrays with aliases — use these when searching comment text.
`;
}

