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
  // Create singleton instances inside createServer to allow mocking in tests
  const fetcher = new DataFetcher();
  const searchEngine = new SearchEngine();
  const server = new McpServer({
    name: 'regulations.gov-comment-browser',
    version: '1.0.0',
  });

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
      description: `Search through public comments to access rich, nuanced perspectives from healthcare stakeholders.

IMPORTANT: The default returnType="fields" provides access to various data fields, but NOT ALL FIELDS ARE EQUAL:
- detailedContent: The FAITHFUL REPRESENTATION of the original comment text - the most reliable source if you need a deep or nuanced understanding of the content
- Other fields: AI-generated abstractions that compress and interpret the original

Reading the detailedContent field reveals:
- Specific implementation challenges and solutions
- Personal experiences and case studies  
- Detailed policy recommendations with rationale
- Nuanced positions that defy simple categorization
- Technical details and operational insights

QUERY SYNTAX:
- Keywords: Use plain words or "quoted phrases" to search comment text
  Examples: prior authorization, "nurse staffing", medicare
  
- Entity filters: Use entity:label to find comments from specific organizations
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

WHAT SEARCH RETURNS:
Every result includes these fields for consistent browsing:
- submitter: Person/organization name
- submitterType: Their role (Physician, Patient, etc.)
- date: When submitted
- oneLineSummary: AI-generated one-line summary
- commenterProfile: AI-generated background info
- keyQuotations: Exact quotes from the comment
- contextSnippet: ~100 words showing your search term in context

IMPORTANT: These are OVERVIEW fields. To read the full original comment text (detailedContent), 
use getComment with the commentId.

SEARCH FIELDS (what to search in):
- detailedContent: The FAITHFUL original comment text (default: true) - most reliable
- oneLineSummary: AI abstraction - brief summary (lossy compression)
- corePosition: AI abstraction - extracted stance (oversimplified)
- keyRecommendations: AI abstraction - extracted suggestions (incomplete list)
- mainConcerns: AI abstraction - extracted worries (selective)
- notableExperiences: AI abstraction - extracted stories (lacks context)
- keyQuotations: AI-selected EXACT QUOTES - preserves original wording but limited selection

BEST PRACTICES:
1. Search broadly to see overview of many comments
2. Use contextSnippet to see how your keywords appear
3. Review oneLineSummary and commenterProfile to identify relevant perspectives
4. CRUCIAL: Use getComment to read full detailedContent for selected comments
5. Only detailedContent is faithful - summaries are AI interpretations`,
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
        limit: z.number().optional().describe('Maximum number of results (default: 1000)'),
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
          returnType: 'fields', // Always return consistent fields
          returnFields: {}, // Always use default overview fields
          limit: params.limit || 1000, // Default to 1000 max
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
        
        if (results.results.length > 0) {
          const sampleIds = results.results.slice(0, 3).map(r => r.commentId).join('", "');
          suggestions.push(`IMPORTANT: Search returns overview only. To read full comment text, use getComment with IDs like: "${sampleIds}"`);
          suggestions.push('The oneLineSummary and commenterProfile are AI abstractions - always read detailedContent for nuanced understanding');
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
      description: `Retrieve the complete, unabridged content of a specific comment to understand nuanced perspectives.

IMPORTANT: By default, this returns ALL FIELDS. Among these, detailedContent is the ONLY FAITHFUL REPRESENTATION of the original comment. It preserves:
- Complete argumentation and reasoning chains
- Specific examples and case studies with full context
- Technical details and operational insights
- Emotional context and stakeholder concerns
- Nuanced positions that resist simple categorization

WHEN TO USE THIS TOOL:
- After search results, always fetch full comments to understand complete perspectives
- When you need the actual words and full context, not AI summaries
- To understand specific implementation details or technical recommendations
- To capture personal stories and experiences in their entirety

PRIMARY FIELDS (preserving original content):
- detailedContent: COMPLETE ORIGINAL COMMENT TEXT - the most reliable source if you need a deep or nuanced understanding of the content
- submitter: Actual name of person/organization who submitted
- submitterType: Their role (e.g., Physician, Patient, Hospital)
- date: When submitted
- location: Geographic origin

AI-EXTRACTED FIELDS (useful for quick overview but less reliable for nuanced understanding):
- oneLineSummary: AI-generated brief summary (loses critical nuance)
- corePosition: AI's attempt to extract stance (often oversimplified)
- keyRecommendations: AI-extracted suggestions (may miss important ones)
- mainConcerns: AI-extracted concerns (incomplete list)
- notableExperiences: AI-extracted stories (lacks full narrative)
- keyQuotations: AI-selected EXACT QUOTES from original text (preserves precise wording but limited selection)
- commenterProfile: AI-generated background summary

METADATA FIELDS:
- themeScores: How strongly comment relates to each theme (1-3 scale)
- entities: Organizations mentioned in the comment
- hasAttachments: Whether comment included additional documents
- wordCount: Length of original comment

DEFAULT BEHAVIOR: Returns submitter info, detailedContent, and keyQuotations only. Request other fields explicitly if needed.

BEST PRACTICE: For deep or nuanced understanding, focus on detailedContent - the faithful representation. The AI-extracted fields can provide quick orientation but are less reliable for understanding subtleties, specific implementation details, or complex arguments.`,
      inputSchema: {
        docketId: z.string().describe('The full docket ID (e.g., "CMS-2025-0050-0031")'),
        commentId: z.string().describe('The comment ID'),
        fields: z.object({
          detailedContent: z.boolean().optional(),
          keyQuotations: z.boolean().optional(),
          oneLineSummary: z.boolean().optional(),
          corePosition: z.boolean().optional(),
          keyRecommendations: z.boolean().optional(),
          mainConcerns: z.boolean().optional(),
          notableExperiences: z.boolean().optional(),
          commenterProfile: z.boolean().optional(),
          submitter: z.boolean().optional(),
          submitterType: z.boolean().optional(),
          date: z.boolean().optional(),
          location: z.boolean().optional(),
          themeScores: z.boolean().optional(),
          entities: z.boolean().optional(),
          hasAttachments: z.boolean().optional(),
          wordCount: z.boolean().optional(),
        }).optional().describe('Which fields to return (default: detailedContent only)'),
        chunk: z.object({
          index: z.number().min(0).default(0),
          of: z.number().min(1).default(1),
        }).optional().describe('Splits detailedContent into chunks for large comments'),
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
          // Default: detailedContent and keyQuotations only
          if (comment.structuredSections) {
            result.detailedContent = comment.structuredSections.detailedContent;
            result.keyQuotations = comment.structuredSections.keyQuotations;
          }
        } else {
          // Return only requested fields
          const s = comment.structuredSections;
          if (params.fields.detailedContent && s) {
            result.detailedContent = s.detailedContent;
          }
          if (params.fields.keyQuotations && s) result.keyQuotations = s.keyQuotations;
          if (params.fields.oneLineSummary && s) result.oneLineSummary = s.oneLineSummary;
          if (params.fields.corePosition && s) result.corePosition = s.corePosition;
          if (params.fields.keyRecommendations && s) result.keyRecommendations = s.keyRecommendations;
          if (params.fields.mainConcerns && s) result.mainConcerns = s.mainConcerns;
          if (params.fields.notableExperiences && s) result.notableExperiences = s.notableExperiences;
          if (params.fields.commenterProfile && s) result.commenterProfile = s.commenterProfile;
          if (params.fields.submitter) result.submitter = comment.submitter;
          if (params.fields.submitterType) result.submitterType = comment.submitterType;
          if (params.fields.date) result.date = comment.date;
          if (params.fields.location) result.location = comment.location;
          if (params.fields.themeScores) result.themeScores = comment.themeScores;
          if (params.fields.entities) result.entities = comment.entities;
          if (params.fields.hasAttachments) result.hasAttachments = comment.hasAttachments;
          if (params.fields.wordCount) result.wordCount = comment.wordCount;
        }

        // Handle chunking
        if (params.chunk && result.detailedContent) {
          const { index, of } = params.chunk;
          if (index >= of) {
            throw new Error(`Chunk index (${index}) must be less than total chunks (${of})`);
          }
          const totalLength = result.detailedContent.length;
          const chunkSize = Math.ceil(totalLength / of);
          const start = index * chunkSize;
          const end = start + chunkSize;
          
          result.detailedContent = result.detailedContent.substring(start, end);
          result.chunk = { index, of };
          result.totalLength = totalLength;
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
        
        if (!params.fields || Object.keys(params.fields).length === 0) {
          suggestions.push('This is the default view (detailedContent and keyQuotations only). To get more info, request specific fields like: submitter, date, oneLineSummary, etc.');
        } else if (Object.keys(params.fields).length < 5) { // Suggest more if they only asked for a few
          suggestions.push('You can request more fields, like: corePosition, mainConcerns, commenterProfile, themeScores.');
        }
        
        if (params.chunk) {
          const { index, of } = params.chunk;
          if (index < of - 1) {
            suggestions.push(`To get the next part of this comment, use chunk: { index: ${index + 1}, of: ${of} }`);
          }
        } else if (result.detailedContent && result.detailedContent.length > 5 * 20000) { // Suggest chunking if content is large
          suggestions.push('This comment is long. To read it in smaller parts, use the `chunk` parameter (e.g., chunk: { index: 0, of: 5 })');
        }
        
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              docketInfo: {
                documentId: meta.documentId,
                totalComments: meta.stats.totalComments
              },
              suggestions,
              comment: result,
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
      description: `Get AI-generated theme analysis - useful for overview but inherently limited compared to reading actual comments.

CRITICAL LIMITATIONS OF AI SUMMARIES:
- Abstractions lose crucial implementation details and specific examples
- Nuanced positions get oversimplified into broad categories  
- Minority viewpoints may be underrepresented or omitted
- Technical specifications and operational details are compressed away
- Personal stories lose their emotional impact and specificity
- Complex arguments get reduced to bullet points
- Important edge cases and exceptions may be missed

WHAT THIS TOOL PROVIDES:
AI-generated analysis attempts to synthesize comments into:
1. Overview: High-level themes (loses specific details)
2. Key Positions: Grouped stances (oversimplifies nuanced views)
3. Major Concerns: Common issues (may miss unique problems)
4. Recommendations: Aggregated suggestions (lacks implementation specifics)
5. Stakeholder Perspectives: Broad categories (loses individual voices)
6. Notable Insights: Selected points (subjective AI selection)

WHEN TO USE vs. READING COMMENTS:
Use theme summaries for:
- Initial orientation to a topic
- Understanding broad patterns
- Quick quantitative overview

Then ALWAYS follow up by searching and reading actual comments to:
- Understand specific implementation challenges
- Capture detailed recommendations with full context
- Hear authentic stakeholder voices
- Discover nuanced positions and edge cases
- Find concrete examples and case studies

BEST PRACTICE WORKFLOW:
1. Use listThemes to see topic landscape
2. Read theme summary for initial orientation
3. CRUCIALLY: Use searchComments with theme filters to read actual comments
4. Look for what the summary missed or oversimplified
5. Pay special attention to detailed recommendations and specific examples

REMEMBER: Theme summaries are AI interpretations that compress thousands of unique perspectives into generalizations. They are starting points, not endpoints. The real insights come from reading what commenters actually wrote.`,
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
