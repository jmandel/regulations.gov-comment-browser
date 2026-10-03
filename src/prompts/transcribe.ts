export const TRANSCRIBE_PROMPT = `# Comment Transcription Instructions

You will receive a public comment submitted regarding a federal regulation, possibly including PDF attachments. Your task is to produce a faithful markdown transcription that preserves the full substantive content with light editorial cleanup.

## Instructions

Transcribe the FULL substantive content of the comment and all attachments into clean, well-structured markdown:

- **Preserve everything substantive** — every argument, recommendation, data point, anecdote, quote, citation, example, and policy position
- **Use proper markdown** — headings (#, ##, ###), bullet lists, numbered lists, bold, italic, block quotes, tables — whatever best represents the original structure
- **Preserve the author's voice** — keep their phrasing, tone, and word choices; use "I/we" as they did
- **Preserve section structure** — if the original has sections, headings, or numbered responses to specific questions, keep that organization
- **Keep technical terms and acronyms** intact
- **Keep all quotations, statistics, and specific references** verbatim
- **Describe non-text content for a reader who can't see the page** — charts, figures, diagrams, images, and anything conveyed by color, shading or position (a Gantt chart, a shaded table, an annotated screenshot). State what it shows in words or as a table with the actual values and labels; for a timeline, give each row's start and end. Never leave table cells empty when the original shows something in them. Skip purely decorative images such as logos

**The ONLY things to remove:**
- Page headers/footers, letterhead artifacts, and formatting noise from PDF extraction
- Pure boilerplate about the comment process itself ("Please see attached file(s)", "See the attached document for our comments", etc.)
- Comment-box text that contains no substantive content beyond pointing to attachments — if the real content is in the attached documents, just transcribe those

**Keep salutations, sign-offs, and signature blocks** only if they contain unique information (credentials, titles, affiliations, organizations) not already mentioned in the body of the comment. Strip them if they just repeat the commenter's name and address.

**Do NOT remove or compress:**
- Introductory paragraphs that establish who the commenter is and their stake in the issue
- Concluding paragraphs that summarize positions or make final recommendations
- Anything with substantive content, even if it sounds "fluffy" — when in doubt, keep it

This is a **transcription** task, not a summarization task. Your output should be nearly as long as the original. You are converting messy source material (comment text, PDFs, images, multi-part submissions) into clean, readable markdown — not condensing it.

Output ONLY the transcribed markdown. No preamble, no commentary.

---

Here is the comment to transcribe:`;
