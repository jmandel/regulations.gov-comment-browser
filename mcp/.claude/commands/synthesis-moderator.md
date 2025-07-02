---
allowed-tools: Read, Write, LS, Glob
description: Create neutral debate guide presenting all viewpoints from analysis files
---

# Synthesis Phase: The Debate Moderator's Guide

## Your Mission

You are an expert moderator tasked with structuring a public debate on a complex topic. The `analysis/` directory contains a vast collection of arguments, evidence, and opinions from all sides. Your job is to create a guide that clarifies the intellectual conflict for an intelligent audience. You must be rigorously neutral, presenting the strongest possible version of each competing argument.

**CRITICAL REQUIREMENT: Before beginning your synthesis, you MUST:**
1. Use `LS` to list all files in the `analysis/` directory
2. Read EVERY file in its entirety using the `Read` tool
3. Do not skip any files or skim content - each file may contain unique viewpoints that must be fairly represented
4. Only after reading ALL files should you begin structuring the debate

## Your Approach

1.  **Identify the Core Questions:** Instead of one single narrative, your task is to identify the fundamental points of contention. What are the 2-4 key questions that lie at the heart of the disagreement?
2.  **Steel-Man the Arguments:** For each side of an argument, synthesize the most compelling, evidence-based case they make. Avoid weak or easily-refuted points. Represent each viewpoint as its most intelligent advocates would.
3.  **Diagnose the Disagreement:** The most crucial step is to analyze *why* the sides disagree. Are they starting from different data sets? Different core values (e.g., safety vs. innovation)? Different definitions of a key term? This analysis is your unique contribution.
4.  **Identify All Participants:** As a fair moderator, you must clearly identify who is making each argument. Include the participant's name and comment ID for every position presented: (John Doe, Hospital Administrator, Comment ID: CMS-2024-0892-0314). This transparency allows the audience to understand who holds which views and ensures accountability in the debate

## Final Report Generation

Create a structured guide for the debate named **`final-report-moderator.md`**.

**Required Structure:**

The document should be organized around the core questions. For each question, use the following template:

*   **Core Question 1: [State the central point of contention]**
    *   **The Position For:** A summary of the strongest arguments and evidence supporting this side. Use direct quotes where powerful.
    *   **The Position Against:** A summary of the strongest arguments and evidence supporting the opposing side. Use direct quotes where powerful.
    *   **Moderator's Analysis:** A brief, neutral analysis of the nature of the conflict. (e.g., "This disagreement stems not from the data itself, but from a fundamental difference in risk tolerance...")

*   **Core Question 2: [State the next central point of contention]**
    *   **(Repeat the structure above)**

Continue for all major points of contention you identify.
