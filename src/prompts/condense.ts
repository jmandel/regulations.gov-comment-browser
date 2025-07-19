export const CONDENSE_PROMPT = `# Comment Distillation Instructions

You will receive a public comment submitted regarding a federal regulation. Your task is to create a highly structured condensed version that preserves all substantive content while organizing it into consistent, parseable sections.

## Output Structure

You MUST organize every comment into these exact sections with these exact headers:

### DETAILED CONTENT

Transform the FULL CONTENT of the original comment including all attachments into a consistent bullet point outline:
- Use ONLY bullets and sub-bullets (no bold, no headers, no special formatting)
- Preserve the original organizational structure as nested bullets
- If the original has section headings, include them as top-level bullets
- Maintain narrative flow and logical connections through bullet hierarchy
- Use the commenter's voice and tone where possible
- Keep all anecdotes, examples, and evidence in their original context
- Use indentation to show relationships:
  - First-level sub-bullet for elaboration
  - Second-level sub-bullet for specific examples or details
    - etc as needed
- Each bullet should be a complete thought or statement
- Combine short related points into single bullets where sensible

### ONE-LINE SUMMARY
[A single, Zagat-style sentence capturing the essence - who they are and what they want]

### COMMENTER PROFILE
- **Name/Organization:** [Name if provided, otherwise "Anonymous"]
- **Type:** [Individual | Business | Healthcare Provider | Advocacy Group | Government Entity | Trade Association | Academic/Research | Other]
- **Role/Expertise:** [Specific professional role, credentials, or relevant experience if mentioned]
- **Geographic Scope:** [Local/State/National/International, with location if specified]
- **Stake in Issue:** [Direct description of how this regulation affects them]

### CORE POSITION
[2-3 sentences in the original voice stating the fundamental stance and primary argument. Use "I/we" if that's how they wrote it.]

### KEY RECOMMENDATIONS
[If no recommendations, write "No specific recommendations provided"]
- [Each recommendation as a clear, actionable bullet point]
- [Include sub-bullets for implementation details or rationale]
  - [Supporting detail]
  - [Supporting detail]

### MAIN CONCERNS
[If no concerns, write "No specific concerns raised"]
- [Each concern as a distinct bullet point]
- [Group related concerns together]
  - [Specific examples or consequences]
  - [Supporting evidence]

### NOTABLE EXPERIENCES & INSIGHTS
[What makes this comment memorable or distinctive? If nothing particularly notable, write "No distinctive experiences shared"]
- [Unique personal anecdotes or case studies]
- [Surprising data points or unexpected consequences]
- [Innovative solutions or workarounds they've developed]
- [Compelling real-world examples that illustrate policy impacts]
- [Counterintuitive insights or perspectives]
- [Specific situations that reveal system failures or successes]

### KEY QUOTATIONS
[Extract 1-3 verbatim quotes that are particularly powerful, surprising, or well-articulated. If no standout quotes, write "No standout quotations"]
- "[Exact quote that captures frustration/hope/insight powerfully]"
- "[A surprising revelation or statistic stated memorably]"
- "[An eloquent summary of position or experience]"

## Distillation Guidelines

**Preserve completely:**
- All policy positions and recommendations
- Specific data, statistics, and citations
- Real-world examples and case studies
- Technical specifications or requirements
- Cost estimates and economic impacts
- Unique perspectives or unintended consequences
- Personal experiences that illustrate policy impacts
- Memorable anecdotes that bring abstract issues to life
- The authentic voice and tone of the writer

**Transform into plain language:**
- Bureaucratic jargon → simple, direct terms
- Promotional fluff → factual statements
- Repetitive emphasis → single clear point
- Corporate speak → human language
- Passive voice → active voice where natural

**Summarize concisely:**
- Organizational background (move key facts to COMMENTER PROFILE)
- Repetitive arguments (consolidate similar points)
- Extended anecdotes (capture key insights while keeping flavor)

**Remove entirely:**
- Salutations, closings, and thank yous
- Pure self-promotion without substance
- Redundant restatements that add nothing
- Empty filler phrases and ceremonial language
- Generic praise or criticism without specifics

**Extract for NOTABLE EXPERIENCES:**
- Specific patient cases or personal stories
- Unexpected outcomes or unintended consequences
- Creative workarounds to system limitations
- "Aha moments" or turning points
- Data points that challenge assumptions
- Vivid examples that illustrate broader problems

**Extract for KEY QUOTATIONS:**
- Statements that crystallize complex issues in memorable ways
- Surprising statistics or revelations phrased impactfully
- Emotional appeals that humanize policy impacts
- Particularly eloquent problem statements or solutions
- Metaphors or analogies that illuminate issues
- "Mic drop" moments that sum up positions powerfully
- Quotes that would work well in executive summaries or media

**Style requirements:**
- Maintain the original voice - use "I/we" if that's how they wrote it
- Use plain, direct language - no jargon or bureaucratic phrasing
- Be precise and clear without being promotional or stilted
- Keep the authentic tone - frustrated, hopeful, technical, urgent, etc.
- Preserve technical terminology and acronyms when used
- Write naturally, as if summarizing to a colleague

---

Here is the comment to distill:

{COMMENT_TEXT}`;
