import { ExternalLink, Paperclip, Calendar, MapPin, User, Quote, Users } from 'lucide-react'
import { Link } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { getRegulationsGovUrl, formatDate } from '../utils/helpers'
import useStore from '../store/useStore'
import type { Comment } from '../types'

interface CommentDetailViewProps {
  comment: Comment
}

function CommentDetailView({ comment }: CommentDetailViewProps) {
  const regulationsUrl = getRegulationsGovUrl(comment.documentId || '', comment.id)
  const { themes, getCommentById } = useStore()
  
  // If this comment is part of a cluster but not the representative, get the representative's summary
  const representativeComment = comment.clusterRepresentativeId && !comment.isClusterRepresentative
    ? getCommentById(comment.clusterRepresentativeId)
    : null
  
  // Use representative's structured sections if available, otherwise use the comment's own
  const displaySections = representativeComment?.structuredSections || comment.structuredSections
  
  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
      {/* Header with Key Information */}
      <div className="bg-gray-50 border-b border-gray-200 px-6 py-4">
        <div className="flex justify-between items-start">
          <div className="flex-1">
            <div className="flex items-center space-x-2">
              <User className="h-4 w-4 text-gray-500" />
              <h4 className="font-semibold text-gray-900">{comment.submitter}</h4>
              <span className="text-sm text-gray-600">• {comment.submitterType}</span>
            </div>
            
            <div className="flex items-center space-x-4 mt-2 text-sm text-gray-600">
              <span className="flex items-center space-x-1">
                <Calendar className="h-3 w-3" />
                <span>{formatDate(comment.date)}</span>
              </span>
              {comment.location && (
                <span className="flex items-center space-x-1">
                  <MapPin className="h-3 w-3" />
                  <span>{comment.location}</span>
                </span>
              )}
              {comment.hasAttachments && (
                <span className="flex items-center space-x-1">
                  <Paperclip className="h-3 w-3" />
                  <span>Has attachments</span>
                </span>
              )}
            </div>
          </div>
          
          <div className="flex items-center space-x-3">
            {/* Cluster Badge */}
            {comment.clusterSize && comment.clusterSize > 1 && comment.isClusterRepresentative && (
              <span 
                className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-medium bg-purple-100 text-purple-800"
                title={`This comment represents ${comment.clusterSize} aligned submissions`}
              >
                <Users className="h-3 w-3" />
                {comment.clusterSize > 100 ? (
                  <span>{comment.clusterSize} aligned comments</span>
                ) : (
                  <span>+{comment.clusterSize - 1} similar</span>
                )}
              </span>
            )}
            <span className="text-xs font-mono text-gray-500 bg-gray-200 px-2 py-1 rounded">
              #{comment.id}
            </span>
            <a
              href={regulationsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:text-blue-800 transition-colors"
              title="View on regulations.gov"
            >
              <ExternalLink className="h-4 w-4" />
            </a>
          </div>
        </div>
      </div>
      
      {/* Main Content Area */}
      <div className="p-6">
        {/* Show note if using aligned content from representative */}
        {(representativeComment || comment.isAlignedSummary) && (
          <div className="mb-4 p-3 bg-purple-50 border border-purple-200 rounded-lg">
            <p className="text-sm text-purple-800">
              <span className="font-semibold">Note:</span> This comment is part of a cluster of {comment.clusterSize || 'multiple'} aligned submissions. 
              The summary below is from the representative comment{representativeComment ? ` (#${representativeComment.id})` : ''}.
            </p>
          </div>
        )}
        
        {displaySections ? (
          <div className="space-y-6">
            {/* One-line Summary */}
            {displaySections.oneLineSummary && (
              <div className="mb-6">
                <h5 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-3">
                  <span className="bg-indigo-600 text-white px-2 py-0.5 rounded text-xs mr-2">SUMMARY</span>
                </h5>
                <p className="text-lg font-medium text-gray-900 italic pl-4 border-l-4 border-indigo-200">
                  {displaySections.oneLineSummary}
                </p>
              </div>
            )}
            
            {/* Commenter Profile */}
            {displaySections.commenterProfile && (
              <div className="mb-6">
                <h5 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-3">
                  <span className="bg-gray-600 text-white px-2 py-0.5 rounded text-xs mr-2">COMMENTER PROFILE</span>
                </h5>
                <div className="prose prose-sm max-w-none pl-4 border-l-2 border-gray-200">
                  <ReactMarkdown 
                    remarkPlugins={[remarkGfm]}
                    components={{
                      ul: ({children}) => <ul className="list-disc list-inside space-y-1 ml-4">{children}</ul>,
                      ol: ({children}) => <ol className="list-decimal list-inside space-y-1 ml-4">{children}</ol>,
                      li: ({children}) => <li className="text-gray-800">{children}</li>,
                    }}
                  >
                    {displaySections.commenterProfile}
                  </ReactMarkdown>
                </div>
              </div>
            )}
            
            {/* Core Position */}
            {displaySections.corePosition && (
              <div className="mb-6">
                <h5 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-3">
                  <span className="bg-purple-600 text-white px-2 py-0.5 rounded text-xs mr-2">CORE POSITION</span>
                </h5>
                <div className="prose prose-sm max-w-none pl-4 border-l-2 border-purple-200">
                  <ReactMarkdown 
                    remarkPlugins={[remarkGfm]}
                    components={{
                      ul: ({children}) => <ul className="list-disc list-inside space-y-1 ml-4">{children}</ul>,
                      ol: ({children}) => <ol className="list-decimal list-inside space-y-1 ml-4">{children}</ol>,
                      li: ({children}) => <li className="text-gray-800">{children}</li>,
                    }}
                  >
                    {displaySections.corePosition}
                  </ReactMarkdown>
                </div>
              </div>
            )}
            
            {/* Key Quotations */}
            {displaySections.keyQuotations && 
             displaySections.keyQuotations !== "No standout quotations" && (
              <div className="mb-6">
                <h5 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-3 flex items-center">
                  <span className="bg-amber-600 text-white px-2 py-0.5 rounded text-xs mr-2">KEY QUOTATIONS</span>
                  <Quote className="h-4 w-4 text-amber-600" />
                </h5>
                <div className="prose prose-sm max-w-none pl-4 border-l-2 border-amber-200">
                  <ReactMarkdown 
                    remarkPlugins={[remarkGfm]}
                    components={{
                      li: ({children}) => (
                        <li className="mb-2">
                          <blockquote className="border-l-4 border-amber-200 pl-4 py-2 bg-amber-50 rounded-r-lg not-italic">
                            <p className="text-gray-800 italic m-0">{children}</p>
                          </blockquote>
                        </li>
                      ),
                      p: ({children}) => {
                        const text = String(children);
                        if (text.startsWith('"') || text.startsWith('"')) {
                          return (
                            <blockquote className="border-l-4 border-amber-200 pl-4 py-2 bg-amber-50 rounded-r-lg mb-3">
                              <p className="text-gray-800 italic m-0">{children}</p>
                            </blockquote>
                          );
                        }
                        return <p className="mb-2">{children}</p>;
                      }
                    }}
                  >
                    {displaySections.keyQuotations}
                  </ReactMarkdown>
                </div>
              </div>
            )}
            
            {/* Key Recommendations */}
            {displaySections.keyRecommendations && 
             displaySections.keyRecommendations !== "No specific recommendations provided" && (
              <div className="mb-6">
                <h5 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-3">
                  <span className="bg-blue-600 text-white px-2 py-0.5 rounded text-xs mr-2">KEY RECOMMENDATIONS</span>
                </h5>
                <div className="prose prose-sm max-w-none pl-4 border-l-2 border-blue-200">
                  <ReactMarkdown 
                    remarkPlugins={[remarkGfm]}
                    components={{
                      ul: ({children}) => <ul className="list-disc list-inside space-y-1 ml-4">{children}</ul>,
                      ol: ({children}) => <ol className="list-decimal list-inside space-y-1 ml-4">{children}</ol>,
                      li: ({children}) => <li className="text-gray-800">{children}</li>,
                    }}
                  >
                    {displaySections.keyRecommendations}
                  </ReactMarkdown>
                </div>
              </div>
            )}
            
            {/* Main Concerns */}
            {displaySections.mainConcerns && 
             displaySections.mainConcerns !== "No specific concerns raised" && (
              <div className="mb-6">
                <h5 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-3">
                  <span className="bg-red-600 text-white px-2 py-0.5 rounded text-xs mr-2">MAIN CONCERNS</span>
                </h5>
                <div className="prose prose-sm max-w-none pl-4 border-l-2 border-red-200">
                  <ReactMarkdown 
                    remarkPlugins={[remarkGfm]}
                    components={{
                      ul: ({children}) => <ul className="list-disc list-inside space-y-1 ml-4">{children}</ul>,
                      ol: ({children}) => <ol className="list-decimal list-inside space-y-1 ml-4">{children}</ol>,
                      li: ({children}) => <li className="text-gray-800">{children}</li>,
                    }}
                  >
                    {displaySections.mainConcerns}
                  </ReactMarkdown>
                </div>
              </div>
            )}
            
            {/* Notable Experiences */}
            {displaySections.notableExperiences && 
             displaySections.notableExperiences !== "No distinctive experiences shared" && (
              <div className="mb-6">
                <h5 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-3">
                  <span className="bg-green-600 text-white px-2 py-0.5 rounded text-xs mr-2">NOTABLE INSIGHTS</span>
                </h5>
                <div className="prose prose-sm max-w-none pl-4 border-l-2 border-green-200">
                  <ReactMarkdown 
                    remarkPlugins={[remarkGfm]}
                    components={{
                      ul: ({children}) => <ul className="list-disc list-inside space-y-1 ml-4">{children}</ul>,
                      ol: ({children}) => <ol className="list-decimal list-inside space-y-1 ml-4">{children}</ol>,
                      li: ({children}) => <li className="text-gray-800">{children}</li>,
                    }}
                  >
                    {displaySections.notableExperiences}
                  </ReactMarkdown>
                </div>
              </div>
            )}
            
            {/* Detailed Content */}
            {displaySections.detailedContent && (
              <div className="mb-6">
                <h5 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-3">
                  <span className="bg-slate-600 text-white px-2 py-0.5 rounded text-xs mr-2">DETAILED CONTENT</span>
                </h5>
                <div className="prose prose-sm max-w-none pl-4 border-l-2 border-slate-200">
                  <ReactMarkdown 
                    remarkPlugins={[remarkGfm]}
                  >
                    {displaySections.detailedContent}
                  </ReactMarkdown>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="mb-6">
            <p className="text-gray-500 italic">No condensed version available</p>
          </div>
        )}
        
        {/* Metadata Section */}
        <div className="border-t border-gray-200 pt-6 mt-8 space-y-4">
          {/* Theme Tags - Only show themes with score = 1 */}
          {comment.themeScores && Object.keys(comment.themeScores).length > 0 && (
            <div>
              <h5 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-3">
                <span className="bg-blue-500 text-white px-2 py-0.5 rounded text-xs mr-2">THEMES</span>
              </h5>
              <div className="flex flex-wrap gap-2 pl-4">
                {Object.entries(comment.themeScores)
                  .filter(([_, score]) => score === 1) // Only show themes with score = 1
                  .map(([code]) => {
                    const theme = themes.find(t => t.code === code)
                    return (
                      <Link
                        key={code}
                        to={`/themes/${code}`}
                        className="text-xs px-3 py-1.5 rounded-full border transition-all bg-blue-100 text-blue-700 border-blue-300 hover:bg-blue-200"
                        title={theme?.label || theme?.description || code}
                      >
                        {code}
                      </Link>
                    )
                  })}
                {Object.entries(comment.themeScores).filter(([_, score]) => score === 1).length === 0 && (
                  <p className="text-xs text-gray-400 italic">No primary themes identified</p>
                )}
              </div>
            </div>
          )}
          
          {/* Entity Tags */}
          {comment.entities && comment.entities.length > 0 && (
            <div>
              <h5 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-3">
                <span className="bg-green-600 text-white px-2 py-0.5 rounded text-xs mr-2">TOPICS</span>
              </h5>
              <div className="flex flex-wrap gap-2 pl-4">
                {comment.entities.map((entity, i) => (
                  <Link
                    key={i}
                    to={`/entities/${encodeURIComponent(entity.category)}/${encodeURIComponent(entity.label)}`}
                    className="text-xs bg-green-50 text-green-700 border border-green-300 px-3 py-1.5 rounded-full hover:bg-green-100 transition-all"
                    title={`Category: ${entity.category}`}
                  >
                    <span className="font-medium">{entity.label}</span>
                    <span className="text-green-600 ml-1">({entity.category})</span>
                  </Link>
                ))}
              </div>
            </div>
          )}
          
          {/* Navigation Suggestions */}
          <div className="mt-6 pt-6 border-t border-gray-200">
            <h5 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-3">
              EXPLORE RELATED
            </h5>
            <div className="flex flex-wrap gap-3 text-sm">
              <Link to="/comments" className="text-blue-600 hover:text-blue-800">
                Browse All Comments →
              </Link>
              <Link to="/themes" className="text-blue-600 hover:text-blue-800">
                Explore Themes →
              </Link>
              <Link to="/entities" className="text-blue-600 hover:text-blue-800">
                View Topics →
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default CommentDetailView 