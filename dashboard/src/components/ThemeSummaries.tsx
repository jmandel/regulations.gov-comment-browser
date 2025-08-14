import { useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { FileText, Search, TrendingUp, AlertCircle, CheckCircle, ListOrdered, MessageSquare, Quote } from 'lucide-react'
import useStore from '../store/useStore'

function ThemeSummaries() {
  const { themes, themeSummaries } = useStore()
  const [searchQuery, setSearchQuery] = useState('')
  const [sortBy, setSortBy] = useState<'theme' | 'comments' | 'consensus' | 'debate' | 'insights' | 'quotes'>('comments')
  
  // Get themes that have summaries
  const themesWithSummaries = useMemo(() => {
    return themes.filter(theme => themeSummaries[theme.code])
      .map(theme => ({
        ...theme,
        summary: themeSummaries[theme.code]
      }))
      .sort((a, b) => b.summary.commentCount - a.summary.commentCount)
  }, [themes, themeSummaries])
  
  // Filter and sort themes
  const filteredThemes = useMemo(() => {
    let filtered = themesWithSummaries
    if (searchQuery) {
      const query = searchQuery.toLowerCase()
      filtered = filtered.filter(theme => 
        theme.code.toLowerCase().includes(query) ||
        theme.label?.toLowerCase().includes(query) ||
        theme.description.toLowerCase().includes(query) ||
        theme.summary.sections.executiveSummary?.toLowerCase().includes(query)
      )
    }
    // Sort
    filtered = [...filtered].sort((a, b) => {
      const sa = a.summary.sections
      const sb = b.summary.sections
      switch (sortBy) {
        case 'theme':
          return a.code.localeCompare(b.code)
        case 'comments':
          return b.summary.commentCount - a.summary.commentCount
        case 'consensus':
          return (sb.consensusPoints?.length || 0) - (sa.consensusPoints?.length || 0)
        case 'debate':
          return (sb.areasOfDebate?.length || 0) - (sa.areasOfDebate?.length || 0)
        case 'insights':
          return (sb.noteworthyInsights?.length || 0) - (sa.noteworthyInsights?.length || 0)
        case 'quotes':
          return (sb.keyQuotations?.length || 0) - (sa.keyQuotations?.length || 0)
        default:
          return 0
      }
    })
    return filtered
  }, [themesWithSummaries, searchQuery, sortBy])
  
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <div className="flex items-center space-x-3">
          <FileText className="h-6 w-6 text-purple-600" />
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Theme Analysis Summaries</h1>
            <p className="text-sm text-gray-500 mt-1">
              {themesWithSummaries.length} of {themes.length} themes have detailed analysis
            </p>
          </div>
        </div>
      </div>
      
      {/* Filters */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
        <div className="flex flex-col md:flex-row gap-4 items-end">
          {/* Sort By */}
          <div className="flex items-center space-x-2">
            <ListOrdered className="h-4 w-4 text-gray-500" />
            <label className="text-xs font-medium text-gray-700">Sort by</label>
            <div className="flex space-x-1">
              <button
                className={`flex items-center space-x-1 px-3 py-1.5 rounded-md border text-xs font-medium transition-colors ${sortBy === 'comments' ? 'bg-purple-100 text-purple-800 border-purple-300' : 'bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100'}`}
                onClick={() => setSortBy('comments')}
                title="Sort by # Comments"
              >
                <MessageSquare className="h-3 w-3" /> <span># Comments</span>
              </button>
              <button
                className={`flex items-center space-x-1 px-3 py-1.5 rounded-md border text-xs font-medium transition-colors ${sortBy === 'theme' ? 'bg-purple-100 text-purple-800 border-purple-300' : 'bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100'}`}
                onClick={() => setSortBy('theme')}
                title="Sort by Theme Code"
              >
                <ListOrdered className="h-3 w-3" /> <span>Theme Code</span>
              </button>
              <button
                className={`flex items-center space-x-1 px-3 py-1.5 rounded-md border text-xs font-medium transition-colors ${sortBy === 'consensus' ? 'bg-green-100 text-green-800 border-green-300' : 'bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100'}`}
                onClick={() => setSortBy('consensus')}
                title="Sort by # Consensus Points"
              >
                <CheckCircle className="h-3 w-3" /> <span># Consensus</span>
              </button>
              <button
                className={`flex items-center space-x-1 px-3 py-1.5 rounded-md border text-xs font-medium transition-colors ${sortBy === 'debate' ? 'bg-red-100 text-red-800 border-red-300' : 'bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100'}`}
                onClick={() => setSortBy('debate')}
                title="Sort by # Debate Points"
              >
                <AlertCircle className="h-3 w-3" /> <span># Debate</span>
              </button>
              <button
                className={`flex items-center space-x-1 px-3 py-1.5 rounded-md border text-xs font-medium transition-colors ${sortBy === 'insights' ? 'bg-amber-100 text-amber-800 border-amber-300' : 'bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100'}`}
                onClick={() => setSortBy('insights')}
                title="Sort by # Insights"
              >
                <TrendingUp className="h-3 w-3" /> <span># Insights</span>
              </button>
              <button
                className={`flex items-center space-x-1 px-3 py-1.5 rounded-md border text-xs font-medium transition-colors ${sortBy === 'quotes' ? 'bg-blue-100 text-blue-800 border-blue-300' : 'bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100'}`}
                onClick={() => setSortBy('quotes')}
                title="Sort by # Quotes"
              >
                <Quote className="h-3 w-3" /> <span># Quotes</span>
              </button>
            </div>
          </div>
          {/* Search */}
          <div className="flex-1">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search theme summaries..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
              />
            </div>
          </div>
        </div>
      </div>
      
      {/* Summary Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {filteredThemes.map(theme => {
          const { sections } = theme.summary
          const hasConsensus = sections.consensusPoints && sections.consensusPoints.length > 0
          const hasDebate = sections.areasOfDebate && sections.areasOfDebate.length > 0
          const hasInsights = sections.noteworthyInsights && sections.noteworthyInsights.length > 0
          
          return (
            <Link
              key={theme.code}
              to={`/themes/${theme.code}`}
              className="bg-white rounded-lg shadow-sm border border-gray-200 hover:shadow-lg hover:border-purple-300 transition-all overflow-hidden"
            >
              <div className="p-6">
                {/* Theme Header */}
                <div className="mb-4">
                  <h3 className="text-lg font-semibold text-gray-900 mb-1">
                    {theme.code}: {theme.label || theme.description}
                  </h3>
                  <div className="flex items-center space-x-3 text-sm">
                    <span className="px-2 py-0.5 bg-blue-100 text-blue-800 rounded font-medium whitespace-nowrap">
                      {theme.direct_count.toLocaleString()} comments
                      {theme.direct_count > theme.summary.commentCount && (
                        <> ({theme.summary.commentCount.toLocaleString()} clusters)</>
                      )}
                    </span>
                  </div>
                </div>
                
                {/* Executive Summary */}
                {sections.executiveSummary && (
                  <p className="text-gray-700 text-sm mb-4 line-clamp-3">
                    {sections.executiveSummary}
                  </p>
                )}
                
                {/* Key Highlights restored */}
                <div className="space-y-3">
                  {hasConsensus && (
                    <div className="flex items-start space-x-2">
                      <CheckCircle className="h-4 w-4 text-green-600 mt-0.5 flex-shrink-0" />
                      <div className="flex-1">
                        <p className="text-sm font-medium text-green-900">
                          {sections.consensusPoints!.length} consensus points
                        </p>
                        <p className="text-xs text-gray-600 line-clamp-2">
                          {sections.consensusPoints![0].text}
                        </p>
                      </div>
                    </div>
                  )}
                  {hasDebate && (
                    <div className="flex items-start space-x-2">
                      <AlertCircle className="h-4 w-4 text-red-600 mt-0.5 flex-shrink-0" />
                      <div className="flex-1">
                        <p className="text-sm font-medium text-red-900">
                          {sections.areasOfDebate!.length} areas of debate
                        </p>
                        <p className="text-xs text-gray-600 line-clamp-2">
                          {sections.areasOfDebate![0].topic}: {sections.areasOfDebate![0].description}
                        </p>
                      </div>
                    </div>
                  )}
                  {hasInsights && (
                    <div className="flex items-start space-x-2">
                      <TrendingUp className="h-4 w-4 text-amber-600 mt-0.5 flex-shrink-0" />
                      <div className="flex-1">
                        <p className="text-sm font-medium text-amber-900">
                          {sections.noteworthyInsights!.length} key insights
                        </p>
                        <p className="text-xs text-gray-600 line-clamp-2">
                          {sections.noteworthyInsights![0].insight}
                        </p>
                      </div>
                    </div>
                  )}
                </div>
                
                {/* View More */}
                <div className="mt-4 pt-4 border-t border-gray-100">
                  <span className="text-sm text-purple-600 font-medium">
                    View full analysis →
                  </span>
                </div>
              </div>
            </Link>
          )
        })}
      </div>
      
      {filteredThemes.length === 0 && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8 text-center">
          <p className="text-gray-500">No theme summaries match your filters</p>
        </div>
      )}
    </div>
  )
}

export default ThemeSummaries 