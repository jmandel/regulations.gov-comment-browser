import { create } from 'zustand'
import type { Meta, Theme, Entity, Comment, ThemeIndex, EntityIndex, ThemeSummary } from '../types'
import { parseThemeDescription } from '../utils/helpers'

interface FilterOptions {
  themes: string[]
  entities: string[]
  submitterTypes: string[]
  searchQuery: string
}

interface StoreState {
  loading: boolean
  error: string | null
  meta: Meta | null
  themes: Theme[]
  themeSummaries: Record<string, ThemeSummary>
  entities: Record<string, Entity[]>
  comments: Comment[]
  filters: FilterOptions
  searchQuery: string
  themeIndex: ThemeIndex
  entityIndex: EntityIndex
  organizationCategory: string | null
  
  // UI state
  selectedView: string
  selectedTheme: Theme | null
  selectedEntity: { category: string; label: string } | null
  
  // Actions
  loadData: () => Promise<void>
  setFilters: (filters: FilterOptions | ((prev: FilterOptions) => FilterOptions)) => void
  setSearchQuery: (query: string) => void
  setData: (data: any) => void
  setSelectedView: (view: string) => void
  setSelectedTheme: (theme: Theme | null) => void
  setSelectedEntity: (entity: { category: string; label: string } | null) => void
  
  // Computed
  getCommentsForTheme: (themeCode: string) => { direct: Comment[], touches: Comment[] }
  getCommentsForEntity: (category: string, label: string) => Comment[]
  getFilteredComments: () => Comment[]
  getCommentById: (commentId: string) => Comment | undefined
}

const useStore = create<StoreState>((set, get) => ({
  // Core data
  meta: null,
  themes: [],
  themeSummaries: {},
  entities: {},
  comments: [],
  themeIndex: {},
  entityIndex: {},
  organizationCategory: null,
  
  // UI state
  selectedView: 'overview',
  selectedTheme: null,
  selectedEntity: null,
  searchQuery: '',
  loading: true,
  error: null,
  
  // Filters
  filters: {
    themes: [],
    entities: [],
    submitterTypes: [],
    searchQuery: ''
  },
  
  // Actions
  setData: (data: any) => set(data),
  setSelectedView: (view: string) => set({ selectedView: view }),
  setSelectedTheme: (theme: Theme | null) => set({ selectedTheme: theme }),
  setSelectedEntity: (entity: { category: string; label: string } | null) => set({ selectedEntity: entity }),
  setSearchQuery: (query: string) => set({ searchQuery: query }),
  setFilters: (filters: FilterOptions | ((prev: FilterOptions) => FilterOptions)) => set((state) => ({
    filters: typeof filters === 'function' ? filters(state.filters) : filters
  })),
  
  // Load all data
  loadData: async () => {
    set({ loading: true, error: null })
    
    try {
      const [meta, themes, themeSummaries, entities, comments, themeIndex, entityIndex] = await Promise.all([
        fetch('./data/meta.json').then(r => r.json()),
        fetch('./data/themes.json').then(r => r.json()),
        fetch('./data/theme-summaries.json').then(r => r.json()),
        fetch('./data/entities.json').then(r => r.json()),
        fetch('./data/comments.json').then(r => r.json()),
        fetch('./data/indexes/theme-comments.json').then(r => r.json()),
        fetch('./data/indexes/entity-comments.json').then(r => r.json()),
      ])
      
      // Parse theme descriptions
      const parsedThemes = themes.map((theme: Theme) => {
        const { label, detailedDescription } = parseThemeDescription(theme.description)
        return {
          ...theme,
          label,
          detailedDescription
        }
      })
      console.log(parsedThemes);
      
      // After loading themeSummaries and entities
      // Determine the organization category by sampling
      const orgCategory = determineOrganizationCategory(themeSummaries, entities)
      
      // Compute wordCount for each comment (use .wordCount if present, else fallback)
      const wordCounts = comments.map((c: Comment) => c.wordCount || 0)
      const sortedCounts = [...wordCounts].sort((a, b) => a - b)
      const commentsWithCounts = comments.map((c: Comment) => {
        const wc = c.wordCount || 0
        const rank = sortedCounts.findIndex(x => x === wc)
        const percentile = sortedCounts.length > 1 ? Math.round((rank / (sortedCounts.length - 1)) * 100) : 100
        return { ...c, wordCount: wc, percentile }
      })
      
      set({
        meta,
        themes: parsedThemes,
        themeSummaries,
        entities,
        comments: commentsWithCounts,
        themeIndex,
        entityIndex,
        organizationCategory: orgCategory,
        loading: false,
        error: null,
      })
    } catch (error) {
      console.error('Failed to load data:', error)
      set({ loading: false, error: error instanceof Error ? error.message : 'Unknown error' })
    }
  },
  
  // Computed getters
  getFilteredComments: () => {
    const startTime = performance.now()
    const state = get()
    
    // Safety check
    if (!state.comments || !state.filters) {
      console.warn('getFilteredComments: Missing comments or filters')
      return []
    }
    
    // Start with only representative comments (or all if no clustering)
    let filtered = state.comments.filter(c => 
      c.isClusterRepresentative === true || 
      c.isClusterRepresentative === undefined // For databases without clustering
    )
    const originalCount = state.comments.length
    
    // Apply search
    if (state.filters.searchQuery) {
      const query = state.filters.searchQuery.toLowerCase()
      filtered = filtered.filter(c => {
        // Search in structured sections
        const searchInSections = c.structuredSections ? (
          c.structuredSections.oneLineSummary?.toLowerCase().includes(query) ||
          c.structuredSections.corePosition?.toLowerCase().includes(query) ||
          c.structuredSections.detailedContent?.toLowerCase().includes(query)
        ) : false
        
        return searchInSections ||
          c.submitter?.toLowerCase().includes(query) ||
          c.id?.toLowerCase().includes(query)
      })
      console.log(`Search filter applied: ${originalCount} → ${filtered.length} (query: "${query}")`)
    }
    
    // Apply theme filters
    if (state.filters.themes?.length > 0) {
      const beforeThemes = filtered.length
      filtered = filtered.filter(c => {
        if (!c.themeScores) return false
        return state.filters.themes.some((themeCode: string) => 
          c.themeScores![themeCode] && c.themeScores![themeCode] <= 2
        )
      })
      console.log(`Theme filter applied: ${beforeThemes} → ${filtered.length}`)
    }
    
    // Apply entity filters
    if (state.filters.entities?.length > 0) {
      const beforeEntities = filtered.length
      filtered = filtered.filter(c => {
        if (!c.entities || c.entities.length === 0) return false
        return state.filters.entities.some((entityKey: string) => {
          const [category, label] = entityKey.split('|')
          return c.entities!.some(e => e.category === category && e.label === label)
        })
      })
      console.log(`Entity filter applied: ${beforeEntities} → ${filtered.length}`)
    }
    
    // Apply submitter type filters
    if (state.filters.submitterTypes?.length > 0) {
      const beforeSubmitter = filtered.length
      filtered = filtered.filter(c => 
        state.filters.submitterTypes.includes(c.submitterType)
      )
      console.log(`Submitter filter applied: ${beforeSubmitter} → ${filtered.length}`)
    }
    
    
    const endTime = performance.now()
    console.log(`Total filtering time: ${(endTime - startTime).toFixed(2)}ms (${originalCount} → ${filtered.length} comments)`)
    
    return filtered
  },
  
  getCommentsForTheme: (themeCode: string) => {
    const state = get()
    const commentIds = state.themeIndex[themeCode]
    if (!commentIds) return { direct: [], touches: [] }
    
    const findComment = (id: string): Comment | undefined => 
      state.comments.find(c => c.id === id)
    
    return {
      direct: (commentIds.direct || [])
        .map(findComment)
        .filter((c): c is Comment => c !== undefined),
      touches: (commentIds.touches || [])
        .map(findComment)
        .filter((c): c is Comment => c !== undefined)
    }
  },
  
  getCommentsForEntity: (category: string, label: string) => {
    const state = get()
    const key = `${category}|${label}`
    const commentIds = state.entityIndex[key] || []
    
    return commentIds
      .map(id => state.comments.find(c => c.id === id))
      .filter((c): c is Comment => c !== undefined)
  },
  
  getCommentById: (commentId: string) => {
    const state = get()
    return state.comments.find(c => c.id === commentId)
  }
}))

export default useStore 

// Helper function to determine organization category
function determineOrganizationCategory(
  _themeSummaries: Record<string, ThemeSummary>, 
  _entities: Record<string, Entity[]>
): string | null {
  // Organizations are now kept in narrative text, not separate arrays
  // This function could be enhanced to parse organization names from narrative text if needed
  // For now, just return default
  return 'Organizations'
} 