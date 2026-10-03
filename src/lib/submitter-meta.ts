// Submitter metadata as filed on regulations.gov, normalized for display and counting. Shared by
// build-website (comments-index.json, overview.json), the downloadable databases and
// classify-submitters, so every place agrees on the same labels.
//
// What the submitter filed is never replaced: the raw category stays available next to its folded
// label, and a blank category is "Not specified" (it is not evidence the submitter is an individual).

export const NOT_SPECIFIED = "Not specified";

// regulations.gov mixes two category vocabularies ("Physician - HC005" and "Health Care
// Professional/Association - Physician"), with codes, truncations and synonyms; fold them onto one
// plain name. Provider facilities from either vocabulary become "Provider - <facility>".
const CATEGORY_FIXES: Record<string, string> = {
  "Other Practitione": "Other Practitioner", "Occupational Therapis": "Occupational Therapist",
  "Dietician/Nutritionist": "Dietitian/Nutritionist",
  "Health Care Professional or Association": "Other Health Care Professional",
  "Health Care Provider/Association": "Provider - Other", "Other Health Care Provider": "Provider - Other",
  "Federal Government": "Government - Federal", "State Government": "Government - State",
  "Local Government": "Government - Local", "Other Government": "Government - Other", "Government": "Government - Other",
  "Health Care Industry": "Industry - Health Care", "Private Industry - Health Care": "Industry - Health Care",
  "Device Industry": "Industry - Device", "Private Industry - Device": "Industry - Device",
  "Drug Industry": "Industry - Drug", "Private Industry - Drug": "Industry - Drug",
  "Laboratory Industry": "Industry - Laboratory", "Private Industry - Laboratory": "Industry - Laboratory",
  "Media Industry": "Industry - Media", "Private Industry - Media": "Industry - Media", "Private Industry": "Industry - Other",
  "Device Association": "Association - Device", "Drug Association": "Association - Drug",
  "Media Association": "Association - Media", "Other Association": "Association - Other", "Association": "Association - Other",
  "Other - Academic": "Academic", "Other - Attorney/Law Firm": "Attorney/Law Firm",
  "Health Plan or Association": "Health Plan",
};
const PROVIDER_FACILITY = /^(Hospital|Critical Access Hospital|Ambulatory Surgical Center|Rural Health Clinic|Home Health Facility|Long-term Care|Hospice|Psychiatric Hospital|End-Stage Renal Disease Facilit(y)?|Comprehensive Outpatient Rehabilitation Facility|Organ Procurement Organization|Religious Nonmedical Health Care Institution|Intermediate Care Facility.*)$/;

export function foldCategory(raw: string | null | undefined): string {
  let s = String(raw ?? "").trim();
  if (!s) return NOT_SPECIFIED;
  s = s.replace(/\s+-\s+[A-Z]{1,3}\d{2,4}$/, "");              // codes: HC005, PI015, HPA05, I0001
  s = s.replace(/^Health Care Professional(\/| or )Association\s+-\s+/, "");
  s = s.replace(/^Health Care Provider\/Association\s+-\s+(?:HPA\d+$)?/, "Provider - ");
  if (s === "Provider - ") s = "Provider - Other";
  s = CATEGORY_FIXES[s] || s;
  if (PROVIDER_FACILITY.test(s)) s = "Provider - " + s.replace(/Facilit$/, "Facility");
  if (/^Provider - End-Stage Renal Disease Facilit$/.test(s)) s += "y";
  return s || NOT_SPECIFIED;
}

// How the submission was filed, from the name and organization fields alone
export type FiledAs = "organization" | "person" | "anonymous";
export const FILED_AS_LABELS: Record<FiledAs, string> = {
  organization: "Organization", person: "Named person", anonymous: "Anonymous",
};

const clean = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
const isAnonymousName = (s: string) => !s || /^(anonymous|anon|n\/?a|none|unknown|private|citizen|-+|\.+)(\s+(anonymous|anon|n\/?a|none|unknown|private|citizen))*$/i.test(s);

export function personName(attrs: any): string {
  const first = clean(attrs?.firstName), last = clean(attrs?.lastName);
  const name = first && last && first.toLowerCase() === last.toLowerCase() && isAnonymousName(first) ? "" : `${first} ${last}`.trim();
  return isAnonymousName(name) ? "" : name;
}

export function filedAs(attrs: any): FiledAs {
  if (clean(attrs?.organization)) return "organization";
  return personName(attrs) ? "person" : "anonymous";
}

// The submitter named in a non-boilerplate title, for submissions with no name or organization.
// Titles are usually "Comment on <doc>" or "Comment from Last, First, <docket>, <doc>, <FR doc>";
// the agency sometimes appends flags ("--Contains PII", "-DUPLICATE"), which are dropped.
export function titleSubmitter(title: unknown): string | null {
  let t = clean(title);
  if (!t) return null;
  if (/^Comment (on|submitted|regarding|re:?)\b/i.test(t)) return null;
  const from = t.match(/^Comment from\s+(.+)$/i);
  if (from) {
    // Drop trailing docket / document / FR-doc identifiers
    const parts = from[1].split(/,\s*/).filter(p => !/^[A-Z]{2,}[-A-Z]*-\d{4}-\d{3,}/.test(p) && !/^\d{4}-\d{4,}$/.test(p));
    if (!parts.length) return null;
    // "Last, First" -> "First Last" when the second part is a single word
    if (parts.length === 2 && !/\s/.test(parts[1]) && !/\s/.test(parts[0])) t = `${parts[1]} ${parts[0]}`;
    else t = parts.join(", ");
  }
  // Not a name: boilerplate with a prefix ("Photo Comment on ..."), staff notes, or a subject line
  if (/\bcomment on\b|\b[A-Z]{2,}-\d{4}-\d{4}|document created by|incoming-\d|\b(comments?|rule|letter|concerns?|proposed|regarding|re:|fee schedule|modifier)\b/i.test(t)) return null;
  t = t.replace(/\s*-+\s*(contains pii|pii|duplicate|no attachment|inappropriate language|prejudice language|language)\s*$/i, "").trim();
  if (!t || isAnonymousName(t) || t.length > 120) return null;
  return t;
}

// The name to show: organization, else the person, else a name from the title, else "Anonymous"
export function submitterName(attrs: any): string {
  return clean(attrs?.organization) || personName(attrs) || titleSubmitter(attrs?.title) || "Anonymous";
}

// The agency's title with its internal flags removed ("Comment on X--Contains PII" -> "Comment on X")
export function cleanTitle(title: unknown): string {
  return clean(title).replace(/\s*-+\s*(contains pii|pii|duplicate|no attachment|inappropriate language|prejudice language|language)\s*$/i, "").replace(/-+$/, "");
}

// US state and territory names -> postal codes; other values are kept as entered
const STATES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT",
  delaware: "DE", "district of columbia": "DC", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL",
  indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT",
  nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA",
  "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT",
  vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
  "puerto rico": "PR", guam: "GU", "virgin islands": "VI", "american samoa": "AS", "northern mariana islands": "MP",
};
const STATE_CODES = new Set(Object.values(STATES));
export function normalizeState(v: unknown): string | null {
  const s = clean(v);
  if (!s) return null;
  if (STATE_CODES.has(s.toUpperCase()) && s.length === 2) return s.toUpperCase();
  return STATES[s.toLowerCase()] || s;
}
export function normalizeCountry(v: unknown): string | null {
  const s = clean(v);
  if (!s) return null;
  return /^(us|usa|u\.s\.a?\.?|united states of america)$/i.test(s) ? "United States" : s;
}

// The commenter types classify-submitters assigns (the same for every docket). Individuals first.
export const SUBMITTER_TYPES = [
  { key: "patient_family", group: "individual", label: "Patient, family or caregiver" },
  { key: "physician", group: "individual", label: "Physician" },
  { key: "other_clinician", group: "individual", label: "Other clinician" },
  { key: "other_professional", group: "individual", label: "Health care or industry worker" },
  { key: "other_individual", group: "individual", label: "Other individual" },
  { key: "practice", group: "organization", label: "Practice, clinic or care provider" },
  { key: "hospital", group: "organization", label: "Hospital or health system" },
  { key: "association", group: "organization", label: "Professional or trade association" },
  { key: "payer", group: "organization", label: "Health plan or payer" },
  { key: "health_it", group: "organization", label: "Health IT or technology company" },
  { key: "manufacturer", group: "organization", label: "Drug, device or other manufacturer" },
  { key: "advocacy", group: "organization", label: "Patient or consumer advocacy group" },
  { key: "government", group: "organization", label: "Government or public official" },
  { key: "academic", group: "organization", label: "Academic or research institution" },
  { key: "other_org", group: "organization", label: "Other organization" },
] as const;
export type SubmitterTypeKey = typeof SUBMITTER_TYPES[number]["key"];
export const SUBMITTER_TYPE_BY_KEY = new Map(SUBMITTER_TYPES.map(t => [t.key as string, t]));

// classify-submitters results by comment ID; empty when the step has not run (older databases)
export interface SubmitterClassification { speaksFor: "individual" | "organization"; type: string; organization: string | null; method: string; }
export function loadClassifications(db: any): Map<string, SubmitterClassification> {
  const out = new Map<string, SubmitterClassification>();
  if (!db.prepare(`SELECT 1 FROM pragma_table_list WHERE type = 'table' AND name = 'submitter_classifications'`).get()) return out;
  for (const r of db.prepare(`SELECT comment_id, speaks_for, type, organization, method FROM submitter_classifications`).all() as any[]) {
    if (!SUBMITTER_TYPE_BY_KEY.has(r.type)) continue;
    out.set(r.comment_id, { speaksFor: r.speaks_for, type: r.type, organization: r.organization || null, method: r.method });
  }
  return out;
}

// Everything the site shows about a submitter, from one source: with classify-submitters results for
// the docket (`classified`), the commenter type and organization are the AI-assigned ones; without
// them, the type is the folded category the submitter chose. Name and location are always as filed.
export interface SubmitterView {
  name: string; nameFromTitle: boolean; filedAs: FiledAs;
  category: string; categoryRaw: string | null;
  type: string; typeKey: string | null; typeGroup: "individual" | "organization" | null; organization: string | null;
  city: string | null; state: string | null; country: string | null;
}
export function submitterView(attrs: any, classification: SubmitterClassification | undefined, classified: boolean): SubmitterView {
  const org = clean(attrs?.organization), person = personName(attrs);
  const fromTitle = !org && !person ? titleSubmitter(attrs?.title) : null;
  const category = foldCategory(attrs?.category);
  const def = classification ? SUBMITTER_TYPE_BY_KEY.get(classification.type) : undefined;
  return {
    name: org || person || fromTitle || "Anonymous", nameFromTitle: !!fromTitle, filedAs: filedAs(attrs),
    category, categoryRaw: clean(attrs?.category) || null,
    type: classified ? (def?.label ?? NOT_SPECIFIED) : category,
    typeKey: classified ? (def?.key ?? null) : null,
    typeGroup: classified && def ? def.group : null,
    organization: classified && def?.group === "organization" ? classification!.organization : null,
    city: clean(attrs?.city) || null, state: normalizeState(attrs?.stateProvinceRegion), country: normalizeCountry(attrs?.country),
  };
}
