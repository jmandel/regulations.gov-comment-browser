#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { resolve } from "path";
import { existsSync } from "fs";

// Script to clear all downstream analysis data while keeping raw comments
// This allows re-running the analysis pipeline with different settings (e.g., clustering enabled)

function clearDownstreamData(dbPath: string) {
  if (!existsSync(dbPath)) {
    console.error(`❌ Database not found: ${dbPath}`);
    return;
  }
  
  console.log(`\n🗑️  Clearing downstream analysis data from ${dbPath}`);
  const db = new Database(dbPath);
  
  try {
    // Start a transaction for safety
    db.exec("BEGIN TRANSACTION");
    
    const tablesToClear = [
      // Condensed comments and analysis
      { name: "condensed_comments", description: "condensed comment analysis" },
      
      // Theme-related tables
      { name: "theme_hierarchy", description: "theme hierarchy" },
      { name: "comment_theme_extracts", description: "theme extracts" },
      { name: "theme_summaries", description: "theme summaries" },
      
      // Entity-related tables
      { name: "entity_taxonomy", description: "entity taxonomy" },
      { name: "comment_entities", description: "comment entities" },
      
      // Clustering tables (if they exist)
      { name: "comment_clusters", description: "comment clusters" },
      { name: "comment_cluster_membership", description: "cluster membership" },
      
      // Cache table (optional - you might want to keep this)
      // { name: "llm_cache", description: "LLM cache" },
    ];
    
    let clearedCount = 0;
    
    for (const table of tablesToClear) {
      // Check if table exists
      const tableExists = db.prepare(`
        SELECT name FROM sqlite_master 
        WHERE type='table' AND name=?
      `).get(table.name);
      
      if (tableExists) {
        const countBefore = db.prepare(`SELECT COUNT(*) as count FROM ${table.name}`).get()?.count || 0;
        
        if (countBefore > 0) {
          db.exec(`DELETE FROM ${table.name}`);
          console.log(`  ✅ Cleared ${countBefore} rows from ${table.description}`);
          clearedCount++;
        } else {
          console.log(`  ⚪ ${table.description} was already empty`);
        }
      } else {
        console.log(`  ⚪ Table ${table.name} doesn't exist (skipping)`);
      }
    }
    
    // Optionally clear the LLM cache
    console.log("\n❓ Do you want to clear the LLM cache too? (y/N)");
    const clearCache = prompt("Clear cache? ") === "y";
    
    if (clearCache) {
      const cacheExists = db.prepare(`
        SELECT name FROM sqlite_master 
        WHERE type='table' AND name='llm_cache'
      `).get();
      
      if (cacheExists) {
        const cacheCount = db.prepare("SELECT COUNT(*) as count FROM llm_cache").get()?.count || 0;
        if (cacheCount > 0) {
          db.exec("DELETE FROM llm_cache");
          console.log(`  ✅ Cleared ${cacheCount} cached LLM responses`);
        }
      }
    } else {
      console.log("  ⚪ Keeping LLM cache intact");
    }
    
    // Commit the transaction
    db.exec("COMMIT");
    
    // Show remaining data
    const commentCount = db.prepare("SELECT COUNT(*) as count FROM comments").get()?.count || 0;
    const attachmentCount = db.prepare(`
      SELECT COUNT(*) as count FROM sqlite_master 
      WHERE type='table' AND name='attachments'
    `).get() ? 
      db.prepare("SELECT COUNT(*) as count FROM attachments").get()?.count || 0 : 0;
    
    console.log("\n📊 Database status after cleanup:");
    console.log(`  • ${commentCount} raw comments preserved`);
    if (attachmentCount > 0) {
      console.log(`  • ${attachmentCount} attachments preserved`);
    }
    console.log(`  • ${clearedCount} tables cleared`);
    console.log("\n✨ Ready for fresh analysis! You can now run:");
    console.log("  1. bun run cli condense <document-id>");
    console.log("  2. bun run cli discover-themes <document-id>");
    console.log("  3. bun run cli extract-theme-content <document-id>");
    console.log("  4. bun run cli summarize-themes-v2 <document-id>");
    console.log("  5. bun run cli discover-entities-v2 <document-id>");
    
  } catch (error) {
    console.error("❌ Error during cleanup:", error);
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

// Main execution
const args = process.argv.slice(2);

if (args.length === 0) {
  console.log("Usage: bun scripts/clear-downstream-analysis.ts <document-id or db-path>");
  console.log("\nExamples:");
  console.log("  bun scripts/clear-downstream-analysis.ts AHRQ-2025-0001-0001");
  console.log("  bun scripts/clear-downstream-analysis.ts dbs/AHRQ-2025-0001-0001.sqlite");
  process.exit(1);
}

const input = args[0];
const dbPath = input.endsWith(".sqlite") 
  ? resolve(process.cwd(), input)
  : resolve(process.cwd(), "dbs", `${input}.sqlite`);

clearDownstreamData(dbPath);