import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { tmpdir } from 'os';

interface CacheEntry {
  etag?: string;
  data: any;
  timestamp: number;
  size: number;
}

interface CacheMetadata {
  url: string;
  etag?: string;
  timestamp: number;
  size: number;
}

export class DiskCache {
  private cacheDir: string;
  private maxSize: number;
  private metadataFile: string;
  
  constructor(maxSizeGB: number = 4) {
    // Use system temp directory for cache
    this.cacheDir = process.env.DISK_CACHE_DIR || join(tmpdir(), 'regulations-gov-cache');
    this.maxSize = maxSizeGB * 1024 * 1024 * 1024; // Convert GB to bytes
    this.metadataFile = join(this.cacheDir, 'cache-metadata.json');
    
    // Ensure cache directory exists
    if (!existsSync(this.cacheDir)) {
      mkdirSync(this.cacheDir, { recursive: true });
      console.error(`[DiskCache] Created cache directory: ${this.cacheDir}`);
    }
    
    console.error(`[DiskCache] Initialized with ${maxSizeGB}GB limit at ${this.cacheDir}`);
    this.reportCacheSize();
  }
  
  /**
   * Get cache file path for a URL
   */
  private getCachePath(url: string): string {
    const hash = createHash('sha256').update(url).digest('hex');
    return join(this.cacheDir, `${hash}.json`);
  }
  
  /**
   * Get metadata for all cached items
   */
  private getMetadata(): Record<string, CacheMetadata> {
    if (!existsSync(this.metadataFile)) {
      return {};
    }
    try {
      return JSON.parse(readFileSync(this.metadataFile, 'utf-8'));
    } catch (error) {
      console.error('[DiskCache] Failed to read metadata:', error);
      return {};
    }
  }
  
  /**
   * Save metadata
   */
  private saveMetadata(metadata: Record<string, CacheMetadata>) {
    try {
      writeFileSync(this.metadataFile, JSON.stringify(metadata, null, 2));
    } catch (error) {
      console.error('[DiskCache] Failed to save metadata:', error);
    }
  }
  
  /**
   * Get total cache size
   */
  private getTotalCacheSize(): number {
    let totalSize = 0;
    try {
      const files = readdirSync(this.cacheDir);
      for (const file of files) {
        if (file.endsWith('.json') && file !== 'cache-metadata.json') {
          const stats = statSync(join(this.cacheDir, file));
          totalSize += stats.size;
        }
      }
    } catch (error) {
      console.error('[DiskCache] Failed to calculate cache size:', error);
    }
    return totalSize;
  }
  
  /**
   * Report cache size
   */
  private reportCacheSize() {
    const totalSize = this.getTotalCacheSize();
    const usedGB = (totalSize / (1024 * 1024 * 1024)).toFixed(2);
    const maxGB = (this.maxSize / (1024 * 1024 * 1024)).toFixed(0);
    console.error(`[DiskCache] Current size: ${usedGB}GB / ${maxGB}GB`);
  }
  
  /**
   * Evict old entries if cache is too large
   */
  private evictIfNeeded(newSize: number) {
    const currentSize = this.getTotalCacheSize();
    if (currentSize + newSize <= this.maxSize) {
      return;
    }
    
    console.error('[DiskCache] Cache size limit reached, evicting old entries...');
    const metadata = this.getMetadata();
    
    // Sort by timestamp (oldest first)
    const entries = Object.entries(metadata).sort((a, b) => a[1].timestamp - b[1].timestamp);
    
    let freedSpace = 0;
    const updatedMetadata = { ...metadata };
    
    for (const [url, meta] of entries) {
      if (currentSize - freedSpace + newSize <= this.maxSize) {
        break;
      }
      
      const cachePath = this.getCachePath(url);
      if (existsSync(cachePath)) {
        unlinkSync(cachePath);
        freedSpace += meta.size;
        delete updatedMetadata[url];
        console.error(`[DiskCache] Evicted ${url} (${(meta.size / 1024 / 1024).toFixed(1)}MB)`);
      }
    }
    
    this.saveMetadata(updatedMetadata);
  }
  
  /**
   * Get cached data and ETag
   */
  get(url: string): { data: any; etag?: string } | null {
    const cachePath = this.getCachePath(url);
    
    if (!existsSync(cachePath)) {
      return null;
    }
    
    try {
      const content = readFileSync(cachePath, 'utf-8');
      const entry: CacheEntry = JSON.parse(content);
      
      console.error(`[DiskCache] HIT for ${url} (${(entry.size / 1024 / 1024).toFixed(1)}MB)`);
      return {
        data: entry.data,
        etag: entry.etag
      };
    } catch (error) {
      console.error(`[DiskCache] Failed to read cache for ${url}:`, error);
      return null;
    }
  }
  
  /**
   * Store data with optional ETag
   */
  set(url: string, data: any, etag?: string) {
    const cachePath = this.getCachePath(url);
    const entry: CacheEntry = {
      data,
      etag,
      timestamp: Date.now(),
      size: 0 // Will be updated after writing
    };
    
    try {
      const content = JSON.stringify(entry);
      entry.size = Buffer.byteLength(content);
      
      // Check if we need to evict old entries
      this.evictIfNeeded(entry.size);
      
      // Write the cache file
      writeFileSync(cachePath, content);
      
      // Update metadata
      const metadata = this.getMetadata();
      metadata[url] = {
        url,
        etag,
        timestamp: entry.timestamp,
        size: entry.size
      };
      this.saveMetadata(metadata);
      
      console.error(`[DiskCache] Stored ${url} (${(entry.size / 1024 / 1024).toFixed(1)}MB)`);
      this.reportCacheSize();
    } catch (error) {
      console.error(`[DiskCache] Failed to write cache for ${url}:`, error);
    }
  }
  
  /**
   * Check if we have a cached version with a specific ETag
   */
  hasETag(url: string, etag: string): boolean {
    const cached = this.get(url);
    return cached?.etag === etag;
  }
  
  /**
   * Clear all cache
   */
  clear() {
    try {
      const files = readdirSync(this.cacheDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          unlinkSync(join(this.cacheDir, file));
        }
      }
      console.error('[DiskCache] Cleared all cache');
    } catch (error) {
      console.error('[DiskCache] Failed to clear cache:', error);
    }
  }
}