import { Link } from 'react-router-dom'
import { Building2, User, Users } from 'lucide-react'
import useStore from '../store/useStore'

interface CommentLinkProps {
  commentId: string
  className?: string
  showIcon?: boolean
  showSubmitterType?: boolean
  showClusterBadge?: boolean
}

function CommentLink({ 
  commentId, 
  className = '', 
  showIcon = true,
  showSubmitterType = false,
  showClusterBadge = true
}: CommentLinkProps) {
  const { getCommentById } = useStore()
  const comment = getCommentById(commentId)
  
  if (!comment) {
    return (
      <span className={`text-gray-500 ${className}`}>
        Comment {commentId}
      </span>
    )
  }
  
  const isOrganization = comment.submitterType === 'Organization' || 
                         comment.submitterType === 'Business' ||
                         comment.submitterType === 'Healthcare Organization' ||
                         comment.submitterType === 'Government Agency' ||
                         comment.submitterType === 'Trade Association'
  
  const hasCluster = comment.clusterSize && comment.clusterSize > 1
  const additionalComments = hasCluster ? (comment.clusterSize! - 1) : 0
  
  return (
    <div className="inline-flex items-center gap-2">
      <Link
        to={`/comments/${commentId}`}
        className={`inline-flex items-center hover:underline ${className}`}
        title={`View comment by ${comment.submitter}${showSubmitterType ? ` (${comment.submitterType})` : ''}${hasCluster ? ` (${additionalComments} similar comments)` : ''}`}
      >
        {showIcon && (
          isOrganization ? (
            <Building2 className="h-3 w-3 mr-1 flex-shrink-0" />
          ) : (
            <User className="h-3 w-3 mr-1 flex-shrink-0" />
          )
        )}
        <span className="truncate max-w-[300px]">{comment.submitter}</span>
        {showSubmitterType && comment.submitterType && (
          <span className="text-gray-500 ml-1 text-xs">({comment.submitterType})</span>
        )}
      </Link>
      {showClusterBadge && hasCluster && comment.isClusterRepresentative && (
        <span 
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-800"
          title={`This comment represents ${comment.clusterSize} similar submissions`}
        >
          <Users className="h-3 w-3" />
          +{additionalComments}
        </span>
      )}
    </div>
  )
}

export default CommentLink