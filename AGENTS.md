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

### Pipeline steps (1-13)

1. **load** - Load comments from regulations.gov API, Mirrulations or CSV (downloads attachments)
2. **cluster** - Group form letters (skipped with `--no-clustering`; see "Form-letter clustering" below)
3. **triage** - Label short ungrouped typed comments (<80 words) `no_substance` / `stance_only` / `substantive`, batched ~100 per Flash-Lite call. Condense skips the first two; theme extraction skips `no_substance` and reads `stance_only` comments' raw text so they still count toward themes
4. **transcribe** - Convert attachments/PDFs to clean markdown. Comments without attachments are stored as-is with no LLM call
5. **match-scans** - After transcription, match ungrouped scanned submissions (no extractable text, so clustering could only group identical files) to form-letter groups by their transcripts and move matches into the group, so only the representative is condensed and extracted. A match needs ≥50% of the group's template in the scan and ≥30% of the scan from the template; templates under 40 phrases are ignored (a full letter quoting the rule's title in its RE: line otherwise matched a title-only template). Scans matching each other (Jaccard ≥0.8) form new groups. On PFS: 139 scans joined 39 groups and 30 formed 11 new groups
6. **tag-campaigns** - Optional (`--tag-campaigns`): tag organized campaigns, including paraphrased ones that clustering can't see. Runs after transcription and scan matching so scanned letters are judged by their transcripts. Tags only; units are unchanged. See "Campaign tagging" below
7. **condense** - Structurally summarize each comment
8. **discover-themes** - Build hierarchical taxonomy of policy themes from a sample: every form-letter template, promoted member and attachment letter, plus `thresholds.typedSample` (1,000) seeded-random typed comments (`--typed-sample`, `--seed`; triaged-out comments excluded). On PFS: ~4,870 units, 15 batches, 3 merges
9. **extract-theme-content** - Extract theme-specific text from each comment, in two phases (see below)
10. **summarize-themes-v2** - Synthesize extracts into narrative theme analysis, in phases across all themes: per-batch summaries, level-by-level 4-way merges, then JSON structuring (includes post-processing to fix partial comment IDs). Sub-themes need ≥5 extracts (`thresholds.minCommentsPerTheme`). Top-level themes with sub-themes instead get a *group report* (Phase 4) synthesized from their sub-themes' reports plus their direct extracts — extraction files content under the most specific theme, so a top-level theme's own extracts are a small slice. Group reports are marked `reportType: "group"` and rebuilt when a sub-theme is re-summarized (or with `--force`); ~$1.50 for 11 groups on the 1-in-20 PFS sample
11. **discover-entities** - Build an entity taxonomy (labels, categories, exact match terms), then tag every unit's text by term matching (local, case-sensitive, whole words; no LLM). Entities need mentions in min(1%, 10) units and at most 50%. Discovery runs in phases, all through `runLlmRequests` (`--batch`, `llm_cache`), and prints entities added and cost per phase:
    1. *base*: one call over a seeded random sample of `wordsPerCall` (150k) words.
    2. *themes*: one call per top-level theme over units with extracts under it that no earlier call read (long and attachment letters first, most extracts under the theme first; `typedShare` 15% of words for short typed comments), given the current taxonomy and asked only for missing entities. A random sample of a large docket is mostly short typed comments, so the base call alone misses the technical terms in long letters. On small dockets the themes share the unread words instead of each taking `wordsPerCall`. Dockets without themes skip this phase.
    3. *sweep*: parallel calls of `sweepWordsPerCall` (300k) words over every unit no earlier call read, plus the rest of long letters past `maxWordsPerUnit` (4,000) words as further pieces, so every word is read once. No stop rule: on PFS, rounds of three calls were still finding entities in 100–180 units after five rounds, with only 39% of units read.
    4. *gap fill*: one call per top-level theme over the taxonomy and that theme's titles (no comment text) for broad, common entities. The comment-reading calls list specific names and pass over these: on PFS none named "prior authorization" (428 units).
    5. *consolidate*: one call over the kept entities with per-term match counts (plus three short passages for each acronym of five characters or less) returns edits: merge duplicates, move categories, remove ambiguous terms (e.g. "APP", "ACL"), remove non-entities.

    Additions with the same normalized label as an existing entity extend its terms; otherwise the new entity is added without terms already taken (a shared acronym like "ACP" doesn't make two entities the same). Terms that are US state abbreviations are dropped (every unit's text has a "Location:" line). Thresholds live in `batch-config.json` → `tasks.discoverEntities.thresholds`. `--dry-run <file>` opens the docket DB read-only and writes the taxonomy with unit counts and the call that found each entity to a JSON file (LLM cache in `<file>.cache.sqlite`).

    PFS (19,415 units): 128 → 853 entities. Batch cost ~$7 (themes $1.3, sweep $5.2 for 30 calls / 13M input tokens, gap fill and consolidation ~$0.25); live about twice that. PFS 1-in-20 sample (942 units): 67 → 124 entities for $0.35 batch.
12. **build-website** - Export analysis for the web dashboard (uses docket ID from DB metadata for output paths). Writes a lean `comments-index.json` loaded at startup (form-letter members point to their representative plus a snippet of their own added text) and on-demand data: `comment-details/` and `comment-text/` shards (condensed sections; full text from the transcription), `theme-extracts/<code>.json`, a `search/` word index plus a word-pair index for quoted phrases (`search/pairs.json`, `search/pairs/NNN.json`; `src/lib/phrase-index.ts`), and `campaigns.json` (when step 6 ran; each index entry carries its `campaign` id). At PFS scale (43k comments) startup downloads ~3.4 MB gzipped. The first search loads the word index (~5 MB); a phrase then fetches a few pair shards (~30 KB gzipped each; each adjacent word pair is stored with the exact characters between them), so a two-word phrase needs no text and longer phrases fetch text shards only for their remaining candidates (`"primary source verification"` on PFS: 0.4 MB after the index, was 28 MB). The pair index is ~65 MB on disk for PFS (~1,000 shards) and takes ~1 min to build. Dockets built without it still search, by fetching candidates' text. The comments page also takes `?part=campaignCopies|campaignReworded|typed|attached` (the Overview composition bar links each segment to it; units with any comment in the part, header counting the part's comments). Also writes the downloadable `<docket>-slim.sqlite.zip` and `<docket>-full.sqlite.zip` (see "Dataset downloads" below; `--no-packs` skips them, `--site-url` sets the dashboard URL recorded in them) and lists them in `meta.json` → `downloads` for the Overview's "Download the data" section. Scoped analyses with current relevance are listed in `meta.json` → `scopes`; `--scope <slug>` builds one scope's sub-site data instead (see "Scoped analyses"; the CI script does this for every listed scope)
13. **vacuum-db** - Optimize SQLite database

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
| discover-entities | `gemini-3.8-flash-nothink` (all phases) | Won both blind comparisons and kept more entities. Reads the whole docket once: ~$7 batch at PFS scale |
| tag-campaigns | judge/merge/expand → `gemini-3.8-flash-nothink`; naming → `gemini-3.5-flash-lite`; embeddings `gemini-embedding-2` | Flash-Lite as judge accepted 71% of candidate groups, including plainly independent dermatology letters; 3.8 Flash without thinking matched hand review far better |

Thinking: 3.5 Flash-Lite doesn't think unless given a budget. `gemini-3.8-flash` defaults to `thinkingLevel: "LOW"` — uppercase matters: the Batch API rejects `minimal` and silently ignores lowercase `low` (0 thought tokens), while `LOW` works in live and batch calls; it matched minimal in trials with slightly more thought tokens, which spends ~1–2k thought tokens per call, often more than the visible output. `gemini-3.8-flash-nothink` (same model, `thinkingBudget: 0`, both in `GEMINI_MODELS` in `src/lib/llm-providers.ts`) produces no thought tokens; on attachment-letter condensing and theme extraction it cut cost 41–61% with equal or better blind-judged quality (extraction completeness 4.74 vs 4.35/5, half the omissions). Theme discovery and summaries keep low thinking; they were better with thinking than without.

All per-comment LLM calls go through `runLlmRequests` (`src/lib/step-runner.ts`): live (parallel with retries) or `--batch` (`src/lib/gemini-batch.ts`: uploads a JSONL file, polls, records jobs in `batch_jobs` so a restarted step resumes the same job instead of paying twice, deletes the input file when done). Text-only results are cached in `llm_cache`. Each step prints tokens (input, cached, output, thoughts) and estimated cost at the end.

**Theme extraction (step 9)**: *Short units* (≤400 words): a Flash-Lite *gate* picks the top-level theme groups each unit substantively discusses (40 units per call, stored in `comment_theme_groups`), then extraction runs per gated group, batching up to 15 short units per call. *Long units*: no gate — one call per unit with the whole taxonomy, recorded in `comment_theme_extract_status` under group `*`. Every extraction prompt puts the instructions and themes first and the comment(s) last, so Gemini's implicit cache reuses the shared prefix (63% of long-unit input was cached in testing), and the model emits only themes the comment substantively addresses. `--gate-only` runs just the gate; reruns resume per (unit, group).

Evidence (292-unit PFS fixture, blind-judged by 3.8 Flash at high thinking): versus the original one-call-per-group-per-unit design, gated extraction cost ~$0.018 vs $0.104/unit with ~93% content-level recall; for long units, the full-taxonomy call then beat gated per-group calls on accuracy (4.91 vs 4.84/5), completeness (4.67 vs 4.62), theme fit (4.56 vs 4.10) and errors (0.11 vs 0.22/unit), preferred 47–20, at 43% lower cost — gate misses on long letters were the main source of lost content.

### After pipeline completes

1. **Browse locally**: Copy data and start dev server:
   ```bash
   cp -r dist/data/* dashboard/public/data/
   cd dashboard && bunx vite --port 3002
   ```

2. **Deploy**: Upload the DB file to the Google Drive `regulations-dbs` folder, then push to trigger the GitHub Actions build (`scripts/build-all-dashboards.sh`; on `main` it also publishes changed downloadable databases to the `analysis-databases` release, see "Dataset downloads").

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

Step 2 runs `cluster-form-letters`.

How it works (`src/commands/cluster-form-letters.ts`):
- Text per comment = comment field + attachment text. Attachment text is extracted locally (`pdftotext`, `pandoc`; no LLM) and cached in `attachment_text`, so reruns take under a minute.
- "See attached"-style stubs (<40 words of form text on a comment with any attachment, even one whose text couldn't be extracted) are dropped so they can't link unrelated letters. Scans therefore group only through identical files.
- A 5-word phrase is *shared* if it appears in ≥5 comments (`--min-shared-df`). Comments whose text is ≥30% shared (`--min-shared-fraction`), or short comments (<30 phrases) that are ≥80% shared, are linked when their shared text has Jaccard ≥0.5 (`--similarity-threshold`), via MinHash LSH + union-find, then split around a medoid so chained campaigns don't merge. Groups under 4 (`--min-cluster-size`) become singletons.
- Second pass, after promotion: among everything still ungrouped (including promoted members), near-identical copies (full-text Jaccard ≥0.8, `--near-copy-threshold`) are grouped even as pairs. Phrases shared by only 2–3 comments never count as "shared" above, so this catches duplicate submissions (often the same organization submitting twice) and copies sent by a handful of people. Comments sharing a byte-identical attachment file are linked too (the only way to group scans, which have no text). It also regroups identical *variants* of a campaign letter: on PFS, 20 senders added the same ~325 words to a 408-member campaign letter, so each was promoted out of that group; this pass puts them back together as one variant group.
- Each group's template = phrases in ≥50% of members; the representative is the member closest to the template. Each member's own added text goes in `form_letter_additions`.
- Members adding ≥300 words (`--promote-added-words`), typically organizations that used a campaign letter and appended their own material, are promoted to their own singleton cluster (`form_letter_additions.promoted = 1` keeps the link).
- Every comment gets a membership row (ungrouped comments are singletons).

Reference run: CMS-2026-2377 (CY2027 PFS, 43,082 comments) → 1,033 groups (721 from the near-copy pass) covering 24.5k comments, 19,644 units after collapsing, 349 promoted members (98 regrouped as identical variants); ~3 min including text extraction, ~40 s with cached text. Of the ungrouped, ~8k typed comments share <10% of their text with other comments, i.e. word overlap can't collapse them further (paraphrased campaigns would need semantic similarity).

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

`tag-campaigns` (`src/commands/tag-campaigns.ts`, pipeline step 6 with `--tag-campaigns`; off by default because it costs ~$3–4 and ~4 min of CPU at PFS scale, and its precision is good but not exact) finds organized campaigns, including *paraphrased* ones: senders given a brief or talking points (often AI-personalized) whose letters share an ask and structure but little wording.

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

### Dataset downloads

`build-website` exports two zipped SQLite databases per docket (`src/lib/dataset-pack.ts`; examples in `src/lib/dataset-pack-examples.ts`, theme-report rendering in `src/lib/theme-report-markdown.ts`), linked from the Overview and described in the AI skill. Local builds put them in the site's `data/`; the published site serves them from a GitHub release (see "Hosting" below):

- `<docket>-slim.sqlite.zip`: `docket`, `submissions` (one row per comment as filed, without text), `units` (one row per analyzed text: form-letter group, promoted member or individual comment, with its weight `submissions` and condensed-summary columns), `themes` (rolled-up submissions/units), `unit_themes`, `extract_items` (each position/concern/recommendation/experience/quote per unit and theme), `theme_reports` (markdown with cited IDs annotated by submitter) and `theme_report_items`, `campaigns`, `entities`/`unit_entities`, `attachments` (metadata and URLs), views `v_submissions` and `v_extract_points`.
- `<docket>-full.sqlite.zip`: the same plus `units.text`/`text_source` (`typed` = verbatim comment box, `llm_transcript` = transcription of comment + attachments), `submissions.typed_text` (comment box, only when the unit text is a transcript) and `added_text` (form-letter members' own words). Template text is never repeated per member.

It is a purpose-built schema written at export (the pipeline DB is only read): every CREATE carries a header comment and a `--` comment per column, so `.schema` documents it; `_readme` is created first and its rows hold the overview, counting units (submissions vs units), original-vs-LLM fields, provenance (models per step, read from `llm_cache`), caveats, a list of features missing in older databases, `enable_search`, ~10 worked example analyses filled in for the docket (largest theme, a characteristic entity's search terms, an organization) and tips. Each zip also has the same text as README.md. No blobs, caches or bookkeeping tables.

FTS5 indexes (`extract_items_fts`, `summaries_fts`, `theme_reports_fts`, full: `units_text_fts`; porter stemming, external content) add ~60–70% to a zip, so they're included only while the zip stays under 50 MB (slim) / 95 MB (full); otherwise `docket.search_index = 'not_included'` and the `enable_search` section has the statements to build them. Output is deterministic: sorted inserts, no export timestamp (`docket.generated_at` is the newest analysis result), fixed zip mtimes, `zip -X` (the `zip` CLI is required; on ubuntu-latest it is preinstalled, without it the step is skipped with a warning).

Measured sizes (zip): real full PFS run slim 75 MB / full 124 MB without search; PFS 1-in-20 sample (1,364 comments) slim 5.2 MB / full 7.5 MB, with search; synthetic full-scale PFS (43k comments, 20k units) with search would be slim 48 MB / full 112 MB, so it ships without: slim 46 MB / full 80 MB (building the indexes from `enable_search` then takes ~40 s). Previously published dockets: 2.4–18.8 MB slim, 3.2–26 MB full, all with search. Build time at PFS scale is ~3 min on a heavily loaded 12-core machine (less on an idle runner). Older databases (no clustering, transcripts, campaigns, triage, group reports) export with empty tables/NULL columns and a "Not available for this docket" README section.

Hosting: CI builds with `DATA_DOWNLOADS_URL=https://github.com/<repo>/releases/download/analysis-databases`, so `meta.json` → `downloads[].url` (and the skill's links) point at release assets; then `scripts/publish-data-packs.sh dist` uploads each zip to the `analysis-databases` release (created on first run) only when its SHA-256 differs from the asset's digest, and the zips are deleted from `dist/` before the Pages deploy. Every push rebuilds the site, so zips inside it would be redeployed and stored as a new workflow artifact each time (and the full PFS zip is over 100 MB); release assets keep one copy per file name at a stable URL. This relies on deterministic output: the `docket.export_code_hash` column hashes the export code instead of recording the git commit, which would change every zip on every push. `--dry-run` shows what would upload. Each `downloads` entry also has `sha256`.

### Gemini sampling settings

No temperature/top_p/top_k is set anywhere: Gemini 3.x models are meant to run at their default (temperature 1.0), and the sampling parameters are deprecated on 3.6 Flash and 3.5 Flash-Lite. All quality trials above ran at the defaults. Re-runs are kept stable by `llm_cache`, not by low temperature.

### Scoped analyses

A *scope* is a markdown prompt that focuses the analytic half of the pipeline on one question about a docket — a topic ("interoperability and health IT…"), a combination of topics, or "the issues raised in comment X" (drafted from a seed letter). Design: `docs/design/scoped-analysis.md`.

- Each scope lives in its own small DB, `<DB_DIR>/<documentId>.scope.<slug>.sqlite` (flat naming so the Drive download script keeps it next to the docket DB), holding only scope tables (`scope`, `scope_relevance`, theme tables, `llm_cache`, `batch_jobs`). The docket DB is ATTACHed read-only (`src/lib/scope-db.ts`, `openScopeDb`), so scoped runs can never modify shared data. Code that iterates `dbs/*.sqlite` as dockets must skip scope DBs (`isScopeDbFile()`).
- `scope create <doc> <slug> --prompt-file scope.md | --from-comment <commentId> [--name ..] [--summary ..]` (name ≤ ~6 words and a one-sentence summary are drafted by Flash-Lite when omitted; the full prompt can be long), `scope show|edit|list`.
- `pipeline <doc> --scope <slug> [--batch]` runs, in the scope DB: **scope-relevance** (every unit judged relevant or not with its in-scope excerpt; condensed summary for short units, full text for long ones; `gemini-3.8-flash-nothink` for all units — Flash-Lite over-included generic fee-cut letters on short units) → **discover-themes** (on the relevance excerpts) → **extract-theme-content** (relevant units; scope block in the cached prompt prefix) → **summarize-themes-v2** (summaries state "X of the Y in-scope submissions (out of Z in the docket)"). Requires docket steps 1–7. Editing a scope's prompt makes its results stale; the next scope-relevance clears them. Prompts without `--scope` are byte-identical to before, so open-ended caches stay valid.
- Evidence (1-in-20 PFS sample): interoperability scope 18 of 942 units relevant, ~$1.75 live; Johns Hopkins Medicine seed-letter scope 56% of submissions relevant, 13 top-level themes mapping onto the letter's issues, ~$3.41 batch. Long-letter relevance recall ~90% (misses were single sentences in 8,000-word letters), precision ~100%. Relevance alone is ~$17 per scope at full PFS scale.
- **Website**: each scope is a sub-site at `<site>/<docket>/scopes/<slug>/` (Overview, Themes, Summaries incl. group reports, Topics, Campaigns, Comments, comment detail). `build-website <doc>` lists the docket's publishable scopes (relevance current with the prompt; `listPublishableScopes`) in `meta.json` → `scopes`, shown as "Scoped analyses" on the docket Overview; `build-website <doc> --scope <slug> -o <docket-out>/scopes/<slug>/data` writes only scope-specific files: `meta.json` (scope stats, `sharedData: "../../data/"`, `docketUrl: "../../"`), `scope.json` (name, summary, `promptMarkdown`, seed comment, counts incl. organizations and form-letter groups), `scope-units.json` (in-scope unit → relevance excerpt, note, scoped theme codes, seed flag), `themes.json`, `theme-summaries.json`, `theme-extracts/`, `overview.json` (computed over in-scope comments). The dashboard reads the docket's `comments-index.json`, comment shards, search index, entities and campaigns through `sharedData` (`dashboard/src/utils/dataPaths.ts`) and narrows them to in-scope units; members of an in-scope form-letter group are in scope. The scope page's `index.html` is the docket's with asset paths rewritten to `../../assets/`, so a sub-site is just its data (PFS 1-in-20 sample: interop 0.4 MB, JHM letter 3.2 MB, vs 25 MB docket data). Every scoped page has a banner (name, summary, "N of M submissions addressed this scope", the full prompt collapsed behind "Read the scope prompt", a link to the same page in the docket's analysis where one exists). Comments default to in-scope units with a "This scope / Whole docket" switch; comment detail shows the scope excerpt and highlights its sentences in the full text (verbatim matches only). Topic and campaign counts are recomputed over in-scope comments.
- **Landing page and skill** list each docket's scopes (name, summary, counts, link). **CI** (`scripts/build-all-dashboards.sh`, `build-single-dashboard.sh`) skips `*.scope.*.sqlite` when enumerating dockets and builds every scope listed in the docket's `meta.json` into its output; the Drive download flattens folders, so scope DBs land next to their docket DB. A scope that fails to build is skipped with a warning.
- Not yet: per-scope downloadable analysis databases (the slim/full zips cover the docket-wide analysis only).
