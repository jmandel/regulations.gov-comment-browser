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
    }>,  // NOTE: debates may have 2, 3, or more distinct positions - capture all of them
  }> | null,
  "stakeholderPerspectives": Array<{
    "stakeholderType": string,
    "primaryConcerns": string,  // Keep specific organization names mentioned
    "specificPoints": Array<string>,  // Narrative points with key organizatio names where relevant
    "commentIds": Array<string>  // Extract only comment IDs
  }> | null,
  "keyRecommendations": Array<{
    "approach": string,  // Category like "Regulatory", "Operational", "Financial"
    "recommendation": string,  // Specific recommendation with key proponent names
    "supportLevel": string | null,
    "commentIds": Array<string>
  }> | null,
  "majorConcerns": Array<{
    "concern": string,  // Specific concern
    "raisedBy": string,  // Who raises it and how broadly
    "evidence": string | null,  // Specific risks or evidence cited
    "commentIds": Array<string>
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

2. **Extract Comment IDs**: When comment IDs are mentioned, extract them into the appropriate commentIds arrays. Comment IDs MUST be preserved EXACTLY as they appear in the input, including the full prefix (e.g., if the input says "HHS-ONC-2026-0001-0232", output "HHS-ONC-2026-0001-0232" — never shorten to just "0232"). When extracting comment IDs into dedicated JSON fields, *remove them* from narrative.

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
