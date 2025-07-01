import { LRUCache } from 'lru-cache';
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
  private cache: LRUCache<string, any>;

  constructor(config: FetcherConfig = {}) {
    this.baseUrl = config.baseUrl || process.env.REGULATIONS_BASE_URL || DEFAULT_BASE_URL;
    
    this.cache = new LRUCache({
      max: config.cacheSize || parseInt(process.env.CACHE_MAX_SIZE || '') || DEFAULT_CACHE_SIZE,
      ttl: config.cacheTTL || parseInt(process.env.CACHE_TTL_MINUTES || '') * 60 * 1000 || DEFAULT_CACHE_TTL,
      updateAgeOnGet: true,
      updateAgeOnHas: true,
    });
  }

  /**
   * Fetch JSON data from the published site with caching
   */
  private async fetchJson<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const cacheKey = url;

    // Check cache first
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      return cached as T;
    }

    try {
      const response = await fetch(url);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      
      // Cache the result
      this.cache.set(cacheKey, data);
      
      return data as T;
    } catch (error) {
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
    return {
      size: this.cache.size,
      maxSize: this.cache.max,
      ttl: this.cache.ttl,
    };
  }

  /**
   * Clear the cache
   */
  clearCache() {
    this.cache.clear();
  }
}