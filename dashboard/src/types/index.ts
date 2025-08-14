export interface Meta {
  documentId: string
  generatedAt: string
  stats: {
    totalComments: number
    condensedComments: number
    totalThemes: number
    totalEntities: number
    scoredComments: number
  }
}

export interface Theme {
  code: string
  parent_code: string | null
  description: string
  label?: string  // Brief theme label (parsed from description)
  detailedDescription?: string  // Detailed description (parsed from description)
  detailed_guidelines?: string  // Comprehensive guidelines about what's included/excluded
  comment_count: number
  direct_count: number
  touch_count: number
}

export interface ThemeSummary {
  themeDescription: string
  commentCount: number
  wordCount: number
  sections: {
    executiveSummary?: string
    consensusPoints?: Array<{
      text: string
      supportLevel?: string | null
      exceptions?: {
        text: string
        commentIds: string[]
      } | null
      evidence?: string[] | null  // Kept for backward compatibility
      commentIds?: string[] | null  // Kept for backward compatibility
    }> | null
    areasOfDebate?: Array<{
      topic: string
      description: string
      positions: Array<{
        label: string
        stance: string
        supportLevel?: string | null
        keyArguments: string[]
        commentIds?: string[] | null
      }>
    }> | null
    stakeholderPerspectives?: Array<{
      stakeholderType: string
      primaryConcerns: string
      specificPoints: string[]
      commentIds?: string[] | null
    }> | null
    noteworthyInsights?: Array<{
      insight: string
      commentId?: string | null
    }> | null
    emergingPatterns?: Array<{
      pattern: string
      commentIds?: string[] | null
    }> | null
    keyQuotations?: Array<{
      quote: string
      sourceType?: string | null
      commentId?: string | null
    }> | null
    analyticalNotes?: {
      discourseQuality?: {
        level: string
        explanation: string
      }
      evidenceBase?: {
        level: string
        explanation: string
      }
      representationGaps?: string | null
      complexityLevel?: string | null
    } | null
  }
}

export interface Entity {
  label: string
  definition: string
  terms: string[]
  mentionCount: number
}

export interface EntityTaxonomy {
  [category: string]: Entity[]
}

export interface Comment {
  id: string
  submitter: string
  submitterType: string
  date: string
  location?: string
  structuredSections?: {
    oneLineSummary?: string
    commenterProfile?: string
    corePosition?: string
    keyRecommendations?: string
    mainConcerns?: string
    notableExperiences?: string
    keyQuotations?: string
    detailedContent?: string
  }
  themeScores?: Record<string, number>
  entities?: Array<{
    category: string
    label: string
  }>
  hasAttachments: boolean
  documentId?: string
  wordCount?: number
  clusterSize?: number
  isClusterRepresentative?: boolean
  clusterRepresentativeId?: string | null
  isAlignedSummary?: boolean
}

export interface ThemeIndex {
  [themeCode: string]: {
    direct: string[]
    touches: string[]
  }
}

export interface EntityIndex {
  [entityKey: string]: string[]
}

export interface Filters {
  themes: string[]
  entities: string[]
  submitterTypes: string[]
  searchQuery: string
}

export interface StoreState {
  // Core data
  meta: Meta | null
  themes: Theme[]
  themeSummaries: Record<string, ThemeSummary>
  entities: EntityTaxonomy
  comments: Comment[]
  themeIndex: ThemeIndex
  entityIndex: EntityIndex
  
  // UI state
  selectedView: 'overview' | 'themes' | 'entities' | 'comments'
  selectedTheme: Theme | null
  selectedEntity: (Entity & { category: string }) | null
  searchQuery: string
  loading: boolean
  error: string | null
  
  // Filters
  filters: Filters
  
  // Actions
  setData: (data: Partial<StoreState>) => void
  setSelectedView: (view: StoreState['selectedView']) => void
  setSelectedTheme: (theme: Theme | null) => void
  setSelectedEntity: (entity: (Entity & { category: string }) | null) => void
  setSearchQuery: (query: string) => void
  setFilters: (filters: Filters) => void
  loadData: () => Promise<void>
  
  // Computed getters
  getFilteredComments: () => Comment[]
  getCommentsForTheme: (themeCode: string) => { direct: Comment[], touches: Comment[] }
  getCommentsForEntity: (category: string, label: string) => Comment[]
  getCommentById: (commentId: string) => Comment | undefined
} 