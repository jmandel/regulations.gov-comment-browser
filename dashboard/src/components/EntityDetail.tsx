import { useParams, Link } from 'react-router-dom'
import { Tag, FileText } from 'lucide-react'
import useStore from '../store/useStore'
import CommentCard from './CommentCard'
import { useMemo, useState } from 'react'
import Breadcrumbs from './Breadcrumbs'
import CopyCommentsModal from './CopyCommentsModal'

function EntityDetail() {
  const { category, label } = useParams<{ category: string; label: string }>()
  const { entities, getCommentsForEntity, themes } = useStore()
  const [showCopyModal, setShowCopyModal] = useState(false)
  
  const entity = category && label && entities[category]?.find(e => e.label === label)
  const comments = category && label ? getCommentsForEntity(category, label) : []
  
  // Calculate theme distribution for these comments
  const themeDistribution = useMemo(() => {
    const distribution: Record<string, number> = {}
    
    for (const comment of comments) {
      if (comment.themeScores) {
        for (const [theme, score] of Object.entries(comment.themeScores)) {
          // Only count themes with score = 1 (directly addresses)
          if (score === 1) {
            distribution[theme] = (distribution[theme] || 0) + 1
          }
        }
      }
    }
    
    return Object.entries(distribution)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10) // Top 10 themes
  }, [comments])
  
  if (!entity) {
    return (
      <div className="space-y-6">
        <Breadcrumbs items={[
          { label: 'Topics', path: '/entities' },
          { label: category || 'Unknown' },
          { label: 'Not Found' }
        ]} />
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8 text-center">
          <p className="text-gray-500">Topic not found</p>
        </div>
      </div>
    )
  }
  

  
  return (
    <div className="space-y-6">
      <Breadcrumbs items={[
        { label: 'Topics', path: '/entities' },
        { label: category, path: `/entities/${encodeURIComponent(category)}` },
        { label: entity.label }
      ]} />

      {/* Header */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 bg-gray-50">
          <div className="flex justify-between items-start">
            <div>
              <div className="flex items-center space-x-3 mb-2">
                <Tag className="h-6 w-6 text-green-600" />
                <h1 className="text-2xl font-bold text-gray-900">{entity.label}</h1>
                <Link
                  to={`/entities/${encodeURIComponent(category)}`}
                  className="text-sm text-blue-600 hover:text-blue-800 font-medium"
                >
                  Category: {category}
                </Link>
              </div>
              <p className="text-gray-600">{entity.definition}</p>
              {entity.terms.length > 1 && (
                <div className="mt-2">
                  <span className="text-sm text-gray-500">Also known as: </span>
                  <span className="text-sm text-gray-700">
                    {entity.terms.filter(t => t !== entity.label).join(', ')}
                  </span>
                </div>
              )}
              <div className="mt-3">
                <span className="px-3 py-1 bg-green-100 text-green-800 rounded-full text-sm font-medium">
                  {comments.length} mentions
                </span>
              </div>
            </div>
            
            <button
              onClick={() => setShowCopyModal(true)}
              className="flex items-center space-x-2 px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition-colors"
              title="Copy entity and comments for LLM"
            >
              <FileText className="h-4 w-4" />
              <span>Copy for LLM</span>
            </button>
          </div>
        </div>
      </div>
      
      {/* Theme Distribution */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Key Themes in These Comments</h3>
        {themeDistribution.length > 0 ? (
          <div className="space-y-3">
            {themeDistribution.map(([themeCode, count]) => {
              const theme = themes.find(t => t.code === themeCode)
              return (
                <div key={themeCode} className="flex items-center justify-between">
                  <Link
                    to={`/themes/${themeCode}`}
                    className="text-blue-600 hover:text-blue-800 hover:underline flex-1"
                  >
                    <span className="font-medium">{theme?.label || themeCode}</span>
                  </Link>
                  <span className="text-gray-600 ml-4">
                    {count} {count === 1 ? 'comment' : 'comments'}
                  </span>
                </div>
              )
            })}
          </div>
        ) : (
          <p className="text-gray-500 italic">No primary themes identified in these comments</p>
        )}
      </div>
      
      {/* Comments */}
      {comments.length > 0 ? (
        <div>
          <h2 className="text-lg font-semibold text-gray-900 mb-4">
            Comments Mentioning This Topic ({comments.length})
          </h2>
          <div className="space-y-4">
            {comments.map(comment => (
              <CommentCard 
                key={comment.id} 
                comment={comment} 
                showThemes={false} 
                showEntities={false}
              />
            ))}
          </div>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8 text-center">
          <p className="text-gray-500">No comments found mentioning this topic</p>
        </div>
      )}
      
      {/* Copy Entity Modal */}
      {entity && (
        <CopyCommentsModal
          isOpen={showCopyModal}
          onClose={() => setShowCopyModal(false)}
          title="Copy Entity for LLM"
          contextKey="entity"
          leadInContent={`# Entity: ${entity.label}\n\n## Category: ${category}\n\n## Definition\n${entity.definition}${entity.terms.length > 1 ? '\n\n## Alternative Terms\n' + entity.terms.filter(t => t !== entity.label).map(t => `- ${t}`).join('\n') : ''}\n\n## Mention Count\n${comments.length} comments mention this entity`}
          comments={comments}
          commentSectionOptions={{
            metadata: true,
            oneLineSummary: true,
            corePosition: true,
            keyRecommendations: false,
            mainConcerns: false,
            notableExperiences: false,
            keyQuotations: false,
            themeExtracts: false,
            detailedContent: false,
            themes: false,
            entities: false
          }}
        />
      )}
    </div>
  )
}

export default EntityDetail 