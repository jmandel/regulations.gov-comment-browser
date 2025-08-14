import { ExternalLink, Paperclip, Calendar, MapPin, User, Building2, Quote, FileText, Users } from 'lucide-react'
import { Link } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { getRegulationsGovUrl, formatDate } from '../utils/helpers'
import clsx from 'clsx'
import { useState } from 'react'
import type { Comment } from '../types'
import CopyCommentsModal from './CopyCommentsModal'

interface CommentCardProps {
  comment: Comment
  showThemes?: boolean
  showEntities?: boolean
  clickable?: boolean
  sections?: {
    oneLineSummary?: boolean
    corePosition?: boolean
    keyRecommendations?: boolean
    mainConcerns?: boolean
    notableExperiences?: boolean
    keyQuotations?: boolean
  }
}

const defaultSections = {
  oneLineSummary: true,
  corePosition: true,
  keyRecommendations: false,
  mainConcerns: false,
  notableExperiences: false,
  keyQuotations: false
}

function CommentCard({ 
  comment, 
  showThemes = true, 
  showEntities = true, 
  clickable = true,
  sections = defaultSections 
}: CommentCardProps) {
  const [showCopyModal, setShowCopyModal] = useState(false)
  const regulationsUrl = getRegulationsGovUrl(comment.documentId || '', comment.id)
  
  const cardContent = (
    <div className={clsx(
      "bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden transition-all",
      clickable && "hover:shadow-lg hover:border-blue-300"
    )}>
      {/* Header with Key Information */}
      <div className="bg-gray-50 border-b border-gray-200 px-6 py-4">
        <div className="flex justify-between items-start">
          <div className="flex-1">
            <div className="flex items-center space-x-2">
              {(comment.submitterType === 'Organization' || 
                comment.submitterType === 'Business' ||
                comment.submitterType === 'Healthcare Organization' ||
                comment.submitterType === 'Government Agency' ||
                comment.submitterType === 'Trade Association') ? (
                <Building2 className="h-4 w-4 text-gray-500" />
              ) : (
                <User className="h-4 w-4 text-gray-500" />
              )}
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
            {/* ID */}
            <span className="text-xs font-mono text-gray-500 bg-gray-200 px-2 py-1 rounded" title="Comment ID">
              #{comment.id}
            </span>
            {typeof comment.wordCount === 'number' && !isNaN(comment.wordCount) && (
              <div className="flex flex-col items-end space-y-0.5" title={`${comment.wordCount.toLocaleString()} words · ${(comment as any).percentile ?? 0}th percentile`}>
                <span className="text-[10px] leading-none text-gray-600">{comment.wordCount.toLocaleString()} words</span>
                {(comment as any).percentile !== undefined && (
                  <div className="w-16 h-1 bg-gray-200 rounded overflow-hidden">
                    <div className="bg-blue-500 h-full" style={{ width: `${(comment as any).percentile}%` }} />
                  </div>
                )}
              </div>
            )}
            <button
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setShowCopyModal(true)
              }}
              className="text-purple-600 hover:text-purple-800 transition-colors"
              title="Copy for LLM"
            >
              <FileText className="h-4 w-4" />
            </button>
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
        {/* Show note if using aligned summary */}
        {comment.isAlignedSummary && (
          <div className="mb-3 p-2 bg-purple-50 border border-purple-200 rounded text-xs text-purple-800">
            <span className="font-semibold">Note:</span> Summary from aligned comment cluster
          </div>
        )}
        
        {/* Condensed Comment Section */}
        {comment.structuredSections ? (
          <>
            {/* Use the structured sections */}
            {(() => {
              const { 
                oneLineSummary, 
                corePosition, 
                keyRecommendations, 
                mainConcerns, 
                notableExperiences,
                keyQuotations 
              } = comment.structuredSections;
              
              return (
                <>
                  {/* One-line Summary */}
                  {sections.oneLineSummary && oneLineSummary && (
                    <div className="mb-4">
                      <p className="text-base font-medium text-gray-900 italic">{oneLineSummary}</p>
                    </div>
                  )}
                  
                  {/* Core Position */}
                  {sections.corePosition && corePosition && (
                    <div className="mb-6">
                      <h5 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-3 flex items-center">
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
                          {corePosition}
                        </ReactMarkdown>
                      </div>
                    </div>
                  )}
                  
                  {/* Key Quotations */}
                  {sections.keyQuotations && keyQuotations && 
                   keyQuotations !== "No standout quotations" && (
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
                              <li className="mb-2 list-none">
                                <blockquote className="border-l-4 border-amber-200 pl-4 py-2 bg-amber-50 rounded-r-lg">
                                  <p className="text-sm text-gray-800 italic m-0">{children}</p>
                                </blockquote>
                              </li>
                            ),
                            ul: ({children}) => <ul className="m-0 p-0 space-y-2">{children}</ul>,
                            p: ({children}) => {
                              const text = String(children);
                              if (text.startsWith('"') || text.startsWith('"')) {
                                return (
                                  <blockquote className="border-l-4 border-amber-200 pl-4 py-2 bg-amber-50 rounded-r-lg mb-2">
                                    <p className="text-sm text-gray-800 italic m-0">{children}</p>
                                  </blockquote>
                                );
                              }
                              return <p className="text-sm mb-2">{children}</p>;
                            }
                          }}
                        >
                          {keyQuotations}
                        </ReactMarkdown>
                      </div>
                    </div>
                  )}
                  
                  {/* Key Recommendations */}
                  {sections.keyRecommendations && keyRecommendations && 
                   keyRecommendations !== "No specific recommendations provided" && (
                    <div className="mb-6">
                      <h5 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-3 flex items-center">
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
                          {keyRecommendations}
                        </ReactMarkdown>
                      </div>
                    </div>
                  )}
                  
                  {/* Main Concerns */}
                  {sections.mainConcerns && mainConcerns && 
                   mainConcerns !== "No specific concerns raised" && (
                    <div className="mb-6">
                      <h5 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-3 flex items-center">
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
                          {mainConcerns}
                        </ReactMarkdown>
                      </div>
                    </div>
                  )}
                  
                  {/* Notable Experiences */}
                  {sections.notableExperiences && notableExperiences && 
                   notableExperiences !== "No distinctive experiences shared" && (
                    <div className="mb-6">
                      <h5 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-3 flex items-center">
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
                          {notableExperiences}
                        </ReactMarkdown>
                      </div>
                    </div>
                  )}
                </>
              )
            })()}
          </>
        ) : (
          <div className="mb-6">
            <h5 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-3 flex items-center">
              <span className="bg-gray-500 text-white px-2 py-0.5 rounded text-xs mr-2">SUMMARY</span>
            </h5>
            <p className="text-gray-500 italic pl-4">No condensed version available</p>
          </div>
        )}
        
        {/* Metadata Section - Themes and Topics */}
        {(showThemes || showEntities) && (
          <div className="border-t border-gray-200 pt-4 space-y-4">
            {/* Theme Tags - Only show themes with score = 1 (directly addresses) */}
            {showThemes && comment.themeScores && Object.keys(comment.themeScores).length > 0 && (
              <div>
                <h5 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-2 flex items-center">
                  <span className="bg-blue-500 text-white px-2 py-0.5 rounded text-xs mr-2">THEMES</span>
                </h5>
                <div className="flex flex-wrap gap-1 pl-4">
                  {Object.entries(comment.themeScores)
                    .filter(([_, score]) => score === 1) // Only show direct relevance
                    .map(([code]) => (
                      <Link
                        key={code}
                        to={`/themes/${code}`}
                        className="inline-block text-xs px-2 py-1 rounded-full border hover:shadow-md transition-all bg-blue-50 text-blue-700 border-blue-300 hover:bg-blue-100"
                        title="Directly addresses this theme"
                      >
                        {code}
                      </Link>
                    ))}
                  {Object.entries(comment.themeScores).filter(([_, score]) => score === 1).length === 0 && (
                    <p className="text-xs text-gray-400 italic">No primary themes identified</p>
                  )}
                </div>
              </div>
            )}
            
            {/* Entity Tags */}
            {showEntities && comment.entities && comment.entities.length > 0 && (
              <div>
                <h5 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-2 flex items-center">
                  <span className="bg-green-600 text-white px-2 py-0.5 rounded text-xs mr-2">TOPICS</span>
                </h5>
                <div className="flex flex-wrap gap-1 pl-4">
                  {comment.entities.map((entity, i) => (
                    <Link
                      key={i} 
                      to={`/entities/${encodeURIComponent(entity.category)}/${encodeURIComponent(entity.label)}`}
                      className="inline-block text-xs bg-green-50 text-green-700 border border-green-300 px-2 py-1 rounded-full hover:bg-green-100 hover:shadow-md transition-all"
                      title={`Category: ${entity.category}`}
                    >
                      {entity.label}
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
  
  // If clickable, wrap the entire card in a Link
  if (clickable) {
    return (
      <>
        <Link to={`/comments/${comment.id}`} className="block">
          {cardContent}
        </Link>
        {showCopyModal && (
          <CopyCommentsModal
            isOpen={showCopyModal}
            onClose={() => setShowCopyModal(false)}
            title="Copy Comment for LLM"
            leadInContent={`# Comment ${comment.id}`}
            comments={[comment]}
          />
        )}
      </>
    )
  }
  
  // If not clickable, just return the card and modal
  return (
    <>
      {cardContent}
      {showCopyModal && (
        <CopyCommentsModal
          isOpen={showCopyModal}
          onClose={() => setShowCopyModal(false)}
          title="Copy Comment for LLM"
          leadInContent={`# Comment ${comment.id}`}
          comments={[comment]}
        />
      )}
    </>
  )
}

export default CommentCard 