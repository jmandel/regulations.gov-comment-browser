# Regulations Browser MCP Server - Design Document

## Overview

This MCP server provides programmatic access to public comments on regulatory proposals. It fetches data from published JSON files and implements client-side search, entity resolution, and theme analysis.

## Architecture

### Core Components

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   MCP Client    │────▶│   MCP Server     │────▶│ Published Data  │
│  (Claude, etc)  │     │  (Express/HTTP)  │     │  (JSON files)   │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                               │
                        ┌──────┴──────┬───────────┐
                        │             │           │
                   ┌────▼────┐  ┌────▼────┐ ┌───▼────┐
                   │  Tools  │  │ Search  │ │ Cache  │
                   │         │  │ Engine  │ │        │
                   └─────────┘  └─────────┘ └────────┘
```

### Data Flow

1. **Client Request**: MCP client sends tool request
2. **Server Processing**: Server validates and routes to appropriate handler
3. **Data Fetching**: Handler fetches required JSON from published site (with caching)
4. **Search/Filter**: Apply query filters and extract relevant data
5. **Response**: Return structured response to client

### Key Design Decisions

1. **Stateless HTTP**: Each request creates new server instance for isolation
2. **Client-Side Search**: All search logic implemented in MCP server (not relying on backend search)
3. **Lazy Loading**: Only fetch data files as needed
4. **Smart Caching**: Cache fetched JSON with TTL
5. **Unified Query Syntax**: Single query language for all search operations

## Implementation Plan

### Phase 1: Core Infrastructure ✅ TODO

1. **Setup Project Structure**
   ```
   mcp/
   ├── src/
   │   ├── index.ts          # Express server entry point
   │   ├── server.ts         # MCP server implementation
   │   ├── tools/            # Tool implementations
   │   │   ├── listDockets.ts
   │   │   ├── searchComments.ts
   │   │   ├── getComment.ts
   │   │   ├── listEntities.ts
   │   │   ├── listThemes.ts
   │   │   └── getThemeSummary.ts
   │   ├── search/           # Search engine
   │   │   ├── parser.ts     # Query parser
   │   │   ├── engine.ts     # Search implementation
   │   │   └── snippets.ts   # Snippet extraction
   │   ├── data/             # Data layer
   │   │   ├── fetcher.ts    # Fetch from published site
   │   │   ├── cache.ts      # Caching layer
   │   │   └── types.ts      # TypeScript types
   │   └── utils/
   │       └── logger.ts
   ├── tests/
   ├── package.json
   ├── tsconfig.json
   └── .env.example
   ```

2. **Dependencies**
   - `@modelcontextprotocol/sdk`: MCP SDK
   - `express`: HTTP server
   - `node-fetch`: Fetch JSON data
   - `lru-cache`: Caching
   - TypeScript toolchain

### Phase 2: Data Layer 📋 TODO

1. **Type Definitions** (from existing codebase)
   - [ ] Copy/adapt types from main codebase
   - [ ] Ensure compatibility with published JSON format

2. **Data Fetcher**
   - [ ] Implement fetch with retry logic
   - [ ] Handle base URL configuration
   - [ ] Add request timeout handling
   - [ ] Implement error handling for 404s

3. **Cache Layer**
   - [ ] LRU cache with configurable size
   - [ ] TTL-based expiration (default: 15 minutes)
   - [ ] Cache key generation from URL
   - [ ] Cache stats for monitoring

### Phase 3: Search Engine 🔍 TODO

1. **Query Parser**
   - [ ] Tokenize query string
   - [ ] Extract entity: references
   - [ ] Extract theme: references
   - [ ] Handle quoted phrases
   - [ ] Support negation (-term)

2. **Search Implementation**
   - [ ] Text search with ranking
   - [ ] Entity filtering
   - [ ] Theme filtering
   - [ ] Field selection
   - [ ] Pagination support

3. **Snippet Extraction**
   - [ ] Find matches in text
   - [ ] Extract context windows
   - [ ] Highlight matches
   - [ ] Rank by relevance

### Phase 4: MCP Tools 🛠️ TODO

1. **listDockets**
   - [ ] Fetch available dockets (hardcoded for now)
   - [ ] Return metadata

2. **searchComments**
   - [ ] Parse query
   - [ ] Fetch comments.json
   - [ ] Apply search filters
   - [ ] Return results with snippets/fields

3. **getComment**
   - [ ] Fetch single comment
   - [ ] Apply field selection
   - [ ] Return structured data

4. **listEntities**
   - [ ] Fetch entities.json
   - [ ] Filter by category
   - [ ] Apply min mentions filter

5. **listThemes**
   - [ ] Fetch themes.json
   - [ ] Build hierarchy
   - [ ] Include comment counts

6. **getThemeSummary**
   - [ ] Fetch theme-summaries.json
   - [ ] Return specific theme data

### Phase 5: Server Setup 🚀 TODO

1. **Express Server**
   - [ ] Stateless HTTP endpoint
   - [ ] Request/response handling
   - [ ] Error handling middleware
   - [ ] CORS configuration

2. **MCP Integration**
   - [ ] Create server instance per request
   - [ ] Register all tools
   - [ ] Handle transport lifecycle

3. **Configuration**
   - [ ] Environment variables
   - [ ] Base URL configuration
   - [ ] Port configuration
   - [ ] Cache settings

### Phase 6: Testing & Documentation 📚 TODO

1. **Unit Tests**
   - [ ] Query parser tests
   - [ ] Search engine tests
   - [ ] Tool implementation tests

2. **Integration Tests**
   - [ ] End-to-end MCP requests
   - [ ] Error scenarios
   - [ ] Performance tests

3. **Documentation**
   - [ ] API examples
   - [ ] Configuration guide
   - [ ] Deployment instructions

## Performance Considerations

1. **Caching Strategy**
   - Cache all fetched JSON files
   - Implement cache warming for common queries
   - Monitor cache hit rates

2. **Search Optimization**
   - Build indexes on first search
   - Use efficient string matching algorithms
   - Implement early termination for large result sets

3. **Memory Management**
   - Limit cache size
   - Stream large responses
   - Implement request timeouts

## Security Considerations

1. **Input Validation**
   - Sanitize query inputs
   - Validate docket IDs
   - Limit request sizes

2. **Rate Limiting**
   - Consider implementing rate limits
   - Monitor for abuse patterns

## Future Enhancements

1. **Advanced Search**
   - Boolean operators (AND, OR)
   - Proximity search
   - Fuzzy matching

2. **Analytics**
   - Track popular queries
   - Monitor performance metrics
   - Usage statistics

3. **Optimization**
   - Pre-computed indexes
   - Background cache warming
   - WebSocket support for real-time updates