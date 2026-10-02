import type { Comment, CompositionCounts, OverviewData, ThemeSummary } from '../../types'

export type Part = keyof CompositionCounts

// Order in the bar: organized (warm) first, then independent (cool)
export const PARTS: Array<{ key: Part; label: string; description: string; color: string; to: string }> = [
  { key: 'campaignCopies', label: 'Campaign copies', description: 'Identical letters sent as part of an organized campaign', color: 'var(--ov-copies)', to: '/campaigns' },
  { key: 'campaignReworded', label: 'Reworded campaign letters', description: 'Campaign letters the sender rewrote in their own words', color: 'var(--ov-reworded)', to: '/campaigns' },
  { key: 'typed', label: 'Individual comments', description: 'Typed into the comment form, not part of a campaign', color: 'var(--ov-typed)', to: '/comments' },
  { key: 'attached', label: 'Attached letters', description: 'Uploaded as a document, not part of a campaign', color: 'var(--ov-attached)', to: '/comments' },
]

export const fmt = (n: number) => n.toLocaleString('en-US')

export const pct = (n: number, total: number) => {
  if (!total) return '0%'
  const p = (n / total) * 100
  return p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`
}

// "About a third", "More than half", "Nearly two-thirds" — a share in words
export function shareInWords(share: number): string {
  if (share >= 0.97) return 'Nearly all'
  if (share < 0.07) return `Only ${Math.max(1, Math.round(share * 100))}%`
  const anchors: Array<[number, string]> = [
    [1 / 10, 'a tenth'], [1 / 8, 'an eighth'], [1 / 5, 'a fifth'], [1 / 4, 'a quarter'], [1 / 3, 'a third'],
    [2 / 5, 'two in five'], [1 / 2, 'half'], [3 / 5, 'three in five'], [2 / 3, 'two-thirds'],
    [3 / 4, 'three-quarters'], [4 / 5, 'four in five'], [9 / 10, 'nine in ten'],
  ]
  let best = anchors[0]
  for (const a of anchors) if (Math.abs(share - a[0]) < Math.abs(share - best[0])) best = a
  const diff = share - best[0]
  const lead = Math.abs(diff) < 0.012 ? 'About' : diff > 0 ? 'More than' : 'Nearly'
  return `${lead} ${best[1]}`
}

// First sentence of a report, for builds without overview.json
function firstSentence(text?: string): string | undefined {
  const m = text?.replace(/\s+/g, ' ').trim().match(/^.+?[.!?](?=\s+[A-Z]|$)/)
  return m?.[0]
}

// The Overview's figures: from overview.json when present, otherwise derived from the startup index
export function deriveOverview(
  pre: OverviewData | null,
  comments: Comment[],
  themeSummaries: Record<string, ThemeSummary>,
): OverviewData {
  if (pre) return pre
  const composition: CompositionCounts = { campaignCopies: 0, campaignReworded: 0, typed: 0, attached: 0 }
  const byType = new Map<string, number>()
  const byDay = new Map<string, number>()
  for (const c of comments) {
    const part: Part = c.campaignId !== undefined ? (c.campaignParaphrase ? 'campaignReworded' : 'campaignCopies') : c.hasAttachments ? 'attached' : 'typed'
    composition[part]++
    byType.set(c.submitterType, (byType.get(c.submitterType) || 0) + 1)
    const day = c.date?.slice(0, 10)
    if (day) byDay.set(day, (byDay.get(day) || 0) + 1)
  }
  const days = [...byDay.keys()].sort()
  const arrivals: OverviewData['arrivals'] = []
  if (days.length) {
    for (let d = new Date(days[0] + 'T00:00:00Z'); d <= new Date(days[days.length - 1] + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
      const key = d.toISOString().slice(0, 10)
      arrivals.push({ date: key, count: byDay.get(key) || 0 })
    }
  }
  const themeGists: Record<string, string> = {}
  for (const [code, s] of Object.entries(themeSummaries)) {
    const g = firstSentence(s.sections?.executiveSummary)
    if (g) themeGists[code] = g
  }
  return {
    version: 0,
    composition,
    submitters: [...byType.entries()].map(([label, count]) => ({ label, count, types: [label] })).sort((a, b) => b.count - a.count),
    arrivals,
    themeGists,
    themeComposition: {},
  }
}

// Dates on regulations.gov are midnight US Eastern stamps; show them as Eastern calendar dates
export function formatDay(iso: string | undefined, opts: Intl.DateTimeFormatOptions = { month: 'long', day: 'numeric', year: 'numeric' }) {
  if (!iso) return ''
  const d = iso.length === 10 ? new Date(iso + 'T12:00:00Z') : new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-US', { ...opts, timeZone: iso.length === 10 ? 'UTC' : 'America/New_York' })
}
