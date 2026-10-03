import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

// The scope prompt as written: every scoped model call received it verbatim
function ScopePrompt({ markdown }: { markdown: string }) {
  return (
    <div className="rounded-md border border-[#d5dce7] bg-white">
      <p className="px-4 pt-3 text-xs text-[#5f6c82]">The prompt every step of this analysis was given, word for word.</p>
      <div className="px-4 pb-3 pt-1 max-h-[60vh] overflow-y-auto prose prose-sm max-w-none prose-headings:text-[#14233c] prose-p:text-[#14233c] prose-li:text-[#14233c] text-[#14233c]">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
      </div>
    </div>
  )
}

export default ScopePrompt
