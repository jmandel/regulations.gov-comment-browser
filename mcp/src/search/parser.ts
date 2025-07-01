import { SearchQuery } from '../data/types';

/**
 * Parse a search query string into structured components
 * 
 * Syntax:
 * - Keywords: plain words or "quoted phrases"
 * - Entities: entity:label or entity:"quoted label"
 * - Themes: theme:code (e.g., theme:2.1)
 * - Exclusions: -word or -"quoted phrase"
 * 
 * Examples:
 * - "prior authorization" entity:CMS theme:2.1
 * - nurse staffing -shortage entity:"American Nurses Association"
 */
export function parseQuery(query: string): SearchQuery {
  const result: SearchQuery = {
    keywords: [],
    entities: [],
    themes: [],
    exclude: []
  };

  if (!query || query.trim().length === 0) {
    return result;
  }

  // Tokenize the query, preserving quoted strings
  const tokens = tokenizeQuery(query);

  for (const token of tokens) {
    if (token.startsWith('entity:') && token.length > 7) {
      const label = token.slice(7);
      // Note: We'll need to resolve the category later from the entity taxonomy
      result.entities.push({ category: '', label });
    } else if (token.startsWith('theme:') && token.length > 6) {
      const code = token.slice(6);
      result.themes.push(code);
    } else if (token.startsWith('-') && token.length > 1) {
      const term = token.slice(1);
      result.exclude.push(term);
    } else {
      result.keywords.push(token);
    }
  }

  return result;
}

/**
 * Tokenize a query string, handling quoted phrases and special prefixes
 */
export function tokenizeQuery(query: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;
  let i = 0;

  while (i < query.length) {
    const char = query[i];
    
    if (char === '"') {
      inQuotes = !inQuotes;
      i++;
      continue;
    }
    
    if (char === ' ' && !inQuotes) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      i++;
      continue;
    }
    
    current += char;
    i++;
  }
  
  if (current) {
    tokens.push(current);
  }
  
  return tokens;
}

/**
 * Check if a text matches a search query
 */
export function matchesQuery(text: string, query: SearchQuery): boolean {
  const lowerText = text.toLowerCase();

  // Check exclusions first
  for (const exclude of query.exclude) {
    if (lowerText.includes(exclude.toLowerCase())) {
      return false;
    }
  }

  // Check keywords (all must match)
  for (const keyword of query.keywords) {
    if (!lowerText.includes(keyword.toLowerCase())) {
      return false;
    }
  }

  // Entity and theme matching would be done at a higher level
  // This function just handles text matching
  return true;
}

/**
 * Extract search snippets from text
 */
export function extractSnippets(
  text: string,
  query: SearchQuery,
  contextLength: number = 800  // Increased 8x from 100
): Array<{ text: string; matchStart: number; matchEnd: number }> {
  type Match = { 
    originalStart: number; 
    originalEnd: number;
    contextStart: number;
    contextEnd: number;
  };
  
  const matches: Match[] = [];
  const lowerText = text.toLowerCase();

  // Find all keyword matches
  for (const keyword of query.keywords) {
    const lowerKeyword = keyword.toLowerCase();
    let index = 0;

    while ((index = lowerText.indexOf(lowerKeyword, index)) !== -1) {
      matches.push({
        originalStart: index,
        originalEnd: index + keyword.length,
        contextStart: Math.max(0, index - contextLength),
        contextEnd: Math.min(text.length, index + keyword.length + contextLength)
      });

      index += keyword.length;
    }
  }

  // Sort by original position
  matches.sort((a, b) => a.originalStart - b.originalStart);

  // Merge overlapping contexts
  const merged: Match[] = [];
  for (const match of matches) {
    if (merged.length === 0) {
      merged.push(match);
    } else {
      const last = merged[merged.length - 1];
      // Check if contexts overlap
      if (last.contextEnd >= match.contextStart) {
        // Merge by extending the context
        last.contextEnd = Math.max(last.contextEnd, match.contextEnd);
        last.originalEnd = Math.max(last.originalEnd, match.originalEnd);
      } else {
        merged.push(match);
      }
    }
  }

  // Convert to snippets
  return merged.map(match => ({
    text: text.substring(match.contextStart, match.contextEnd),
    matchStart: match.originalStart - match.contextStart,
    matchEnd: match.originalEnd - match.contextStart
  }));
}