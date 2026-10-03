import { useState, useMemo, useEffect, useCallback, useRef, useTransition, useDeferredValue } from 'react'
import { useSearchParams } from 'react-router-dom'
import { MessageSquare, Copy, Search, X, HelpCircle, Loader2 } from 'lucide-react'
import useStore, { submissionPredicate } from '../store/useStore'
import type { Comment } from '../types'
import CommentCard from './CommentCard'
import CopyCommentsModal from './CopyCommentsModal'
import ActiveFilterChips from './ActiveFilterChips'
import FilterAddButtons from './FilterAddButtons'
import InlineFilterDropdown from './InlineFilterDropdown'
import SearchHelpModal from './SearchHelpModal'
import { parseSearchQuery, tokensToString, removeToken } from '../utils/searchParser'
import { debounce } from 'lodash'
import type { PickerItem } from './FilterAddButtons'
import { PARTS, partLabel, FILED_AS_LABELS } from './overview/overviewData'

interface FilterOptions {
  themes: string[]
  entities: string[]
  submitterTypes: string[]
  filedAs?: string[]
  states?: string[]
  campaigns?: string[]
  parts?: string[]
  searchQuery: string
}

type PrefixType = 'theme' | 'entity' | 'type' | 'campaign'

interface PrefixDetection {
  type: PrefixType
  filterText: string
  prefixStart: number
}

const PREFIX_REGEX = /(?:^|\s)(theme|entity|type|campaign):(.*)$/i

function detectPrefix(query: string, cursorPos: number): PrefixDetection | null {
  const textToCursor = query.slice(0, cursorPos)
  const match = textToCursor.match(PREFIX_REGEX)
  if (!match) return null
  const prefixStart = match.index! + (match[0][0] === ' ' ? 1 : 0)
  return {
    type: match[1].toLowerCase() as PrefixType,
    filterText: match[2],
    prefixStart,
  }
}

function CommentBrowser() {
  const { loading, comments = [], filters, setFilters, getFilteredComments, themes = [], entities = {}, search, hasClustering, campaigns = [], scope, commentScope, setCommentScope, meta, getSubmissionMatches, typeSource } = useStore()
  const wholeDocket = !!scope && commentScope === 'docket'
  const docketTotal = scope?.counts.docketSubmissions ?? 0
  const [searchParams] = useSearchParams()
  const [page, setPage] = useState(0)
  const [showCopyModal, setShowCopyModal] = useState(false)
  const [localSearchQuery, setLocalSearchQuery] = useState(filters?.searchQuery || '')
  const PAGE_SIZE_OPTIONS = [50, 100, 250, 500, 1000, 1500, 2000]
  const [itemsPerPage, setItemsPerPage] = useState(100)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const searchContainerRef = useRef<HTMLDivElement>(null)
  const [, startTransition] = useTransition()

  // Inline prefix picker state
  const [inlinePickerType, setInlinePickerType] = useState<PrefixType | null>(null)
  const [inlineFilterText, setInlineFilterText] = useState('')
  const [inlineHighlightIndex, setInlineHighlightIndex] = useState(0)
  const [prefixStart, setPrefixStart] = useState(0)
  const [showHelp, setShowHelp] = useState(false)

  // Parse search tokens from local query
  const searchTokens = useMemo(
    () => parseSearchQuery(localSearchQuery),
    [localSearchQuery]
  )

  // Debounced search handler — called directly from onChange, not via useEffect. While a quoted
  // phrase is still open, wait for a longer pause: each partial phrase is a new search.
  const debouncedSetSearchQuery = useMemo(() => {
    const apply = (query: string) => {
      if (setFilters) {
        startTransition(() => {
          setFilters((prev: FilterOptions) => ({ ...prev, searchQuery: query }))
          setPage(0)
        })
      }
    }
    const soon = debounce(apply, 300)
    const later = debounce(apply, 1000)
    const run = (query: string) => {
      const openQuote = (query.match(/"/g) || []).length % 2 === 1
      ;(openQuote ? soon : later).cancel()
      ;(openQuote ? later : soon)(query)
    }
    run.cancel = () => { soon.cancel(); later.cancel() }
    return run
  }, [setFilters])

  // Apply URL query parameters on mount
  useEffect(() => {
    // Links from the Overview and elsewhere: ?submitterType=, ?filedAs=, ?state= (repeatable),
    // ?campaign=, ?part=. Arriving with any of them replaces the structured filters, so the list
    // shows exactly what the link counted.
    const submitterTypes = searchParams.getAll('submitterType')
    const filedAs = searchParams.getAll('filedAs')
    const states = searchParams.getAll('state')
    const campaign = searchParams.get('campaign')
    const part = searchParams.get('part')
    const parts = part && PARTS.some(p => p.key === part) ? [part] : []
    if (submitterTypes.length || filedAs.length || states.length || campaign || parts.length) {
      setFilters((prev: FilterOptions) => ({
        ...prev, themes: [], entities: [], submitterTypes, filedAs, states, campaigns: campaign ? [campaign] : [], parts,
      }))
    }
  }, [searchParams, setFilters])

  // Global keyboard shortcuts
  useEffect(() => {
    function handleGlobalKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return

      if (e.key === '/') {
        e.preventDefault()
        searchInputRef.current?.focus()
      }
      if (e.key === '?') {
        e.preventDefault()
        setShowHelp(true)
      }
    }
    document.addEventListener('keydown', handleGlobalKey)
    return () => document.removeEventListener('keydown', handleGlobalKey)
  }, [])

  // Close inline picker on click outside
  useEffect(() => {
    if (!inlinePickerType) return
    function handleClick(e: MouseEvent) {
      if (searchContainerRef.current && !searchContainerRef.current.contains(e.target as Node)) {
        closeInlinePicker()
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [inlinePickerType])

  // Memoize filtered comments — only recompute when store filters change (after debounce),
  // not on every keystroke in the search input
  const filteredComments = useMemo(() => {
    if (!getFilteredComments) return []
    return getFilteredComments()
  }, [getFilteredComments, filters, search, commentScope])

  // Picker values with their submission counts, largest first
  const countBy = useCallback((key: (c: typeof comments[number]) => string | undefined) => {
    const counts = new Map<string, number>()
    for (const c of comments) { const k = key(c); if (k) counts.set(k, (counts.get(k) || 0) + 1) }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([value, count]) => ({ value, count }))
  }, [comments])
  const availableSubmitterTypes = useMemo(() => countBy(c => c.submitterType), [countBy])
  const availableFiledAs = useMemo(() => typeSource === 'ai' ? [] : countBy(c => c.filedAs), [countBy, typeSource])
  const availableStates = useMemo(() => countBy(c => c.state), [countBy])

  // Pagination — memoize so keystroke re-renders don't recompute
  const { totalPages, paginatedComments } = useMemo(() => {
    const tp = Math.ceil(filteredComments.length / itemsPerPage)
    const pc = filteredComments.slice(page * itemsPerPage, (page + 1) * itemsPerPage)
    return { totalPages: tp, paginatedComments: pc }
  }, [filteredComments, page, itemsPerPage])

  const commentsToCopy = filteredComments

  const unitNoun = (hasClustering ? 'cluster' : 'comment') + (filteredComments.length === 1 ? '' : 's')
  // Submissions the listed units stand for (a form-letter group counts all its members)
  const representedCount = useMemo(() => filteredComments.reduce((n, c) => n + (c.clusterSize || 1), 0), [filteredComments])

  // With submission filters (type, filed as, state, part), how many submissions among the listed
  // units match them: the number the Overview shows for the same selection
  const activeParts = filters?.parts || []
  const matchedCount = useMemo(() => {
    const matches = getSubmissionMatches()
    if (!matches) return null
    let n = 0
    for (const c of filteredComments) n += matches.get(c.id) || 0
    return n
  }, [filteredComments, getSubmissionMatches, filters, commentScope])
  const partName = (key: string) => {
    const p = PARTS.find(x => x.key === key)
    return p ? partLabel(p, campaigns.length > 0) : key
  }

  // A form-letter group listed only because some of its copies match the submission filters
  // (type, filed as, state, part): say so, since the card shows the representative's own details
  const matchNoteFor = useMemo(() => {
    const test = filters ? submissionPredicate(filters) : null
    const matches = test ? getSubmissionMatches() : null
    return (c: Comment): string | undefined => {
      if (!test || !matches || test(c) || !c.clusterSize || c.clusterSize < 2) return undefined
      const n = matches.get(c.id) || 0
      return n ? `Listed because ${n.toLocaleString()} of its ${c.clusterSize.toLocaleString()} copies match your filters; the details below are the original letter's.` : undefined
    }
  }, [filters, getSubmissionMatches, commentScope])

  // Memoize the comment list JSX — this is the expensive part. Rendered from a deferred copy so
  // a new result list renders in the background without blocking typing.
  const listedComments = useDeferredValue(paginatedComments)
  const commentListJsx = useMemo(() => (
    listedComments.length > 0 ? (
      listedComments.map(comment => (
        <CommentCard
          key={comment.id}
          comment={comment}
          showThemes={false}
          showEntities={false}
          matchNote={matchNoteFor(comment)}
        />
      ))
    ) : (
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8 text-center">
        <p className="text-gray-500">No comments match your filters</p>
      </div>
    )
  ), [listedComments, matchNoteFor])

  // Build inline picker items for the active prefix type
  const inlinePickerItems = useMemo((): PickerItem[] => {
    if (!inlinePickerType) return []
    const q = inlineFilterText.toLowerCase()

    switch (inlinePickerType) {
      case 'theme':
        return themes
          .filter(t => t.comment_count > 0)
          .map(t => ({
            key: t.code,
            label: `${t.code} ${t.label || t.description}`,
            count: t.direct_count,
            selected: (filters?.themes || []).includes(t.code),
          }))
          .filter(item => !q || item.label.toLowerCase().includes(q))

      case 'entity':
        return Object.entries(entities).flatMap(([category, entityList]) =>
          entityList
            .filter(e => e.mentionCount > 0)
            .map(e => ({
              key: `${category}|${e.label}`,
              label: e.label,
              sublabel: category,
              count: e.mentionCount,
              selected: (filters?.entities || []).includes(`${category}|${e.label}`),
            }))
        ).filter(item => !q || item.label.toLowerCase().includes(q) || (item.sublabel?.toLowerCase().includes(q) ?? false))

      case 'type':
        return availableSubmitterTypes
          .map(t => ({
            key: t.value,
            label: t.value,
            count: t.count,
            selected: (filters?.submitterTypes || []).includes(t.value),
          }))
          .filter(item => !q || item.label.toLowerCase().includes(q))

      case 'campaign':
        return campaigns
          .map(c => ({
            key: String(c.id),
            label: c.name,
            count: c.total,
            selected: (filters?.campaigns || []).includes(String(c.id)),
          }))
          .filter(item => !q || item.label.toLowerCase().includes(q))

      default:
        return []
    }
  }, [inlinePickerType, inlineFilterText, themes, entities, availableSubmitterTypes, filters, campaigns])

  // Reset highlight when items change
  useEffect(() => {
    setInlineHighlightIndex(0)
  }, [inlinePickerItems])

  const closeInlinePicker = useCallback(() => {
    setInlinePickerType(null)
    setInlineFilterText('')
    setInlineHighlightIndex(0)
  }, [])

  const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value
    setLocalSearchQuery(value)

    const cursorPos = e.target.selectionStart ?? value.length
    const prefix = detectPrefix(value, cursorPos)

    if (prefix) {
      setInlinePickerType(prefix.type)
      setInlineFilterText(prefix.filterText)
      setPrefixStart(prefix.prefixStart)
      // Send only the text before the prefix to the search filter
      const cleanQuery = value.slice(0, prefix.prefixStart).trimEnd()
      debouncedSetSearchQuery(cleanQuery)
    } else {
      closeInlinePicker()
      debouncedSetSearchQuery(value)
    }
  }, [debouncedSetSearchQuery, closeInlinePicker])

  const handleFilterChange = useCallback((type: string, value: any) => {
    if (setFilters) {
      startTransition(() => {
        setFilters((prev: FilterOptions) => ({ ...prev, [type]: value }))
        setPage(0)
      })
    }
  }, [setFilters])

  const handleRemoveSearchToken = useCallback((tokenId: string) => {
    debouncedSetSearchQuery.cancel()
    const updated = removeToken(searchTokens, tokenId)
    const newQuery = tokensToString(updated)
    setLocalSearchQuery(newQuery)
    startTransition(() => {
      setFilters((prev: FilterOptions) => ({ ...prev, searchQuery: newQuery }))
      setPage(0)
    })
  }, [searchTokens, debouncedSetSearchQuery, setFilters])

  const handleClickSearchToken = useCallback((token: { startIndex: number; endIndex: number }) => {
    if (searchInputRef.current) {
      searchInputRef.current.focus()
      searchInputRef.current.setSelectionRange(token.startIndex, token.endIndex)
    }
  }, [])

  const handleToggleTheme = useCallback((code: string) => {
    const current = filters?.themes || []
    const updated = current.includes(code)
      ? current.filter((c: string) => c !== code)
      : [...current, code]
    handleFilterChange('themes', updated)
  }, [filters?.themes, handleFilterChange])

  const handleToggleEntity = useCallback((key: string) => {
    const current = filters?.entities || []
    const updated = current.includes(key)
      ? current.filter((k: string) => k !== key)
      : [...current, key]
    handleFilterChange('entities', updated)
  }, [filters?.entities, handleFilterChange])

  const handleToggleSubmitterType = useCallback((value: string) => {
    const current = filters?.submitterTypes || []
    const updated = current.includes(value)
      ? current.filter((v: string) => v !== value)
      : [...current, value]
    handleFilterChange('submitterTypes', updated)
  }, [filters?.submitterTypes, handleFilterChange])

  const toggleIn = useCallback((key: 'filedAs' | 'states', value: string) => {
    const current = filters?.[key] || []
    handleFilterChange(key, current.includes(value) ? current.filter((v: string) => v !== value) : [...current, value])
  }, [filters?.filedAs, filters?.states, handleFilterChange])

  const handleToggleCampaign = useCallback((id: string) => {
    const current = filters?.campaigns || []
    const updated = current.includes(id) ? current.filter((v: string) => v !== id) : [...current, id]
    handleFilterChange('campaigns', updated)
  }, [filters?.campaigns, handleFilterChange])

  const handleInlineSelect = useCallback((key: string) => {
    if (!inlinePickerType) return

    // Remove the prefix text from the search query
    const before = localSearchQuery.slice(0, prefixStart).trimEnd()
    setLocalSearchQuery(before)
    debouncedSetSearchQuery(before)

    // Add the structured filter
    switch (inlinePickerType) {
      case 'theme': handleToggleTheme(key); break
      case 'entity': handleToggleEntity(key); break
      case 'type': handleToggleSubmitterType(key); break
      case 'campaign': handleToggleCampaign(key); break
    }

    closeInlinePicker()
    setTimeout(() => searchInputRef.current?.focus(), 0)
  }, [inlinePickerType, localSearchQuery, prefixStart, debouncedSetSearchQuery, closeInlinePicker, handleToggleTheme, handleToggleEntity, handleToggleSubmitterType, handleToggleCampaign])

  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!inlinePickerType || inlinePickerItems.length === 0) return

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setInlineHighlightIndex(i => (i + 1) % inlinePickerItems.length)
        break
      case 'ArrowUp':
        e.preventDefault()
        setInlineHighlightIndex(i => (i - 1 + inlinePickerItems.length) % inlinePickerItems.length)
        break
      case 'Enter':
      case 'Tab':
        e.preventDefault()
        if (inlinePickerItems[inlineHighlightIndex]) {
          handleInlineSelect(inlinePickerItems[inlineHighlightIndex].key)
        }
        break
      case 'Escape':
        e.preventDefault()
        closeInlinePicker()
        break
    }
  }, [inlinePickerType, inlinePickerItems, inlineHighlightIndex, handleInlineSelect, closeInlinePicker])

  const handleClearAll = useCallback(() => {
    debouncedSetSearchQuery.cancel()
    setLocalSearchQuery('')
    closeInlinePicker()
    startTransition(() => {
      setFilters((prev: FilterOptions) => ({
        ...prev,
        submitterTypes: [],
        filedAs: [],
        states: [],
        themes: [],
        entities: [],
        campaigns: [],
        parts: [],
        searchQuery: ''
      }))
      setPage(0)
    })
  }, [setFilters, debouncedSetSearchQuery, closeInlinePicker])

  if (loading || !filters) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading comments...</div>
      </div>
    )
  }

  const inlinePickerLabel = inlinePickerType === 'theme' ? 'Select theme...'
    : inlinePickerType === 'entity' ? 'Select entity...'
    : inlinePickerType === 'type' ? 'Select submitter type...'
    : inlinePickerType === 'campaign' ? 'Select campaign...'
    : ''

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 sm:p-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3 min-w-0">
            <MessageSquare className="h-6 w-6 text-blue-600 flex-shrink-0" />
            <div className="min-w-0">
              <h1 className="text-xl sm:text-2xl font-bold text-gray-900">{scope ? (wholeDocket ? 'All comments in the docket' : 'Comments in this scope') : 'Browse Comments'}</h1>
              <p className="text-sm text-gray-500 mt-1 truncate sm:whitespace-normal">
                {matchedCount !== null ? (
                  hasClustering || scope
                    ? <>Showing {filteredComments.length.toLocaleString()} {unitNoun} with {matchedCount.toLocaleString()} matching comment{matchedCount === 1 ? '' : 's'}</>
                    : <>Showing {matchedCount.toLocaleString()} of {comments.length.toLocaleString()} comments</>
                ) : scope ? (
                  wholeDocket
                    ? <>Showing {filteredComments.length.toLocaleString()} {unitNoun} from all {docketTotal.toLocaleString()} submissions, in or out of scope</>
                    : <>Showing {filteredComments.length.toLocaleString()} {unitNoun} representing {representedCount.toLocaleString()} of the {comments.length.toLocaleString()} submissions (out of {docketTotal.toLocaleString()}) that address this scope</>
                ) : hasClustering ? (
                  <>Showing {filteredComments.length.toLocaleString()} {unitNoun} representing {representedCount.toLocaleString()} of {comments.length.toLocaleString()} comments</>
                ) : (
                  <>Showing {filteredComments.length.toLocaleString()} of {comments.length.toLocaleString()} comments</>
                )}
              </p>
            </div>
          </div>
          <button
            onClick={() => setShowCopyModal(true)}
            className="flex items-center space-x-2 px-3 sm:px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors flex-shrink-0"
            title="Copy for LLM"
          >
            <Copy className="h-4 w-4" />
            <span className="hidden sm:inline">Copy for LLM</span>
          </button>
        </div>
        {scope && (
          <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
            <span className="text-gray-600" id="comment-scope-label">Search in</span>
            <div role="radiogroup" aria-labelledby="comment-scope-label" className="inline-flex rounded-md border border-gray-300 p-0.5 bg-gray-50">
              {([['scope', 'This scope'], ['docket', 'Whole docket']] as const).map(([value, label]) => (
                <button
                  key={value}
                  role="radio"
                  aria-checked={commentScope === value}
                  onClick={() => { setCommentScope(value); setPage(0) }}
                  className={`px-3 py-1 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${commentScope === value ? 'bg-white shadow-sm text-[#14233c] font-medium' : 'text-gray-600 hover:text-gray-900'}`}
                >
                  {label}
                </button>
              ))}
            </div>
            {wholeDocket && (
              <span className="text-xs text-gray-500">
                Out-of-scope comments carry no scope themes. <a href={meta?.docketUrl ? `${meta.docketUrl}#/comments` : '#'} className="underline hover:text-gray-700">Open the docket's comment browser</a>
              </span>
            )}
          </div>
        )}
      </div>

      {/* Search + Filters */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
        {/* Search Input + Help Button */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1" ref={searchContainerRef}>
            <input
              ref={searchInputRef}
              type="text"
              value={localSearchQuery}
              onChange={handleSearchChange}
              onKeyDown={handleSearchKeyDown}
              placeholder={'Search... "exact phrase"  OR  -exclude  theme:  entity:'}
              className="w-full pl-10 pr-10 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
            <Search className="absolute left-3 top-2.5 h-5 w-5 text-gray-400" />
            {localSearchQuery && (
              <button
                onClick={() => {
                  debouncedSetSearchQuery.cancel()
                  closeInlinePicker()
                  setLocalSearchQuery('')
                  startTransition(() => {
                    setFilters((prev: FilterOptions) => ({ ...prev, searchQuery: '' }))
                    setPage(0)
                  })
                }}
                className="absolute right-3 top-2.5 text-gray-400 hover:text-gray-600"
              >
                <X className="h-5 w-5" />
              </button>
            )}

            {/* Inline prefix picker dropdown */}
            {inlinePickerType && inlinePickerItems.length > 0 && (
              <InlineFilterDropdown
                items={inlinePickerItems}
                highlightIndex={inlineHighlightIndex}
                onSelect={handleInlineSelect}
                onHighlightChange={setInlineHighlightIndex}
                label={inlinePickerLabel}
              />
            )}
          </div>
          <button
            onClick={() => setShowHelp(true)}
            className="flex-shrink-0 w-7 h-7 rounded-full border border-gray-300 text-gray-400 hover:text-gray-600 hover:border-gray-400 flex items-center justify-center transition-colors"
            title="Search help (?)"
          >
            <HelpCircle className="h-4 w-4" />
          </button>
        </div>

        {/* Full-text search progress */}
        {filters.searchQuery && search.query === filters.searchQuery && search.phase !== 'done' && search.phase !== 'idle' && (
          <div className={`mt-2 flex items-center gap-2 text-xs ${search.phase === 'error' ? 'text-red-600' : 'text-gray-500'}`}>
            {search.phase !== 'error' && <Loader2 className="h-3 w-3 animate-spin flex-shrink-0" />}
            {search.phase === 'index' && <span>Showing matches in names and summaries; loading the full-text index…</span>}
            {search.phase === 'verify' && (
              <span>
                Checking exact phrase in {(search.pending ?? 0).toLocaleString()} candidate comments
                {search.progress && search.progress.total > 1 ? ` (${Math.round((search.progress.done / search.progress.total) * 100)}% of text loaded)` : ''}…
              </span>
            )}
            {search.phase === 'error' && <span>{search.error}</span>}
          </div>
        )}

        {/* Active Filter Chips */}
        <ActiveFilterChips
          searchTokens={searchTokens}
          themes={filters.themes || []}
          entities={filters.entities || []}
          submitterTypes={filters.submitterTypes || []}
          typeLabel={typeSource === 'ai' ? 'Commenter type' : 'Category'}
          campaigns={(filters.campaigns || []).map(id => ({ id, name: campaigns.find(c => String(c.id) === id)?.name || `Campaign ${id}` }))}
          onRemoveCampaign={(id) => handleFilterChange('campaigns', (filters.campaigns || []).filter((v: string) => v !== id))}
          parts={[
            ...activeParts.map(key => ({ key, label: partName(key), onRemove: () => handleFilterChange('parts', activeParts.filter((v: string) => v !== key)) })),
            ...(filters.filedAs || []).map(v => ({ key: `filed-${v}`, label: `Filed as: ${FILED_AS_LABELS[v] || v}`, onRemove: () => toggleIn('filedAs', v) })),
            ...(filters.states || []).map(v => ({ key: `state-${v}`, label: `State: ${v}`, onRemove: () => toggleIn('states', v) })),
          ]}
          themeList={themes}
          entityMap={entities}
          onRemoveSearchToken={handleRemoveSearchToken}
          onRemoveTheme={(code) => handleFilterChange('themes', (filters.themes || []).filter((c: string) => c !== code))}
          onRemoveEntity={(key) => handleFilterChange('entities', (filters.entities || []).filter((k: string) => k !== key))}
          onRemoveSubmitterType={(value) => handleFilterChange('submitterTypes', (filters.submitterTypes || []).filter((v: string) => v !== value))}
          onClearAll={handleClearAll}
          onClickSearchToken={handleClickSearchToken}
        />

        {/* Add Filter Buttons */}
        <div className="mt-3 pt-3 border-t border-gray-100">
          <FilterAddButtons
            themes={themes}
            entities={entities}
            submitterTypes={availableSubmitterTypes}
            typeLabel={typeSource === 'ai' ? 'Commenter type' : 'Category'}
            extraPickers={[
              ...(availableFiledAs.length ? [{ label: 'Filed as', items: availableFiledAs.map(f => ({ key: f.value, label: FILED_AS_LABELS[f.value] || f.value, count: f.count, selected: (filters.filedAs || []).includes(f.value) })), onSelect: (k: string) => toggleIn('filedAs', k) }] : []),
              ...(availableStates.length ? [{ label: 'State', items: availableStates.map(f => ({ key: f.value, label: f.value, count: f.count, selected: (filters.states || []).includes(f.value) })), onSelect: (k: string) => toggleIn('states', k) }] : []),
            ]}
            selectedThemes={filters.themes || []}
            selectedEntities={filters.entities || []}
            selectedSubmitterTypes={filters.submitterTypes || []}
            onAddTheme={handleToggleTheme}
            onAddEntity={handleToggleEntity}
            onAddSubmitterType={handleToggleSubmitterType}
          />
        </div>
      </div>

      {/* Comments List */}
      <div className="space-y-4">
        {commentListJsx}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex justify-center items-center space-x-2 flex-wrap gap-y-2">
          <button
            onClick={() => setPage(Math.max(0, page - 1))}
            disabled={page === 0}
            className="px-4 py-2 border rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Previous
          </button>

          <span className="text-sm text-gray-600">
            Page {page + 1} of {totalPages}
          </span>

          <button
            onClick={() => setPage(Math.min(totalPages - 1, page + 1))}
            disabled={page === totalPages - 1}
            className="px-4 py-2 border rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Next
          </button>

          <select
            value={itemsPerPage}
            onChange={(e) => {
              setItemsPerPage(Number(e.target.value))
              setPage(0)
            }}
            className="ml-4 px-2 py-2 border rounded-lg text-sm text-gray-600"
          >
            {PAGE_SIZE_OPTIONS.map(size => (
              <option key={size} value={size}>{size} per page</option>
            ))}
          </select>
        </div>
      )}

      {/* Copy Modal */}
      <CopyCommentsModal
        isOpen={showCopyModal}
        onClose={() => setShowCopyModal(false)}
        title={`Copy ${commentsToCopy.length} Comments for LLM`}
        contextKey="search"
        comments={commentsToCopy}
      />

      {/* Help Modal */}
      <SearchHelpModal
        isOpen={showHelp}
        onClose={() => setShowHelp(false)}
      />
    </div>
  )
}

export default CommentBrowser
