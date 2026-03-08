import { useState, useMemo, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { Tag, ChevronRight, Copy, ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react'
import useStore from '../store/useStore'
import CopyCommentsModal from './CopyCommentsModal'

type SortOption = 'alpha-asc' | 'alpha-desc' | 'mentions-asc' | 'mentions-desc'

function EntityBrowser() {
  const { entities, getCommentsForEntity } = useStore()
  const [selectedCategory, setSelectedCategory] = useState<string>(Object.keys(entities)[0] || '')
  const [showCopyModal, setShowCopyModal] = useState(false)
  const [copyEntity, setCopyEntity] = useState<{category: string, label: string} | null>(null)
  const [sortBy, setSortBy] = useState<SortOption>('mentions-desc')

  const categories = Object.keys(entities).sort()

  // Select first category once entities load (initial useState runs before data is ready)
  useEffect(() => {
    if (!selectedCategory && categories.length > 0) {
      setSelectedCategory(categories[0])
    }
  }, [categories, selectedCategory])
  
  // User-friendly category names
  const getCategoryDisplayName = (category: string): string => {
    const displayNames: Record<string, string> = {
      'Organizations': 'Organizations & Agencies',
      'Medications': 'Medications & Treatments',
      'Conditions': 'Medical Conditions',
      'Regulations': 'Laws & Regulations',
      'Programs': 'Programs & Initiatives',
      'Locations': 'Places & Regions'
    }
    return displayNames[category] || category
  }
  
  // Sort entities based on current sort option
  const sortedEntities = useMemo(() => {
    if (!selectedCategory || !entities[selectedCategory]) return []
    
    const items = [...entities[selectedCategory]]
    
    switch (sortBy) {
      case 'alpha-asc':
        return items.sort((a, b) => a.label.localeCompare(b.label))
      case 'alpha-desc':
        return items.sort((a, b) => b.label.localeCompare(a.label))
      case 'mentions-asc':
        return items.sort((a, b) => a.mentionCount - b.mentionCount)
      case 'mentions-desc':
        return items.sort((a, b) => b.mentionCount - a.mentionCount)
      default:
        return items
    }
  }, [selectedCategory, entities, sortBy])
  
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 sm:p-6">
        <div className="flex items-center space-x-3">
          <Tag className="h-6 w-6 text-green-600 flex-shrink-0" />
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Browse Topics & Organizations</h1>
            <p className="text-sm text-gray-500 mt-1">
              Explore key topics, organizations, and subjects mentioned in comments
            </p>
          </div>
        </div>
      </div>
      
      <div className="relative">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Category List - Fixed Position */}
          <div className="md:sticky md:top-20 bg-white rounded-lg shadow-sm border border-gray-200 flex flex-col h-[calc(100vh-12rem)] max-h-[700px]">
            <div className="p-4 border-b border-gray-200 flex-shrink-0">
              <div className="flex items-center space-x-2">
                <Tag className="h-5 w-5 text-gray-400" />
                <h3 className="font-semibold">Categories</h3>
              </div>
            </div>
            <div className="p-2 overflow-y-auto flex-1">
            {categories.map(category => {
              const entityCount = entities[category]?.length || 0
              const totalMentions = entities[category]?.reduce((sum, e) => sum + e.mentionCount, 0) || 0
              
              return (
                <button
                  key={category}
                  onClick={() => setSelectedCategory(category)}
                  className={`w-full text-left px-4 py-3 rounded transition-colors ${
                    selectedCategory === category
                      ? 'bg-green-50 text-green-700 border-l-4 border-green-600'
                      : 'hover:bg-gray-50'
                  }`}
                >
                  <div className="flex justify-between items-center">
                    <span className="font-medium">{getCategoryDisplayName(category)}</span>
                    <span className="text-sm text-gray-500">{entityCount}</span>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">
                    {totalMentions.toLocaleString()} total mentions
                  </p>
                </button>
              )
            })}
          </div>
        </div>

          {/* Entity List */}
          <div className="md:col-span-2 bg-white rounded-lg shadow-sm border border-gray-200 flex flex-col">
            <div className="p-4 border-b border-gray-200 flex-shrink-0">
              <div className="flex justify-between items-start">
                <div>
                  <h3 className="font-semibold text-lg">{getCategoryDisplayName(selectedCategory)}</h3>
                  <p className="text-sm text-gray-500 mt-1">
                    {entities[selectedCategory]?.length || 0} topics in this category
                  </p>
                </div>
                {/* Sort Controls */}
                <div className="flex items-center space-x-2">
                  <span className="text-sm text-gray-500">Sort by:</span>
                  <div className="flex rounded-lg border border-gray-300 divide-x divide-gray-300">
                    <button
                      onClick={() => setSortBy(sortBy === 'alpha-asc' ? 'alpha-desc' : 'alpha-asc')}
                      className={`px-3 py-1 text-sm flex items-center space-x-1 hover:bg-gray-50 transition-colors ${
                        sortBy.startsWith('alpha') ? 'bg-gray-100' : ''
                      }`}
                      title="Sort alphabetically"
                    >
                      <span>Name</span>
                      {sortBy === 'alpha-asc' && <ArrowUp className="h-3 w-3" />}
                      {sortBy === 'alpha-desc' && <ArrowDown className="h-3 w-3" />}
                      {!sortBy.startsWith('alpha') && <ArrowUpDown className="h-3 w-3 text-gray-400" />}
                    </button>
                    <button
                      onClick={() => setSortBy(sortBy === 'mentions-desc' ? 'mentions-asc' : 'mentions-desc')}
                      className={`px-3 py-1 text-sm flex items-center space-x-1 hover:bg-gray-50 transition-colors ${
                        sortBy.startsWith('mentions') ? 'bg-gray-100' : ''
                      }`}
                      title="Sort by mention count"
                    >
                      <span>Mentions</span>
                      {sortBy === 'mentions-asc' && <ArrowUp className="h-3 w-3" />}
                      {sortBy === 'mentions-desc' && <ArrowDown className="h-3 w-3" />}
                      {!sortBy.startsWith('mentions') && <ArrowUpDown className="h-3 w-3 text-gray-400" />}
                    </button>
                  </div>
                </div>
              </div>
            </div>
            <div className="divide-y divide-gray-200 overflow-y-auto" style={{ maxHeight: 'calc(100vh - 16rem)' }}>
              {selectedCategory && sortedEntities.map(entity => (
              <div key={entity.label} className="flex items-stretch group hover:bg-gray-50 transition-colors">
                <Link
                  to={`/entities/${encodeURIComponent(selectedCategory)}/${encodeURIComponent(entity.label)}`}
                  className="flex-1 block p-4"
                >
                  <div className="flex justify-between items-start">
                    <div className="flex-1">
                      <h4 className="font-medium text-gray-900 group-hover:text-green-600 transition-colors">
                        {entity.label}
                      </h4>
                      <p className="text-sm text-gray-600 mt-1">{entity.definition}</p>
                      <div className="flex flex-wrap gap-1 mt-2">
                        {entity.terms.slice(0, 3).map((term, i) => (
                          <span key={i} className="text-xs bg-gray-100 px-2 py-1 rounded">
                            "{term}"
                          </span>
                        ))}
                        {entity.terms.length > 3 && (
                          <span className="text-xs text-gray-500 px-2 py-1">
                            +{entity.terms.length - 3} more
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center space-x-2 ml-4">
                      <span className="text-sm text-gray-500">
                        {entity.mentionCount} {entity.mentionCount === 1 ? 'mention' : 'mentions'}
                      </span>
                      <button
                        className="p-2 hover:bg-gray-200 rounded-lg"
                        title="Copy comments mentioning this entity for LLM"
                        onClick={e => {
                          e.preventDefault();
                          setCopyEntity({category: selectedCategory, label: entity.label});
                          setShowCopyModal(true);
                        }}
                      >
                        <Copy className="h-4 w-4 text-gray-500" />
                      </button>
                      <ChevronRight className="h-4 w-4 text-gray-400 group-hover:text-green-600 transition-colors" />
                    </div>
                  </div>
                </Link>
              </div>
            ))}
            
            {(!selectedCategory || !sortedEntities.length) && (
              <div className="p-8 text-center text-gray-500">
                No topics in this category
              </div>
            )}
            </div>
          </div>
        </div>
      </div>
      {/* Copy Modal for entity */}
      <CopyCommentsModal
        isOpen={showCopyModal && !!copyEntity}
        onClose={() => { setShowCopyModal(false); setCopyEntity(null); }}
        title={copyEntity ? `Copy comments mentioning "${copyEntity.label}" for LLM` : ''}
        comments={copyEntity ? getCommentsForEntity(copyEntity.category, copyEntity.label) : []}
      />
    </div>
  )
}

export default EntityBrowser