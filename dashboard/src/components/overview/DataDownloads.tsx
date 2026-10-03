import { Download } from 'lucide-react'
import type { Meta } from '../../types'

const DESCRIPTIONS: Record<string, { title: string; text: string }> = {
  slim: {
    title: 'Analysis database',
    text: 'Every comment’s metadata, form-letter groups, campaigns, summaries, themes, theme reports and the points extracted from each comment. No full comment text.',
  },
  full: {
    title: 'Full database',
    text: 'Everything in the analysis database plus the full text of every comment, with attachments transcribed.',
  },
}

export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)} MB`
  return `${Math.max(1, Math.round(n / 1e3))} KB`
}

// "Download the data": the zipped SQLite databases build-website writes next to the site data
export function DataDownloads({ downloads }: { downloads: NonNullable<Meta['downloads']> }) {
  const linkClass = 'text-[var(--ov-link)] underline decoration-1 underline-offset-2 decoration-[var(--ov-link)]/40 hover:decoration-[var(--ov-link)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ov-link)] rounded-sm'
  const order = ['slim', 'full']
  const items = [...downloads].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))
  return (
    <section aria-labelledby="ov-download">
      <h2 id="ov-download" className="text-lg font-semibold">Download the data</h2>
      <p className="mt-1 text-sm text-[var(--ov-ink-2)] max-w-[62ch]">
        SQLite databases for your own analysis or an AI assistant, each zipped with a README that documents every table and gives example queries. Summaries, themes and transcripts are AI-generated.
      </p>
      <ul className="mt-4 space-y-4">
        {items.map(d => {
          const info = DESCRIPTIONS[d.kind] || { title: d.file, text: '' }
          return (
            <li key={d.file}>
              <a href={`./data/${d.file}`} download className={`${linkClass} inline-flex items-center gap-1.5 text-sm font-medium`}>
                <Download className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
                {info.title}
              </a>
              <span className="ml-2 text-xs text-[var(--ov-ink-3)] tnum">{formatBytes(d.bytes)} zip</span>
              <p className="mt-1 text-sm leading-relaxed text-[var(--ov-ink-2)]">{info.text}</p>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
