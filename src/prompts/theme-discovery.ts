/**
 * Shared constant defining the strict output format for all taxonomy generation.
 * This version uses ALL CAPS for emphasis, provides a concrete example, and avoids markdown.
 */
const TAXONOMY_OUTPUT_FORMAT_INSTRUCTIONS = `
YOUR OUTPUT MUST BE A SINGLE BLOCK OF PLAINTEXT.

Follow this format PRECISELY for every theme. EVERY THEME GETS ONE PARAGRAPH. EVERY PARAGRAPH MUST START AT THE BEGINNING (NO INDENTATION).

THE REQUIRED FORMAT IS:
[Number]. [Label]. [Brief Description] || [Detailed Guidelines].

A breakdown of the format:
NUMBER: Use hierarchical numbering. In discovery: go deep (1, 1.1, 1.1.1, etc.). In merge: exactly 2 levels (1, 1.1, 2, 2.1, etc.).
LABEL: A concise theme name, ideally under 8 words, but anyway under 12.
BRIEF DESCRIPTION: A single sentence explaining what this theme is about.
|| : A double pipe delimiter (EXACTLY two pipe characters with a space before and after)
DETAILED GUIDELINES: A comprehensive 3-5 sentence explanation that MUST include:
  - What specific topics, concerns, or positions ARE included in this theme (with examples)
  - What related topics ARE NOT included in this theme (boundary setting)
  - Key distinguishing features that separate this theme from similar ones
  - Why this theme matters to commenters

CRITICAL: You MUST use the double pipe || delimiter between the brief description and detailed guidelines. This is not optional.

EXAMPLE OF CORRECT FORMATTING:
1. Administrative Burden Concerns. This theme encompasses all concerns about increased paperwork, reporting requirements, and compliance costs that the proposed rule would impose on healthcare providers and facilities. || It includes specific worries about staff time spent on documentation, costs of new software systems, complexity of reporting metrics, and burden on small practices with limited administrative resources. This theme does NOT include general opposition to the rule, clinical workflow disruptions, or patient care quality concerns - those belong in separate themes. The defining characteristic is focus on administrative and bureaucratic challenges rather than clinical or financial impacts. This matters because administrative burden is cited as a major barrier to rule implementation.

1.1. Small Practice Impact. This sub-theme specifically addresses how administrative burdens would disproportionately affect small medical practices, solo practitioners, and rural healthcare facilities with limited staff. || It includes concerns about lack of dedicated compliance personnel, inability to afford new systems, and risk of closure due to administrative overload. This excludes large hospital system concerns or general workforce issues. The key distinction is the focus on practice size and resource constraints as the primary vulnerability factor. This matters because small practices serve vulnerable populations who may lose access to care.

2. Quality Measurement Validity. This theme captures all comments questioning whether the proposed quality metrics accurately measure care quality or could have unintended consequences. || It includes critiques of specific metrics, concerns about gaming the system, worries about cherry-picking patients, and arguments that metrics don't capture care complexity. This theme does NOT include implementation challenges or cost concerns - only validity and accuracy issues. The central focus is on whether the measurements themselves are meaningful and beneficial. This matters because invalid metrics could worsen rather than improve patient care.

`;

/**
 * A prompt for discovering a MECE hierarchical taxonomy from structured comment sections.
 * Focuses specifically on core positions, recommendations, and concerns to identify policy themes.
 * The {COMMENTS} placeholder is where the structured comment data should be injected.
 */
export const THEME_DISCOVERY_PROMPT = `As an expert policy analyst, your task is to derive a comprehensive, deeply detailed hierarchical taxonomy from the structured public comments provided below.

You are analyzing the most substantive parts of each comment: their commenter profiles, core positions, key recommendations, and main concerns. These structured sections capture the essential policy arguments and positions taken by commenters.

CRITICAL RULE: Organize themes by ISSUE AREAS and TOPICS, not by stance or perspective. NEVER create themes like "Support for X" vs "Opposition to X". Instead, create themes around specific issues where both supporters and opponents can be found together.

Your analysis should:
1. IDENTIFY ISSUE AREAS: Look for distinct policy topics, implementation challenges, affected populations, or specific provisions being discussed
2. GROUP BY SUBJECT MATTER: Organize themes around what is being discussed (e.g., "Impact on Small Businesses", "Healthcare Access", "Implementation Timeline") rather than positions taken
3. CAPTURE DEBATES WITHIN THEMES: Each theme should potentially contain both supportive and critical viewpoints about that specific issue
4. CATEGORIZE RECOMMENDATIONS: Group policy suggestions by the problem they address or the area they affect, not by whether they support or oppose
5. ORGANIZE CONCERNS: Cluster worries and objections by the specific issue area they relate to (e.g., "Cost Implications", "Legal Challenges", "Technical Feasibility")
6. CREATE DEEP HIERARCHY: Go as deep as needed to capture all nuances. If a theme has sub-aspects, create sub-themes. If those have further distinctions, create sub-sub-themes. Don't artificially limit depth.
7. BE COMPREHENSIVE: Capture every distinct issue area and topic. It's better to have too many specific themes than to lose important distinctions.
8. AVOID PERSPECTIVE-BASED GROUPING: Never use theme names like "Arguments For", "Arguments Against", "Support", "Opposition", "Proponents Say", "Critics Argue". Use neutral, issue-focused titles.

Examples of GOOD theme names:
- "Impact on Rural Healthcare Facilities"
- "Compliance Costs and Administrative Burden"
- "Timeline and Implementation Challenges"
- "Effects on Vulnerable Populations"
- "Data Privacy and Security Requirements"

Examples of BAD theme names (avoid these):
- "Support for the Proposed Rule"
- "Opposition to Changes"
- "Arguments in Favor"
- "Criticisms and Objections"
- "Positive Impacts" vs "Negative Impacts"

Focus on substantive policy content rather than procedural comments or general statements. Each theme should capture a meaningful issue area that appears across multiple comments, potentially with diverse viewpoints about that issue.

IMPORTANT: Do not limit yourself to 2 or 3 levels. Go as deep as the content requires - 4, 5, or even 6 levels if needed to fully capture the nuances in the comments.

CRITICAL FORMATTING RULE: You MUST use the double pipe delimiter ( || ) to separate the brief description from the detailed guidelines. This is essential for proper parsing. Do not omit this delimiter.

--- FORMATTING REQUIREMENTS ---
${TAXONOMY_OUTPUT_FORMAT_INSTRUCTIONS}
--- END OF FORMATTING REQUIREMENTS ---

--- START OF STRUCTURED COMMENTS ---
{COMMENTS}
--- END OF STRUCTURED COMMENTS ---

You have now reviewed all the structured comment sections. Proceed with generating the complete, MECE hierarchical taxonomy of policy themes, strictly following the formatting requirements provided above.
`;

/**
 * A prompt for merging multiple existing theme taxonomies into a single, unified hierarchy.
 * This version handles N taxonomies instead of just 2, encouraging intelligent reconciliation.
 * It enforces the same strict plaintext output format as the discovery prompt.
 */
export const THEME_MERGE_PROMPT = `You are a senior analyst tasked with synthesizing research. Your goal is to merge multiple theme taxonomies into a single, comprehensive two-level hierarchy that preserves the richness and specificity of important topics.

CRITICAL RULE: Organize themes by ISSUE AREAS and TOPICS, not by stance or perspective. If you see themes organized by support vs. opposition, you MUST reorganize them by the actual issues being discussed.

Your input taxonomies:
{TAXONOMIES}

Your process should be:

1. **FIX PERSPECTIVE-BASED GROUPING**: If you see themes like "Support for X" and "Opposition to X", reorganize them into issue-based themes like "Impact of X on Healthcare", "Legal Implications of X", "Implementation Challenges with X", etc. Each new theme should potentially contain both supportive and critical viewpoints.

2. **EXTRACT ALL SUBSTANTIVE TOPICS**: Identify every topic from the source taxonomies that could warrant a focused one-page explainer. This includes:
   - Specific policy issues (e.g., "Impact on Emergency Medical Services")
   - Implementation challenges (e.g., "Database Integration Requirements")
   - Affected populations (e.g., "Effects on Rural Communities")
   - Specific provisions or requirements (e.g., "90-Day Reporting Deadline")
   - Cost and resource implications (e.g., "Staffing Requirements for Compliance")

2. **CREATE DEPTH-TWO NODES LIBERALLY**: Each important topic gets its own depth-two node. Ask yourself: "Would someone write a policy brief about this specific issue?" If yes, it deserves its own node. Aim for 50-100 depth-two nodes total rather than 20-30.

3. **GROUP INTO LOGICAL DEPTH-ONE CATEGORIES**: Create 10-15 top-level themes that serve as logical groupings. These should be broad enough to house related issues but not so broad they become meaningless. Examples:
   - "Zoning Reform Proposals & Opposition"
   - "Student Assessment Methods & Validity"  
   - "Industrial Emissions Monitoring & Enforcement"
   - "Open Source Licensing Models & Compliance"

4. **ORDER YOUR CATEGORIES STRATEGICALLY**:
   - **Start with foundational/infrastructure themes**: Put technical standards, frameworks, or enabling conditions first
   - **Follow with implementation/application themes**: How the foundations are put into practice
   - **Then stakeholder-specific themes**: Organized by who is most affected (users, implementers, regulators)
   - **End with cross-cutting concerns**: Privacy, equity, governance issues that affect everything
   - **Alternative: Order by urgency/importance**: If clear from the source material, put the most critical or time-sensitive issues first

5. **ORDER SUB-THEMES WITHIN CATEGORIES**:
   - **Problem → Solution ordering**: Start with issues/barriers, follow with proposed fixes
   - **General → Specific**: Broad concerns before narrow edge cases
   - **Frequency/Impact**: Most commonly mentioned or highest-impact issues first
   - **Logical workflow**: If there's a natural sequence (e.g., "Design Standards" → "Implementation Requirements" → "Compliance Monitoring")

6. **PRESERVE SPECIFICITY IN DESCRIPTIONS**: 
   - Keep concrete examples, specific company names, particular technologies
   - Include numbers, dates, specific regulations when mentioned
   - Maintain stakeholder attributions ("teachers report...", "neighborhood associations demand...")
   - Preserve memorable phrases and "sticky" language from the source

7. **SPLITTING IS BETTER THAN LUMPING**: When in doubt:
   - Split compound themes (e.g., "Noise & Air Pollution" → "Aircraft Noise Impacts" and "Diesel Particulate Exposure")
   - Keep distinct issues separate even if related
   - Create multiple specific nodes rather than one generic node

8. **MAINTAIN TENSIONS AND CONTRADICTIONS**: If stakeholders disagree:
   - Create separate nodes for opposing viewpoints
   - Or clearly capture both perspectives within a single node
   - Don't smooth over conflicts into generic statements

9. **USE ISSUE-FOCUSED TITLES**: Each depth-two node should have a specific, descriptive title that immediately conveys what the issue is. Examples:
   - Not: "Transit Challenges" 
   - But: "Bus Drivers Face Split Shifts Without Overtime Pay"
   - Not: "Rural Issues"
   - But: "Rural Schools Cannot Afford Broadband for Remote Learning"

CRITICAL: Remember that each depth-two node should be substantial enough that someone could write a focused, one-page issue brief about it. If you find yourself creating nodes like "Other Concerns" or "General Issues," you're being too generic.

--- FORMATTING REQUIREMENTS ---
${TAXONOMY_OUTPUT_FORMAT_INSTRUCTIONS}
--- END OF FORMATTING REQUIREMENTS ---`;
