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
          detailedContent: 'We need better prior authorization processes for Medicare patients',
          oneLineSummary: 'Improve prior auth',
          corePosition: 'Support reform',
          keyRecommendations: ['Streamline processes', 'Reduce delays'],
          mainConcerns: ['Patient access', 'Administrative burden'],
          notableExperiences: ['Delayed treatment for 3 months'],
          keyQuotations: ['Prior auth is broken'],
          commenterProfile: 'Healthcare provider'
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
          detailedContent: 'Nurse staffing ratios are critical for patient safety',
          oneLineSummary: 'Support staffing ratios',
          corePosition: 'Mandate ratios',
          keyRecommendations: ['Set minimum ratios', 'Monitor compliance'],
          mainConcerns: ['Patient safety', 'Nurse burnout'],
          notableExperiences: ['Unsafe conditions due to understaffing'],
          keyQuotations: ['We need mandated ratios'],
          commenterProfile: 'Registered nurse'
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
          detailedContent: 'We should deny this proposal as it will harm patients',
          oneLineSummary: 'Oppose proposal',
          corePosition: 'Strong opposition',
          keyRecommendations: ['Reject proposal', 'Start over'],
          mainConcerns: ['Patient harm', 'Cost increases'],
          notableExperiences: [],
          keyQuotations: ['This will hurt vulnerable populations'],
          commenterProfile: 'Patient advocate'
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

  describe('searchComments', () => {
    it('should find comments by keywords', () => {
      const result = engine.searchComments(testComments, {
        query: {
          keywords: ['prior', 'authorization'],
          entities: [],
          themes: [],
          exclude: []
        }
      });

      expect(result.totalCount).toBe(1);
      expect(result.results[0].commentId).toBe('1');
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

    it('should search multiple fields', () => {
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

    it('should return snippets by default', () => {
      const result = engine.searchComments(testComments, {
        query: {
          keywords: ['prior', 'authorization'],
          entities: [],
          themes: [],
          exclude: []
        }
      });

      expect(result.results[0].snippets).toBeDefined();
      expect(result.results[0].snippets!.length).toBeGreaterThan(0);
      expect(result.results[0].snippets![0].field).toBe('detailedContent');
    });

    it('should return fields when requested', () => {
      const result = engine.searchComments(testComments, {
        query: {
          keywords: ['prior'],
          entities: [],
          themes: [],
          exclude: []
        },
        returnType: 'fields',
        returnFields: {
          detailedContent: true,
          keyRecommendations: true,
          themeScores: true
        }
      });

      expect(result.results[0].fields).toBeDefined();
      expect(result.results[0].fields!.detailedContent).toContain('prior authorization');
      expect(result.results[0].fields!.keyRecommendations).toHaveLength(2);
      expect(result.results[0].fields!.themeScores).toEqual({ '2.1': 1, '2.1.1': 1 });
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

    it('should handle comments with missing fields', () => {
      const incompleteComment: Comment = {
        id: '5',
        documentId: 'DOCKET-1',
        submitter: 'Test User',
        submitterType: 'Individual',
        date: '2024-01-05',
        location: 'Unknown',
        structuredSections: {
          detailedContent: 'Test content',
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
        wordCount: 0
      };

      const result = engine.searchComments([incompleteComment], {
        query: {
          keywords: ['test'],
          entities: [],
          themes: [],
          exclude: []
        },
        returnType: 'fields',
        returnFields: {
          detailedContent: true,
          submitter: true,
          keyRecommendations: true
        }
      });

      expect(result.totalCount).toBe(1);
      expect(result.results[0].fields!.detailedContent).toBe('Test content');
      expect(result.results[0].fields!.submitter).toBe('Test User');
      expect(result.results[0].fields!.keyRecommendations).toEqual([]);
    });
  });
});