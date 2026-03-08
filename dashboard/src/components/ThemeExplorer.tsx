import { useState, useMemo, useEffect } from 'react'
import { ChevronRight, ChevronDown, Search, Info, FileText, Copy, BarChart3 } from 'lucide-react'
import { Link } from 'react-router-dom'
import useStore from '../store/useStore'
import type { Theme } from '../types'
import CopyThemeListModal from './CopyThemeListModal'

interface ThemeExplorerProps {
  hideTopLevelMetrics?: boolean
}

function ThemeExplorer({ hideTopLevelMetrics = true }: ThemeExplorerProps = {}) {
  const { themes, themeSummaries } = useStore()
  console.log('Rendering ThemeExplorer with themes:', themes)
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set())
  const [searchQuery, setSearchQuery] = useState('')
  const [expandedDescriptions, setExpandedDescriptions] = useState<Set<string>>(new Set())
  const [showCopyModal, setShowCopyModal] = useState(false)
  
  // Build theme tree
  const themeTree = useMemo(() => {
    const tree: Record<string, Theme[]> = {}
    
    // Group by parent - show all themes
    themes.forEach(theme => {
      const parent = theme.parent_code || 'root'
      if (!tree[parent]) tree[parent] = []
      tree[parent].push(theme)
    })
    
    // Sort each group by code with natural numeric ordering
    const naturalSort = (a: string, b: string) => {
      // Split codes into parts (numbers and non-numbers)
      const aParts = a.split(/(\d+)/)
      const bParts = b.split(/(\d+)/)
      
      for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
        const aPart = aParts[i] || ''
        const bPart = bParts[i] || ''
        
        // If both parts are numbers, compare numerically
        if (/^\d+$/.test(aPart) && /^\d+$/.test(bPart)) {
          const diff = parseInt(aPart) - parseInt(bPart)
          if (diff !== 0) return diff
        } else {
          // Otherwise compare as strings
          const diff = aPart.localeCompare(bPart)
          if (diff !== 0) return diff
        }
      }
      return 0
    }
    
    Object.values(tree).forEach(children => {
      children.sort((a, b) => naturalSort(a.code, b.code))
    })
    
    return tree
  }, [themes])
  
  // Expand first 2 levels by default
  useEffect(() => {
    const defaultExpanded = new Set<string>()
    
    // Add root themes
    const rootThemes = themeTree['root'] || []
    rootThemes.forEach(theme => {
      defaultExpanded.add(theme.code)
      
      // Add their children (second level)
      const children = themeTree[theme.code] || []
      children.forEach(child => {
        defaultExpanded.add(child.code)
      })
    })
    
    setExpandedNodes(defaultExpanded)
  }, [themeTree])
  
  // Filter themes based on search
  const filteredThemes = useMemo(() => {
    if (!searchQuery) return themes
    const query = searchQuery.toLowerCase()
    return themes.filter(theme => 
      theme.code.toLowerCase().includes(query) ||
      theme.description.toLowerCase().includes(query) ||
      (theme.label && theme.label.toLowerCase().includes(query))
    )
  }, [themes, searchQuery])
  
  const toggleNode = (code: string) => {
    const newExpanded = new Set(expandedNodes)
    if (newExpanded.has(code)) {
      newExpanded.delete(code)
    } else {
      newExpanded.add(code)
    }
    setExpandedNodes(newExpanded)
  }
  
  const toggleDescription = (code: string, e: React.MouseEvent) => {
    e.stopPropagation()
    const newExpanded = new Set(expandedDescriptions)
    if (newExpanded.has(code)) {
      newExpanded.delete(code)
    } else {
      newExpanded.add(code)
    }
    setExpandedDescriptions(newExpanded)
  }
  
  const expandAll = () => {
    const allCodes = themes.map(t => t.code)
    setExpandedNodes(new Set(allCodes))
  }
  
  const collapseAll = () => {
    setExpandedNodes(new Set())
  }
  
  const renderThemeNode = (theme: Theme, depth: number = 0) => {
    const children = themeTree[theme.code] || []
    const hasChildren = children.length > 0
    const isExpanded = expandedNodes.has(theme.code)
    const isFiltered = searchQuery && !filteredThemes.includes(theme)
    const isDescriptionExpanded = expandedDescriptions.has(theme.code)
    const hasSummary = !!themeSummaries[theme.code]
    const isTopLevel = !theme.parent_code
    const shouldHideMetrics = hideTopLevelMetrics && isTopLevel
    
    if (isFiltered) return null
    
    const indentPx = depth * 20
    const indentPxSm = depth * 20
    
    return (
      <div key={theme.code} className="select-none">
        <div>
          <Link
            to={`/themes/${theme.code}`}
            className="flex items-start py-2 pr-2 sm:pr-3 hover:bg-gray-50 rounded-lg cursor-pointer group hover:no-underline"
            style={{ paddingLeft: `${indentPx}px` }}
          >
            {/* Code column with optional chevron */}
            <span className="font-mono font-semibold text-gray-400 text-sm flex-shrink-0 mt-0.5 mr-2 inline-flex items-center gap-0.5">
              {hasChildren ? (
                <button
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    toggleNode(theme.code)
                  }}
                  className="text-gray-400 hover:text-gray-600 -ml-1 p-1 flex-shrink-0"
                >
                  {isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                </button>
              ) : null}
              {theme.code}
            </span>
            
            {/* Label + comment count in a column */}
            <div className="flex-1 min-w-0">
              <div className="flex items-start justify-between gap-2">
                <span className="text-gray-900 text-sm sm:text-base leading-snug">{theme.label || theme.description}</span>
                {/* Desktop: comment count + chevron on the right */}
                <div className="hidden sm:flex items-center space-x-2 flex-shrink-0 mt-0.5">
                  {!shouldHideMetrics && (
                    <span className="text-sm text-blue-600 font-medium whitespace-nowrap" title="Direct mentions">
                      {theme.direct_count}
                    </span>
                  )}
                  {!shouldHideMetrics && hasSummary && (
                    <span className="text-purple-600" title="Theme analysis available">
                      <FileText className="h-3 w-3" />
                    </span>
                  )}
                  {theme.detailedDescription && (
                    <button
                      onClick={(e) => {
                        e.preventDefault()
                        toggleDescription(theme.code, e)
                      }}
                      className="text-gray-400 hover:text-gray-600 transition-colors"
                      title={isDescriptionExpanded ? "Hide description" : "Show description"}
                    >
                      <Info className="h-3 w-3" />
                    </button>
                  )}
                  <ChevronRight className="h-4 w-4 text-gray-400 opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>
              </div>
              {/* Mobile: comment count on its own line */}
              {!shouldHideMetrics && (
                <span className="sm:hidden text-xs text-blue-600 font-medium leading-tight">
                  {theme.direct_count} {theme.direct_count === 1 ? 'comment' : 'comments'}
                </span>
              )}
            </div>
          </Link>
          
          {/* Inline description */}
          {isDescriptionExpanded && theme.detailedDescription && (
            <div 
              className="ml-6 mr-3 mb-2 p-3 bg-blue-50 rounded-lg text-sm text-gray-700 border border-blue-100"
              style={{ marginLeft: `${indentPxSm + 48}px` }}
            >
              {theme.detailedDescription}
            </div>
          )}
        </div>
        
        {isExpanded && children.map(child => renderThemeNode(child, depth + 1))}
      </div>
    )
  }
  
  // Get root themes
  const rootThemes = themeTree['root'] || []
  const visibleThemeCount = themes.length
  
  return (
    <div className="sm:p-8 max-w-7xl mx-auto">
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 sm:p-6 mb-6">
        <div className="flex items-center space-x-3">
          <BarChart3 className="h-6 w-6 text-blue-600 flex-shrink-0" />
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Theme Hierarchy</h1>
            <p className="text-sm text-gray-500 mt-1 hidden sm:block">
              Explore themes identified in comments. Click <Info className="inline h-3 w-3" /> for descriptions.
            </p>
          </div>
        </div>
      </div>
      
      {/* Controls */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 mb-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="w-full sm:flex-1 sm:max-w-md">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search themes..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
          </div>
          
          <div className="flex items-center space-x-4">
            <button
              onClick={() => expandedNodes.size === visibleThemeCount ? collapseAll() : expandAll()}
              className="text-sm text-blue-600 hover:text-blue-800 font-medium"
            >
              {expandedNodes.size === visibleThemeCount ? 'Collapse All' : 'Expand All'}
            </button>
            <button
              onClick={() => setShowCopyModal(true)}
              className="flex items-center space-x-2 px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition-colors text-sm"
              title="Copy theme hierarchy for LLM"
            >
              <Copy className="h-4 w-4" />
              <span className="hidden sm:inline">Copy for LLM</span>
            </button>
          </div>
        </div>
      </div>
      
      {/* Theme Tree */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200">
        <div className="p-1 sm:p-6">
          {rootThemes.length > 0 ? (
            <div className="space-y-1">
              {rootThemes.map(theme => renderThemeNode(theme))}
            </div>
          ) : (
            <p className="text-gray-500 text-center py-8">
              No themes with direct mentions found
            </p>
          )}
        </div>
      </div>
      
      {/* Stats */}
      <div className="mt-6 grid grid-cols-2 gap-4">
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
          <div className="text-2xl font-bold text-gray-900">{themes.length}</div>
          <div className="text-sm text-gray-600">Total Themes</div>
        </div>
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
          <div className="text-2xl font-bold text-gray-900">
            {themes.reduce((sum, t) => sum + t.direct_count, 0)}
          </div>
          <div className="text-sm text-gray-600">Total Direct Mentions</div>
        </div>
      </div>
      
      {/* Copy Theme List Modal */}
      <CopyThemeListModal
        isOpen={showCopyModal}
        onClose={() => setShowCopyModal(false)}
        themes={themes}
      />
    </div>
  )
}

export default ThemeExplorer 