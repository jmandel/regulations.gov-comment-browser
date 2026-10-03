import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { CompositionCounts, OverviewData } from '../../types'
import { PARTS, Part, fmt, pct, formatDay, partLabel } from './overviewData'

// The hero: every submission, split into campaign copies, reworded campaign letters, individual
// comments and attached letters. Segments and legend entries link to where each group can be read.
export function CompositionBar({ composition, total, campaignsTagged = true }: { composition: CompositionCounts; total: number; campaignsTagged?: boolean }) {
  const [active, setActive] = useState<Part | null>(null)
  const parts = PARTS.filter(p => composition[p.key] > 0)
  const sum = parts.reduce((s, p) => s + composition[p.key], 0) || 1

  return (
    <figure className="mt-8 sm:mt-10">
      <figcaption className="sr-only">
        How the {fmt(total)} comments break down: {parts.map(p => `${partLabel(p, campaignsTagged)}, ${fmt(composition[p.key])}`).join('; ')}.
      </figcaption>
      <div className="ov-grow flex h-9 sm:h-12 gap-[2px] rounded overflow-hidden" aria-hidden="true">
        {parts.map(p => (
          <Link
            key={p.key}
            to={p.to}
            tabIndex={-1}
            title={`${partLabel(p, campaignsTagged)}: ${fmt(composition[p.key])} (${pct(composition[p.key], total)})`}
            onMouseEnter={() => setActive(p.key)}
            onMouseLeave={() => setActive(null)}
            className="block h-full transition-opacity duration-150 motion-reduce:transition-none"
            style={{
              flexGrow: composition[p.key] / sum,
              flexBasis: 0,
              minWidth: 3,
              background: p.color,
              opacity: active && active !== p.key ? 0.35 : 1,
            }}
          />
        ))}
      </div>

      <ul className="mt-4 grid grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-5">
        {parts.map(p => (
          <li key={p.key}>
            <Link
              to={p.to}
              onMouseEnter={() => setActive(p.key)}
              onMouseLeave={() => setActive(null)}
              onFocus={() => setActive(p.key)}
              onBlur={() => setActive(null)}
              className="group block rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ov-link)] focus-visible:ring-offset-4 focus-visible:ring-offset-gray-50"
            >
              <span className="flex items-start gap-2 text-sm font-medium leading-snug text-[var(--ov-ink)]">
                <span className="mt-[0.3em] h-2.5 w-2.5 rounded-sm flex-shrink-0" style={{ background: p.color }} aria-hidden="true" />
                <span className="group-hover:underline underline-offset-2">{partLabel(p, campaignsTagged)}</span>
              </span>
              <span className="mt-1 flex items-baseline gap-2">
                <span className="tnum text-2xl sm:text-[1.75rem] font-semibold leading-none">{fmt(composition[p.key])}</span>
                <span className="tnum text-sm text-[var(--ov-ink-2)]">{pct(composition[p.key], total)}</span>
              </span>
              <span className="mt-1.5 block text-[0.8125rem] leading-snug text-[var(--ov-ink-3)] max-w-[30ch]">{campaignsTagged ? p.description : p.plainDescription || p.description}</span>
            </Link>
          </li>
        ))}
      </ul>
    </figure>
  )
}

// A thin horizontal bar, optionally split by composition (same colors as the hero)
export function SplitBar({ value, max, split, label }: { value: number; max: number; split?: CompositionCounts; label?: string }) {
  const width = max > 0 ? Math.max((value / max) * 100, 0.75) : 0
  const parts = split ? PARTS.filter(p => split[p.key] > 0) : []
  const sum = parts.reduce((s, p) => s + split![p.key], 0)
  return (
    <div className="h-2 w-full" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <div className="flex h-full gap-[2px] rounded-r-[4px] overflow-hidden" style={{ width: `${width}%` }}>
        {sum > 0
          ? parts.map(p => (
              <span key={p.key} className="block h-full" style={{ flexGrow: split![p.key] / sum, flexBasis: 0, minWidth: 2, background: p.color }} />
            ))
          : <span className="block h-full w-full" style={{ background: 'var(--ov-mark)' }} />}
      </div>
    </div>
  )
}

// Submissions per day across the comment period
export function ArrivalsChart({ arrivals, closeDate }: { arrivals: OverviewData['arrivals']; closeDate?: string }) {
  const [hover, setHover] = useState<number | null>(null)
  const max = Math.max(...arrivals.map(a => a.count), 1)
  let peak = 0
  arrivals.forEach((a, i) => { if (a.count > arrivals[peak].count) peak = i })
  const short = { month: 'short', day: 'numeric' } as const
  const closeDay = closeDate ? new Date(closeDate).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) : null
  const lastIsClose = closeDay && arrivals[peak].date === closeDay
  const shown = hover ?? peak
  const caption = hover === null
    ? `Busiest day: ${formatDay(arrivals[peak].date, short)}, ${fmt(arrivals[peak].count)} comments${lastIsClose ? ', the last day to comment' : ''}.`
    : `${formatDay(arrivals[hover].date, { weekday: 'short', month: 'short', day: 'numeric' })}: ${fmt(arrivals[hover].count)} comment${arrivals[hover].count === 1 ? '' : 's'}`

  return (
    <figure>
      <p className="text-sm text-[var(--ov-ink-2)] min-h-[1.25rem]" aria-live="polite">{caption}</p>
      <div
        className="mt-3 flex items-end h-24 gap-px border-b border-[var(--ov-rule)]"
        role="img"
        aria-label={`Comments received per day, ${formatDay(arrivals[0].date, short)} to ${formatDay(arrivals[arrivals.length - 1].date, short)}. Busiest day ${formatDay(arrivals[peak].date, short)} with ${fmt(arrivals[peak].count)}.`}
        onMouseLeave={() => setHover(null)}
      >
        {arrivals.map((a, i) => (
          <div key={a.date} className="flex-1 h-full flex items-end" onMouseEnter={() => setHover(i)}>
            <div
              className="w-full rounded-t-[2px]"
              style={{
                height: a.count ? `${Math.max((a.count / max) * 100, 2)}%` : 0,
                background: i === shown ? 'var(--ov-ink)' : 'var(--ov-mark)',
              }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-xs text-[var(--ov-ink-3)] tnum" aria-hidden="true">
        <span>{formatDay(arrivals[0].date, short)}</span>
        <span>{formatDay(arrivals[arrivals.length - 1].date, short)}</span>
      </div>
    </figure>
  )
}
