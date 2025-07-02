import { describe, it, expect, beforeEach } from 'bun:test';
import { SearchEngine } from '../../src/search/engine';
import type { Comment, EntityTaxonomy, SearchQuery } from '../../src/data/types';

describe('SearchEngine', () => {
  let engine: SearchEngine;
  let testComments: Comment[];
  let testTaxonomy: EntityTaxonomy;

  beforeEach(() => {
    engine = new SearchEngine();
    
    testTaxonomy = {
      'Healthcare Organizations': [
        { 
          label: 'CMS', 
          definition: 'Centers for Medicare and Medicaid Services',
          terms: ['CMS', 'Centers for Medicare'],
          mentionCount: 100 
        },
        { 
          label: 'AMA', 
          definition: 'American Medical Association',
          terms: ['AMA', 'American Medical Association'],
          mentionCount: 50 
        }
      ],
      'Government Agencies': [
        { 
          label: 'Medicare', 
          definition: 'Federal health insurance program',
          terms: ['Medicare'],
          mentionCount: 200 
        }
      ]
    };

    testComments = [
      {
        id: '1',
        documentId: 'DOCKET-1',
        submitter: 'Dr. Smith',
        submitterType: 'Physician',
        date: '2024-01-01',
        location: 'NY',
        structuredSections: {
          detailedContent: 'We need better prior authorization processes for Medicare patients. The current system causes significant delays in patient care.',
          oneLineSummary: 'Improve prior auth for Medicare patients',
          corePosition: 'Support reform',
          keyRecommendations: ['Streamline processes', 'Reduce delays'],
          mainConcerns: ['Patient access', 'Administrative burden'],
          notableExperiences: ['Delayed treatment for 3 months'],
          keyQuotations: ['Prior auth is broken', 'Patients suffer from delays'],
          commenterProfile: 'Healthcare provider with 20 years experience'
        },
        entities: [
          { category: 'Government Agencies', label: 'Medicare' },
          { category: 'Healthcare Organizations', label: 'CMS' }
        ],
        themeScores: {
          '2.1': 1,
          '2.1.1': 1
        },
        hasAttachments: false,
        wordCount: 100
      },
      {
        id: '2',
        documentId: 'DOCKET-1',
        submitter: 'Jane Doe',
        submitterType: 'Nurse',
        date: '2024-01-02',
        location: 'CA',
        structuredSections: {
          detailedContent: 'Nurse staffing ratios are critical for patient safety. Without adequate staffing, nurses experience burnout and patients receive substandard care.',
          oneLineSummary: 'Support mandated nurse staffing ratios',
          corePosition: 'Mandate ratios',
          keyRecommendations: ['Set minimum ratios', 'Monitor compliance'],
          mainConcerns: ['Patient safety', 'Nurse burnout'],
          notableExperiences: ['Unsafe conditions due to understaffing'],
          keyQuotations: ['We need mandated ratios', 'Patient safety depends on staffing'],
          commenterProfile: 'Registered nurse in acute care'
        },
        entities: [
          { category: 'Healthcare Organizations', label: 'AMA' }
        ],
        themeScores: {
          '3.1': 1,
          '3.2': 1
        },
        hasAttachments: false,
        wordCount: 150
      },
      {
        id: '3',
        documentId: 'DOCKET-1',
        submitter: 'John Public',
        submitterType: 'Individual',
        date: '2024-01-03',
        location: 'TX',
        structuredSections: {
          detailedContent: 'We should deny this proposal as it will harm patients and increase costs for everyone involved.',
          oneLineSummary: 'Oppose proposal due to patient harm',
          corePosition: 'Strong opposition',
          keyRecommendations: ['Reject proposal', 'Start over'],
          mainConcerns: ['Patient harm', 'Cost increases'],
          notableExperiences: [],
          keyQuotations: ['This will hurt vulnerable populations'],
          commenterProfile: 'Patient advocate and caregiver'
        },
        entities: [],
        themeScores: {
          '1.1': 1
        },
        hasAttachments: false,
        wordCount: 75
      }
    ];

    engine.setEntityTaxonomy(testTaxonomy);
  });

  describe('entity resolution', () => {
    it('should resolve entity labels to categories', () => {
      const query: SearchQuery = {
        keywords: [],
        entities: [{ category: '', label: 'CMS' }],
        themes: [],
        exclude: []
      };

      const resolved = engine.resolveEntities(query);
      
      expect(resolved.entities[0].category).toBe('Healthcare Organizations');
      expect(resolved.entities[0].label).toBe('CMS');
    });

    it('should handle case-insensitive entity matching', () => {
      const query: SearchQuery = {
        keywords: [],
        entities: [{ category: '', label: 'cms' }],
        themes: [],
        exclude: []
      };

      const resolved = engine.resolveEntities(query);
      
      expect(resolved.entities[0].category).toBe('Healthcare Organizations');
      expect(resolved.entities[0].label).toBe('CMS');
    });

    it('should keep unknown entities as-is', () => {
      const query: SearchQuery = {
        keywords: [],
        entities: [{ category: '', label: 'Unknown Org' }],
        themes: [],
        exclude: []
      };

      const resolved = engine.resolveEntities(query);
      
      expect(resolved.entities[0].category).toBe('');
      expect(resolved.entities[0].label).toBe('Unknown Org');
    });
  });

  describe('searchComments with new consistent format', () => {
    it('should always return overview fields', () => {
      const result = engine.searchComments(testComments, {
        query: {
          keywords: ['prior', 'authorization'],
          entities: [],
          themes: [],
          exclude: []
        }
      });

      expect(result.totalCount).toBe(1);
      const firstResult = result.results[0];
      
      // Check basic fields always present
      expect(firstResult.commentId).toBe('1');
      expect(firstResult.submitter).toBe('Dr. Smith');
      expect(firstResult.submitterType).toBe('Physician');
      expect(firstResult.date).toBe('2024-01-01');
      
      // Check overview fields
      expect(firstResult.fields).toBeDefined();
      expect(firstResult.fields!.oneLineSummary).toBe('Improve prior auth for Medicare patients');
      expect(firstResult.fields!.commenterProfile).toBe('Healthcare provider with 20 years experience');
      expect(firstResult.fields!.keyQuotations).toEqual(['Prior auth is broken', 'Patients suffer from delays']);
      
      // Check context snippet
      expect(firstResult.fields!.contextSnippet).toBeDefined();
      expect(firstResult.fields!.contextSnippet).toContain('prior authorization');
    });

    it('should find comments by keywords', () => {
      const result = engine.searchComments(testComments, {
        query: {
          keywords: ['staffing', 'ratios'],
          entities: [],
          themes: [],
          exclude: []
        }
      });

      expect(result.totalCount).toBe(1);
      expect(result.results[0].commentId).toBe('2');
      expect(result.results[0].fields!.contextSnippet).toContain('staffing ratios');
    });

    it('should exclude comments with excluded terms', () => {
      const result = engine.searchComments(testComments, {
        query: {
          keywords: ['proposal'],
          entities: [],
          themes: [],
          exclude: ['deny']
        }
      });

      expect(result.totalCount).toBe(0);
    });

    it('should filter by entities', () => {
      const result = engine.searchComments(testComments, {
        query: {
          keywords: [],
          entities: [{ category: 'Healthcare Organizations', label: 'CMS' }],
          themes: [],
          exclude: []
        }
      });

      expect(result.totalCount).toBe(1);
      expect(result.results[0].commentId).toBe('1');
    });

    it('should filter by themes', () => {
      const result = engine.searchComments(testComments, {
        query: {
          keywords: [],
          entities: [],
          themes: ['3.1'],
          exclude: []
        }
      });

      expect(result.totalCount).toBe(1);
      expect(result.results[0].commentId).toBe('2');
    });

    it('should combine filters with AND logic', () => {
      const result = engine.searchComments(testComments, {
        query: {
          keywords: ['prior'],
          entities: [{ category: 'Government Agencies', label: 'Medicare' }],
          themes: ['2.1'],
          exclude: []
        }
      });

      expect(result.totalCount).toBe(1);
      expect(result.results[0].commentId).toBe('1');
    });

    it('should search multiple fields when specified', () => {
      const result = engine.searchComments(testComments, {
        query: {
          keywords: ['burnout'],
          entities: [],
          themes: [],
          exclude: []
        },
        searchFields: {
          detailedContent: true,
          mainConcerns: true
        }
      });

      expect(result.totalCount).toBe(1);
      expect(result.results[0].commentId).toBe('2');
    });

    it('should handle pagination', () => {
      const result1 = engine.searchComments(testComments, {
        query: { keywords: [], entities: [], themes: [], exclude: [] },
        limit: 2,
        offset: 0
      });

      const result2 = engine.searchComments(testComments, {
        query: { keywords: [], entities: [], themes: [], exclude: [] },
        limit: 2,
        offset: 2
      });

      expect(result1.results).toHaveLength(2);
      expect(result2.results).toHaveLength(1);
      expect(result1.totalCount).toBe(3);
      expect(result2.totalCount).toBe(3);
    });

    it('should sort by date', () => {
      const result = engine.searchComments(testComments, {
        query: { keywords: [], entities: [], themes: [], exclude: [] },
        sortBy: 'date',
        sortOrder: 'desc'
      });

      expect(result.results[0].commentId).toBe('3');
      expect(result.results[1].commentId).toBe('2');
      expect(result.results[2].commentId).toBe('1');
    });

    it('should sort by word count', () => {
      const result = engine.searchComments(testComments, {
        query: { keywords: [], entities: [], themes: [], exclude: [] },
        sortBy: 'wordCount',
        sortOrder: 'desc'
      });

      expect(result.results[0].commentId).toBe('2'); // 150 words
      expect(result.results[1].commentId).toBe('1'); // 100 words
      expect(result.results[2].commentId).toBe('3'); // 75 words
    });

    it('should score by relevance', () => {
      const result = engine.searchComments(testComments, {
        query: {
          keywords: ['prior'],
          entities: [{ category: 'Healthcare Organizations', label: 'CMS' }],
          themes: ['2.1'],
          exclude: []
        },
        sortBy: 'relevance'
      });

      // Comment 1 should score highest due to keyword, entity, and theme matches
      expect(result.results[0].commentId).toBe('1');
    });

    it('should handle comments without keywords in contextSnippet', () => {
      const result = engine.searchComments(testComments, {
        query: {
          keywords: [],
          entities: [{ category: 'Healthcare Organizations', label: 'AMA' }],
          themes: [],
          exclude: []
        }
      });

      expect(result.totalCount).toBe(1);
      expect(result.results[0].commentId).toBe('2');
      // No keywords, so no context snippet
      expect(result.results[0].fields!.contextSnippet).toBeUndefined();
    });
  });

  describe('regex special characters handling', () => {
    it('should handle regex special characters in scoring', () => {
      const specialCharComment: Comment = {
        id: '6',
        documentId: 'DOCKET-1',
        submitter: 'Test User',
        submitterType: 'Individual',
        date: '2024-01-06',
        location: 'CA',
        structuredSections: {
          detailedContent: 'This discusses TEFCA (trusted exchange framework) and config[prod].json file',
          oneLineSummary: 'TEFCA and config discussion',
          keyQuotations: ['TEFCA (trusted exchange framework)', 'config[prod].json']
        },
        entities: [],
        themeScores: {},
        hasAttachments: false,
        wordCount: 50
      };

      // Test parentheses don't break regex
      const result1 = engine.searchComments([specialCharComment], {
        query: {
          keywords: ['TEFCA (trusted exchange framework)'],
          entities: [],
          themes: [],
          exclude: []
        }
      });
      expect(result1.totalCount).toBe(1);

      // Test brackets don't break regex  
      const result2 = engine.searchComments([specialCharComment], {
        query: {
          keywords: ['config[prod]'],
          entities: [],
          themes: [],
          exclude: []
        }
      });
      expect(result2.totalCount).toBe(1);

      // Test dots don't break regex
      const result3 = engine.searchComments([specialCharComment], {
        query: {
          keywords: ['config[prod].json'],
          entities: [],
          themes: [],
          exclude: []
        }
      });
      expect(result3.totalCount).toBe(1);
    });
  });

  describe('edge cases', () => {
    it('should handle comments without structured sections', () => {
      const rawComment: Comment = {
        id: '4',
        documentId: 'DOCKET-1',
        submitter: 'Anonymous',
        submitterType: 'Individual',
        date: '2024-01-04',
        location: '',
        structuredSections: null,
        entities: [],
        themeScores: {},
        hasAttachments: false,
        wordCount: 0
      };

      const result = engine.searchComments([rawComment], {
        query: {
          keywords: ['test'],
          entities: [],
          themes: [],
          exclude: []
        }
      });

      expect(result.totalCount).toBe(0); // No text to search
      expect(result.results).toHaveLength(0);
    });

    it('should handle empty search results', () => {
      const result = engine.searchComments(testComments, {
        query: {
          keywords: ['nonexistent'],
          entities: [],
          themes: [],
          exclude: []
        }
      });

      expect(result.totalCount).toBe(0);
      expect(result.results).toHaveLength(0);
    });

    it('should handle comments with missing overview fields', () => {
      const incompleteComment: Comment = {
        id: '5',
        documentId: 'DOCKET-1',
        submitter: 'Test User',
        submitterType: 'Individual',
        date: '2024-01-05',
        location: 'Unknown',
        structuredSections: {
          detailedContent: 'Test content with important information',
          oneLineSummary: '',
          corePosition: '',
          keyRecommendations: [],
          mainConcerns: [],
          notableExperiences: [],
          keyQuotations: [],
          commenterProfile: ''
        },
        entities: [],
        themeScores: {},
        hasAttachments: false,
        wordCount: 10
      };

      const result = engine.searchComments([incompleteComment], {
        query: {
          keywords: ['test'],
          entities: [],
          themes: [],
          exclude: []
        }
      });

      expect(result.totalCount).toBe(1);
      
      // Basic fields should still be present
      expect(result.results[0].submitter).toBe('Test User');
      expect(result.results[0].submitterType).toBe('Individual');
      
      // Empty string fields should not be included
      expect(result.results[0].fields!.oneLineSummary).toBeUndefined();
      expect(result.results[0].fields!.commenterProfile).toBeUndefined();
      // Empty array for keyQuotations is still included
      expect(result.results[0].fields!.keyQuotations).toEqual([]);
      
      // Context snippet should still work
      expect(result.results[0].fields!.contextSnippet).toContain('Test content');
    });
  });
});