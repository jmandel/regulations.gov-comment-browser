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
// - Phrases and terms with punctuation are narrowed to units containing every word in them and,
//   when the docket has the word-pair index (search/pairs.json + pairs/NNN.json, see
//   src/lib/phrase-index.ts), every adjacent pair of words with the separator between them. A
//   phrase of exactly two words is then answered from the pair index; other candidates are
//   verified against the units' text, which is fetched shard by shard (with progress).
import type { Comment } from '../types'
import type { SearchToken } from './searchParser'
import { buildSearchText, matchesSearchText } from './searchParser'
import { forEachCommentContent, type LoadProgress } from './commentData'
import { sharedData } from './dataPaths'

const WORD_RE = /[\p{L}\p{N}]+/gu
const SINGLE_WORD_RE = /^[\p{L}\p{N}]+$/u

// Posting lists stored back to back, as written by build-website
interface PostingLists {
  offsets: Uint32Array // byte offset of each list; offsets[i+1] - offsets[i] = length
  bitmap: Uint8Array // 1 if list i is a bitmap
  postings: Uint8Array
}

interface SearchIndex extends PostingLists {
  units: string[]
  unitOrdinal: Map<string, number>
  words: string[]
  maxWord: number
}

function listOffsets(lens: number[]): Pick<PostingLists, 'offsets' | 'bitmap'> {
  const offsets = new Uint32Array(lens.length + 1)
  const bitmap = new Uint8Array(lens.length)
  for (let i = 0; i < lens.length; i++) {
    if (lens[i] < 0) bitmap[i] = 1
    offsets[i + 1] = offsets[i] + Math.abs(lens[i])
  }
  return { offsets, bitmap }
}

let indexPromise: Promise<SearchIndex> | null = null
let loadedIndex: SearchIndex | null = null

// The search index if it has finished loading
export function peekSearchIndex(): SearchIndex | null {
  return loadedIndex
}

export function loadSearchIndex(): Promise<SearchIndex> {
  if (!indexPromise) {
    indexPromise = (async () => {
      const [meta, buf] = await Promise.all([
        fetch(sharedData('search/index.json')).then(r => {
          if (!r.ok) throw new Error(`search index: HTTP ${r.status}`)
          return r.json()
        }),
        fetch(sharedData('search/postings.bin')).then(r => {
          if (!r.ok) throw new Error(`search postings: HTTP ${r.status}`)
          return r.arrayBuffer()
        }),
      ])
      const unitOrdinal = new Map<string, number>()
      meta.units.forEach((id: string, i: number) => unitOrdinal.set(id, i))
      loadedIndex = {
        units: meta.units,
        unitOrdinal,
        words: meta.words,
        ...listOffsets(meta.lens),
        postings: new Uint8Array(buf),
        maxWord: meta.maxWord ?? 60,
      }
      return loadedIndex
    })()
    indexPromise.catch(() => { indexPromise = null })
  }
  return indexPromise
}

// Mark every unit in list i
function addPostings(ix: PostingLists, i: number, out: Uint8Array) {
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

// --- Word-pair index (optional; dockets built before it lack search/pairs.json) ---

interface PairMeta {
  shards: number
  maxWord: number
  maxSep: number
  longUnits: Set<number> // units with a word too long to index; checked against their text
}

interface PairShard extends PostingLists {
  keys: string[] // sorted
}

// A phrase's units according to the pair index: `units` has every unit containing all the pairs
// looked up; `exact` means these are exactly the units containing the phrase, apart from
// `longUnits`, which the index can't rule out
export interface PhraseMatch {
  units: Uint8Array
  exact: boolean
  longUnits: Set<number>
}

const MAX_PAIR_SHARDS = 24 // per query; positions needing more are skipped (less narrowing)

let pairMetaPromise: Promise<PairMeta | null> | null = null
const pairShards = new Map<number, Promise<PairShard>>()

function loadPairMeta(): Promise<PairMeta | null> {
  if (!pairMetaPromise) {
    pairMetaPromise = fetch(sharedData('search/pairs.json'))
      .then(r => (r.ok ? r.json() : null))
      .then(m => (m ? { shards: m.shards, maxWord: m.maxWord, maxSep: m.maxSep, longUnits: new Set<number>(m.longUnits) } : null))
      .catch(() => null)
  }
  return pairMetaPromise
}

function loadPairShard(n: number): Promise<PairShard> {
  let p = pairShards.get(n)
  if (!p) {
    p = fetch(sharedData(`search/pairs/${String(n).padStart(3, '0')}.json`))
      .then(r => {
        if (!r.ok) throw new Error(`search pairs ${n}: HTTP ${r.status}`)
        return r.json()
      })
      .then(({ keys, lens, postings }) => {
        const bin = atob(postings)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        return { keys, ...listOffsets(lens), postings: bytes }
      })
    p.catch(() => pairShards.delete(n))
    pairShards.set(n, p)
  }
  return p
}

// Same hash as src/lib/phrase-index.ts
function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h
}

function lowerBound(arr: string[], key: string): number {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid] < key) lo = mid + 1
    else hi = mid
  }
  return lo
}

// One lookup: the key `left + sep + right`, or every key starting with it when the phrase may
// continue the right-hand word ("primary sou" -> "primary source", "primary sources")
interface PairLookup { shard: number; key: string; prefix: boolean }

// Narrow a phrase with the pair index. Each adjacent pair of words in the phrase must occur in
// the unit with the same separator. The first word may end a longer word and the last may start
// one (substring semantics), so those are expanded over the vocabulary.
async function matchPhrase(ix: SearchIndex, meta: PairMeta, value: string): Promise<PhraseMatch | null> {
  const parts = [...value.matchAll(WORD_RE)]
  if (parts.length < 2) return null
  const n = parts.length
  const startsWithWord = parts[0].index === 0
  const endsWithWord = parts[n - 1].index! + parts[n - 1][0].length === value.length
  const positions: PairLookup[][] = []
  for (let i = 0; i < n - 1; i++) {
    const left = parts[i][0]
    const right = parts[i + 1][0]
    const sep = value.slice(parts[i].index! + left.length, parts[i + 1].index)
    if (left.length > meta.maxWord || right.length > meta.maxWord || sep.length > meta.maxSep) return null
    const lefts = i === 0 && startsWithWord ? ix.words.filter(w => w.endsWith(left)) : [left]
    const prefix = i === n - 2 && endsWithWord
    positions.push(lefts.map(l => ({ shard: fnv1a(l + sep + right[0]) % meta.shards, key: l + sep + right, prefix })))
  }
  // Use the cheapest positions within the shard budget
  const order = positions
    .map(p => ({ p, shards: new Set(p.map(l => l.shard)) }))
    .sort((a, b) => a.shards.size - b.shards.size)
  const used: PairLookup[][] = []
  const shardSet = new Set<number>()
  for (const { p, shards } of order) {
    const next = new Set([...shardSet, ...shards])
    if (next.size > MAX_PAIR_SHARDS) continue
    used.push(p)
    next.forEach(s => shardSet.add(s))
  }
  if (used.length === 0) return null
  const shards = new Map<number, PairShard>()
  await Promise.all([...shardSet].map(async s => shards.set(s, await loadPairShard(s))))

  let units: Uint8Array | null = null
  for (const lookups of used) {
    const hit = new Uint8Array(ix.units.length)
    for (const { shard, key, prefix } of lookups) {
      const sh = shards.get(shard)!
      for (let j = lowerBound(sh.keys, key); j < sh.keys.length; j++) {
        const k = sh.keys[j]
        if (prefix ? !k.startsWith(key) : k !== key) break
        addPostings(sh, j, hit)
      }
    }
    if (units) for (let o = 0; o < hit.length; o++) units[o] &= hit[o]
    else units = hit
  }
  return { units: units!, exact: n === 2 && startsWithWord && endsWithWord, longUnits: meta.longUnits }
}

// Look up the query's phrases (and punctuated terms) in the pair index, if the docket has one
export async function matchPhrases(ix: SearchIndex, tokens: SearchToken[]): Promise<Map<string, PhraseMatch>> {
  const out = new Map<string, PhraseMatch>()
  const values = [...new Set(tokens.map(t => t.value.toLowerCase()).filter(v => !SINGLE_WORD_RE.test(v)))]
  if (values.length === 0) return out
  const meta = await loadPairMeta()
  if (!meta) return out
  await Promise.all(values.map(async v => {
    const m = await matchPhrase(ix, meta, v)
    if (m) out.set(v, m)
  }))
  return out
}

// Three-valued match per unit: 0 = no, 1 = yes, 2 = maybe (needs text verification)
type Tri = 0 | 1 | 2

function tokenMatcher(
  ix: SearchIndex,
  token: SearchToken,
  cache: Map<string, Uint8Array>,
  phrases: Map<string, PhraseMatch>,
): (ordinal: number) => Tri {
  const value = token.value.toLowerCase()
  if (SINGLE_WORD_RE.test(value)) {
    const set = unitsWithWordContaining(ix, value, cache)
    return o => (set[o] ? 1 : 0)
  }
  const parts = value.match(WORD_RE) || []
  if (parts.length === 0) return () => 2
  // Every word of the phrase must occur (a superset of the units containing the phrase)
  const sets = parts.map(w => unitsWithWordContaining(ix, w, cache))
  const words = (o: number) => sets.every(s => s[o])
  const pm = phrases.get(value)
  if (!pm) return o => (words(o) ? 2 : 0)
  // ...and every pair looked up; units with unindexed long words keep the word-only check
  return o => {
    if (pm.units[o]) return pm.exact ? 1 : words(o) ? 2 : 0
    return pm.longUnits.has(o) && words(o) ? 2 : 0
  }
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
// (`phrases` from matchPhrases; without it phrases are narrowed by their words only)
export function searchWithIndex(
  ix: SearchIndex,
  tokens: SearchToken[],
  units: Comment[],
  phrases: Map<string, PhraseMatch> = new Map(),
): IndexSearchResult {
  const cache = new Map<string, Uint8Array>()
  const matcher = (t: SearchToken) => tokenMatcher(ix, t, cache, phrases)
  const groups = groupTokens(tokens).map(g => ({
    pos: g.filter(t => !t.negated).map(matcher),
    neg: g.filter(t => t.negated).map(matcher),
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
