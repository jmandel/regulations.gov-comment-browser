import { useState, useEffect } from 'react'
import { X, Copy, Check } from 'lucide-react'
import { Comment, ThemeSummary } from '../types'

interface CopyCommentsModalProps {
  isOpen: boolean
  onClose: () => void
  title: string
  leadInContent?: string // Theme description, entity definition, etc.
  comments: Comment[]
  themeSummary?: ThemeSummary // Optional theme summary sections
  commentSectionOptions?: CommentSectionOptions // Override default sections
}

export interface CommentSectionOptions {
  metadata: boolean
  oneLineSummary: boolean
  corePosition: boolean
  keyRecommendations: boolean
  mainConcerns: boolean
  notableExperiences: boolean
  keyQuotations: boolean
  detailedContent: boolean
  themes: boolean
  entities: boolean
}

const defaultCommentSections: CommentSectionOptions = {
  metadata: true,
  oneLineSummary: true,
  corePosition: true,
  keyRecommendations: false,
  mainConcerns: false,
  notableExperiences: false,
  keyQuotations: false,
  detailedContent: false,
  themes: true,
  entities: true
}

interface ThemeSummarySectionOptions {
  executiveSummary: boolean
  consensusPoints: boolean
  areasOfDebate: boolean
  stakeholderPerspectives: boolean
  noteworthyInsights: boolean
  emergingPatterns: boolean
  keyQuotations: boolean
  analyticalNotes: boolean
}

function CopyCommentsModal({ 
  isOpen, 
  onClose, 
  title,
  leadInContent,
  comments,
  themeSummary,
  commentSectionOptions = defaultCommentSections
}: CopyCommentsModalProps) {
  const [copied, setCopied] = useState(false)
  const [commentSections, setCommentSections] = useState<CommentSectionOptions>(commentSectionOptions)
  const [themeSections, setThemeSections] = useState<ThemeSummarySectionOptions>({
    executiveSummary: false,
    consensusPoints: false,
    areasOfDebate: false,
    stakeholderPerspectives: false,
    noteworthyInsights: false,
    emergingPatterns: false,
    keyQuotations: false,
    analyticalNotes: false
  })

  useEffect(() => {
    if (!isOpen) {
      setCopied(false)
    }
  }, [isOpen])

  useEffect(() => {
    setCommentSections(commentSectionOptions)
  }, [commentSectionOptions])

  if (!isOpen) return null

  const handleCommentSectionToggle = (section: keyof CommentSectionOptions) => {
    setCommentSections(prev => ({ ...prev, [section]: !prev[section] }))
  }

  const handleThemeSectionToggle = (section: keyof ThemeSummarySectionOptions) => {
    setThemeSections(prev => ({ ...prev, [section]: !prev[section] }))
  }

  const handleSelectAllThemeSections = () => {
    const allChecked = Object.values(themeSections).every(v => v)
    setThemeSections({
      executiveSummary: !allChecked,
      consensusPoints: !allChecked,
      areasOfDebate: !allChecked,
      stakeholderPerspectives: !allChecked,
      noteworthyInsights: !allChecked,
      emergingPatterns: !allChecked,
      keyQuotations: !allChecked,
      analyticalNotes: !allChecked
    })
  }

  const handleSelectAllCommentSections = () => {
    const allChecked = Object.values(commentSections).every(v => v)
    setCommentSections({
      metadata: !allChecked,
      oneLineSummary: !allChecked,
      corePosition: !allChecked,
      keyRecommendations: !allChecked,
      mainConcerns: !allChecked,
      notableExperiences: !allChecked,
      keyQuotations: !allChecked,
      detailedContent: !allChecked,
      themes: !allChecked,
      entities: !allChecked
    })
  }

  const formatComment = (comment: Comment) => {
    const parts: string[] = []
    
    // Build metadata string
    if (commentSections.metadata) {
      const metadata = [
        comment.submitter,
        comment.submitterType,
        comment.date,
        comment.location
      ].filter(Boolean).join(' | ')
      parts.push(`<comment id="${comment.id}" metadata="${metadata}">`)
    } else {
      parts.push(`<comment id="${comment.id}">`)
    }

    const sections = comment.structuredSections || {}
    const contentParts: string[] = []
    
    if (commentSections.oneLineSummary && sections.oneLineSummary) {
      contentParts.push(`**Summary:** ${sections.oneLineSummary}`)
    }
    
    if (commentSections.corePosition && sections.corePosition) {
      contentParts.push(`**Core Position:**\n${sections.corePosition}`)
    }
    
    if (commentSections.keyRecommendations && sections.keyRecommendations && 
        sections.keyRecommendations !== "No specific recommendations provided") {
      contentParts.push(`**Key Recommendations:**\n${sections.keyRecommendations}`)
    }
    
    if (commentSections.mainConcerns && sections.mainConcerns && 
        sections.mainConcerns !== "No specific concerns raised") {
      contentParts.push(`**Main Concerns:**\n${sections.mainConcerns}`)
    }
    
    if (commentSections.notableExperiences && sections.notableExperiences && 
        sections.notableExperiences !== "No distinctive experiences shared") {
      contentParts.push(`**Notable Experiences:**\n${sections.notableExperiences}`)
    }
    
    if (commentSections.keyQuotations && sections.keyQuotations && 
        sections.keyQuotations !== "No standout quotations") {
      contentParts.push(`**Key Quotations:**\n${sections.keyQuotations}`)
    }
    
    if (commentSections.detailedContent && sections.detailedContent) {
      contentParts.push(`**Detailed Content:**\n${sections.detailedContent}`)
    }
    
    // Themes
    if (commentSections.themes && comment.themeScores) {
      const directThemes = Object.entries(comment.themeScores)
        .filter(([_, score]) => score === 1)
        .map(([code]) => code)
      
      if (directThemes.length > 0) {
        contentParts.push(`**Themes:** ${directThemes.join(', ')}`)
      }
    }
    
    // Entities
    if (commentSections.entities && comment.entities && comment.entities.length > 0) {
      const entityList = comment.entities.map(e => `${e.label} (${e.category})`).join(', ')
      contentParts.push(`**Topics:** ${entityList}`)
    }
    
    if (contentParts.length === 0) {
      contentParts.push('No content available')
    }
    
    parts.push(contentParts.join('\n\n'))
    parts.push('</comment>')
    
    return parts.join('\n')
  }

  const buildContent = () => {
    let content = ''
    
    // Add lead-in content if provided
    if (leadInContent) {
      content += leadInContent + '\n\n'
    }
    
    // Add theme summary sections if available and selected
    if (themeSummary) {
      const { sections: sumSections } = themeSummary
      
      if (themeSections.executiveSummary && sumSections.executiveSummary) {
        content += `## Executive Summary\n${sumSections.executiveSummary}\n\n`
      }
      
      if (themeSections.consensusPoints && sumSections.consensusPoints) {
        content += `## Consensus Points\n`
        sumSections.consensusPoints.forEach(point => {
          content += `- ${point.text}\n`
          if (point.supportLevel) content += `  Support Level: ${point.supportLevel}\n`
          if (point.evidence) {
            point.evidence.forEach(ev => content += `  - ${ev}\n`)
          }
        })
        content += '\n'
      }
      
      if (themeSections.areasOfDebate && sumSections.areasOfDebate) {
        content += `## Areas of Debate\n`
        sumSections.areasOfDebate.forEach(debate => {
          content += `### ${debate.topic}\n${debate.description}\n`
          debate.positions.forEach(pos => {
            content += `- **${pos.label}:** ${pos.stance}\n`
            if (pos.supportLevel) content += `  Support Level: ${pos.supportLevel}\n`
            pos.keyArguments.forEach(arg => content += `  - ${arg}\n`)
          })
        })
        content += '\n'
      }
      
      if (themeSections.stakeholderPerspectives && sumSections.stakeholderPerspectives) {
        content += `## Stakeholder Perspectives\n`
        sumSections.stakeholderPerspectives.forEach(stakeholder => {
          content += `### ${stakeholder.stakeholderType}\n${stakeholder.primaryConcerns}\n`
          stakeholder.specificPoints.forEach(point => content += `- ${point}\n`)
        })
        content += '\n'
      }
      
      if (themeSections.noteworthyInsights && sumSections.noteworthyInsights) {
        content += `## Noteworthy Insights\n`
        sumSections.noteworthyInsights.forEach(insight => {
          content += `- ${insight.insight}`
          if (insight.commentId) content += ` (Comment: ${insight.commentId})`
          content += '\n'
        })
        content += '\n'
      }
      
      if (themeSections.emergingPatterns && sumSections.emergingPatterns) {
        content += `## Emerging Patterns\n`
        sumSections.emergingPatterns.forEach(pattern => {
          if (typeof pattern === 'string') {
            content += `- ${pattern}\n`
          } else {
            content += `- ${pattern.pattern}\n`
          }
        })
        content += '\n'
      }
      
      if (themeSections.keyQuotations && sumSections.keyQuotations) {
        content += `## Key Quotations\n`
        sumSections.keyQuotations.forEach(quote => {
          content += `- "${quote.quote}"`
          if (quote.commentId) content += ` - Comment ${quote.commentId}`
          if (quote.sourceType) content += `, ${quote.sourceType}`
          content += '\n'
        })
        content += '\n'
      }
      
      if (themeSections.analyticalNotes && sumSections.analyticalNotes) {
        content += `## Analytical Notes\n`
        const notes = sumSections.analyticalNotes
        if (notes.discourseQuality) {
          content += `- **Discourse Quality:** ${notes.discourseQuality.level} - ${notes.discourseQuality.explanation}\n`
        }
        if (notes.evidenceBase) {
          content += `- **Evidence Base:** ${notes.evidenceBase.level} - ${notes.evidenceBase.explanation}\n`
        }
        if (notes.representationGaps) {
          content += `- **Representation Gaps:** ${notes.representationGaps}\n`
        }
        if (notes.complexityLevel) {
          content += `- **Complexity Level:** ${notes.complexityLevel}\n`
        }
        content += '\n'
      }
    }
    
    // Add comments
    content += `## Comments (${comments.length})\n\n`
    comments.forEach(comment => {
      content += formatComment(comment) + '\n\n'
    })
    
    return content.trim()
  }

  const handleCopy = async () => {
    const content = buildContent()
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }

  return (
    <>
      {/* Modal backdrop */}
      <div 
        className="fixed inset-0 bg-black bg-opacity-50 z-40"
        onClick={onClose}
      />
      
      {/* Modal content */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
        <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[80vh] overflow-hidden" onClick={(e)=>e.stopPropagation()}>
          {/* Header */}
          <div className="flex items-center justify-between p-6 border-b border-gray-200">
            <h2 className="text-xl font-semibold text-gray-900">{title}</h2>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 transition-colors"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          
          {/* Content */}
          <div className="p-6 overflow-y-auto max-h-[60vh]">
            <div className="space-y-4">
              <div>
                <p className="text-sm text-gray-500">
                  {comments.length} {comments.length === 1 ? 'comment' : 'comments'} will be included
                </p>
              </div>
              
              {/* Theme Summary Sections */}
              {themeSummary && (
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-medium text-gray-700">
                      Include Analysis Sections:
                    </h3>
                    <button
                      type="button"
                      onClick={handleSelectAllThemeSections}
                      className="text-xs text-blue-600 hover:text-blue-800"
                    >
                      {Object.values(themeSections).every(v => v) ? 'Deselect All' : 'Select All'}
                    </button>
                  </div>
                  <div className="space-y-2">
                    {themeSummary.sections.executiveSummary && (
                      <label 
                        className="flex items-center space-x-3 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={themeSections.executiveSummary}
                          onChange={() => handleThemeSectionToggle('executiveSummary')}
                          className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                        />
                        <span className="text-sm text-gray-700">Executive Summary</span>
                      </label>
                    )}
                    
                    {themeSummary.sections.consensusPoints && (
                      <label 
                        className="flex items-center space-x-3 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={themeSections.consensusPoints}
                          onChange={() => handleThemeSectionToggle('consensusPoints')}
                          className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                        />
                        <span className="text-sm text-gray-700">Consensus Points</span>
                      </label>
                    )}
                    
                    {themeSummary.sections.areasOfDebate && (
                      <label 
                        className="flex items-center space-x-3 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={themeSections.areasOfDebate}
                          onChange={() => handleThemeSectionToggle('areasOfDebate')}
                          className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                        />
                        <span className="text-sm text-gray-700">Areas of Debate</span>
                      </label>
                    )}
                    
                    {themeSummary.sections.stakeholderPerspectives && (
                      <label 
                        className="flex items-center space-x-3 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={themeSections.stakeholderPerspectives}
                          onChange={() => handleThemeSectionToggle('stakeholderPerspectives')}
                          className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                        />
                        <span className="text-sm text-gray-700">Stakeholder Perspectives</span>
                      </label>
                    )}
                    
                    {themeSummary.sections.noteworthyInsights && (
                      <label 
                        className="flex items-center space-x-3 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={themeSections.noteworthyInsights}
                          onChange={() => handleThemeSectionToggle('noteworthyInsights')}
                          className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                        />
                        <span className="text-sm text-gray-700">Noteworthy Insights</span>
                      </label>
                    )}
                    
                    {themeSummary.sections.emergingPatterns && (
                      <label 
                        className="flex items-center space-x-3 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={themeSections.emergingPatterns}
                          onChange={() => handleThemeSectionToggle('emergingPatterns')}
                          className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                        />
                        <span className="text-sm text-gray-700">Emerging Patterns</span>
                      </label>
                    )}
                    
                    {themeSummary.sections.keyQuotations && (
                      <label 
                        className="flex items-center space-x-3 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={themeSections.keyQuotations}
                          onChange={() => handleThemeSectionToggle('keyQuotations')}
                          className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                        />
                        <span className="text-sm text-gray-700">Key Quotations</span>
                      </label>
                    )}
                    
                    {themeSummary.sections.analyticalNotes && (
                      <label 
                        className="flex items-center space-x-3 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={themeSections.analyticalNotes}
                          onChange={() => handleThemeSectionToggle('analyticalNotes')}
                          className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                        />
                        <span className="text-sm text-gray-700">Analytical Notes</span>
                      </label>
                    )}
                  </div>
                </div>
              )}
              
              {/* Comment Sections */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-medium text-gray-700">
                    Include Comment Sections:
                  </h3>
                  <button
                    type="button"
                    onClick={handleSelectAllCommentSections}
                    className="text-xs text-blue-600 hover:text-blue-800"
                  >
                    {Object.values(commentSections).every(v => v) ? 'Deselect All' : 'Select All'}
                  </button>
                </div>
                <div className="space-y-2">
                  <label 
                    className="flex items-center space-x-3 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={commentSections.metadata}
                      onChange={() => handleCommentSectionToggle('metadata')}
                      className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                    />
                    <span className="text-sm text-gray-700">Metadata (submitter, date, etc.)</span>
                  </label>
                  
                  <label 
                    className="flex items-center space-x-3 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={commentSections.oneLineSummary}
                      onChange={() => handleCommentSectionToggle('oneLineSummary')}
                      className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                    />
                    <span className="text-sm text-gray-700">One-Line Summary</span>
                  </label>
                  
                  <label 
                    className="flex items-center space-x-3 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={commentSections.corePosition}
                      onChange={() => handleCommentSectionToggle('corePosition')}
                      className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                    />
                    <span className="text-sm text-gray-700">Core Position</span>
                  </label>
                  
                  <label 
                    className="flex items-center space-x-3 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={commentSections.keyRecommendations}
                      onChange={() => handleCommentSectionToggle('keyRecommendations')}
                      className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                    />
                    <span className="text-sm text-gray-700">Key Recommendations</span>
                  </label>
                  
                  <label 
                    className="flex items-center space-x-3 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={commentSections.mainConcerns}
                      onChange={() => handleCommentSectionToggle('mainConcerns')}
                      className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                    />
                    <span className="text-sm text-gray-700">Main Concerns</span>
                  </label>
                  
                  <label 
                    className="flex items-center space-x-3 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={commentSections.notableExperiences}
                      onChange={() => handleCommentSectionToggle('notableExperiences')}
                      className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                    />
                    <span className="text-sm text-gray-700">Notable Experiences</span>
                  </label>
                  
                  <label 
                    className="flex items-center space-x-3 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={commentSections.keyQuotations}
                      onChange={() => handleCommentSectionToggle('keyQuotations')}
                      className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                    />
                    <span className="text-sm text-gray-700">Key Quotations</span>
                  </label>
                  
                  <label 
                    className="flex items-center space-x-3 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={commentSections.detailedContent}
                      onChange={() => handleCommentSectionToggle('detailedContent')}
                      className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                    />
                    <span className="text-sm text-gray-700">Detailed Content</span>
                  </label>
                  
                  <label 
                    className="flex items-center space-x-3 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={commentSections.themes}
                      onChange={() => handleCommentSectionToggle('themes')}
                      className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                    />
                    <span className="text-sm text-gray-700">Themes</span>
                  </label>
                  
                  <label 
                    className="flex items-center space-x-3 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={commentSections.entities}
                      onChange={() => handleCommentSectionToggle('entities')}
                      className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                    />
                    <span className="text-sm text-gray-700">Topics/Entities</span>
                  </label>
                </div>
              </div>
            </div>
          </div>
          
          {/* Footer */}
          <div className="flex items-center justify-end space-x-3 p-6 border-t border-gray-200">
            <button
              onClick={onClose}
              className="px-4 py-2 text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleCopy}
              className="flex items-center space-x-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
            >
              {copied ? (
                <>
                  <Check className="h-4 w-4" />
                  <span>Copied!</span>
                </>
              ) : (
                <>
                  <Copy className="h-4 w-4" />
                  <span>Copy to Clipboard</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

export default CopyCommentsModal 