// Theme reports (theme_summaries.structured_sections, written by summarize-themes) as readable
// markdown and as flat rows, for the downloadable analysis databases. Tolerates the older report
// shapes in previously published databases: any field may be missing, a string, or an array.

export interface ReportItem {
  section: string;        // consensus | debate | debate_position | stakeholder | recommendation | concern | insight | pattern | quotation | analytical_note
  heading: string | null; // topic, position label, stakeholder type, approach or concern name
  text: string;
  supportLevel: string | null;
  commentIds: string[];
}

const asArray = (v: any): any[] => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]);
const str = (v: any): string => (v == null ? "" : typeof v === "string" ? v.trim() : typeof v === "object" ? flatten(v) : String(v));
const ids = (v: any): string[] => asArray(v).filter((x) => typeof x === "string" && x.trim()).map((x: string) => x.trim());

// Any leftover object as "key: value" lines
function flatten(o: any): string {
  if (Array.isArray(o)) return o.map(str).filter(Boolean).join("; ");
  return Object.entries(o)
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `${humanize(k)}: ${str(v)}`)
    .join("; ");
}
const humanize = (k: string) => k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

export function reportItems(sections: any): ReportItem[] {
  const out: ReportItem[] = [];
  const push = (section: string, heading: any, text: any, supportLevel: any, commentIds: any) => {
    const t = str(text);
    if (!t && !str(heading)) return;
    out.push({ section, heading: str(heading) || null, text: t, supportLevel: str(supportLevel) || null, commentIds: ids(commentIds) });
  };
  for (const c of asArray(sections?.consensusPoints)) {
    if (typeof c === "string") { push("consensus", null, c, null, null); continue; }
    const exc = c.exceptions ? (typeof c.exceptions === "string" ? c.exceptions : str(c.exceptions.text)) : "";
    push("consensus", null, exc ? `${str(c.text)}\nExceptions: ${exc}` : c.text, c.supportLevel, [...ids(c.commentIds), ...ids(c.exceptions?.commentIds)]);
  }
  for (const d of asArray(sections?.areasOfDebate)) {
    if (typeof d === "string") { push("debate", null, d, null, null); continue; }
    push("debate", d.topic, d.description, null, null);
    for (const p of asArray(d.positions)) {
      if (typeof p === "string") { push("debate_position", d.topic, p, null, null); continue; }
      const args = asArray(p.keyArguments).map(str).filter(Boolean);
      const text = [str(p.stance), ...args.map((a) => `- ${a}`)].filter(Boolean).join("\n");
      push("debate_position", [str(d.topic), str(p.label)].filter(Boolean).join(" — "), text, p.supportLevel, p.commentIds);
    }
  }
  for (const s of asArray(sections?.stakeholderPerspectives)) {
    if (typeof s === "string") { push("stakeholder", null, s, null, null); continue; }
    const points = asArray(s.specificPoints).map(str).filter(Boolean);
    push("stakeholder", s.stakeholderType, [str(s.primaryConcerns), ...points.map((p) => `- ${p}`)].filter(Boolean).join("\n"), null, s.commentIds);
  }
  for (const r of asArray(sections?.keyRecommendations)) {
    if (typeof r === "string") { push("recommendation", null, r, null, null); continue; }
    push("recommendation", r.approach, r.recommendation, r.supportLevel, r.commentIds);
  }
  for (const c of asArray(sections?.majorConcerns)) {
    if (typeof c === "string") { push("concern", null, c, null, null); continue; }
    const text = [str(c.evidence), c.raisedBy ? `Raised by: ${str(c.raisedBy)}` : ""].filter(Boolean).join("\n");
    push("concern", c.concern, text, null, c.commentIds);
  }
  for (const i of asArray(sections?.noteworthyInsights)) {
    if (typeof i === "string") { push("insight", null, i, null, null); continue; }
    push("insight", null, i.insight, null, i.commentIds ?? i.commentId);
  }
  for (const p of asArray(sections?.emergingPatterns)) {
    if (typeof p === "string") { push("pattern", null, p, null, null); continue; }
    push("pattern", null, p.pattern, null, p.commentIds ?? p.commentId);
  }
  for (const q of asArray(sections?.keyQuotations)) {
    if (typeof q === "string") { push("quotation", null, q, null, null); continue; }
    push("quotation", q.sourceType, q.quote, null, q.commentIds ?? q.commentId);
  }
  const notes = sections?.analyticalNotes;
  if (notes && typeof notes === "object" && !Array.isArray(notes)) {
    for (const [k, v] of Object.entries(notes)) {
      if (v == null || v === "") continue;
      const text = typeof v === "object" && !Array.isArray(v) ? [str((v as any).level), str((v as any).explanation)].filter(Boolean).join(": ") || str(v) : str(v);
      push("analytical_note", humanize(k), text, null, null);
    }
  } else if (notes) {
    push("analytical_note", null, notes, null, null);
  }
  return out;
}

const SECTION_TITLES: Array<[string, string]> = [
  ["consensus", "Points of consensus"],
  ["debate", "Areas of debate"],
  ["stakeholder", "Stakeholder perspectives"],
  ["recommendation", "Key recommendations"],
  ["concern", "Major concerns"],
  ["insight", "Noteworthy insights"],
  ["pattern", "Emerging patterns"],
  ["quotation", "Key quotations"],
  ["analytical_note", "Analytical notes"],
];

const MAX_CITED = 12;

// `nameOf` turns a comment ID into "ID (Submitter)" so a reader can tell who said what
export function reportMarkdown(opts: {
  code: string;
  label: string;
  sections: any;
  submissions: number | null;
  units: number | null;
  subThemes?: Array<{ code: string; label: string }>;
  nameOf: (id: string) => string | null;
}): string {
  const { sections } = opts;
  const lines: string[] = [];
  const cite = (list: string[]) => {
    if (!list.length) return "";
    const shown = list.slice(0, MAX_CITED).map((id) => { const n = opts.nameOf(id); return n ? `${id} (${n})` : id; });
    return ` [${shown.join("; ")}${list.length > MAX_CITED ? `; and ${list.length - MAX_CITED} more` : ""}]`;
  };
  const isGroup = sections?.reportType === "group";
  lines.push(`# ${opts.code} ${opts.label}`, "");
  const scope = [
    isGroup ? "Group report synthesized from its sub-theme reports and direct extracts" : "Theme report",
    opts.submissions != null ? `${opts.submissions.toLocaleString("en-US")} submissions` : "",
    opts.units != null ? `${opts.units.toLocaleString("en-US")} distinct units` : "",
  ].filter(Boolean).join(" · ");
  lines.push(`*${scope}. LLM-generated synthesis of extracted comment content; verify against the comments.*`, "");
  if (isGroup && opts.subThemes?.length) {
    lines.push(`Sub-themes: ${opts.subThemes.map((s) => `${s.code} ${s.label}`).join("; ")}`, "");
  }
  const exec = str(sections?.executiveSummary);
  if (exec) lines.push("## Executive summary", "", exec, "");

  const items = reportItems(sections);
  for (const [key, title] of SECTION_TITLES) {
    if (key === "debate") {
      const topics = asArray(sections?.areasOfDebate);
      if (!topics.length) continue;
      lines.push(`## ${title}`, "");
      for (const t of topics) {
        if (typeof t === "string") { lines.push(`- ${t}`, ""); continue; }
        lines.push(`### ${str(t.topic) || "Debate"}`, "");
        if (str(t.description)) lines.push(str(t.description), "");
        for (const p of asArray(t.positions)) {
          if (typeof p === "string") { lines.push(`- ${p}`); continue; }
          lines.push(`- **${str(p.label) || "Position"}**${str(p.supportLevel) ? ` (${str(p.supportLevel)})` : ""}: ${str(p.stance)}${cite(ids(p.commentIds))}`);
          for (const a of asArray(p.keyArguments).map(str).filter(Boolean)) lines.push(`  - ${a}`);
        }
        lines.push("");
      }
      continue;
    }
    const list = items.filter((i) => i.section === key);
    if (!list.length) continue;
    lines.push(`## ${title}`, "");
    for (const i of list) {
      if (key === "quotation") {
        lines.push(`> "${i.text}"`, `> — ${[i.heading, ...i.commentIds.map((id) => { const n = opts.nameOf(id); return n ? `${id} (${n})` : id; })].filter(Boolean).join(", ")}`, "");
        continue;
      }
      if (key === "stakeholder" || key === "concern") {
        lines.push(`### ${i.heading || "—"}`, "", `${i.text}${cite(i.commentIds)}`, "");
        continue;
      }
      const head = i.heading ? `**${i.heading}**: ` : "";
      const support = i.supportLevel ? ` (${i.supportLevel})` : "";
      const [first, ...rest] = i.text.split("\n");
      lines.push(`- ${head}${first}${support}${cite(i.commentIds)}`);
      for (const r of rest) lines.push(`  ${r}`);
    }
    lines.push("");
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
