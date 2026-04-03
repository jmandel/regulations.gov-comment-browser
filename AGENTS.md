# Agents Guide

## Running the Pipeline for a Docket

### Command format

```bash
bun run src/cli.ts pipeline <document-id> -m gemini-3-flash -c 20 --no-clustering
```

- `<document-id>`: Document ID from regulations.gov (e.g., `CMS-2025-0058-0002`) or CSV file path
- `-m gemini-3-flash`: Default and recommended model
- `-c 20`: Concurrency — safe with Gemini Tier 1 rate limits (2000 RPM)
- `--no-clustering`: Use for dockets under ~1000 comments (most dockets)
- The DB is created at `dbs/<document-id>.sqlite`

### Critical rules

1. **NEVER pass `-s` / `--skip-attachments` unless the user explicitly asks for it.** Many regulatory comments are just "See attached file(s)" stubs with all substance in PDF/DOCX attachments. Skipping attachments causes:
   - Loss of ~45%+ of comment content
   - Broken clustering (all "see attached" stubs get grouped together as duplicates)
   - Hollow analysis for attachment-heavy dockets

2. **Use `--no-clustering` for small dockets.** Dockets under ~1000 comments don't benefit from clustering and it can cause problems (especially with many attachment-only comments). Only enable clustering for 1000+ comment dockets.

### Pipeline steps (1-10)

1. **load** - Load comments from regulations.gov API or CSV (downloads attachments)
2. **cluster** - Group similar comments (skipped with `--no-clustering`)
3. **transcribe** - Convert attachments/PDFs to clean markdown
4. **condense** - Structurally summarize each comment
5. **discover-themes** - Build hierarchical taxonomy of policy themes
6. **extract-theme-content** - Extract theme-specific text from each comment (batched by top-level theme group, uses Gemini prompt caching)
7. **summarize-themes** - Synthesize extracts into narrative theme analysis (includes post-processing to fix partial comment IDs)
8. **discover-entities** - Identify organizations and named entities
9. **build-website** - Export analysis to JSON for web dashboard (uses docket ID from DB metadata for output paths)
10. **vacuum-db** - Optimize SQLite database

### After pipeline completes

1. **Browse locally**: Copy data and start dev server:
   ```bash
   cp -r dist/data/* dashboard/public/data/
   cd dashboard && bunx vite --port 3002
   ```

2. **Deploy**: Upload the DB file to the Google Drive `regulations-dbs` folder, then push to trigger the GitHub Actions build (`scripts/build-all-dashboards.sh`).

### Resuming after failure

The pipeline has crash recovery (up to 10 retries). To manually resume from a specific step:

```bash
bun run src/cli.ts pipeline <document-id> -m gemini-3-flash -c 20 --start-at <step-number>
```

### Verifying results

After the load step, spot-check:
```bash
sqlite3 dbs/<id>.sqlite "SELECT count(*) FROM comments;"
sqlite3 dbs/<id>.sqlite "SELECT count(*) FROM attachments WHERE blob_data IS NOT NULL;"
sqlite3 dbs/<id>.sqlite "SELECT count(*) FROM attachments;"
```

If clustering is enabled, spot-check that large clusters contain genuinely similar content (not just "see attached" stubs):
```bash
sqlite3 dbs/<id>.sqlite "
  SELECT cc.cluster_size, substr(json_extract(c.attributes_json, '$.comment'), 1, 100)
  FROM comment_clusters cc
  JOIN comments c ON cc.representative_comment_id = c.id
  ORDER BY cc.cluster_size DESC LIMIT 5;
"
```
