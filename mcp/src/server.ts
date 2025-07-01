import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DataFetcher } from './data/fetcher';
import { SearchEngine } from './search/engine';
import { parseQuery } from './search/parser';
import type { 
  Comment, 
  Theme, 
  Entity, 
  SearchFields, 
  ReturnFields,
  DocketMeta
} from './data/types';


export function createServer() {
  const server = new McpServer({
    name: 'regulations.gov-comment-browser',
    version: '1.0.0',
  });

  const fetcher = new DataFetcher();
  const searchEngine = new SearchEngine();

  // Feature flag for listing dockets (disabled by default)
  const ENABLE_LIST_DOCKETS = process.env.ENABLE_LIST_DOCKETS === 'true';

  // Register tools
  if (ENABLE_LIST_DOCKETS) {
    server.registerTool(
      'listDockets',
      {
      title: 'List Available Dockets',
      description: `List all available regulation dockets with metadata.
    
This tool returns information about federal regulations open for public comment that have been processed and analyzed. Each docket includes:
- id: The official docket identifier (e.g., "CMS-2025-0050-0031")
- title: The regulation's title
- agency: The sponsoring agency (e.g., CMS, EPA)
- commentCount: Number of public comments received
- lastUpdated: When the analysis was last updated
- status: Always "published" for available dockets

Use this tool first to discover what regulations are available to search and analyze.`,
      inputSchema: {},
    },
    async () => {
      try {
        const dockets = await fetcher.listDockets();
        
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              dockets: dockets.map(d => ({
                id: d.documentId,
                documentId: d.documentId,
                generatedAt: d.generatedAt,
                totalComments: d.stats.totalComments,
                condensedComments: d.stats.condensedComments,
                scoredComments: d.stats.scoredComments,
                totalThemes: d.stats.totalThemes,
                status: 'published'
              }))
            }, null, 2)
          }]
        };
      } catch (error) {
        throw new Error(`Failed to list dockets: ${error}`);
      }
    }
    );
  }

  server.registerTool(
    'searchComments',
    {
      title: 'Search Comments',
      description: `Search through public comments using a powerful query syntax with keywords, entities, and themes.

QUERY SYNTAX:
- Keywords: Use plain words or "quoted phrases" to search comment text
  Examples: prior authorization, "nurse staffing", medicare
  
- Entity filters: Use entity:label to find comments mentioning specific organizations
  Examples: entity:CMS, entity:"American Medical Association", entity:ANA
  Note: Entity labels are case-insensitive
  
- Theme filters: Use theme:code to find comments tagged with specific themes
  Examples: theme:2.1, theme:3.1.2
  Note: Use listThemes first to discover available theme codes
  
- Exclusions: Use -term to exclude comments containing specific words
  Examples: -deny, -"not support"
  
- Combinations: All filters use AND logic
  Example: "prior authorization" entity:AMA theme:2.1 -deny
  This finds comments about prior authorization from the AMA on theme 2.1 that don't contain "deny"

SEARCH FIELDS:
By default, searches the detailed content. You can search specific fields:
- detailedContent: Full comment text (default: true)
- oneLineSummary: Brief summary
- corePosition: Main stance
- keyRecommendations: Specific suggestions
- mainConcerns: Primary worries
- notableExperiences: Personal stories
- keyQuotations: Important quotes

RETURN OPTIONS:
- returnType: "snippets" (default) shows text excerpts with matches highlighted
- returnType: "fields" returns full field values
- limit: Number of results (default: all results, no limit)
- sortBy: "relevance" (default), "date", or "wordCount"

TIPS:
1. Start broad, then narrow with filters
2. Use entity: to find comments from specific organizations
3. Use theme: to focus on particular topics
4. Review theme hierarchy with listThemes first
5. Check entity taxonomy with listEntities for available organizations`,
      inputSchema: {
        docketId: z.string().describe('The full docket ID (e.g., "CMS-2025-0050-0031")'),
        query: z.string().describe('Search query using keywords, entity:label, and theme:code syntax'),
        searchFields: z.object({
          detailedContent: z.boolean().optional(),
          oneLineSummary: z.boolean().optional(),
          corePosition: z.boolean().optional(),
          keyRecommendations: z.boolean().optional(),
          mainConcerns: z.boolean().optional(),
          notableExperiences: z.boolean().optional(),
          keyQuotations: z.boolean().optional(),
        }).optional().describe('Which fields to search in'),
        returnType: z.enum(['fields', 'snippets']).optional().describe('Return full fields or text snippets'),
        returnFields: z.object({
          detailedContent: z.boolean().optional(),
          oneLineSummary: z.boolean().optional(),
          corePosition: z.boolean().optional(),
          keyRecommendations: z.boolean().optional(),
          mainConcerns: z.boolean().optional(),
          notableExperiences: z.boolean().optional(),
          keyQuotations: z.boolean().optional(),
          commenterProfile: z.boolean().optional(),
          submitter: z.boolean().optional(),
          submitterType: z.boolean().optional(),
          date: z.boolean().optional(),
          location: z.boolean().optional(),
          themeScores: z.boolean().optional(),
          entities: z.boolean().optional(),
          hasAttachments: z.boolean().optional(),
          wordCount: z.boolean().optional(),
        }).optional().describe('Which fields to return when returnType is "fields"'),
        limit: z.number().optional().describe('Maximum number of results (default: all)'),
        offset: z.number().optional().describe('Offset for pagination (default: 0)'),
        sortBy: z.enum(['date', 'relevance', 'wordCount']).optional().describe('Sort criteria'),
        sortOrder: z.enum(['asc', 'desc']).optional().describe('Sort order'),
      },
    },
    async (params) => {
      try {
        // Fetch data
        const [comments, entities] = await Promise.all([
          fetcher.getComments(params.docketId),
          fetcher.getEntities(params.docketId)
        ]);

        // Set up search engine with entity taxonomy
        searchEngine.setEntityTaxonomy(entities);

        // Parse query
        const parsedQuery = parseQuery(params.query);

        // Search
        const results = searchEngine.searchComments(comments, {
          query: parsedQuery,
          searchFields: params.searchFields || { detailedContent: true },
          returnType: params.returnType || 'snippets',
          returnFields: params.returnFields,
          limit: params.limit || Number.MAX_SAFE_INTEGER, // Default to all results
          offset: params.offset || 0,
          sortBy: params.sortBy || 'relevance',
          sortOrder: params.sortOrder || 'desc'
        });

        // Get docket metadata
        const meta = await fetcher.getDocketMeta(params.docketId);
        
        // Generate follow-up suggestions
        const suggestions = [];
        
        // Only suggest pagination if a limit was explicitly set and there are more results
        if (params.limit && results.totalCount > params.limit) {
          const nextOffset = (params.offset || 0) + params.limit;
          suggestions.push(`Found ${results.totalCount} total results. To see next page, add offset: ${nextOffset}`);
        }
        
        if (params.returnType !== 'fields' && results.results.length > 0) {
          suggestions.push('To get full comment text, re-run with returnType: "fields" and returnFields: {detailedContent: true}');
          const sampleIds = results.results.slice(0, 3).map(r => r.commentId).join('", "');
          suggestions.push(`Or use getComment for specific comments: "${sampleIds}"`);
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              docketInfo: {
                documentId: meta.documentId,
                totalComments: meta.stats.totalComments,
                totalThemes: meta.stats.totalThemes,
                totalEntities: meta.stats.totalEntities
              },
              searchResults: {
                totalFound: results.totalCount,
                returned: results.results.length,
                offset: params.offset || 0,
                limit: params.limit || 'all'
              },
              results: results.results,
              query: {
                keywords: parsedQuery.keywords,
                entities: parsedQuery.entities,
                themes: parsedQuery.themes,
                exclude: parsedQuery.exclude
              },
              suggestions
            }, null, 2)
          }]
        };
      } catch (error) {
        throw new Error(`Search failed: ${error}`);
      }
    }
  );

  server.registerTool(
    'getComment',
    {
      title: 'Get Comment Details',
      description: `Retrieve detailed information about a specific comment by its ID.

This tool fetches a single comment with all available fields or just the fields you specify. Use this when:
- You found an interesting comment via search and want full details
- You need specific fields like recommendations or concerns from a known comment
- You want to analyze a comment's theme scores or entity mentions

AVAILABLE FIELDS:
- detailedContent: Full comment text
- oneLineSummary: Brief one-line summary
- corePosition: The commenter's main position/stance
- keyRecommendations: List of specific recommendations
- mainConcerns: List of primary concerns raised
- notableExperiences: Personal experiences or case studies mentioned
- keyQuotations: Important quotes extracted
- commenterProfile: Background info about the commenter
- submitter: Name of person/organization
- submitterType: Category (e.g., Physician, Patient, Organization)
- date: Submission date
- location: Geographic location
- themeScores: Object mapping theme codes to relevance scores (1-3)
- entities: List of mentioned organizations with categories
- hasAttachments: Whether comment included attachments
- wordCount: Length of comment

If no fields are specified, all available fields are returned (except entities).

EXAMPLE USAGE:
1. Get everything: getComment(docketId, commentId)
2. Get just recommendations: getComment(docketId, commentId, {keyRecommendations: true})
3. Get summary and themes: getComment(docketId, commentId, {oneLineSummary: true, themeScores: true})`,
      inputSchema: {
        docketId: z.string().describe('The full docket ID (e.g., "CMS-2025-0050-0031")'),
        commentId: z.string().describe('The comment ID'),
        fields: z.object({
          detailedContent: z.boolean().optional(),
          oneLineSummary: z.boolean().optional(),
          corePosition: z.boolean().optional(),
          keyRecommendations: z.boolean().optional(),
          mainConcerns: z.boolean().optional(),
          notableExperiences: z.boolean().optional(),
          keyQuotations: z.boolean().optional(),
          commenterProfile: z.boolean().optional(),
          submitter: z.boolean().optional(),
          submitterType: z.boolean().optional(),
          date: z.boolean().optional(),
          location: z.boolean().optional(),
          themeScores: z.boolean().optional(),
          entities: z.boolean().optional(),
          hasAttachments: z.boolean().optional(),
          wordCount: z.boolean().optional(),
        }).optional().describe('Which fields to return (all if not specified)'),
      },
    },
    async (params) => {
      try {
        const comments = await fetcher.getComments(params.docketId);
        const comment = comments.find(c => c.id === params.commentId);

        if (!comment) {
          throw new Error(`Comment ${params.commentId} not found`);
        }

        // Extract requested fields
        const result: any = {
          commentId: comment.id,
          submitter: comment.submitter,
          submitterType: comment.submitterType,
          date: comment.date,
          location: comment.location
        };

        // Add requested fields
        if (!params.fields || Object.keys(params.fields).length === 0) {
          // Return ALL fields when none specified (full detailed content)
          if (comment.structuredSections) {
            result.detailedContent = comment.structuredSections.detailedContent;
            result.oneLineSummary = comment.structuredSections.oneLineSummary;
            result.corePosition = comment.structuredSections.corePosition;
            result.keyRecommendations = comment.structuredSections.keyRecommendations;
            result.mainConcerns = comment.structuredSections.mainConcerns;
            result.notableExperiences = comment.structuredSections.notableExperiences;
            result.keyQuotations = comment.structuredSections.keyQuotations;
            result.commenterProfile = comment.structuredSections.commenterProfile;
          }
          result.themeScores = comment.themeScores;
          // Don't include entities by default - they're verbose and redundant
          result.wordCount = comment.wordCount;
          result.hasAttachments = comment.hasAttachments;
        } else {
          // Return only requested fields
          const s = comment.structuredSections;
          if (params.fields.detailedContent && s) {
            result.detailedContent = s.detailedContent;
          }
          if (params.fields.oneLineSummary && s) result.oneLineSummary = s.oneLineSummary;
          if (params.fields.corePosition && s) result.corePosition = s.corePosition;
          if (params.fields.keyRecommendations && s) result.keyRecommendations = s.keyRecommendations;
          if (params.fields.mainConcerns && s) result.mainConcerns = s.mainConcerns;
          if (params.fields.notableExperiences && s) result.notableExperiences = s.notableExperiences;
          if (params.fields.keyQuotations && s) result.keyQuotations = s.keyQuotations;
          if (params.fields.commenterProfile && s) result.commenterProfile = s.commenterProfile;
          if (params.fields.location) result.location = comment.location;
          if (params.fields.themeScores) result.themeScores = comment.themeScores;
          if (params.fields.entities) result.entities = comment.entities;
          if (params.fields.hasAttachments) result.hasAttachments = comment.hasAttachments;
          if (params.fields.wordCount) result.wordCount = comment.wordCount;
        }

        // Get docket metadata
        const meta = await fetcher.getDocketMeta(params.docketId);
        
        // Generate suggestions
        const suggestions = [];
        
        if (comment.themeScores && Object.keys(comment.themeScores).length > 0) {
          const topThemes = Object.entries(comment.themeScores)
            .sort(([,a], [,b]) => b - a)
            .slice(0, 3)
            .map(([code]) => code);
          suggestions.push(`This comment relates to themes: ${topThemes.join(', ')}. Use getThemeSummary for analysis.`);
        }
        
        // Don't suggest entities - they're better for searching than displaying
        
        if (!params.fields || Object.keys(params.fields).length === 0) {
          suggestions.push('All fields returned. Specify fields parameter to get only specific data.');
        }
        
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              docketInfo: {
                documentId: meta.documentId,
                totalComments: meta.stats.totalComments
              },
              comment: result,
              suggestions
            }, null, 2)
          }]
        };
      } catch (error) {
        throw new Error(`Failed to get comment: ${error}`);
      }
    }
  );

  server.registerTool(
    'listEntities',
    {
      title: 'List Entity Taxonomy',
      description: `Explore the taxonomy of organizations, agencies, and stakeholders mentioned in comments.

This tool returns a hierarchical list of entities (organizations, agencies, etc.) that have been identified in the comments, organized by category. Each entity includes how many times it was mentioned.

The entity taxonomy organizes all named entities mentioned in comments into categories. Each docket has its own unique set of entities and categories based on the specific regulatory context.

USE THIS TOOL TO:
1. Discover which organizations are participating in the comment process
2. Find the exact entity labels to use with entity: filters in searchComments
3. Identify major stakeholders by mention count
4. Understand the landscape of commenters

FILTERING OPTIONS:
- category: Filter to a specific category (e.g., "Healthcare Organizations")
- minMentions: Only show entities mentioned at least N times

TIPS:
- High mention counts indicate major stakeholders
- Use exact entity labels from this list in your entity: search filters
- Entity matching is case-insensitive in searches
- Some comments may mention multiple entities`,
      inputSchema: {
        docketId: z.string().describe('The full docket ID (e.g., "CMS-2025-0050-0031")'),
        category: z.string().optional().describe('Filter by entity category'),
        minMentions: z.number().optional().describe('Minimum mention count'),
      },
    },
    async (params) => {
      try {
        const entities = await fetcher.getEntities(params.docketId);
        
        // Get docket metadata
        const meta = await fetcher.getDocketMeta(params.docketId);
        
        // Filter entities
        let filteredEntities = { ...entities };
        
        // Filter by category if specified
        if (params.category) {
          const matchingCategory = Object.keys(entities).find(cat => 
            cat.toLowerCase() === params.category!.toLowerCase()
          );
          filteredEntities = matchingCategory ? { [matchingCategory]: entities[matchingCategory] } : {};
        }

        // Filter by minimum mentions if specified
        if (params.minMentions) {
          for (const [category, entityList] of Object.entries(filteredEntities)) {
            filteredEntities[category] = entityList.filter(e => e.mentionCount >= params.minMentions!);
          }
          // Remove empty categories
          Object.keys(filteredEntities).forEach(cat => {
            if (filteredEntities[cat].length === 0) delete filteredEntities[cat];
          });
        }

        const totalEntities = Object.values(filteredEntities).reduce((sum, list) => sum + list.length, 0);
        
        // Generate suggestions
        const suggestions = [];
        if (params.minMentions && params.minMentions > 1) {
          suggestions.push('To see all entities, remove the minMentions filter');
        }
        if (!params.category) {
          suggestions.push('Filter by specific category to focus on particular stakeholder types');
        }
        suggestions.push('Use entity labels in searchComments with entity:"Label" syntax (case-insensitive)');
        
        // Find most mentioned entities
        const topEntities = Object.values(filteredEntities)
          .flat()
          .sort((a, b) => b.mentionCount - a.mentionCount)
          .slice(0, 3);
        
        if (topEntities.length > 0) {
          suggestions.push(`Most mentioned: ${topEntities.map(e => `${e.label} (${e.mentionCount})`).join(', ')}`);
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              docketInfo: {
                documentId: meta.documentId,
                totalComments: meta.stats.totalComments,
                totalEntities: meta.stats.totalEntities
              },
              entities: filteredEntities,
              totalReturned: totalEntities,
              suggestions
            }, null, 2)
          }]
        };
      } catch (error) {
        throw new Error(`Failed to list entities: ${error}`);
      }
    }
  );

  server.registerTool(
    'listThemes',
    {
      title: 'List Theme Hierarchy',
      description: `Explore the hierarchical theme taxonomy used to categorize and analyze comments.

This tool returns the complete theme hierarchy showing how comments have been categorized into major themes and sub-themes. Each theme includes:
- code: The theme identifier (e.g., "2.1", "3.1.2") used in theme: filters
- name: Human-readable theme name
- guidelines: What types of content belong in this theme
- commentCount: Number of comments tagged with this theme
- children: Sub-themes under this theme

THEME STRUCTURE:
Themes are organized hierarchically (up to 2 levels deep):
- Level 1: Major topic areas (e.g., "2. Prior Authorization")
- Level 2: Specific aspects (e.g., "2.1 Administrative Burden")

USE THIS TOOL TO:
1. Understand the major topics being discussed
2. Find theme codes for use with theme: filters in searchComments
3. Identify which themes have the most comments
4. Explore the analytical framework used to categorize comments

FILTERING OPTIONS:
- includeEmpty: Set to true to see themes with zero comments
- maxDepth: Limit hierarchy depth (1 or 2)

WORKING WITH THEMES:
- Comments can be tagged with multiple themes
- Theme scores range from 1-3 (1=mentioned, 2=significant, 3=primary focus)
- Use theme codes in searchComments like: theme:2.1
- Themes represent mutually exclusive and collectively exhaustive (MECE) categories

TIPS:
1. Review themes before searching to understand the topic landscape
2. High comment counts indicate hot-button issues
3. Use parent themes (e.g., theme:2) to search broadly
4. Use child themes (e.g., theme:2.1) for specific aspects`,
      inputSchema: {
        docketId: z.string().describe('The full docket ID (e.g., "CMS-2025-0050-0031")'),
        includeEmpty: z.boolean().optional().describe('Include themes with no comments'),
        maxDepth: z.number().optional().describe('Maximum depth of theme hierarchy'),
      },
    },
    async (params) => {
      try {
        const themes = await fetcher.getThemes(params.docketId);
        
        // Build a map for quick theme lookup
        const themeMap = new Map<string, Theme>();
        themes.forEach(theme => themeMap.set(theme.code, theme));

        // Filter and process themes
        const processTheme = (theme: Theme, depth: number = 0): Theme | null => {
          // Check depth limit
          if (params.maxDepth && depth >= params.maxDepth) {
            return { ...theme, children: [] };
          }

          // Filter out empty themes if requested
          if (!params.includeEmpty && (!theme.comment_count || theme.comment_count === 0)) {
            return null;
          }

          // Process children (they are strings, need to look up actual Theme objects)
          const processedChildCodes: string[] = [];
          for (const childCode of theme.children) {
            const childTheme = themeMap.get(childCode);
            if (childTheme) {
              const processed = processTheme(childTheme, depth + 1);
              if (processed !== null) {
                processedChildCodes.push(childCode);
              }
            }
          }

          return { ...theme, children: processedChildCodes };
        };

        // Only process top-level themes (those without parent_code)
        const processedThemes = themes
          .filter(theme => !theme.parent_code)
          .map(theme => processTheme(theme))
          .filter(theme => theme !== null) as Theme[];

        // Get docket metadata
        const meta = await fetcher.getDocketMeta(params.docketId);
        
        // Count themes
        const totalThemes = themes.length;
        const themesWithComments = themes.filter(t => t.comment_count > 0).length;
        
        // Generate suggestions
        const suggestions = [];
        if (!params.includeEmpty) {
          suggestions.push('Set includeEmpty: true to see all themes in the taxonomy');
        }
        suggestions.push('Use theme codes in searchComments with theme:CODE syntax');
        suggestions.push('Use getThemeSummary for detailed analysis of specific themes');
        
        // Find most discussed themes
        const topThemes = themes
          .filter(t => t.comment_count > 0)
          .sort((a, b) => b.comment_count - a.comment_count)
          .slice(0, 3);
        
        if (topThemes.length > 0) {
          suggestions.push(`Most discussed themes: ${topThemes.map(t => `${t.code} (${t.comment_count} comments)`).join(', ')}`);
        }
        
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              docketInfo: {
                documentId: meta.documentId,
                totalComments: meta.stats.totalComments,
                totalThemes: totalThemes,
                themesWithComments: themesWithComments
              },
              themes: processedThemes,
              suggestions
            }, null, 2)
          }]
        };
      } catch (error) {
        throw new Error(`Failed to list themes: ${error}`);
      }
    }
  );

  server.registerTool(
    'getThemeSummary',
    {
      title: 'Get Theme Summary',
      description: `Get comprehensive AI-generated analysis and summary for a specific theme.

This tool provides deep insights into all comments related to a particular theme, including:

SUMMARY SECTIONS:
1. Overview: High-level synthesis of the theme
2. Key Positions: Major stances with supporting points and comment counts
3. Major Concerns: Primary issues raised with specific problems and affected groups
4. Recommendations: Concrete suggestions with rationale and support levels
5. Stakeholder Perspectives: Views from different groups (patients, providers, payers)
6. Notable Insights: Unique or particularly important points

UNDERSTANDING THE ANALYSIS:
- Positions show the main arguments and how many comments support each
- Concerns identify specific problems and who is affected
- Recommendations are rated by support level: Strong/Moderate/Limited
- Stakeholder sentiment is categorized: Positive/Negative/Mixed/Neutral
- All sections reference representative comment counts

USE THIS TOOL WHEN YOU NEED TO:
1. Understand the full scope of discussion on a topic
2. Identify consensus positions and major disagreements
3. Find specific recommendations from commenters
4. Understand different stakeholder perspectives
5. Get quantitative backing for qualitative insights

WORKFLOW TIPS:
1. Use listThemes first to find theme codes and comment counts
2. Focus on themes with high comment counts for richer summaries
3. Compare parent and child theme summaries for different granularity
4. Cross-reference with searchComments to find specific examples

EXAMPLE THEMES (codes vary by regulation):
- "2.1"
- "3.2" 
- "4.1"

The summaries are generated through systematic analysis of all comments tagged with the theme, providing both quantitative and qualitative insights.`,
      inputSchema: {
        docketId: z.string().describe('The full docket ID (e.g., "CMS-2025-0050-0031")'),
        themeCode: z.string().describe('The theme code (e.g., "2.1")'),
      },
    },
    async (params) => {
      try {
        const summaries = await fetcher.getThemeSummaries(params.docketId);
        const summary = summaries[params.themeCode];

        if (!summary) {
          throw new Error(`Theme summary for ${params.themeCode} not found`);
        }

        // Format the summary to match the expected structure
        const formattedSummary = {
          themeCode: params.themeCode,
          themeName: summary.themeDescription,
          commentCount: summary.commentCount,
          wordCount: summary.wordCount,
          lastUpdated: new Date().toISOString(), // Not in the data, using current time
          summary: summary.sections
        };

        // Get docket metadata
        const meta = await fetcher.getDocketMeta(params.docketId);
        
        // Generate suggestions based on summary content
        const suggestions = [];
        
        if (summary.sections?.recommendations?.length > 0) {
          suggestions.push('Search for specific recommendations using keywords from this summary');
        }
        
        if (summary.sections?.stakeholder_perspectives?.length > 0) {
          const stakeholders = summary.sections.stakeholder_perspectives.map(s => s.stakeholder_group).slice(0, 3);
          suggestions.push(`Search comments from specific stakeholders: ${stakeholders.join(', ')}`);
        }
        
        suggestions.push(`Use searchComments with theme:${params.themeCode} to find all related comments`);
        suggestions.push('Compare with parent/child theme summaries for different levels of detail');
        
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              docketInfo: {
                documentId: meta.documentId,
                totalComments: meta.stats.totalComments
              },
              themeSummary: formattedSummary,
              suggestions
            }, null, 2)
          }]
        };
      } catch (error) {
        throw new Error(`Failed to get theme summary: ${error}`);
      }
    }
  );

  // Note: McpServer doesn't have the same resource registration API as the low-level Server
  // Resources would need to be handled differently or through tools

  return server;
}
