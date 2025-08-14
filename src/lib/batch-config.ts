import { readFileSync } from "fs";
import { join } from "path";

export interface BatchConfig {
  triggerWordLimit: number;
  batchWordLimit: number;
  description?: string;
}

export interface TaskConfig {
  concurrency?: number;
  mergeWidth?: number;
  model?: string;
  batching?: boolean | BatchConfig;
  validation?: Record<string, any>;
  thresholds?: Record<string, any>;
  description?: string;
}

export interface EntityTaskConfig {
  concurrency?: number;
  model?: string;
  stages?: {
    categoryDiscovery?: {
      mergeWidth?: number;
      model?: string;
      batching?: BatchConfig;
      description?: string;
    };
    entityExtraction?: {
      model?: string;
      batching?: BatchConfig;
      timeoutPerBatch?: number;
      maxFailures?: number;
      description?: string;
    };
  };
}

export interface BatchConfigFile {
  global: {
    concurrency: { default: number; description?: string };
    mergeWidth: { default: number; description?: string };
    defaultModel?: string;
  };
  tasks: {
    condense?: TaskConfig;
    discoverThemes?: TaskConfig;
    summarizeThemes?: TaskConfig;
    extractThemeContent?: TaskConfig;
    discoverEntities?: EntityTaskConfig;
    loadComments?: {
      rateLimiting?: {
        apiCallDelay?: number;
        attachmentDelay?: number;
        pageSize?: number;
        description?: string;
      };
    };
  };
  pipeline?: {
    errorHandling?: {
      maxCrashes?: number;
      defaultRetryDelay?: number;
      description?: string;
    };
  };
  models?: Record<string, {
    concurrency?: number;
    description?: string;
  }>;
}

let configCache: BatchConfigFile | null = null;

export function loadBatchConfig(configPath?: string): BatchConfigFile {
  if (configCache && !configPath) {
    return configCache;
  }

  const path = configPath || join(process.cwd(), "batch-config.json");
  
  try {
    const configData = readFileSync(path, "utf-8");
    configCache = JSON.parse(configData);
    return configCache!;
  } catch (error) {
    console.warn(`Warning: Could not load batch config from ${path}, using defaults`);
    // Return default config
    return {
      global: {
        concurrency: { default: 5 },
        mergeWidth: { default: 10 }
      },
      tasks: {}
    };
  }
}

export function getTaskConfig(taskName: keyof BatchConfigFile['tasks'], model?: string): {
  concurrency: number;
  mergeWidth: number;
  batching?: boolean | BatchConfig;
  validation?: Record<string, any>;
  thresholds?: Record<string, any>;
  stages?: EntityTaskConfig['stages'];
  rateLimiting?: any;
} {
  const config = loadBatchConfig();
  const taskConfig = config.tasks[taskName] || {};
  const globalDefaults = config.global;
  
  // Calculate effective concurrency based on model
  let concurrency = (taskConfig as any).concurrency || globalDefaults.concurrency.default;
  if (model && config.models?.[model]?.concurrency) {
    concurrency = Math.round(concurrency * config.models[model].concurrency);
  }
  
  return {
    concurrency,
    mergeWidth: (taskConfig as any).mergeWidth || globalDefaults.mergeWidth.default,
    ...(taskConfig as any)
  };
}

export function getBatchOptions(taskName: keyof BatchConfigFile['tasks'], stage?: string): BatchConfig | null {
  const taskConfig = getTaskConfig(taskName);
  
  if (taskName === 'discoverEntities' && stage && taskConfig.stages) {
    const stageConfig = taskConfig.stages[stage as keyof EntityTaskConfig['stages']];
    return stageConfig?.batching || null;
  }
  
  if ('batching' in taskConfig && typeof taskConfig.batching === 'object' && taskConfig.batching) {
    return taskConfig.batching;
  }
  
  return null;
}

export function getStageConfig(taskName: keyof BatchConfigFile['tasks'], stageName: string): {
  mergeWidth?: number;
  model?: string;
  batching?: BatchConfig;
  description?: string;
} | null {
  const config = loadBatchConfig();
  const taskConfig = config.tasks[taskName];
  
  if (taskName === 'discoverEntities' && (taskConfig as EntityTaskConfig)?.stages) {
    const stages = (taskConfig as EntityTaskConfig).stages!;
    return stages[stageName as keyof typeof stages] || null;
  }
  
  return null;
}

export function getTaskModel(taskName: keyof BatchConfigFile['tasks'], cliModel?: string, stage?: string): string {
  const config = loadBatchConfig();
  const taskConfig = config.tasks[taskName];
  
  // Priority order:
  // 1. CLI override
  if (cliModel) return cliModel;
  
  // 2. Stage-specific model (for entity discovery)
  if (stage && taskName === 'discoverEntities' && (taskConfig as EntityTaskConfig)?.stages) {
    const entityConfig = taskConfig as EntityTaskConfig;
    if (stage === 'categoryDiscovery' && entityConfig.stages?.categoryDiscovery?.model) {
      return entityConfig.stages.categoryDiscovery.model;
    }
    if (stage === 'entityExtraction' && entityConfig.stages?.entityExtraction?.model) {
      return entityConfig.stages.entityExtraction.model;
    }
  }
  
  // 3. Task-specific model
  if ((taskConfig as any)?.model) return (taskConfig as any).model;
  console.log("⚠️ No specific model configured for task, using global defaults", taskConfig);
  
  // 4. Global default model
  if (config.global.defaultModel) return config.global.defaultModel;
  
  // 5. Hardcoded fallback
  return 'gemini-pro';
}