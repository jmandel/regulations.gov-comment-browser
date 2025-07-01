---
allowed-tools: Task, Write, Read, mcp__regulations-browser__searchComments, mcp__regulations-browser__getComment, mcp__regulations-browser__listThemes, mcp__regulations-browser__getThemeSummary
description: Launch parallel investigations of public comments on a specific theme
---

# Analysis Phase: Parallel Investigation

## Your Mission

Your entire mission is defined by the following directive. You will deconstruct this directive to plan and execute a parallelized, in-depth investigation.

**`$ARGUMENTS`**

## Phase 1: Deconstruction and Planning

First, you must parse the mission directive to establish your operational parameters.

1.  **Deconstruct the Directive (`$ARGUMENTS`):**
    *   **Identify the Core Theme:** What is the central topic of this investigation?
    *   **Identify the Docket ID:** What is the specific source docket for the comments?

2.  **Conduct Initial Reconnaissance:**
    *   Using the theme and docket you identified, run a search to gauge the volume of relevant comments.
    *   `searchComments(docketId="[Your Identified Docket ID]", query="[Your Identified Theme]", limit=20)`

3.  **Create the Work Plan:**
    *   Based on the total count returned, create a work plan in a file named `workplan.md`.
    *   **The plan must include:**
        *   The Core Theme and Docket ID you derived.
        *   Total relevant comments found.
        *   The number of parallel subtasks needed. **Plan for a batch size of 25 comments per subtask.**
        *   Batch assignments with specific `offset` and `limit=25` values for each subtask.

## Phase 2: Launch Parallel Deep Dives

Execute the work plan by creating parallel subtasks. Ensure the `analysis/` directory is created if it does not exist. Use the following prompt template for each subtask.

---
### **Subtask Prompt Template**

You are an analyst conducting an in-depth investigation of **[Core Theme from your plan]** as revealed in comments [OFFSET] to [OFFSET+25] of docket `[Docket ID from your plan]`.

**Starting Point:**
`searchComments(docketId="[Docket ID]", query="[Core Theme]", limit=25, offset=[OFFSET])`

Your objective is to extract and analyze the evidence, arguments, and implications within your assigned comment batch.

**Your Method:**

1.  **Systematic Review:** For each comment, perform a structured analysis of its core position, supporting evidence, implied causal relationships, and the submitter's perspective.

2.  **Investigative Exploration:** Use the search tools to add context, test assertions, and read full comments with `getComment` when necessary.

3.  **Document Your Investigation:** Record your findings as a structured intelligence report in **`analysis/batch-[N].md`**, where `[N]` is the subtask number. Include key arguments, direct quotes, contrasting viewpoints, technical details, and any surprising findings.
---
