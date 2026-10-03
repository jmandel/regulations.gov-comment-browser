import { useParams } from 'react-router-dom'
import useStore from '../store/useStore'
import CommentDetailView from './CommentDetailView'
import Breadcrumbs from './Breadcrumbs'

function CommentDetail() {
  const { commentId } = useParams<{ commentId: string }>()
  const { getCommentById } = useStore()

  const comment = commentId ? getCommentById(commentId) : undefined
  
  if (!comment) {
    return (
      <div className="space-y-6">
        <Breadcrumbs items={[
          { label: 'Comments', path: '/comments' },
          { label: 'Not Found' }
        ]} />
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8 text-center">
          <p className="text-gray-500">Comment not found</p>
        </div>
      </div>
    )
  }
  
  return (
    <div className="space-y-6">
      <Breadcrumbs items={[
        { label: 'Comments', path: '/comments' },
        { label: `Comment #${comment.id}` }
      ]} />
      
      <CommentDetailView comment={comment} />
    </div>
  )
}

export default CommentDetail 