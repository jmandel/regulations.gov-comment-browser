import { create } from 'zustand'
import type { Meta, Theme, Entity, Comment, ThemeIndex, EntityIndex, ThemeSummary, ThemeExtract, CommentsIndexFile, Campaign } from '../types'
import { parseThemeDescription } from '../utils/helpers'
import { parseSearchQuery, matchesSearchQuery } from '../utils/searchParser'
import { loadSearchIndex, searchWithIndex, verifyCandidates } from '../utils/fullTextSearch'

interface FilterOptions {
  themes: string[]
  entities: string[]
  submitterTypes: string[]
  campaigns?: string[] // campaign ids
  searchQuery: string
}

// Progress of the current text search. `ids` is the set of matching units shown so far:
// first matches on the up-front fields, then index matches, narrowed as phrases are verified.
export interface SearchState {
  query: string
  ids: Set<string> | null
  phase: 'idle' | 'index' | 'verify' | 'done' | 'error'
  progress?: { done: number; total: number }
  pending?: number // candidates still being verified
  error?: string
}

type ThemeExtractsForTheme = { [commentId: string]: ThemeExtract }

interface StoreState {
  loading: boolean
  error: string | null
  meta: Meta | null
  themes: Theme[]
  themeSummaries: Record<string, ThemeSummary>
  entities: Record<string, Entity[]>
  comments: Comment[]
  commentsById: Map<string, Comment>
  units: Comment[] // comments with their own content: representatives, or all without clustering
  campaigns: Campaign[]
  campaignsById: Map<number, Campaign>
  hasClustering: boolean
  filters: FilterOptions
  searchQuery: string
  search: SearchState
  themeIndex: ThemeIndex
  entityIndex: EntityIndex
  themeExtracts: Record<string, ThemeExtractsForTheme | undefined>
  organizationCategory: string | null

  // UI state
  selectedView: string
  selectedTheme: Theme | null
  selectedEntity: { category: string; label: string } | null

  // Actions
  loadData: () => Promise<void>
  loadThemeExtracts: (themeCode: string) => Promise<void>
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

let searchGeneration = 0
const themeExtractRequests = new Map<string, Promise<void>>()

const useStore = create<StoreState>((set, get) => {
  // Run a text search: instant pass over up-front fields, then the full-text index, then
  // verification of phrase candidates against fetched text
  async function runSearch(query: string) {
    const gen = ++searchGeneration
    const tokens = parseSearchQuery(query)
    if (!query || tokens.length === 0) {
      set({ search: { query, ids: null, phase: 'idle' } })
      return
    }
    const units = get().units
    const leanIds = new Set(units.filter(c => matchesSearchQuery(c, tokens)).map(c => c.id))
    set({ search: { query, ids: leanIds, phase: 'index' } })

    let ix
    try {
      ix = await loadSearchIndex()
    } catch (err) {
      if (gen === searchGeneration) {
        set({ search: { query, ids: leanIds, phase: 'error', error: `Full-text index unavailable (${err}); showing matches on summaries and names only` } })
      }
      return
    }
    if (gen !== searchGeneration) return

    const t0 = performance.now()
    const { matches, toVerify } = searchWithIndex(ix, tokens, units)
    console.log(`Index search "${query}": ${matches.size} matches, ${toVerify.size} to verify (${(performance.now() - t0).toFixed(1)}ms)`)
    if (toVerify.size === 0) {
      set({ search: { query, ids: matches, phase: 'done' } })
      return
    }

    // Show definite matches plus unverified candidates; drop candidates that fail verification
    const ids = new Set([...matches, ...toVerify])
    let pending = toVerify.size
    set({ search: { query, ids, phase: 'verify', pending, progress: { done: 0, total: 1 } } })
    const candidates = units.filter(c => toVerify.has(c.id))
    const t1 = performance.now()
    try {
      await verifyCandidates(
        candidates,
        tokens,
        (_matched, rejected) => {
          if (gen !== searchGeneration) return
          for (const id of rejected) ids.delete(id)
          pending -= _matched.length + rejected.length
          set(state => ({ search: { ...state.search, ids: new Set(ids), pending } }))
        },
        progress => {
          if (gen !== searchGeneration) return
          set(state => ({ search: { ...state.search, progress } }))
        },
        () => gen !== searchGeneration,
      )
    } catch (err) {
      if (gen === searchGeneration) {
        set(state => ({ search: { ...state.search, phase: 'error', error: `Could not verify all phrase matches (${err}); some results may not contain the exact phrase` } }))
      }
      return
    }
    if (gen !== searchGeneration) return
    console.log(`Verified ${candidates.length} candidates in ${(performance.now() - t1).toFixed(0)}ms`)
    set(state => ({ search: { ...state.search, ids: new Set(ids), phase: 'done', pending: 0 } }))
  }

  return {
    // Core data
    meta: null,
    themes: [],
    themeSummaries: {},
    entities: {},
    comments: [],
    commentsById: new Map(),
    units: [],
    campaigns: [],
    campaignsById: new Map(),
    hasClustering: false,
    themeIndex: {},
    entityIndex: {},
    themeExtracts: {},
    organizationCategory: null,

    // UI state
    selectedView: 'overview',
    selectedTheme: null,
    selectedEntity: null,
    searchQuery: '',
    search: { query: '', ids: null, phase: 'idle' },
    loading: true,
    error: null,

    // Filters
    filters: {
      themes: [],
      entities: [],
      submitterTypes: [],
      campaigns: [],
      searchQuery: ''
    },

    // Actions
    setData: (data: any) => set(data),
    setSelectedView: (view: string) => set({ selectedView: view }),
    setSelectedTheme: (theme: Theme | null) => set({ selectedTheme: theme }),
    setSelectedEntity: (entity: { category: string; label: string } | null) => set({ selectedEntity: entity }),
    setSearchQuery: (query: string) => set({ searchQuery: query }),
    setFilters: (filters: FilterOptions | ((prev: FilterOptions) => FilterOptions)) => {
      const prev = get().filters
      const next = typeof filters === 'function' ? filters(prev) : filters
      set({ filters: next })
      if (next.searchQuery !== get().search.query) runSearch(next.searchQuery)
    },

    loadThemeExtracts: (themeCode: string) => {
      if (get().themeExtracts[themeCode]) return Promise.resolve()
      let p = themeExtractRequests.get(themeCode)
      if (!p) {
        p = fetch(`./data/theme-extracts/${encodeURIComponent(themeCode)}.json`)
          .then(r => (r.ok ? r.json() : {}))
          .catch(() => ({}))
          .then(map => set(state => ({ themeExtracts: { ...state.themeExtracts, [themeCode]: map } })))
          .finally(() => themeExtractRequests.delete(themeCode))
        themeExtractRequests.set(themeCode, p)
      }
      return p
    },

    // Load the up-front data; comment content, theme extracts and the search index load on demand
    loadData: async () => {
      set({ loading: true, error: null })

      try {
        const getJson = (path: string) => fetch(path).then(r => {
          if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`)
          return r.json()
        })
        const [meta, themes, themeSummaries, entities, index, campaigns] = await Promise.all([
          getJson('./data/meta.json'),
          getJson('./data/themes.json'),
          getJson('./data/theme-summaries.json'),
          getJson('./data/entities.json'),
          getJson('./data/comments-index.json') as Promise<CommentsIndexFile>,
          // Optional: only present when tag-campaigns ran
          (getJson('./data/campaigns.json') as Promise<Campaign[]>).catch(() => [] as Campaign[]),
        ])
        const t0 = performance.now()

        // Parse theme descriptions
        const parsedThemes = themes.map((theme: Theme) => {
          const { label, detailedDescription: parsedDescription } = parseThemeDescription(theme.description)
          return {
            ...theme,
            label,
            // Only use parsed description if no detailed description from backend
            detailedDescription: theme.detailedDescription || parsedDescription
          }
        })

        const orgCategory = determineOrganizationCategory(themeSummaries, entities)
        const { comments, commentsById, units } = expandCommentsIndex(index)

        // Theme and entity -> comment indexes (units only, as before)
        const themeIndex: ThemeIndex = {}
        const entityIndex: EntityIndex = {}
        for (const c of units) {
          for (const code of Object.keys(c.themeScores || {})) {
            (themeIndex[code] ||= { direct: [], touches: [] }).direct.push(c.id)
          }
          for (const e of c.entities || []) {
            (entityIndex[`${e.category}|${e.label}`] ||= []).push(c.id)
          }
        }
        console.log(`Prepared ${comments.length} comments (${units.length} units) in ${(performance.now() - t0).toFixed(0)}ms`)

        set({
          meta,
          themes: parsedThemes,
          themeSummaries,
          entities,
          comments,
          commentsById,
          units,
          campaigns,
          campaignsById: new Map(campaigns.map(c => [c.id, c])),
          hasClustering: index.clustered,
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

      // Start with only representative comments (or all if no clustering)
      let filtered = state.units

      // Apply search with boolean query parsing (results come from runSearch)
      if (state.filters.searchQuery) {
        const ids = state.search.query === state.filters.searchQuery ? state.search.ids : null
        if (ids) {
          filtered = filtered.filter(c => ids.has(c.id))
        } else {
          const tokens = parseSearchQuery(state.filters.searchQuery)
          if (tokens.length > 0) filtered = filtered.filter(c => matchesSearchQuery(c, tokens))
        }
      }

      // Apply theme filters
      if (state.filters.themes?.length > 0) {
        filtered = filtered.filter(c => {
          if (!c.themeScores) return false
          return state.filters.themes.some((themeCode: string) =>
            c.themeScores![themeCode] && c.themeScores![themeCode] <= 2
          )
        })
      }

      // Apply entity filters
      if (state.filters.entities?.length > 0) {
        filtered = filtered.filter(c => {
          if (!c.entities || c.entities.length === 0) return false
          return state.filters.entities.some((entityKey: string) => {
            const [category, label] = entityKey.split('|')
            return c.entities!.some(e => e.category === category && e.label === label)
          })
        })
      }

      // Apply campaign filters (a unit's tag covers its exact-copy members)
      if (state.filters.campaigns?.length) {
        const wanted = new Set(state.filters.campaigns.map(Number))
        filtered = filtered.filter(c => c.campaignId !== undefined && wanted.has(c.campaignId))
      }

      // Apply submitter type filters
      if (state.filters.submitterTypes?.length > 0) {
        filtered = filtered.filter(c =>
          state.filters.submitterTypes.includes(c.submitterType)
        )
      }

      console.log(`Total filtering time: ${(performance.now() - startTime).toFixed(2)}ms (${state.units.length} → ${filtered.length} comments)`)
      return filtered
    },

    getCommentsForTheme: (themeCode: string) => {
      const state = get()
      const commentIds = state.themeIndex[themeCode]
      if (!commentIds) return { direct: [], touches: [] }
      const find = (ids: string[]) => ids.map(id => state.commentsById.get(id)).filter((c): c is Comment => c !== undefined)
      return { direct: find(commentIds.direct || []), touches: find(commentIds.touches || []) }
    },

    getCommentsForEntity: (category: string, label: string) => {
      const state = get()
      const commentIds = state.entityIndex[`${category}|${label}`] || []
      return commentIds
        .map(id => state.commentsById.get(id))
        .filter((c): c is Comment => c !== undefined)
    },

    getCommentById: (commentId: string) => get().commentsById.get(commentId)
  }
})

export default useStore

// Turn comments-index.json into in-memory comments. Form-letter members share their
// representative's summary, themes and content shards rather than carrying copies.
function expandCommentsIndex(index: CommentsIndexFile) {
  const entityObjects = index.entityKeys.map(key => {
    const sep = key.indexOf('|')
    return { category: key.slice(0, sep), label: key.slice(sep + 1) }
  })
  const comments: Comment[] = index.comments.map(raw => {
    const c: Comment = {
      id: raw.id,
      documentId: index.documentId,
      submitter: raw.submitter,
      submitterType: index.submitterTypes[raw.submitterType] ?? 'Unknown',
      date: raw.date,
      location: raw.location,
      hasAttachments: !!raw.hasAttachments,
      wordCount: raw.wordCount,
      clusterSize: raw.clusterSize || 1,
      isClusterRepresentative: index.clustered ? !raw.rep : undefined,
      clusterRepresentativeId: index.clustered ? (raw.rep || raw.id) : null,
      detailShard: raw.detailShard,
      textShard: raw.textShard,
    }
    if (raw.summary) c.structuredSections = { oneLineSummary: raw.summary }
    if (raw.themes) {
      c.themeScores = {}
      for (const code of raw.themes) c.themeScores[code] = 1
    }
    if (raw.entities) c.entities = raw.entities.map(i => entityObjects[i])
    if (raw.campaign !== undefined) {
      c.campaignId = raw.campaign
      if (raw.campaignParaphrase) c.campaignParaphrase = true
    }
    if (raw.addedWords) {
      c.addedWords = raw.addedWords
      c.addedSnippet = raw.addedSnippet
    }
    return c
  })
  const commentsById = new Map(comments.map(c => [c.id, c]))

  // Members: borrow the representative's summary, word count and content shards
  for (const c of comments) {
    if (c.isClusterRepresentative !== false) continue
    const rep = commentsById.get(c.clusterRepresentativeId!)
    if (!rep) continue
    c.clusterSize = rep.clusterSize
    c.wordCount = rep.wordCount
    c.detailShard = rep.detailShard
    c.textShard = rep.textShard
    if (rep.structuredSections) {
      c.structuredSections = rep.structuredSections
      c.isAlignedSummary = true
    }
  }

  // Word-count percentile among all comments
  const sorted = comments.map(c => c.wordCount || 0).sort((a, b) => a - b)
  const firstIndex = new Map<number, number>()
  sorted.forEach((wc, i) => { if (!firstIndex.has(wc)) firstIndex.set(wc, i) })
  for (const c of comments) {
    const wc = c.wordCount || 0
    c.wordCount = wc
    c.percentile = sorted.length > 1 ? Math.round((firstIndex.get(wc)! / (sorted.length - 1)) * 100) : 100
  }

  const units = index.clustered ? comments.filter(c => c.isClusterRepresentative) : comments
  return { comments, commentsById, units }
}

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
