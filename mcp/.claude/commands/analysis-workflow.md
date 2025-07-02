---
allowed-tools: Task, Write, Read, mcp__regulations-comment-browser__searchComments, mcp__regulations-comment-browser__getComment, mcp__regulations-comment-browser__listThemes, mcp__regulations-comment-browser__getThemeSummary
description: Launch parallel investigations of public comments on a specific theme
---

# Analysis Phase: Parallel Investigation

## Your Mission

Your entire mission is defined by the following directive. You will deconstruct this directive to plan and execute a parallelized, in-depth investigation.

**`$ARGUMENTS`**

## Phase 1: Planning Your Investigation

1. **Parse the directive** (`$ARGUMENTS`) to identify:
   - Core investigation theme
   - Target docket ID

2. **Probe the comment landscape:**
   - Test individual keywords and short quoted phrases to understand coverage
   - IMPORTANT: Use quotes for exact phrases: `"prior authorization"` vs `prior authorization`
     - `"prior authorization"` finds the exact phrase
     - `prior authorization` finds docs with both words (anywhere)
   - Examples: `telehealth`, `"consent forms"`, `"information blocking"`
   - Note result counts and skim a few results to gauge relevance

3. **Combine related terms into a single efficient query:**
   - After probing, combine related terms using OR to create one comprehensive query
   - **Good queries are SPECIFIC:** 2-4 closely related terms, not kitchen-sink queries
   - Examples of GOOD queries:
     - `("prior auth" OR "prior authorization" OR pre-authorization)`
     - `(telehealth OR telemedicine OR "virtual care")`
   - Examples of BAD queries (too many clauses = too broad):
     - `(health OR medical OR patient OR care OR treatment OR...)`
     - Combining unrelated concepts that capture most comments
   - **CRITICAL: TEST your full OR query before proceeding!** Run the complete query to verify:
     - The result count is reasonable (aim for 10-30% of total comments, NOT 50%+)
     - If you're hitting >30%, your query is too broad - be more specific
     - The results are actually relevant (skim several)
   - Remember: Good analysis comes from SENSITIVE but SPECIFIC queries

4. **Create your work plan** in `workplan.md`:

   **Key principle:** Use ONE query with OR combinations rather than multiple separate queries. This ensures no comment appears in multiple batches.

   **Your plan must include:**
   - Total comments in the docket
   - Your final combined query string (the one you TESTED)
   - Actual result count from running this query
   - Percentage of docket this represents
   - Confirmation that you reviewed sample results for relevance
   - Number of batches needed (25 comments per batch)
   - Batch assignments with specific offsets
   - Brief rationale for your term choices

## Phase 2: Launch Parallel Deep Dives

Execute the work plan by launching ALL subtasks IN PARALLEL for maximum efficiency:

1. Ensure the `analysis/` directory exists
2. Launch all batch analysis tasks simultaneously using a single Task tool invocation with multiple prompts
3. Each sub-agent works independently on their assigned batch

**IMPORTANT:** Do not launch tasks sequentially - use the Task tool's ability to launch multiple agents concurrently in a single invocation.

### **Subtask Prompt Guidelines**

Craft prompts that give sub-agents clear objectives while preserving their analytical autonomy. Each prompt should:

1. **State the assignment clearly** - Which comments to analyze (query, offset, limit)
2. **Require comprehensive reading** - Sub-agents MUST use `getComment` on ALL 25 comments in their batch
3. **Provide context** - The broader investigation theme and why this batch matters
4. **Encourage curiosity** - Frame the task as an investigation, allowing follow-up queries
5. **Require self-documentation** - Sub-agents must document their specific task at the start of their output file

### **Example Subtask Prompt (adapt as needed):**

```
You're investigating [Core Theme] through comments [OFFSET]-[OFFSET+25] from docket [ID].

Your search parameters: `[exact query]`

REQUIRED PROCESS:
1. Document your specific assignment in your report file (`analysis/batch-[N].md`)
2. Run your search query to get your batch of 25 comments
3. Use `getComment` to read the FULL TEXT of EVERY comment in your batch (all 25)
4. You may also run follow-up searches if you discover related themes or need context

Process each comment individually with curiosity and depth:

1. Work through your batch comment by comment (all 25), and for each one:
   - Read the FULL TEXT using `getComment`
   - Let the comment guide your analysis - what stands out? What surprises you?
   - Capture the commenter's unique perspective and voice
   - Note specific examples, stories, or technical details they share
   - Include powerful direct quotes that convey their position
   - Follow threads of interest - if they mention something intriguing, dig deeper
   - Document your discoveries and insights as you go

2. Only after you've given each comment individual attention:
   - Reflect on patterns or tensions you noticed across comments
   - Identify areas where commenters converge or diverge
   - Note any surprising connections or contradictions
   - Synthesize broader insights from your deep dive

Your output should read like an investigative journal - showing your comment-by-comment discoveries before any cross-comment synthesis. Stay curious and let each comment teach you something new.
```

### **Vary your approach based on what you're investigating:**

- For **technical aspects**: Encourage digging into implementation details, feasibility concerns, and system dependencies
- For **human impact**: Focus on stories, experiences, and real-world consequences  
- For **policy conflicts**: Look for competing values, trade-offs, and underlying tensions
- For **stakeholder positions**: Analyze motivations, power dynamics, and coalition patterns

The key is to give sub-agents room to discover what's actually important in their batch, not just fill out a template.

---

## Phase 3: Completion (No Synthesis)

**IMPORTANT:** When all parallel subtasks have been launched:

1. **DO NOT perform any synthesis or summary of the findings**
2. **DO NOT attempt to read or merge the analysis files**
3. **DO NOT create any additional reports or overviews**

Simply state: "Analysis phase complete. All [N] subtasks have been launched to analyze [total number] comments across [number] queries. The detailed findings are available in the `analysis/` directory for subsequent synthesis."

Your role ends with launching the parallel investigations. Synthesis will be handled by specialized agents with specific synthesis objectives.
