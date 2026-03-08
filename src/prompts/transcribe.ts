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

**The ONLY things to remove:**
- Salutations and greetings ("Dear Secretary...", "To Whom It May Concern")
- Closing pleasantries and sign-offs ("Thank you for the opportunity to comment", "Sincerely", "Respectfully submitted")
- Signature blocks (name, title, address repeated at the end)
- Pure boilerplate about the comment process itself
- Page headers/footers, letterhead artifacts, and formatting noise from PDF extraction

**Do NOT remove or compress:**
- Introductory paragraphs that establish who the commenter is and their stake in the issue
- Concluding paragraphs that summarize positions or make final recommendations
- Anything with substantive content, even if it sounds "fluffy" — when in doubt, keep it

This is a **transcription** task, not a summarization task. Your output should be nearly as long as the original. You are converting messy source material (PDFs, form letters, multi-part submissions) into clean, readable markdown — not condensing it.

Output ONLY the transcribed markdown. No preamble, no commentary.

---

Here is the comment to transcribe:

{COMMENT_TEXT}`;
