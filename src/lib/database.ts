import { Database } from "bun:sqlite";
import { mkdir } from "fs/promises";
import { join } from "path";

export const DB_DIR = "dbs";

// Ensure dbs directory exists
await mkdir(DB_DIR, { recursive: true });

export function getDbPath(documentId: string): string {
  return join(DB_DIR, `${documentId}.sqlite`);
}

export function openDb(documentId: string): Database {
  const path = getDbPath(documentId);
  const db = new Database(path);
  
  // Use DELETE mode for simpler file management (no separate WAL files)
  db.exec("PRAGMA journal_mode = DELETE");
  
  // Initialize schema
  initSchema(db);
  
  return db;
}

export function initSchema(db: Database) {
  db.exec(`
    -- Raw comments from regulations.gov
    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      attributes_json TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    
    -- Attachments for comments
    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT,
      comment_id TEXT NOT NULL,
      format TEXT,
      file_name TEXT,
      url TEXT,
      size INTEGER,
      blob_data BLOB,
      PRIMARY KEY (id, format),
      FOREIGN KEY (comment_id) REFERENCES comments(id)
    );
    
    -- Condensed versions of comments
    CREATE TABLE IF NOT EXISTS condensed_comments (
      comment_id TEXT PRIMARY KEY,
      structured_sections TEXT NOT NULL,
      word_count INTEGER,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'completed', 'failed')),
      error_message TEXT,
      attempt_count INTEGER DEFAULT 0,
      last_attempt_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (comment_id) REFERENCES comments(id)
    );
    
    -- Merged theme hierarchy
    CREATE TABLE IF NOT EXISTS theme_hierarchy (
      code TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      level INTEGER NOT NULL,
      parent_code TEXT,
      quotes_json TEXT,
      detailed_guidelines TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (parent_code) REFERENCES theme_hierarchy(code)
    );
    
    -- Merged entity taxonomy
    CREATE TABLE IF NOT EXISTS entity_taxonomy (
      category TEXT NOT NULL,
      label TEXT NOT NULL,
      definition TEXT,
      terms TEXT NOT NULL, -- JSON array of search terms
      PRIMARY KEY (category, label)
    );
    
    -- Per-comment entity annotations
    CREATE TABLE IF NOT EXISTS comment_entities (
      comment_id TEXT NOT NULL,
      category TEXT NOT NULL,
      entity_label TEXT NOT NULL,
      PRIMARY KEY (comment_id, category, entity_label),
      FOREIGN KEY (comment_id) REFERENCES comments(id),
      FOREIGN KEY (category, entity_label) REFERENCES entity_taxonomy(category, label)
    );
    
    -- Theme summary analysis
    CREATE TABLE IF NOT EXISTS theme_summaries (
      theme_code TEXT PRIMARY KEY,
      structured_sections TEXT NOT NULL, -- JSON
      comment_count INTEGER NOT NULL,
      word_count INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (theme_code) REFERENCES theme_hierarchy(code)
    );
    
    -- Theme scoring for comments
    CREATE TABLE IF NOT EXISTS comment_themes (
      comment_id TEXT NOT NULL,
      theme_code TEXT NOT NULL,
      score INTEGER NOT NULL CHECK(score IN (1, 2, 3)),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (comment_id, theme_code),
      FOREIGN KEY (comment_id) REFERENCES comments(id),
      FOREIGN KEY (theme_code) REFERENCES theme_hierarchy(code)
    );
    
    -- Processing status for theme scoring
    CREATE TABLE IF NOT EXISTS theme_scoring_status (
      comment_id TEXT PRIMARY KEY,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'completed', 'failed')),
      error_message TEXT,
      attempt_count INTEGER DEFAULT 0,
      last_attempt_at DATETIME,
      FOREIGN KEY (comment_id) REFERENCES comments(id)
    );
    
    -- Indexes for performance
    CREATE INDEX IF NOT EXISTS idx_comments_created ON comments(created_at);
    CREATE INDEX IF NOT EXISTS idx_condensed_status ON condensed_comments(status);
    CREATE INDEX IF NOT EXISTS idx_condensed_attempts ON condensed_comments(attempt_count);
    CREATE INDEX IF NOT EXISTS idx_attachments_comment ON attachments(comment_id);
    CREATE INDEX IF NOT EXISTS idx_comment_themes_comment ON comment_themes(comment_id);
    CREATE INDEX IF NOT EXISTS idx_comment_themes_theme ON comment_themes(theme_code);
    
    -- LLM cache for prompt-level caching
    CREATE TABLE IF NOT EXISTS llm_cache (
      prompt_hash TEXT PRIMARY KEY,
      task_type TEXT NOT NULL,
      task_level INTEGER DEFAULT 0,
      task_params TEXT, -- JSON metadata
      
      result TEXT NOT NULL,
      model TEXT,
      
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    
    -- Indexes for LLM cache
    CREATE INDEX IF NOT EXISTS idx_llm_cache_task_type_level ON llm_cache(task_type, task_level);
    CREATE INDEX IF NOT EXISTS idx_llm_cache_created_at ON llm_cache(created_at);
    
    -- Theme-specific content extracts from comments
    CREATE TABLE IF NOT EXISTS comment_theme_extracts (
      comment_id TEXT NOT NULL,
      theme_code TEXT NOT NULL,
      extract_json TEXT NOT NULL, -- JSON with positions, concerns, recommendations specific to theme
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (comment_id, theme_code),
      FOREIGN KEY (comment_id) REFERENCES comments(id),
      FOREIGN KEY (theme_code) REFERENCES theme_hierarchy(code)
    );
    
    -- Index for efficient theme-based queries
    CREATE INDEX IF NOT EXISTS idx_theme_extracts_theme ON comment_theme_extracts(theme_code);
  `);
}

// Helper to get processing status
export function getProcessingStatus(db: Database, table: string): {
  total: number;
  completed: number;
  failed: number;
  pending: number;
} {
  const query = `
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN status IN ('pending', 'processing') THEN 1 ELSE 0 END) as pending
    FROM ${table}
  `;
  
  return db.prepare(query).get() as any;
}

// Transaction helper
export function withTransaction<T>(db: Database, fn: () => T): T {
  const tx = db.transaction(fn);
  return tx();
}
