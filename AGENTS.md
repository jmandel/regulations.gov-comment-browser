# Agents Guide

## Running the Pipeline for a Docket

### Command format

```bash
bun run cli pipeline <source> -m <model> [options]
```

- `<source>`: CSV file path (e.g., `mmj-kxgh-trd3.csv`) or document ID (e.g., `CMS-2025-0050-0031`)
- `-m <model>`: One of `gemini-3-flash` (default), `gemini-pro`, `gemini-flash`, `gemini-flash-lite`, `claude`
- The document ID for the database is derived from the CSV filename (e.g., `mmj-kxgh-trd3.csv` -> `dbs/mmj-kxgh-trd3.sqlite`)

### Critical rules

1. **NEVER pass `-s` / `--skip-attachments` unless the user explicitly asks for it.** Many regulatory comments are just "See attached file(s)" stubs with all substance in PDF/DOCX attachments. Skipping attachments causes:
   - Loss of ~45%+ of comment content
   - Broken clustering (all "see attached" stubs get grouped together as duplicates)
   - Hollow analysis for attachment-heavy dockets

2. **Ask the user about clustering.** Before running the pipeline:
   - If the docket has **fewer than ~1000 comments**, clustering is typically unnecessary and can cause problems (especially with many attachment-only comments). Suggest `--no-clustering`.
   - If the docket has **1000+ comments**, clustering helps reduce processing volume. Use the default (clustering enabled).
   - Always mention the tradeoff: clustering saves API cost but risks merging unrelated comments.

3. **Check comment count first** if loading from CSV:
   ```bash
   wc -l <file.csv>  # Subtract 1 for header
   ```

### Pipeline steps (1-10)

1. **load** - Load comments from CSV or regulations.gov API (downloads attachments)
2. **cluster** - Group similar comments (optional, use `--no-clustering` to skip)
3. **transcribe** - Convert attachments/PDFs to clean markdown
4. **condense** - Structurally summarize each comment
5. **discover-themes** - Build hierarchical taxonomy of policy themes
6. **extract-theme-content** - Extract theme-specific text from each comment
7. **summarize-themes** - Synthesize extracts into narrative theme analysis
8. **discover-entities** - Identify organizations and named entities
9. **build-website** - Export analysis to JSON for web dashboard
10. **vacuum-db** - Optimize SQLite database

### Resuming after failure

The pipeline has crash recovery (up to 10 retries). To manually resume from a specific step:

```bash
bun run cli pipeline <source> -m <model> --start-at <step-number>
```

### Verifying results

After the load step, spot-check:
```bash
# Check comment count and attachment completeness
sqlite3 dbs/<id>.sqlite "SELECT count(*) FROM comments;"
sqlite3 dbs/<id>.sqlite "SELECT count(*) FROM attachments WHERE blob_data IS NOT NULL;"
sqlite3 dbs/<id>.sqlite "SELECT count(*) FROM attachments;"
```

After clustering, spot-check that large clusters contain genuinely similar content (not just "see attached" stubs):
```bash
sqlite3 dbs/<id>.sqlite "
  SELECT cc.cluster_size, substr(json_extract(c.attributes_json, '$.comment'), 1, 100)
  FROM comment_clusters cc
  JOIN comments c ON cc.representative_comment_id = c.id
  ORDER BY cc.cluster_size DESC LIMIT 5;
"
```
