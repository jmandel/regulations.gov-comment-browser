// Gate before theme extraction: decides which top-level theme groups each comment discusses
// (the model lists sub-theme codes, which it matches more reliably; callers map them to groups),
// so extraction only runs for those groups. Recall-biased: a missed group means a lost extract,
// while an extra group only costs one extraction call that comes back empty.

export interface GateGroup {
  code: string;
  description: string;
  children: string[];   // names of the group's sub-themes
}

export function formatGateGroups(groups: GateGroup[]): string {
  return groups.map(g => {
    const kids = g.children.length > 0 ? `\n${g.children.map(c => `   - ${c}`).join("\n")}` : "";
    return `${g.code}. ${g.description}${kids}`;
  }).join("\n\n");
}

// Fixed content (instructions + groups) comes first so it forms a shared, cacheable prefix
export function buildThemeGatePrompt(
  ruleTitle: string | null,
  groupsText: string,
  comments: { id: string; text: string }[]
): string {
  const rule = ruleTitle ? `"${ruleTitle}"` : "a proposed federal rule";
  return `# Which topics does each comment discuss?

The items at the end are public comments on a federal rulemaking: ${rule}. Analysts have organized the issues raised in these comments into the topic groups below, each with numbered sub-topics. A later step will extract, group by group, what each comment says. Your job is to decide which topics each comment discusses, so it is sent to every group that needs it.

## Topics

${groupsText}

## Rules

- Read the whole comment and list EVERY topic it substantively discusses: a position, reason, concern, experience, recommendation, data point, or request about it. One sentence is enough.
- Give the most specific code that fits (e.g. "4.6" rather than "4"). Use a group's code alone (e.g. "4") only when the comment discusses that group's area but none of its sub-topics.
- Comments often belong under several groups. A clinician objecting to a payment policy belongs under the topic for that policy AND under the topic for their own specialty, profession or services if it is listed; cross-cutting arguments (overall payment levels or costs, effects on access, how the agency made its estimates, the rulemaking process) belong under those topics too if they are listed, in addition to the specific service the comment is about.
- Be generous. Leaving out a topic the comment discusses loses that content for good; listing one it doesn't discuss only costs a little extra work. When unsure, include it.
- Long comments (letters from organizations) usually discuss many topics; check every section of the letter, including appendices and lists of recommendations.
- Leave out a topic only if the comment does not discuss it at all, or touches it only in passing (e.g. a word in a list of unrelated items).
- A comment that discusses none of the topics gets an empty list.

Return ONLY a JSON object mapping every comment id to its list of topic codes, for example:
{"c1": ["2.1", "2.4", "5.3"], "c2": [], "c3": ["1", "12.2"]}

## Comments

${comments.map(c => `<comment id="${c.id}">\n${c.text}\n</comment>`).join("\n\n")}
`;
}
