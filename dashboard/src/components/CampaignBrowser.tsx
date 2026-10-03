import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Megaphone, Search } from 'lucide-react'
import useStore from '../store/useStore'

type SortKey = 'total' | 'paraphrased' | 'name'

// List of organized campaigns (tag-campaigns): exact copies + reworded letters per campaign
function CampaignBrowser() {
  const { campaigns, meta, scope } = useStore()
  const [query, setQuery] = useState('')
  const [sortBy, setSortBy] = useState<SortKey>('total')
  const [kind, setKind] = useState<'all' | 'paraphrase' | 'form-letter'>('all')

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = campaigns.filter(c =>
      (kind === 'all' || c.method === kind) &&
      (!q || c.name.toLowerCase().includes(q) || (c.description || '').toLowerCase().includes(q)))
    return [...list].sort((a, b) =>
      sortBy === 'name' ? a.name.localeCompare(b.name) : sortBy === 'paraphrased' ? b.paraphrased - a.paraphrased || b.total - a.total : b.total - a.total)
  }, [campaigns, query, sortBy, kind])

  const totalComments = meta?.stats.totalComments || 0
  const inCampaigns = campaigns.reduce((s, c) => s + c.total, 0)
  const reworded = campaigns.reduce((s, c) => s + c.paraphrased, 0)
  const max = Math.max(1, ...campaigns.map(c => c.total))

  if (campaigns.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8 text-center text-gray-500">
        {scope ? 'None of the comments in this scope belong to an organized campaign.' : 'No organized campaigns have been identified for this docket.'}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 sm:p-6">
        <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
          <Megaphone className="h-5 w-5 text-amber-600" /> Organized campaigns
        </h2>
        <p className="text-sm text-gray-600 mt-1">
          {campaigns.length.toLocaleString()} campaigns account for {inCampaigns.toLocaleString()} comments
          {totalComments ? ` (${Math.round((inCampaigns / totalComments) * 100)}% of ${totalComments.toLocaleString()})` : ''}.
          {' '}{reworded.toLocaleString()} of them are reworded letters that follow a campaign's template or talking points
          rather than copying it; the rest are exact or near-exact copies. Each comment counts in at most one campaign.
        </p>
        <p className="text-xs text-gray-400 mt-1">
          Found automatically: similar letters grouped by embeddings, then checked by an LLM for a shared template or brief.
          Expect some groups of independent letters on the same topic to slip in.
        </p>
        <div className="mt-4 flex flex-col sm:flex-row gap-2 sm:items-center">
          <div className="relative flex-1">
            <Search className="h-4 w-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Filter campaigns…"
              className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <select value={kind} onChange={e => setKind(e.target.value as any)} className="border border-gray-300 rounded-md text-sm px-2 py-2">
            <option value="all">All campaigns</option>
            <option value="paraphrase">With reworded letters</option>
            <option value="form-letter">Exact copies only</option>
          </select>
          <select value={sortBy} onChange={e => setSortBy(e.target.value as SortKey)} className="border border-gray-300 rounded-md text-sm px-2 py-2">
            <option value="total">Most comments</option>
            <option value="paraphrased">Most reworded</option>
            <option value="name">Name</option>
          </select>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-sm border border-gray-200 divide-y divide-gray-100">
        {rows.map(c => (
          <Link key={c.id} to={`/campaigns/${c.id}`} className="block px-4 py-3 hover:bg-gray-50">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="font-medium text-gray-900">{c.name}</div>
                {c.description && <div className="text-sm text-gray-600 mt-0.5 line-clamp-2">{c.description}</div>}
              </div>
              <div className="text-right flex-shrink-0">
                <div className="text-lg font-semibold text-gray-900 tabular-nums">{c.total.toLocaleString()}</div>
                <div className="text-xs text-gray-500 tabular-nums whitespace-nowrap">
                  {c.exact.toLocaleString()} copies · {c.paraphrased.toLocaleString()} reworded
                </div>
              </div>
            </div>
            <div className="mt-2 h-1.5 bg-gray-100 rounded-full overflow-hidden flex" aria-hidden>
              <div className="bg-purple-400" style={{ width: `${(c.exact / max) * 100}%` }} />
              <div className="bg-amber-400" style={{ width: `${(c.paraphrased / max) * 100}%` }} />
            </div>
          </Link>
        ))}
        {rows.length === 0 && <div className="p-6 text-center text-sm text-gray-500">No campaigns match.</div>}
      </div>
      <p className="text-xs text-gray-500 flex items-center gap-3">
        <span className="inline-flex items-center gap-1"><span className="inline-block w-3 h-1.5 bg-purple-400 rounded" /> exact copies</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block w-3 h-1.5 bg-amber-400 rounded" /> reworded letters</span>
      </p>
    </div>
  )
}

export default CampaignBrowser
