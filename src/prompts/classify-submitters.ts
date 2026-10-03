// Who each submission speaks for, from its filed metadata and the start and end of its text
// (where letterheads, introductions and signatures are). Units are sent in batches; the model
// returns one classification each.
import { SUBMITTER_TYPES } from "../lib/submitter-meta";

export interface ClassifyItem {
  id: string;
  name: string | null;          // filed first + last name ("Anonymous" blanked)
  organization: string | null;  // filed organization field
  category: string | null;      // filed category, raw
  title: string | null;         // only when it is not boilerplate
  note: string | null;          // e.g. "copy of a form letter; text below is what this sender added"
  text: string;                 // start (and end) of the text
}

export function buildClassifyPrompt(ruleTitle: string | null, items: ClassifyItem[]): string {
  const rule = ruleTitle ? `"${ruleTitle}"` : "a federal rule";
  const types = (group: string) => SUBMITTER_TYPES.filter(t => t.group === group).map(t => `- \`${t.key}\` — ${t.label}`).join("\n");
  return `# Who submitted each public comment

Each item below is a public comment on a federal rulemaking: ${rule}. For each one you get what the submitter typed into the regulations.gov form (name, organization, category) and the start and end of the comment text, where letterheads, introductions and signatures usually are. Decide who the submission speaks for.

## speaks_for

- **organization** — written on behalf of an organization: letterhead, "on behalf of", "we at <org>", "our members/patients/company", signed by someone with a title acting for the organization (president, CEO, director of government affairs, practice administrator), or a joint letter from several organizations. Members of Congress, state officials and agencies writing in their official role count as organizations (type \`government\`).
- **individual** — written by a person for themselves: personal experience or opinion ("I am a physician", "my mother", "as a Medicare patient"), even when they mention where they work. A clinician who writes about "my patients" or "my practice" in the first person singular, without presenting the letter as the practice's, is an individual.

The form fields are hints, often wrong. Many citizens pick "Government - Federal" or "Congressional" because they are writing to the government, and many professionals pick "Individual". The organization field sometimes holds an employer, a product or a campaign vendor while the text is personal; then the submission is an individual's and organization is null. A filing named "Anonymous" can be an organization's letter. Go by the text when it is clear; when the text is empty or uninformative, go by the fields (an organization field that names an organization → organization; a personal name → individual).

## type

Individuals:
${types("individual")}

Organizations:
${types("organization")}

Notes:
- \`physician\`: MD/DO, including residents and any specialty. \`other_clinician\`: NP, PA, nurse, physical/occupational/speech therapist, psychologist, pharmacist, chiropractor, dietitian, social worker, audiologist, other licensed clinicians. \`other_professional\`: practice managers, billing and coding staff, health IT and industry employees, consultants, researchers, lawyers writing from their work. \`patient_family\`: writes as a patient, Medicare beneficiary, family member or caregiver. \`other_individual\`: anyone else, or not enough to tell.
- Pick the role the comment is written from. A nurse writing about a parent's care is \`patient_family\`; a physician writing about payment for their services is \`physician\`.
- \`practice\`: physician groups, therapy clinics, FQHCs and community health centers, surgery centers, labs, pharmacies, nursing homes, home health and hospice agencies, ACOs and other care providers that are not hospitals. \`association\`: medical and specialty societies, state medical associations, provider and industry trade associations, coalitions of such groups. \`advocacy\`: patient, disease, consumer, disability and community advocacy groups. \`other_org\`: employers, unions, law and consulting firms, foundations, think tanks and anything else.

## organization

For speaks_for = organization: the organization's name as written in the text or the organization field, without address or tagline (for a joint letter, the first or lead organization; for an elected official, their office, e.g. "Rep. Jane Doe"). For individuals: null.

Return ONLY a JSON array with one object per item, in the same order, using the ids exactly as given:
[{"id": "s1", "speaks_for": "individual", "type": "physician", "organization": null}, ...]

## Submissions

${items.map(formatItem).join("\n\n")}
`;
}

function formatItem(it: ClassifyItem): string {
  const lines = [
    `name: ${it.name || "(blank)"}`,
    `organization field: ${it.organization || "(blank)"}`,
    `category: ${it.category || "(not specified)"}`,
  ];
  if (it.title) lines.push(`title: ${it.title}`);
  if (it.note) lines.push(`note: ${it.note}`);
  return `<submission id="${it.id}">\n${lines.join("\n")}\n<text>\n${it.text || "(no text)"}\n</text>\n</submission>`;
}
