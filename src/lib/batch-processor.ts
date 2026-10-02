import { Batch } from "../types";

export interface BatchOptions {
  totalWordLimit: number;  // When to start batching (default 200k)
  batchWordLimit: number;  // Target size per batch (default 100k)
}

export const DEFAULT_BATCH_OPTIONS: BatchOptions = {
  totalWordLimit: 250_000,
  batchWordLimit: 150_000,
};

export function countWords(text: string): number {
  return text.split(/\s+/).filter(w => w.length > 0).length;
}

export function createBatches<T extends { wordCount: number }>(
  items: T[],
  options: Partial<BatchOptions> = {}
): Batch<T>[] {
  const opts = { ...DEFAULT_BATCH_OPTIONS, ...options };
  
  // Calculate total word count
  const totalWords = items.reduce((sum, item) => sum + item.wordCount, 0);
  
  // If under the total limit, return single batch
  if (totalWords <= opts.totalWordLimit) {
    return [{
      items,
      wordCount: totalWords,
      number: 1
    }];
  }
  
  // Otherwise, create multiple batches
  const batches: Batch<T>[] = [];
  let currentBatch: T[] = [];
  let currentWordCount = 0;
  let batchNumber = 1;
  
  for (const item of items) {
    // If adding this item would exceed batch limit, start new batch
    if (currentWordCount > 0 && currentWordCount + item.wordCount > opts.batchWordLimit) {
      batches.push({
        items: currentBatch,
        wordCount: currentWordCount,
        number: batchNumber++
      });
      currentBatch = [];
      currentWordCount = 0;
    }
    
    currentBatch.push(item);
    currentWordCount += item.wordCount;
  }
  
  // Add final batch
  if (currentBatch.length > 0) {
    batches.push({
      items: currentBatch,
      wordCount: currentWordCount,
      number: batchNumber
    });
  }
  
  return batches;
}

// Create evenly-sized batches (by word count)
export function createEvenBatches<T extends { wordCount: number }>(
  items: T[],
  options: Partial<BatchOptions> = {}
): Batch<T>[] {
  const opts = { ...DEFAULT_BATCH_OPTIONS, ...options };
  const totalWords = items.reduce((sum, item) => sum + item.wordCount, 0);
  
  if (totalWords <= opts.totalWordLimit) {
    return [{
      items,
      wordCount: totalWords,
      number: 1
    }];
  }
  
  // Calculate number of batches needed
  const numBatches = Math.ceil(totalWords / opts.batchWordLimit);
  const targetWordsPerBatch = Math.ceil(totalWords / numBatches);
  
  // Sort items by word count descending for better distribution
  const sortedItems = [...items].sort((a, b) => b.wordCount - a.wordCount);
  
  // Initialize batches
  const batches: Batch<T>[] = Array.from({ length: numBatches }, (_, i) => ({
    items: [],
    wordCount: 0,
    number: i + 1
  }));
  
  // Distribute items using a greedy algorithm
  for (const item of sortedItems) {
    // Find batch with lowest word count
    const targetBatch = batches.reduce((min, batch) => 
      batch.wordCount < min.wordCount ? batch : min
    );
    
    targetBatch.items.push(item);
    targetBatch.wordCount += item.wordCount;
  }
  
  // Filter out empty batches and restore original order within batches
  // (index map: items.indexOf inside the comparator was quadratic, minutes for themes with thousands of extracts)
  const position = new Map<T, number>(items.map((item, i) => [item, i]));
  return batches
    .filter(b => b.items.length > 0)
    .map(batch => ({
      ...batch,
      items: batch.items.sort((a, b) => position.get(a)! - position.get(b)!)
    }));
}
