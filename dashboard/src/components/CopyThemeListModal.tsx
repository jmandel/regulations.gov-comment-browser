import { useState, useEffect } from 'react'
import { X, Copy, Check } from 'lucide-react'
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
            <h2 className="text-xl font-semibold text-gray-900">
              Copy Theme Hierarchy for LLM
            </h2>
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

export default CopyThemeListModal 