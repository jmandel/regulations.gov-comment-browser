import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { DataFetcher } from '../../src/data/fetcher';

// Mock fetch globally
const mockFetch = mock(() => Promise.resolve({
  ok: true,
  status: 200,
  statusText: 'OK',
  headers: {
    get: (name: string) => null
  },
  json: () => Promise.resolve({})
}));

global.fetch = mockFetch as any;

describe('DataFetcher', () => {
  let fetcher: DataFetcher;

  beforeEach(() => {
    // Set a test-specific cache directory
    process.env.DISK_CACHE_DIR = `/tmp/test-cache-${Date.now()}-${Math.random()}`;
    
    // Clear the mock completely
    mockFetch.mockClear();
    mockFetch.mockReset();
    
    // Reset the default mock implementation
    mockFetch.mockImplementation(() => Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: {
        get: (name: string) => null
      },
      json: () => Promise.resolve({})
    }));
    
    fetcher = new DataFetcher({
      baseUrl: 'https://example.com',
      cacheSize: 10,
      cacheTTL: 5000
    });
    
    // Clear any existing cache
    fetcher.clearCache();
  });
  
  afterEach(() => {
    // Clean up the test cache directory
    if (process.env.DISK_CACHE_DIR) {
      delete process.env.DISK_CACHE_DIR;
    }
  });

  describe('constructor', () => {
    it('should use provided config', () => {
      const stats = fetcher.getCacheStats();
      expect(stats.maxSize).toBe(10);
      expect(stats.ttl).toBe(5000);
    });

    it('should use environment variables', () => {
      process.env.REGULATIONS_BASE_URL = 'https://env-test.com';
      process.env.CACHE_MAX_SIZE = '20';
      process.env.CACHE_TTL_MINUTES = '10';

      const envFetcher = new DataFetcher();
      const stats = envFetcher.getCacheStats();
      expect(stats.maxSize).toBe(20);
      expect(stats.ttl).toBe(10 * 60 * 1000);

      // Clean up
      delete process.env.REGULATIONS_BASE_URL;
      delete process.env.CACHE_MAX_SIZE;
      delete process.env.CACHE_TTL_MINUTES;
    });
  });

  describe('getDocketMeta', () => {
    it('should fetch docket metadata', async () => {
      const mockMeta = {
        id: 'TEST-2024-0001',
        title: 'Test Docket',
        commentCount: 100
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {
          get: (name: string) => null
        },
        json: () => Promise.resolve(mockMeta)
      });

      const result = await fetcher.getDocketMeta('TEST-2024-0001');
      
      expect(mockFetch).toHaveBeenCalledWith('https://example.com/TEST-2024-0001/data/meta.json');
      expect(result).toEqual(mockMeta);
    });

    it('should cache results', async () => {
      const mockMeta = { id: 'TEST-2024-0001' };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {
          get: (name: string) => null
        },
        json: () => Promise.resolve(mockMeta)
      });

      // First call
      await fetcher.getDocketMeta('TEST-2024-0001');
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Second call should use cache
      const cached = await fetcher.getDocketMeta('TEST-2024-0001');
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(cached).toEqual(mockMeta);
    });

    it('should handle fetch errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        headers: {
          get: (name: string) => null
        },
        json: () => Promise.reject(new Error('Not JSON'))
      });

      await expect(fetcher.getDocketMeta('MISSING')).rejects.toThrow('HTTP 404: Not Found');
    });

    it('should handle network errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      await expect(fetcher.getDocketMeta('TEST')).rejects.toThrow('Failed to fetch');
    });
  });

  describe('getComments', () => {
    it('should fetch comments', async () => {
      const mockComments = [
        { commentId: '1', comment: 'Test comment 1' },
        { commentId: '2', comment: 'Test comment 2' }
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {
          get: (name: string) => null
        },
        json: () => Promise.resolve(mockComments)
      });

      const result = await fetcher.getComments('TEST-2024-0001');
      
      expect(mockFetch).toHaveBeenCalledWith('https://example.com/TEST-2024-0001/data/comments.json');
      expect(result).toEqual(mockComments);
      expect(result).toHaveLength(2);
    });
  });

  describe('listDockets', () => {
    it('should list known dockets', async () => {
      const mockMeta = {
        id: 'CMS-2025-0050-0031',
        title: 'Test CMS Docket',
        commentCount: 1000
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {
          get: (name: string) => null
        },
        json: () => Promise.resolve(mockMeta)
      });

      const result = await fetcher.listDockets();
      
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(mockMeta);
    });

    it('should handle errors gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await fetcher.listDockets();
      
      expect(result).toHaveLength(0);
    });
  });

  describe('cache management', () => {
    it('should clear cache', async () => {
      const mockData = { test: 'data' };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {
          get: (name: string) => null
        },
        json: () => Promise.resolve(mockData)
      });

      // Populate cache
      await fetcher.getDocketMeta('TEST');
      expect(fetcher.getCacheStats().size).toBe(1);

      // Clear cache
      fetcher.clearCache();
      expect(fetcher.getCacheStats().size).toBe(0);

      // Next call should fetch again
      await fetcher.getDocketMeta('TEST');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});