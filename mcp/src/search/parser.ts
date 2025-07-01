import { SearchQuery, KeywordExpression } from '../data/types';

/**
 * Parse a search query string into structured components
 * 
 * Syntax:
 * - Keywords: plain words or "quoted phrases"
 * - Boolean operators: AND (default), OR
 * - Entities: entity:label or entity:"quoted label"
 * - Themes: theme:code (e.g., theme:2.1)
 * - Exclusions: -word or -"quoted phrase"
 * 
 * Examples:
 * - "prior authorization" entity:CMS theme:2.1
 * - nurse staffing -shortage entity:"American Nurses Association"
 * - "prior auth" OR "preauthorization" 
 * - medicare AND advantage
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

  // First extract special tokens (entity:, theme:, exclusions)
  const { cleanQuery, entities, themes, excludes } = extractSpecialTokens(query);
  
  result.entities = entities;
  result.themes = themes;
  result.exclude = excludes;

  // Parse the remaining query for keywords with OR/AND
  if (cleanQuery.trim()) {
    const expression = parseKeywordExpression(cleanQuery);
    result.keywordExpression = expression;
    
    // Also populate legacy keywords array for backward compatibility
    result.keywords = extractAllTerms(expression);
  }

  return result;
}

/**
 * Extract entity:, theme:, and -exclusion tokens from query
 */
function extractSpecialTokens(query: string): {
  cleanQuery: string;
  entities: Array<{category: string; label: string}>;
  themes: string[];
  excludes: string[];
} {
  const entities: Array<{category: string; label: string}> = [];
  const themes: string[] = [];
  const excludes: string[] = [];
  
  // Tokenize preserving quotes
  const tokens = tokenizeQuery(query);
  const cleanTokens: string[] = [];
  
  for (const token of tokens) {
    if (token.startsWith('entity:') && token.length > 7) {
      entities.push({ category: '', label: token.slice(7) });
    } else if (token.startsWith('theme:') && token.length > 6) {
      themes.push(token.slice(6));
    } else if (token.startsWith('-') && token.length > 1) {
      excludes.push(token.slice(1));
    } else {
      cleanTokens.push(token);
    }
  }
  
  // Reconstruct clean query, preserving quotes for multi-word terms
  const cleanQuery = cleanTokens.map(token => 
    token.includes(' ') ? `"${token}"` : token
  ).join(' ');
  
  return { cleanQuery, entities, themes, excludes };
}

/**
 * Parse keyword expression with OR/AND support
 */
function parseKeywordExpression(query: string): KeywordExpression {
  // Remove outer parentheses if they exist
  query = query.trim();
  if (query.startsWith('(') && query.endsWith(')')) {
    query = query.slice(1, -1).trim();
  }
  
  // Split by OR first (lower precedence)
  const orParts = query.split(/\s+OR\s+/i);
  
  if (orParts.length > 1) {
    return {
      type: 'or',
      terms: orParts.map(part => parseAndExpression(part.trim()))
    };
  }
  
  return parseAndExpression(query);
}

/**
 * Parse AND expressions (higher precedence than OR)
 */
function parseAndExpression(query: string): KeywordExpression {
  // Split by explicit AND or implicit space
  const andParts = query.split(/\s+AND\s+/i);
  const allParts: string[] = [];
  
  for (const part of andParts) {
    // Further split by space for implicit AND
    const tokens = tokenizeQuery(part.trim());
    allParts.push(...tokens);
  }
  
  if (allParts.length === 0) {
    return { type: 'term', value: '' };
  }
  
  if (allParts.length === 1) {
    return { type: 'term', value: allParts[0] };
  }
  
  return {
    type: 'and',
    terms: allParts.map(term => ({ type: 'term', value: term }))
  };
}

/**
 * Extract all terms from expression tree (for backward compatibility)
 */
function extractAllTerms(expr: KeywordExpression): string[] {
  if (expr.type === 'term') {
    return expr.value ? [expr.value] : [];
  }
  
  const terms: string[] = [];
  for (const subExpr of expr.terms) {
    terms.push(...extractAllTerms(subExpr));
  }
  return terms;
}

/**
 * Tokenize a query string, handling quoted phrases
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
 * Check if a text matches a search query with OR/AND support
 */
export function matchesQuery(text: string, query: SearchQuery): boolean {
  const lowerText = text.toLowerCase();

  // Check exclusions first
  for (const exclude of query.exclude) {
    if (lowerText.includes(exclude.toLowerCase())) {
      return false;
    }
  }

  // Use new expression matching if available
  if (query.keywordExpression) {
    return matchesExpression(lowerText, query.keywordExpression);
  }
  
  // Fall back to legacy AND-only matching
  for (const keyword of query.keywords) {
    if (!lowerText.includes(keyword.toLowerCase())) {
      return false;
    }
  }

  return true;
}

/**
 * Evaluate keyword expression against text
 */
function matchesExpression(text: string, expr: KeywordExpression): boolean {
  switch (expr.type) {
    case 'term':
      return text.includes(expr.value.toLowerCase());
      
    case 'and':
      return expr.terms.every(term => matchesExpression(text, term));
      
    case 'or':
      return expr.terms.some(term => matchesExpression(text, term));
      
    default:
      return false;
  }
}

/**
 * Extract search snippets from text
 */
export function extractSnippets(
  text: string,
  query: SearchQuery,
  contextLength: number = 800
): Array<{ text: string; matchStart: number; matchEnd: number }> {
  type Match = { 
    originalStart: number; 
    originalEnd: number;
    contextStart: number;
    contextEnd: number;
  };
  
  const matches: Match[] = [];
  const lowerText = text.toLowerCase();
  
  // Get all terms to highlight
  const keywords = query.keywordExpression 
    ? extractAllTerms(query.keywordExpression)
    : query.keywords;

  // Find all keyword matches
  for (const keyword of keywords) {
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
      if (last.contextEnd >= match.contextStart) {
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