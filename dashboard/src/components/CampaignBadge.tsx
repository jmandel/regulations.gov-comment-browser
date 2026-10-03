import { Link } from 'react-router-dom'
import { Megaphone } from 'lucide-react'
import useStore from '../store/useStore'
import type { Comment } from '../types'

// Pill linking a comment to the organized campaign it belongs to (from tag-campaigns)
function CampaignBadge({ comment, compact = false }: { comment: Comment; compact?: boolean }) {
  const campaign = useStore(s => (comment.campaignId !== undefined ? s.campaignsById.get(comment.campaignId) : undefined))
  if (!campaign) return null
  const how = comment.campaignParaphrase ? 'a reworded version of the campaign letter' : 'an exact or near-exact copy'
  return (
    <Link
      to={`/campaigns/${campaign.id}`}
      onClick={e => e.stopPropagation()}
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-900 hover:bg-amber-200 max-w-full min-w-0"
      title={`Campaign: ${campaign.name} (${campaign.total.toLocaleString()} comments: ${campaign.exact.toLocaleString()} copies, ${campaign.paraphrased.toLocaleString()} reworded). This comment is ${how}.`}
    >
      <Megaphone className="h-3 w-3 flex-shrink-0" />
      <span className="truncate">{compact ? 'Campaign' : campaign.name}</span>
      {comment.campaignParaphrase && !compact && <span className="font-normal text-amber-700 flex-shrink-0">· reworded</span>}
    </Link>
  )
}

export default CampaignBadge
