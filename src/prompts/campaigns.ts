// Prompts for campaign tagging: deciding whether a group of semantically similar letters comes
// from one organized campaign (shared template, sample letter or talking points, possibly reworded
// per sender) or is just independent letters on the same topic, and naming campaigns.

export function buildCampaignJudgePrompt(ruleTitle: string | null, letters: string[], totalUnits: number): string {
  const rule = ruleTitle ? `"${ruleTitle}"` : "a proposed federal rule";
  return `# Is this a coordinated comment campaign?

The letters below are public comments on a federal rulemaking: ${rule}. An embedding model put them in one group of ${totalUnits} similar comments (${letters.length} shown${letters.length < totalUnits ? ", spread across the group from most to least typical" : ""}). Exact copies were already grouped separately; these letters are worded differently.

Decide whether the group is a **campaign** — senders working from a common template, sample letter, action alert or set of talking points, often reworded or personalized (sometimes by AI) — or **independent letters** by people who happen to share a topic and position.

Evidence of a campaign (look for several, not just one):
- the same distinctive subject line, citation string or section reference, written the same way (e.g. "Section (46), Lactation Care Services, CPT codes 978XX and 978X1, 91 FR 43890 to 43891")
- the same opening move or self-introduction pattern ("I am a [profession] with [N] years...") and the same closing ask, in the same words or close paraphrases
- the same points in the same order, the same unusual specifics, statistics, examples or turns of phrase
- the same letterhead layout or document structure, or leftover placeholders like [Name] or [Practice]

Independent letters on the same topic look like this: openings, structure, arguments and examples vary from letter to letter; the overlap is only the subject and the obvious ask that anyone on that side would make (e.g. many physicians each explaining in their own way why a payment cut hurts their specialty). A shared profession, topic or stance alone is NOT a campaign. Neither are the standard arguments everyone on one side makes (e.g. "patients would need a second visit", "rural patients travel far", "practices may close") or the official names of the policy, codes and rule — every independent letter on the topic uses those. Look for wording and structure that would be unlikely if each sender wrote from scratch. When in doubt, answer "same_topic".

Answer with one of:
- "campaign": all or nearly all shown letters (at least ~80%) follow one common template/brief
- "mixed": some letters clearly follow a common template/brief, others are independent or follow a different one
- "same_topic": independent letters on the same topic

Return ONLY JSON:
{"verdict": "campaign" | "mixed" | "same_topic",
 "members": [numbers of the letters that follow the shared template/brief; [] if none],
 "evidence": "the specific shared features you relied on, quoting distinctive phrases that recur across most letters, or why the letters look independent",
 "name": "short campaign name, at most 8 words, naming the issue and the ask (e.g. 'Lactation consultants: value CPT 978XX for non-RN IBCLCs'); null if same_topic",
 "description": "1-2 sentences: who sends these letters and what they ask CMS to do; null if same_topic"}

${letters.map((t, i) => `--- Letter ${i + 1} ---\n${t}`).join("\n\n")}
`;
}

export function buildFormLetterNamingPrompt(ruleTitle: string | null, letters: { id: string; count: number; text: string }[]): string {
  const rule = ruleTitle ? `"${ruleTitle}"` : "a proposed federal rule";
  return `# Name these form-letter campaigns

Each item below is the text of a form letter that many people submitted (identical or nearly identical copies) as public comments on a federal rulemaking: ${rule}.

For each, give:
- "name": a short campaign name, at most 8 words, naming the issue and the ask (e.g. "Oppose 50% cut to same-day E/M visits")
- "description": 1-2 sentences: who sends it and what it asks the agency to do

Return ONLY a JSON array, one object per item, using the ids exactly as given:
[{"id": "f1", "name": "...", "description": "..."}, ...]

${letters.map(l => `--- ${l.id} (${l.count} copies) ---\n${l.text}`).join("\n\n")}
`;
}

export interface CampaignBrief { id: string; name: string; description: string | null; copies: number; excerpts: string[]; }

const briefBlock = (c: CampaignBrief) =>
  `--- ${c.id}: ${c.name} (${c.copies} comments) ---\n${c.description || ""}\n${c.excerpts.map((e, i) => `Example ${i + 1}: ${e}`).join("\n")}`;

export function buildCampaignMergePrompt(ruleTitle: string | null, campaigns: CampaignBrief[]): string {
  const rule = ruleTitle ? `"${ruleTitle}"` : "a proposed federal rule";
  return `# Which of these comment campaigns are the same campaign?

Each item below is a group of public comments on a federal rulemaking (${rule}) that was identified as an organized campaign: copies of one form letter, or letters reworded from a common template, sample letter or set of talking points. Groups were found separately, so one campaign may have been split into several groups (e.g. senders who personalized the letter differently, or a form letter and its reworded versions).

Put groups together only when they come from the **same campaign**: the same template, sample letter or action alert, recognizable from shared distinctive wording, citation strings, structure or unusual specifics in their examples. Different campaigns on the same issue (e.g. two different organizations' letters against the same payment cut, or a specialty society's letter and a patient letter) stay separate. When unsure, keep groups separate.

Return ONLY JSON: every group id exactly once, in sets of the same campaign (singletons allowed), each with a short name (at most 8 words, naming the issue and the ask) and a 1-2 sentence description of who sends it and what it asks:
{"campaigns": [{"groups": ["g1", "g3"], "name": "...", "description": "..."}, {"groups": ["g2"], "name": "...", "description": "..."}]}

${campaigns.map(briefBlock).join("\n\n")}
`;
}

export function buildCampaignExpandPrompt(ruleTitle: string | null, campaign: CampaignBrief, candidates: { id: string; text: string }[]): string {
  const rule = ruleTitle ? `"${ruleTitle}"` : "a proposed federal rule";
  return `# Does each comment belong to this campaign?

Public comments on a federal rulemaking (${rule}). Below is an organized comment campaign — letters copied or reworded from a common template, sample letter or set of talking points — with example letters, followed by candidate comments that an embedding model found similar.

For each candidate decide whether it was written from **this campaign's** template/brief: it shares the campaign's distinctive wording, citation strings, structure or specific talking points (possibly reworded, shortened or with personal additions). A comment that is merely on the same topic or takes the same position, in its own words and structure, does NOT belong. When unsure, answer false.

For each member, quote in "shared" the most distinctive phrase (at least 6 words, copied exactly from the candidate) that also appears word for word in the campaign examples. Generic phrases any letter on the topic would use ("I am writing to express my strong opposition to the proposed") don't count; if the only shared wording is generic, the candidate is not a member.

## Campaign
${briefBlock(campaign)}

## Candidates
${candidates.map(c => `--- ${c.id} ---\n${c.text}`).join("\n\n")}

Return ONLY JSON, one entry per candidate, ids exactly as given:
{"results": [{"id": "${candidates[0]?.id ?? "k1"}", "member": true, "shared": "exact phrase from the candidate"}, {"id": "...", "member": false, "shared": null}, ...]}
`;
}
