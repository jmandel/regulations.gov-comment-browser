// Worked example analyses for the downloadable databases' _readme / README.md. Each is real,
// copy-pasteable SQL filled in with values from this docket (its largest theme, a characteristic
// search phrase, an organization that commented), so it runs and returns rows as written.

export interface ExampleParams {
  topTheme: string;      // top-level theme with the most submissions
  topThemeLabel: string;
  subTheme: string;      // its largest sub-theme (or the theme itself)
  subThemeLabel: string;
  match: string;         // FTS5 MATCH expression for a characteristic topic, e.g. '"modifier 25" OR "25 modifier"'
  matchLabel: string;    // what it searches for, in words
  pivotThemes: string[]; // top-level theme codes for the stakeholder matrix columns
  organization: string | null; // an organization with a substantial comment
}

export interface Example {
  title: string;
  question: string;
  sql: string;       // runs on both databases unless fullOnly
  read: string;      // how to read the result
  fullOnly?: boolean;
  slimSql?: string;  // slim-database variant of a fullOnly example
  slimRead?: string; // how to read the slim variant
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

// Units under a top-level theme, counted once per (top-level theme, unit)
const TOP_UNITS = `SELECT DISTINCT substr(theme_code, 1, instr(theme_code || '.', '.') - 1) AS top, unit_id FROM unit_themes`;

export function exampleAnalyses(p: ExampleParams): Example[] {
  const T = lit(p.topTheme), S = lit(p.subTheme), Q = lit(p.match);
  const inTop = (col: string) => `(${col} = ${T} OR ${col} LIKE ${lit(p.topTheme + ".%")})`;
  const ex: Example[] = [];

  ex.push({
    title: "Issues ranked by people vs. by distinct arguments",
    question: "Which issue areas drew the most submissions, and which are amplified by form letters and campaigns?",
    sql: `
SELECT code, label, submissions, units,
       ROUND(1.0 * submissions / units, 1) AS submissions_per_unit,
       RANK() OVER (ORDER BY submissions DESC) AS rank_by_people,
       RANK() OVER (ORDER BY units DESC) AS rank_by_content
FROM themes
WHERE parent_code IS NULL AND units > 0
ORDER BY submissions DESC`,
    read: "`submissions` counts people; `units` counts distinct texts. A high `submissions_per_unit`, or a much better rank by people than by content, means the issue was carried by repeated letters rather than many independent arguments.",
  });

  ex.push({
    title: `Find every comment discussing ${p.matchLabel}`,
    question: `Who discussed ${p.matchLabel}, in what words, and how many people does each text stand for?`,
    fullOnly: true,
    sql: `
SELECT u.id, s.submitter_name, s.category_group, u.submissions, u.text_source,
       snippet(units_text_fts, 0, '«', '»', ' … ', 16) AS context
FROM units_text_fts
JOIN units u ON u.unit_no = units_text_fts.rowid
JOIN submissions s ON s.id = u.id
WHERE units_text_fts MATCH ${Q}
ORDER BY bm25(units_text_fts)
LIMIT 25`,
    slimSql: `
SELECT u.id, s.submitter_name, s.category_group, u.submissions,
       highlight(summaries_fts, 2, '«', '»') AS core_position
FROM summaries_fts
JOIN units u ON u.unit_no = summaries_fts.rowid
JOIN submissions s ON s.id = u.id
WHERE summaries_fts MATCH ${Q}
ORDER BY bm25(summaries_fts)
LIMIT 25`,
    read: "Rows are ranked by relevance (bm25: lower is better). `context` shows the match in the commenter's text; check `text_source` ('typed' = their own words, 'llm_transcript' = transcription of an attachment). The slim variant searches the LLM summaries instead.",
    slimRead: "Rows are ranked by relevance (bm25: lower is better). This searches the LLM-written summaries (all seven summary columns; `core_position` is shown with matches marked), so it finds comments whose summary mentions the topic; the full database searches the complete comment text.",
  });

  ex.push({
    title: `Quotes for a briefing on "${p.topThemeLabel}"`,
    question: "What did organizations say, in their own words, on the biggest issue — and is each quote really in their text?",
    fullOnly: true,
    sql: `
SELECT s.organization, s.category_group, e.submissions, e.text AS quote,
       instr(u.text, e.text) > 0 AS verbatim_in_text
FROM extract_items e
JOIN submissions s ON s.id = e.unit_id
JOIN units u ON u.id = e.unit_id
WHERE e.kind = 'quote' AND ${inTop("e.theme_code")}
  AND s.organization IS NOT NULL
ORDER BY e.submissions DESC, length(e.text) DESC
LIMIT 15`,
    slimSql: `
SELECT s.organization, s.category_group, e.submissions, e.text AS quote
FROM extract_items e JOIN submissions s ON s.id = e.unit_id
WHERE e.kind = 'quote' AND ${inTop("e.theme_code")} AND s.organization IS NOT NULL
ORDER BY e.submissions DESC, length(e.text) DESC
LIMIT 15`,
    slimRead: "Quotes were picked by the LLM and are meant to be verbatim; the full database adds a `verbatim_in_text` check against the comment text. Verify before quoting.",
    read: "Quotes were picked by the LLM. `verbatim_in_text = 1` confirms the exact string occurs in the comment; 0 usually means small differences (punctuation, an elision) — look it up in `units.text` before quoting it.",
  });

  ex.push({
    title: `Recommendations inventory: "${p.subThemeLabel}"`,
    question: "What specific changes did commenters ask for on this issue, and how many people back each?",
    sql: `
SELECT MIN(e.text) AS recommendation,
       COUNT(DISTINCT e.unit_id) AS units,
       SUM(e.submissions) AS submissions
FROM extract_items e
WHERE e.kind = 'recommendation' AND e.theme_code = ${S}
GROUP BY lower(substr(e.text, 1, 40))
ORDER BY submissions DESC, units DESC
LIMIT 20`,
    read: "Grouping on the first 40 characters merges only near-identical wording (typically one campaign's letters); paraphrases stay separate. For a true deduplicated list, pull the rows and cluster them yourself. `submissions` weights each by the people it stands for.",
  });

  ex.push({
    title: "Campaign vs. independent voices on each issue",
    question: "For each issue area, what share of the people discussing it came through organized campaigns?",
    sql: `
WITH tu AS (${TOP_UNITS})
SELECT t.code, t.label, COUNT(*) AS submissions,
       ROUND(100.0 * SUM(s.campaign_how = 'exact') / COUNT(*)) AS pct_campaign_copies,
       ROUND(100.0 * SUM(s.campaign_how = 'paraphrase') / COUNT(*)) AS pct_campaign_reworded,
       ROUND(100.0 * SUM(s.campaign_id IS NULL AND s.has_attachments = 0) / COUNT(*)) AS pct_individual_typed,
       ROUND(100.0 * SUM(s.campaign_id IS NULL AND s.has_attachments = 1) / COUNT(*)) AS pct_attached_letters
FROM tu
JOIN submissions s ON s.unit_id = tu.unit_id
JOIN themes t ON t.code = tu.top
GROUP BY t.code
ORDER BY submissions DESC`,
    read: "Each submission counts once per issue area it touches. Campaign tags are automatic (precision ~73–88%); with no campaign tagging, the two campaign columns are 0 and `units.kind = 'form_letter'` is the next best signal of copying.",
  });

  const pivot = p.pivotThemes.map(c => `       SUM(top = ${lit(c)}) AS "${c}"`).join(",\n");
  ex.push({
    title: "Stakeholder matrix: who raised which issues",
    question: "How do submitter categories spread across the main issue areas?",
    sql: `
WITH tu AS (${TOP_UNITS}),
     st AS (SELECT DISTINCT s.id, s.category_group, tu.top
            FROM tu JOIN submissions s ON s.unit_id = tu.unit_id)
SELECT category_group,
       COUNT(DISTINCT id) AS submissions${pivot ? `,\n${pivot}` : ""}
FROM st
GROUP BY category_group
ORDER BY submissions DESC
LIMIT 15`,
    read: "Columns are top-level theme codes (see `themes.label`); each cell counts submissions in that category whose content touches the theme, so a row's cells can sum to more than `submissions`. `category_group` is the regulations.gov category, normalized.",
  });

  ex.push({
    title: "Timeline and late surges",
    question: "When did comments arrive, and which campaigns surged near the deadline?",
    sql: `
SELECT substr(received_date, 1, 10) AS day,
       COUNT(*) AS submissions,
       SUM(campaign_id IS NOT NULL) AS from_campaigns
FROM submissions
WHERE received_date IS NOT NULL
GROUP BY day
ORDER BY day;

WITH d AS (SELECT COALESCE(comment_end, (SELECT MAX(received_date) FROM submissions)) AS close FROM docket)
SELECT c.id, c.name, COUNT(*) AS submissions,
       SUM(s.received_date >= date(d.close, '-7 days')) AS in_last_week,
       ROUND(100.0 * SUM(s.received_date >= date(d.close, '-7 days')) / COUNT(*)) AS pct_last_week
FROM submissions s JOIN campaigns c ON c.id = s.campaign_id, d
GROUP BY c.id
HAVING COUNT(*) >= 5
ORDER BY pct_last_week DESC, submissions DESC
LIMIT 10`,
    read: "The first query is a daily series (received date). The second lists campaigns by the share of their letters that arrived in the final week of the comment period; it returns nothing when campaigns weren't tagged.",
  });

  ex.push({
    title: "Disagreement finder",
    question: "Which themes have commenters explicitly on both sides, and what does each side say?",
    sql: `
WITH pro AS (SELECT rowid AS id FROM extract_items_fts
             WHERE extract_items_fts MATCH 'support OR endorse OR applaud OR welcome OR commend'),
     con AS (SELECT rowid AS id FROM extract_items_fts
             WHERE extract_items_fts MATCH 'oppos* OR reject OR withdraw OR rescind OR "not finalize" OR halt OR reverse')
SELECT e.theme_code, t.label,
       COUNT(DISTINCT CASE WHEN e.id IN pro AND e.id NOT IN con THEN e.unit_id END) AS units_for,
       COUNT(DISTINCT CASE WHEN e.id IN con AND e.id NOT IN pro THEN e.unit_id END) AS units_against,
       SUM(CASE WHEN e.id IN pro AND e.id NOT IN con THEN e.submissions ELSE 0 END) AS people_for,
       SUM(CASE WHEN e.id IN con AND e.id NOT IN pro THEN e.submissions ELSE 0 END) AS people_against
FROM extract_items e JOIN themes t ON t.code = e.theme_code
WHERE e.kind = 'position'
GROUP BY e.theme_code
HAVING units_for >= 2 AND units_against >= 2
ORDER BY MIN(units_for, units_against) DESC
LIMIT 10;

SELECT side, submitter_name, submissions, text FROM (
  SELECT 'for' AS side, s.submitter_name, e.submissions, e.text,
         ROW_NUMBER() OVER (ORDER BY e.submissions DESC, e.id) AS n
  FROM extract_items e JOIN submissions s ON s.id = e.unit_id
  WHERE e.kind = 'position' AND e.theme_code = ${S}
    AND e.id IN (SELECT rowid FROM extract_items_fts WHERE extract_items_fts MATCH 'support OR endorse OR applaud OR welcome')
  UNION ALL
  SELECT 'against', s.submitter_name, e.submissions, e.text,
         ROW_NUMBER() OVER (ORDER BY e.submissions DESC, e.id)
  FROM extract_items e JOIN submissions s ON s.id = e.unit_id
  WHERE e.kind = 'position' AND e.theme_code = ${S}
    AND e.id IN (SELECT rowid FROM extract_items_fts WHERE extract_items_fts MATCH 'oppos* OR reject OR withdraw OR rescind')
) WHERE n <= 4`,
    read: "A keyword heuristic over the LLM-extracted positions: \"supports X\" and \"opposes Y\" can be about different proposals within one theme, and \"does not support\" lands on the 'for' side. Use it to find candidate debates, then read the positions (second query) — and `theme_report_items WHERE section LIKE 'debate%'` for the LLM's own account.",
  });

  ex.push({
    title: "From a report's claim to the evidence",
    question: "A theme report asserts a consensus point (or a major concern) — which comments does it cite, and what did they actually say?",
    sql: `
WITH claim AS (SELECT theme_code, section, text, comment_ids FROM theme_report_items
               WHERE ${inTop("theme_code")} AND section IN ('consensus', 'concern') AND comment_ids IS NOT NULL
               ORDER BY section = 'consensus' DESC, theme_code = ${T} DESC, theme_code, ord LIMIT 1),
     cited AS (SELECT DISTINCT j.value AS unit_id FROM claim, json_each(claim.comment_ids) j)
SELECT (SELECT theme_code || ' ' || section || ': ' || text FROM claim) AS claim, c.unit_id, s.submitter_name, u.submissions,
       e.theme_code, e.kind, e.text
FROM cited c
JOIN submissions s ON s.id = c.unit_id
JOIN units u ON u.id = c.unit_id
LEFT JOIN extract_items e ON e.unit_id = c.unit_id AND ${inTop("e.theme_code")} AND e.kind IN ('position', 'concern')
ORDER BY c.unit_id, e.theme_code, e.kind, e.ord`,
    read: "The report's `comment_ids` (a JSON array) are the units the LLM cited; reports cite examples, not every supporter. If a cited unit shows no matching extract, read its `text` (full database) — and treat unsupported claims with suspicion.",
  });

  if (p.organization) {
    const O = lit(p.organization);
    ex.push({
      title: `One organization's submission, end to end: ${p.organization}`,
      question: "What exactly did a given organization submit, and what did the analysis extract from it?",
      sql: `
SELECT s.id, s.received_date, s.category_group, u.kind, u.submissions, u.word_count, u.one_line_summary,
       (SELECT COUNT(*) FROM attachments a WHERE a.submission_id = s.id) AS files
FROM submissions s JOIN units u ON u.id = s.unit_id
WHERE s.organization = ${O};

SELECT e.theme_code, t.label, e.kind, e.text
FROM extract_items e JOIN themes t ON t.code = e.theme_code
WHERE e.unit_id IN (SELECT unit_id FROM submissions WHERE organization = ${O})
ORDER BY e.theme_code, e.kind, e.ord;

-- Full database: the whole text (and the original typed box)
-- SELECT u.text_source, u.text FROM units u WHERE u.id IN (SELECT unit_id FROM submissions WHERE organization = ${O});`,
      read: "Use `organization LIKE '%name%'` for partial names (spellings vary). The extracts list every point filed under each theme; `attachments` has the original file URLs on regulations.gov.",
    });
  }
  return ex;
}

export const ANALYSIS_TIPS = [
  "**Weighting.** `submissions` counts people; `units` counts distinct texts. Sum `extract_items.submissions` (or `units.submissions`) to count people behind a point; `COUNT(DISTINCT unit_id)` to count independent arguments. Report both when campaigns are large.",
  "**A form-letter member's text** is its unit's text plus its own additions: `SELECT u.text, s.added_text FROM submissions s JOIN units u ON u.id = s.unit_id WHERE s.id = '…'` (full database). `added_words > 0` finds members who personalized the letter.",
  "**Top-level rollups.** Content is filed under the most specific theme; for theme 3 use `theme_code = '3' OR theme_code LIKE '3.%'`, and count DISTINCT units or submissions so a unit with several sub-themes counts once.",
  "**FTS syntax.** Quote phrases (`'\"site neutral\"'` — hyphens split words, so \"site-neutral\" matches as a phrase); bare words are ANDed; use `OR`, `NEAR(a b, 10)`, and prefixes (`telehealt*`). Porter stemming is on, so `cuts` matches `cut`. Order by `bm25(<table>)`; `snippet()` and `highlight()` show matches. Numbers and codes are tokens (`'\"modifier 25\"'`, `G2211`).",
  "**Check LLM output.** Summaries, extracts, reports, campaign tags and triage labels are model output. For any claim that matters, read the unit's `text` (and `typed_text`, the commenter's own words) or the regulations.gov page (`submissions.regulations_gov_url`).",
];
