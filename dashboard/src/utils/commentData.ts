// On-demand loading of comment content that is not in comments-index.json:
//   data/comment-details/NNNN.json  { [unitId]: { sections }, [memberId]: { addedText } }
//   data/comment-text/NNNN.json     { [unitId]: full transcription }
// Shards are cached in memory (LRU by size; the browser's HTTP cache backs evicted ones).
import { useEffect, useState } from 'react'
import type { Comment, StructuredSections } from '../types'
import { sharedData } from './dataPaths'

type DetailShard = Record<string, { sections?: StructuredSections; addedText?: string }>
type TextShard = Record<string, string>

class ShardCache<T> {
  private entries = new Map<number, { value: T; size: number }>()
  private inflight = new Map<number, Promise<T>>()
  private total = 0
  constructor(private dir: string, private budgetChars: number) {}

  peek(n: number): T | undefined {
    const e = this.entries.get(n)
    if (!e) return undefined
    this.entries.delete(n)
    this.entries.set(n, e) // mark recently used
    return e.value
  }

  get(n: number): Promise<T> {
    const hit = this.peek(n)
    if (hit) return Promise.resolve(hit)
    let p = this.inflight.get(n)
    if (!p) {
      p = fetch(sharedData(`${this.dir}/${String(n).padStart(4, '0')}.json`))
        .then(r => {
          if (!r.ok) throw new Error(`${this.dir}/${n}: HTTP ${r.status}`)
          return r.text()
        })
        .then(text => {
          const value = JSON.parse(text) as T
          this.entries.set(n, { value, size: text.length })
          this.total += text.length
          for (const [k, e] of this.entries) {
            if (this.total <= this.budgetChars || this.entries.size <= 1) break
            this.entries.delete(k)
            this.total -= e.size
          }
          return value
        })
        .finally(() => this.inflight.delete(n))
      this.inflight.set(n, p)
    }
    return p
  }
}

const detailCache = new ShardCache<DetailShard>('comment-details', 64e6)
const textCache = new ShardCache<TextShard>('comment-text', 96e6)

export interface CommentContent {
  // Full condensed sections (the representative's for form-letter members), with
  // oneLineSummary and, when requested, detailedContent filled in
  sections?: StructuredSections
  // A form-letter member's own added text
  addedText?: string
}

// The comment whose content a comment displays: itself, or its representative
function contentSourceId(comment: Comment): string {
  return comment.clusterRepresentativeId && !comment.isClusterRepresentative
    ? comment.clusterRepresentativeId
    : comment.id
}

function needsDetail(comment: Comment): boolean {
  return comment.detailShard !== undefined
}

function needsText(comment: Comment): boolean {
  return comment.textShard !== undefined
}

function assemble(comment: Comment, detail: DetailShard | undefined, text: TextShard | undefined, withText: boolean): CommentContent {
  const sourceId = contentSourceId(comment)
  const sections: StructuredSections = {
    ...(comment.structuredSections || {}),
    ...(detail?.[sourceId]?.sections || {}),
  }
  if (withText && text?.[sourceId]) sections.detailedContent = text[sourceId]
  const out: CommentContent = {}
  if (Object.values(sections).some(Boolean)) out.sections = sections
  const addedText = detail?.[comment.id]?.addedText
  if (addedText) out.addedText = addedText
  return out
}

// Synchronous lookup; undefined if a needed shard isn't cached yet
export function peekCommentContent(comment: Comment, withText: boolean): CommentContent | undefined {
  const detail = needsDetail(comment) ? detailCache.peek(comment.detailShard!) : undefined
  if (needsDetail(comment) && !detail) return undefined
  const text = withText && needsText(comment) ? textCache.peek(comment.textShard!) : undefined
  if (withText && needsText(comment) && !text) return undefined
  return assemble(comment, detail, text, withText)
}

export async function loadCommentContent(comment: Comment, withText: boolean): Promise<CommentContent> {
  const [detail, text] = await Promise.all([
    needsDetail(comment) ? detailCache.get(comment.detailShard!) : undefined,
    withText && needsText(comment) ? textCache.get(comment.textShard!) : undefined,
  ])
  return assemble(comment, detail, text, withText)
}

export interface LoadProgress { done: number; total: number }

// Load content for many comments, a few shards at a time. Calls onBatch with each group of
// comments as their shards arrive (so callers can process and drop them), then resolves.
// With withDetail = false, only text shards are fetched (sections then hold just the
// one-line summary and detailedContent).
export async function forEachCommentContent(
  comments: Comment[],
  withText: boolean,
  onBatch: (items: Array<{ comment: Comment; content: CommentContent }>) => void,
  onProgress?: (p: LoadProgress) => void,
  isCancelled?: () => boolean,
  withDetail = true,
): Promise<void> {
  const useDetail = (c: Comment) => withDetail && needsDetail(c)
  // Group by (detail shard, text shard) so each group needs at most two fetches
  const groups = new Map<string, Comment[]>()
  for (const c of comments) {
    const key = `${useDetail(c) ? c.detailShard : '-'}|${withText && needsText(c) ? c.textShard : '-'}`
    let g = groups.get(key)
    if (!g) groups.set(key, g = [])
    g.push(c)
  }
  const queue = [...groups.values()]
  const total = queue.length
  let done = 0
  onProgress?.({ done, total })
  const worker = async () => {
    while (queue.length && !isCancelled?.()) {
      const group = queue.shift()!
      const first = group[0]
      const [detail, text] = await Promise.all([
        useDetail(first) ? detailCache.get(first.detailShard!) : undefined,
        withText && needsText(first) ? textCache.get(first.textShard!) : undefined,
      ])
      if (isCancelled?.()) return
      onBatch(group.map(comment => ({ comment, content: assemble(comment, detail, text, withText) })))
      done++
      onProgress?.({ done, total })
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker))
}

// React hook: a comment's content, loading shards when `enabled`
export function useCommentContent(comment: Comment | undefined, withText: boolean, enabled = true) {
  const [state, setState] = useState<{ key: string; content?: CommentContent; error?: string }>({ key: '' })
  const key = comment ? `${comment.id}|${withText}` : ''
  const cached = comment && enabled ? peekCommentContent(comment, withText) : undefined

  useEffect(() => {
    if (!comment || !enabled || cached) return
    let cancelled = false
    loadCommentContent(comment, withText)
      .then(content => { if (!cancelled) setState({ key, content }) })
      .catch(err => { if (!cancelled) setState({ key, error: String(err) }) })
    return () => { cancelled = true }
  }, [key, enabled, cached === undefined])

  if (cached) return { content: cached, loading: false, error: undefined }
  if (state.key === key && (state.content || state.error)) return { content: state.content, loading: false, error: state.error }
  return { content: undefined, loading: enabled && !!comment, error: undefined }
}
