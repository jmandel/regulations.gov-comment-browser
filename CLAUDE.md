# Claude Code Project Instructions

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
See `AGENTS.md` for detailed pipeline operation instructions. Key points:
- Never skip attachments (`-s`) unless explicitly asked
- Use `--no-clustering` for dockets under ~1000 comments
- Default model: `gemini-3-flash`, default concurrency: `-c 20`
- The `.env` file contains API keys (GEMINI_API_KEY, REGSGOV_API_KEY)

## ID conventions
- **Docket ID**: e.g., `HHS-ONC-2026-0067` — the regulatory proceeding
- **Document ID**: e.g., `HHS-ONC-2026-0067-0001` — a specific document within the docket (pipeline input)
- **Comment ID**: e.g., `HHS-ONC-2026-0067-0042` — shares the docket prefix, not the document prefix
- DB files are named by document ID (`dbs/HHS-ONC-2026-0067-0001.sqlite`)
- Website output uses docket ID for URL paths (read from DB metadata at build time)
- Old document-ID-based URLs get HTML redirects for backward compatibility
