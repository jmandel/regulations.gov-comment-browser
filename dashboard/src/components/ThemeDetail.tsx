import { Link, useParams } from 'react-router-dom'
import { Copy, ChevronRight, FileText } from 'lucide-react'
import { useMemo, useState } from 'react'
import useStore from '../store/useStore'
import CommentCard from './CommentCard'
import Breadcrumbs from './Breadcrumbs'
import ThemeSummaryView from './ThemeSummaryView'
import CopyCommentsModal from './CopyCommentsModal'

function ThemeDetail() {
  const { themeCode } = useParams<{ themeCode: string }>()
  const { themes, themeSummaries, getCommentsForTheme } = useStore()
  const [showCopyModal, setShowCopyModal] = useState(false)
  
  const theme = themes.find(t => t.code === themeCode)
  const themeSummary = themeCode ? themeSummaries[themeCode] : undefined
  const { direct } = themeCode ? getCommentsForTheme(themeCode) : { direct: [] }
  
  // Filter to only show representative comments (or all if no clustering)
  const displayedComments = direct.filter(c => 
    c.isClusterRepresentative === true || 
    c.isClusterRepresentative === undefined // For databases without clustering
  )
  
  // Build theme hierarchy
  const themeHierarchy = useMemo(() => {
    if (!theme) return []
    
    const hierarchy: typeof themes = []
    let current = theme
    
    // Walk up the parent chain
    while (current) {
      hierarchy.unshift(current)
      if (current.parent_code) {
        current = themes.find(t => t.code === current.parent_code)!
      } else {
        break
      }
    }
    
    return hierarchy
  }, [theme, themes])
  
  
 
  if (!theme) {
    return (
      <div className="p-8">
        <p className="text-gray-500">Theme not found</p>
      </div>
    )
  }
  

  
  const handleCopyIds = () => {
    const ids = displayedComments.map(c => c.id).join('\n')
    navigator.clipboard.writeText(ids)
  }
  
  return (
    <div className="space-y-6">
      {/* Breadcrumbs with full theme hierarchy */}
      <Breadcrumbs items={[
        { label: 'Themes', path: '/themes' },
        ...themeHierarchy.map((t, index) => ({
          label: `${t.code}${t.label ? `: ${t.label}` : ''}`,
          path: index === themeHierarchy.length - 1 ? undefined : `/themes/${t.code}`
        }))
      ]} />
      
      {/* Header */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 bg-gray-50">
          <div className="flex justify-between items-start">
            <div className="flex-1">
              <div className="flex items-center space-x-4 mb-2">
                <h2 className="text-2xl font-bold text-gray-900">
                  {theme.code}
                  {theme.label && (
                    <span className="text-gray-700 font-medium ml-3">{theme.label}</span>
                  )}
                </h2>
                <span className="px-3 py-1 bg-blue-100 text-blue-800 rounded-full text-sm font-medium whitespace-nowrap">
                  {theme.direct_count.toLocaleString()} {theme.direct_count === 1 ? 'comment' : 'comments'}
                  {theme.direct_count > displayedComments.length && (
                    <> ({displayedComments.length} {displayedComments.length === 1 ? 'cluster' : 'clusters'})</>
                  )}
                </span>
              </div>
              {theme.detailedDescription && (
                <div className="bg-blue-50 border-l-4 border-blue-200 pl-4 py-3 rounded-r-lg">
                  <p className="text-gray-700 text-sm leading-relaxed italic">
                    {theme.detailedDescription}
                  </p>
                </div>
              )}
              {!theme.detailedDescription && theme.description !== theme.label && (
                <div className="bg-blue-50 border-l-4 border-blue-200 pl-4 py-3 rounded-r-lg">
                  <p className="text-gray-700 text-sm leading-relaxed italic">
                    {theme.description}
                  </p>
                </div>
              )}
            </div>
            
            <div className="flex items-center space-x-2">
              <button
                onClick={() => setShowCopyModal(true)}
                className="flex items-center space-x-2 px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition-colors"
                title="Copy theme and comments for LLM"
              >
                <FileText className="h-4 w-4" />
                <span>Copy for LLM</span>
              </button>
              <button
                onClick={handleCopyIds}
                className="flex items-center space-x-2 px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg transition-colors"
                title="Copy all comment IDs"
              >
                <Copy className="h-4 w-4" />
                <span>Copy IDs</span>
              </button>
            </div>
          </div>
        </div>
      </div>
      
      {/* Theme Summary Analysis */}
      {themeSummary ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h2 className="text-xl font-semibold text-gray-900 mb-6">Theme Analysis</h2>
          <ThemeSummaryView summary={themeSummary} themeCode={theme.code} />
        </div>
      ) : (
        // No summary available - check if parent has one
        theme.parent_code && (
          <div className="bg-amber-50 rounded-lg shadow-sm border border-amber-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-3 flex items-center">
              <svg className="h-5 w-5 text-amber-600 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              No Detailed Analysis Available
            </h2>
            <p className="text-gray-700 mb-4">
              This sub-theme hasn't been analyzed in detail yet. 
              {theme.parent_code && (
                <>
                  {' '}View the parent theme for a broader analysis that may include this topic.
                </>
              )}
            </p>
            {theme.parent_code && (
              <Link
                to={`/themes/${theme.parent_code}`}
                className="inline-flex items-center space-x-2 px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white rounded-lg transition-colors"
              >
                <ChevronRight className="h-4 w-4 rotate-180" />
                <span>View Parent Theme Analysis</span>
              </Link>
            )}
          </div>
        )
      )}
      
      {/* Sub-themes */}
      {(() => {
        const childThemes = themes.filter(t => t.parent_code === theme.code)
        return childThemes.length > 0 ? (
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Sub-themes</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {childThemes.map(child => (
                <Link
                  key={child.code}
                  to={`/themes/${child.code}`}
                  className="bg-gray-50 rounded-lg border border-gray-200 p-4 hover:shadow-md hover:border-blue-300 transition-all"
                >
                  <h3 className="font-medium text-gray-900 mb-1">{child.code}</h3>
                  {child.label && (
                    <p className="text-sm text-gray-700 mb-2">{child.label}</p>
                  )}
                  {child.detailedDescription && (
                    <p className="text-xs text-gray-600 mb-3 italic">{child.detailedDescription}</p>
                  )}
                  {!child.detailedDescription && child.description !== child.label && (
                    <p className="text-xs text-gray-600 mb-3 italic">{child.description}</p>
                  )}
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-blue-600 font-medium">
                      {child.direct_count} {child.direct_count === 1 ? 'comment' : 'comments'}
                    </span>
                    <ChevronRight className="h-4 w-4 text-gray-400" />
                  </div>
                </Link>
              ))}
            </div>
          </div>
        ) : null
      })()}
      
      {/* Comments */}
      <div className="space-y-6">
        <h2 className="text-xl font-semibold text-gray-900">
          {direct.some(c => c.isClusterRepresentative !== undefined) ? (
            <>Representative Comments for This Theme ({displayedComments.length} clusters)</>
          ) : (
            <>Comments Addressing This Theme ({displayedComments.length})</>
          )}
        </h2>
        
        {displayedComments.length > 0 ? (
          <div className="space-y-4">
            {displayedComments.map(comment => (
              <CommentCard 
                key={comment.id} 
                comment={comment} 
                showThemes={false}
                showEntities={false}
              />
            ))}
          </div>
        ) : (
          <p className="text-gray-500 italic">No comments found addressing this theme</p>
        )}
      </div>
      
      {/* Copy Theme Comments Modal */}
      <CopyCommentsModal
        isOpen={showCopyModal}
        onClose={() => setShowCopyModal(false)}
        title="Copy Theme Comments for LLM"
        leadInContent={`# Theme Analysis: ${theme.code} - ${theme.label || theme.description}${theme.detailedDescription ? '\n\n## Theme Description\n' + theme.detailedDescription : ''}`}
        comments={displayedComments}
        themeSummary={themeSummary}
        commentSectionOptions={{
          metadata: true,
          oneLineSummary: false,
          corePosition: false,
          keyRecommendations: false,
          mainConcerns: false,
          notableExperiences: false,
          keyQuotations: false,
          detailedContent: true,
          themes: false,
          entities: false
        }}
      />
    </div>
  )
}

export default ThemeDetail 