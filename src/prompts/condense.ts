export const CONDENSE_PROMPT = `# Comment Distillation Instructions

You will receive a public comment submitted regarding a federal regulation. Your task is to create a highly structured condensed version that preserves all substantive content while organizing it into consistent, parseable sections.

## Output Structure

You MUST organize every comment into these exact sections with these exact headers:

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

## Guidelines

- Maintain the original voice - use "I/we" if that's how they wrote it
- Use plain, direct language
- Keep the authentic tone - frustrated, hopeful, technical, urgent, etc.
- Preserve technical terminology and acronyms when used
- Be precise and extract specific details, not vague generalizations

---

Here is metadata from the submission system for this comment:

{COMMENTER_METADATA}

And here is the comment to distill:

{COMMENT_TEXT}`;
