import { useState, useMemo, useEffect, useCallback, useRef, useTransition } from 'react'
import { useSearchParams } from 'react-router-dom'
import { MessageSquare, Copy, Search, X } from 'lucide-react'
import useStore from '../store/useStore'
import CommentCard from './CommentCard'
import CopyCommentsModal from './CopyCommentsModal'
import ActiveFilterChips from './ActiveFilterChips'
import FilterAddButtons from './FilterAddButtons'
import { getUniqueValues } from '../utils/helpers'
import { parseSearchQuery, tokensToString, removeToken } from '../utils/searchParser'
import { debounce } from 'lodash'
// types imported as needed via store

interface FilterOptions {
  themes: string[]
  entities: string[]
  submitterTypes: string[]
  searchQuery: string
}

function CommentBrowser() {
  const { loading, comments = [], filters, setFilters, getFilteredComments, themes = [], entities = {} } = useStore()
  const [searchParams] = useSearchParams()
  const [page, setPage] = useState(0)
  const [showCopyModal, setShowCopyModal] = useState(false)
  const [localSearchQuery, setLocalSearchQuery] = useState(filters?.searchQuery || '')
  const PAGE_SIZE_OPTIONS = [50, 100, 250, 500, 1000, 1500, 2000]
  const [itemsPerPage, setItemsPerPage] = useState(100)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [, startTransition] = useTransition()

  // Parse search tokens from local query
  const searchTokens = useMemo(
    () => parseSearchQuery(localSearchQuery),
    [localSearchQuery]
  )

  // Debounced search handler — called directly from onChange, not via useEffect
  const debouncedSetSearchQuery = useMemo(
    () => debounce((query: string) => {
      if (setFilters) {
        startTransition(() => {
          setFilters((prev: FilterOptions) => ({ ...prev, searchQuery: query }))
          setPage(0)
        })
      }
    }, 300),
    [setFilters]
  )

  // Apply URL query parameters on mount
  useEffect(() => {
    const submitterType = searchParams.get('submitterType')
    if (submitterType) {
      setFilters((prev: FilterOptions) => ({
        ...prev,
        submitterTypes: [submitterType]
      }))
    }
  }, [searchParams, setFilters])

  // Memoize filtered comments — only recompute when store filters change (after debounce),
  // not on every keystroke in the search input
  const filteredComments = useMemo(() => {
    if (!getFilteredComments) return []
    return getFilteredComments()
  }, [getFilteredComments, filters])

  // Available submitter types (with 5+ comments)
  const availableSubmitterTypes = useMemo(() => {
    const counts = comments.reduce((acc, c) => {
      acc[c.submitterType] = (acc[c.submitterType] || 0) + 1
      return acc
    }, {} as Record<string, number>)
    return getUniqueValues(comments, 'submitterType').filter(t => counts[t] >= 5)
  }, [comments])

  // Pagination — memoize so keystroke re-renders don't recompute
  const { totalPages, paginatedComments } = useMemo(() => {
    const tp = Math.ceil(filteredComments.length / itemsPerPage)
    const pc = filteredComments.slice(page * itemsPerPage, (page + 1) * itemsPerPage)
    return { totalPages: tp, paginatedComments: pc }
  }, [filteredComments, page, itemsPerPage])

  const commentsToCopy = filteredComments

  // Memoize the comment list JSX — this is the expensive part
  const commentListJsx = useMemo(() => (
    paginatedComments.length > 0 ? (
      paginatedComments.map(comment => (
        <CommentCard
          key={comment.id}
          comment={comment}
          showThemes={false}
          showEntities={false}
        />
      ))
    ) : (
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8 text-center">
        <p className="text-gray-500">No comments match your filters</p>
      </div>
    )
  ), [paginatedComments])

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

  const handleClearAll = useCallback(() => {
    debouncedSetSearchQuery.cancel()
    setLocalSearchQuery('')
    startTransition(() => {
      setFilters((prev: FilterOptions) => ({
        ...prev,
        submitterTypes: [],
        themes: [],
        entities: [],
        searchQuery: ''
      }))
      setPage(0)
    })
  }, [setFilters, debouncedSetSearchQuery])

  if (loading || !filters) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading comments...</div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 sm:p-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3 min-w-0">
            <MessageSquare className="h-6 w-6 text-blue-600 flex-shrink-0" />
            <div className="min-w-0">
              <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Browse Comments</h1>
              <p className="text-sm text-gray-500 mt-1 truncate sm:whitespace-normal">
                {comments.some(c => c.isClusterRepresentative !== undefined) ? (
                  <>Showing {filteredComments.length} clusters representing {comments.length} comments</>
                ) : (
                  <>Showing {filteredComments.length} of {comments.length} comments</>
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
      </div>

      {/* Search + Filters */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
        {/* Search Input */}
        <div className="relative">
          <input
            ref={searchInputRef}
            type="text"
            value={localSearchQuery}
            onChange={(e) => {
              setLocalSearchQuery(e.target.value)
              debouncedSetSearchQuery(e.target.value)
            }}
            placeholder={'Search... "exact phrase"  OR  -exclude'}
            className="w-full pl-10 pr-10 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
          <Search className="absolute left-3 top-2.5 h-5 w-5 text-gray-400" />
          {localSearchQuery && (
            <button
              onClick={() => {
                debouncedSetSearchQuery.cancel()
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
        </div>

        {/* Active Filter Chips */}
        <ActiveFilterChips
          searchTokens={searchTokens}
          themes={filters.themes || []}
          entities={filters.entities || []}
          submitterTypes={filters.submitterTypes || []}
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
        comments={commentsToCopy}
      />
    </div>
  )
}

export default CommentBrowser
