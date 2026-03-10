import { useState, useRef, useEffect, useMemo } from 'react'
import { Plus, Search, Check } from 'lucide-react'
import type { Theme } from '../types'

interface FilterAddButtonsProps {
  themes: Theme[]
  entities: Record<string, { label: string; definition?: string; mentionCount: number }[]>
  submitterTypes: string[]
  selectedThemes: string[]
  selectedEntities: string[]
  selectedSubmitterTypes: string[]
  onAddTheme: (code: string) => void
  onAddEntity: (key: string) => void
  onAddSubmitterType: (value: string) => void
}

function FilterAddButtons({
  themes,
  entities,
  submitterTypes,
  selectedThemes,
  selectedEntities,
  selectedSubmitterTypes,
  onAddTheme,
  onAddEntity,
  onAddSubmitterType,
}: FilterAddButtonsProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <FilterPicker
        label="Theme"
        colorClass="blue"
        items={themes
          .filter(t => t.comment_count > 0)
          .map(t => ({
            key: t.code,
            label: `${t.code} ${t.label || t.description}`,
            count: t.direct_count,
            selected: selectedThemes.includes(t.code),
          }))}
        onSelect={(key) => onAddTheme(key)}
      />
      <FilterPicker
        label="Entity"
        colorClass="green"
        items={Object.entries(entities).flatMap(([category, entityList]) =>
          entityList
            .filter(e => e.mentionCount > 0)
            .map(e => ({
              key: `${category}|${e.label}`,
              label: e.label,
              sublabel: category,
              count: e.mentionCount,
              selected: selectedEntities.includes(`${category}|${e.label}`),
            }))
        )}
        onSelect={(key) => onAddEntity(key)}
      />
      <FilterPicker
        label="Type"
        colorClass="purple"
        items={submitterTypes.map(type => ({
          key: type,
          label: type,
          selected: selectedSubmitterTypes.includes(type),
        }))}
        onSelect={(key) => onAddSubmitterType(key)}
      />
    </div>
  )
}

export interface PickerItem {
  key: string
  label: string
  sublabel?: string
  count?: number
  selected: boolean
}

interface FilterPickerProps {
  label: string
  colorClass: 'blue' | 'green' | 'purple'
  items: PickerItem[]
  onSelect: (key: string) => void
}

const colorMap = {
  blue: {
    button: 'text-blue-600 border-blue-200 hover:bg-blue-50',
    header: 'bg-blue-50',
  },
  green: {
    button: 'text-green-600 border-green-200 hover:bg-green-50',
    header: 'bg-green-50',
  },
  purple: {
    button: 'text-purple-600 border-purple-200 hover:bg-purple-50',
    header: 'bg-purple-50',
  },
}

function FilterPicker({ label, colorClass, items, onSelect }: FilterPickerProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [highlightIndex, setHighlightIndex] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const colors = colorMap[colorClass]

  // Close on click outside
  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
        setSearch('')
        setHighlightIndex(0)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  // Focus search on open
  useEffect(() => {
    if (open) {
      searchInputRef.current?.focus()
      setHighlightIndex(0)
    }
  }, [open])

  const filtered = useMemo(() => {
    if (!search) return items
    const q = search.toLowerCase()
    return items.filter(
      item =>
        item.label.toLowerCase().includes(q) ||
        (item.sublabel && item.sublabel.toLowerCase().includes(q))
    )
  }, [items, search])

  // Reset highlight when filtered list changes
  useEffect(() => {
    setHighlightIndex(0)
  }, [filtered])

  // Scroll highlighted item into view
  useEffect(() => {
    if (!listRef.current) return
    const el = listRef.current.children[highlightIndex] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [highlightIndex])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open || filtered.length === 0) return

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setHighlightIndex(i => (i + 1) % filtered.length)
        break
      case 'ArrowUp':
        e.preventDefault()
        setHighlightIndex(i => (i - 1 + filtered.length) % filtered.length)
        break
      case 'Enter':
        e.preventDefault()
        if (filtered[highlightIndex]) {
          onSelect(filtered[highlightIndex].key)
        }
        break
      case 'Escape':
        e.preventDefault()
        setOpen(false)
        setSearch('')
        setHighlightIndex(0)
        break
    }
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        onClick={() => setOpen(!open)}
        className={`inline-flex items-center gap-1 px-2.5 py-1.5 text-sm border rounded-lg transition-colors ${colors.button}`}
      >
        <Plus className="h-3.5 w-3.5" />
        {label}
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 w-72 bg-white rounded-lg shadow-lg border border-gray-200 z-20 overflow-hidden">
          <div className={`p-2 ${colors.header} border-b border-gray-200`}>
            <div className="relative">
              <Search className="absolute left-2.5 top-2 h-4 w-4 text-gray-400" />
              <input
                ref={searchInputRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={`Filter ${label.toLowerCase()}s...`}
                className="w-full pl-8 pr-3 py-1.5 text-sm border border-gray-300 rounded-md focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
          </div>
          <div className="max-h-60 overflow-y-auto" ref={listRef}>
            {filtered.length === 0 ? (
              <div className="px-3 py-4 text-sm text-gray-500 text-center">No matches</div>
            ) : (
              filtered.map((item, index) => (
                <button
                  key={item.key}
                  onClick={() => {
                    onSelect(item.key)
                  }}
                  onMouseEnter={() => setHighlightIndex(index)}
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
      )}
    </div>
  )
}

export default FilterAddButtons
