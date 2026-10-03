import { User, Building2 } from 'lucide-react'
import useStore from '../store/useStore'
import type { Comment } from '../types'

// Organization icon: the AI-assigned side when there is one, else how it was filed
export function isOrganization(c: Comment): boolean {
  return c.typeGroup ? c.typeGroup === 'organization' : c.filedAs === 'organization'
}

export function SubmitterIcon({ comment }: { comment: Comment }) {
  return isOrganization(comment)
    ? <Building2 className="h-4 w-4 text-gray-500 flex-shrink-0" aria-hidden="true" />
    : <User className="h-4 w-4 text-gray-500 flex-shrink-0" aria-hidden="true" />
}

export function SubmitterName({ comment }: { comment: Comment }) {
  return (
    <h4
      className="font-semibold text-gray-900 truncate"
      title={comment.nameFromTitle ? `${comment.submitter} (no name was filed; this is from the submission's title)` : comment.submitter}
    >
      {comment.submitter}
    </h4>
  )
}

// The commenter type (and organization it speaks for), from the docket's one source
export function SubmitterType({ comment, className = '' }: { comment: Comment; className?: string }) {
  const typeSource = useStore(s => s.typeSource)
  const title = typeSource === 'ai'
    ? 'Commenter type assigned by AI from the form fields and the comment text'
    : comment.submitterType === 'Not specified' ? 'No category was chosen on regulations.gov' : 'Category chosen on regulations.gov'
  return (
    <span className={`text-sm text-gray-600 ${className}`} title={title}>
      • {comment.submitterType}{comment.org ? <> · {comment.org}</> : null}
    </span>
  )
}
