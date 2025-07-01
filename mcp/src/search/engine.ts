import type { 
  Comment, 
  SearchQuery, 
  SearchResult, 
  SearchFields, 
  ReturnFields,
  EntityTaxonomy
} from '../data/types';
import { matchesQuery, extractSnippets } from './parser';

export interface SearchOptions {
  query: SearchQuery;
  searchFields?: SearchFields;
  returnType?: 'fields' | 'snippets';
  returnFields?: ReturnFields;
  limit?: number;
  offset?: number;
  sortBy?: 'date' | 'relevance' | 'wordCount';
  sortOrder?: 'asc' | 'desc';
}

export class SearchEngine {
  private entityMap: Map<string, { category: string; label: string }> = new Map();

  /**
   * Initialize the search engine with entity taxonomy for label resolution
   */
  setEntityTaxonomy(taxonomy: EntityTaxonomy) {
    this.entityMap.clear();
    
    // Iterate over categories in the taxonomy object
    for (const [category, entities] of Object.entries(taxonomy)) {
      for (const entity of entities) {
        // Store by lowercase label for case-insensitive matching
        this.entityMap.set(entity.label.toLowerCase(), {
          category: category,
          label: entity.label
        });
      }
    }
  }

  /**
   * Resolve entity labels to include categories
   */
  resolveEntities(query: SearchQuery): SearchQuery {
    const resolved = { ...query };
    
    resolved.entities = query.entities.map(entity => {
      if (entity.category) {
        return entity; // Already has category
      }
      
      // Look up in entity map
      const found = this.entityMap.get(entity.label.toLowerCase());
      if (found) {
        return found;
      }
      
      // Return as-is if not found
      return entity;
    });
    
    return resolved;
  }

  /**
   * Search comments with the given options
   */
  searchComments(comments: Comment[], options: SearchOptions): {
    results: SearchResult[];
    totalCount: number;
  } {
    const {
      query,
      searchFields = { detailedContent: true },
      returnType = 'snippets',
      returnFields = {},
      limit = Number.MAX_SAFE_INTEGER, // Default to all results
      offset = 0,
      sortBy = 'relevance',
      sortOrder = 'desc'
    } = options;

    // Resolve entities with categories
    const resolvedQuery = this.resolveEntities(query);

    // Filter comments
    const matches = comments.filter(comment => 
      this.matchesComment(comment, resolvedQuery, searchFields)
    );

    // Score and sort
    const scored = matches.map(comment => ({
      comment,
      score: this.scoreComment(comment, resolvedQuery, searchFields)
    }));

    // Sort by selected criteria
    this.sortResults(scored, sortBy, sortOrder);

    // Paginate
    const paginated = scored.slice(offset, offset + limit);

    // Format results
    const results = paginated.map(({ comment }) => 
      this.formatResult(comment, resolvedQuery, searchFields, returnType, returnFields)
    );

    return {
      results,
      totalCount: matches.length
    };
  }

  /**
   * Check if a comment matches the search criteria
   */
  private matchesComment(
    comment: Comment, 
    query: SearchQuery, 
    searchFields: SearchFields
  ): boolean {
    // Check text matching in specified fields
    const searchTexts = this.getSearchTexts(comment, searchFields);
    const combinedText = searchTexts.join(' ');
    
    if (!matchesQuery(combinedText, query)) {
      return false;
    }

    // Check entity filters
    if (query.entities.length > 0) {
      const hasRequiredEntities = query.entities.every(queryEntity => 
        comment.entities?.some(commentEntity => 
          commentEntity.category === queryEntity.category &&
          commentEntity.label.toLowerCase() === queryEntity.label.toLowerCase()
        )
      );
      
      if (!hasRequiredEntities) {
        return false;
      }
    }

    // Check theme filters
    if (query.themes.length > 0) {
      const hasRequiredThemes = query.themes.every(themeCode =>
        comment.themeScores && 
        comment.themeScores[themeCode] && 
        comment.themeScores[themeCode] > 0
      );
      
      if (!hasRequiredThemes) {
        return false;
      }
    }

    return true;
  }

  /**
   * Score a comment based on relevance to the query
   */
  private scoreComment(
    comment: Comment,
    query: SearchQuery,
    searchFields: SearchFields
  ): number {
    let score = 0;

    // Keyword frequency scoring
    const searchTexts = this.getSearchTexts(comment, searchFields);
    const combinedText = searchTexts.join(' ').toLowerCase();
    
    for (const keyword of query.keywords) {
      const regex = new RegExp(keyword.toLowerCase(), 'gi');
      const matches = combinedText.match(regex);
      score += matches ? matches.length : 0;
    }

    // Entity match bonus
    score += query.entities.filter(queryEntity =>
      comment.entities?.some(commentEntity =>
        commentEntity.category === queryEntity.category &&
        commentEntity.label.toLowerCase() === queryEntity.label.toLowerCase()
      )
    ).length * 5;

    // Theme relevance bonus
    for (const themeCode of query.themes) {
      if (comment.themeScores && comment.themeScores[themeCode]) {
        score += comment.themeScores[themeCode] * 3;
      }
    }

    return score;
  }

  /**
   * Get searchable text fields from a comment
   */
  private getSearchTexts(comment: Comment, searchFields: SearchFields): string[] {
    const texts: string[] = [];

    if (!comment.structuredSections) {
      // No structured content available
      return texts;
    }

    const s = comment.structuredSections;

    if (searchFields.detailedContent !== false && s.detailedContent) {
      texts.push(s.detailedContent);
    }
    if (searchFields.oneLineSummary && s.oneLineSummary) {
      texts.push(s.oneLineSummary);
    }
    if (searchFields.corePosition && s.corePosition) {
      texts.push(s.corePosition);
    }
    if (searchFields.keyRecommendations && s.keyRecommendations) {
      texts.push(...s.keyRecommendations);
    }
    if (searchFields.mainConcerns && s.mainConcerns) {
      texts.push(...s.mainConcerns);
    }
    if (searchFields.notableExperiences && s.notableExperiences) {
      texts.push(...s.notableExperiences);
    }
    if (searchFields.keyQuotations && s.keyQuotations) {
      texts.push(...s.keyQuotations);
    }

    return texts.filter(t => t && t.length > 0);
  }

  /**
   * Sort search results
   */
  private sortResults(
    results: Array<{ comment: Comment; score: number }>,
    sortBy: 'date' | 'relevance' | 'wordCount',
    sortOrder: 'asc' | 'desc'
  ) {
    const multiplier = sortOrder === 'asc' ? 1 : -1;

    results.sort((a, b) => {
      switch (sortBy) {
        case 'relevance':
          return (b.score - a.score) * multiplier;
        
        case 'date':
          const dateA = new Date(a.comment.date || 0).getTime();
          const dateB = new Date(b.comment.date || 0).getTime();
          return (dateA - dateB) * multiplier;
        
        case 'wordCount':
          const countA = a.comment.wordCount || 0;
          const countB = b.comment.wordCount || 0;
          return (countA - countB) * multiplier;
        
        default:
          return 0;
      }
    });
  }

  /**
   * Format a comment as a search result
   */
  private formatResult(
    comment: Comment,
    query: SearchQuery,
    searchFields: SearchFields,
    returnType: 'fields' | 'snippets',
    returnFields: ReturnFields
  ): SearchResult {
    const result: SearchResult = {
      commentId: comment.id,
      submitter: comment.submitter,
      submitterType: comment.submitterType,
      date: comment.date
    };

    if (returnType === 'snippets') {
      // Extract snippets from searched fields
      const snippets: SearchResult['snippets'] = [];
      const fieldTexts = this.getFieldTexts(comment, searchFields);

      for (const [field, text] of Object.entries(fieldTexts)) {
        const fieldSnippets = extractSnippets(text, query);
        
        for (const snippet of fieldSnippets) {
          snippets.push({
            field,
            text: snippet.text,
            matchStart: snippet.matchStart,
            matchEnd: snippet.matchEnd
          });
        }
      }

      result.snippets = snippets;
    } else {
      // Return requested fields
      result.fields = this.extractFields(comment, returnFields);
    }

    return result;
  }

  /**
   * Get field texts for snippet extraction
   */
  private getFieldTexts(
    comment: Comment, 
    searchFields: SearchFields
  ): Record<string, string> {
    const texts: Record<string, string> = {};

    if (!comment.structuredSections) {
      return texts;
    }

    const s = comment.structuredSections;

    if (searchFields.detailedContent !== false && s.detailedContent) {
      texts.detailedContent = s.detailedContent;
    }
    if (searchFields.oneLineSummary && s.oneLineSummary) {
      texts.oneLineSummary = s.oneLineSummary;
    }
    if (searchFields.corePosition && s.corePosition) {
      texts.corePosition = s.corePosition;
    }
    if (searchFields.keyRecommendations && s.keyRecommendations?.length) {
      texts.keyRecommendations = s.keyRecommendations.join(' ');
    }
    if (searchFields.mainConcerns && s.mainConcerns?.length) {
      texts.mainConcerns = s.mainConcerns.join(' ');
    }
    if (searchFields.notableExperiences && s.notableExperiences?.length) {
      texts.notableExperiences = s.notableExperiences.join(' ');
    }
    if (searchFields.keyQuotations && s.keyQuotations?.length) {
      texts.keyQuotations = s.keyQuotations.join(' ');
    }

    return texts;
  }

  /**
   * Extract requested fields from a comment
   */
  private extractFields(comment: Comment, fields: ReturnFields): Record<string, any> {
    const result: Record<string, any> = {};

    const s = comment.structuredSections;

    // If no fields specified, return detailedContent by default
    if (!fields || Object.keys(fields).length === 0) {
      if (s && s.detailedContent) {
        result.detailedContent = s.detailedContent;
      }
      return result;
    }

    // Otherwise return only requested fields
    if (fields.detailedContent && s) result.detailedContent = s.detailedContent;
    if (fields.oneLineSummary && s) result.oneLineSummary = s.oneLineSummary;
    if (fields.corePosition && s) result.corePosition = s.corePosition;
    if (fields.keyRecommendations && s) result.keyRecommendations = s.keyRecommendations;
    if (fields.mainConcerns && s) result.mainConcerns = s.mainConcerns;
    if (fields.notableExperiences && s) result.notableExperiences = s.notableExperiences;
    if (fields.keyQuotations && s) result.keyQuotations = s.keyQuotations;
    if (fields.commenterProfile && s) result.commenterProfile = s.commenterProfile;
    if (fields.submitter) result.submitter = comment.submitter;
    if (fields.submitterType) result.submitterType = comment.submitterType;
    if (fields.date) result.date = comment.date;
    if (fields.location) result.location = comment.location;
    if (fields.themeScores) result.themeScores = comment.themeScores;
    if (fields.entities) result.entities = comment.entities;
    if (fields.hasAttachments) result.hasAttachments = comment.hasAttachments;
    if (fields.wordCount) result.wordCount = comment.wordCount;

    return result;
  }
}