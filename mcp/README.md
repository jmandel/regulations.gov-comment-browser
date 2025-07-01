# Regulations.gov Comment Browser MCP Server

An MCP (Model Context Protocol) server that provides access to public comments on regulatory proposals via a streamlined API interface.

## Important Usage Notes

- **Docket IDs**: Always use the full docket ID (e.g., "CMS-2025-0050-0031") not partial IDs
- **Enhanced Responses**: All tools now return:
  - Docket metadata (total comments, themes, entities) 
  - Contextual suggestions for follow-up queries
  - Smart defaults for easier exploration
- **Improved Defaults**:
  - Search snippets are 8x longer (~800 chars) for better context
  - `getComment` returns ALL fields when none specified (except entities - too verbose)
  - `searchComments` with `returnType: "fields"` returns `detailedContent` by default

## Features

- **Unified Search**: Search comments using keywords, entities, and themes
- **Entity Recognition**: Browse and filter by organizations, agencies, and stakeholders
- **Theme Analysis**: Access hierarchical theme taxonomies and summaries
- **Rich Comment Data**: Retrieve structured comment data including positions, recommendations, and concerns
- **Efficient Caching**: Built-in caching layer for optimal performance

## Installation

```bash
cd mcp
bun install
```

## Usage

### Starting the Server

The MCP server can run in two modes:

#### HTTP Server Mode (for web clients)
```bash
# Default: Uses published data from https://joshuamandel.com/regulations.gov-comment-browser
bun start

# Custom data source
REGULATIONS_BASE_URL=http://localhost:3000 bun start

# Custom port
PORT=3001 bun start
```

#### CLI Mode (for STDIO transport)
```bash
# Run with STDIO transport for CLI tools
bun run start:cli

# Or directly
bun run src/cli.ts
```

### Connecting with Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "regulations-browser": {
      "command": "bun",
      "args": ["run", "/path/to/mcp/src/index.ts"],
      "env": {
        "REGULATIONS_BASE_URL": "https://joshuamandel.com/regulations.gov-comment-browser"
      }
    }
  }
}
```

Or if you prefer to use Node.js with compiled JavaScript:

```json
{
  "mcpServers": {
    "regulations-browser": {
      "command": "node",
      "args": ["/path/to/mcp/dist/index.js"],
      "env": {
        "REGULATIONS_BASE_URL": "https://joshuamandel.com/regulations.gov-comment-browser"
      }
    }
  }
}
```

## Query Syntax

The search tool supports a powerful query syntax:

```
# Simple keyword search
"prior authorization"

# Entity search
"entity:CMS entity:Medicare"

# Theme search  
"theme:2.1 theme:2.1.1"

# Combined search
"nurse staffing theme:2.1 entity:ANA"

# Exclude terms
"prior authorization -deny"
```

## Available Tools

### listDockets
List all available regulation dockets with metadata.

### searchComments
Search comments with flexible query syntax and field selection.

Parameters:
- `docketId`: The full docket ID (e.g., "CMS-2025-0050-0031")
- `query`: Search query using the syntax above
- `searchFields`: Which fields to search (default: detailedContent)
- `returnType`: 'fields' or 'snippets' (default: snippets)
  - 'snippets': Returns text excerpts with ~800 chars of context
  - 'fields': Returns full field values (detailedContent by default)
- `returnFields`: Specific fields to return when using returnType: 'fields'
- `limit`: Maximum results (default: all results, no limit)
- `offset`: Pagination offset (default: 0)
- `sortBy`: 'relevance', 'date', or 'wordCount' (default: relevance)

### getComment
Retrieve detailed information from a single comment.

Parameters:
- `docketId`: The full docket ID
- `commentId`: The comment ID (e.g., "CMS-2025-0050-0123")
- `fields`: Optional - specific fields to return. If not specified, ALL content fields are returned including:
  - Full structured content (detailedContent, recommendations, concerns, etc.)
  - Theme scores
  - Metadata (submitter, date, location, etc.)
  - Note: Entities are excluded by default (too verbose - request explicitly if needed)

### listEntities
Get the entity taxonomy with mention counts.

Parameters:
- `docketId`: The full docket ID
- `category`: Optional - filter by specific category
- `minMentions`: Optional - only show entities with at least N mentions

Returns the entity taxonomy organized by categories. The specific categories and entities vary by docket based on the regulatory context.

### listThemes
Get the theme hierarchy with comment counts.

Parameters:
- `docketId`: The full docket ID
- `includeEmpty`: Include themes with no comments (default: false)
- `maxDepth`: Limit hierarchy depth (1 or 2)

Returns hierarchical theme structure with:
- Theme codes for use in searches (e.g., "2.1")
- Detailed guidelines for what each theme includes
- Comment counts per theme
- Suggestions for most discussed themes

### getThemeSummary
Get detailed analysis for a specific theme.

## Examples

```typescript
// Search for prior authorization concerns
await searchComments({
  docketId: "CMS-2025-0050-0031",
  query: "prior authorization entity:AMA",
  searchFields: {
    detailedContent: true,
    mainConcerns: true
  }
});

// Get theme analysis
await getThemeSummary({
  docketId: "CMS-2025-0050-0031",
  themeCode: "2.1"
});
```

## Development

```bash
# Build TypeScript
bun run build

# Run tests
bun test

# Development mode with auto-reload
bun run dev

# Enable listDockets tool (disabled by default)
ENABLE_LIST_DOCKETS=true bun start
```

## Architecture

The MCP server:
1. Fetches data from published JSON files
2. Implements client-side search with snippet extraction
3. Provides a unified query interface
4. Caches fetched data for performance
5. Supports pagination and field selection

See [DESIGN.md](./DESIGN.md) for detailed architecture documentation.