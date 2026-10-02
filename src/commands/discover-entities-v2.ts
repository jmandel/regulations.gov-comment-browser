import { Command } from "commander";
import { openDb, withTransaction } from "../lib/database";
import type { Database } from "bun:sqlite";
import { initDebug, debugSave } from "../lib/debug";
import { UsageTally } from "../lib/ai-client";
import { loadUnitsForEntities, seededOrder } from "../lib/comment-processing";
import type { EntityTaxonomy, EnrichedComment } from "../types";
import { parseJsonResponse } from "../lib/json-parser";
import { getTaskModel, getTaskConfig } from "../lib/batch-config";
import { runLlmRequests } from "../lib/step-runner";

// Entity discovery: one LLM call designs a taxonomy (with exact match terms) from a seeded random
// sample of units, then every unit is scanned for the terms locally. Only the single call costs
// money, so this step doesn't grow with docket size beyond the local scan.
// Keep an entity if it appears in at least min(1% of units, minUnitsCap) units (and at least 1) and in at
// most 50% of units. A flat 1% floor would need 200 mentions on a 20k-unit docket, dropping most
// organizations and codes that only serious letters mention.
const DEFAULT_MIN_UNITS_CAP = 10;
// Long letters are truncated in the discovery sample so one 50-page letter can't fill it
const SAMPLE_MAX_WORDS_PER_UNIT = 4000;

export const discoverEntitiesV2Command = new Command("discover-entities-v2")
  .description("Discover named entities using single large prompt (v2)")
  .argument("<document-id>", "Document ID (e.g., CMS-2025-0050-0031)")
  .option("-l, --limit <n>", "Process only N comments", parseInt)
  .option("--word-limit <n>", "Target word count for prompt (default: 150000)", parseInt)
  .option("--seed <s>", "Seed for the discovery sample (default: 1)")
  .option("-d, --debug", "Enable debug output")
  .option("-m, --model <model>", "AI model to use (overrides batch-config)")
  .option("--discover-only", "Only discover entities, skip annotation")
  .option("--annotate-only", "Only annotate comments with existing entities")
  .action(discoverEntitiesV2);

async function discoverEntitiesV2(documentId: string, options: any) {
  await initDebug(options.debug);
  
  const db = openDb(documentId);
  const targetWords = options.wordLimit || 150000;
  const model = getTaskModel('discoverEntities', options.model);
  
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
    const allComments = loadUnitsForEntities(db, options.limit);
    if (allComments.length === 0) {
      console.log("❌ No transcribed comments found. Run 'transcribe' command first.");
      db.close();
      return;
    }
    
    console.log(`📊 Found ${allComments.length} units (transcribed; representatives only if clustered; no_substance excluded)`);
    
    let taxonomy: EntityTaxonomy = {};
    
    // Discovery phase
    if (shouldDiscover && existingEntities.count === 0) {
      taxonomy = await discoverEntities(db, model, allComments, targetWords, options.seed ?? 1, options.debug);
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
  model: string,
  allComments: EnrichedComment[],
  targetWords: number,
  seed: string | number,
  debug: boolean
): Promise<EntityTaxonomy> {
  console.log("\n🔍 Starting entity discovery...");
  
  // Seeded random sample up to the target word count (reruns pick the same sample)
  const selectedComments: { id: string; content: string }[] = [];
  let totalWords = 0;
  for (const comment of seededOrder(allComments, seed)) {
    const words = comment.content.split(/\s+/);
    const content = words.length > SAMPLE_MAX_WORDS_PER_UNIT
      ? words.slice(0, SAMPLE_MAX_WORDS_PER_UNIT).join(' ') + ' [...]'
      : comment.content;
    const wordCount = Math.min(words.length, SAMPLE_MAX_WORDS_PER_UNIT);
    if (totalWords + wordCount > targetWords && totalWords > targetWords * 0.9) {
      break; // Close enough to target
    }
    if (totalWords + wordCount > targetWords) continue;
    selectedComments.push({ id: comment.id, content });
    totalWords += wordCount;
  }
  
  console.log(`📝 Selected ${selectedComments.length} comments with ${totalWords.toLocaleString()} words`);
  
  // Build prompt
  const commentBlocks = selectedComments.map(c => 
    `<comment id="${c.id}">\n${c.content}\n</comment>`
  ).join("\n\n");
  
  const prompt = `You are analyzing public comments on a regultions.gov docket. Based on the following ${selectedComments.length} comment excerpts (${totalWords.toLocaleString()} words total), create a comprehensive taxonomy of entities mentioned or relevant to this domain.

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
  let taxonomy: EntityTaxonomy | undefined;
  const tally = new UsageTally();
  // Two attempts; the retry asks for JSON output, which also keeps it from hitting a stale cache entry
  for (let attempt = 1; attempt <= 2 && !taxonomy; attempt++) {
    const summary = await runLlmRequests(
      [{ key: 'entity-taxonomy', model, parts: [{ text: prompt }], config: attempt > 1 ? { responseMimeType: "application/json" } : undefined }],
      (_req, res) => {
        const parsed = parseJsonResponse(res.text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('taxonomy is not a JSON object');
        // Keep only well-formed entities
        for (const [cat, list] of Object.entries(parsed)) {
          parsed[cat] = Array.isArray(list) ? (list as any[]).filter(e => e && typeof e.label === 'string' && Array.isArray(e.terms)) : [];
        }
        taxonomy = parsed as EntityTaxonomy;
      },
      { db, task: 'discover-entities', mode: 'live', concurrency: 1 }
    );
    tally.addSummary('entity-taxonomy', summary);
  }
  if (!taxonomy) throw new Error('Entity taxonomy generation failed');
  
  const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`✅ Taxonomy generated in ${elapsedTime}s`);
  tally.print('discover-entities-v2');
  
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
  const insertEntity = db.prepare(
    `INSERT INTO entity_taxonomy (category, label, definition, terms)
     VALUES (?, ?, ?, ?)`
  );

  const matcher = new TermMatcher();
  const entityHits: Map<string, number> = new Map();
  for (const [category, entities] of Object.entries(taxonomy)) {
    for (const { label, terms } of entities) {
      const entityKey = `${category}|${label}`;
      entityHits.set(entityKey, 0);
      for (const term of terms) matcher.add(term, entityKey);
    }
  }

  console.log("\n📚 Scanning all units for entity matches...");
  const t0 = Date.now();
  for (const comment of comments) {
    for (const key of matcher.match(comment.content)) entityHits.set(key, entityHits.get(key)! + 1);
  }
  console.log(`   Scanned ${comments.length} units in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const thresholds = (getTaskConfig('discoverEntities') as any).thresholds || {};
  const minUnitsCap: number = thresholds.minUnitsCap ?? DEFAULT_MIN_UNITS_CAP;
  const upperThreshold = Math.floor(comments.length * 0.5);
  const lowerThreshold = Math.max(1, Math.min(Math.floor(comments.length * 0.01), minUnitsCap));
  const entitiesToRemove = new Set<string>();
  for (const [entityKey, count] of entityHits.entries()) {
    if (count < lowerThreshold || count > upperThreshold) entitiesToRemove.add(entityKey);
  }

  console.log(`\n⚖️  Keeping entities found in ${lowerThreshold}–${upperThreshold} units.`);
  console.log(`   Total entities: ${entityHits.size}`);
  console.log(`   To remove:      ${entitiesToRemove.size}`);

  withTransaction(db, () => {
    let saved = 0;
    for (const [category, entities] of Object.entries(taxonomy)) {
      for (const entity of entities) {
        const key = `${category}|${entity.label}`;
        if (entitiesToRemove.has(key)) continue;
        const definition = entity.definition && entity.definition.trim()
          ? entity.definition
          : `A ${category.toLowerCase()} entity mentioned in comments`;
        insertEntity.run(category, entity.label, definition, JSON.stringify(entity.terms));
        saved++;
      }
    }
    console.log(`   ✅ Saved ${saved} entities to database`);
  });

  if (entitiesToRemove.size > 0) {
    console.log("\n⚠️  Entities removed due to frequency thresholds (showing up to 10):");
    [...entitiesToRemove].slice(0, 10).forEach(key => {
      const hits = entityHits.get(key) ?? 0;
      const percent = ((hits / comments.length) * 100).toFixed(2);
      console.log(`      - ${key} (${hits} units, ${percent}%)`);
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
  
  const entityRows = db.prepare(
    "SELECT category, label, terms FROM entity_taxonomy"
  ).all() as Array<{ category: string; label: string; terms: string }>;
  
  if (entityRows.length === 0) {
    console.log("❌ No entities found in database");
    return;
  }
  console.log(`   Found ${entityRows.length} entities to match`);
  
  const matcher = new TermMatcher();
  const byKey = new Map<string, { category: string; label: string }>();
  for (const row of entityRows) {
    const entityKey = `${row.category}|${row.label}`;
    byKey.set(entityKey, { category: row.category, label: row.label });
    for (const term of JSON.parse(row.terms) as string[]) matcher.add(term, entityKey);
  }
  
  db.prepare("DELETE FROM comment_entities").run();
  const insertAnnotation = db.prepare(
    `INSERT OR IGNORE INTO comment_entities (comment_id, category, entity_label)
     VALUES (?, ?, ?)`
  );
  
  let annotationCount = 0;
  withTransaction(db, () => {
    for (const comment of comments) {
      for (const key of matcher.match(comment.content)) {
        const e = byKey.get(key)!;
        insertAnnotation.run(comment.id, e.category, e.label);
        annotationCount++;
      }
    }
  });
  
  console.log(`   💡 Created ${annotationCount} entity annotations over ${comments.length} units`);
}

// Case-sensitive, whole-word term matching (same semantics as /\bTERM\b/) in one pass per text.
// Terms are indexed by their leading word (\w+ run); each word in the text is looked up and the
// candidates verified in place, so the cost is linear in text length rather than texts × terms
// regex scans (which also had a bug: /g regexes reused across texts carried lastIndex over and
// missed matches).
export class TermMatcher {
  private byFirstWord = new Map<string, { term: string; key: string }[]>();
  private fallback: { regex: RegExp; key: string }[] = [];

  add(term: string, key: string) {
    if (!term) return;
    const first = term.match(/^\w+/);
    if (!first) {
      this.fallback.push({ regex: new RegExp(`\\b${escapeRegex(term)}\\b`), key });
      return;
    }
    const list = this.byFirstWord.get(first[0]) || [];
    list.push({ term, key });
    this.byFirstWord.set(first[0], list);
  }

  match(text: string): Set<string> {
    const found = new Set<string>();
    if (!text) return found;
    const word = /\w+/g;
    let m: RegExpExecArray | null;
    while ((m = word.exec(text))) {
      const candidates = this.byFirstWord.get(m[0]);
      if (!candidates) continue;
      for (const c of candidates) {
        if (found.has(c.key) || !text.startsWith(c.term, m.index)) continue;
        // \b after the term: word-ness of its last char differs from the next char's
        const next = text[m.index + c.term.length];
        if (isWordChar(c.term[c.term.length - 1]) !== isWordChar(next)) found.add(c.key);
      }
    }
    for (const f of this.fallback) if (!found.has(f.key) && f.regex.test(text)) found.add(f.key);
    return found;
  }
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /\w/.test(ch);
}

// Escape regex special characters
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
