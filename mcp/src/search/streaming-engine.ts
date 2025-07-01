import type { 
  Comment, 
  SearchQuery, 
  SearchResult, 
  SearchFields, 
  ReturnFields,
  EntityTaxonomy
} from '../data/types';
import { matchesQuery, extractSnippets } from './parser';

/**
 * Streaming search engine that processes comments in chunks to avoid OOM
 */
export class StreamingSearchEngine {
  private entityMap: Map<string, { category: string; label: string }> = new Map();
  
  setEntityTaxonomy(taxonomy: EntityTaxonomy) {
    this.entityMap.clear();
    
    for (const [category, entities] of Object.entries(taxonomy)) {
      for (const entity of entities) {
        this.entityMap.set(entity.label.toLowerCase(), {
          category: category,
          label: entity.label
        });
      }
    }
  }

  resolveEntities(query: SearchQuery): SearchQuery {
    const resolved = { ...query };
    
    resolved.entities = query.entities.map(entity => {
      if (entity.category) {
        return entity;
      }
      
      const found = this.entityMap.get(entity.label.toLowerCase());
      if (found) {
        return found;
      }
      
      return entity;
    });
    
    return resolved;
  }

  /**
   * Process comments in chunks and yield results as they're found
   */
  async *searchCommentsStreaming(
    comments: Comment[],
    options: {
      query: SearchQuery;
      searchFields?: SearchFields;
      returnType?: 'fields' | 'snippets';
      returnFields?: ReturnFields;
      limit?: number;
      offset?: number;
      sortBy?: 'date' | 'relevance' | 'wordCount';
      sortOrder?: 'asc' | 'desc';
    }
  ): AsyncGenerator<{
    result?: SearchResult;
    progress?: { processed: number; total: number };
    done?: boolean;
  }> {
    const {
      query,
      searchFields = { detailedContent: true },
      returnType = 'snippets',
      returnFields = {},
      limit = Number.MAX_SAFE_INTEGER,
      offset = 0,
      sortBy = 'relevance',
      sortOrder = 'desc'
    } = options;

    const resolvedQuery = this.resolveEntities(query);
    const CHUNK_SIZE = 1000; // Process 1000 comments at a time
    
    let found = 0;
    let skipped = 0;
    let processed = 0;
    
    // For relevance sorting, we need to collect all results first
    // For date/wordCount, we can stream if the data is pre-sorted
    const needsFullScan = sortBy === 'relevance';
    const tempResults: Array<{ comment: Comment; score: number }> = [];
    
    for (let i = 0; i < comments.length; i += CHUNK_SIZE) {
      const chunk = comments.slice(i, Math.min(i + CHUNK_SIZE, comments.length));
      
      for (const comment of chunk) {
        processed++;
        
        if (!this.matchesComment(comment, resolvedQuery, searchFields)) {
          continue;
        }
        
        const score = this.scoreComment(comment, resolvedQuery, searchFields);
        
        if (needsFullScan) {
          tempResults.push({ comment, score });
        } else {
          // Can yield immediately for non-relevance sorting
          if (skipped < offset) {
            skipped++;
            continue;
          }
          
          if (found >= limit) {
            yield { done: true };
            return;
          }
          
          yield {
            result: this.formatResult(comment, resolvedQuery, searchFields, returnType, returnFields)
          };
          found++;
        }
      }
      
      // Yield progress update
      yield { progress: { processed, total: comments.length } };
    }
    
    // Handle relevance-sorted results
    if (needsFullScan) {
      this.sortResults(tempResults, sortBy, sortOrder);
      
      const paginated = tempResults.slice(offset, offset + limit);
      
      for (const { comment } of paginated) {
        yield {
          result: this.formatResult(comment, resolvedQuery, searchFields, returnType, returnFields)
        };
      }
    }
    
    yield { done: true };
  }

  // Include all the private methods from the original SearchEngine
  private matchesComment(
    comment: Comment, 
    query: SearchQuery, 
    searchFields: SearchFields
  ): boolean {
    const searchTexts = this.getSearchTexts(comment, searchFields);
    const combinedText = searchTexts.join(' ');
    
    if (!matchesQuery(combinedText, query)) {
      return false;
    }

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

  private scoreComment(
    comment: Comment,
    query: SearchQuery,
    searchFields: SearchFields
  ): number {
    let score = 0;

    const searchTexts = this.getSearchTexts(comment, searchFields);
    const combinedText = searchTexts.join(' ').toLowerCase();
    
    for (const keyword of query.keywords) {
      const regex = new RegExp(keyword.toLowerCase(), 'gi');
      const matches = combinedText.match(regex);
      score += matches ? matches.length : 0;
    }

    score += query.entities.filter(queryEntity =>
      comment.entities?.some(commentEntity =>
        commentEntity.category === queryEntity.category &&
        commentEntity.label.toLowerCase() === queryEntity.label.toLowerCase()
      )
    ).length * 5;

    for (const themeCode of query.themes) {
      if (comment.themeScores && comment.themeScores[themeCode]) {
        score += comment.themeScores[themeCode] * 3;
      }
    }

    return score;
  }

  private getSearchTexts(comment: Comment, searchFields: SearchFields): string[] {
    const texts: string[] = [];

    if (!comment.structuredSections) {
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
      result.fields = this.extractFields(comment, returnFields);
    }

    return result;
  }

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