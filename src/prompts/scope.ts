// Prompts for scoped analyses. A scope is a markdown prompt written by a person (or drafted from a
// seed comment and then edited). Scoped runs insert scopeBlock() into the theme discovery,
// extraction and summary prompts; without a scope those prompts are byte-identical to the
// open-ended ones, so existing llm_cache entries stay valid.

export function scopeBlock(promptMd: string): string {
  return `## Scope of this analysis
${promptMd.trim()}

Analyze only what bears on this scope. Ignore material outside it.
`;
}

// Insert `block` before the first occurrence of `anchor` in `prompt` (throws if the anchor moved,
// so a prompt edit can't silently drop the scope)
export function insertBefore(prompt: string, anchor: string, block: string): string {
  const i = prompt.indexOf(anchor);
  if (i < 0) throw new Error(`scope: anchor not found in prompt: ${anchor.slice(0, 40)}`);
  return prompt.slice(0, i) + block + "\n" + prompt.slice(i);
}

// ── Relevance ───────────────────────────────────────────────────────────────────────────────
// Recall-biased: a unit wrongly excluded is lost from every later scoped step, while a unit wrongly
// included only costs an extraction call that finds little.
export function buildScopeRelevancePrompt(ruleTitle: string | null, scopeMd: string, comments: { id: string; text: string }[]): string {
  const rule = ruleTitle ? `"${ruleTitle}"` : "a proposed federal rule";
  return `# Which comments address this scope?

The items at the end are public comments on a federal rulemaking: ${rule}. An analyst wants a focused analysis of just the part of the public input described by the scope below. Your job is to decide, for each comment, whether it addresses the scope, and to copy out the parts that do.

${scopeBlock(scopeMd)}
## Rules

- A comment is **relevant** if ANY part of it addresses the scope: a position, reason, concern, experience, recommendation, data point or request about something the scope covers. One sentence or one paragraph in a long letter is enough.
- Be generous. A relevant comment you leave out is lost from the analysis for good; an extra one only costs a little review time. When unsure, mark it relevant.
- Read the scope as a whole. Phrases that qualify its subject (e.g. "burden on small practices" in a scope about health IT, or "especially X") mean that aspect OF the subject, not a separate topic: a comment about the qualifier alone (say, small-practice burden from payment cuts, with nothing about the scope's subject) is not relevant. If the scope lists several separate issues, a comment on any one of them is relevant.
- Not relevant: the comment never touches the scope's subject matter, or only uses one of its words in an unrelated sense or in a bare list of unrelated items.
- Long letters from organizations often cover many issues. Read every section, including appendices, footnotes and lists of recommendations, before deciding.
- Some comments are given as a structured summary (profile, positions, recommendations, concerns) rather than full text; judge them the same way.

For each relevant comment give:
- **excerpt**: the passages that address the scope, copied VERBATIM from the comment (from the summary text when that is all you have). Include every in-scope passage, with enough surrounding words to make sense on its own; join separate passages with a line containing only "[...]". Leave out everything outside the scope. Keep it under about 600 words; if there is more, keep the most specific passages (numbers, examples, recommendations).
- **note**: one short line saying which part of the scope it touches and the commenter's stance, e.g. "prior authorization API timeline; asks CMS to delay to 2028".

For a comment that is not relevant, give relevant: false, excerpt "", and a note of a few words saying what it is about instead.

Return ONLY a JSON object mapping every comment id, exactly as given, to its judgment:
{"c1": {"relevant": true, "excerpt": "...", "note": "..."}, "c2": {"relevant": false, "excerpt": "", "note": "anesthesia conversion factor"}}

## Comments

${comments.map(c => `<comment id="${c.id}">\n${c.text}\n</comment>`).join("\n\n")}
`;
}

// ── Name + summary for a written scope ──────────────────────────────────────────────────────
export function buildScopeLabelPrompt(scopeMd: string): string {
  return `Below is the scope of a focused analysis of public comments on a federal regulation. Write a label for it, for display on every page of the analysis:

- "name": a short noun phrase of at most 6 words naming the subject (e.g. "Interoperability and health IT"); don't add filler like "Analysis" or "Comments on"
- "summary": one plain sentence (under 30 words) saying what the analysis covers

Return ONLY a JSON object: {"name": "...", "summary": "..."}

<scope>
${scopeMd.trim()}
</scope>
`;
}

// ── Scope drafted from a seed comment ───────────────────────────────────────────────────────
export function buildScopeFromCommentPrompt(ruleTitle: string | null, commentId: string, submitter: string, text: string): string {
  const rule = ruleTitle ? `"${ruleTitle}"` : "a proposed federal rule";
  return `You are helping an analyst set up a focused analysis of the public comments on a federal rulemaking: ${rule}.

The analyst wants to know how the rest of the docket responded to the issues raised in one particular comment (the "seed" letter, below). Write the scope for that analysis: a markdown prompt that a later step will use to decide which other comments are relevant and to organize what they say.

The scope prompt should:
- Start with one sentence saying the scope is the set of issues raised in comment ${commentId} (${submitter}).
- Then list each distinct issue the letter raises as a numbered item: name the specific provision, program, code or policy concretely (use the letter's own terms, codes and section names so related comments can be recognized), and state in a clause what the letter argues or asks for. Merge trivial points into the issue they support; keep genuinely separate issues separate. Typically 4-15 items.
- End with one sentence asking, for each issue, who else raised it, who agreed or disagreed with the letter's position, and why.
- Not quote the letter at length; it is a scope, not a summary.

Also give:
- "name": a short noun phrase of at most 6 words naming the analysis (e.g. "Issues in the AMA letter")
- "summary": one plain sentence (under 30 words) saying what the analysis covers

Return ONLY a JSON object: {"name": "...", "summary": "...", "prompt_md": "..."}

<seed_comment id="${commentId}" submitter="${submitter.replace(/"/g, "'")}">
${text}
</seed_comment>
`;
}
