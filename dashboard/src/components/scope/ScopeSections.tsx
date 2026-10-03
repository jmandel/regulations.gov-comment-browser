import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import type { ScopeInfo, ScopeListing } from '../../types'
import ScopePrompt from './ScopePrompt'

const fmt = (n: number) => n.toLocaleString('en-US')
const linkClass = 'text-[var(--ov-link)] underline decoration-1 underline-offset-2 decoration-[var(--ov-link)]/40 hover:decoration-[var(--ov-link)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ov-link)] rounded-sm'

function share(n: number, total: number) {
  if (!total) return ''
  const p = (n / total) * 100
  return p > 0 && p < 1 ? 'under 1%' : `${Math.round(p)}%`
}

// Docket Overview: the scoped analyses published for this docket, each its own sub-site
export function ScopedAnalysesList({ scopes }: { scopes: ScopeListing[] }) {
  return (
    <section className="mt-12 sm:mt-14" aria-labelledby="ov-scopes">
      <h2 id="ov-scopes" className="text-xl sm:text-2xl font-semibold">Scoped analyses</h2>
      <p className="mt-2 text-sm text-[var(--ov-ink-2)] max-w-[72ch]">
        Separate analyses of only the comments that address one question, each with its own themes and reports.
      </p>
      <ul className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-x-12 border-t border-[var(--ov-rule)] md:border-t-0">
        {scopes.map(s => (
          <li key={s.slug} className="border-b border-[var(--ov-rule)] md:border-t">
            <a href={s.path} className="group block py-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ov-link)] rounded-sm">
              <span className="flex items-baseline justify-between gap-4">
                <span className="font-semibold leading-snug text-[var(--ov-link)] group-hover:underline underline-offset-2">{s.name}</span>
                <ChevronRight className="h-4 w-4 flex-shrink-0 self-center text-[var(--ov-ink-3)]" aria-hidden="true" />
              </span>
              {s.summary && <span className="mt-1 block text-sm leading-relaxed text-[var(--ov-ink-2)]">{s.summary}</span>}
              <span className="mt-1.5 block text-xs text-[var(--ov-ink-3)] tnum">
                {fmt(s.inScopeSubmissions)} of {fmt(s.docketSubmissions)} submissions ({share(s.inScopeSubmissions, s.docketSubmissions)})
                {s.themes ? `, ${fmt(s.themes)} themes` : ''}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  )
}

// Scope Overview: what the scope covers, its denominators and the prompt (collapsed)
export function AboutScope({ scope }: { scope: ScopeInfo }) {
  const [open, setOpen] = useState(false)
  const c = scope.counts
  const lines = scope.promptMarkdown.split('\n').length
  return (
    <section aria-labelledby="ov-scope">
      <h2 id="ov-scope" className="text-lg font-semibold">About this scope</h2>
      <dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-6 gap-y-1.5 text-sm">
        <dt className="text-[var(--ov-ink-2)]">Submissions that address it</dt>
        <dd className="tnum font-medium text-right">{fmt(c.inScopeSubmissions)} of {fmt(c.docketSubmissions)}</dd>
        <dt className="text-[var(--ov-ink-2)]">Distinct comments and form-letter groups</dt>
        <dd className="tnum font-medium text-right">{fmt(c.inScopeUnits)} of {fmt(c.docketUnits)}</dd>
        {c.inScopeFormLetterGroups ? (<>
          <dt className="text-[var(--ov-ink-2)]">Form-letter groups among them</dt>
          <dd className="tnum font-medium text-right">{fmt(c.inScopeFormLetterGroups)}</dd>
        </>) : null}
        {c.inScopeOrganizations ? (<>
          <dt className="text-[var(--ov-ink-2)]">Organizations</dt>
          <dd className="tnum font-medium text-right">{fmt(c.inScopeOrganizations)}</dd>
        </>) : null}
      </dl>
      <p className="mt-3 text-sm leading-relaxed text-[var(--ov-ink-2)]">
        An AI model read every comment in the docket against the prompt below and kept those that address it; themes and reports here cover only those comments.
        {scope.seedCommentId && <> The prompt was drafted from <Link to={`/comments/${scope.seedCommentId}`} className={linkClass}>comment {scope.seedCommentId}</Link>.</>}
      </p>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className={`${linkClass} mt-3 text-sm inline-flex items-center gap-1`}
      >
        {open ? 'Hide the scope prompt' : `Read the scope prompt (${lines} line${lines === 1 ? '' : 's'})`}
      </button>
      {open && <div className="mt-3"><ScopePrompt markdown={scope.promptMarkdown} /></div>}
    </section>
  )
}
