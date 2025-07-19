import { Command } from "commander";
import { openDb } from "../lib/database";

export const vacuumDbCommand = new Command("vacuum-db")
  .description("Vacuum the database to reclaim disk space and optimize performance")
  .argument("<document-id>", "Document ID")
  .option("-v, --verbose", "Show detailed vacuum information")
  .action(async (documentId: string, options: any) => {
    console.log(`🧹 Vacuuming database for ${documentId}...`);
    
    const db = openDb(documentId);
    
    try {
      // Get database size before vacuum
      const sizeBeforeQuery = db.prepare("PRAGMA page_count").get() as { page_count: number };
      const pageSizeQuery = db.prepare("PRAGMA page_size").get() as { page_size: number };
      const sizeBefore = sizeBeforeQuery.page_count * pageSizeQuery.page_size;
      
      if (options.verbose) {
        console.log(`📊 Database size before vacuum: ${(sizeBefore / 1024 / 1024).toFixed(2)} MB`);
        console.log(`📄 Pages: ${sizeBeforeQuery.page_count}, Page size: ${pageSizeQuery.page_size} bytes`);
      }
      
      const startTime = Date.now();
      
      // Run VACUUM command
      db.exec("VACUUM");
      
      const endTime = Date.now();
      const duration = endTime - startTime;
      
      // Get database size after vacuum
      const sizeAfterQuery = db.prepare("PRAGMA page_count").get() as { page_count: number };
      const sizeAfter = sizeAfterQuery.page_count * pageSizeQuery.page_size;
      const spaceReclaimed = sizeBefore - sizeAfter;
      
      console.log(`✅ Database vacuum completed in ${duration}ms`);
      
      if (options.verbose) {
        console.log(`📊 Database size after vacuum: ${(sizeAfter / 1024 / 1024).toFixed(2)} MB`);
        console.log(`📄 Pages after vacuum: ${sizeAfterQuery.page_count}`);
        console.log(`💾 Space reclaimed: ${(spaceReclaimed / 1024 / 1024).toFixed(2)} MB`);
        console.log(`📉 Size reduction: ${((spaceReclaimed / sizeBefore) * 100).toFixed(1)}%`);
      } else {
        console.log(`💾 Space reclaimed: ${(spaceReclaimed / 1024 / 1024).toFixed(2)} MB`);
      }
      
    } catch (error) {
      console.error("❌ Database vacuum failed:", error);
      process.exit(1);
    } finally {
      db.close();
    }
  });