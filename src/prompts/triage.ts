// Triage of short typed comments: decides which ones carry enough content to be worth
// condensing and extracting. Comments are sent in batches; the model returns one label each.

export const TRIAGE_LABELS = ["no_substance", "stance_only", "substantive"] as const;
export type TriageLabel = typeof TRIAGE_LABELS[number];

export function buildTriagePrompt(ruleTitle: string | null, comments: { id: string; text: string }[]): string {
  const rule = ruleTitle ? `"${ruleTitle}"` : "a proposed federal rule";
  return `# Triage of brief public comments

Each item below is a public comment submitted on a federal rulemaking: ${rule}. These are the brief comments typed directly into the comment box (no attachments). Your job is to sort them so that a later step only spends effort analyzing comments that actually say something beyond a bare position.

Label each comment with exactly one of:

- **no_substance** — no identifiable topic or position. Examples: "Strong objection", "I really don't know what I'm saying", "test", "Please see my comments", a greeting or name only, text that is unrelated to the rule or unintelligible.
- **stance_only** — an identifiable topic and position, but nothing more: no reason, no personal experience, no specifics, no recommendation beyond the position itself. Examples: "I support increasing the physician fee schedule"; "Do not change the medicare payment provisions for orthopedic care"; "Withdraw this proposal" (a bare demand to withdraw or approve is a position on the whole rule: topic "the proposed rule").
- **substantive** — gives ANY reason, personal or professional experience, specific detail (a named service, code, program, number, consequence), or concrete recommendation, even in a single sentence. Examples: "Without this service, I feel that my life would have already ended" (personal experience); "Cutting PT payments will force rural clinics like mine to close" (a reason and a consequence); "Please keep telehealth audio-only visits for patients without broadband" (a specific recommendation with a reason).

Rules:
- When in doubt between stance_only and substantive, choose **substantive**. When in doubt between no_substance and stance_only, choose **stance_only**.
- Judge content, not writing quality: misspelled or angry comments can still be substantive.
- Saying who the commenter is ("As a physical therapist, I oppose the cuts") is not by itself a reason; it becomes substantive only with a reason or experience attached.

For every comment also give:
- **topic**: what the comment is about, in a few words (e.g. "physical therapy payment cuts", "telehealth flexibilities", "the proposed rule"). Use null for no_substance.
- **stance**: one of "support", "oppose", "mixed", "other" — the commenter's position toward what they are discussing (supporting the proposed change = support; asking CMS not to make it = oppose). Use null for no_substance.

Return ONLY a JSON array with one object per comment, in the same order, using the ids exactly as given:
[{"id": "c1", "label": "stance_only", "topic": "the proposed rule", "stance": "oppose"}, ...]

## Comments

${comments.map(c => `<comment id="${c.id}">\n${c.text}\n</comment>`).join("\n\n")}
`;
}
