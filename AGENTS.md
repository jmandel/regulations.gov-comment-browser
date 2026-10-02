# Agents Guide

## Project overview
Regulations.gov comment analysis pipeline. Loads public comments on federal regulations, clusters similar ones, uses LLMs (primarily Gemini) to transcribe/condense/analyze themes, and builds a web dashboard.

## Tech stack
- **Runtime**: Bun (not Node.js)
- **Language**: TypeScript
- **Database**: SQLite (via bun:sqlite)
- **LLMs**: Gemini (primary), Claude (secondary) — see `src/lib/llm-providers.ts`
- **CLI**: Commander.js — entry point is `src/cli.ts`
- **Dashboard**: React app in `dashboard/`

## Key guidance
- Never skip attachments (`-s`) unless explicitly asked
- Use `--no-clustering` for dockets under ~1000 comments
- Models are set per step (and per role within a step) in `batch-config.json`; see "Models and cost" below. Don't pass `-m` to `pipeline` unless you mean to override every step and role
- Add `--batch` to run the per-comment LLM steps through the Gemini Batch API at half price; each such step then takes minutes to hours
- Default concurrency: `-c 20`
- The `.env` file contains API keys (`GEMINI_API_KEY`, `REGSGOV_API_KEY`); the code reads `REGSGOV_API_KEY`, not `REGULATIONS_GOV_API_KEY`
- For large dockets (>~5k comments) load with `--mirrulations` instead of the API — the API listing caps at 10k comments
- When adding features, flags or methods, update this file in the same change
- Design docs for proposed (not yet built) features live in `docs/design/`

## ID conventions
- **Docket ID**: e.g., `HHS-ONC-2026-0067` — the regulatory proceeding
- **Document ID**: e.g., `HHS-ONC-2026-0067-0001` — a specific document within the docket (pipeline input)
- **Comment ID**: e.g., `HHS-ONC-2026-0067-0042` — shares the docket prefix, not the document prefix
- DB files are named by document ID (`dbs/HHS-ONC-2026-0067-0001.sqlite`)
- Website output uses docket ID for URL paths (read from DB metadata at build time)
- Old document-ID-based URLs get HTML redirects for backward compatibility

## Running the Pipeline for a Docket

### Command format

```bash
bun run src/cli.ts pipeline <document-id> -c 20 --no-clustering
```

- `<document-id>`: Document ID from regulations.gov (e.g., `CMS-2025-0058-0002`) or CSV file path
- Add `--mirrulations` for large dockets (see below)
- Models come from `batch-config.json` per step. `-m <model>` overrides all steps at once; accepted names are `gemini-3.8-flash`, `gemini-3.8-flash-nothink`, `gemini-3.5-flash-lite`, legacy `gemini-3-flash` (3 Flash preview), and `gemini-pro`/`gemini-flash`/`gemini-flash-lite` (2.5). Add new models in `GEMINI_MODELS` in `src/lib/llm-providers.ts`
- `-c 20`: Concurrency — safe with Gemini Tier 1 rate limits (2000 RPM)
- `--no-clustering`: Use for dockets under ~1000 comments (most dockets)
- The DB is created at `dbs/<document-id>.sqlite`

### Choosing a load source

| Source | Flag | Use when |
|---|---|---|
| regulations.gov API | (default) | Small dockets. The comment listing caps at 10,000 results (page 40 × 250), and the API key allows 1,000 requests/hour, so large dockets fail or take days |
| Mirrulations S3 mirror | `--mirrulations` | Large dockets (thousands of comments). Public bucket `s3://mirrulations`, no credentials or API key; ~43k comments + 4 GB attachments load in well under an hour |
| Bulk CSV | pass a `.csv` path | You already have a regulations.gov bulk export. Name it `<document-id>.csv` |

Mirrulations options (on both `load` and `pipeline`):
- `--whole-docket`: include comments on every document in the docket. Large rules often have two copies of the proposed rule (e.g. `-0001` and `-0002`) with comments split between them, so this is usually what you want.
- `--fill-unavailable`: Mirrulations marks some comments `<id>_UNAVAILABLE`; this fetches those from the regulations.gov API (needs `REGSGOV_API_KEY`). Without it, they are reported and skipped.
- `-c <N>` (load only): parallel downloads, default 16.

```bash
bun run src/cli.ts load CMS-2026-2377-0002 --mirrulations --whole-docket -c 24
bun run src/cli.ts load CMS-2026-2377-0002 --mirrulations --whole-docket --fill-unavailable   # second pass for the gaps
```

Re-running any load is safe: comments already in the DB are skipped by ID. Attachment files missing from S3 are fetched from `downloads.regulations.gov` (no API key needed).

### Critical rules

1. **NEVER pass `-s` / `--skip-attachments` unless the user explicitly asks for it.** Many regulatory comments are just "See attached file(s)" stubs with all substance in PDF/DOCX attachments. Skipping attachments causes:
   - Loss of ~45%+ of comment content
   - Broken clustering (all "see attached" stubs get grouped together as duplicates)
   - Hollow analysis for attachment-heavy dockets

2. **Use `--no-clustering` for small dockets.** Dockets under ~1000 comments don't benefit from clustering and it can cause problems (especially with many attachment-only comments). Only enable clustering for 1000+ comment dockets.

### Pipeline steps (1-12)

1. **load** - Load comments from regulations.gov API, Mirrulations or CSV (downloads attachments)
2. **cluster** - Group form letters (skipped with `--no-clustering`; see "Form-letter clustering" below)
3. **tag-campaigns** - Optional (`--tag-campaigns`): tag organized campaigns, including paraphrased ones that clustering can't see. Tags only; units are unchanged. See "Campaign tagging" below
4. **triage** - Label short ungrouped typed comments (<80 words) `no_substance` / `stance_only` / `substantive`, batched ~100 per Flash-Lite call. Condense skips the first two; theme extraction skips `no_substance` and reads `stance_only` comments' raw text so they still count toward themes
5. **transcribe** - Convert attachments/PDFs to clean markdown. Comments without attachments are stored as-is with no LLM call
6. **condense** - Structurally summarize each comment
7. **discover-themes** - Build hierarchical taxonomy of policy themes from a sample: every form-letter template, promoted member and attachment letter, plus `thresholds.typedSample` (1,000) seeded-random typed comments (`--typed-sample`, `--seed`; triaged-out comments excluded). On PFS: ~4,870 units, 15 batches, 3 merges
8. **extract-theme-content** - Extract theme-specific text from each comment, in two phases (see below)
9. **summarize-themes** - Synthesize extracts into narrative theme analysis, in phases across all themes: per-batch summaries, level-by-level 4-way merges, then JSON structuring (includes post-processing to fix partial comment IDs). Sub-themes need ≥5 extracts (`thresholds.minCommentsPerTheme`). Top-level themes with sub-themes instead get a *group report* (Phase 4) synthesized from their sub-themes' reports plus their direct extracts — extraction files content under the most specific theme, so a top-level theme's own extracts are a small slice. Group reports are marked `reportType: "group"` and rebuilt when a sub-theme is re-summarized (or with `--force`); ~$1.50 for 11 groups on the 1-in-20 PFS sample
10. **discover-entities** - Build an entity taxonomy from a seeded sample in one call, then tag every unit's text by term matching (local, no LLM). Entities need mentions in min(1%, 10) units
11. **build-website** - Export analysis for the web dashboard (uses docket ID from DB metadata for output paths). Writes a lean `comments-index.json` loaded at startup (form-letter members point to their representative plus a snippet of their own added text) and on-demand data: `comment-details/` and `comment-text/` shards (condensed sections; full text from the transcription), `theme-extracts/<code>.json`, a `search/` word index, and `campaigns.json` (when step 3 ran; each index entry carries its `campaign` id). At PFS scale (43k comments) startup downloads ~3.4 MB gzipped
12. **vacuum-db** - Optimize SQLite database

### Models and cost

Per-step models live in `batch-config.json` (`tasks.<step>.model`, or `tasks.<step>.models.<role>` read via `getTaskRoleModel`). Defaults and why:

| Step | Model | Notes |
|---|---|---|
| triage | `gemini-3.5-flash-lite` | ~100 comments per call |
| transcribe | `gemini-3.5-flash-lite`; failures retried once on `gemini-3.8-flash` (`models.fallback`) | Thinking budget and 3.8 Flash changed nothing in a trial (same length and source overlap, 2–5× cost). Flash-Lite occasionally returns an empty response for an ordinary letter |
| condense | typed → `gemini-3.5-flash-lite`, attachment letters and promoted members → `gemini-3.8-flash-nothink` | Flash-Lite matched 3.8 on typed comments but omitted recommendations in long multi-issue letters |
| extract-theme-content | gate → `gemini-3.5-flash-lite`; extraction → `gemini-3.8-flash-nothink` | Flash-Lite as extractor over-split themes in a blind comparison |
| discover-themes | `gemini-3.8-flash` (low thinking) | Without thinking it found fewer themes and missed issues (won 3 of 4 blind comparisons with thinking) |
| summarize-themes | `gemini-3.8-flash` (low thinking) | Slightly better summaries and JSON structuring with thinking (7.69 vs 7.31); ~$3.6 difference at PFS scale |
| discover-entities | `gemini-3.8-flash-nothink` | Won both blind comparisons and kept more entities |
| tag-campaigns | judge/merge/expand → `gemini-3.8-flash-nothink`; naming → `gemini-3.5-flash-lite`; embeddings `gemini-embedding-2` | Flash-Lite as judge accepted 71% of candidate groups, including plainly independent dermatology letters; 3.8 Flash without thinking matched hand review far better |

Thinking: 3.5 Flash-Lite doesn't think unless given a budget. `gemini-3.8-flash` defaults to `thinkingLevel: low` (the Batch API rejects `minimal`, which live calls accept; low matched minimal in trials with slightly more thought tokens), which spends ~1–2k thought tokens per call, often more than the visible output. `gemini-3.8-flash-nothink` (same model, `thinkingBudget: 0`, both in `GEMINI_MODELS` in `src/lib/llm-providers.ts`) produces no thought tokens; on attachment-letter condensing and theme extraction it cut cost 41–61% with equal or better blind-judged quality (extraction completeness 4.74 vs 4.35/5, half the omissions). Theme discovery and summaries keep low thinking; they were better with thinking than without.

All per-comment LLM calls go through `runLlmRequests` (`src/lib/step-runner.ts`): live (parallel with retries) or `--batch` (`src/lib/gemini-batch.ts`: uploads a JSONL file, polls, records jobs in `batch_jobs` so a restarted step resumes the same job instead of paying twice, deletes the input file when done). Text-only results are cached in `llm_cache`. Each step prints tokens (input, cached, output, thoughts) and estimated cost at the end.

**Theme extraction (step 8)**: *Short units* (≤400 words): a Flash-Lite *gate* picks the top-level theme groups each unit substantively discusses (40 units per call, stored in `comment_theme_groups`), then extraction runs per gated group, batching up to 15 short units per call. *Long units* (`thresholds.longMode: "full"`, the default): no gate — one call per unit with the whole taxonomy, recorded in `comment_theme_extract_status` under group `*`. Every extraction prompt puts the instructions and themes first and the comment(s) last, so Gemini's implicit cache reuses the shared prefix (63% of long-unit input was cached in testing), and the model emits only themes the comment substantively addresses. `--long-mode gated` restores per-group calls for long units; `--gate-only` runs just the gate; reruns resume per (unit, group).

Evidence (292-unit PFS fixture, blind-judged by 3.8 Flash at high thinking): versus the original one-call-per-group-per-unit design, gated extraction cost ~$0.018 vs $0.104/unit with ~93% content-level recall; for long units, the full-taxonomy call then beat gated per-group calls on accuracy (4.91 vs 4.84/5), completeness (4.67 vs 4.62), theme fit (4.56 vs 4.10) and errors (0.11 vs 0.22/unit), preferred 47–20, at 43% lower cost — gate misses on long letters were the main source of lost content.

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
bun run src/cli.ts pipeline <document-id> -c 20 --start-at <step-number>
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

### Form-letter clustering

Step 2 defaults to `cluster-form-letters` (`--cluster-method form-letters`); the older whole-comment n-gram clusterer is still available as `--cluster-method fast` / the `cluster-comments-fast` command.

How it works (`src/commands/cluster-form-letters.ts`):
- Text per comment = comment field + attachment text. Attachment text is extracted locally (`pdftotext`, `pandoc`; no LLM) and cached in `attachment_text`, so reruns take under a minute.
- "See attached"-style stubs (<40 words of form text when attachments have text) are dropped so they can't link unrelated letters.
- A 5-word phrase is *shared* if it appears in ≥5 comments (`--min-shared-df`). Comments whose text is ≥30% shared (`--min-shared-fraction`), or short comments (<30 phrases) that are ≥80% shared, are linked when their shared text has Jaccard ≥0.5 (`--similarity-threshold`), via MinHash LSH + union-find, then split around a medoid so chained campaigns don't merge. Groups under 4 (`--min-cluster-size`) become singletons.
- Second pass, after promotion: among everything still ungrouped (including promoted members), near-identical copies (full-text Jaccard ≥0.8, `--near-copy-threshold`) are grouped even as pairs. Phrases shared by only 2–3 comments never count as "shared" above, so this catches duplicate submissions (often the same organization submitting twice) and copies sent by a handful of people. Comments sharing a byte-identical attachment file are linked too (the only way to group scans, which have no text). It also regroups identical *variants* of a campaign letter: on PFS, 20 senders added the same ~325 words to a 408-member campaign letter, so each was promoted out of that group; this pass puts them back together as one variant group.
- Each group's template = phrases in ≥50% of members; the representative is the member closest to the template. Each member's own added text goes in `form_letter_additions`.
- Members adding ≥300 words (`--promote-added-words`), typically organizations that used a campaign letter and appended their own material, are promoted to their own singleton cluster (`form_letter_additions.promoted = 1` keeps the link).
- Every comment gets a membership row (ungrouped comments are singletons).

Reference run: CMS-2026-2377 (CY2027 PFS, 43,082 comments) → 891 groups (571 from the near-copy pass) covering 24.7k comments, 19,298 units after collapsing, 349 promoted members (98 regrouped as identical variants); ~3 min including text extraction, ~40 s with cached text. Of the ungrouped, ~8k typed comments share <10% of their text with other comments, i.e. word overlap can't collapse them further (paraphrased campaigns would need semantic similarity).

Check group tightness after clustering — `similarity_score` is the member's coverage of its group template, so loose groups show low average coverage or large additions:
```bash
sqlite3 dbs/<id>.sqlite "
  SELECT cc.cluster_size, cc.representative_comment_id, round(avg(m.similarity_score),2) avg_cov,
         round(avg(COALESCE(fa.added_word_count,0))) avg_added
  FROM comment_clusters cc JOIN comment_cluster_membership m USING(cluster_id)
  LEFT JOIN form_letter_additions fa ON fa.comment_id = m.comment_id AND fa.promoted = 0
  WHERE cc.cluster_size >= 4 GROUP BY cc.cluster_id ORDER BY cc.cluster_size DESC LIMIT 20;
"
```

### Campaign tagging

`tag-campaigns` (`src/commands/tag-campaigns.ts`, pipeline step 3 with `--tag-campaigns`; off by default because it costs ~$3–4 and ~4 min of CPU at PFS scale, and its precision is good but not exact) finds organized campaigns, including *paraphrased* ones: senders given a brief or talking points (often AI-personalized) whose letters share an ask and structure but little wording.

```bash
bun run src/cli.ts tag-campaigns <document-id> -c 20 [--report groups.json]
```

How it works:
1. **Units**: form-letter representatives (≥10 words) and ungrouped comments (≥40 words); text = typed comment + attachment text, first 1,500 words. Embedded with `gemini-embedding-2` (768-d, $0.20/1M tokens), cached in `comment_embeddings` (keyed by text hash), so reruns are free.
2. **Candidates**: average-linkage clustering of the embeddings (all pairs ≥ `levels[0]` → connected components → NN-chain linkage per component), cut at cosine 0.92; groups of ≥4 units.
3. **Judge**: 3.8 Flash (no thinking) reads 10 letters spread from most to least typical (first 300 words each) and answers campaign / mixed / same_topic, with quoted evidence and a name. Mixed or same_topic groups are split at 0.94, then 0.96, and re-judged.
4. Form-letter groups of ≥10 (`minExact`) not in an accepted group become exact-only campaigns (named by Flash-Lite).
5. **Merge**: campaigns whose centroids are within average-linkage 0.95 are shown to the LLM together, which says which are the same campaign (e.g. a form letter and its reworded versions; one brief split by sender type).
6. **Expand**: unassigned units with ≥2 members of one campaign at ≥0.92 are checked by the LLM against that campaign (12 per call). A "yes" counts only if the quoted shared phrase (≥6 words) occurs in the candidate and in ≥2 members and is specific to the campaign (in <1% of units, or mostly in that campaign's units); without that check the expansion added mostly same-topic letters.
7. **Tags** (`campaigns`, `comment_campaigns`): a form-letter representative brings its whole exact-copy group and members promoted out of it (`how = 'exact'`); other units are `paraphrase`. A comment is in at most one campaign, so campaign counts never double-count. `campaigns.method` is `paraphrase` when any member is reworded, else `form-letter`.

Thresholds and evidence (CMS-2026-2377, 15.4k units): random-pair cosine median 0.75, p99 0.887. At 0.92, 3,423 units fall in 361 groups; the judge accepted 214 (+14 after splits). Hand review of a stratified sample of 26 accepted groups: 19 clear campaigns (shared citation strings such as "Section (46), Lactation Care Services, CPT codes 978XX and 978X1, 91 FR 43890 to 43891", identical openings, letterhead, leftover `[placeholders]`), 4 plausible (employer-organized staff letters, shared talking points), 3 same-topic (dermatology/modifier-25 letters). The errors are all in the dense modifier-25 topic; rejected groups sampled were all correctly independent. Expansion, after the phrase check: ~11 of 14 sampled additions were real members. Result: 292 campaigns, 25,675 comments (23,221 exact, 2,454 reworded); 211 campaigns include reworded letters. Recall against known campaigns (ungrouped comments matching each campaign's keywords): skilled-nursing technical correction 173/173, lactation 978XX 68%, OT-on-SLP 67%, G2211/MOD1 60%, "50% cut to same-day care" 50%, health coaching 0591T 55%; most misses are personal stories with too little shared wording to cross 0.92. Cost on PFS: embeddings ~$1.7, LLM ~$1.9 (judge $1.1, expansion $0.7).

Dashboard: a Campaigns tab (list with exact vs reworded counts, detail page with form-letter groups and reworded letters), a campaign badge on comment cards and details, a `campaign:` picker in comment search (also `#/comments?campaign=<id>`), and an Overview panel.

### Gemini sampling settings

No temperature/top_p/top_k is set anywhere: Gemini 3.x models are meant to run at their default (temperature 1.0), and the sampling parameters are deprecated on 3.6 Flash and 3.5 Flash-Lite. All quality trials above ran at the defaults. Re-runs are kept stable by `llm_cache`, not by low temperature.
