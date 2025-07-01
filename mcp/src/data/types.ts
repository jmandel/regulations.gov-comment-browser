// Data types based on the published JSON structure

export interface StructuredSections {
  detailedContent?: string;
  commenterProfile?: string;
  corePosition?: string;
  mainConcerns?: string[];
  keyRecommendations?: string[];
  notableExperiences?: string[];
  keyQuotations?: string[];
  oneLineSummary?: string;
}

export interface Comment {
  id: string;
  documentId: string;
  submitter: string;
  submitterType: string;
  date: string;
  location: string;
  structuredSections: StructuredSections | null;
  themeScores: Record<string, number>;
  entities: Array<{
    category: string;
    label: string;
  }>;
  hasAttachments: boolean;
  wordCount: number;
}

export interface Theme {
  code: string;
  description: string;
  detailed_guidelines: string;
  level: number;
  parent_code: string | null;
  comment_count: number;
  direct_count: number;
  touch_count: number;
  children: string[]; // Array of child theme codes, not full Theme objects
}

export interface ThemeSummary {
  themeDescription: string;
  commentCount: number;
  wordCount: number;
  sections: {
    overview: string;
    key_positions: Array<{
      position: string;
      supporting_points: string[];
      representative_comments: number;
    }>;
    major_concerns: Array<{
      concern: string;
      specific_issues: string[];
      affected_groups: string[];
      representative_comments: number;
    }>;
    recommendations: Array<{
      recommendation: string;
      rationale: string;
      expected_impact: string;
      support_level: 'Strong' | 'Moderate' | 'Limited';
    }>;
    stakeholder_perspectives: Array<{
      stakeholder_group: string;
      primary_concerns: string[];
      suggested_solutions: string[];
      overall_sentiment: 'Positive' | 'Negative' | 'Mixed' | 'Neutral';
    }>;
    notable_insights: string[];
  };
}

export interface Entity {
  label: string;
  definition: string;
  terms: string[];
  mentionCount: number;
}

export interface EntityTaxonomy {
  [category: string]: Entity[];
}

export interface DocketMeta {
  documentId: string;
  generatedAt: string;
  stats: {
    totalComments: number;
    condensedComments: number;
    totalThemes: number;
    totalEntities: number;
    scoredComments: number;
    themeSummaries: number;
  };
}

export interface SearchQuery {
  keywords: string[];
  entities: Array<{category: string; label: string}>;
  themes: string[];
  exclude: string[];
}

export interface SearchResult {
  commentId: string;
  submitter: string;
  submitterType: string;
  date: string;
  snippets?: Array<{
    field: string;
    text: string;
    matchStart: number;
    matchEnd: number;
  }>;
  fields?: Record<string, any>;
}

export interface SearchFields {
  detailedContent?: boolean;
  oneLineSummary?: boolean;
  corePosition?: boolean;
  keyRecommendations?: boolean;
  mainConcerns?: boolean;
  notableExperiences?: boolean;
  keyQuotations?: boolean;
}

export interface ReturnFields extends SearchFields {
  commenterProfile?: boolean;
  submitter?: boolean;
  submitterType?: boolean;
  date?: boolean;
  location?: boolean;
  themeScores?: boolean;
  entities?: boolean;
  hasAttachments?: boolean;
  wordCount?: boolean;
}