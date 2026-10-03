import { ExternalLink, Paperclip, Calendar, MapPin, Quote, Users } from 'lucide-react'
import { Link } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { getRegulationsGovUrl, formatDate } from '../utils/helpers'
import useStore from '../store/useStore'
import type { Comment } from '../types'
import { useCommentContent } from '../utils/commentData'
import CampaignBadge from './CampaignBadge'
import { SubmitterIcon, SubmitterName, SubmitterType } from './SubmitterInfo'
import { useMemo } from 'react'
import { excerptPassages, countPassagesIn, remarkHighlightPassages } from '../utils/scopeHighlight'

interface CommentDetailViewProps {
  comment: Comment
}

function CommentDetailView({ comment }: CommentDetailViewProps) {
  const regulationsUrl = getRegulationsGovUrl(comment.documentId || '', comment.id)
  const { themes, getCommentById, scope } = useStore()
  
  // If this comment is part of a cluster but not the representative, get the representative's summary
  const representativeComment = comment.clusterRepresentativeId && !comment.isClusterRepresentative
    ? getCommentById(comment.clusterRepresentativeId)
    : null
  
  // Full sections and text (the representative's for form-letter members) load from shards
  const { content, loading, error } = useCommentContent(comment, true)
  const displaySections = content?.sections || comment.structuredSections

  // Scope sub-site: the in-scope passages (a form-letter member's come from its representative)
  const scopeSource = scope ? (representativeComment || comment) : null
  const excerpt = scopeSource?.scopeExcerpt
  const passages = useMemo(() => excerptPassages(excerpt), [excerpt])
  const highlightPlugin = useMemo(() => remarkHighlightPassages(passages), [passages])
  const marked = countPassagesIn(displaySections?.detailedContent, passages)
  
  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
      {/* Header with Key Information */}
      <div className="bg-gray-50 border-b border-gray-200 px-4 sm:px-6 py-3 sm:py-4">
        {/* Row 1: Author + actions */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center space-x-2 min-w-0 flex-1">
            <SubmitterIcon comment={comment} />
            <SubmitterName comment={comment} />
            <SubmitterType comment={comment} className="flex-shrink min-w-0 truncate hidden sm:inline" />
          </div>
          <div className="flex items-center space-x-2 sm:space-x-3 flex-shrink-0">
            <CampaignBadge comment={comment} />
            {/* Cluster Badge */}
            {comment.clusterSize && comment.clusterSize > 1 && comment.isClusterRepresentative && (
              <span
                className="inline-flex items-center gap-1 px-2 sm:px-3 py-1 rounded-full text-xs font-medium bg-purple-100 text-purple-800"
                title={`This comment represents ${comment.clusterSize} aligned submissions`}
              >
                <Users className="h-3 w-3" />
                <span className="hidden sm:inline">{comment.clusterSize > 100 ? `${comment.clusterSize} aligned` : `+${comment.clusterSize - 1} similar`}</span>
                <span className="sm:hidden">{comment.clusterSize}</span>
              </span>
            )}
            <a
              href={regulationsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:text-blue-800 transition-colors p-1"
              title="View on regulations.gov"
            >
              <ExternalLink className="h-4 w-4" />
            </a>
          </div>
        </div>

        {/* Row 2: Metadata */}
        <div className="flex items-center flex-wrap gap-x-3 gap-y-1 mt-2 text-sm text-gray-600">
          <SubmitterType comment={comment} className="sm:hidden" />
          <span className="flex items-center space-x-1" title="Date received">
            <Calendar className="h-3 w-3 flex-shrink-0" />
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
              <span className="hidden sm:inline">Has attachments</span>
            </span>
          )}
          <span className="text-xs font-mono text-gray-500 bg-gray-200 px-2 py-0.5 rounded hidden sm:inline">
            #{comment.id}
          </span>
        </div>
      </div>
      
      {/* Main Content Area */}
      <div className="p-6">
        {scope && comment.inScope === false && (
          <p className="mb-4 text-sm text-gray-600 bg-gray-50 border border-gray-200 rounded-md px-3 py-2">
            Outside this scope: the relevance check found nothing in this comment that addresses it.
          </p>
        )}
        {scopeSource && (scopeSource.scopeExcerpt || scopeSource.scopeNote) && (
          <section className="mb-6 rounded-md border border-[#cfd8e6] bg-[#f3f6fa] px-4 py-3" aria-labelledby="scope-excerpt-h">
            <h5 id="scope-excerpt-h" className="text-sm font-semibold text-[#14233c]">
              What this comment says on the scope
              {scopeSource.scopeSeed && <span className="ml-2 font-normal text-[#46546b]">(the letter this scope was drafted from)</span>}
            </h5>
            {scopeSource.scopeNote && <p className="mt-0.5 text-sm text-[#46546b]">{scopeSource.scopeNote}</p>}
            {scopeSource.scopeExcerpt && (
              <div className="mt-2 max-h-72 overflow-y-auto border-l-[3px] border-[#e8c547] pl-3 text-sm leading-relaxed text-gray-800 whitespace-pre-line">
                {scopeSource.scopeExcerpt}
              </div>
            )}
            {marked > 0 && (
              <p className="mt-2 text-xs text-[#5f6c82]">
                <mark className="scope-mark scope-key">Highlighted</mark> in the full text below.{' '}
                <button type="button" className="underline hover:text-[#14233c]" onClick={() => document.querySelector('mark.scope-mark:not(.scope-key)')?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>
                  Jump to the first passage
                </button>
              </p>
            )}
          </section>
        )}
        {/* Show note if using aligned content from representative */}
        {(representativeComment || comment.isAlignedSummary) && (
          <div className="mb-4 p-3 bg-purple-50 border border-purple-200 rounded-lg">
            <p className="text-sm text-purple-800">
              <span className="font-semibold">Note:</span> This comment is part of a cluster of {comment.clusterSize || 'multiple'} aligned submissions. 
              The summary and text below are from the representative comment
              {representativeComment ? <> (<Link to={`/comments/${representativeComment.id}`} className="underline">#{representativeComment.id}</Link>)</> : ''}.
              {comment.addedWords ? ' This submitter added their own text, shown first.' : ''}
            </p>
          </div>
        )}
        
        {(content?.addedText || comment.addedSnippet) && (
          <div className="mb-6">
            <h5 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-3">
              <span className="bg-amber-600 text-white px-2 py-0.5 rounded text-xs mr-2">ADDED TO THE FORM LETTER</span>
              {comment.addedWords ? <span className="normal-case font-normal">{comment.addedWords} words</span> : null}
            </h5>
            <div className="text-sm pl-4 border-l-2 border-amber-200 whitespace-pre-wrap text-gray-800">
              {content?.addedText || comment.addedSnippet}
            </div>
          </div>
        )}

        {loading && (
          <p className="text-sm text-gray-400 italic mb-4">Loading comment content…</p>
        )}
        {error && (
          <p className="text-sm text-red-600 mb-4">Could not load the full content: {error}</p>
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
                  {representativeComment && (
                    <span className="normal-case font-normal">
                      of the representative comment by {representativeComment.submitter} (<Link to={`/comments/${representativeComment.id}`} className="underline">#{representativeComment.id}</Link>), not of {comment.submitter}
                    </span>
                  )}
                </h5>
                <div className="text-sm pl-4 border-l-2 border-gray-200">
                  <ReactMarkdown 
                    remarkPlugins={[remarkGfm]}
                    components={{
                      ul: ({children}) => <ul className="list-disc pl-4 space-y-1">{children}</ul>,
                      ol: ({children}) => <ol className="list-decimal pl-4 space-y-1">{children}</ol>,
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
                <div className="text-sm pl-4 border-l-2 border-purple-200">
                  <ReactMarkdown 
                    remarkPlugins={[remarkGfm]}
                    components={{
                      ul: ({children}) => <ul className="list-disc pl-4 space-y-1">{children}</ul>,
                      ol: ({children}) => <ol className="list-decimal pl-4 space-y-1">{children}</ol>,
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
                <div className="text-sm pl-4 border-l-2 border-amber-200">
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
                <div className="text-sm pl-4 border-l-2 border-blue-200">
                  <ReactMarkdown 
                    remarkPlugins={[remarkGfm]}
                    components={{
                      ul: ({children}) => <ul className="list-disc pl-4 space-y-1">{children}</ul>,
                      ol: ({children}) => <ol className="list-decimal pl-4 space-y-1">{children}</ol>,
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
                <div className="text-sm pl-4 border-l-2 border-red-200">
                  <ReactMarkdown 
                    remarkPlugins={[remarkGfm]}
                    components={{
                      ul: ({children}) => <ul className="list-disc pl-4 space-y-1">{children}</ul>,
                      ol: ({children}) => <ol className="list-decimal pl-4 space-y-1">{children}</ol>,
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
                <div className="text-sm pl-4 border-l-2 border-green-200">
                  <ReactMarkdown 
                    remarkPlugins={[remarkGfm]}
                    components={{
                      ul: ({children}) => <ul className="list-disc pl-4 space-y-1">{children}</ul>,
                      ol: ({children}) => <ol className="list-decimal pl-4 space-y-1">{children}</ol>,
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
                <div className="text-sm pl-4 border-l-2 border-slate-200 prose prose-sm max-w-none">
                  <ReactMarkdown
                    remarkPlugins={passages.length ? [remarkGfm, remarkBreaks, highlightPlugin] : [remarkGfm, remarkBreaks]}
                  >
                    {displaySections.detailedContent}
                  </ReactMarkdown>
                </div>
              </div>
            )}
          </div>
        ) : !loading && (
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