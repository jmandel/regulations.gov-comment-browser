import { useState, useEffect } from 'react'
import { X, Copy, Check, Download, Share2 } from 'lucide-react'
import { Theme } from '../types'

interface CopyThemeListModalProps {
  isOpen: boolean
  onClose: () => void
  themes: Theme[]
}

function CopyThemeListModal({ isOpen, onClose, themes }: CopyThemeListModalProps) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!isOpen) {
      setCopied(false)
    }
  }, [isOpen])

  if (!isOpen) return null

  const buildThemeHierarchy = (themes: Theme[], parentCode: string | null = null, depth = 0): string => {
    let content = ''
    const children = themes.filter(t => t.parent_code === parentCode)
    
    children.forEach(theme => {
      const indent = '  '.repeat(depth)
      content += `${indent}- **${theme.code}**: ${theme.label || theme.description} (${theme.direct_count} comments)\n`
      
      if (theme.detailedDescription) {
        content += `${indent}  _${theme.detailedDescription}_\n`
      }
      
      // Recursively add children
      const childContent = buildThemeHierarchy(themes, theme.code, depth + 1)
      if (childContent) {
        content += childContent
      }
    })
    
    return content
  }

  const buildContent = () => {
    let content = `# Theme Hierarchy\n\n`
    
    // Stats
    const totalThemes = themes.length
    const themesWithMentions = themes.length
    const totalMentions = themes.reduce((sum, t) => sum + t.direct_count, 0)
    
    content += `## Statistics\n`
    content += `- Total Themes: ${totalThemes}\n`
    content += `- Themes: ${themesWithMentions}\n`
    content += `- Total Direct Mentions: ${totalMentions}\n\n`
    
    content += `## Theme Structure\n\n`
    content += buildThemeHierarchy(themes)
    
    return content
  }

  const handleCopy = async () => {
    const content = buildContent()
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
      handleExport()
    }
  }

  const canShare = typeof navigator.share === 'function' && typeof navigator.canShare === 'function'

  const handleExport = async () => {
    const content = buildContent()
    const filename = `theme-hierarchy-${themes.length}-themes.md`
    const file = new File([content], filename, { type: 'text/plain;charset=utf-8' })

    if (canShare) {
      try {
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: filename })
          return
        }
      } catch (e) {
        if ((e as Error).name === 'AbortError') return
        // Fall through to download
      }
    }
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
            <h2 className="text-lg sm:text-xl font-semibold text-gray-900 pr-4">
              Copy Theme Hierarchy for LLM
            </h2>
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
              <p className="text-sm text-gray-600">
                This will copy the complete theme hierarchy with statistics and descriptions.
              </p>
              
              <div className="bg-gray-50 rounded-lg p-4">
                <h3 className="text-sm font-medium text-gray-700 mb-2">Preview:</h3>
                <ul className="text-sm text-gray-600 space-y-1">
                  <li>• Theme hierarchy structure</li>
                  <li>• Comment counts for each theme</li>
                  <li>• Theme descriptions</li>
                  <li>• Overall statistics</li>
                </ul>
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
              title={canShare ? 'Share as file' : 'Download as file'}
            >
              {canShare ? <Share2 className="h-4 w-4" /> : <Download className="h-4 w-4" />}
              <span className="hidden sm:inline">{canShare ? 'Share' : 'Download'}</span>
              <span className="sm:hidden">{canShare ? 'Share' : '.md'}</span>
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

export default CopyThemeListModal 