import { useState, useMemo, useEffect, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Filter, MessageSquare, Copy, Search, X } from 'lucide-react'
import useStore from '../store/useStore'
import CommentCard from './CommentCard'
import CopyCommentsModal from './CopyCommentsModal'
import { getUniqueValues } from '../utils/helpers'
import { debounce } from 'lodash'
import type { Comment } from '../types'

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
  const [showFilters, setShowFilters] = useState(true)
  const [showCopyModal, setShowCopyModal] = useState(false)
  const [localSearchQuery, setLocalSearchQuery] = useState(filters?.searchQuery || '')
  const [submitterTypeSearch, setSubmitterTypeSearch] = useState('')
  const [entitySearch, setEntitySearch] = useState('')
  const ITEMS_PER_PAGE = 100
  
  // Debounced search handler - use useRef to avoid recreating on every render
  const debouncedSetSearchQuery = useMemo(
    () => debounce((query: string) => {
      if (setFilters) {
        setFilters((prev: FilterOptions) => ({ ...prev, searchQuery: query }))
        setPage(0)
      }
    }, 300),
    [setFilters]
  )

  // Update search query
  useEffect(() => {
    debouncedSetSearchQuery(localSearchQuery)
  }, [localSearchQuery, debouncedSetSearchQuery])

  // Apply URL query parameters to filters on mount ONLY
  useEffect(() => {
    // Check for submitterType parameter
    const submitterType = searchParams.get('submitterType')
    const filterType = searchParams.get('filter')
    
    if (submitterType) {
      setFilters((prev: FilterOptions) => ({
        ...prev,
        submitterTypes: submitterType ? [submitterType] : prev.submitterTypes
      }))
    }
    
    // Check for filter parameter (general purpose)
    if (filterType === 'stakeholder') {
      setShowFilters(true)
    }
  }, [searchParams, setFilters]) // Include deps but this should still only run on mount/param change
  
  // Get filtered comments - don't memoize, let it re-run on each render
  let filteredComments: Comment[] = []
  if (getFilteredComments) {
    filteredComments = getFilteredComments()
  }
  
  // Get unique values for filters with typeahead filtering
  const filterOptions = useMemo(() => {
    // Count comments per submitter type
    const submitterTypeCounts = comments.reduce((acc, comment) => {
      acc[comment.submitterType] = (acc[comment.submitterType] || 0) + 1
      return acc
    }, {} as Record<string, number>)
    
    // Filter out types with < 5 comments
    const allSubmitterTypes = getUniqueValues(comments, 'submitterType')
      .filter(type => submitterTypeCounts[type] >= 5)
    
    const submitterTypes = submitterTypeSearch
      ? allSubmitterTypes.filter(type => 
          type.toLowerCase().includes(submitterTypeSearch.toLowerCase())
        )
      : allSubmitterTypes

    const availableThemes = themes.filter(t => t.comment_count > 0).map(t => t.code)
    
    const allEntities: Array<{key: string, label: string, category: string}> = []
    Object.entries(entities).forEach(([category, entityList]) => {
      entityList.forEach(entity => {
        if (entity.mentionCount > 0) {
          allEntities.push({
            key: `${category}|${entity.label}`,
            label: entity.label,
            category
          })
        }
      })
    })
    
    const availableEntities = entitySearch
      ? allEntities.filter(entity => 
          entity.label.toLowerCase().includes(entitySearch.toLowerCase()) ||
          entity.category.toLowerCase().includes(entitySearch.toLowerCase())
        )
      : allEntities
    
    return { submitterTypes, themes: availableThemes, entities: availableEntities }
  }, [comments, themes, entities, submitterTypeSearch, entitySearch])
  
  // Pagination
  const totalPages = Math.ceil(filteredComments.length / ITEMS_PER_PAGE)
  const paginatedComments = filteredComments.slice(
    page * ITEMS_PER_PAGE,
    (page + 1) * ITEMS_PER_PAGE
  )
  
  const commentsToCopy = filteredComments

  const handleFilterChange = useCallback((type: string, value: any) => {
    if (setFilters) {
      setFilters((prev: FilterOptions) => ({ ...prev, [type]: value }))
      setPage(0) // Reset to first page when filters change
    }
  }, [setFilters])

  // Show loading state if data isn't ready
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
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <MessageSquare className="h-6 w-6 text-blue-600" />
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Browse Comments</h1>
              <p className="text-sm text-gray-500 mt-1">
                {comments.some(c => c.isClusterRepresentative !== undefined) ? (
                  <>Showing {filteredComments.length} clusters representing {comments.length} comments</>
                ) : (
                  <>Showing {filteredComments.length} of {comments.length} comments</>
                )}
                {searchParams.get('submitterType') && ` from ${searchParams.get('submitterType')}`}
              </p>
            </div>
          </div>
          <div className="flex items-center space-x-2">
            <button
              onClick={() => setShowCopyModal(true)}
              className="flex items-center space-x-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            >
              <Copy className="h-4 w-4" />
              <span>Copy for LLM</span>
            </button>
            <button
              onClick={() => setShowFilters(!showFilters)}
              className="flex items-center space-x-2 px-4 py-2 border rounded-lg hover:bg-gray-50"
            >
              <Filter className="h-4 w-4" />
              <span>{showFilters ? 'Hide' : 'Show'} Filters</span>
            </button>
          </div>
        </div>
      </div>
      
      {/* Filters */}
      {showFilters && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h2 className="text-lg font-semibold mb-4">Filters</h2>
          
          <div className="space-y-4">
            {/* Search Filter */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Search in Comment Details
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={localSearchQuery}
                  onChange={(e) => setLocalSearchQuery(e.target.value)}
                  placeholder="Search in condensed comment details..."
                  className="w-full pl-10 pr-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
                <Search className="absolute left-3 top-2.5 h-5 w-5 text-gray-400" />
                {localSearchQuery && (
                  <button
                    onClick={() => setLocalSearchQuery('')}
                    className="absolute right-3 top-2.5 text-gray-400 hover:text-gray-600"
                  >
                    <X className="h-5 w-5" />
                  </button>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* Submitter Type Filter with Typeahead */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-sm font-medium text-gray-700">
                    Submitter Type
                  </label>
                  {filters.submitterTypes?.length > 0 && (
                    <button
                      onClick={() => {
                        handleFilterChange('submitterTypes', [])
                        setSubmitterTypeSearch('')
                      }}
                      className="text-xs text-gray-500 hover:text-gray-700"
                    >
                      Clear
                    </button>
                  )}
                </div>
                <input
                  type="text"
                  value={submitterTypeSearch}
                  onChange={(e) => setSubmitterTypeSearch(e.target.value)}
                  placeholder="Type to filter..."
                  className="w-full px-3 py-1 border rounded-lg mb-2"
                />
                <select
                  multiple
                  value={filters.submitterTypes || []}
                  onChange={(e) => {
                    const selected = Array.from(e.target.selectedOptions, option => option.value)
                    handleFilterChange('submitterTypes', selected)
                  }}
                  className="w-full border rounded-lg p-2 h-32"
                >
                  {filterOptions.submitterTypes.map(type => (
                    <option key={type} value={type}>{type}</option>
                  ))}
                </select>
                {filters.submitterTypes?.length > 0 && (
                  <div className="mt-2 text-xs text-gray-600">
                    Selected: {filters.submitterTypes.join(', ')}
                  </div>
                )}
              </div>
              
              {/* Entity Filter with Typeahead */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-sm font-medium text-gray-700">
                    Topics/Entities
                  </label>
                  {filters.entities?.length > 0 && (
                    <button
                      onClick={() => {
                        handleFilterChange('entities', [])
                        setEntitySearch('')
                      }}
                      className="text-xs text-gray-500 hover:text-gray-700"
                    >
                      Clear
                    </button>
                  )}
                </div>
                <input
                  type="text"
                  value={entitySearch}
                  onChange={(e) => setEntitySearch(e.target.value)}
                  placeholder="Type to filter entities..."
                  className="w-full px-3 py-1 border rounded-lg mb-2"
                />
                <select
                  multiple
                  value={filters.entities || []}
                  onChange={(e) => {
                    const selected = Array.from(e.target.selectedOptions, option => option.value)
                    handleFilterChange('entities', selected)
                  }}
                  className="w-full border rounded-lg p-2 h-32"
                >
                  {filterOptions.entities.map(entity => (
                    <option key={entity.key} value={entity.key}>
                      {entity.label}
                    </option>
                  ))}
                </select>
                {filters.entities?.length > 0 && (
                  <div className="mt-2 text-xs text-gray-600">
                    Selected: {filters.entities.map(e => {
                      const [, label] = e.split('|')
                      return label
                    }).join(', ')}
                  </div>
                )}
              </div>
              
              {/* Theme Filter */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-sm font-medium text-gray-700">
                    Themes
                  </label>
                  {filters.themes?.length > 0 && (
                    <button
                      onClick={() => handleFilterChange('themes', [])}
                      className="text-xs text-gray-500 hover:text-gray-700"
                    >
                      Clear
                    </button>
                  )}
                </div>
                <select
                  multiple
                  value={filters.themes || []}
                  onChange={(e) => {
                    const selected = Array.from(e.target.selectedOptions, option => option.value)
                    handleFilterChange('themes', selected)
                  }}
                  className="w-full border rounded-lg p-2 h-40"
                >
                  {filterOptions.themes.map(themeCode => {
                    const theme = themes.find(t => t.code === themeCode)
                    return (
                      <option key={themeCode} value={themeCode}>
                        {theme?.label || themeCode}
                      </option>
                    )
                  })}
                </select>
                {filters.themes?.length > 0 && (
                  <div className="mt-2 text-xs text-gray-600">
                    Selected: {filters.themes.map(code => {
                      const theme = themes.find(t => t.code === code)
                      return theme?.label || code
                    }).join(', ')}
                  </div>
                )}
              </div>
            </div>
          </div>
          
          {(filters.submitterTypes?.length > 0 || filters.entities?.length > 0 || filters.themes?.length > 0 || filters.searchQuery) && (
            <button
              onClick={() => {
                setFilters((prev: FilterOptions) => ({
                  ...prev,
                  submitterTypes: [],
                  themes: [],
                  entities: [],
                  searchQuery: ''
                }))
                setLocalSearchQuery('')
                setSubmitterTypeSearch('')
                setEntitySearch('')
              }}
              className="mt-4 text-sm text-blue-600 hover:text-blue-800"
            >
              Clear all filters
            </button>
          )}
        </div>
      )}
      
      {/* Comments List */}
      <div className="space-y-4">
        {paginatedComments.length > 0 ? (
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
        )}
      </div>
      
      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex justify-center items-center space-x-2">
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