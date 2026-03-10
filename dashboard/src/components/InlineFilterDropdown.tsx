import { useEffect, useRef } from 'react'
import { Check } from 'lucide-react'
import type { PickerItem } from './FilterAddButtons'

interface InlineFilterDropdownProps {
  items: PickerItem[]
  highlightIndex: number
  onSelect: (key: string) => void
  onHighlightChange: (index: number) => void
  label: string
}

function InlineFilterDropdown({ items, highlightIndex, onSelect, onHighlightChange, label }: InlineFilterDropdownProps) {
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!listRef.current) return
    const el = listRef.current.children[highlightIndex] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [highlightIndex])

  return (
    <div className="absolute top-full left-0 right-0 mt-1 bg-white rounded-lg shadow-lg border border-gray-200 z-30 overflow-hidden">
      <div className="px-3 py-1.5 text-xs font-medium text-gray-500 bg-gray-50 border-b border-gray-200">
        {label}
      </div>
      <div className="max-h-60 overflow-y-auto" ref={listRef}>
        {items.length === 0 ? (
          <div className="px-3 py-4 text-sm text-gray-500 text-center">No matches</div>
        ) : (
          items.map((item, index) => (
            <button
              key={item.key}
              onClick={() => onSelect(item.key)}
              onMouseEnter={() => onHighlightChange(index)}
              className={`w-full text-left px-3 py-2 text-sm flex items-center justify-between transition-colors ${
                index === highlightIndex ? 'bg-blue-50' : item.selected ? 'bg-gray-50' : 'hover:bg-gray-50'
              }`}
            >
              <div className="flex items-center gap-2 min-w-0">
                {item.selected ? (
                  <Check className="h-4 w-4 text-green-600 flex-shrink-0" />
                ) : (
                  <span className="w-4 flex-shrink-0" />
                )}
                <div className="min-w-0">
                  <div className="truncate">{item.label}</div>
                  {item.sublabel && (
                    <div className="text-xs text-gray-400 truncate">{item.sublabel}</div>
                  )}
                </div>
              </div>
              {item.count !== undefined && (
                <span className="text-xs text-gray-400 flex-shrink-0 ml-2">{item.count}</span>
              )}
            </button>
          ))
        )}
      </div>
    </div>
  )
}

export default InlineFilterDropdown
