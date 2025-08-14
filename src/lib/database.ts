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
    -- Document metadata from regulations.gov
    CREATE TABLE IF NOT EXISTS document_metadata (
      document_id TEXT PRIMARY KEY,
      title TEXT,
      docket_id TEXT,
      agency_id TEXT,
      agency_name TEXT,
      document_type TEXT,
      posted_date TEXT,
      comment_start_date TEXT,
      comment_end_date TEXT,
      metadata_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    
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
      cluster_size INTEGER DEFAULT 1, -- Number of comments this extract represents
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (comment_id, theme_code),
      FOREIGN KEY (comment_id) REFERENCES comments(id),
      FOREIGN KEY (theme_code) REFERENCES theme_hierarchy(code)
    );
    
    -- Index for efficient theme-based queries
    CREATE INDEX IF NOT EXISTS idx_theme_extracts_theme ON comment_theme_extracts(theme_code);
    
    -- Comment clusters based on similarity analysis
    CREATE TABLE IF NOT EXISTS comment_clusters (
      cluster_id INTEGER PRIMARY KEY AUTOINCREMENT,
      representative_comment_id TEXT NOT NULL UNIQUE,
      cluster_size INTEGER NOT NULL,
      similarity_threshold REAL NOT NULL,
      cluster_method TEXT NOT NULL DEFAULT 'jaccard',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (representative_comment_id) REFERENCES comments(id)
    );
    
    -- Track all cluster members
    CREATE TABLE IF NOT EXISTS comment_cluster_membership (
      comment_id TEXT PRIMARY KEY,
      cluster_id INTEGER NOT NULL,
      is_representative BOOLEAN NOT NULL DEFAULT 0,
      similarity_score REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (comment_id) REFERENCES comments(id),
      FOREIGN KEY (cluster_id) REFERENCES comment_clusters(cluster_id)
    );
    
    -- Clustering run metadata
    CREATE TABLE IF NOT EXISTS clustering_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      total_comments INTEGER NOT NULL,
      total_clusters INTEGER NOT NULL,
      representative_count INTEGER NOT NULL,
      duplicates_filtered INTEGER NOT NULL,
      similarity_threshold REAL NOT NULL,
      min_cluster_size INTEGER NOT NULL,
      cluster_method TEXT NOT NULL DEFAULT 'jaccard',
      status TEXT DEFAULT 'completed' CHECK(status IN ('pending', 'processing', 'completed', 'failed')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME
    );
    
    -- Indexes for clustering performance
    CREATE INDEX IF NOT EXISTS idx_cluster_membership_cluster ON comment_cluster_membership(cluster_id);
    CREATE INDEX IF NOT EXISTS idx_cluster_membership_representative ON comment_cluster_membership(is_representative);
    CREATE INDEX IF NOT EXISTS idx_cluster_representative ON comment_clusters(representative_comment_id);
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
