export const THEME_EXTRACT_PROMPT = `You are extracting the authentic substance of what a commenter is saying about specific regulatory themes. Your goal is to capture their actual thinking, specific details, and unique perspective - not generic summaries.

## Theme Hierarchy
{THEME_HIERARCHY}

## Comment to Analyze
{COMMENT}

## Your Mission
For each theme, extract EXACTLY what this commenter says about it. Capture their actual arguments, specific examples, unique insights, and emotional tone. If they don't address a theme, mark it as not addressed.

## Output Format
\`\`\`json
{
  "1": { // Theme Code (numbers and dots)
    "relevance": 1,  // 1=substantive discussion, 2=brief mention, 3=not addressed
    "extract": {
      "positions": [
        // Their ACTUAL stance with their ACTUAL reasoning
        // Include numbers, specifics, conditions they mention
        // LEAVE ARRAY EMPTY [] if they express no positions on this theme
      ],
      "concerns": [
        // Their SPECIFIC worries with the DETAILS they provide
        // Include who/what/when/where/why as they describe it
        // LEAVE ARRAY EMPTY [] if they raise no concerns about this theme
      ],
      "recommendations": [
        // Their EXACT suggestions with implementation details
        // Include timelines, methods, conditions they specify
        // LEAVE ARRAY EMPTY [] if they make no recommendations for this theme
      ],
      "experiences": [
        // Their ACTUAL stories, examples, data
        // Include names, places, numbers, outcomes they share
        // LEAVE ARRAY EMPTY [] if they share no relevant experiences
      ],
      "key_quotes": [
        // Powerful verbatim quotes that capture their essence
        // Choose quotes that would make policymakers stop and think
        // LEAVE ARRAY EMPTY [] if there are no compelling quotes for this theme
      ]
    }
  }
}
\`\`\`

## CRITICAL RULES FOR EMPTY SECTIONS:
- If a commenter doesn't address a particular aspect (e.g., no recommendations), leave that array EMPTY []
- NEVER write placeholder text like "No recommendations provided" or "Nothing to extract"
- NEVER write explanatory text like "The commenter did not discuss..."
- An empty array [] is the correct way to indicate no content for that section
- Only include actual content from the comment - if it's not there, leave it empty

## Extraction Principles

**CAPTURE THE GOLD, NOT THE GENERIC**
- ❌ BAD: "Concerned about patient safety"
- ✅ GOOD: "Lost 3 patients last month due to delayed response times when we only had 1 RN covering 40 beds"

**PRESERVE THEIR LOGIC CHAIN**
- ❌ BAD: "Opposes the proposal"  
- ✅ GOOD: "Opposes because mandatory overtime already drives 30% annual turnover at their facility, and this would make it worse by removing flexibility incentives"

**KEEP THEIR EVIDENCE**
- Numbers: "16-hour shifts", "23% increase", "$4.2 million loss"
- Specifics: "rural Idaho", "Level II trauma center", "night shift ICU"
- Comparisons: "unlike California's approach", "worse than 2008 crisis"

**CAPTURE THEIR VOICE**
- If they're angry, show it: "This is insanity - we're already drowning"
- If they're analytical, preserve it: "Based on our 5-year data trending..."
- If they're pleading, keep that: "I'm begging you to understand..."

**EXTRACT THEIR UNIQUE ANGLE**
What does THIS commenter know/see/experience that others might not?
- A nurse's view from the bedside
- An administrator's budget reality
- A patient's family's trauma
- A rural facility's unique challenges

## Theme Assignment Rules

1. **Most Specific Wins**: Content about "nurse staffing ratios" goes under theme 1.1 (if that's staffing), NOT under general theme 1
2. **No Duplication**: Each insight appears under only ONE most relevant theme
3. **Follow the Guidelines**: Use the detailed theme descriptions to determine fit

## Quality Checks
- Would a policymaker learn something SPECIFIC from this extract?
- Could you identify this commenter's unique perspective from the extract?
- Did you capture details that differentiate this from generic feedback?
- Would this extract help identify patterns when aggregated with others?

Remember: You're preserving testimony that will inform critical policy decisions. Every specific detail, compelling story, and unique insight matters.`;

export const THEME_SUMMARY_FROM_EXTRACTS_PROMPT = `You are a policy analyst synthesizing public input on a specific regulatory theme. Your analysis will inform decision-makers about public sentiment, concerns, and recommendations.

## Theme Being Analyzed
{THEME_CODE}: {THEME_DESCRIPTION}

## Your Task
Analyze the theme-specific extracts below to create a comprehensive picture of public sentiment. These extracts contain ONLY content about this specific theme, pre-filtered from full comments.

## Required Analysis Sections

### CONSENSUS POINTS
Identify areas of broad agreement across commenters. For each consensus point:
- State the specific point of agreement
- Quantify support ("Nearly all commenters..." "A strong majority..." "Most stakeholders...")
- Provide 2-3 representative examples with comment IDs
- Note any notable exceptions or caveats

Example:
- **Workforce burnout is at crisis levels** - Nearly all healthcare workers (87 of 92) describe unsustainable working conditions, with many citing 16+ hour shifts and 6-day weeks as standard (ABC-2025-0050-1234, ABC-2025-0050-5678, ABC-2025-0050-9012). Even administrators acknowledge this crisis, though they differ on solutions (ABC-2025-0050-3456, ABC-2025-0050-7890).

### AREAS OF DEBATE
Map the key disagreements, organizing by topic then position:

**[Specific Debate Topic]**
- **[Pithy 1-4 word label]**: [Clear statement of position]
  - Support level: [Quantify who holds this view]
  - Key arguments: [2-3 strongest points made]
  - Representative voices: [Comment IDs with role/perspective noted]
- **[Contrasting 1-4 word label]**: [Opposing position]
  - Support level: [Quantify support]
  - Key arguments: [2-3 strongest counterpoints]
  - Representative voices: [Comment IDs with role/perspective noted]

Example:
**Mandatory Staffing Ratios**
- **Strict Requirements**: Enforce specific nurse-to-patient ratios across all units
  - Support level: 73% of nurses, most patient advocacy groups
  - Key arguments: Patient safety data shows 40% reduction in adverse events; prevents dangerous understaffing during profit-driven cuts
  - Representative voices: Nurse practitioners (DEF-2025-0100-2468), Patient Safety Coalition (DEF-2025-0100-1357)
- **Flexible Guidelines**: Allow facilities to adjust based on acuity and resources
  - Support level: Most administrators, rural hospitals, some physician groups
  - Key arguments: One-size-fits-all ignores unit complexity; rural facilities cannot meet urban standards without closing
  - Representative voices: Rural Hospital Association (DEF-2025-0100-8642), Hospital CFO (DEF-2025-0100-9753)

### STAKEHOLDER PERSPECTIVES
Group insights by commenter type, highlighting their unique concerns:

**[Stakeholder Type]** (N comments)
- Primary concerns: [Top 2-3 issues for this group]
- Unique perspective: [What only this group emphasizes]
- Proposed solutions: [Their preferred approaches]
- Key examples: [Most compelling cases with comment IDs like GHI-2025-0200-12345]

Types typically include: Healthcare Workers, Administrators, Patients/Families, Professional Organizations, Advocacy Groups, etc.

### KEY RECOMMENDATIONS
Organize by approach type, not just list:

**Regulatory/Compliance Approaches**
- [Specific recommendation]: Supported by [X commenters, particularly Y stakeholder type]

**Financial/Incentive Approaches**
- [Specific recommendation]: Proposed by [groups] to address [specific problem]

**Operational/Practice Changes**
- [Specific recommendation]: [Support level and key proponents]

### MAJOR CONCERNS
Prioritize by frequency and severity:

1. **[Most critical concern]**
   - Raised by: [X% of commenters, especially Y groups]
   - Specific risks: [Concrete negative outcomes predicted]
   - Evidence cited: [Data, examples, or experiences referenced]

2. **[Second major concern]**
   - [Same structure]

### NOTEWORTHY INSIGHTS
Highlight unique, well-articulated, or surprising perspectives:
- **[Unexpected connection/insight]** - [Commenter type] in JKL-2025-0300-54321 points out [specific insight and why it matters]
- **[Compelling personal example]** - [Brief description and significance with comment ID like MNO-2025-0400-98765]
- **[Data-backed observation]** - [Specific finding with source and comment ID]

### EMERGING PATTERNS
Identify trends that might not be explicit:
- Geographic variations: [Regional differences in perspectives]
- Facility-type patterns: [How views differ by setting]
- Experience correlations: [How tenure/role affects positions]
- Unintended consequences: [Knock-on effects multiple commenters identify]

### KEY QUOTATIONS
Select AS MANY powerful verbatim quotes as you can identify to capture different aspects of this theme:
- "[Quote that crystallizes the main concern]" - Nurse Practitioner, PQR-2025-0500-11111
- "[Quote that offers unique insight]" - Hospital Administrator, STU-2025-0600-22222
- "[Quote that shows real-world impact]" - Family Caregiver, VWX-2025-0700-33333
- "[Quote that proposes innovative solution]" - Healthcare Consultant, YZA-2025-0800-44444

Choose quotes that:
- Make policymakers stop and think
- Capture authentic emotion or expertise
- Illustrate concrete impacts
- Represent diverse perspectives

### EXECUTIVE SUMMARY
[2-3 sentences capturing the essence: overall sentiment, key tension points, and dominant recommendation thrust]

## Theme-Specific Extracts
{EXTRACTS}

## Analysis Principles
1. **Quantify When Possible**: Use numbers, percentages, ratios ("15 of 23 nurses", "roughly 70% of administrators")
2. **Preserve Authentic Voice**: Use commenters' own powerful phrases in quotes
3. **Show, Don't Tell**: Provide specific examples rather than generic statements
4. **Balance Perspectives**: Give fair weight to minority views if well-articulated
5. **Connect Patterns**: Link related concerns across different stakeholder groups
6. **Highlight Tensions**: Make conflicts and trade-offs explicit
7. **Evidence Hierarchy**: Prioritize data > specific examples > general assertions

Remember: This analysis will help policymakers understand not just WHAT people think, but WHY they think it, WHO thinks what, and HOW STRONGLY they feel about it.`;

export const EXTRACT_MERGE_PROMPT = `You are merging multiple analyses of the same theme into a comprehensive summary. Each analysis covers a different batch of comments.

## Theme Being Merged
{THEME_CODE}: {THEME_DESCRIPTION}

## Analyses to Merge
{EXTRACT_SETS}

## Merging Instructions

### For Consensus Points:
- Combine similar points into single, stronger statements
- Add up support numbers across batches ("45 of 50 in batch 1" + "38 of 40 in batch 2" = "83 of 90 overall")
- Keep the most compelling examples from each batch
- Note if consensus strength varies between batches

### For Areas of Debate:
- Merge debates on the same topic, combining support numbers
- If new positions emerge in different batches, add them
- Preserve the strongest arguments from each side across all batches
- Keep representative comment IDs from multiple batches

### For Stakeholder Perspectives:
- Combine counts for each stakeholder type
- Merge their concerns, keeping unique ones from each batch
- Consolidate similar recommendations
- Preserve diverse examples showing range of experiences

### For Recommendations:
- Group similar recommendations together
- Add up supporter counts across batches
- Note if certain recommendations appear only in specific batches
- Keep the most detailed/specific version of each recommendation

### For Major Concerns:
- Rank by total frequency across all batches
- Combine evidence and examples
- Preserve specific data points and citations
- Note if concern intensity varies between batches

### For Noteworthy Insights:
- Keep ALL UNIQUE INSIGHTS from across batches -- output a long list if needed
- Keep the full attribution (Commenter Type, Comment ID)

### For Patterns:
- Combine pattern observations across batches
- Preserve ALL UNIQUE OR IMPORTANT CONTENT
- Aggregate any quantitative patterns

### For Key Quotations:
- Keep ALL KEY QUOTATONS from across batches -- output a long list if needed
- Keep the full attribution (Commenter Type, Comment ID)

### For Executive Summary:
- Write a NEW summary that encompasses all batches (without mentioning batches)
- Capture the overall sentiment across all comments
- Highlight the most significant findings

## Output Format
Produce a single, comprehensive analysis using the same section structure as the individual analyses. Your merged analysis should read as if it analyzed all comments at once, not as a combination of separate analyses.

Remember: You're creating THE definitive analysis of this theme based on ALL available comment data.`;
