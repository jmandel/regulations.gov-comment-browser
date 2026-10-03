export interface Meta {
  documentId: string
  title?: string
  documentType?: string
  agencyId?: string
  commentStartDate?: string
  commentEndDate?: string
  generatedAt: string
  // Downloadable analysis databases (zipped SQLite + README), in data/; absent in older builds
  downloads?: Array<{ kind: 'slim' | 'full'; file: string; bytes: number; sqliteBytes?: number; sha256?: string; url?: string }>  // url: absolute (release asset); else ./data/<file>
  // Docket site: its scoped analyses, each a sub-site at `path` (relative to the docket site)
  scopes?: ScopeListing[]
  // Scope sub-site: the scope, where the docket's shared data lives and the way back to the docket
  scope?: Omit<ScopeListing, 'path' | 'themes' | 'seedCommentId'> & { docketUnits?: number }
  sharedData?: string
  docketUrl?: string
  stats: {
    totalComments: number
    condensedComments: number
    totalThemes: number
    totalEntities: number
    scoredComments: number
    // Present when tag-campaigns ran; each comment is in at most one campaign
    campaigns?: number
    campaignComments?: number
    paraphrasedCampaignComments?: number
    paraphraseCampaigns?: number
  }
}

export interface ScopeListing {
  slug: string
  name: string
  summary?: string | null
  path: string
  inScopeSubmissions: number
  docketSubmissions: number
  inScopeUnits: number
  themes?: number
  seedCommentId?: string | null
}

// scope.json in a scope sub-site
export interface ScopeInfo {
  slug: string
  name: string
  summary?: string | null
  promptMarkdown: string
  seedCommentId?: string | null
  updatedAt?: string
  counts: {
    docketSubmissions: number
    docketUnits: number
    inScopeSubmissions: number
    inScopeUnits: number
    inScopeComments?: number
    inScopeFormLetterGroups?: number
    inScopeOrganizations?: number
  }
}

// scope-units.json: the in-scope units with what the relevance judge kept
export interface ScopeUnitsFile {
  version: number
  units: Record<string, { excerpt?: string; note?: string; themes?: string[]; seed?: boolean }>
}

// overview.json: precomputed figures for the Overview page. Counts are submissions (copies included).
export interface CompositionCounts {
  campaignCopies: number   // exact copies of a campaign letter
  campaignReworded: number // campaign letters reworded by the sender
  typed: number            // not in a campaign, no attachment
  attached: number         // not in a campaign, with an attached document
}
export interface OverviewData {
  version: number
  composition: CompositionCounts
  // Commenter types, from one source: AI-assigned (typeSource 'ai') or the folded filed category
  // ('filed'; older builds have no typeSource). Labels match comments-index.json submitterTypes.
  submitters: Array<{ label: string; count: number; split?: CompositionCounts; group?: 'individual' | 'organization'; organizations?: Array<{ name: string; count: number }>; organizationCount?: number }>
  typeSource?: 'ai' | 'filed'
  filedAs?: Record<FiledAs, number>
  geography?: { total: number; withState: number; withCountry: number; states: Array<{ state: string; count: number }>; countries: Array<{ country: string; count: number }> }
  arrivals: Array<{ date: string; count: number }>
  themeGists: Record<string, string>
  themeComposition: Record<string, CompositionCounts>
  // Per top-level theme: distinct letters (form-letter groups once) and those over longLetterWords
  themeLetters?: Record<string, { letters: number; long: number; longOrg?: number }>
  longLetterWords?: number
}

// An organized comment campaign (campaigns.json, from tag-campaigns). method 'paraphrase': has
// reworded letters (maybe plus exact-copy groups); 'form-letter': exact-copy groups only.
export interface Campaign {
  id: number
  name: string
  description?: string | null
  method: 'paraphrase' | 'form-letter'
  evidence?: string | null
  total: number
  exact: number
  paraphrased: number
  units: number
  example?: string
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
    keyRecommendations?: Array<{
      approach: string
      recommendation: string
      supportLevel?: string | null
      commentIds?: string[] | null
    }> | null
    majorConcerns?: Array<{
      concern: string
      raisedBy: string
      evidence?: string | null
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

export interface StructuredSections {
  oneLineSummary?: string
  commenterProfile?: string
  corePosition?: string
  keyRecommendations?: string
  mainConcerns?: string
  notableExperiences?: string
  keyQuotations?: string
  detailedContent?: string
}

export type FiledAs = 'organization' | 'person' | 'anonymous'

// A comment as held in memory. Only lean fields are loaded up front (from comments-index.json);
// the full condensed sections, full text and a form-letter member's added text are fetched on
// demand from shards (see utils/commentData.ts).
export interface Comment {
  id: string
  submitter: string
  nameFromTitle?: boolean // submitter name taken from the submission's title (no name was filed)
  submitterType: string   // commenter type label (AI-assigned or folded filed category; see typeSource)
  typeGroup?: 'individual' | 'organization' // AI-assigned types only
  org?: string            // organization the comment speaks for (AI-assigned), when not the submitter name
  filedAs?: FiledAs
  date: string            // received date
  city?: string
  state?: string
  country?: string
  location?: string       // city, state, country joined
  // Up front this holds only oneLineSummary (the representative's, for form-letter members)
  structuredSections?: StructuredSections
  themeScores?: Record<string, number>
  entities?: Array<{
    category: string
    label: string
  }>
  hasAttachments: boolean
  documentId?: string
  wordCount?: number
  percentile?: number
  clusterSize?: number
  isClusterRepresentative?: boolean
  clusterRepresentativeId?: string | null
  isAlignedSummary?: boolean
  // Form-letter members: words this member added to the template, and the start of that text
  addedWords?: number
  addedSnippet?: string
  // Organized campaign this comment belongs to, and whether it is a reworded (not exact) copy
  campaignId?: number
  campaignParaphrase?: boolean
  // Shards holding this comment's content (for members: the representative's)
  detailShard?: number
  textShard?: number
  // Scope sub-site: whether the comment addresses the scope (members follow their representative),
  // and the in-scope passages and one-line note from the relevance judgment (units only)
  inScope?: boolean
  scopeExcerpt?: string
  scopeNote?: string
  scopeSeed?: boolean
}

// Shape of comments-index.json
export interface CommentsIndexFile {
  version: number
  documentId: string
  clustered: boolean
  typeSource?: 'ai' | 'filed'
  submitterTypes: string[]
  typeGroups?: Array<'individual' | 'organization' | null>
  states?: string[]
  countries?: string[]
  entityKeys: string[]
  comments: Array<{
    id: string
    submitter: string
    nameFromTitle?: boolean
    submitterType: number
    filedAs?: 'o' | 'p' | 'a'
    org?: string
    date: string
    city?: string
    state?: number
    country?: number
    location?: string
    hasAttachments?: boolean
    isRep?: boolean
    clusterSize?: number
    rep?: string
    addedWords?: number
    addedSnippet?: string
    wordCount?: number
    summary?: string
    detailShard?: number
    textShard?: number
    themes?: string[]
    entities?: number[]
    campaign?: number
    campaignParaphrase?: boolean
  }>
}

export interface ThemeExtract {
  positions?: string[]
  concerns?: string[]
  recommendations?: string[]
  key_quotes?: string[]
  experiences?: string[]
}

export interface ThemeExtractsMap {
  [themeCode: string]: {
    [commentId: string]: ThemeExtract
  }
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