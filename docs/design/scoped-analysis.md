# Design: Scoped Analysis

Status: phase 1 (backend) implemented 2026-10-02: `src/lib/scope-db.ts`, `src/commands/scope.ts` (`scope create|show|edit|list`, `scope-relevance`), `--scope` on discover-themes / extract-theme-content / summarize-themes-v2 / pipeline. Website output (phase 2) is not built yet. Where this doc and the code differ, the code wins; notably: scope DBs are flat files `dbs/<doc>.scope.<slug>.sqlite` (the Drive download flattens folders); the `scope` table also has `name` (<= ~6 words) and `summary` (one sentence), drafted by Flash-Lite when not given; relevance uses 3.8 Flash without thinking for short and long units (Flash-Lite had very poor precision on short units); summaries open with the theme's in-scope count against the in-scope and docket totals and store a `scopeCounts` object.

## Problem

Broad rules like the Physician Fee Schedule bundle dozens of unrelated policies (E/M and modifier 25, pathology codes, remote patient monitoring, lactation services, MSSP, drug rebates, ...). The open-ended pipeline discovers a taxonomy across *everything*, which spreads thin on a 43k-comment docket and doesn't answer the questions people actually bring:

- "What did commenters say about interoperability and health IT?"
- "Interoperability plus quality measures"
- "How did the rest of the docket respond to the issues raised in Mr. Sinai's letter?"

A **scoped analysis** re-runs the analytic half of the pipeline (relevance → themes → extraction → synthesis) focused by a prompt, reusing all the expensive per-comment work already done for the docket.

## Goals and non-goals

Goals
- A scope is **just a markdown prompt**. No schema, no topic lists, no in/out fields. The model infers structure from the prose.
- Many scopes per docket, cheap to add, each producing a self-contained, browsable result.
- Every scoped result states what it covers: the scope text, and how many comments/campaigns/organizations were in scope out of the docket total.
- No changes to the open-ended analysis or to existing DBs.

Non-goals (for now)
- Cross-docket scopes.
- Editing a scope and incrementally patching results (an edited scope is re-run; the LLM cache makes unchanged calls free).
- Scoping load/cluster/transcribe/condense — these stay per-docket and shared.

## Concepts

**Scope prompt.** Markdown written by a person, or drafted by the model from a seed comment and then edited. Examples:

```markdown
Focus on provisions affecting interoperability and health IT: certified EHR requirements,
prior authorization APIs, information blocking, and how these interact with MIPS
Promoting Interoperability. I'm especially interested in burden on small practices.
```

```markdown
The scope is the set of issues raised in comment CMS-2026-2377-12345 (Mr. Sinai):
1. ...
2. ...
For each, I want to know who else raised it, who agreed or disagreed, and why.
```

**Unit.** What the pipeline processes: a form-letter group's representative, a promoted member, or an ungrouped comment (after triage). Units carry a weight (`cluster_size`) so counts reflect submissions, not units.

**Scoped analysis.** The output for one scope on one docket: relevance judgments, a theme taxonomy, per-unit theme extracts, theme summaries, and website data.

## Pipeline

Shared, per docket (unchanged): `load → cluster → triage → transcribe → condense`.
Scoped, per scope: `scope create → scope relevance → discover-themes → extract-theme-content → summarize-themes → build-website`.

### S0. `scope create`

```bash
bun run src/cli.ts scope create <doc-id> <slug> --prompt-file scope.md
bun run src/cli.ts scope create <doc-id> <slug> --from-comment CMS-2026-2377-12345   # drafts a prompt
bun run src/cli.ts scope show <doc-id> <slug>        # print prompt + status
bun run src/cli.ts scope edit <doc-id> <slug> --prompt-file scope.md
```

- `--from-comment`: one 3.8 Flash call over that comment's transcription produces a draft prompt in the second example's style (issues listed in prose, stance noted). Saved, printed, and meant to be edited before running.
- Combinations ("interoperability + quality measures") are just a prompt that says both. No special handling.
- `slug` is URL-safe (`interop`, `sinai-letter`) and names the output path.

### S1. `scope relevance` (new step)

For every unit, decide whether it addresses the scope, and capture the in-scope material.

- Input per unit: condensed comment for short/typed comments; **transcription** for attachment letters and promoted members (long letters often touch a scope in one paragraph that condensing can drop).
- Batched: pack units into calls by token budget (~50 condensed units or a few long letters per call). Model: `gemini-3.5-flash-lite` (it is a classification + copy task); escalate to 3.8 Flash only if spot checks show misses.
- Output per unit: `relevant` (yes/no), `excerpt` (the in-scope passages, lightly trimmed, verbatim where possible), `note` (one line: what part of the scope it touches).
- Recall-biased instruction: include a unit if *any* part addresses the scope; exclusion must be clear.
- Triage interaction: "stance only" brief comments are judged from their text like any other unit (cheap, batched ~100/call) so they can count toward scoped tallies; "no substance" comments are skipped.
- Seed-letter scopes: the seed comment itself is marked relevant and flagged `is_seed` so summaries can say "the seed letter argued X; N others agreed".

### S2. `discover-themes --scope <slug>`

- Input: the **excerpts** from S1 for relevant units, not whole condensed comments. This keeps discovery focused and much smaller than the docket (and avoids long letters' out-of-scope material dominating).
- Prompt: `THEME_DISCOVERY_PROMPT` gets a `## Scope` block (the scope markdown verbatim) and one instruction: organize the taxonomy around what the scope asks about; omit material outside it. If the scope enumerates issues (seed letters), the model will naturally use them as top-level themes; we don't force it.
- Same hierarchical batching/merge as today; merge prompt also gets the scope block.

### S3. `extract-theme-content --scope <slug>`

- Units: relevant units only.
- Input text: unchanged from today (full transcription/condensed), so extracts keep fidelity; the scope keeps them on-topic.
- Prompt: the scope block goes in the **cached prefix** (instructions + scope + comment), before the per-call theme group, so Gemini prompt caching keeps working (see `buildBatchedThemeExtractPrompt`).

### S4. `summarize-themes --scope <slug>`

- Same as today over scoped extracts; prompt gets the scope block plus the denominators (below) so narratives can say "of the 1,240 in-scope submissions...".
- Seed-letter scopes: no special summary structure. The scope prompt asks how the docket responded to the letter's issues, and the narrative handles agreement and disagreement as it sees fit (decided 2026-10-02).

### S5. Entities

Not re-run. The docket's entity taxonomy is reused; scoped indexes are filtered to relevant comments.

### S6. `build-website --scope <slug>`

Writes the scoped data set (see Website) including `scope.json` with the prompt and denominators.

### Pipeline command

```bash
bun run src/cli.ts pipeline <doc-id> --scope <slug>     # runs S1–S6, requires shared steps done
```

Fails fast if condensed comments are missing, with the command to run the shared steps.

## Storage

Theme tables today have one taxonomy per DB (`theme_hierarchy.code` is the primary key; `comment_theme_extracts`, `theme_summaries` key on theme code). Adding a `scope_id` column means rebuilding primary keys in every existing DB.

**Chosen approach: one small SQLite file per scope, with the docket DB attached read-only.**

```
dbs/CMS-2026-2377-0002.sqlite                  # docket DB (unchanged)
dbs/CMS-2026-2377-0002.scope.interop.sqlite    # scope DB
```

- The scope DB contains only: `scope` (slug, name, prompt_md, seed_comment_id, created_at, updated_at), `scope_relevance` (comment_id PK, relevant, excerpt, note, is_seed), `theme_hierarchy`, `comment_theme_extracts`, `theme_summaries`, `llm_cache`.
- Opened as `main`; the docket DB is `ATTACH`ed as `base` in read-only mode. SQLite resolves unqualified table names `main` first, then attached DBs, so **existing queries in discover/extract/summarize/build-website work unchanged**: theme tables resolve to the scope DB, `comments`/`transcriptions`/`condensed_comments`/cluster tables resolve to the docket DB.
- Read-only attach guarantees a scoped run can never modify the shared docket data.
- Deleting a scope = deleting its file. Shipping a scope = shipping one small file alongside the docket DB.

Pitfalls to handle
- `openDb()` runs `initSchema()` which would create *all* tables (including an empty `comments`) in the scope DB and shadow the docket's. Add `openScopeDb(docId, slug)` that creates only scope tables, then attaches the base DB. Add a startup assertion that no base table names exist in the scope DB.
- Commands get a `--scope <slug>` option that swaps `openDb` for `openScopeDb`; unit selection adds `JOIN scope_relevance USING(comment_id) WHERE relevant = 1`.
- `llm_cache` lives in the scope DB. The scope text is part of every scoped prompt, so cache keys never collide with the open-ended run or other scopes; re-running an unchanged scope is free.

## Counting and denominators

Every scoped output carries (in `scope.json` and in summary prompts):

- docket totals: submissions, units
- in scope: submissions (sum of `cluster_size` over relevant units), units, form-letter groups, organizations, brief stance-only comments
- per theme: submissions and units (as today, from `cluster_size`)

Rules
- Form-letter group relevance is judged once on its representative and applies to all members (members' additions are already in the group digest).
- Promoted members are judged on their own.
- Stance-only brief comments count toward theme tallies but aren't quoted as reasoning.

## Prompts

New
- `SCOPE_DRAFT_FROM_COMMENT_PROMPT`: seed transcription → editable markdown scope prompt.
- `SCOPE_RELEVANCE_PROMPT`: scope + batch of units → JSON `[{id, relevant, excerpt, note}]`.

Changed (scope block inserted when `--scope` is set; otherwise byte-identical to today so open-ended caches stay valid)
- `THEME_DISCOVERY_PROMPT`, `THEME_MERGE_PROMPT`
- `buildBatchedThemeExtractPrompt` (scope in cached prefix)
- `THEME_SUMMARY_FROM_EXTRACTS_PROMPT`, `EXTRACT_MERGE_PROMPT`

Scope block format, everywhere:

```markdown
## Scope of this analysis
<scope prompt, verbatim>

Analyze only what bears on this scope. Ignore material outside it.
```

## Website and dashboard

Data layout (per docket build):

```
data/                       # open-ended analysis (unchanged)
data/scopes/index.json      # [{slug, name, inScopeSubmissions, ...}]
data/scopes/<slug>/scope.json
data/scopes/<slug>/themes.json, theme-summaries.json, theme-extracts.json, indexes/theme-comments.json
```

- `comments.json` and `entities.json` are not duplicated; scoped views reuse the docket's and filter by `scope_relevance` (exported as `data/scopes/<slug>/relevant.json`: id → excerpt/note).
- Dashboard: `useStore` takes a data base path; routes get an optional prefix `#/s/<slug>/...`. The layout shows a scope switcher and, on every scoped page, a banner with the scope prompt (collapsible) and denominators.
- Comment detail in a scoped view highlights the in-scope excerpt.
- Landing page lists scopes under each docket. The AI skill export includes scope prompts and points to scoped data.
- `scripts/build-all-dashboards.sh` picks up `dbs/<doc>.scopes/*.sqlite` automatically.

## Cost (estimates for CMS-2026-2377, PFS, 43.1k comments)

Measured inputs (after form-letter clustering): 20,035 units: 12,526 typed comments ≥40 words (avg 228 words), 3,954 typed <40 words (avg 22), 3,555 with attachments (11.1M words total, 26.8k PDF pages, 520 scanned/image files). Prices: Flash-Lite 3.5 $0.30/$2.50 per 1M in/out; 3.8 Flash $0.75/$3.75 (promotional through 2026-12-31, then doubles). Output estimates exclude thinking tokens, the largest unknown; calibrate on a 100-unit trial using `thoughtsTokenCount`.

**Fixed: once per docket (shared by the open-ended run and every scope)**

| Step | Model | Estimate | Notes |
|---|---|---|---|
| Cluster, triage text extraction | local | $0 | |
| Triage of brief comments | Flash-Lite | <$1 | ~40 batched calls |
| Transcribe attachments (3.6k units) | Flash-Lite | ~$40 | Output-dominated: transcripts ≈ 15M tokens |
| Transcribe typed comments (16.5k) | Flash-Lite | ~$13, or $0 | Avoidable: typed text can be stored as its own transcript |
| Condense (≈20k units) | 3.8 Flash | ~$75 (+ thinking) | Thinking could add up to ~$75 more; set a low thinking level |
| **Total fixed** | | **~$115–200** | |

**Marginal: per scope**

| Step | Scales with | Estimate |
|---|---|---|
| Relevance (reads every unit) | docket size, same for every scope | Flash-Lite ~$11 · split by type ~$17 · 3.8 Flash ~$25 |
| Theme discovery (in-scope excerpts) | in-scope share | ~$1–3 |
| Theme extraction (in-scope units × theme groups, cached prefix) | in-scope share | ~$16 at 5% · ~$48 at 15% · ~$95 at 30% |
| Summaries | number of themes | ~$3–5 |
| **Total per scope** | | **~$30 (focused, 5%) · ~$75 (15%) · ~$130 (broad, 30%)** |

For comparison, open-ended extraction over all 20k units is ~$320 on its own. A focused scope costs about a tenth of that. Running before 2027-01-01 avoids 3.8 Flash's price doubling; the Gemini Batch API (50% off) would halve most of these but isn't implemented.

## Edge cases

- **Scope matches almost everything** (e.g. "physician payment"): works, just costs more; `scope relevance` prints the in-scope share up front so it can be stopped early.
- **Scope matches almost nothing**: report counts and stop before discovery if under a threshold (e.g. <10 units).
- **Seed comment not transcribed** (e.g. only condensed): `scope create --from-comment` transcribes it on demand.
- **Scope edited after a run**: `scope edit` marks results stale; the next run recomputes, and the cache absorbs unchanged calls.
- **Out-of-rule topics** in a scope: relevance handles them like any other; summaries say if few comments addressed them.

## Implementation phases

1. **Storage + CLI skeleton**: `openScopeDb` with base attach and shadowing guard; `scope create/show/edit`; `--scope` option plumbing. Check: open-ended commands produce identical output with no `--scope`.
2. **Relevance**: prompt, batching, `scope_relevance`. Check: hand-label ~100 units for one scope; recall ≥ 95% on the hand labels, precision spot-checked.
3. **Scoped themes/extracts/summaries**: scope block in prompts; unit filtering. Check: run "interoperability" on CMS-2026-2377; read the taxonomy and three summaries.
4. **Website**: scoped data export, dashboard prefix routes, banner, landing page. Check: browse a scope locally; open-ended dashboard unchanged.
5. **Seed-letter scopes**: draft prompt from comment; seed flag in summaries. Check: run on one large organizational letter and compare its issues against the generated taxonomy.
6. **Docs**: AGENTS.md section on scopes.

## Open questions

- Should S1 use the cheaper model for all units, or 3.8 Flash for long attachment letters where recall matters most? (Cost difference: ~$6–14 per scope; see Cost.)

Decided 2026-10-02: disagreement with a seed letter is left to the narrative; a "rule structure" scope is just a prompt someone writes, not a built-in preset.
