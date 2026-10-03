import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { ExternalLink } from 'lucide-react'
import useStore from '../store/useStore'
import { CompositionBar, SplitBar, ArrivalsChart } from './overview/OverviewCharts'
import { DataDownloads } from './overview/DataDownloads'
import { WhoCommented, WhereCommenters } from './overview/WhoCommented'
import { ScopedAnalysesList, AboutScope } from './scope/ScopeSections'
import { deriveOverview, fmt, formatDay, PARTS, partLabel } from './overview/overviewData'

const CAMPAIGN_ROWS = 5

const linkClass = 'text-[var(--ov-link)] underline decoration-1 underline-offset-2 decoration-[var(--ov-link)]/40 hover:decoration-[var(--ov-link)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ov-link)] rounded-sm'
const rowLinkClass = 'group block focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ov-link)] focus-visible:ring-offset-2 focus-visible:ring-offset-gray-50 rounded-sm'

function OverviewPanel() {
  const { meta, themes, themeSummaries, comments, campaigns, overview: pre, scope } = useStore()

  const ov = useMemo(() => deriveOverview(pre, comments, themeSummaries), [pre, comments, themeSummaries])
  const c = ov.composition
  const total = c.campaignCopies + c.campaignReworded + c.typed + c.attached || meta?.stats.totalComments || 0
  const campaignsTagged = campaigns.length > 0
  // Headline: just the count. The composition bar below gives the breakdown with real numbers
  const headline = scope
    ? `${fmt(total)} of ${fmt(scope.counts.docketSubmissions)} comments addressed this scope`
    : `${fmt(total)} comment${total === 1 ? '' : 's'}`

  // Top-level themes (issue areas), most-discussed first
  const issueAreas = useMemo(() =>
    themes.filter(t => !t.parent_code && t.comment_count > 0).sort((a, b) => b.comment_count - a.comment_count),
  [themes])
  const issueMax = issueAreas[0]?.comment_count || 0
  const hasThemeSplit = issueAreas.some(t => ov.themeComposition[t.code])

  const docketId = meta?.documentId
  const start = formatDay(meta?.commentStartDate, { month: 'long', day: 'numeric' })
  const end = formatDay(meta?.commentEndDate)
  const ruleKind = meta?.documentType ? meta.documentType.toLowerCase() : 'document'

  return (
    <div className="overview px-2 sm:px-0 pb-4">
      {/* The rule */}
      <header className="max-w-4xl">
        <p className="text-sm text-[var(--ov-ink-2)] leading-relaxed">
          Public comments on {meta?.agencyId ? `${meta.agencyId} ` : ''}{ruleKind} <span className="font-medium text-[var(--ov-ink)] whitespace-nowrap">{docketId}</span>
          {start && end ? `, open for comment ${start} to ${end}` : ''}.{' '}
          {docketId && (
            <a href={`https://www.regulations.gov/docket/${encodeURIComponent(docketId)}`} target="_blank" rel="noopener noreferrer" className={`${linkClass} inline-flex items-center gap-1 whitespace-nowrap`}>
              Docket on regulations.gov<ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </a>
          )}
        </p>
        {meta?.title && meta.title !== docketId && (
          <p className="mt-2 text-[0.9375rem] sm:text-base leading-snug text-[var(--ov-ink-2)] max-w-[72ch]">{meta.title}</p>
        )}
        <h1 className="mt-6 sm:mt-8 text-[1.75rem] sm:text-[2.625rem] leading-[1.12] font-semibold tracking-[-0.015em] max-w-[30ch]">
          {headline}
        </h1>
      </header>

      {total > 0 && <CompositionBar composition={c} total={total} campaignsTagged={campaignsTagged} />}

      {!scope && meta?.scopes && meta.scopes.length > 0 && <ScopedAnalysesList scopes={meta.scopes} />}

      {ov.submitters.length > 0 && <div className="mt-12 sm:mt-16"><WhoCommented ov={ov} /></div>}

      <div className="mt-12 sm:mt-16 grid grid-cols-1 lg:grid-cols-12 gap-x-16 gap-y-14">
        {/* What commenters raised */}
        <section className="lg:col-span-7" aria-labelledby="ov-issues">
          <div className="flex items-baseline justify-between gap-4">
            <h2 id="ov-issues" className="text-xl sm:text-2xl font-semibold">{scope ? 'What commenters raised on this scope' : 'What commenters raised'}</h2>
            <Link to="/themes" className={`${linkClass} text-sm whitespace-nowrap`}>All themes</Link>
          </div>
          <p className="mt-2 text-sm text-[var(--ov-ink-2)] max-w-[62ch]">
            Issue areas by the number of comments that discuss them; most comments raise more than one.
            {hasThemeSplit && ' Bar colors follow the breakdown above.'}
          </p>
          {issueAreas.length === 0 ? (
            <p className="mt-6 text-sm text-[var(--ov-ink-2)]">Themes haven't been identified for this docket yet. <Link to="/comments" className={linkClass}>Browse the comments</Link> instead.</p>
          ) : (
            <ol className="mt-5 border-t border-[var(--ov-rule)]">
              {issueAreas.map(t => {
                const gist = ov.themeGists[t.code]
                const split = ov.themeComposition[t.code]
                const name = t.label || t.description
                return (
                  <li key={t.code} className="border-b border-[var(--ov-rule)]">
                    <Link to={`/themes/${t.code}`} className={`${rowLinkClass} py-4`}>
                      <span className="flex items-baseline justify-between gap-4">
                        <span className="font-semibold leading-snug group-hover:underline underline-offset-2">{name}</span>
                        <span className="tnum font-semibold flex-shrink-0">{fmt(t.comment_count)}</span>
                      </span>
                      <span className="mt-2 block">
                        <SplitBar
                          value={t.comment_count}
                          max={issueMax}
                          split={split}
                          label={split ? PARTS.filter(p => split[p.key]).map(p => `${partLabel(p, campaignsTagged)} ${fmt(split[p.key])}`).join(', ') : undefined}
                        />
                      </span>
                      {gist && <span className="mt-2 block text-sm leading-relaxed text-[var(--ov-ink-2)] max-w-[72ch]">{gist}</span>}
                    </Link>
                  </li>
                )
              })}
            </ol>
          )}
        </section>

        <aside className="lg:col-span-5 space-y-14">
          {scope && <AboutScope scope={scope} />}

          {ov.arrivals.length > 1 && (
            <section aria-labelledby="ov-arrivals">
              <h2 id="ov-arrivals" className="text-lg font-semibold">When comments arrived</h2>
              <div className="mt-2">
                <ArrivalsChart arrivals={ov.arrivals} closeDate={meta?.commentEndDate} />
              </div>
            </section>
          )}

          {ov.geography && <WhereCommenters geo={ov.geography} />}

          {campaigns.length > 0 && (
            <section aria-labelledby="ov-campaigns">
              <div className="flex items-baseline justify-between gap-4">
                <h2 id="ov-campaigns" className="text-lg font-semibold">Largest campaigns</h2>
                <Link to="/campaigns" className={`${linkClass} text-sm whitespace-nowrap`}>
                  {campaigns.length > CAMPAIGN_ROWS ? `All ${fmt(campaigns.length)}` : 'Campaigns'}
                </Link>
              </div>
              <ul className="mt-4 space-y-3">
                {campaigns.slice(0, CAMPAIGN_ROWS).map(k => (
                  <li key={k.id}>
                    <Link to={`/campaigns/${k.id}`} className={rowLinkClass}>
                      <span className="flex items-baseline justify-between gap-4 text-sm">
                        <span className="min-w-0 group-hover:underline underline-offset-2">{k.name}</span>
                        <span className="tnum font-medium flex-shrink-0">{fmt(k.total)}</span>
                      </span>
                      <span className="mt-1 block">
                        <SplitBar
                          value={k.total}
                          max={campaigns[0].total}
                          split={{ campaignCopies: k.exact, campaignReworded: k.paraphrased, typed: 0, attached: 0 }}
                          label={`${fmt(k.exact)} copies, ${fmt(k.paraphrased)} reworded`}
                        />
                      </span>
                      <span className="mt-1 block text-xs text-[var(--ov-ink-3)] tnum">
                        {k.paraphrased === 0 ? 'All identical copies' : k.exact === 0 ? 'All reworded' : `${fmt(k.exact)} copies, ${fmt(k.paraphrased)} reworded`}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {meta?.downloads && meta.downloads.length > 0 && <DataDownloads downloads={meta.downloads} />}
        </aside>
      </div>
    </div>
  )
}

export default OverviewPanel
