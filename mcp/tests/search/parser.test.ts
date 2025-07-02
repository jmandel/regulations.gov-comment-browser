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
    expect(result.keywords).toEqual(['prior', 'authorization']);
    expect(result.keywordExpression).toEqual({
      type: 'and',
      terms: [
        { type: 'term', value: 'prior' },
        { type: 'term', value: 'authorization' }
      ]
    });
  });

  it('should parse quoted phrases', () => {
    const result = parseQuery('"prior authorization"');
    expect(result.keywords).toEqual(['prior authorization']);
    expect(result.keywordExpression).toEqual({
      type: 'term',
      value: 'prior authorization'
    });
  });

  it('should parse OR queries', () => {
    const result = parseQuery('medicare OR medicaid');
    expect(result.keywords).toEqual(['medicare', 'medicaid']);
    expect(result.keywordExpression).toEqual({
      type: 'or',
      terms: [
        { type: 'term', value: 'medicare' },
        { type: 'term', value: 'medicaid' }
      ]
    });
  });

  it('should parse explicit AND queries', () => {
    const result = parseQuery('medicare AND advantage');
    expect(result.keywords).toEqual(['medicare', 'advantage']);
    expect(result.keywordExpression).toEqual({
      type: 'and',
      terms: [
        { type: 'term', value: 'medicare' },
        { type: 'term', value: 'advantage' }
      ]
    });
  });

  it('should parse complex OR/AND queries', () => {
    const result = parseQuery('"prior auth" OR preauthorization');
    expect(result.keywords).toEqual(['prior auth', 'preauthorization']);
    expect(result.keywordExpression).toEqual({
      type: 'or',
      terms: [
        { type: 'term', value: 'prior auth' },
        { type: 'term', value: 'preauthorization' }
      ]
    });
  });

  it('should handle OR with multiple terms', () => {
    const result = parseQuery('nurse staffing OR "nurse ratios" OR "staffing levels"');
    expect(result.keywords).toEqual(['nurse', 'staffing', 'nurse ratios', 'staffing levels']);
    expect(result.keywordExpression).toEqual({
      type: 'or',
      terms: [
        {
          type: 'and',
          terms: [
            { type: 'term', value: 'nurse' },
            { type: 'term', value: 'staffing' }
          ]
        },
        { type: 'term', value: 'nurse ratios' },
        { type: 'term', value: 'staffing levels' }
      ]
    });
  });

  it('should parse entity references', () => {
    const result = parseQuery('entity:CMS entity:"American Medical Association"');
    expect(result).toEqual({
      keywords: [],
      keywordExpression: undefined,
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
      keywordExpression: undefined,
      entities: [],
      themes: ['2.1', '2.1.1'],
      exclude: []
    });
  });

  it('should parse exclusions', () => {
    const result = parseQuery('prior -deny -"coverage gap"');
    expect(result.keywords).toEqual(['prior']);
    expect(result.entities).toEqual([]);
    expect(result.themes).toEqual([]);
    expect(result.exclude).toEqual(['deny', 'coverage gap']);
  });

  it('should parse complex queries with OR and filters', () => {
    const result = parseQuery('"prior authorization" OR preauth entity:CMS theme:2.1 -deny');
    expect(result.keywords).toEqual(['prior authorization', 'preauth']);
    expect(result.keywordExpression).toEqual({
      type: 'or',
      terms: [
        { type: 'term', value: 'prior authorization' },
        { type: 'term', value: 'preauth' }
      ]
    });
    expect(result.entities).toEqual([{ category: '', label: 'CMS' }]);
    expect(result.themes).toEqual(['2.1']);
    expect(result.exclude).toEqual(['deny']);
  });

  it('should handle empty queries', () => {
    expect(parseQuery('')).toEqual({
      keywords: [],
      keywordExpression: undefined,
      entities: [],
      themes: [],
      exclude: []
    });
  });

  it('should handle queries with regex special characters', () => {
    const result = parseQuery('"test (with parens)" OR "test [brackets]" OR test.dot');
    expect(result.keywords).toEqual(['test (with parens)', 'test [brackets]', 'test.dot']);
    expect(result.keywordExpression).toEqual({
      type: 'or',
      terms: [
        { type: 'term', value: 'test (with parens)' },
        { type: 'term', value: 'test [brackets]' },
        { type: 'term', value: 'test.dot' }
      ]
    });
  });
});

describe('matchesQuery', () => {
  it('should match simple keywords', () => {
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

  it('should match OR queries', () => {
    const query = parseQuery('medicare OR medicaid');
    expect(matchesQuery('This applies to Medicare patients', query)).toBe(true);
    expect(matchesQuery('This applies to Medicaid patients', query)).toBe(true);
    expect(matchesQuery('This applies to private insurance', query)).toBe(false);
    expect(matchesQuery('Both Medicare and Medicaid are covered', query)).toBe(true);
  });

  it('should match explicit AND queries', () => {
    const query = parseQuery('medicare AND advantage');
    expect(matchesQuery('Medicare Advantage plans are popular', query)).toBe(true);
    expect(matchesQuery('Traditional Medicare is different', query)).toBe(false);
    expect(matchesQuery('The advantage of Medicare is clear', query)).toBe(true);
  });

  it('should match complex OR expressions', () => {
    const query = parseQuery('"prior auth" OR "pre-authorization" OR preauth');
    expect(matchesQuery('We need prior auth approval', query)).toBe(true);
    expect(matchesQuery('Submit for pre-authorization', query)).toBe(true);
    expect(matchesQuery('The preauth process is simple', query)).toBe(true);
    expect(matchesQuery('Authorization is required', query)).toBe(false);
  });

  it('should handle exclusions', () => {
    const query = parseQuery('prior -deny');
    expect(matchesQuery('We need prior authorization', query)).toBe(true);
    expect(matchesQuery('We deny prior authorization', query)).toBe(false);
  });

  it('should handle exclusions with OR', () => {
    const query = parseQuery('(medicare OR medicaid) -deny');
    expect(matchesQuery('Medicare coverage is available', query)).toBe(true);
    expect(matchesQuery('We deny Medicare claims', query)).toBe(false);
    expect(matchesQuery('Medicaid benefits explained', query)).toBe(true);
    expect(matchesQuery('Medicaid deny reasons', query)).toBe(false);
  });

  it('should require all keywords in implicit AND', () => {
    const query = parseQuery('nurse staffing ratios');
    expect(matchesQuery('Nurse staffing ratios are important', query)).toBe(true);
    expect(matchesQuery('Staffing ratios for nurses matter', query)).toBe(true);
    expect(matchesQuery('Nurse staffing is important', query)).toBe(false);
  });

  it('should be case insensitive', () => {
    const query = parseQuery('PRIOR authorization');
    expect(matchesQuery('prior AUTHORIZATION needed', query)).toBe(true);
  });

  it('should handle regex special characters in search', () => {
    const query1 = parseQuery('"test (with parens)"');
    expect(matchesQuery('This is a test (with parens) here', query1)).toBe(true);
    expect(matchesQuery('This is a test without parens here', query1)).toBe(false);
    
    const query2 = parseQuery('file.txt OR config[prod]');
    expect(matchesQuery('Found file.txt in directory', query2)).toBe(true);
    expect(matchesQuery('Using config[prod] settings', query2)).toBe(true);
    expect(matchesQuery('No match here', query2)).toBe(false);
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

  it('should extract snippets for OR queries', () => {
    const text = 'Medicare patients have different needs than Medicaid patients.';
    const query = parseQuery('medicare OR medicaid');
    const snippets = extractSnippets(text, query, 15);
    
    expect(snippets.length).toBeGreaterThanOrEqual(1);
    // Should capture both terms if context windows overlap
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

  it('should handle empty results', () => {
    const text = 'No matches here';
    const query = parseQuery('missing');
    const snippets = extractSnippets(text, query);
    
    expect(snippets).toHaveLength(0);
  });
});