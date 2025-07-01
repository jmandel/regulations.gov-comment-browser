import { describe, it, expect } from 'bun:test';
import { parseQuery, tokenizeQuery, matchesQuery, extractSnippets } from '../../src/search/parser';

describe('tokenizeQuery', () => {
  it('should handle simple keywords', () => {
    expect(tokenizeQuery('prior authorization')).toEqual(['prior', 'authorization']);
  });

  it('should handle quoted phrases', () => {
    expect(tokenizeQuery('"prior authorization" nurse')).toEqual(['prior authorization', 'nurse']);
  });

  it('should handle entity references', () => {
    expect(tokenizeQuery('entity:CMS')).toEqual(['entity:CMS']);
  });

  it('should handle quoted entity references', () => {
    expect(tokenizeQuery('entity:"Centers for Medicare"')).toEqual(['entity:Centers for Medicare']);
  });

  it('should handle theme references', () => {
    expect(tokenizeQuery('theme:2.1')).toEqual(['theme:2.1']);
    expect(tokenizeQuery('theme:2.1.1')).toEqual(['theme:2.1.1']);
  });

  it('should handle exclusions', () => {
    expect(tokenizeQuery('-deny')).toEqual(['-deny']);
    expect(tokenizeQuery('-"deny coverage"')).toEqual(['-deny coverage']);
  });

  it('should handle complex queries', () => {
    const query = '"prior authorization" entity:CMS theme:2.1 -deny nurse';
    expect(tokenizeQuery(query)).toEqual([
      'prior authorization',
      'entity:CMS',
      'theme:2.1',
      '-deny',
      'nurse'
    ]);
  });

  it('should handle empty strings', () => {
    expect(tokenizeQuery('')).toEqual([]);
    expect(tokenizeQuery('   ')).toEqual([]);
  });

  it('should handle special characters in quotes', () => {
    expect(tokenizeQuery('"entity:test" "theme:2.1"')).toEqual(['entity:test', 'theme:2.1']);
  });
});

describe('parseQuery', () => {
  it('should parse simple keywords', () => {
    const result = parseQuery('prior authorization');
    expect(result).toEqual({
      keywords: ['prior', 'authorization'],
      entities: [],
      themes: [],
      exclude: []
    });
  });

  it('should parse quoted phrases', () => {
    const result = parseQuery('"prior authorization"');
    expect(result).toEqual({
      keywords: ['prior authorization'],
      entities: [],
      themes: [],
      exclude: []
    });
  });

  it('should parse entity references', () => {
    const result = parseQuery('entity:CMS entity:"American Medical Association"');
    expect(result).toEqual({
      keywords: [],
      entities: [
        { category: '', label: 'CMS' },
        { category: '', label: 'American Medical Association' }
      ],
      themes: [],
      exclude: []
    });
  });

  it('should parse theme references', () => {
    const result = parseQuery('theme:2.1 theme:2.1.1');
    expect(result).toEqual({
      keywords: [],
      entities: [],
      themes: ['2.1', '2.1.1'],
      exclude: []
    });
  });

  it('should parse exclusions', () => {
    const result = parseQuery('prior -deny -"coverage gap"');
    expect(result).toEqual({
      keywords: ['prior'],
      entities: [],
      themes: [],
      exclude: ['deny', 'coverage gap']
    });
  });

  it('should parse complex queries', () => {
    const result = parseQuery('"prior authorization" entity:CMS theme:2.1 -deny nurse staffing');
    expect(result).toEqual({
      keywords: ['prior authorization', 'nurse', 'staffing'],
      entities: [{ category: '', label: 'CMS' }],
      themes: ['2.1'],
      exclude: ['deny']
    });
  });

  it('should handle empty queries', () => {
    expect(parseQuery('')).toEqual({
      keywords: [],
      entities: [],
      themes: [],
      exclude: []
    });
    expect(parseQuery('   ')).toEqual({
      keywords: [],
      entities: [],
      themes: [],
      exclude: []
    });
  });

  it('should ignore empty entity/theme values', () => {
    const result = parseQuery('entity: theme: keyword');
    expect(result).toEqual({
      keywords: ['entity:', 'theme:', 'keyword'],
      entities: [],
      themes: [],
      exclude: []
    });
  });
});

describe('matchesQuery', () => {
  it('should match keywords', () => {
    const query = parseQuery('prior authorization');
    expect(matchesQuery('We need prior authorization for this procedure', query)).toBe(true);
    expect(matchesQuery('We need authorization prior to the procedure', query)).toBe(true);
    expect(matchesQuery('We need approval for this procedure', query)).toBe(false);
  });

  it('should match quoted phrases', () => {
    const query = parseQuery('"prior authorization"');
    expect(matchesQuery('We need prior authorization for this', query)).toBe(true);
    expect(matchesQuery('We need PRIOR AUTHORIZATION for this', query)).toBe(true);
    expect(matchesQuery('We need authorization prior to this', query)).toBe(false);
  });

  it('should handle exclusions', () => {
    const query = parseQuery('prior -deny');
    expect(matchesQuery('We need prior authorization', query)).toBe(true);
    expect(matchesQuery('We deny prior authorization', query)).toBe(false);
    expect(matchesQuery('Prior auth should not be denied', query)).toBe(true); // "denied" doesn't contain "deny"
    expect(matchesQuery('They will deny the prior auth', query)).toBe(false); // "deny" is excluded
  });

  it('should require all keywords', () => {
    const query = parseQuery('nurse staffing ratios');
    expect(matchesQuery('Nurse staffing ratios are important', query)).toBe(true);
    expect(matchesQuery('Staffing ratios for nurses matter', query)).toBe(true);
    expect(matchesQuery('Nurse staffing is important', query)).toBe(false);
  });

  it('should be case insensitive', () => {
    const query = parseQuery('PRIOR authorization');
    expect(matchesQuery('prior AUTHORIZATION needed', query)).toBe(true);
  });
});

describe('extractSnippets', () => {
  it('should extract single keyword snippet', () => {
    const text = 'The patient needs prior authorization before we can proceed with the treatment.';
    const query = parseQuery('prior');
    const snippets = extractSnippets(text, query, 20);
    
    expect(snippets).toHaveLength(1);
    expect(snippets[0].text).toContain('prior');
    expect(snippets[0].matchStart).toBeGreaterThan(0);
    expect(snippets[0].matchEnd).toBeGreaterThan(snippets[0].matchStart);
  });

  it('should extract multiple keyword occurrences', () => {
    const text = 'Prior authorization is needed. The prior auth process is complex.';
    const query = parseQuery('prior');
    const snippets = extractSnippets(text, query, 10);
    
    expect(snippets.length).toBeGreaterThanOrEqual(2);
  });

  it('should merge overlapping snippets', () => {
    const text = 'We need prior authorization and prior approval for this.';
    const query = parseQuery('prior authorization');
    const snippets = extractSnippets(text, query, 15);
    
    // Should merge the overlapping contexts
    expect(snippets).toHaveLength(1);
    expect(snippets[0].text).toContain('prior authorization');
    expect(snippets[0].text).toContain('prior approval');
  });

  it('should respect context length', () => {
    const text = 'x'.repeat(50) + 'keyword' + 'y'.repeat(50);
    const query = parseQuery('keyword');
    const snippets = extractSnippets(text, query, 10);
    
    expect(snippets[0].text.length).toBeLessThanOrEqual(27); // keyword(7) + 2*10
  });

  it('should handle text boundaries', () => {
    const text = 'keyword at start';
    const query = parseQuery('keyword');
    const snippets = extractSnippets(text, query, 10);
    
    expect(snippets[0].matchStart).toBe(0);
    expect(snippets[0].text).toBe('keyword at start');
  });

  it('should handle empty results', () => {
    const text = 'No matches here';
    const query = parseQuery('missing');
    const snippets = extractSnippets(text, query);
    
    expect(snippets).toHaveLength(0);
  });
});