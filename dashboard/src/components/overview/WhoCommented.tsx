import { Link } from 'react-router-dom'
import type { OverviewData } from '../../types'
import { SplitBar } from './OverviewCharts'
import { fmt, pct, FILED_AS_LABELS } from './overviewData'

const linkClass = 'text-[var(--ov-link)] underline decoration-1 underline-offset-2 decoration-[var(--ov-link)]/40 hover:decoration-[var(--ov-link)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ov-link)] rounded-sm'
const rowLinkClass = 'group block focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ov-link)] focus-visible:ring-offset-2 focus-visible:ring-offset-gray-50 rounded-sm'

const TYPE_ROWS = 8
const STATE_ROWS = 8

type Row = OverviewData['submitters'][number]

function BarRow({ label, count, max, to, note }: { label: string; count: number; max: number; to?: string; note?: string }) {
  const body = (
    <>
      <span className="flex items-baseline justify-between gap-4 text-sm">
        <span className={to ? 'group-hover:underline underline-offset-2' : 'text-[var(--ov-ink-2)]'}>{label}</span>
        <span className="tnum font-medium">{fmt(count)}</span>
      </span>
      <span className="mt-1 block"><SplitBar value={count} max={max} /></span>
      {note && <span className="mt-1 block text-xs text-[var(--ov-ink-3)] truncate">{note}</span>}
    </>
  )
  return <li>{to ? <Link to={to} className={rowLinkClass}>{body}</Link> : <div>{body}</div>}</li>
}

const typeLink = (label: string) => `/comments?submitterType=${encodeURIComponent(label)}`

// Who commented: AI-assigned commenter types grouped into individuals and organizations, or (older
// builds and dockets without classify-submitters) how people filed and the category they chose.
export function WhoCommented({ ov }: { ov: OverviewData }) {
  const ai = ov.typeSource === 'ai'
  const max = Math.max(...ov.submitters.map(r => r.count), 1)
  const orgNote = (r: Row) => r.organizations?.length
    ? `${r.organizations.map(o => o.name).join(', ')}${(r.organizationCount || 0) > r.organizations.length ? ` and ${fmt(r.organizationCount! - r.organizations.length)} more` : ''}`
    : undefined

  const groups = ai
    ? (['individual', 'organization'] as const).map(g => {
        const rows = ov.submitters.filter(r => r.group === g)
        return { g, rows, total: rows.reduce((s, r) => s + r.count, 0) }
      }).filter(x => x.rows.length)
    : []
  const unclassified = ai ? ov.submitters.filter(r => !r.group) : []

  const rows = ov.submitters.slice(0, TYPE_ROWS)
  const rest = ov.submitters.slice(TYPE_ROWS)
  const restCount = rest.reduce((s, r) => s + r.count, 0)
  const filedMax = Math.max(rows[0]?.count || 1, restCount)
  const filed = ov.filedAs
  const filedTotal = filed ? filed.organization + filed.person + filed.anonymous : 0

  return (
    <section aria-labelledby="ov-who">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="ov-who" className="text-lg font-semibold">Who commented</h2>
        <Link to="/comments" className={`${linkClass} text-sm whitespace-nowrap`}>Browse comments</Link>
      </div>
      {ai ? (
        <>
          <p className="mt-1 text-sm text-[var(--ov-ink-2)]">Commenter types assigned by AI from each comment's form fields and text, including letterheads and signatures.</p>
          {groups.map(({ g, rows, total }) => (
            <div key={g} className="mt-5">
              <h3 className="flex items-baseline justify-between gap-4 text-sm font-semibold">
                <span>{g === 'individual' ? 'Individuals' : 'Organizations'}</span>
                <span className="tnum">{fmt(total)}</span>
              </h3>
              <ul className="mt-3 space-y-3">
                {rows.map(r => <BarRow key={r.label} label={r.label} count={r.count} max={max} to={typeLink(r.label)} note={orgNote(r)} />)}
              </ul>
            </div>
          ))}
          {unclassified.length > 0 && (
            <p className="mt-4 text-xs text-[var(--ov-ink-3)]">
              Not classified: {unclassified.map(r => <Link key={r.label} to={typeLink(r.label)} className={linkClass}>{fmt(r.count)}</Link>)}
            </p>
          )}
        </>
      ) : (
        <>
          <p className="mt-1 text-sm text-[var(--ov-ink-2)]">How each commenter filed on regulations.gov, and the category they chose. Many choose none.</p>
          {filed && filedTotal > 0 && (
            <ul className="mt-4 grid grid-cols-3 gap-3">
              {(['organization', 'person', 'anonymous'] as const).map(k => (
                <li key={k}>
                  <Link to={`/comments?filedAs=${k}`} className={rowLinkClass}>
                    <span className="block text-xs text-[var(--ov-ink-2)] group-hover:underline underline-offset-2">{FILED_AS_LABELS[k]}</span>
                    <span className="tnum text-base font-semibold">{fmt(filed[k])}</span>
                    <span className="tnum ml-1.5 text-xs text-[var(--ov-ink-3)]">{pct(filed[k], filedTotal)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <ul className="mt-5 space-y-3">
            {rows.map(r => <BarRow key={r.label} label={r.label} count={r.count} max={filedMax} to={typeLink(r.label)} />)}
            {rest.length > 0 && <BarRow label={`All other categories (${rest.length})`} count={restCount} max={filedMax} />}
          </ul>
        </>
      )}
    </section>
  )
}

// Where commenters are, by the state they gave; shown only when enough of them gave one
export function WhereCommenters({ geo }: { geo: NonNullable<OverviewData['geography']> }) {
  if (!geo.total || geo.withState < 30 || geo.withState / geo.total < 0.2) return null
  const rows = geo.states.slice(0, STATE_ROWS)
  const rest = geo.states.slice(STATE_ROWS)
  const restCount = rest.reduce((s, r) => s + r.count, 0)
  const max = Math.max(rows[0]?.count || 1, restCount)
  const abroad = geo.countries.filter(c => c.country !== 'United States').reduce((s, c) => s + c.count, 0)
  return (
    <section aria-labelledby="ov-where">
      <h2 id="ov-where" className="text-lg font-semibold">Where commenters are</h2>
      <p className="mt-1 text-sm text-[var(--ov-ink-2)]">
        {pct(geo.withState, geo.total)} of comments give a state{abroad > 0 ? `; ${fmt(abroad)} give a country other than the United States` : ''}.
      </p>
      <ul className="mt-4 space-y-3">
        {rows.map(r => <BarRow key={r.state} label={r.state} count={r.count} max={max} to={`/comments?state=${encodeURIComponent(r.state)}`} />)}
        {rest.length > 0 && <BarRow label={`All other states (${rest.length})`} count={restCount} max={max} />}
      </ul>
    </section>
  )
}
