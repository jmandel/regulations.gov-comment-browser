# Comment Analysis Dashboard

A TypeScript React application for browsing and analyzing public comments from regulations.gov.

## Features

- **Theme-Centric Navigation**: Browse hierarchical themes with expand/collapse functionality.
- **Theme Summaries**: Read detailed, AI-generated narrative analyses for key themes.
- **Smart Comment Filtering**: Filter by themes, entities, and stakeholder types.
- **Markdown Rendering**: Condensed comments are displayed with proper markdown formatting.
- **Hash-Based Routing**: All views are bookmarkable URLs (e.g., `#/themes/1.2.3`).
- **Copy for LLM**: Export data in LLM-friendly formats for further analysis.
- **Entity Browser**: Explore entities by category with mention counts.
- **Responsive Design**: Works on desktop and mobile devices.

## Development

```bash
# Install dependencies
bun install

# Start development server
bun run dev

# Build for production
bun run build

# Preview production build
bun run preview
```

## Data Requirements

The dashboard reads these files from `/public/data/`. Only the first five load at startup; the
rest are fetched on demand, so dockets with tens of thousands of comments stay fast:

- `meta.json` - Document metadata and statistics.
- `themes.json` - Theme hierarchy with comment counts.
- `theme-summaries.json` - Detailed narrative summaries for themes.
- `entities.json` - Entity taxonomy by category.
- `comments-index.json` - Every comment's metadata, one-line summary, themes and entities.
  Form-letter members reference their representative instead of copying its content.
- `comment-details/NNNN.json` - Condensed sections (and members' added text), loaded when a
  comment is shown or copied.
- `comment-text/NNNN.json` - Full comment text, loaded when a comment is opened, copied, or a
  phrase search needs verifying.
- `search/index.json`, `search/postings.bin` - Full-text word index, loaded on the first search.
- `theme-extracts/<code>.json` - Per-theme extracts, loaded when a theme page opens.
- `indexes/theme-comments.json`, `indexes/entity-comments.json` - Theme/entity to comment
  mappings (not used by the dashboard; kept for the AI skill).

Generate these files using the main CLI tool:
```bash
bun run build-website <document-id>
```

## URL Structure

- `#/overview` - Dashboard overview with statistics.
- `#/themes` - Theme hierarchy browser.
- `#/themes/:code` - Individual theme detail with comments.
- `#/summaries` - **(New)** Browse all theme analysis summaries.
- `#/entities` - Entity browser by category.
- `#/entities/:category/:label` - Entity detail with mentions.
- `#/comments` - Comment browser with filters.
- `#/comments/:id` - Individual comment detail.

## Technology Stack

- **React 18** with TypeScript
- **React Router** for hash-based routing
- **Zustand** for state management
- **Tailwind CSS** for styling
- **React Markdown** for rendering condensed text
- **Vite** for fast builds with Bun 