// Full-text search without downloading the comments' text.
//
// build-website writes an inverted index over each unit's search text (see buildSearchText):
//   data/search/index.json   { units: unitIds by ordinal, words: sorted vocabulary, lens: byte
//                              length of each word's posting list (negative = bitmap) }
//   data/search/postings.bin concatenated posting lists (delta + varint unit ordinals, or bitmaps)
//
// Search keeps the old semantics (case-insensitive substring match, AND between terms, OR
// groups, -negation):
// - A term made only of letters/digits matches exactly the units with a vocabulary word that
//   contains it, so it is answered from the index alone.
// - Phrases and terms with punctuation are narrowed to units containing every word in them,
//   then verified against the units' text, which is fetched shard by shard (with progress).
import type { Comment } from '../types'
import type { SearchToken } from './searchParser'
import { buildSearchText, matchesSearchText } from './searchParser'
import { forEachCommentContent, type LoadProgress } from './commentData'

const WORD_RE = /[\p{L}\p{N}]+/gu
const SINGLE_WORD_RE = /^[\p{L}\p{N}]+$/u

interface SearchIndex {
  units: string[]
  unitOrdinal: Map<string, number>
  words: string[]
  offsets: Uint32Array // byte offset of each word's list; offsets[i+1] - offsets[i] = length
  bitmap: Uint8Array // 1 if word i's list is a bitmap
  postings: Uint8Array
  maxWord: number
}

let indexPromise: Promise<SearchIndex> | null = null

export function loadSearchIndex(): Promise<SearchIndex> {
  if (!indexPromise) {
    indexPromise = (async () => {
      const [meta, buf] = await Promise.all([
        fetch('./data/search/index.json').then(r => {
          if (!r.ok) throw new Error(`search index: HTTP ${r.status}`)
          return r.json()
        }),
        fetch('./data/search/postings.bin').then(r => {
          if (!r.ok) throw new Error(`search postings: HTTP ${r.status}`)
          return r.arrayBuffer()
        }),
      ])
      const n = meta.words.length
      const offsets = new Uint32Array(n + 1)
      const bitmap = new Uint8Array(n)
      for (let i = 0; i < n; i++) {
        const len = meta.lens[i]
        if (len < 0) bitmap[i] = 1
        offsets[i + 1] = offsets[i] + Math.abs(len)
      }
      const unitOrdinal = new Map<string, number>()
      meta.units.forEach((id: string, i: number) => unitOrdinal.set(id, i))
      return {
        units: meta.units,
        unitOrdinal,
        words: meta.words,
        offsets,
        bitmap,
        postings: new Uint8Array(buf),
        maxWord: meta.maxWord ?? 60,
      }
    })()
    indexPromise.catch(() => { indexPromise = null })
  }
  return indexPromise
}

// Mark every unit in word i's posting list
function addPostings(ix: SearchIndex, i: number, out: Uint8Array) {
  const start = ix.offsets[i]
  const end = ix.offsets[i + 1]
  const p = ix.postings
  if (ix.bitmap[i]) {
    for (let b = start; b < end; b++) {
      const byte = p[b]
      if (!byte) continue
      const base = (b - start) << 3
      for (let bit = 0; bit < 8; bit++) if (byte & (1 << bit)) out[base + bit] = 1
    }
    return
  }
  let pos = start
  let prev = -1
  while (pos < end) {
    let delta = 0
    let shift = 0
    let byte
    do {
      byte = p[pos++]
      delta |= (byte & 0x7f) << shift
      shift += 7
    } while (byte & 0x80)
    prev += delta
    out[prev] = 1
  }
}

// Units whose search text contains `fragment` within a single word
function unitsWithWordContaining(ix: SearchIndex, fragment: string, cache: Map<string, Uint8Array>): Uint8Array {
  let hit = cache.get(fragment)
  if (hit) return hit
  hit = new Uint8Array(ix.units.length)
  if (fragment.length <= ix.maxWord) {
    const words = ix.words
    for (let i = 0; i < words.length; i++) {
      if (words[i].includes(fragment)) addPostings(ix, i, hit)
    }
  }
  cache.set(fragment, hit)
  return hit
}

// Three-valued match per unit: 0 = no, 1 = yes, 2 = maybe (needs text verification)
type Tri = 0 | 1 | 2

function tokenMatcher(ix: SearchIndex, token: SearchToken, cache: Map<string, Uint8Array>): (ordinal: number) => Tri {
  const value = token.value.toLowerCase()
  if (SINGLE_WORD_RE.test(value)) {
    const set = unitsWithWordContaining(ix, value, cache)
    return o => (set[o] ? 1 : 0)
  }
  const parts = value.match(WORD_RE) || []
  if (parts.length === 0) return () => 2
  // Every word of the phrase must occur (a superset of the units containing the phrase)
  const sets = parts.map(w => unitsWithWordContaining(ix, w, cache))
  return o => (sets.every(s => s[o]) ? 2 : 0)
}

function and(a: Tri, b: Tri): Tri {
  if (a === 0 || b === 0) return 0
  return a === 2 || b === 2 ? 2 : 1
}
function or(a: Tri, b: Tri): Tri {
  if (a === 1 || b === 1) return 1
  return a === 2 || b === 2 ? 2 : 0
}
function not(a: Tri): Tri {
  return a === 2 ? 2 : a === 1 ? 0 : 1
}

function groupTokens(tokens: SearchToken[]): SearchToken[][] {
  const groups = new Map<number, SearchToken[]>()
  for (const t of tokens) {
    if (!groups.has(t.orGroup)) groups.set(t.orGroup, [])
    groups.get(t.orGroup)!.push(t)
  }
  return [...groups.values()]
}

export interface IndexSearchResult {
  matches: Set<string> // definite matches
  toVerify: Set<string> // need their text checked
}

// Evaluate the query over `units` (comments) with the index
export function searchWithIndex(ix: SearchIndex, tokens: SearchToken[], units: Comment[]): IndexSearchResult {
  const cache = new Map<string, Uint8Array>()
  const groups = groupTokens(tokens).map(g => ({
    pos: g.filter(t => !t.negated).map(t => tokenMatcher(ix, t, cache)),
    neg: g.filter(t => t.negated).map(t => tokenMatcher(ix, t, cache)),
  }))
  const matches = new Set<string>()
  const toVerify = new Set<string>()
  for (const c of units) {
    const o = ix.unitOrdinal.get(c.id)
    let result: Tri
    if (o === undefined) {
      result = 2 // not in the index (shouldn't happen): fall back to checking its text
    } else {
      result = 1
      for (const g of groups) {
        let gr: Tri = 1
        for (const m of g.neg) gr = and(gr, not(m(o)))
        if (g.pos.length) {
          let any: Tri = 0
          for (const m of g.pos) any = or(any, m(o))
          gr = and(gr, any)
        }
        result = and(result, gr)
        if (result === 0) break
      }
    }
    if (result === 1) matches.add(c.id)
    else if (result === 2) toVerify.add(c.id)
  }
  return { matches, toVerify }
}

// Check candidates against their search text, fetching shards as needed. The full text is
// checked first: for a query without negations, a match there is a match in the whole search
// text, so condensed sections (detail shards) are fetched only for the candidates left over.
export async function verifyCandidates(
  candidates: Comment[],
  tokens: SearchToken[],
  onVerified: (matched: string[], rejected: string[]) => void,
  onProgress: (p: LoadProgress) => void,
  isCancelled: () => boolean,
): Promise<void> {
  const hasNegation = tokens.some(t => t.negated)
  // Stage 1: full text only
  const unresolved: Comment[] = []
  const textById = new Map<string, string | undefined>()
  let stage1Total = 0
  await forEachCommentContent(
    candidates,
    true,
    items => {
      const matched: string[] = []
      for (const { comment, content } of items) {
        const text = content.sections?.detailedContent
        if (!hasNegation && text && matchesSearchText(text.toLowerCase(), tokens)) {
          matched.push(comment.id)
        } else {
          unresolved.push(comment)
          textById.set(comment.id, text)
        }
      }
      onVerified(matched, [])
    },
    p => { stage1Total = p.total; onProgress(p) },
    isCancelled,
    false,
  )
  if (isCancelled() || unresolved.length === 0) return
  // Stage 2: whole search text, fetching only the condensed sections
  await forEachCommentContent(
    unresolved,
    false,
    items => {
      const matched: string[] = []
      const rejected: string[] = []
      for (const { comment, content } of items) {
        const sections = { ...content.sections, detailedContent: textById.get(comment.id) }
        const text = buildSearchText({ ...comment, structuredSections: sections })
        if (matchesSearchText(text, tokens)) matched.push(comment.id)
        else rejected.push(comment.id)
      }
      onVerified(matched, rejected)
    },
    p => onProgress({ done: stage1Total + p.done, total: stage1Total + p.total }),
    isCancelled,
  )
}
