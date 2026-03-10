import { useEffect } from 'react'
import { X } from 'lucide-react'

interface SearchHelpModalProps {
  isOpen: boolean
  onClose: () => void
}

function SearchHelpModal({ isOpen, onClose }: SearchHelpModalProps) {
  useEffect(() => {
    if (!isOpen) return
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [isOpen, onClose])

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/30" />
      <div
        className="relative bg-white rounded-lg shadow-xl max-w-md w-full mx-4 text-sm"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
          <h3 className="font-semibold text-gray-900">Search & Filter Help</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-4 py-4 space-y-4">
          {/* Search syntax */}
          <div>
            <h4 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-2">Search</h4>
            <table className="w-full">
              <tbody className="text-sm">
                <Row syntax="word1 word2" desc="Both required (AND)" />
                <Row syntax={'"exact phrase"'} desc="Phrase match" />
                <Row syntax="word1 OR word2" desc="Either matches" />
                <Row syntax="-word" desc="Exclude term" />
              </tbody>
            </table>
          </div>

          {/* Quick filters */}
          <div>
            <h4 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-2">Quick Filters</h4>
            <p className="text-xs text-gray-500 mb-1.5">Type in the search box to open a picker:</p>
            <table className="w-full">
              <tbody className="text-sm">
                <Row syntax="theme:" desc="Filter by theme" />
                <Row syntax="entity:" desc="Filter by entity" />
                <Row syntax="type:" desc="Filter by submitter type" />
              </tbody>
            </table>
            <p className="text-xs text-gray-400 mt-1.5">
              Add text after the colon to narrow results, e.g. <code className="bg-gray-100 px-1 rounded">theme:safety</code>
            </p>
          </div>

          {/* Keyboard shortcuts */}
          <div>
            <h4 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-2">Keyboard</h4>
            <table className="w-full">
              <tbody className="text-sm">
                <Row syntax="/" desc="Focus search" />
                <Row syntax="?" desc="This help" />
                <Row syntax="↑ ↓" desc="Navigate picker" />
                <Row syntax="Enter" desc="Select item" />
                <Row syntax="Tab" desc="Select item" />
                <Row syntax="Esc" desc="Close / dismiss" />
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}

function Row({ syntax, desc }: { syntax: string; desc: string }) {
  return (
    <tr>
      <td className="py-0.5 pr-4 font-mono text-gray-700 whitespace-nowrap">{syntax}</td>
      <td className="py-0.5 text-gray-500">{desc}</td>
    </tr>
  )
}

export default SearchHelpModal
