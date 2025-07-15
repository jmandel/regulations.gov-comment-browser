---
allowed-tools: Write
description: Launch parallel investigations of public comments on a specific theme
---

# Analysis Phase: Parallel Investigation

## Your Mission

Your entire mission is defined by the following directive. You will deconstruct this directive to plan and execute a parallelized, in-depth investigation.

<userRequest>
$ARGUMENTS
</userRequest>

## Phase 1: Planning Your Investigation

1. **Parse the directive** to identify:
   - Core investigation themes
   - Target docket ID
   - Any specific constraints or focus areas

**PLANNING PHASE DISCIPLINE:**

Your job in the planning phase is to identify and organize comments relevant to the analysis. During planning:

- Use search to test keywords and check result counts
- Read comment metadata (submitter, type, summary) to verify relevance
- Read MAXIMUM 2-3 comments just to confirm your search is on target
- Save any analysis for the sub-agents who will read comments in batches so they're not overwhelmed with contxt

2. **Identify highly relevant comments for the user's query**

Your goal is to find a set of comments that is both sensitive (capture what matters) and specific (avoid noise of unrelated material) to the user's investigation. Use whatever approach works best:

- **Keyword searches** - Test terms, filters by submtter type, use OR to combine related concepts, verify relevance
- **Manual curation** - Search broadly, examine one-line summaries, hand-pick comments you think would be good for further analysis. In this context, you'll want to request paged results and read through MANY PAGES to get identify all the comments that need to be analyzed by sub-agents and curate them into batches
- **Hybrid approaches** - Start with keywords, refine with manual selection
- **Any other method** that helps you identify the right comments


Remember:
- Good investigations focus on quality over quantity (10-30% of comments is often better than 50%+)
- Test your approach before committing - spot check a couple of results to ensure they're on target
- You'll soon organize findings into batches of ~25 comments each, for sub-agent analysis
- Each batch can be described to sub-agents either via search parameters (query + offset) or explicit comment ID lists based on your curational exercise.

## Phase 2: Create Your Work Plan

**Create your work plan** in `workplan.md` that explains:

- What you understand the user's requirements to be -- in terms of which comments are relevant and how subagnts must analyze those comments batch by batch
- How you identified relevant comments (your search/selection approach)
- Total comments found and why they're relevant
- How you're organizing them into batches
- How you'll explain the task to the sub-agents (i.e. what analysis is required, what was the user's intent)
- What each batch will analyze (with specific search parameters or comment IDs)

The goal is to document your approach clearly so the user understands what you're doing and sub-agents know exactly what to analyze.

## Phase 3: Review and Confirm

After creating your workplan, you MUST:

1. **Present the workplan to the user** with a brief explanation:
   - Which strategy you chose and why
   - How you identified the comments (keywords tested, selection criteria used)
   - Number of batches and what each will analyze
   - Any interesting patterns you noticed during planning
   - How you'll explain the task to the sub-agents

2. **Ask for feedback** before proceeding:
   - "I've created a workplan... [explain details]. Would you like me to proceed with this plan, or would you prefer any adjustments?"

3. **Wait for user confirmation** before launching any sub-agents

This pause allows the user to:
- Suggest different keywords or selection criteria
- Adjust the scope (more/fewer comments)
- Redirect focus to specific aspects
- Request other changes
- Confirm the approach makes sense

## Phase 4: Launch Parallel Deep Dives

Execute the work plan by launching ALL sub-agents IN PARALLEL for maximum efficiency:

1. Ensure the `analysis/` directory exists
2. Launch all batch analysis tasks simultaneously using a single Agent tool invocation with multiple prompts
3. Each sub-agent works independently on their assigned batch

**IMPORTANT:** Do not launch tasks sequentially - use the Agent tool's ability to launch multiple agents concurrently in a single invocation.

### **Sub-agent Prompt Guidelines**

Craft prompts that give sub-agents clear objectives while preserving their analytical autonomy. The prompt structure varies by strategy:

**CRITICAL: Pass Along the User's Real Intent**
Don't just tell sub-agents what to search for - explain what the user actually wants to understand and why. Include their specific questions, concerns, and interests in your own words. Think of yourself as briefing a colleague on what really matters about this investigation.

#### For Keyword-Based Batches:

1. **Provide exact search parameters** - Include the complete search tool call with docketId, query, offset, and limit
2. **Require parameter documentation** - Sub-agents MUST record the exact search parameters in their output file
3. **Require comprehensive reading** - Sub-agents MUST use `getComment` on ALL comments in their batch

#### For Manually Curated Batches:

1. **Provide exact comment IDs** - List the specific comment IDs to analyze
2. **Explain selection criteria** - Why these comments were chosen (e.g., "all from rural physicians")
3. **Require full reading** - Sub-agents MUST use `getComment` on ALL assigned comments

### **Example Subtask Prompts:**

#### Keyword Strategy Example:
<subtaskPrompt>
You're investigating [Core Theme] through comments [OFFSET]-[OFFSET+25] from docket [ID].

[Here, thoughtfully explain what the user is trying to understand - their actual questions, what sparked their interest, what they're hoping to learn. Write it conversationally, as you would brief a colleague.]

Your exact search tool call parameters:
- docketId: "[DOCKET_ID]"
- query: "[EXACT_QUERY]"
- offset: [OFFSET_NUMBER]
- limit: 25

REQUIRED PROCESS:
1. Document your specific assignment in your report file (`analysis/batch-[N].md`)
2. Run your search query using the EXACT parameters provided above
3. Use `getComment` to read the FULL TEXT of EVERY comment returned
4. Process each comment individually with curiosity and depth

Process each comment individually with curiosity and depth:

**CRITICAL: Your workflow MUST alternate between reading and writing:**
1. Use `getComment` to read ONE comment
2. IMMEDIATELY write your notes and analysis for that comment in your report
3. Move to the next comment and repeat

Your report should show this alternating pattern:

### CMS-2025-0050-0142: [Description of commenter]
[Your immediate notes, reactions, quotes, and insights from this comment, in markdown; paragraphs, lists etc are all fair game]

### CMS-2025-0050-0287: [Description of commenter]
[Your immediate notes, reactions, quotes, and insights from this comment, in markdown; paragraphs, lists etc are all fair game]

...and so on through all comments using the official full comment IDs.

For each comment:
- Let the comment guide your analysis - what stands out? What surprises you?
- Capture the commenter's unique perspective and voice
- Note specific examples, stories, or technical details they share
- Include powerful direct quotes that convey their position
- Follow threads of interest - if they mention something intriguing, dig deeper
- Write your discoveries and insights BEFORE moving to the next comment

Only after you've processed ALL comments individually:
- Add a final section reflecting on patterns or tensions across comments
- Identify areas where commenters converge or diverge
- Note any surprising connections or contradictions
- Synthesize broader insights from your deep dive

Your output should read like an investigative journal - showing your real-time discoveries as you work through each comment. DO NOT read all comments first and then write - alternate between reading and documenting.
</subtaskPrompt>

#### Manual Curation Example:
Same as keyword-based, but the comments will be convened in an explicit list lie

<subtaskPrompt>
```
Your assigned comment IDs from docket [DOCKET_ID]:
- CMS-2025-0050-0142
- CMS-2025-0050-0287
- CMS-2025-0050-0394
[... list all 25 comment IDs]

These comments were selected because [REASON - e.g., "they're all from patient advocates in rural areas"].

[... as in the keyword-based prompt
</subtaskPrompt>

### **Vary your subtask prompts based on what needs to be investigated:**

- For **technical aspects**: Encourage digging into implementation details, feasibility concerns, and system dependencies
- For **human impact**: Focus on stories, experiences, and real-world consequences  
- For **policy conflicts**: Look for competing values, trade-offs, and underlying tensions
- For **stakeholder positions**: Analyze motivations, power dynamics, and coalition patterns

The key is to give sub-agents room to discover what's actually important in their batch, not just fill out a template.

---

## Phase 5: Completion (No Synthesis)

**IMPORTANT:** When all parallel sub-agents have been launched:

1. **DO NOT perform any synthesis or summary of the findings**
2. **DO NOT attempt to read or merge the analysis files**
3. **DO NOT create any additional reports or overviews**

Simply state: "Analysis phase complete. All [N] sub-agents have been launched to analyze [total number] comments across [number] queries. The detailed findings are available in the `analysis/` directory for subsequent synthesis."

Your role ends with launching the parallel investigations. Synthesis will be handled by specialized agents with specific synthesis objectives.
