import { X } from 'lucide-react'
import type { SearchToken } from '../utils/searchParser'
import type { Theme } from '../types'

interface ActiveFilterChipsProps {
  searchTokens: SearchToken[]
  themes: string[]
  entities: string[]
  submitterTypes: string[]
  themeList: Theme[]
  entityMap: Record<string, { label: string; mentionCount: number }[]>
  onRemoveSearchToken: (tokenId: string) => void
  onRemoveTheme: (code: string) => void
  onRemoveEntity: (key: string) => void
  onRemoveSubmitterType: (value: string) => void
  onClearAll: () => void
  onClickSearchToken?: (token: SearchToken) => void
}

function ActiveFilterChips({
  searchTokens,
  themes,
  entities,
  submitterTypes,
  themeList,
  entityMap: _entityMap,
  onRemoveSearchToken,
  onRemoveTheme,
  onRemoveEntity,
  onRemoveSubmitterType,
  onClearAll,
  onClickSearchToken,
}: ActiveFilterChipsProps) {
  const totalFilters = searchTokens.length + themes.length + entities.length + submitterTypes.length
  if (totalFilters === 0) return null

  // Group search tokens by orGroup
  const orGroups = new Map<number, SearchToken[]>()
  for (const token of searchTokens) {
    if (!orGroups.has(token.orGroup)) orGroups.set(token.orGroup, [])
    orGroups.get(token.orGroup)!.push(token)
  }

  return (
    <div className="flex flex-wrap items-center gap-2 py-2">
      {/* Search token chips */}
      {Array.from(orGroups.entries()).map(([groupId, group]) => (
        <span key={`or-${groupId}`} className="inline-flex items-center gap-0.5">
          {group.map((token, i) => (
            <span key={token.id} className="inline-flex items-center">
              {i > 0 && (
                <span className="text-xs text-gray-400 mx-1 font-medium">OR</span>
              )}
              <span
                className={`inline-flex items-center gap-1 px-2.5 py-1 text-sm rounded-full border cursor-default ${
                  token.negated
                    ? 'bg-red-50 text-red-700 border-red-200'
                    : 'bg-gray-100 text-gray-700 border-gray-200'
                }`}
              >
                <span
                  className={`${token.negated ? 'line-through' : ''} ${onClickSearchToken ? 'cursor-pointer hover:underline' : ''}`}
                  onClick={() => onClickSearchToken?.(token)}
                >
                  {token.negated && <span className="no-underline mr-0.5">-</span>}
                  {token.type === 'phrase' ? `"${token.value}"` : token.value}
                </span>
                <button
                  onClick={() => onRemoveSearchToken(token.id)}
                  className="ml-0.5 hover:text-gray-900 transition-colors"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            </span>
          ))}
        </span>
      ))}

      {/* Theme chips */}
      {themes.map(code => {
        const theme = themeList.find(t => t.code === code)
        const label = theme?.label || code
        return (
          <span
            key={`theme-${code}`}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-sm rounded-full border bg-blue-50 text-blue-700 border-blue-200"
          >
            <span className="font-medium">Theme:</span> {code} {label}
            <button
              onClick={() => onRemoveTheme(code)}
              className="ml-0.5 hover:text-blue-900 transition-colors"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        )
      })}

      {/* Entity chips */}
      {entities.map(key => {
        const [_category, label] = key.split('|')
        return (
          <span
            key={`entity-${key}`}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-sm rounded-full border bg-green-50 text-green-700 border-green-200"
          >
            {label}
            <button
              onClick={() => onRemoveEntity(key)}
              className="ml-0.5 hover:text-green-900 transition-colors"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        )
      })}

      {/* Submitter type chips */}
      {submitterTypes.map(value => (
        <span
          key={`type-${value}`}
          className="inline-flex items-center gap-1 px-2.5 py-1 text-sm rounded-full border bg-purple-50 text-purple-700 border-purple-200"
        >
          {value}
          <button
            onClick={() => onRemoveSubmitterType(value)}
            className="ml-0.5 hover:text-purple-900 transition-colors"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}

      {/* Clear all */}
      {totalFilters >= 2 && (
        <button
          onClick={onClearAll}
          className="text-sm text-gray-500 hover:text-gray-700 ml-1"
        >
          Clear all
        </button>
      )}
    </div>
  )
}

export default ActiveFilterChips
