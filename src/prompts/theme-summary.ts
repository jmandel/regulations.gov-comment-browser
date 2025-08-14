export const THEME_SUMMARY_PROMPT = `# Theme Analysis Instructions

You will analyze public comments that address a specific theme. Your task is to create a comprehensive overview that captures areas of consensus, debate, and noteworthy insights while maintaining the authentic voices of commenters.

CRITICAL: Themes are organized by ISSUE AREA, not by stance. You should expect to find BOTH supportive and critical viewpoints within this theme. Be highly skeptical if all comments seem to agree - you're likely missing important dissenting voices. Look for the debates and tensions within the issue area.

## Theme Being Analyzed
{THEME_CODE}: {THEME_DESCRIPTION}

You *must* restrict your analysis to this theme. Remember that this theme is about an issue area, not a position, so capture all perspectives on this issue.

## Important: Comment ID Format
Comment IDs in the input are provided as attributes in comment tags: <comment id="CMS-ABC">. When referencing comments in your analysis, use the full ID.

## Important: Mention commenters and Comment IDs in consistent format
Commenter Name (Comment ID) -- this is a good reliable way to refer

## Output Structure

You MUST organize your analysis into these exact sections with these exact headers:

### CONSENSUS POINTS
[If no clear consensus exists, write "No clear consensus points identified"]
- [Each point where commenters broadly agree, regardless of their overall position]
- [Include the approximate proportion who agree, e.g., "Nearly all commenters agree..." or "A strong majority believe..."]
  - [Supporting evidence or common reasoning, mentioning specific organizations or stakeholders when notable]
  - [Notable exceptions if any, with key stakeholders and comment IDs where specific counter-examples are cited]

### AREAS OF DEBATE
[Most themes should have debates. If you find unanimous agreement, you're likely missing dissenting voices. Look harder for disagreements about implementation details, scope, timing, or specific provisions even if there's broad agreement on general principles.]
- **[Debate Topic]:** [Brief description of the disagreement]
  - **[Brief label for Position]:** [First perspective with approximate support level, noting key organizations/stakeholders who hold this view]
    - [Key arguments or evidence, referencing specific comment IDs for particularly articulate examples]
  - **[Brief label for Position]:** [Opposing perspective with approximate support level, noting key organizations/stakeholders who hold this view]
    - [Key arguments or evidence, referencing specific comment IDs for particularly articulate examples]

### STAKEHOLDER PERSPECTIVES
[Group commenters by their type/role and summarize their distinct viewpoints]
- **[Stakeholder Type]:** [Their primary concerns and positions]
  - [Specific points unique to this group, with stakeholder and comment IDs for exemplary statements]
  - [How their experience shapes their view]

### NOTEWORTHY INSIGHTS
[Unique, surprising, or particularly well-articulated points that illuminate the issue -- be sure to identify the comment ID and name associated with the insight]
- [Unexpected consequences or connections raised by commenters]
- [Creative solutions or alternatives proposed]
- [Compelling personal experiences that illustrate broader issues]
- [Data points or evidence that challenge assumptions]
- [Particularly eloquent articulations of complex issues]

### EMERGING PATTERNS
[Patterns or trends that become visible across multiple comments-- be sure to identify key comment IDs and commenter types associated with the insight]
- [Geographic variations in perspectives, with example comment IDs showing regional differences]
- [Correlations between commenter types and positions, citing specific examples]
- [Recurring concerns that may not be explicitly connected by commenters, with representative comment IDs]
- [Gaps or blind spots - what's NOT being discussed?]

### KEY QUOTATIONS
[Extract 3-5 verbatim quotes that powerfully capture different aspects of the debate]
- "[Quote that crystallizes the main concern]" - [Commenter Type/Organization, Comment ID]
- "[Quote that offers unique insight]" - [Commenter Type/Organization, Comment ID]
- "[Quote that humanizes the policy impact]" - [Commenter Type/Organization, Comment ID]

### ANALYTICAL NOTES
[Your observations about the quality and nature of the discourse]
- **Discourse Quality:** [Professional/Emotional/Mixed, with explanation]
- **Evidence Base:** [Well-supported/Anecdotal/Mixed, with explanation]
- **Representation Gaps:** [Which voices might be missing from this discussion?]
- **Complexity Level:** [How nuanced are the arguments being made?]

### EXECUTIVE SUMMARY
[A 2-3 sentence overview capturing the essence of public sentiment on this theme - what's the big picture?]


## Analysis Guidelines

**Maintain Objectivity:**
- Present all significant viewpoints fairly
- Use neutral language when describing positions
- Let commenters' own words carry emotional weight
- Distinguish between majority and minority views clearly

**Preserve Authenticity:**
- Keep the genuine tone and concerns of commenters
- Use direct quotes to let voices shine through
- Don't sanitize passionate or frustrated language in quotes
- Maintain the human element of the comments

**Focus on Substance:**
- Prioritize substantive policy arguments over process complaints
- Extract concrete examples and specific evidence
- Identify cause-and-effect relationships described by commenters
- Surface unintended consequences mentioned

**Identify Patterns:**
- Look for recurring themes across different commenter types
- Note when similar concerns use different language
- Identify proxy debates (surface issue vs. underlying concern)
- Recognize when commenters talk past each other

**Quality over Quantity:**
- Better to have fewer, well-supported points than many weak ones
- Combine similar points rather than listing repetitively
- Focus on the most significant and well-articulated arguments

---

Here are the structured comment sections addressing this theme:

{COMMENTS}

---

REMINDER: Limit analysis to {THEME_CODE}: {THEME_DESCRIPTION}

`;

export const THEME_SUMMARY_MERGE_NWAY_PROMPT = `You have multiple theme summary analyses from different batches of comments. Create a unified, comprehensive analysis that preserves the shape and insights without being redundant. 

Follow instructuions from the original summary prompt to guide your abstraction.
<originalPrompt>
{ORIGINAL_PROMPT}
</originalPrompt>

DO NOT mention batches or summaries in your ouptut! Your output should look like the inputs.

When merging:
- Combine points in each section, while streamlining to avoid redundancy and organizing as neeed
- Keep all unique noteworthy insights and quotations
- Update analytical notes to reflect the full dataset
- Preserve representative or key comment IDs!

{SUMMARIES}

Output the complete merged theme analysis.`;

export const THEME_SUMMARY_STRUCTURE_PROMPT = `Convert the theme analysis text into a structured JSON format. The input follows a specific markdown format with sections and bullet points.

Your task is to parse this into clean JSON that preserves all information while making it easy to process programmatically.

## Important: Preserve Rich Narratives
Keep stakeholder and organization names naturally embedded within the narrative text fields. This makes the summaries more readable and informative. Only extract comment IDs to separate arrays for database lookups.

## JSON Output Schema

Return a JSON object with this exact structure:

\`\`\`typescript
{
  "executiveSummary": string,
  "consensusPoints": Array<{
    "text": string,  // Narrative, including key stakeholders or types
    "supportLevel": string | null,  // e.g., "Nearly all commenters", "A strong majority"
    "exceptions": {
      "text": string,  // Narrative explaining notable exceptions
      "commentIds": <Array<string>> // coment IDs of notable exceptions
    }
  }> | null,
  "areasOfDebate": Array<{
    "topic": string,
    "description": string,
    "positions": Array<{
      "label": string,  // 2-4 word pithy label for the position
      "stance": string,  // Keep organization/stakeholder names in the narrative
      "supportLevel": string | null,
      "keyArguments": Array<string>,  // Keep names in these narratives
      "commentIds": Array<string> // Extract only comment IDs
    }>, 
  }> | null,
  "stakeholderPerspectives": Array<{
    "stakeholderType": string,
    "primaryConcerns": string,  // Keep specific organization names mentioned
    "specificPoints": Array<string>,  // Narrative points with key organizatio names where relevant
    "commentIds": Array<string>  // Extract only comment IDs
  }> | null,
  "noteworthyInsights": Array<{
    "insight": string,  // Keep narrative insight
    "commentId": string
  }> | null,
  "emergingPatterns": Array<{
    "pattern": string,  // Keep key organization/stakeholder names in the narrative
    "commentIds": Array<string>  // Extract only comment IDs
  }> | null,
  "keyQuotations": Array<{
    "quote": string,
    "sourceType": string | null,  // e.g., "Healthcare Provider", "Business"
    "commentId": string
  }> | null,
  "analyticalNotes": {
    "discourseQuality": {
      "level": string,
      "explanation": string
    },
    "evidenceBase": {
      "level": string,
      "explanation": string
    },
    "representationGaps": string | null,
    "complexityLevel": string | null
  } | null
}
\`\`\`

## Parsing Guidelines

1. **Preserve Rich Narratives**: Keep organization and stakeholder names naturally embedded within the narrative text but omit comment IDs from text. This creates more readable and informative summaries. For example:
   - Good: "Acme Health argues that administrative burden..."
   - Bad: "Acme Health (CMS-123-456) argues that administrative burden..." (comment ID is extracted to searate json field)

2. **Extract Comment IDs**: When comment IDs are mentioned (e.g., "Comment CMS-2025-0050-0031" or "as noted in comment 0042"), extract them into the appropriate commentIds arrays. Use fully prefixed ids, e.g.  "CMS-2025-0050-0031". When extracting comment IDs into dedicated JSON fields, *remove them* from narrative.

3. **Clean Text**: For examle, remove markdown formatting like ** for bold and remove comment IDs from text fields.

4. **Handle Missing Sections**: If a section states "No clear consensus points identified" or similar, return null for that section.

5. **Preserve Quotes**: Keep quotation marks in quoted text, but ensure proper JSON escaping.

6. **Support Levels**: Extract phrases like "Nearly all commenters", "A strong majority", "Supported by a significant minority" into the supportLevel fields.

7. **Source Attribution in Narratives**: When sources are mentioned, keep them in the narrative text for context and readability.

8. **Maintain Structure**: Even if bullet points have sub-bullets, flatten them appropriately into the arrays while preserving the logical relationships.


## Input Theme Analysis:

{THEME_ANALYSIS}

---

## Final notes / remdinders

IMPORTANT: Focus ALL ANALYSIS on the following theme:
{THEME_CODE}: {THEME_DESCRIPTION}. You can ignore any content outside this theme. No other themes are relevant for this specific analysis.

Return only the JSON object, no additional text or explanation.`; 
