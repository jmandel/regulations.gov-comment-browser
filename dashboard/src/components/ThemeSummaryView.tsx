import { CheckCircle, AlertCircle, Users, Lightbulb, TrendingUp, Quote, BarChart3, MessageSquare, Target, AlertTriangle } from 'lucide-react'
import type { ThemeSummary } from '../types'
import CommentAuthorLink from './CommentAuthorLink'
import CommentAuthorsList from './CommentAuthorsList'
import CommentLink from './CommentLink'

interface ThemeSummaryViewProps {
  summary: ThemeSummary
  themeCode: string
}

function ThemeSummaryView({ summary }: ThemeSummaryViewProps) {
  const { sections } = summary
  
  return (
    <div className="space-y-8">
      {/* Executive Summary */}
      {sections.executiveSummary && (
        <div className="bg-gradient-to-r from-blue-50 to-indigo-50 rounded-xl p-6 border border-blue-200">
          <h3 className="text-lg font-semibold text-blue-900 mb-3 flex items-center">
            <BarChart3 className="h-5 w-5 mr-2" />
            Executive Summary
          </h3>
          <p className="text-gray-800 leading-relaxed text-base">
            {sections.executiveSummary}
          </p>
        </div>
      )}
      
      {/* Consensus Points */}
      {sections.consensusPoints && sections.consensusPoints.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
          <div className="bg-green-50 px-6 py-4 border-b border-green-100">
            <h3 className="text-lg font-semibold text-green-900 flex items-center">
              <CheckCircle className="h-5 w-5 mr-2" />
              Consensus Points
            </h3>
          </div>
          <div className="p-6 space-y-4">
            {sections.consensusPoints.map((point, index) => (
              <div key={index} className="relative pl-8">
                <div className="absolute left-0 top-1 h-6 w-6 bg-green-100 rounded-full flex items-center justify-center">
                  <span className="text-xs font-bold text-green-700">{index + 1}</span>
                </div>
                <div className="space-y-2">
                  <div>
                    <p className="text-gray-800 font-medium">{point.text}</p>
                    {point.supportLevel && (
                      <span className="text-xs text-gray-500 italic">({point.supportLevel})</span>
                    )}
                  </div>
                  {point.evidence && point.evidence.length > 0 && (
                    <div className="ml-4 space-y-2">
                      {point.evidence.map((ev, i) => (
                        <div key={i} className="flex items-start">
                          <span className="text-green-500 mr-2 mt-0.5">•</span>
                          <span className="text-sm text-gray-600">{ev}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {point.commentIds && point.commentIds.length > 0 && (
                    <div className="mt-2">
                      <span className="text-xs text-gray-500 mr-2">Referenced in:</span>
                      <CommentAuthorsList commentIds={point.commentIds} className="inline" />
                    </div>
                  )}
                  {point.exceptions && (
                    <div className="mt-2">
                      <p className="text-sm text-amber-700 bg-amber-50 px-3 py-2 rounded-lg">
                        ⚠️ {typeof point.exceptions === 'string' ? point.exceptions : point.exceptions.text}
                      </p>
                      {typeof point.exceptions !== 'string' && point.exceptions.commentIds && point.exceptions.commentIds.length > 0 && (
                        <div className="mt-1 ml-3">
                          <span className="text-xs text-gray-500">Exception examples: </span>
                          <CommentAuthorsList commentIds={point.exceptions.commentIds} className="inline" />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      
      {/* Areas of Debate */}
      {sections.areasOfDebate && sections.areasOfDebate.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
          <div className="bg-red-50 px-6 py-4 border-b border-red-100">
            <h3 className="text-lg font-semibold text-red-900 flex items-center">
              <AlertCircle className="h-5 w-5 mr-2" />
              Areas of Debate
            </h3>
          </div>
          <div className="p-6 space-y-6">
            {sections.areasOfDebate.map((debate, index) => (
              <div key={index} className="border-l-4 border-red-200 pl-4">
                <h4 className="font-semibold text-gray-900 mb-1">{debate.topic}</h4>
                <p className="text-gray-600 text-sm mb-4">{debate.description}</p>
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {debate.positions.map((position, posIndex) => (
                    <div key={posIndex} className="bg-gray-50 rounded-lg p-4">
                      <h5 className="font-medium text-gray-900 mb-2 flex items-center">
                        <span className={`h-2 w-2 rounded-full mr-2 ${
                          ['bg-blue-500', 'bg-orange-500', 'bg-emerald-500', 'bg-violet-500', 'bg-rose-500'][posIndex % 5]
                        }`} />
                        {position.label}
                      </h5>
                      <p className="text-sm text-gray-700 mb-2">{position.stance}</p>
                      {position.supportLevel && (
                        <p className="text-xs text-gray-500 italic mb-3">({position.supportLevel})</p>
                      )}
                      {position.keyArguments && position.keyArguments.length > 0 && (
                        <div>
                          <p className="text-xs font-semibold text-gray-600 uppercase tracking-wider mb-2">Key Arguments</p>
                          <ul className="space-y-2">
                            {position.keyArguments.map((arg, argIndex) => (
                              <li key={argIndex} className="text-sm text-gray-600 flex items-start">
                                <span className="text-gray-400 mr-2 mt-0.5">•</span>
                                <span>{arg}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {position.commentIds && position.commentIds.length > 0 && (
                        <div className="mt-3 pt-3 border-t border-gray-100">
                          <span className="text-xs text-gray-500 block mb-1">Example comments:</span>
                          <div className="flex flex-wrap gap-2">
                            {position.commentIds.map((commentId, idx) => (
                              <CommentLink 
                                key={idx}
                                commentId={commentId} 
                                className="text-indigo-600 hover:text-indigo-800"
                                showIcon={true}
                              />
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      
      {/* Stakeholder Perspectives */}
      {sections.stakeholderPerspectives && sections.stakeholderPerspectives.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
          <div className="bg-blue-50 px-6 py-4 border-b border-blue-100">
            <h3 className="text-lg font-semibold text-blue-900 flex items-center">
              <Users className="h-5 w-5 mr-2" />
              Stakeholder Perspectives
            </h3>
          </div>
          <div className="p-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {sections.stakeholderPerspectives.map((stakeholder, index) => (
                <div key={index} className="bg-gradient-to-br from-gray-50 to-blue-50 rounded-lg p-5 border border-gray-200">
                  <h4 className="font-semibold text-gray-900 mb-3 flex items-center">
                    <Users className="h-4 w-4 mr-2 text-blue-600" />
                    {stakeholder.stakeholderType}
                  </h4>
                  <div className="space-y-3">
                    <div>
                      <p className="text-sm font-medium text-gray-700 mb-1">Primary Concerns:</p>
                      <p className="text-sm text-gray-600">{stakeholder.primaryConcerns}</p>
                    </div>
                    {stakeholder.specificPoints && stakeholder.specificPoints.length > 0 && (
                      <div>
                        <p className="text-sm font-medium text-gray-700 mb-1">Key Points:</p>
                        <ul className="space-y-1">
                          {stakeholder.specificPoints.map((point, i) => (
                            <li key={i} className="text-sm text-gray-600 flex items-start">
                              <span className="text-blue-500 mr-2 mt-0.5">•</span>
                              <span>{point}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {stakeholder.commentIds && stakeholder.commentIds.length > 0 && (
                      <div className="mt-2 pt-2 border-t border-gray-100">
                        <span className="text-xs text-gray-500 block mb-1">Key contributors:</span>
                        <CommentAuthorsList commentIds={stakeholder.commentIds} />
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      
      {/* Key Recommendations */}
      {sections.keyRecommendations && sections.keyRecommendations.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
          <div className="bg-teal-50 px-6 py-4 border-b border-teal-100">
            <h3 className="text-lg font-semibold text-teal-900 flex items-center">
              <Target className="h-5 w-5 mr-2" />
              Key Recommendations
            </h3>
          </div>
          <div className="p-6 space-y-4">
            {sections.keyRecommendations.map((rec, index) => (
              <div key={index} className="border-l-4 border-teal-200 pl-4">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <span className="text-xs font-semibold text-teal-700 uppercase tracking-wider">{rec.approach}</span>
                    <p className="text-gray-800 mt-1">{rec.recommendation}</p>
                    {rec.supportLevel && (
                      <span className="text-xs text-gray-500 italic">({rec.supportLevel})</span>
                    )}
                  </div>
                </div>
                {rec.commentIds && rec.commentIds.length > 0 && (
                  <div className="mt-2">
                    <span className="text-xs text-gray-500 mr-2">Proposed by:</span>
                    <CommentAuthorsList commentIds={rec.commentIds} className="inline" />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      
      {/* Major Concerns */}
      {sections.majorConcerns && sections.majorConcerns.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
          <div className="bg-orange-50 px-6 py-4 border-b border-orange-100">
            <h3 className="text-lg font-semibold text-orange-900 flex items-center">
              <AlertTriangle className="h-5 w-5 mr-2" />
              Major Concerns
            </h3>
          </div>
          <div className="p-6 space-y-4">
            {sections.majorConcerns.map((concern, index) => (
              <div key={index} className="relative pl-8">
                <div className="absolute left-0 top-1 h-6 w-6 bg-orange-100 rounded-full flex items-center justify-center">
                  <span className="text-xs font-bold text-orange-700">{index + 1}</span>
                </div>
                <div className="space-y-1">
                  <p className="text-gray-800 font-medium">{concern.concern}</p>
                  <p className="text-sm text-gray-600">Raised by: {concern.raisedBy}</p>
                  {concern.evidence && (
                    <p className="text-sm text-gray-500 italic">{concern.evidence}</p>
                  )}
                  {concern.commentIds && concern.commentIds.length > 0 && (
                    <div className="mt-1">
                      <span className="text-xs text-gray-500 mr-2">Examples:</span>
                      <CommentAuthorsList commentIds={concern.commentIds} className="inline" />
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      
      {/* Noteworthy Insights & Emerging Patterns */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Noteworthy Insights */}
        {sections.noteworthyInsights && sections.noteworthyInsights.length > 0 && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
            <div className="bg-amber-50 px-6 py-4 border-b border-amber-100">
              <h3 className="text-lg font-semibold text-amber-900 flex items-center">
                <Lightbulb className="h-5 w-5 mr-2" />
                Noteworthy Insights
              </h3>
            </div>
            <div className="p-6">
              <ul className="space-y-3">
                {sections.noteworthyInsights.map((item, index) => (
                  <li key={index} className="flex items-start">
                    <span className="flex-shrink-0 h-6 w-6 bg-amber-100 rounded-full flex items-center justify-center mr-3 mt-0.5">
                      <Lightbulb className="h-3 w-3 text-amber-600" />
                    </span>
                    <div className="flex-1">
                      <span className="text-gray-700 text-sm">{item.insight}</span>
                      {item.commentId && (
                        <span className="ml-2 text-xs">
                          — <CommentAuthorLink 
                              commentId={item.commentId} 
                              className="text-gray-500 hover:text-amber-600"
                            />
                        </span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
        
        {/* Emerging Patterns */}
        {sections.emergingPatterns && sections.emergingPatterns.length > 0 && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
            <div className="bg-purple-50 px-6 py-4 border-b border-purple-100">
              <h3 className="text-lg font-semibold text-purple-900 flex items-center">
                <TrendingUp className="h-5 w-5 mr-2" />
                Emerging Patterns
              </h3>
            </div>
            <div className="p-6">
              <ul className="space-y-3">
                {sections.emergingPatterns.map((item, index) => (
                  <li key={index} className="flex items-start">
                    <span className="flex-shrink-0 h-6 w-6 bg-purple-100 rounded-full flex items-center justify-center mr-3 mt-0.5">
                      <TrendingUp className="h-3 w-3 text-purple-600" />
                    </span>
                    <div className="flex-1">
                      <span className="text-gray-700 text-sm">{item.pattern}</span>
                      {item.commentIds && item.commentIds.length > 0 && (
                        <div className="mt-1">
                          <span className="text-xs text-gray-500">Examples: </span>
                          <CommentAuthorsList 
                            commentIds={item.commentIds} 
                            className="inline"
                          />
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>
      
      {/* Key Quotations */}
      {sections.keyQuotations && sections.keyQuotations.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
          <div className="bg-indigo-50 px-6 py-4 border-b border-indigo-100">
            <h3 className="text-lg font-semibold text-indigo-900 flex items-center">
              <Quote className="h-5 w-5 mr-2" />
              Key Quotations
            </h3>
          </div>
          <div className="p-6 space-y-4">
            {sections.keyQuotations.map((quotation, index) => (
              <blockquote key={index} className="border-l-4 border-indigo-200 pl-6 py-2">
                <p className="text-gray-800 italic mb-2">"{quotation.quote}"</p>
                <cite className="text-sm text-gray-600 not-italic flex items-center">
                  <span className="mr-2">—</span>
                  {quotation.commentId ? (
                    <>
                      <CommentLink 
                        commentId={quotation.commentId} 
                        className="text-indigo-600 hover:text-indigo-800"
                        showIcon={true}
                      />
                      {quotation.sourceType && (
                        <span className="ml-1 text-gray-500">, {quotation.sourceType}</span>
                      )}
                    </>
                  ) : (
                    <span className="text-gray-500">Unknown source</span>
                  )}
                </cite>
              </blockquote>
            ))}
          </div>
        </div>
      )}
      
      {/* Analytical Notes */}
      {sections.analyticalNotes && (
        <div className="bg-gradient-to-r from-gray-50 to-gray-100 rounded-xl p-6 border border-gray-300">
          <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
            <MessageSquare className="h-5 w-5 mr-2" />
            Analytical Notes
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {sections.analyticalNotes.discourseQuality && (
              <div className="bg-white rounded-lg p-4 border border-gray-200">
                <h4 className="font-medium text-gray-700 mb-2">Discourse Quality</h4>
                <div className="flex items-center mb-1">
                  <span className={`px-2 py-1 rounded text-xs font-medium ${
                    sections.analyticalNotes.discourseQuality.level === 'Professional' ? 'bg-green-100 text-green-800' :
                    sections.analyticalNotes.discourseQuality.level === 'Mixed' ? 'bg-yellow-100 text-yellow-800' :
                    'bg-red-100 text-red-800'
                  }`}>
                    {sections.analyticalNotes.discourseQuality.level}
                  </span>
                </div>
                {sections.analyticalNotes.discourseQuality.explanation && (
                  <p className="text-sm text-gray-600">{sections.analyticalNotes.discourseQuality.explanation}</p>
                )}
              </div>
            )}
            
            {sections.analyticalNotes.evidenceBase && (
              <div className="bg-white rounded-lg p-4 border border-gray-200">
                <h4 className="font-medium text-gray-700 mb-2">Evidence Base</h4>
                <div className="flex items-center mb-1">
                  <span className={`px-2 py-1 rounded text-xs font-medium ${
                    sections.analyticalNotes.evidenceBase.level === 'Well-supported' ? 'bg-green-100 text-green-800' :
                    sections.analyticalNotes.evidenceBase.level === 'Mixed' ? 'bg-yellow-100 text-yellow-800' :
                    'bg-orange-100 text-orange-800'
                  }`}>
                    {sections.analyticalNotes.evidenceBase.level}
                  </span>
                </div>
                {sections.analyticalNotes.evidenceBase.explanation && (
                  <p className="text-sm text-gray-600">{sections.analyticalNotes.evidenceBase.explanation}</p>
                )}
              </div>
            )}
            
            {sections.analyticalNotes.representationGaps && (
              <div className="bg-white rounded-lg p-4 border border-gray-200">
                <h4 className="font-medium text-gray-700 mb-2">Representation Gaps</h4>
                <p className="text-sm text-gray-600">{sections.analyticalNotes.representationGaps}</p>
              </div>
            )}
            
            {sections.analyticalNotes.complexityLevel && (
              <div className="bg-white rounded-lg p-4 border border-gray-200">
                <h4 className="font-medium text-gray-700 mb-2">Complexity Level</h4>
                <p className="text-sm text-gray-600">{sections.analyticalNotes.complexityLevel}</p>
              </div>
            )}
          </div>
        </div>
      )}
      
      {/* Summary Stats */}
      <div className="bg-gray-50 rounded-lg p-4 flex items-center justify-center space-x-8 text-sm text-gray-600">
        <div className="flex items-center">
          <MessageSquare className="h-4 w-4 mr-2 text-gray-400" />
          <span>{summary.commentCount} comments analyzed</span>
        </div>
        <div className="flex items-center">
          <BarChart3 className="h-4 w-4 mr-2 text-gray-400" />
          {/* <span>{summary.wordCount.toLocaleString()} words processed</span> */}
        </div>
      </div>
    </div>
  )
}

export default ThemeSummaryView 