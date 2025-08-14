#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { resolve } from "path";
import { existsSync } from "fs";

// Script to patch truncated theme descriptions in existing databases
// Fixes issues where descriptions like "Harm to U.S" should be "Harm to U.S. Citizen Children"

function patchDatabase(dbPath: string) {
  if (!existsSync(dbPath)) {
    console.error(`Database not found: ${dbPath}`);
    return;
  }
  
  console.log(`\n📝 Patching themes in ${dbPath}`);
  const db = new Database(dbPath);
  
  try {
    // Check if detailed_guidelines column exists
    const hasDetailedGuidelines = db.prepare(`
      SELECT COUNT(*) as count 
      FROM pragma_table_info('theme_hierarchy') 
      WHERE name='detailed_guidelines'
    `).get()?.count > 0;
    
    if (!hasDetailedGuidelines) {
      console.log("  ⚠️  No detailed_guidelines column, skipping");
      return;
    }
    
    // Find themes that appear truncated
    const truncatedThemes = db.prepare(`
      SELECT code, description, detailed_guidelines
      FROM theme_hierarchy
      WHERE detailed_guidelines IS NOT NULL
        AND (
          description LIKE '% U.S' 
          OR description LIKE '% U.K'
          OR description LIKE '% vs'
          OR description LIKE '% Dr'
          OR description LIKE '% Mr'
          OR description LIKE '% Mrs'
          OR description LIKE '% Ms'
          OR description LIKE '% Inc'
          OR description LIKE '% Ltd'
          OR description LIKE '% Corp'
          OR (length(description) < 50 AND description NOT LIKE '%.%')
        )
    `).all();
    
    if (truncatedThemes.length === 0) {
      console.log("  ✅ No truncated themes found");
      return;
    }
    
    console.log(`  🔍 Found ${truncatedThemes.length} potentially truncated themes`);
    
    const updateStmt = db.prepare(`
      UPDATE theme_hierarchy 
      SET description = ? 
      WHERE code = ?
    `);
    
    let patchedCount = 0;
    
    for (const theme of truncatedThemes) {
      const { code, description, detailed_guidelines } = theme;
      
      // Combine description with detailed_guidelines and reparse
      const combined = description + ". " + detailed_guidelines;
      
      // Apply the same parsing logic to extract the proper label
      // Look for the first sentence that's not cut off by abbreviations
      let newDescription = description;
      
      // Handle common abbreviations - don't split on these
      const abbreviations = ['U.S.', 'U.K.', 'vs.', 'Dr.', 'Mr.', 'Mrs.', 'Ms.', 'Inc.', 'Ltd.', 'Corp.'];
      
      // Find the first real sentence boundary
      // Split on ". " but check if it's preceded by known abbreviations
      const sentences = combined.split(/\.\s+/);
      
      if (sentences.length >= 2) {
        // Take the first sentence as the description
        let firstSentence = sentences[0];
        
        // Check if we accidentally split on an abbreviation
        for (const abbr of abbreviations) {
          const abbrWithoutPeriod = abbr.slice(0, -1); // Remove trailing period
          if (firstSentence.endsWith(' ' + abbrWithoutPeriod)) {
            // We split on an abbreviation, include the next part
            firstSentence = firstSentence + '. ' + (sentences[1] || '');
            break;
          }
        }
        
        newDescription = firstSentence;
      }
      
      if (newDescription !== description) {
        console.log(`  📝 ${code}: "${description}" → "${newDescription}"`);
        updateStmt.run(newDescription, code);
        patchedCount++;
      }
    }
    
    if (patchedCount > 0) {
      console.log(`  ✅ Patched ${patchedCount} themes`);
    } else {
      console.log(`  ℹ️  No themes needed patching`);
    }
    
  } finally {
    db.close();
  }
}

// Main execution
const args = process.argv.slice(2);

if (args.length === 0) {
  // Patch all databases in dbs/ directory
  console.log("🔧 Patching all databases in dbs/ directory...");
  
  const dbsDir = resolve(process.cwd(), "dbs");
  if (!existsSync(dbsDir)) {
    console.error("No dbs/ directory found");
    process.exit(1);
  }
  
  const { readdirSync } = require("fs");
  const files = readdirSync(dbsDir);
  const sqliteFiles = files.filter((f: string) => f.endsWith(".sqlite"));
  
  console.log(`Found ${sqliteFiles.length} SQLite databases`);
  
  for (const file of sqliteFiles) {
    patchDatabase(resolve(dbsDir, file));
  }
} else {
  // Patch specific database
  const dbPath = args[0].endsWith(".sqlite") ? args[0] : `dbs/${args[0]}.sqlite`;
  patchDatabase(resolve(process.cwd(), dbPath));
}

console.log("\n✨ Done!");