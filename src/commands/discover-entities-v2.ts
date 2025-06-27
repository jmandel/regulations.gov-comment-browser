import { Command } from "commander";
import { openDb, withTransaction } from "../lib/database";
import type { Database } from "bun:sqlite";
import { initDebug, debugSave } from "../lib/debug";
import { AIClient } from "../lib/ai-client";
import { loadCondensedCommentsForEntities } from "../lib/comment-processing";
import type { EntityTaxonomy, EnrichedComment } from "../types";
import { parseJsonResponse } from "../lib/json-parser";

export const discoverEntitiesV2Command = new Command("discover-entities-v2")
  .description("Discover named entities using single large prompt (v2)")
  .argument("<document-id>", "Document ID (e.g., CMS-2025-0050-0031)")
  .option("-l, --limit <n>", "Process only N comments", parseInt)
  .option("--word-limit <n>", "Target word count for prompt (default: 150000)", parseInt)
  .option("-d, --debug", "Enable debug output")
  .option("-m, --model <model>", "AI model to use (default: gemini-pro)")
  .option("--discover-only", "Only discover entities, skip annotation")
  .option("--annotate-only", "Only annotate comments with existing entities")
  .action(discoverEntitiesV2);

async function discoverEntitiesV2(documentId: string, options: any) {
  await initDebug(options.debug);
  
  const db = openDb(documentId);
  const targetWords = options.wordLimit || 150000;
  const model = options.model || 'gemini-pro';
  
  const ai = new AIClient(model, db);
  
  // Determine what operations to perform
  const shouldDiscover = !options.annotateOnly;
  const shouldAnnotate = !options.discoverOnly;
  
  if (options.discoverOnly && options.annotateOnly) {
    console.log("❌ Cannot use both --discover-only and --annotate-only");
    db.close();
    return;
  }
  
  console.log(`🔍 Processing entities for document ${documentId} (v2 approach)`);
  console.log(`   Mode: ${shouldDiscover && shouldAnnotate ? 'Discover and annotate' : shouldDiscover ? 'Discover only' : 'Annotate only'}`);
  console.log(`   Using model: ${model}`);
  if (shouldDiscover) {
    console.log(`   Target words: ${targetWords.toLocaleString()}`);
  }
  
  try {
    // Check existing entities
    const existingEntities = db.prepare("SELECT COUNT(*) as count FROM entity_taxonomy").get() as { count: number };
    
    if (shouldDiscover && existingEntities.count > 0) {
      console.log(`⚠️  Entities already discovered (${existingEntities.count} entities)`);
      console.log("   To re-run discovery, clear entity_taxonomy table first");
      if (!shouldAnnotate) {
        // User only wants to discover, but entities already exist
        db.close();
        return;
      }
      // User wants both discover and annotate, skip discovery
      console.log("   Skipping discovery, proceeding to annotation...");
    }
    
    if (shouldAnnotate && !shouldDiscover && existingEntities.count === 0) {
      console.log("❌ No entities found. Run discovery first.");
      db.close();
      return;
    }
    
    // Load all comments (needed for both discovery and annotation)
    const allComments = loadCondensedCommentsForEntities(db, options.limit);
    if (allComments.length === 0) {
      console.log("❌ No condensed comments found. Run 'condense' command first.");
      db.close();
      return;
    }
    
    console.log(`📊 Found ${allComments.length} condensed comments`);
    
    let taxonomy: EntityTaxonomy = {};
    
    // Discovery phase
    if (shouldDiscover && existingEntities.count === 0) {
      taxonomy = await discoverEntities(db, ai, allComments, targetWords, options.debug);
    }
    
    // Annotation phase
    if (shouldAnnotate) {
      await annotateComments(db, allComments);
    }
    
    // Final summary
    const savedEntities = db.prepare("SELECT COUNT(*) as count FROM entity_taxonomy").get() as { count: number };
    const annotationCount = db.prepare("SELECT COUNT(*) as count FROM comment_entities").get() as { count: number };
    
    console.log("\n✅ Entity processing complete!");
    console.log(`   Entities in database: ${savedEntities.count}`);
    console.log(`   Annotations: ${annotationCount.count}`);
    
  } catch (error) {
    console.error("❌ Failed:", error);
    throw error;
  } finally {
    db.close();
  }
}

// Discover entities from comments
async function discoverEntities(
  db: Database,
  ai: AIClient,
  allComments: EnrichedComment[],
  targetWords: number,
  debug: boolean
): Promise<EntityTaxonomy> {
  console.log("\n🔍 Starting entity discovery...");
  
  // Randomly select comments to reach target word count
  const shuffled = [...allComments].sort(() => Math.random() - 0.5);
  const selectedComments: EnrichedComment[] = [];
  let totalWords = 0;
  
  for (const comment of shuffled) {
    const wordCount = comment.content.split(/\s+/).length;
    
    if (totalWords + wordCount > targetWords && totalWords > targetWords * 0.9) {
      break; // Close enough to target
    }
    
    selectedComments.push(comment);
    totalWords += wordCount;
  }
  
  console.log(`📝 Selected ${selectedComments.length} comments with ${totalWords.toLocaleString()} words`);
  
  // Build prompt
  const commentBlocks = selectedComments.map(c => 
    `<comment id="${c.id}">\n${c.content}\n</comment>`
  ).join("\n\n");
  
  const prompt = `You are analyzing public comments on a proposed CMS rule. Based on the following ${selectedComments.length} comment excerpts (${totalWords.toLocaleString()} words total), create a comprehensive taxonomy of entities mentioned or relevant to this domain.

Generate a JSON taxonomy with the following structure:
{
  "CategoryName": [
    {
      "label": "Brief Name",
      "definition": "Clear definition of what this entity is",
      "terms": ["exact term 1", "exact term 2", "ABBR", "Alternative Name", "alternate spelling"]
    }
  ]
}

CRITICAL Requirements:

1. **MECE Categories**: Categories must be Mutually Exclusive and Collectively Exhaustive. Each entity belongs to exactly ONE category. No overlapping categories.

2. **Brief Entity Labels**: Keep labels SHORT (2-4 words max). These are identifiers, not descriptions.
   - Good: "Medicare Part D", "Prior Authorization", "CMS"  
   - Bad: "Centers for Medicare and Medicaid Services Administrative Processes"

3. **Complete Term Lists for Blind Matching**: The terms array must contain EVERY possible text variation that could appear in comments. This will be used for exact string matching, so include:
   - All spelling variations (e.g., "Prior Authorization", "prior auth", "prior-authorization")
   - All abbreviations (e.g., "PA", "prior auth")
   - All acronyms (e.g., "CMS", "HHS", "MA-PD")
   - Common misspellings if any
   - Both singular and plural forms when appropriate
   - Both hyphenated and non-hyphenated versions
   
   IMPORTANT: The matching will be CASE-SENSITIVE and must match exact word boundaries.
   
   **CRITICAL**: DO NOT include synonym terms that are common words on their own and could cause false matches. For example:
   - For "Prior Authorization", include "PA", "prior auth" but NOT "approval" or "permission"
   - For "Medicare Advantage", include "MA", "MA plan" but NOT "advantage" alone
   - For "Prescription Drug Plan", include "PDP", "Part D plan" but NOT "plan" alone

Additional Guidelines:
- Create up to 500 total entities across all categories
- Categories should be domain-appropriate (e.g., Government Agencies, Programs, Medications, Conditions, Regulations, Processes, etc.)
- **EXCLUDE private/commercial companies**: Do not create categories for vendors, service providers, or commercial entities.
- Each entity needs a brief but informative definition (<20 words)
- Include entities that are directly mentioned AND those you'd expect to see in similar comments
- Make a coherent taxonomy of the domain represented in these comments

Focus on creating a high-quality, comprehensive taxonomy that captures the key entities in this domain, even if some specific terms don't appear in this sample.

<comments>
${commentBlocks}
</comments>

Generate the JSON taxonomy:`;

  // Generate taxonomy
  console.log("\n🤖 Generating taxonomy with LLM...");
  const startTime = Date.now();
  
  const taxonomy = await ai.generateContent<EntityTaxonomy>(
    prompt,
    debug ? 'entities_v2_full' : undefined,
    'entities_v2_full_taxonomy',
    {
      taskType: 'discover-entities-v2-full',
      taskLevel: 0,
      params: { 
        commentCount: selectedComments.length,
        wordCount: totalWords
      }
    },
    parseJsonResponse
  );
  
  const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`✅ Taxonomy generated in ${elapsedTime}s`);
  
  if (debug) {
    await debugSave('entities_v2_taxonomy.json', taxonomy);
  }
  
  // Count entities
  const totalEntities = Object.values(taxonomy).flat().length;
  const categoryCount = Object.keys(taxonomy).length;
  console.log(`   Categories: ${categoryCount}`);
  console.log(`   Total entities: ${totalEntities}`);
  
  // Save entities with filtering
  console.log("\n💾 Saving entity taxonomy...");
  await saveEntitiesWithFiltering(db, taxonomy, allComments);
  
  return taxonomy;
}

// Save entities with filtering based on occurrence frequency
async function saveEntitiesWithFiltering(
  db: Database,
  taxonomy: EntityTaxonomy,
  comments: EnrichedComment[]
) {
  // ──────────────────── preparation ────────────────────
  const insertEntity = db.prepare(
    `INSERT INTO entity_taxonomy (category, label, definition, terms)
     VALUES (?, ?, ?, ?)`
  );

  const insertAnnotation = db.prepare(
    `INSERT OR IGNORE INTO comment_entities (comment_id, category, entity_label)
     VALUES (?, ?, ?)`
  );

  // Build regex index per term so we can scan comments efficiently
  type SearchEntry = {
    entityKey: string;        // "{category}|{label}"
    category: string;
    label: string;
    regex: RegExp;
  };

  const searchEntries: SearchEntry[] = [];

  // Track occurrences per entity (unique comments mentioning it)
  const entityHits: Map<string, Set<string>> = new Map();

  for (const [category, entities] of Object.entries(taxonomy)) {
    for (const { label, terms } of entities) {
      const entityKey = `${category}|${label}`;
      entityHits.set(entityKey, new Set());
      for (const term of terms) {
        // Word-boundary, case-sensitive match
        const regex = new RegExp(`\\b${escapeRegex(term)}\\b`, "g");
        searchEntries.push({ entityKey, category, label, regex });
      }
    }
  }

  // ───────────────────── scan comments ─────────────────────
  console.log("\n📚 Scanning all comments for entity matches...");
  const upperThreshold = Math.floor(comments.length * 0.5);
  const lowerThreshold = Math.max(1, Math.floor(comments.length * 0.01));

  let processedCount = 0;
  for (const comment of comments) {
    // structuredSections should already be parsed in EnrichedComment
    const sections = comment.structuredSections ?? {};
    const detailedContent = sections.detailedContent ?? "";
    if (!detailedContent) continue;

    for (const entry of searchEntries) {
      if (entry.regex.test(detailedContent)) {
        entityHits.get(entry.entityKey)!.add(comment.id);
      }
    }
    
    processedCount++;
    if (processedCount % 100 === 0) {
      console.log(`   Processed ${processedCount}/${comments.length} comments...`);
    }
  }

  // ─────────────── decide which entities to keep ───────────────
  const entitiesToRemove = new Set<string>();
  for (const [entityKey, hits] of entityHits.entries()) {
    const count = hits.size;
    if (count < lowerThreshold || count > upperThreshold) {
      entitiesToRemove.add(entityKey);
    }
  }

  console.log(
    `\n⚖️  Filtering entities outside [1%, 50%] occurrence thresholds.`
  );
  console.log(`   Total entities: ${entityHits.size}`);
  console.log(`   To remove:      ${entitiesToRemove.size}`);

  // ─────────────────── insert kept entities ───────────────────
  withTransaction(db, () => {
    let saved = 0;
    for (const [category, entities] of Object.entries(taxonomy)) {
      for (const entity of entities) {
        const key = `${category}|${entity.label}`;
        if (entitiesToRemove.has(key)) continue; // skip
        
        // Final safeguard: ensure definition is not null/empty
        const definition = entity.definition && entity.definition.trim() 
          ? entity.definition 
          : `A ${category.toLowerCase()} entity mentioned in comments`;
          
        insertEntity.run(
          category,
          entity.label,
          definition,
          JSON.stringify(entity.terms)
        );
        saved++;
      }
    }
    console.log(`   ✅ Saved ${saved} entities to database`);
  });

  // ─────────────────── summary ───────────────────
  if (entitiesToRemove.size > 0) {
    console.log("\n⚠️  Entities removed due to frequency thresholds (showing up to 10):");
    [...entitiesToRemove].slice(0, 10).forEach(key => {
      const hits = entityHits.get(key)?.size ?? 0;
      const percent = ((hits / comments.length) * 100).toFixed(2);
      console.log(`      - ${key} (${hits} comments, ${percent}%)`);
    });
    if (entitiesToRemove.size > 10) {
      console.log(`      ... and ${entitiesToRemove.size - 10} more`);
    }
  }
}

// Annotate comments with existing entities
async function annotateComments(
  db: Database,
  comments: EnrichedComment[]
) {
  console.log("\n📝 Annotating comments with entities...");
  
  // Load existing taxonomy from database
  const entityRows = db.prepare(
    "SELECT category, label, terms FROM entity_taxonomy"
  ).all() as Array<{
    category: string;
    label: string;
    terms: string;
  }>;
  
  if (entityRows.length === 0) {
    console.log("❌ No entities found in database");
    return;
  }
  
  console.log(`   Found ${entityRows.length} entities to match`);
  
  // Build search index
  type SearchEntry = {
    entityKey: string;
    category: string;
    label: string;
    regex: RegExp;
  };
  
  const searchEntries: SearchEntry[] = [];
  
  for (const row of entityRows) {
    const terms = JSON.parse(row.terms) as string[];
    const entityKey = `${row.category}|${row.label}`;
    
    for (const term of terms) {
      const regex = new RegExp(`\\b${escapeRegex(term)}\\b`, "g");
      searchEntries.push({ 
        entityKey, 
        category: row.category, 
        label: row.label, 
        regex 
      });
    }
  }
  
  // Clear existing annotations
  db.prepare("DELETE FROM comment_entities").run();
  
  // Annotate comments
  const insertAnnotation = db.prepare(
    `INSERT OR IGNORE INTO comment_entities (comment_id, category, entity_label)
     VALUES (?, ?, ?)`
  );
  
  let annotationCount = 0;
  let processedCount = 0;
  
  withTransaction(db, () => {
    for (const comment of comments) {
      const sections = comment.structuredSections ?? {};
      const detailedContent = sections.detailedContent ?? "";
      if (!detailedContent) continue;
      
      const alreadyAdded = new Set<string>();
      for (const entry of searchEntries) {
        if (alreadyAdded.has(entry.entityKey)) continue;
        if (entry.regex.test(detailedContent)) {
          insertAnnotation.run(comment.id, entry.category, entry.label);
          alreadyAdded.add(entry.entityKey);
          annotationCount++;
        }
      }
      
      processedCount++;
      if (processedCount % 100 === 0) {
        console.log(`   Processed ${processedCount}/${comments.length} comments...`);
      }
    }
  });
  
  console.log(`   💡 Created ${annotationCount} entity annotations`);
}

// Escape regex special characters
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}