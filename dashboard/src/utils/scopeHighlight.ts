// Highlighting a scope's relevance excerpt inside a comment's full text. The excerpt is "verbatim
// where possible", so it is cut into passages (paragraphs, then sentences) and each passage of 25+
// characters found word-for-word in a text node of the rendered markdown is wrapped in <mark>.
// Passages that were paraphrased, or span formatting, simply aren't marked.

const MIN_PASSAGE = 25

const norm = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim()

export function excerptPassages(excerpt: string | undefined): string[] {
  if (!excerpt) return []
  const out: string[] = []
  for (const para of excerpt.split(/\n+|\s*(?:\.{3}|…)\s*/)) {
    const sentences = norm(para).match(/[^.!?]+(?:[.!?]+["')\]]*|$)/g) || []
    for (const s of sentences) {
      const t = s.trim().replace(/^[-*>#\s]+/, '')
      if (t.length >= MIN_PASSAGE) out.push(t)
    }
  }
  return [...new Set(out)].sort((a, b) => b.length - a.length)
}

// Does the text contain any passage? (to say whether highlights will appear)
export function countPassagesIn(text: string | undefined, passages: string[]): number {
  if (!text || !passages.length) return 0
  const t = norm(text)
  return passages.filter(p => t.includes(p)).length
}

type Node = { type: string; value?: string; children?: Node[]; data?: Record<string, unknown> }

// remark plugin: wrap passages found in text nodes in mark elements
export function remarkHighlightPassages(passages: string[]) {
  return () => (tree: Node) => {
    if (!passages.length) return
    const visit = (node: Node) => {
      if (!node.children) return
      const next: Node[] = []
      for (const child of node.children) {
        if (child.type === 'text' && child.value) next.push(...splitText(child.value, passages))
        else { if (child.type !== 'code' && child.type !== 'inlineCode') visit(child); next.push(child) }
      }
      node.children = next
    }
    visit(tree)
  }
}

// Find passages in a text node's value, matching across whitespace differences
function splitText(value: string, passages: string[]): Node[] {
  // Map normalized offsets back to the raw string
  const map: number[] = []
  let normed = ''
  let prevSpace = false
  for (let i = 0; i < value.length; i++) {
    let ch = value[i]
    if (/\s/.test(ch)) { if (prevSpace || normed.length === 0) continue; ch = ' '; prevSpace = true } else prevSpace = false
    if (ch === '‘' || ch === '’') ch = "'"
    if (ch === '“' || ch === '”') ch = '"'
    normed += ch
    map.push(i)
  }
  const ranges: Array<[number, number]> = []
  for (const p of passages) {
    let from = 0
    for (;;) {
      const at = normed.indexOf(p, from)
      if (at < 0) break
      const end = at + p.length
      if (!ranges.some(([a, b]) => at < b && end > a)) ranges.push([at, end])
      from = end
    }
  }
  if (!ranges.length) return [{ type: 'text', value }]
  ranges.sort((a, b) => a[0] - b[0])
  // Join passages separated only by a few characters (sentence splits at "i.e." and the like)
  for (let i = ranges.length - 1; i > 0; i--) {
    if (ranges[i][0] - ranges[i - 1][1] <= 4) { ranges[i - 1][1] = Math.max(ranges[i - 1][1], ranges[i][1]); ranges.splice(i, 1) }
  }
  const out: Node[] = []
  let pos = 0
  for (const [a, b] of ranges) {
    const start = map[a]
    const end = map[b - 1] + 1
    if (start > pos) out.push({ type: 'text', value: value.slice(pos, start) })
    out.push({ type: 'scopeMark', data: { hName: 'mark', hProperties: { className: 'scope-mark' } }, children: [{ type: 'text', value: value.slice(start, end) }] })
    pos = end
  }
  if (pos < value.length) out.push({ type: 'text', value: value.slice(pos) })
  return out
}
