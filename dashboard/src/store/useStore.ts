import { create } from 'zustand'
import type { FiledAs, Meta, Theme, Entity, Comment, ThemeIndex, EntityIndex, ThemeSummary, ThemeExtract, CommentsIndexFile, Campaign, OverviewData, ScopeInfo, ScopeUnitsFile, CompositionCounts } from '../types'
import { ownData, sharedData, setSharedDataBase } from '../utils/dataPaths'
import { parseThemeDescription, commentPart } from '../utils/helpers'
import { parseSearchQuery, buildSearchText, matchesSearchText, type SearchToken } from '../utils/searchParser'
import { loadSearchIndex, peekSearchIndex, matchPhrases, searchWithIndex, verifyCandidates } from '../utils/fullTextSearch'

interface FilterOptions {
  themes: string[]
  entities: string[]
  submitterTypes: string[] // commenter type labels
  filedAs?: string[] // organization | person | anonymous
  states?: string[]
  campaigns?: string[] // campaign ids
  parts?: string[] // Overview composition parts (campaignCopies, campaignReworded, typed, attached)
  searchQuery: string
}

// Filters on what each submission is (its own type, filing, state, composition part) rather than
// on a unit's content. A unit matches when any of its submissions (itself and its form-letter
// members) passes all of them, the same way the Overview counts submissions.
const SUBMISSION_FILTERS = ['parts', 'submitterTypes', 'filedAs', 'states'] as const
export function submissionPredicate(f: FilterOptions): ((c: Comment) => boolean) | null {
  const parts = f.parts?.length ? new Set(f.parts) : null
  const types = f.submitterTypes?.length ? new Set(f.submitterTypes) : null
  const filed = f.filedAs?.length ? new Set(f.filedAs) : null
  const states = f.states?.length ? new Set(f.states) : null
  if (!parts && !types && !filed && !states) return null
  return c => (!parts || parts.has(commentPart(c))) && (!types || types.has(c.submitterType))
    && (!filed || (!!c.filedAs && filed.has(c.filedAs))) && (!states || (!!c.state && states.has(c.state)))
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
  units: Comment[] // comments with their own content: representatives, or all without clustering (in a scope sub-site: in-scope units only)
  // Scope sub-site: the scope (null on a docket site), every unit of the docket, and whether the
  // comment browser searches in-scope units (default) or the whole docket
  scope: ScopeInfo | null
  docketUnits: Comment[]
  docketComments: Comment[]
  commentScope: 'scope' | 'docket'
  campaigns: Campaign[]
  campaignsById: Map<number, Campaign>
  overview: OverviewData | null
  hasClustering: boolean
  typeSource: 'ai' | 'filed'
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
  setCommentScope: (which: 'scope' | 'docket') => void
  setData: (data: any) => void
  setSelectedView: (view: string) => void
  setSelectedTheme: (theme: Theme | null) => void
  setSelectedEntity: (entity: { category: string; label: string } | null) => void

  // Computed
  getCommentsForTheme: (themeCode: string) => { direct: Comment[], touches: Comment[] }
  getCommentsForEntity: (category: string, label: string) => Comment[]
  getFilteredComments: () => Comment[]
  // Per browsed unit, how many of its comments (itself and its form-letter members) fall in each
  // Overview composition part
  getUnitParts: () => Map<string, CompositionCounts>
  // With submission filters active (type, filed as, state, part): per browsed unit, how many of its
  // submissions match them all; null when none are active
  getSubmissionMatches: () => Map<string, number> | null
  getCommentById: (commentId: string) => Comment | undefined
}

let searchGeneration = 0
let submissionMatchCache: { all: Comment[]; key: string; map: Map<string, number> } | null = null
const unitPartsCache = new WeakMap<Comment[], Map<string, CompositionCounts>>()
const themeExtractRequests = new Map<string, Promise<void>>()

const useStore = create<StoreState>((set, get) => {
  // Run a text search: instant pass over up-front fields (until the full-text index has loaded),
  // then the full-text index, then verification of phrase candidates against fetched text
  async function runSearch(query: string) {
    const gen = ++searchGeneration
    const tokens = parseSearchQuery(query)
    if (!query || tokens.length === 0) {
      set({ search: { query, ids: null, phase: 'idle' } })
      return
    }
    const units = browsedUnits(get())
    let leanIds: Set<string> | null = null
    let ix = peekSearchIndex()
    if (!ix) {
      leanIds = new Set(units.filter(c => matchesLeanText(c, tokens)).map(c => c.id))
      set({ search: { query, ids: leanIds, phase: 'index' } })
    }

    let phrases
    try {
      ix ??= await loadSearchIndex()
      if (gen !== searchGeneration) return
      // Phrase lookups in the optional pair index; without it phrases are verified against text
      phrases = await matchPhrases(ix, tokens).catch(err => {
        console.warn('Pair index unavailable:', err)
        return undefined
      })
    } catch (err) {
      if (gen === searchGeneration) {
        leanIds ??= new Set(units.filter(c => matchesLeanText(c, tokens)).map(c => c.id))
        set({ search: { query, ids: leanIds, phase: 'error', error: `Full-text index unavailable (${err}); showing matches on summaries and names only` } })
      }
      return
    }
    if (gen !== searchGeneration) return

    const t0 = performance.now()
    const { matches, toVerify } = searchWithIndex(ix, tokens, units, phrases)
    console.log(`Index search "${query}": ${matches.size} matches, ${toVerify.size} to verify (${(performance.now() - t0).toFixed(1)}ms)`)
    if (toVerify.size === 0) {
      set({ search: { query, ids: matches, phase: 'done' } })
      return
    }

    // Show definite matches plus unverified candidates; drop candidates that fail verification.
    // Progress reaches the store at most every 250 ms, as each update re-filters and re-renders.
    const ids = new Set([...matches, ...toVerify])
    let pending = toVerify.size
    let progress = { done: 0, total: 1 }
    set({ search: { query, ids, phase: 'verify', pending, progress } })
    let lastFlush = performance.now()
    let idsChanged = false
    const flush = (force = false) => {
      if (gen !== searchGeneration || (!force && performance.now() - lastFlush < 250)) return
      lastFlush = performance.now()
      const changed = idsChanged
      idsChanged = false
      set(state => ({ search: { ...state.search, ...(changed ? { ids: new Set(ids) } : {}), pending, progress } }))
    }
    const candidates = units.filter(c => toVerify.has(c.id))
    const t1 = performance.now()
    try {
      await verifyCandidates(
        candidates,
        tokens,
        (matched, rejected) => {
          if (gen !== searchGeneration) return
          for (const id of rejected) ids.delete(id)
          if (rejected.length) idsChanged = true
          pending -= matched.length + rejected.length
          flush()
        },
        p => {
          progress = p
          flush()
        },
        () => gen !== searchGeneration,
      )
    } catch (err) {
      if (gen === searchGeneration) {
        flush(true)
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
    scope: null,
    docketUnits: [],
    docketComments: [],
    commentScope: 'scope',
    campaigns: [],
    campaignsById: new Map(),
    overview: null,
    hasClustering: false,
    typeSource: 'filed',
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
      filedAs: [],
      states: [],
      campaigns: [],
      parts: [],
      searchQuery: ''
    },

    // Actions
    setData: (data: any) => set(data),
    setSelectedView: (view: string) => set({ selectedView: view }),
    setSelectedTheme: (theme: Theme | null) => set({ selectedTheme: theme }),
    setSelectedEntity: (entity: { category: string; label: string } | null) => set({ selectedEntity: entity }),
    setSearchQuery: (query: string) => set({ searchQuery: query }),
    setCommentScope: (which: 'scope' | 'docket') => {
      if (which === get().commentScope) return
      set({ commentScope: which })
      const q = get().filters.searchQuery
      if (q) runSearch(q)
    },
    setFilters: (filters: FilterOptions | ((prev: FilterOptions) => FilterOptions)) => {
      const prev = get().filters
      const next = typeof filters === 'function' ? filters(prev) : filters
      set({ filters: next })
      if (next.searchQuery !== get().search.query) runSearch(next.searchQuery)
    },

    loadThemeExtracts: (themeCode: string) => {
      if (get().themeExtracts[themeCode]) return Promise.resolve()
      // No file is written for a theme without direct extracts (e.g. a group theme); skip the 404
      if (get().themes.find(t => t.code === themeCode)?.direct_count === 0) {
        set(state => ({ themeExtracts: { ...state.themeExtracts, [themeCode]: {} } }))
        return Promise.resolve()
      }
      let p = themeExtractRequests.get(themeCode)
      if (!p) {
        p = fetch(ownData(`theme-extracts/${encodeURIComponent(themeCode)}.json`))
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
        // A scope sub-site's meta.json says where the docket's shared files are
        const meta: Meta = await getJson(ownData('meta.json'))
        setSharedDataBase(meta.sharedData)
        const scoped = !!meta.scope
        const [themes, themeSummaries, entities, index, campaigns, overview, scope, scopeUnits] = await Promise.all([
          getJson(ownData('themes.json')),
          getJson(ownData('theme-summaries.json')),
          getJson(sharedData('entities.json')),
          getJson(sharedData('comments-index.json')) as Promise<CommentsIndexFile>,
          // Optional: only present when tag-campaigns ran
          (getJson(sharedData('campaigns.json')) as Promise<Campaign[]>).catch(() => [] as Campaign[]),
          // Optional: older builds lack it; the Overview falls back to the index
          (getJson(ownData('overview.json')) as Promise<OverviewData>).catch(() => null),
          scoped ? getJson(ownData('scope.json')) as Promise<ScopeInfo> : Promise.resolve(null),
          scoped ? getJson(ownData('scope-units.json')) as Promise<ScopeUnitsFile> : Promise.resolve(null),
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
        const expanded = expandCommentsIndex(index)
        const { commentsById } = expanded
        let { comments, units } = expanded
        const docketUnits = units
        let scopedEntities = entities
        let scopedCampaigns = campaigns
        if (scope && scopeUnits) {
          ;({ comments, units } = applyScope(expanded.comments, commentsById, scopeUnits))
          scopedEntities = scopeEntities(entities, units)
          scopedCampaigns = scopeCampaigns(campaigns, comments)
        }

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
          entities: scopedEntities,
          comments,
          commentsById,
          units,
          scope,
          docketUnits,
          docketComments: expanded.comments,
          campaigns: scopedCampaigns,
          campaignsById: new Map(scopedCampaigns.map(c => [c.id, c])),
          overview,
          hasClustering: index.clustered,
          typeSource: index.typeSource || 'filed',
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

      // Start with only representative comments (or all if no clustering); in a scope sub-site,
      // in-scope units unless the browser is set to the whole docket
      let filtered = browsedUnits(state)

      // Apply search with boolean query parsing (results come from runSearch)
      if (state.filters.searchQuery) {
        const ids = state.search.query === state.filters.searchQuery ? state.search.ids : null
        if (ids) {
          filtered = filtered.filter(c => ids.has(c.id))
        } else {
          const tokens = parseSearchQuery(state.filters.searchQuery)
          if (tokens.length > 0) filtered = filtered.filter(c => matchesLeanText(c, tokens))
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

      // Submission filters (type, filed as, state, composition part): units with at least one
      // submission that passes them all
      const matches = state.getSubmissionMatches()
      if (matches) filtered = filtered.filter(c => (matches.get(c.id) || 0) > 0)

      console.log(`Total filtering time: ${(performance.now() - startTime).toFixed(2)}ms (${browsedUnits(state).length} → ${filtered.length} comments)`)
      return filtered
    },

    getUnitParts: () => {
      const state = get()
      const all = state.scope && state.commentScope === 'docket' ? state.docketComments : state.comments
      let m = unitPartsCache.get(all)
      if (!m) {
        m = new Map()
        for (const c of all) {
          const unit = c.isClusterRepresentative === false ? c.clusterRepresentativeId! : c.id
          let n = m.get(unit)
          if (!n) m.set(unit, n = { campaignCopies: 0, campaignReworded: 0, typed: 0, attached: 0 })
          n[commentPart(c)]++
        }
        unitPartsCache.set(all, m)
      }
      return m
    },

    getSubmissionMatches: () => {
      const state = get()
      const test = submissionPredicate(state.filters)
      if (!test) return null
      const all = state.scope && state.commentScope === 'docket' ? state.docketComments : state.comments
      const key = JSON.stringify(SUBMISSION_FILTERS.map(k => state.filters[k] || []))
      if (submissionMatchCache && submissionMatchCache.all === all && submissionMatchCache.key === key) return submissionMatchCache.map
      const map = new Map<string, number>()
      for (const c of all) {
        if (!test(c)) continue
        const unit = c.isClusterRepresentative === false ? c.clusterRepresentativeId! : c.id
        map.set(unit, (map.get(unit) || 0) + 1)
      }
      submissionMatchCache = { all, key, map }
      return map
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

// Search over the up-front fields (summary, submitter, ID) before the full-text index is loaded
const leanTexts = new WeakMap<Comment, string>()
function matchesLeanText(c: Comment, tokens: SearchToken[]): boolean {
  let text = leanTexts.get(c)
  if (text === undefined) leanTexts.set(c, text = buildSearchText(c))
  return matchesSearchText(text, tokens)
}

// The units the comment browser and search work over
function browsedUnits(state: { scope: ScopeInfo | null; commentScope: 'scope' | 'docket'; units: Comment[]; docketUnits: Comment[] }): Comment[] {
  return state.scope && state.commentScope === 'docket' ? state.docketUnits : state.units
}

// Scope sub-site: mark in-scope comments, attach the relevance excerpt, and replace the docket's
// theme codes with the scope's (the two taxonomies share codes like "1.2" but mean different things).
// A form-letter group's relevance, judged on its representative, applies to its members.
function applyScope(all: Comment[], byId: Map<string, Comment>, scopeUnits: ScopeUnitsFile) {
  for (const c of all) {
    const isMember = c.isClusterRepresentative === false
    const u = scopeUnits.units[isMember ? c.clusterRepresentativeId! : c.id]
    delete c.themeScores
    c.inScope = !!u
    if (!u || isMember) continue
    if (u.excerpt) c.scopeExcerpt = u.excerpt
    if (u.note) c.scopeNote = u.note
    if (u.seed) c.scopeSeed = true
    if (u.themes?.length) {
      c.themeScores = {}
      for (const code of u.themes) c.themeScores[code] = 1
    }
  }
  // Units missing from the index (shouldn't happen) are ignored
  for (const id of Object.keys(scopeUnits.units)) if (!byId.has(id)) console.warn(`Scope unit ${id} not in the comment index`)
  const comments = all.filter(c => c.inScope)
  const units = comments.filter(c => c.isClusterRepresentative !== false)
  return { comments, units }
}

// The docket's topics, counted over in-scope units (by submissions); topics with none are dropped
function scopeEntities(entities: Record<string, Entity[]>, units: Comment[]): Record<string, Entity[]> {
  const counts = new Map<string, number>()
  for (const c of units) for (const e of c.entities || []) {
    const k = `${e.category}|${e.label}`
    counts.set(k, (counts.get(k) || 0) + (c.clusterSize || 1))
  }
  const out: Record<string, Entity[]> = {}
  for (const [category, list] of Object.entries(entities)) {
    const kept = list
      .map(e => ({ ...e, mentionCount: counts.get(`${category}|${e.label}`) || 0 }))
      .filter(e => e.mentionCount > 0)
      .sort((a, b) => b.mentionCount - a.mentionCount)
    if (kept.length) out[category] = kept
  }
  return out
}

// The docket's campaigns, counted over in-scope comments; campaigns with none are dropped
function scopeCampaigns(campaigns: Campaign[], comments: Comment[]): Campaign[] {
  const n = new Map<number, { total: number; para: number; units: number }>()
  for (const c of comments) {
    if (c.campaignId === undefined) continue
    let x = n.get(c.campaignId); if (!x) n.set(c.campaignId, x = { total: 0, para: 0, units: 0 })
    x.total++
    if (c.campaignParaphrase) x.para++
    if (c.isClusterRepresentative !== false) x.units++
  }
  return campaigns
    .filter(k => n.has(k.id))
    .map(k => { const x = n.get(k.id)!; return { ...k, total: x.total, paraphrased: x.para, exact: x.total - x.para, units: x.units } })
    .sort((a, b) => b.total - a.total || a.id - b.id)
}

// Turn comments-index.json into in-memory comments. Form-letter members share their
// representative's summary, themes and content shards rather than carrying copies.
function expandCommentsIndex(index: CommentsIndexFile) {
  const entityObjects = index.entityKeys.map(key => {
    const sep = key.indexOf('|')
    return { category: key.slice(0, sep), label: key.slice(sep + 1) }
  })
  const FILED: Record<string, FiledAs> = { o: 'organization', p: 'person', a: 'anonymous' }
  const comments: Comment[] = index.comments.map(raw => {
    const state = raw.state !== undefined ? index.states?.[raw.state] : undefined
    const country = raw.country !== undefined ? index.countries?.[raw.country] : undefined
    const c: Comment = {
      id: raw.id,
      documentId: index.documentId,
      submitter: raw.submitter,
      submitterType: index.submitterTypes[raw.submitterType] ?? 'Not specified',
      date: raw.date,
      location: raw.location ?? ([raw.city, state, country].filter(Boolean).join(', ') || undefined),
      hasAttachments: !!raw.hasAttachments,
      wordCount: raw.wordCount,
      clusterSize: raw.clusterSize || 1,
      isClusterRepresentative: index.clustered ? !raw.rep : undefined,
      clusterRepresentativeId: index.clustered ? (raw.rep || raw.id) : null,
      detailShard: raw.detailShard,
      textShard: raw.textShard,
    }
    const group = index.typeGroups?.[raw.submitterType]
    if (group) c.typeGroup = group
    if (raw.filedAs) c.filedAs = FILED[raw.filedAs]
    if (raw.nameFromTitle) c.nameFromTitle = true
    if (raw.org) c.org = raw.org
    if (raw.city) c.city = raw.city
    if (state) c.state = state
    if (country) c.country = country
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
