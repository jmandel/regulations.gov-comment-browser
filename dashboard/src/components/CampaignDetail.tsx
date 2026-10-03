import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Megaphone, Users, MessageSquare } from 'lucide-react'
import useStore from '../store/useStore'
import type { Comment } from '../types'

const PAGE = 100

function MemberRow({ c, note }: { c: Comment; note?: string }) {
  return (
    <li className="px-4 py-2.5">
      <div className="flex items-center gap-2 text-sm">
        <Link to={`/comments/${c.id}`} className="text-blue-700 hover:underline font-mono text-xs flex-shrink-0">{c.id}</Link>
        <span className="text-gray-900 truncate">{c.submitter}</span>
        {note && <span className="text-xs text-purple-800 bg-purple-100 rounded-full px-2 py-0.5 flex-shrink-0">{note}</span>}
      </div>
      {c.structuredSections?.oneLineSummary && (
        <div className="text-sm text-gray-600 mt-0.5 line-clamp-2">{c.structuredSections.oneLineSummary}</div>
      )}
    </li>
  )
}

function CampaignDetail() {
  const { campaignId } = useParams<{ campaignId: string }>()
  const { campaignsById, comments, commentsById } = useStore()
  const campaign = campaignsById.get(Number(campaignId))
  const [shown, setShown] = useState(PAGE)

  // Members: exact-copy groups (by representative) and reworded letters
  const { groups, reworded, looseCopies } = useMemo(() => {
    const id = Number(campaignId)
    const members = comments.filter(c => c.campaignId === id)
    const byRep = new Map<string, Comment[]>()
    const reworded: Comment[] = []
    const looseCopies: Comment[] = []
    for (const c of members) {
      if (c.campaignParaphrase) { reworded.push(c); continue }
      const rep = c.clusterRepresentativeId || c.id
      if ((c.clusterSize || 1) > 1) {
        let g = byRep.get(rep); if (!g) byRep.set(rep, g = []); g.push(c)
      } else looseCopies.push(c) // e.g. a member promoted out of its group for its added text
    }
    const groups = [...byRep.entries()]
      .map(([rep, list]) => ({ rep: commentsById.get(rep) || list[0], count: list.length }))
      .sort((a, b) => b.count - a.count)
    reworded.sort((a, b) => a.id.localeCompare(b.id))
    return { groups, reworded, looseCopies }
  }, [campaignId, comments, commentsById])

  if (!campaign) {
    return (
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8 text-center text-gray-500">
        Campaign not found. <Link to="/campaigns" className="text-blue-600 hover:underline">All campaigns</Link>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <Link to="/campaigns" className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline">
        <ArrowLeft className="h-4 w-4" /> All campaigns
      </Link>
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 sm:p-6">
        <h2 className="text-lg font-semibold text-gray-900 flex items-start gap-2">
          <Megaphone className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" /> {campaign.name}
        </h2>
        {campaign.description && <p className="text-sm text-gray-700 mt-2">{campaign.description}</p>}
        <div className="grid grid-cols-3 gap-3 mt-4">
          <div className="bg-gray-50 rounded-md p-3">
            <div className="text-xs text-gray-500">Comments</div>
            <div className="text-xl font-semibold tabular-nums">{campaign.total.toLocaleString()}</div>
          </div>
          <div className="bg-purple-50 rounded-md p-3">
            <div className="text-xs text-purple-700">Exact copies</div>
            <div className="text-xl font-semibold tabular-nums text-purple-900">{campaign.exact.toLocaleString()}</div>
          </div>
          <div className="bg-amber-50 rounded-md p-3">
            <div className="text-xs text-amber-700">Reworded letters</div>
            <div className="text-xl font-semibold tabular-nums text-amber-900">{campaign.paraphrased.toLocaleString()}</div>
          </div>
        </div>
        {campaign.evidence && (
          <p className="text-xs text-gray-500 mt-3"><span className="font-medium text-gray-600">Why grouped:</span> {campaign.evidence}</p>
        )}
        <Link
          to={`/comments?campaign=${campaign.id}`}
          className="inline-flex items-center gap-1.5 mt-4 text-sm px-3 py-1.5 rounded-md bg-blue-50 text-blue-700 hover:bg-blue-100"
        >
          <MessageSquare className="h-4 w-4" /> Browse these comments
        </Link>
      </div>

      {groups.length > 0 && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200">
          <h3 className="px-4 pt-4 pb-2 font-semibold text-gray-900 flex items-center gap-2">
            <Users className="h-4 w-4 text-purple-600" /> Form-letter groups ({groups.length})
          </h3>
          <ul className="divide-y divide-gray-100">
            {groups.map(g => <MemberRow key={g.rep.id} c={g.rep} note={`${g.count.toLocaleString()} copies`} />)}
          </ul>
        </div>
      )}

      {reworded.length > 0 && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200">
          <h3 className="px-4 pt-4 pb-2 font-semibold text-gray-900">Reworded letters ({reworded.length.toLocaleString()})</h3>
          <ul className="divide-y divide-gray-100">
            {reworded.slice(0, shown).map(c => <MemberRow key={c.id} c={c} />)}
          </ul>
          {shown < reworded.length && (
            <button onClick={() => setShown(s => s + PAGE)} className="w-full py-2 text-sm text-blue-600 hover:bg-gray-50 border-t border-gray-100">
              Show more ({(reworded.length - shown).toLocaleString()} left)
            </button>
          )}
        </div>
      )}

      {looseCopies.length > 0 && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200">
          <h3 className="px-4 pt-4 pb-2 font-semibold text-gray-900">Copies with substantial additions ({looseCopies.length})</h3>
          <ul className="divide-y divide-gray-100">
            {looseCopies.slice(0, PAGE).map(c => <MemberRow key={c.id} c={c} />)}
          </ul>
        </div>
      )}
    </div>
  )
}

export default CampaignDetail
