import { useState } from 'react'
import { useLocation } from 'react-router-dom'
import { ArrowLeft, ChevronDown, Crosshair } from 'lucide-react'
import useStore from '../../store/useStore'
import ScopePrompt from './ScopePrompt'

const fmt = (n: number) => n.toLocaleString('en-US')
const linkClass = 'text-[var(--ov-link)] underline decoration-1 underline-offset-2 decoration-[var(--ov-link)]/40 hover:decoration-[var(--ov-link)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ov-link)] rounded-sm'

// The same page in the docket's own analysis where one exists (comments, campaigns and topics are
// shared; theme codes differ between the two taxonomies)
export function docketHref(docketUrl: string, pathname: string): string {
  const same = /^\/(comments\/[^/]+|campaigns(\/[^/]+)?|entities(\/[^/]+\/[^/]+)?|comments)$/.test(pathname)
  return `${docketUrl}#${same ? pathname : '/overview'}`
}

// Shown on every page of a scope sub-site: what the scope is, how much of the docket it covers,
// the full prompt on request, and the way back to the docket's analysis
function ScopeBanner() {
  const { scope, meta } = useStore()
  const { pathname } = useLocation()
  const [open, setOpen] = useState(false)
  if (!scope || !meta) return null
  const c = scope.counts
  const share = c.docketSubmissions ? c.inScopeSubmissions / c.docketSubmissions : 0
  const pctText = share > 0 && share < 0.01 ? 'under 1%' : `${Math.round(share * 100)}%`
  const docketUrl = meta.docketUrl || '../../'

  return (
    <div className="scope-ui bg-[#eef2f7] border-b border-[#d5dce7]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3">
        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-x-8 gap-y-2">
          <div className="min-w-0 flex gap-3">
            <Crosshair className="h-4 w-4 mt-[3px] flex-shrink-0 text-[var(--ov-ink-2)]" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-[0.9375rem] leading-snug">
                <span className="text-[var(--ov-ink-2)]">Scoped analysis: </span>
                <span className="font-semibold">{scope.name}</span>
              </p>
              {/* On phones the summary shows on the Overview only, to keep the banner short */}
              {scope.summary && <p className={`${pathname === '/overview' ? '' : 'hidden sm:block '}mt-0.5 text-sm leading-relaxed text-[var(--ov-ink-2)] max-w-[80ch]`}>{scope.summary}</p>}
              <p className="mt-0.5 text-sm text-[var(--ov-ink-2)]">
                <span className="tnum font-medium text-[var(--ov-ink)]">{fmt(c.inScopeSubmissions)} of {fmt(c.docketSubmissions)}</span> submissions ({pctText}) addressed this scope.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 pl-7 lg:pl-0 text-sm flex-shrink-0 lg:pt-0.5">
            <button
              type="button"
              onClick={() => setOpen(o => !o)}
              aria-expanded={open}
              aria-controls="scope-prompt-panel"
              className={`${linkClass} inline-flex items-center gap-1`}
            >
              {open ? 'Hide the scope prompt' : 'Read the scope prompt'}
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
            </button>
            <a href={docketHref(docketUrl, pathname)} className={`${linkClass} inline-flex items-center gap-1`}>
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
              Full docket analysis
            </a>
          </div>
        </div>
        {open && (
          <div id="scope-prompt-panel" className="mt-3 lg:ml-7">
            <ScopePrompt markdown={scope.promptMarkdown} />
          </div>
        )}
      </div>
    </div>
  )
}

export default ScopeBanner
