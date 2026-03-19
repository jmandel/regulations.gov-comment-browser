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
- Ask about clustering for small dockets (<1000 comments)
- Spot-check clustering results after loading
- The `.env` file contains API keys (GEMINI_API_KEY, REGSGOV_API_KEY)
