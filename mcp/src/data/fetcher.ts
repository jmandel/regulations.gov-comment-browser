import { LRUCache } from 'lru-cache';
import { DiskCache } from './disk-cache';
import type { 
  Comment, 
  Theme, 
  ThemeSummary, 
  EntityTaxonomy, 
  DocketMeta 
} from './types';

// Configuration
const DEFAULT_BASE_URL = 'https://joshuamandel.com/regulations.gov-comment-browser';
const DEFAULT_CACHE_SIZE = 100;
const DEFAULT_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

export interface FetcherConfig {
  baseUrl?: string;
  cacheSize?: number;
  cacheTTL?: number;
}

export class DataFetcher {
  private baseUrl: string;
  private memoryCache: LRUCache<string, any>;
  private diskCache: DiskCache;

  constructor(config: FetcherConfig = {}) {
    this.baseUrl = config.baseUrl || process.env.REGULATIONS_BASE_URL || DEFAULT_BASE_URL;
    
    // Memory cache for small items and hot data
    this.memoryCache = new LRUCache({
      max: config.cacheSize || parseInt(process.env.CACHE_MAX_SIZE || '') || DEFAULT_CACHE_SIZE,
      ttl: config.cacheTTL || parseInt(process.env.CACHE_TTL_MINUTES || '') * 60 * 1000 || DEFAULT_CACHE_TTL,
      updateAgeOnGet: true,
      updateAgeOnHas: true,
    });
    
    // Disk cache for large items with up to 4GB storage
    this.diskCache = new DiskCache(4);
    
    console.error(`[DataFetcher] Initialized with memory cache size ${this.memoryCache.max}, TTL ${this.memoryCache.ttl}ms`);
  }

  /**
   * Fetch JSON data from the published site with caching
   */
  private async fetchJson<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const cacheKey = url;

    // Check memory cache first
    const memoryCached = this.memoryCache.get(cacheKey);
    if (memoryCached !== undefined) {
      console.error(`[DataFetcher] Memory cache HIT for ${path}`);
      return memoryCached as T;
    }

    // Check disk cache
    const diskCached = this.diskCache.get(url);
    if (diskCached) {
      console.error(`[DataFetcher] Disk cache HIT for ${path}`);
      
      // Try conditional request with ETag
      if (diskCached.etag) {
        try {
          const response = await fetch(url, {
            headers: {
              'If-None-Match': diskCached.etag
            }
          });
          
          if (response.status === 304) {
            console.error(`[DataFetcher] ETag validated, content unchanged for ${path}`);
            // Put back in memory cache
            this.memoryCache.set(cacheKey, diskCached.data);
            return diskCached.data as T;
          }
          
          // If not 304, we'll re-download below
          if (response.ok) {
            const newData = await response.json();
            const newEtag = response.headers.get('etag') || undefined;
            
            // Update caches
            this.memoryCache.set(cacheKey, newData);
            this.diskCache.set(url, newData, newEtag);
            
            console.error(`[DataFetcher] ETag changed, updated ${path}`);
            return newData as T;
          }
        } catch (error) {
          console.error(`[DataFetcher] ETag validation failed for ${path}, using cached data`);
          // Put back in memory cache
          this.memoryCache.set(cacheKey, diskCached.data);
          return diskCached.data as T;
        }
      } else {
        // No ETag, just use cached data
        this.memoryCache.set(cacheKey, diskCached.data);
        return diskCached.data as T;
      }
    }

    console.error(`[DataFetcher] Cache MISS for ${path} - downloading...`);
    const startTime = Date.now();

    try {
      const response = await fetch(url);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      const etag = response.headers.get('etag') || undefined;
      const downloadTime = Date.now() - startTime;
      
      // Get size estimate
      const sizeEstimate = JSON.stringify(data).length;
      console.error(`[DataFetcher] Downloaded ${path} in ${downloadTime}ms (${Math.round(sizeEstimate / 1024)}KB)`);
      
      // Cache the result
      this.memoryCache.set(cacheKey, data);
      this.diskCache.set(url, data, etag);
      
      return data as T;
    } catch (error) {
      const failTime = Date.now() - startTime;
      console.error(`[DataFetcher] Failed to fetch ${path} after ${failTime}ms`);
      if (error instanceof Error) {
        throw new Error(`Failed to fetch ${url}: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Get docket metadata
   */
  async getDocketMeta(docketId: string): Promise<DocketMeta> {
    return this.fetchJson<DocketMeta>(`/${docketId}/data/meta.json`);
  }

  /**
   * Get all comments for a docket
   */
  async getComments(docketId: string): Promise<Comment[]> {
    return this.fetchJson<Comment[]>(`/${docketId}/data/comments.json`);
  }

  /**
   * Get theme hierarchy for a docket
   */
  async getThemes(docketId: string): Promise<Theme[]> {
    return this.fetchJson<Theme[]>(`/${docketId}/data/themes.json`);
  }

  /**
   * Get entity taxonomy for a docket
   */
  async getEntities(docketId: string): Promise<EntityTaxonomy> {
    return this.fetchJson<EntityTaxonomy>(`/${docketId}/data/entities.json`);
  }

  /**
   * Get theme summaries for a docket
   */
  async getThemeSummaries(docketId: string): Promise<Record<string, ThemeSummary>> {
    return this.fetchJson<Record<string, ThemeSummary>>(`/${docketId}/data/theme-summaries.json`);
  }

  /**
   * List available dockets (hardcoded for now)
   */
  async listDockets(): Promise<DocketMeta[]> {
    // For now, we'll hardcode known dockets
    // In the future, this could fetch from an index file
    const knownDockets = [
      'CMS-2025-0050-0031',
      // Add more as they become available
    ];

    const dockets: DocketMeta[] = [];
    
    for (const docketId of knownDockets) {
      try {
        const meta = await this.getDocketMeta(docketId);
        dockets.push(meta);
      } catch (error) {
        console.error(`Failed to fetch metadata for ${docketId}:`, error);
      }
    }

    return dockets;
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    const keys = [...this.memoryCache.keys()];
    return {
      size: this.memoryCache.size,
      maxSize: this.memoryCache.max,
      ttl: this.memoryCache.ttl,
      keys: keys,
      memoryCache: {
        size: this.memoryCache.size,
        maxSize: this.memoryCache.max,
        ttl: this.memoryCache.ttl,
        keys: keys,
      },
      diskCache: 'See disk cache logs for details'
    };
  }

  /**
   * Clear the cache
   */
  clearCache() {
    this.memoryCache.clear();
    this.diskCache.clear();
    console.error('[DataFetcher] Cleared both memory and disk caches');
  }
}