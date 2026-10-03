import type { Comment, CompositionCounts, OverviewData, ThemeSummary } from '../../types'
import { commentPart } from '../../utils/helpers'

export type Part = keyof CompositionCounts

// Order in the bar: organized (warm) first, then independent (cool)
// plainLabel/plainDescription: used when no campaigns were tagged (older builds, or tag-campaigns
// not run), where "individual" and "not part of a campaign" can't be claimed
export const PARTS: Array<{ key: Part; label: string; description: string; plainLabel?: string; plainDescription?: string; color: string; to: string }> = [
  { key: 'campaignCopies', label: 'Campaign copies', description: 'Identical letters sent as part of an organized campaign', color: 'var(--ov-copies)', to: '/comments?part=campaignCopies' },
  { key: 'campaignReworded', label: 'Reworded campaign letters', description: 'Campaign letters the sender rewrote in their own words', color: 'var(--ov-reworded)', to: '/comments?part=campaignReworded' },
  { key: 'typed', label: 'Written in the comment form', description: 'Entered directly in the regulations.gov comment box, not part of a campaign', plainDescription: 'Entered directly in the regulations.gov comment box', color: 'var(--ov-typed)', to: '/comments?part=typed' },
  { key: 'attached', label: 'Attached document', description: 'Sent as an attached PDF or Word file, not part of a campaign', plainDescription: 'Sent as an attached PDF or Word file', color: 'var(--ov-attached)', to: '/comments?part=attached' },
]

export const fmt = (n: number) => n.toLocaleString('en-US')

export const FILED_AS_LABELS: Record<string, string> = { organization: 'Organization', person: 'Named person', anonymous: 'Anonymous' }

export const pct = (n: number, total: number) => {
  if (!total) return '0%'
  const p = (n / total) * 100
  return p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`
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
    composition[commentPart(c)]++
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
    submitters: [...byType.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count),
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

export const partLabel = (p: (typeof PARTS)[number], campaignsTagged: boolean) => campaignsTagged ? p.label : p.plainLabel || p.label
