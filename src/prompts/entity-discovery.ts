export const ENTITY_CATEGORY_DISCOVERY_PROMPT = `Identify the main categories of entities mentioned in the comments below. For each category, provide 1-2 example entities to illustrate what belongs in that category.

Format your response as:

1. Category
* Member Name: Brief definition
* Another Member: Brief definition

2. Next Category
* Next Category Member Name: Brief definition

RULES:
• Plain text only – NO bold, italics, or markdown
• Categories should be broad groups (e.g., "Healthcare Organizations", "Government Agencies", "Medical Conditions")
• Include only 1-2 representative examples per category
• Examples should be actual entities from the comments, not hypothetical

{COMMENTS}

Output only the category structure with minimal examples.`;

export const ENTITY_CATEGORY_MERGE_PROMPT = `You have multiple category lists from different batches of comments. Create a unified MECE (Mutually Exclusive, Collectively Exhaustive) category structure.

MECE Requirements:
• Mutually Exclusive: Each entity should clearly belong to only ONE category
• Collectively Exhaustive: Every entity from the source lists must have a home
• Clear boundaries: Category definitions should make it obvious what belongs where
* SPLIT DON'T LUM{} -- a category like "A, B, and C" should become 3 categories unless A, B, and C are super closely related
* USE SHORT TERMS -- pick a representative clear term rather that offering a category with several synonyms

Reconciliation guidelines:
- "Healthcare Organizations" and "Medical Entities" → choose the clearer, more specific name
- "Government Bodies" and "Federal Agencies" → merge under the more precise category
- Split overly broad categories if they mix different types (e.g., "Healthcare" → "Healthcare Organizations", "Medical Conditions", "Medical Procedures")
- Combine overly narrow categories that could confuse placement

Return a JSON array of category names:
[
"Category 1: Brief explanation of what belongs and doesn't",
"Category 2: Brief explanation of what belongs and doesn't", 
"Category 3: Brief explanation of what belongs and doesn't",
...]

{CATEGORY_LISTS}

Output only the JSON array of MECE categories where every entity has exactly one obvious home.`;
