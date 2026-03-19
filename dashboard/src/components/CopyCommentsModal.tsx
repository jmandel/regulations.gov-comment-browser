import { useState, useEffect } from 'react'
import { X, Copy, Check, Download, Share2 } from 'lucide-react'
import { Comment, ThemeSummary, ThemeExtract } from '../types'

interface CopyCommentsModalProps {
  isOpen: boolean
  onClose: () => void
  title: string
  contextKey?: string // Unique key per context (e.g., "theme", "entity", "search") for persisting checkbox state
  leadInContent?: string // Theme description, entity definition, etc.
  comments: Comment[]
  themeSummary?: ThemeSummary // Optional theme summary sections
  themeExtracts?: { [commentId: string]: ThemeExtract } // Per-comment theme-specific extracts
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
  themeExtracts: boolean
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
  keyQuotations: true,
  themeExtracts: true,
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

function loadSavedSections<T>(storageKey: string, defaults: T): T {
  try {
    const saved = localStorage.getItem(storageKey)
    if (saved) {
      const parsed = JSON.parse(saved)
      // Merge with defaults so new keys get their default value
      return { ...defaults, ...parsed }
    }
  } catch (_) {}
  return defaults
}

function CopyCommentsModal({
  isOpen,
  onClose,
  title,
  contextKey,
  leadInContent,
  comments,
  themeSummary,
  themeExtracts,
  commentSectionOptions = defaultCommentSections
}: CopyCommentsModalProps) {
  const commentStorageKey = contextKey ? `copy-modal-comments-${contextKey}` : ''
  const themeStorageKey = contextKey ? `copy-modal-theme-${contextKey}` : ''

  const defaultThemeSections: ThemeSummarySectionOptions = {
    executiveSummary: false,
    consensusPoints: false,
    areasOfDebate: false,
    stakeholderPerspectives: false,
    noteworthyInsights: false,
    emergingPatterns: false,
    keyQuotations: false,
    analyticalNotes: false
  }

  const [copied, setCopied] = useState(false)
  const [commentSections, setCommentSections] = useState<CommentSectionOptions>(
    () => commentStorageKey ? loadSavedSections(commentStorageKey, commentSectionOptions) : commentSectionOptions
  )
  const [themeSections, setThemeSections] = useState<ThemeSummarySectionOptions>(
    () => themeStorageKey ? loadSavedSections(themeStorageKey, defaultThemeSections) : defaultThemeSections
  )

  useEffect(() => {
    if (!isOpen) {
      setCopied(false)
    }
  }, [isOpen])

  // Persist comment section choices
  useEffect(() => {
    if (commentStorageKey) {
      localStorage.setItem(commentStorageKey, JSON.stringify(commentSections))
    }
  }, [commentSections, commentStorageKey])

  // Persist theme summary section choices
  useEffect(() => {
    if (themeStorageKey) {
      localStorage.setItem(themeStorageKey, JSON.stringify(themeSections))
    }
  }, [themeSections, themeStorageKey])

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
      themeExtracts: !allChecked,
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
    
    // Theme-specific extracts (per-comment, per-theme analysis)
    if (commentSections.themeExtracts && themeExtracts) {
      const extract = themeExtracts[comment.id]
      if (extract) {
        const extractParts: string[] = []
        if (extract.positions?.length) {
          extractParts.push(`**Positions:**\n${extract.positions.map(p => `- ${p}`).join('\n')}`)
        }
        if (extract.concerns?.length) {
          extractParts.push(`**Concerns:**\n${extract.concerns.map(c => `- ${c}`).join('\n')}`)
        }
        if (extract.recommendations?.length) {
          extractParts.push(`**Recommendations:**\n${extract.recommendations.map(r => `- ${r}`).join('\n')}`)
        }
        if (extract.experiences?.length) {
          extractParts.push(`**Experiences:**\n${extract.experiences.map(e => `- ${e}`).join('\n')}`)
        }
        if (extract.key_quotes?.length) {
          extractParts.push(`**Key Quotes:**\n${extract.key_quotes.map(q => `- ${q}`).join('\n')}`)
        }
        if (extractParts.length > 0) {
          contentParts.push(`### Theme-Specific Analysis\n${extractParts.join('\n\n')}`)
        }
      }
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
      // Fallback: trigger share/download if clipboard fails
      handleExport()
    }
  }

  const hasShareApi = typeof navigator.share === 'function'

  const handleExport = async () => {
    const content = buildContent()
    const filename = `comments-${comments.length}-export.md`

    if (hasShareApi) {
      // Try file share first (iOS Safari, newer Android)
      try {
        const file = new File([content], filename, { type: 'text/plain;charset=utf-8' })
        if (navigator.canShare?.({ files: [file] })) {
          await navigator.share({ files: [file], title: filename })
          return
        }
      } catch (e) {
        if ((e as Error).name === 'AbortError') return
      }
      // Fall back to text-only share (Android Chrome, etc.)
      try {
        await navigator.share({ title: filename, text: content })
        return
      } catch (e) {
        if ((e as Error).name === 'AbortError') return
      }
    }
    // Final fallback: download
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  return (
    <>
      {/* Modal backdrop */}
      <div 
        className="fixed inset-0 bg-black bg-opacity-50 z-40"
        onClick={onClose}
      />
      
      {/* Modal content */}
      <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4" onClick={onClose}>
        <div className="bg-white rounded-t-xl sm:rounded-lg shadow-xl max-w-2xl w-full max-h-[85vh] sm:max-h-[80vh] flex flex-col mx-0 sm:mx-auto" onClick={(e)=>e.stopPropagation()}>
          {/* Header */}
          <div className="flex items-center justify-between p-4 sm:p-6 border-b border-gray-200 flex-shrink-0">
            <h2 className="text-lg sm:text-xl font-semibold text-gray-900 pr-4">{title}</h2>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 transition-colors flex-shrink-0"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          
          {/* Content */}
          <div className="p-4 sm:p-6 overflow-y-auto flex-1 min-h-0">
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
                  
                  {themeExtracts && (
                    <label
                      className="flex items-center space-x-3 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={commentSections.themeExtracts}
                        onChange={() => handleCommentSectionToggle('themeExtracts')}
                        className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                      />
                      <span className="text-sm text-gray-700">Theme-Specific Extracts (positions, concerns, recommendations)</span>
                    </label>
                  )}

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
          <div className="flex items-center justify-end space-x-2 sm:space-x-3 p-3 sm:p-4 border-t border-gray-200 flex-shrink-0 bg-white">
            <button
              onClick={onClose}
              className="px-3 sm:px-4 py-2 text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors text-sm"
            >
              Cancel
            </button>
            <button
              onClick={handleExport}
              className="flex items-center space-x-1.5 px-3 sm:px-4 py-2 bg-gray-700 hover:bg-gray-800 text-white rounded-lg transition-colors text-sm"
              title={hasShareApi ? 'Share as file' : 'Download as file'}
            >
              {hasShareApi ? <Share2 className="h-4 w-4" /> : <Download className="h-4 w-4" />}
              <span className="hidden sm:inline">{hasShareApi ? 'Share' : 'Download'}</span>
              <span className="sm:hidden">{hasShareApi ? 'Share' : '.md'}</span>
            </button>
            <button
              onClick={handleCopy}
              className="flex items-center space-x-1.5 px-3 sm:px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors text-sm"
              title="Copy to clipboard"
            >
              {copied ? (
                <>
                  <Check className="h-4 w-4" />
                  <span>Copied!</span>
                </>
              ) : (
                <>
                  <Copy className="h-4 w-4" />
                  <span className="hidden sm:inline">Copy</span>
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