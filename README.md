# Regulations.gov Comment Analysis Pipeline

A modular pipeline for analyzing public comments from federal regulations using AI-powered theme and entity discovery.

## Overview

This tool processes public comments to:
1. **Load** comments from regulations.gov API or CSV bulk downloads
2. **Condense** verbose comments into structured bullet-point summaries
3. **Discover themes** - build a hierarchical taxonomy of topics discussed
4. **Discover entities** - identify organizations, programs, and concepts mentioned
5. **Score themes** - analyze stance alignment and generate narrative summaries per theme

## Installation

```bash
# Install Bun (if not already installed)
curl -fsSL https://bun.sh/install | bash

# Install dependencies
bun install
```

## Usage

All commands follow the pattern:
```bash
bun run src/cli.ts <command> <document-id> [options]
```

Or use the shorthand scripts:
```bash
bun run <command> <document-id> [options]
```

### Getting Comment Data

You can obtain comment data in two ways:

#### Option 1: CSV Bulk Download (Recommended)
1. Visit https://www.regulations.gov/bulkdownload
2. Enter the **Docket ID** (e.g., `CMS-2025-0050-0031`)
3. Select **"All Comments"** 
4. Submit the request and wait for the email with download link
5. Download the CSV file from the email
6. Rename the file to `[Docket-ID].csv` and place it in the repository root
   - Example: `CMS-2025-0050-0031.csv`

#### Option 2: Direct API Access
Use the regulations.gov API directly (limited to smaller datasets).

### 1. Load Comments

Load from CSV file (recommended):
```bash
bun run load CMS-2025-0050-0031.csv --limit 500
```

Load from regulations.gov API:
```bash
bun run load CMS-2025-0050-0031 --limit 100
```

Load from CSV file with custom path:
```bash
bun run load path/to/comments.csv --limit 500
```

Options:
- `--api-key <key>` - Regulations.gov API key (default: DEMO_KEY)
- `--skip-attachments` - Don't download PDF attachments
- `--limit <n>` - Stop after N comments
- `--debug` - Save all API responses to debug/

**PDF Text Extraction**: The system now automatically extracts text content from PDF attachments using `pdf-parse`, providing actual document content instead of placeholder messages.

**CSV vs API**: CSV bulk download is recommended for large datasets as it's faster, more reliable, and doesn't hit API rate limits. The API method is suitable for smaller datasets or testing.

### 2. Condense Comments

Generate condensed bullet-point versions:
```bash
bun run condense CMS-2025-0050-0031 --limit 100
```

Options:
- `--limit <n>` - Process only N comments
- `--retry-failed` - Retry previously failed comments
- `--debug` - Save prompts and responses

**Metadata Optimization**: The condensing process now uses streamlined metadata headers instead of redundant JSON blocks, improving prompt efficiency while maintaining essential context.

### 3. Discover Themes

Build hierarchical theme taxonomy:
```bash
bun run discover-themes CMS-2025-0050-0031
```

**Filter out form letters and duplicates:**
```bash
bun run discover-themes CMS-2025-0050-0031 --filter-duplicates
```

Options:
- `--limit <n>` - Use only first N condensed comments
- `--batch-limit <n>` - Word count to trigger batching (default: 200000)
- `--batch-size <n>` - Target words per batch (default: 150000)
- `--filter-duplicates` - Filter out duplicate/form letter comments using clustering
- `--similarity-threshold <n>` - Similarity threshold for duplicate filtering (default: 0.8)
- `--debug` - Save intermediate results

**Duplicate Filtering**: When `--filter-duplicates` is enabled, the system clusters similar comments based on full content (including PDFs) and selects only the longest representative from each cluster. This removes form letter campaigns while preserving unique content. Lower thresholds (e.g., 0.75) are more aggressive at filtering duplicates.

**Simplified Architecture**: Theme discovery now works with plain text responses instead of complex JSON structures, improving reliability and reducing parsing errors. The system automatically extracts multiple quotes per theme with proper citation tracking.

### 4. Discover Entities

Extract named entities and build taxonomy:
```bash
bun run discover-entities-v2 CMS-2025-0050-0031
```

Options: Same as discover-themes

### 5. Score Themes

Generate stance analysis and narrative summaries per theme:
```bash
bun run score-themes CMS-2025-0050-0031 --themes 1.1,2.3
```

Options:
- `--themes <list>` - Comma-separated theme IDs to analyze (e.g., "1.1,2.3,4.2")
- `--debug` - Save prompts and responses

**New Functionality**: Scores every comment against every theme in the hierarchy (1=directly addresses, 2=touches on, 3=does not address) with comprehensive validation to ensure complete coverage.

### 6. Summarize Themes

Generate detailed narrative summaries for themes:
```bash
bun run summarize-themes-v2 CMS-2025-0050-0031
```

**Filter to representative comments only:**
```bash
bun run summarize-themes-v2 CMS-2025-0050-0031 --filter-duplicates
```

Options:
- `--themes <codes>` - Comma-separated theme codes to analyze
- `--min-comments <n>` - Minimum comments required for a theme (default: 5)
- `--filter-duplicates` - Only use extracts from representative comments (filters form letters)
- `--similarity-threshold <n>` - Similarity threshold for duplicate filtering (default: 0.8)
- `--batch-limit <n>` - Word limit to trigger batching (default: 150000)
- `--batch-size <n>` - Target words per batch (default: 75000)
- `--concurrency <n>` - Number of parallel API calls (default: 3)

**Form Letter Filtering**: When enabled, only extracts from representative comments (longest from each cluster) are used for theme summarization. This ensures summaries reflect unique perspectives rather than repetitive form letter content.
- `--debug` - Save prompts and responses

**Key Features**:
- Uses worker pool for parallel processing
- Only summarizes themes up to specified depth (e.g., "1.1" but not "1.1.1" at depth 2)
- Dashboard shows link to parent theme analysis for deeper themes

## Architecture

### Directory Structure
```
src/
├── commands/          # CLI command implementations
├── lib/              # Shared utilities (database, comment processing)
├── prompts/          # AI prompt templates
├── types/            # TypeScript type definitions
└── cli.ts            # Main entry point

dbs/                  # SQLite databases (one per document)
debug/                # Debug outputs when --debug flag used
```

### Database Schema

Each document gets its own SQLite database in `dbs/<document-id>.sqlite` containing:

- `comments` - Raw comment data from regulations.gov
- `attachments` - PDF and other attachments with extracted text content
- `condensed_comments` - AI-generated summaries with progress tracking
- `theme_batches` - Theme discovery results stored as plain text
- `themes` - Parsed hierarchical theme structure with multiple quotes per theme
- `entity_taxonomy` - Discovered entity categories
- `comment_entities` - Entity annotations per comment
- `comment_themes` - Complete scoring matrix (every comment vs every theme)
- `theme_scoring_status` - Processing status and error tracking

### Key Features

1. **Progress Tracking** - All operations can be resumed if interrupted
2. **Failure Handling** - Failed items tracked separately, retry with `--retry-failed`
3. **Batching** - Automatic batching for large datasets (>200k words)
4. **Debug Mode** - `--debug` flag saves all intermediate artifacts
5. **Modular Design** - Each command is independent and can be run separately
6. **Enhanced PDF Processing** - Automatic text extraction from PDF attachments
7. **Multiple Quote Support** - Themes can reference multiple supporting quotes with proper citations
8. **Complete Theme Scoring** - Every comment scored against every theme with validation

### AI Processing Approach

- **Narrative Output**: AI generates narrative/markdown responses for better quality
- **Post-hoc Parsing**: Structured data is extracted from narratives after generation
- **Smart Merging**: When batching is required, custom merge prompts reconcile different organizational schemes
- **Single Task Focus**: Each prompt focuses on one task to maximize quality
- **Simplified Data Structures**: Removed complex JSON wrappers in favor of direct text processing

## Environment Variables

- `GEMINI_API_KEY` - Required for AI features (condense, discover-themes, discover-entities-v2, score-themes)
- `REGSGOV_API_KEY` - For regulations.gov API (defaults to DEMO_KEY)

## Examples

### Full Pipeline

Run all steps at once:
```bash
# Run the complete pipeline with CSV file
bun run pipeline CMS-2025-0050-0031.csv

# Run with document ID (API access)
bun run pipeline CMS-2025-0050-0031

# Filter out form letters during theme discovery
bun run pipeline CMS-2025-0050-0031.csv --filter-duplicates

# Start from a specific step (e.g., step 3 = discover-themes)
bun run pipeline CMS-2025-0050-0031.csv --start-at 3

# With options and duplicate filtering
bun run pipeline CMS-2025-0050-0031.csv --limit-total-comment-load 100 --debug --start-at 2 --filter-duplicates --similarity-threshold 0.75

# With crash recovery (default: 10 max crashes)
bun run pipeline CMS-2025-0050-0031.csv --max-crashes 20
```

**Crash Recovery**: The pipeline automatically retries from the failed step if it crashes (e.g., due to API errors). It will retry up to `--max-crashes` times (default: 10) before giving up. Each retry waits 5 seconds before restarting.

**Form Letter Filtering**: Use `--filter-duplicates` to automatically detect and filter out form letter campaigns during theme discovery. This dramatically improves theme quality by focusing on unique content rather than repetitive submissions. Adjust `--similarity-threshold` (default: 0.8) to control filtering aggressiveness.

Or run individual steps:
```bash
# Load comments from CSV file
bun run load CMS-2025-0050-0031.csv --limit 1000

# Condense all loaded comments
bun run condense CMS-2025-0050-0031

# Discover themes from condensed comments (with duplicate filtering)
bun run discover-themes CMS-2025-0050-0031 --filter-duplicates

# Extract entities
bun run discover-entities-v2 CMS-2025-0050-0031

# Score all themes
bun run score-themes CMS-2025-0050-0031

# Summarize themes (with duplicate filtering)
bun run summarize-themes-v2 CMS-2025-0050-0031 --filter-duplicates

# Build website
bun run build-website CMS-2025-0050-0031
```

### Debug Mode
```bash
# Run any command with --debug to save artifacts
bun run condense CMS-2025-0050-0031 --limit 10 --debug

# Check debug/ directory for:
# - condense_<comment-id>_prompt.txt
# - condense_<comment-id>_response.txt
# - themes_<batch-id>_prompt.txt
# - themes_<batch-id>_response.txt
# - score_themes_<theme-id>_prompt.txt
# - score_themes_<theme-id>_response.txt
```

### Incremental Processing
```bash
# Process in batches over multiple runs
bun run load CMS-2025-0050-0031 --limit 100    # First 100
bun run load CMS-2025-0050-0031 --limit 100    # Next 100 (201-300)

# Retry failed condensing
bun run condense CMS-2025-0050-0031 --retry-failed

# Analyze themes incrementally
bun run score-themes CMS-2025-0050-0031 --themes 1.1,1.2  # First batch
bun run score-themes CMS-2025-0050-0031 --themes 2.1,2.2  # Second batch
```

## Recent Improvements

### PDF Text Extraction
- Fixed import issues with `pdf-parse` in Bun/ESM environments
- Added proper TypeScript definitions for PDF parsing
- Enhanced attachment processing to extract actual text content
- Improved error handling for corrupted or unsupported PDF files

### Theme Discovery Enhancements
- Simplified data structures by removing unnecessary JSON wrappers
- Improved quote extraction to support multiple citations per theme
- Enhanced database schema to store quotes as structured JSON arrays
- Streamlined parsing logic to reduce errors and improve reliability

### Enhanced Theme Scoring Feature
- Complete scoring matrix: every comment scored against every theme (1/2/3 scale)
- Strict validation ensures no themes are skipped in LLM responses
- Comprehensive error handling for incomplete or malformed JSON responses
- Detailed progress reporting with score breakdowns (direct/touches/not-addressed)
- Database schema supports all three score levels with proper constraints

### Metadata Optimization
- Removed redundant metadata blocks from AI prompts
- Streamlined comment context while preserving essential information
- Improved prompt efficiency and reduced token usage

## Building Web Dashboards

### Build All Dashboards
Build separate dashboard instances for each regulation database:
```bash
./scripts/build-all-dashboards.sh
```

This will:
- Find all SQLite databases in `dbs/`
- Generate data files for each regulation using `build-website` command
- Build a separate React dashboard for each regulation
- Output to `dist/<regulation-id>/` directories
- Create an index page at `dist/index.html` listing all dashboards

### Dashboard Features
The web dashboard provides:
- **Interactive Theme Explorer**: Browse hierarchical theme structure with comment counts
- **Entity Browser**: Explore discovered entities by category
- **Comment Search**: Full-text search across all comments
- **Copy for LLM**: Export data in LLM-friendly formats with customizable sections
  - Theme hierarchies with summaries and comments
  - Entity definitions with related comments
  - Individual comments with selectable structured sections
- **No CSV Export**: Removed CSV export functionality in favor of LLM-optimized copy features

### Build Single Dashboard
Build dashboard for a specific regulation:
```bash
./scripts/build-single-dashboard.sh CMS-2025-0050-0031
```

### GitHub Actions
The project includes a GitHub Actions workflow that automatically builds dashboards for all regulations on push to main:
- Workflow: `.github/workflows/build-regulation-dashboards.yml`
- Uploads built dashboards as artifacts
- Optional: Can deploy to GitHub Pages

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

### Adding New Commands

1. Create command file in `src/commands/`
2. Import and register in `src/cli.ts`
3. Add any new prompts to `src/prompts/`
4. Update database schema if needed

## License

MIT
