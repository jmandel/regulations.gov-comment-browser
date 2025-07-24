# Regulations.gov Comment Analysis Pipeline

A modular pipeline for analyzing public comments from federal regulations using AI-powered theme and entity discovery.

## Overview

This tool processes public comments to:
1.  **Load** comments from regulations.gov API or CSV bulk downloads.
2.  **Condense** verbose comments into structured summaries.
3.  **Discover Themes** by building a hierarchical taxonomy of topics.
4.  **Extract Theme-Specific Content** from each comment for precise analysis.
5.  **Summarize Themes** by synthesizing all relevant comment extracts into a narrative.
6.  **Discover Entities** by identifying organizations, programs, and concepts.
7.  **Build a Website** to explore the results interactively.

## Installation

```bash
# Install Bun (if not already installed)
curl -fsSL https://bun.sh/install | bash

# Install dependencies
bun install
```

## The Analysis Pipeline: A Quick Guide

This section provides a high-level overview of the main commands. For a detailed explanation of how each step works, see the **"Pipeline Deep Dive"** section below.

All commands follow the pattern:
```bash
bun run src/cli.ts <command> <document-id> [options]
```

### Step 1: `load` - Load Comments

Load comments from a CSV file (recommended) or the regulations.gov API.

**From CSV:**
```bash
bun run load CMS-2025-0050-0031.csv --limit 500
```

**From API:**
```bash
bun run load CMS-2025-0050-0031 --limit 100
```

### Step 2: `condense` - Create Structured Summaries

Generate condensed, structured versions of each comment using an AI model.

```bash
bun run condense CMS-2025-0050-0031 --limit 100
```

### Step 3: `discover-themes` - Discover Theme Taxonomy

Analyze comments to build a hierarchical taxonomy of themes and topics discussed.

```bash
bun run discover-themes CMS-2025-0050-0031 --filter-duplicates
```
*   Use `--filter-duplicates` to remove form letters and improve theme quality.

### Step 4: `extract-theme-content` - Extract Relevant Content

For each comment, extract the specific sentences and arguments that are relevant to each theme in the taxonomy. This is a critical step for high-quality summaries.

```bash
bun run extract-theme-content CMS-2025-0050-0031
```

### Step 5: `summarize-themes-v2` - Generate Theme Summaries

Synthesize all the theme-specific extracts into a comprehensive narrative analysis for each theme.

```bash
bun run summarize-themes-v2 CMS-2025-0050-0031 --filter-duplicates
```

### Step 6: `discover-entities-v2` - Discover Entities

Extract named entities (organizations, programs, etc.) from comments and build a taxonomy.

```bash
bun run discover-entities-v2 CMS-2025-0050-0031
```

### Step 7: `build-website` - Build the Dashboard Data

Generate all necessary JSON files for the interactive web dashboard.

```bash
bun run build-website CMS-2025-0050-0031
```

### Step 8: `vacuum-db` - Optimize Database

Clean and optimize the SQLite database to reduce file size.

```bash
bun run vacuum-db CMS-2025-0050-0031
```

## Utility Commands

### `pipeline` - Run the Full Pipeline

Execute the entire 8-step pipeline in sequence with automatic crash recovery.

```bash
# Run the complete pipeline with a CSV file
bun run pipeline CMS-2025-0050-0031.csv

# Start from a specific step (e.g., step 4 = extract-theme-content)
bun run pipeline CMS-2025-0050-0031.csv --start-at 4

# Filter duplicates and set a similarity threshold
bun run pipeline CMS-2025-0050-0031.csv --filter-duplicates --similarity-threshold 0.75
```

### `generate-landing-page` - Create Main Index

Generate the `dist/index.html` landing page that lists all available regulation dashboards.

```bash
bun run generate-landing-page
```

### `cache` - Manage the LLM Cache

Inspect and manage the LLM prompt/response cache stored in the database.

```bash
# View cache statistics
bun run cache stats CMS-2025-0050-0031

# Clear the entire cache
bun run cache clear CMS-2025-0050-0031 --all
```

## Pipeline Deep Dive: Building Intuition

This section explains the *how* and *why* behind each step of the analysis pipeline.

---

### **1. `load`**

*   **Purpose:** To get the raw comment data into a local SQLite database.
*   **How it Works:** It can either fetch comments one-by-one from the regulations.gov API or, more efficiently, parse a bulk-downloaded CSV file. It also downloads any attachments associated with the comments, with built-in support for extracting text from **PDF and DOCX files**.
*   **The AI's Role:** None. This step is purely data ingestion.
*   **Database Impact:**
    *   `comments`: Populated with raw comment data.
    *   `attachments`: Populated with PDF data.

---

### **2. `condense`**

*   **Purpose:** To transform long, unstructured comments (especially PDFs) into a clean, consistent, and structured format for easier analysis.
*   **How it Works:** It takes the full text of each comment (including text extracted from PDFs) and sends it to an AI model.
*   **The AI's Role:**
    *   **Prompt Goal:** To act as an expert analyst, reading a comment and summarizing it into a structured format with predefined sections.
    *   **Key Prompt Snippet:** From `src/prompts/condense.ts`:
        > `You MUST organize every comment into these exact sections with these exact headers: ### DETAILED CONTENT, ### ONE-LINE SUMMARY, ### COMMENTER PROFILE, ### CORE POSITION...`
    *   **Conceptual Example:**
        *   **Before:** A 10-page, unstructured PDF attachment.
        *   **After:** A clean summary with sections like `### CORE POSITION` and `### KEY RECOMMENDATIONS`.
*   **Database Impact:**
    *   Reads from: `comments`, `attachments`.
    *   Writes to: `condensed_comments` (stores the structured summary).

---

### **3. `discover-themes`**

*   **Purpose:** To understand the main topics of discussion by creating a hierarchical taxonomy of themes from the ground up.
*   **How it Works:** It takes thousands of condensed comments, batches them together into large contexts, and asks the AI to identify the recurring themes and organize them.
*   **The AI's Role:**
    *   **Prompt Goal:** To read a large volume of comments and act as a research synthesizer, identifying and organizing the key themes into a MECE (Mutually Exclusive, Collectively Exhaustive) hierarchy.
    *   **Key Prompt Snippet:** From `src/prompts/theme-discovery.ts`:
        > `[Number]. [Label]. [Brief Description] || [Detailed Guidelines].`
    *   **Conceptual Example:**
        *   **Before:** Thousands of comments mentioning "paperwork," "forms," and "reporting."
        *   **After:** A structured theme is created: `1.1. Administrative Burden`, with detailed guidelines explaining what is and isn't included in this theme.
*   **Handling Large Datasets (Batching & Merging):** If the total word count of comments exceeds a threshold (e.g., >250k words), this command automatically splits the comments into smaller batches. It generates a separate theme taxonomy for each batch. Then, it recursively merges these taxonomies using a special `THEME_MERGE_PROMPT` until a single, unified hierarchy remains. This allows the pipeline to process millions of words, far beyond the context window of a single AI call.
*   **Database Impact:**
    *   Reads from: `condensed_comments`.
    *   Writes to: `theme_hierarchy` (stores the final taxonomy).

---

### **4. `extract-theme-content`**

*   **Purpose:** To find the "semantic signal" by precisely identifying which parts of a comment discuss which themes. This is the foundation for high-quality theme summaries.
*   **How it Works:** This step iterates through each comment. For every individual comment, it makes a single AI call, providing the full comment text along with the *entire* theme taxonomy. This is a highly efficient "one-to-many" operation.
*   **The AI's Role:**
    *   **Prompt Goal:** To read a single comment and, for every theme in the taxonomy, extract the exact text (positions, concerns, recommendations) that pertains to that theme.
    *   **Key Prompt Snippet:** From `src/prompts/theme-extract.ts`:
        > `For each theme, extract EXACTLY what this commenter says about it... If they don't address a theme, mark it as not addressed.`
    *   **Conceptual Example:**
        *   **Input:** A full comment and the theme "1.1 Small Practice Impact".
        *   **Output:** A JSON object for that comment and theme containing just the relevant sentence: `{"positions": ["As a solo practitioner, this rule would force me to hire a full-time administrator I cannot afford."]}`.
*   **Database Impact:**
    *   Reads from: `condensed_comments`, `theme_hierarchy`.
    *   Writes to: `comment_theme_extracts` (stores the JSON snippets).

---

### **5. `summarize-themes-v2`**

*   **Purpose:** To create a rich, narrative summary for each theme, explaining the consensus points, debates, and key perspectives.
*   **How it Works:** For a given theme (e.g., "1.1 Small Practice Impact"), it gathers all the specific extracts created in the previous step. It then sends this collection of targeted content to the AI to be synthesized.
*   **The AI's Role:**
    *   **Prompt Goal:** To act as a policy analyst, reading all the pre-filtered, on-topic extracts and synthesizing them into a structured report with sections for consensus, debate, stakeholder views, and more.
    *   **Key Prompt Snippet:** From `src/prompts/theme-extract.ts`:
        > `You are a policy analyst synthesizing public input... Your analysis will inform decision-makers... Required Analysis Sections: ### CONSENSUS POINTS, ### AREAS OF DEBATE...`
    *   **Conceptual Example:**
        *   **Before:** Dozens of individual JSON extracts about the impact on small practices.
        *   **After:** A final, structured summary for theme 1.1 that begins: `### EXECUTIVE SUMMARY: Small practices universally oppose the rule, citing cost concerns as the primary driver...`
*   **Handling Large Datasets (Batching & Merging):** If a single theme has a very large volume of extracted text, this step will automatically batch the extracts, generate a summary for each batch, and then use a final `EXTRACT_MERGE_PROMPT` to combine the partial summaries into one comprehensive analysis.
*   **Database Impact:**
    *   Reads from: `comment_theme_extracts`, `theme_hierarchy`.
    *   Writes to: `theme_summaries` (stores the final narrative analysis).

---

### **6. `discover-entities-v2`**

*   **Purpose:** To identify and categorize all the specific organizations, regulations, programs, and technical terms mentioned in the comments.
*   **How it Works:** Similar to theme discovery, it sends a large batch of comments to the AI and asks it to generate a taxonomy of named entities. It then scans all comments to annotate which comments mention which entities.
*   **The AI's Role:**
    *   **Prompt Goal:** To identify named entities and group them into logical categories (e.g., "Government Agencies," "Medical Conditions").
    *   **Key Prompt Snippet:** From `src/prompts/entity-discovery.ts`:
        > `Return a JSON object with this structure: { "category_name": [ { "label": "Entity Name", "definition": "...", "terms": ["exact term 1", "variant spellings"] } ] }`
*   **Database Impact:**
    *   Reads from: `condensed_comments`.
    *   Writes to: `entity_taxonomy` (the categories and definitions) and `comment_entities` (the mapping between comments and entities).

---

### **7. `build-website`**

*   **Purpose:** To export all the processed data from the database into static JSON files that the web dashboard can consume.
*   **How it Works:** This is a pure export script. It queries the various database tables and writes the results into a series of JSON files.
*   **The AI's Role:** None.
*   **Database Impact:** Reads from all major tables (`comments`, `themes`, `entities`, etc.). Writes to the `dist/data` directory.

---

### **8. `vacuum-db`**

*   **Purpose:** To optimize the SQLite database file, reclaiming unused space and improving performance.
*   **How it Works:** It runs the `VACUUM` command on the SQLite database. This is good practice to do after a lot of writes.
*   **The AI's Role:** None.
*   **Database Impact:** Rewrites the database file, potentially reducing its size.

## Architecture

### Directory Structure
```
src/
├── commands/          # CLI command implementations
├── lib/              # Shared utilities (database, AI, comment processing)
├── prompts/          # AI prompt templates
├── types/            # TypeScript type definitions
└── cli.ts            # Main entry point

dbs/                  # SQLite databases (one per document)
debug/                # Debug outputs when --debug flag is used
dist/                 # Output for built website files
```

### Database Schema

Each document gets its own SQLite database in `dbs/<document-id>.sqlite` containing:

- `comments`: Raw comment data from regulations.gov.
- `attachments`: PDF and other attachments with extracted text content.
- `condensed_comments`: AI-generated structured summaries of comments.
- `theme_hierarchy`: The hierarchical taxonomy of themes.
- `comment_theme_extracts`: **(New)** Stores theme-specific text extracted from each comment.
- `theme_summaries`: **(New)** Stores the final AI-generated narrative analysis for each theme.
- `entity_taxonomy`: The taxonomy of discovered entities (organizations, etc.).
- `comment_entities`: Maps which comments mention which entities.
- `llm_cache`: **(New)** Caches AI prompts and responses to avoid re-running expensive calls.

## Building Web Dashboards

### Build All Dashboards
Build separate dashboard instances for each regulation database:
```bash
./scripts/build-all-dashboards.sh
```

This will:
- Find all SQLite databases in `dbs/`
- Generate data files for each regulation using the `build-website` command.
- Output to `dist/<regulation-id>/` directories.
- Create an index page at `dist/index.html` listing all dashboards.

### Dashboard Features
The web dashboard provides:
- **Interactive Theme Explorer**: Browse hierarchical theme structure with comment counts.
- **Theme Summaries**: Read detailed narrative analyses of key themes.
- **Entity Browser**: Explore discovered entities by category.
- **Comment Search**: Full-text search across all comments.
- **Copy for LLM**: Export data in LLM-friendly formats.

### Build Single Dashboard
Build a dashboard for a specific regulation:
```bash
./scripts/build-single-dashboard.sh CMS-2025-0050-0031
```

### Serving Locally
```bash
cd dist
python -m http.server 8000
# Then visit http://localhost:8000
```

## Development

### Type Checking
```bash
bun run typecheck
```

### Clean Databases
```bash
bun run clean  # Removes all dbs/* and debug/*
```

## License

MIT
