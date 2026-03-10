export interface SearchToken {
  id: string
  type: 'term' | 'phrase'
  value: string
  negated: boolean
  orGroup: number
  startIndex: number
  endIndex: number
}

let nextId = 0
function genId(): string {
  return `tok_${nextId++}`
}

export function parseSearchQuery(query: string): SearchToken[] {
  const tokens: SearchToken[] = []
  let i = 0
  let orGroup = 0

  while (i < query.length) {
    // Skip whitespace
    while (i < query.length && query[i] === ' ') i++
    if (i >= query.length) break

    // Check for OR keyword
    if (
      query.slice(i, i + 2).toUpperCase() === 'OR' &&
      (i + 2 >= query.length || query[i + 2] === ' ') &&
      tokens.length > 0
    ) {
      // OR joins next token into same orGroup as previous — don't increment
      i += 2
      continue
    }

    // Check for negation
    const negated = query[i] === '-'
    const startIndex = i
    if (negated) i++

    if (i >= query.length) break

    let value: string
    let type: 'term' | 'phrase'

    if (query[i] === '"') {
      // Quoted phrase
      i++ // skip opening quote
      const closeQuote = query.indexOf('"', i)
      if (closeQuote === -1) {
        // Unmatched quote — take rest of string
        value = query.slice(i)
        i = query.length
      } else {
        value = query.slice(i, closeQuote)
        i = closeQuote + 1
      }
      type = 'phrase'
    } else {
      // Regular word — consume until whitespace
      const wordStart = i
      while (i < query.length && query[i] !== ' ' && query[i] !== '"') i++
      value = query.slice(wordStart, i)
      type = 'term'
    }

    if (!value) continue

    // Decide orGroup: if the previous token was followed by OR, reuse its orGroup
    // We detect this by checking if orGroup wasn't incremented since last token
    // prevToken used to detect OR continuation (same orGroup as previous)

    tokens.push({
      id: genId(),
      type,
      value,
      negated,
      orGroup,
      startIndex,
      endIndex: i,
    })

    // Next token starts a new orGroup (unless OR keyword appears)
    orGroup++
  }

  return tokens
}

export function tokensToString(tokens: SearchToken[]): string {
  if (tokens.length === 0) return ''

  // Group by orGroup
  const groups = new Map<number, SearchToken[]>()
  for (const token of tokens) {
    if (!groups.has(token.orGroup)) groups.set(token.orGroup, [])
    groups.get(token.orGroup)!.push(token)
  }

  const parts: string[] = []
  for (const group of groups.values()) {
    const groupParts = group.map(t => {
      const prefix = t.negated ? '-' : ''
      return t.type === 'phrase' ? `${prefix}"${t.value}"` : `${prefix}${t.value}`
    })
    parts.push(groupParts.join(' OR '))
  }

  return parts.join(' ')
}

export function removeToken(tokens: SearchToken[], tokenId: string): SearchToken[] {
  const filtered = tokens.filter(t => t.id !== tokenId)
  // Renumber orGroups to be contiguous
  const groupMap = new Map<number, number>()
  let nextGroup = 0
  return filtered.map(t => {
    if (!groupMap.has(t.orGroup)) {
      groupMap.set(t.orGroup, nextGroup++)
    }
    return { ...t, orGroup: groupMap.get(t.orGroup)! }
  })
}

interface Searchable {
  structuredSections?: {
    oneLineSummary?: string
    corePosition?: string
    detailedContent?: string
    keyRecommendations?: string
    mainConcerns?: string
    commenterProfile?: string
  }
  submitter?: string
  id?: string
}

function buildSearchText(comment: Searchable): string {
  const parts: string[] = []
  if (comment.structuredSections) {
    const s = comment.structuredSections
    if (s.oneLineSummary) parts.push(s.oneLineSummary)
    if (s.corePosition) parts.push(s.corePosition)
    if (s.detailedContent) parts.push(s.detailedContent)
    if (s.keyRecommendations) parts.push(s.keyRecommendations)
    if (s.mainConcerns) parts.push(s.mainConcerns)
    if (s.commenterProfile) parts.push(s.commenterProfile)
  }
  if (comment.submitter) parts.push(comment.submitter)
  if (comment.id) parts.push(comment.id)
  return parts.join(' ').toLowerCase()
}

export function matchesSearchQuery(comment: Searchable, tokens: SearchToken[]): boolean {
  if (tokens.length === 0) return true

  const text = buildSearchText(comment)

  // Group tokens by orGroup
  const groups = new Map<number, SearchToken[]>()
  for (const token of tokens) {
    if (!groups.has(token.orGroup)) groups.set(token.orGroup, [])
    groups.get(token.orGroup)!.push(token)
  }

  // All groups must pass (AND between groups)
  for (const group of groups.values()) {
    const positiveTokens = group.filter(t => !t.negated)
    const negativeTokens = group.filter(t => t.negated)

    // Negative tokens: ALL must not match
    for (const t of negativeTokens) {
      if (text.includes(t.value.toLowerCase())) return false
    }

    // Positive tokens: at least one must match (OR within group)
    if (positiveTokens.length > 0) {
      const anyMatch = positiveTokens.some(t => text.includes(t.value.toLowerCase()))
      if (!anyMatch) return false
    }
  }

  return true
}
