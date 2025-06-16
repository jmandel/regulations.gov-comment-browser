import { ExternalLink, Paperclip, Calendar, MapPin, User, Quote } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { getRegulationsGovUrl, formatDate } from '../utils/helpers'
import clsx from 'clsx'
import type { Comment } from '../types'

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
  const navigate = useNavigate()
  const regulationsUrl = getRegulationsGovUrl(comment.documentId || '', comment.id)
  
  const handleCardClick = (e: React.MouseEvent) => {
    // Don't navigate if clicking on the external link
    if ((e.target as HTMLElement).closest('a')) {
      return
    }
    if (clickable) {
      navigate(`/comments/${comment.id}`)
    }
  }
  
  return (
    <div 
      className={clsx(
        "bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden transition-all",
        clickable && "cursor-pointer hover:shadow-lg hover:border-blue-300"
      )}
      onClick={handleCardClick}
    >
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
            <span className="text-xs font-mono text-gray-500 bg-gray-200 px-2 py-1 rounded">
              #{comment.id}
            </span>
            <a
              href={regulationsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:text-blue-800 transition-colors"
              title="View on regulations.gov"
              onClick={(e) => e.stopPropagation()}
            >
              <ExternalLink className="h-4 w-4" />
            </a>
          </div>
        </div>
      </div>
      
      {/* Main Content Area */}
      <div className="p-6">
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
                      <span
                        key={code}
                        className="text-xs px-2 py-1 rounded-full border cursor-pointer hover:shadow-md transition-all bg-blue-50 text-blue-700 border-blue-300 hover:bg-blue-100"
                        title="Directly addresses this theme"
                        onClick={(e) => {
                          e.stopPropagation()
                          navigate(`/themes/${code}`)
                        }}
                      >
                        {code}
                      </span>
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
                    <span 
                      key={i} 
                      className="text-xs bg-green-50 text-green-700 border border-green-300 px-2 py-1 rounded-full cursor-pointer hover:bg-green-100 hover:shadow-md transition-all"
                      title={`Category: ${entity.category}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        navigate(`/entities/${encodeURIComponent(entity.category)}/${encodeURIComponent(entity.label)}`)
                      }}
                    >
                      {entity.label}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default CommentCard 