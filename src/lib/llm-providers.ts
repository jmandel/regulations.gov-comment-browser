import { GoogleGenAI, type Part, type GenerateContentConfig } from "@google/genai";
import { debugStreamStart, debugStreamWrite, debugStreamEnd } from "./debug";

// Simple provider functions that just handle the generation call
// Cache logic remains in AIClient

export interface StreamingOptions {
  debugFilename?: string;
}

export interface UsageMetadata {
  promptTokenCount: number;
  cachedContentTokenCount: number;
  candidatesTokenCount: number;
  thoughtsTokenCount?: number;
}

export interface GenerationResult {
  text: string;
  usageMetadata?: UsageMetadata;
}

// Model names accepted by --model / batch-config.json → Gemini API model IDs and per-model config.
// Defaults (batch-config.json): gemini-3.5-flash-lite for mechanical work (transcription),
// gemini-3.8-flash for everything else.
// 3.8 Flash can't turn thinking off; "minimal" was the cheapest level with no quality loss in a
// 2026-10 trial. 3.5 Flash-Lite doesn't think unless given a thinking budget.
export const GEMINI_MODELS: Record<string, { id: string; config?: GenerateContentConfig }> = {
  "gemini-3.8-flash": { id: "gemini-3.8-flash", config: { thinkingConfig: { thinkingLevel: "minimal" } as any } },
  // Same model with a zero thinking budget (the API still allows a little thinking)
  "gemini-3.8-flash-nothink": { id: "gemini-3.8-flash", config: { thinkingConfig: { thinkingBudget: 0 } } },
  "gemini-3.5-flash-lite": { id: "gemini-3.5-flash-lite" },
  // Legacy names, kept so existing commands and configs keep working
  "gemini-3-flash": { id: "gemini-3-flash-preview" },
  "gemini-pro": { id: "gemini-2.5-pro" },
  "gemini-flash": { id: "gemini-2.5-flash", config: { thinkingConfig: { thinkingBudget: 14000 } } },
  "gemini-flash-lite": { id: "gemini-2.5-flash-lite" },
};

export const DEFAULT_MODEL = "gemini-3.8-flash";

// Helper to handle streaming with optional debug
async function processStream<T>(
  stream: AsyncIterable<T>,
  getText: (chunk: T) => string,
  options?: StreamingOptions
): Promise<string> {
  // Start debug stream if requested
  if (options?.debugFilename) {
    debugStreamStart(options.debugFilename);
  }

  let result = "";
  try {
    for await (const chunk of stream) {
      const chunkText = getText(chunk);
      result += chunkText;

      // Stream to debug file if active
      if (options?.debugFilename && chunkText) {
        debugStreamWrite(options.debugFilename, chunkText);
      }
    }
  } finally {
    // Close debug stream
    if (options?.debugFilename) {
      debugStreamEnd(options.debugFilename);
    }
  }

  return result;
}

export function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY environment variable is required");
  }
  return new GoogleGenAI({ apiKey });
}

export function resolveGeminiModel(model: string) {
  const entry = GEMINI_MODELS[model];
  if (!entry) {
    throw new Error(`Unknown Gemini model: ${model}. Available: ${Object.keys(GEMINI_MODELS).join(", ")}`);
  }
  return { id: entry.id, config: { responseMimeType: "text/plain", ...entry.config } as GenerateContentConfig };
}

// Retry 429/503 responses with exponential backoff
async function withGeminiRetry<T>(model: string, fn: () => Promise<T>): Promise<T> {
  const MAX_RETRIES = 5;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const msg = err?.message || String(err);
      if ((msg.includes('429') || msg.includes('503')) && attempt < MAX_RETRIES - 1) {
        const backoff = Math.min(5000 * Math.pow(2, attempt), 60000);
        console.log(`   🔄 Gemini ${msg.includes('429') ? '429' : '503'}, retrying in ${(backoff/1000).toFixed(0)}s (attempt ${attempt+1}/${MAX_RETRIES})...`);
        await new Promise(r => setTimeout(r, backoff));
        continue;
      }
      throw err;
    }
  }
  throw new Error(`Max retries exceeded for ${model}`);
}

async function generateWithGemini(model: string, parts: Part[], options?: StreamingOptions): Promise<string> {
  const { id, config } = resolveGeminiModel(model);
  const ai = getGeminiClient();
  return withGeminiRetry(model, async () => {
    const response = await ai.models.generateContentStream({
      model: id,
      config,
      contents: [{ role: "user", parts }],
    });
    return await processStream(response, chunk => chunk.text || '', options);
  });
}

// Non-streaming call with arbitrary parts and per-call config overrides; returns text and usage.
// Used by the shared step runner (src/lib/step-runner.ts).
export async function generateGeminiContent(
  model: string,
  parts: Part[],
  configOverrides?: GenerateContentConfig
): Promise<GenerationResult> {
  const { id, config } = resolveGeminiModel(model);
  const ai = getGeminiClient();
  return withGeminiRetry(model, async () => {
    const response = await ai.models.generateContent({
      model: id,
      config: { ...config, ...configOverrides },
      contents: [{ role: "user", parts }],
    });
    return { text: response.text || '', usageMetadata: toUsage(response.usageMetadata) };
  });
}

export function toUsage(u: any): UsageMetadata | undefined {
  if (!u) return undefined;
  return {
    promptTokenCount: u.promptTokenCount || 0,
    cachedContentTokenCount: u.cachedContentTokenCount || 0,
    candidatesTokenCount: u.candidatesTokenCount || 0,
    thoughtsTokenCount: u.thoughtsTokenCount || 0,
  };
}

// Non-streaming variant that returns usage metadata for cache monitoring
export async function generateWithGeminiMetadata(model: string, prompt: string, options?: StreamingOptions): Promise<GenerationResult> {
  const { id, config } = resolveGeminiModel(model);
  const ai = getGeminiClient();
  return withGeminiRetry(model, async () => {
    const response = await ai.models.generateContent({
      model: id,
      config,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    });

    const text = response.text || '';

    // Save to debug file if requested
    if (options?.debugFilename) {
      debugStreamStart(options.debugFilename);
      debugStreamWrite(options.debugFilename, text);
      debugStreamEnd(options.debugFilename);
    }

    const usageMetadata = toUsage(response.usageMetadata);

    return { text, usageMetadata };
  });
}

export async function generateWithClaude(prompt: string, options?: StreamingOptions): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY environment variable is required");
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 8192,
      temperature: 0,
      messages: [{
        role: "user",
        content: prompt
      }]
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Claude API error: ${response.status} - ${error}`);
  }

  const data = await response.json() as { content: Array<{ text: string }> };
  const result = data.content[0].text;

  // Save to debug file if requested (Claude doesn't stream)
  if (options?.debugFilename) {
    debugStreamStart(options.debugFilename);
    debugStreamWrite(options.debugFilename, result);
    debugStreamEnd(options.debugFilename);
  }

  return result;
}

export type GenerationFunction = (prompt: string, options?: StreamingOptions) => Promise<string>;

// Multimodal generation (accepts Part[] with inline binary data)
export type MultimodalGenerationFunction = (parts: Part[], options?: StreamingOptions) => Promise<string>;

export function getMultimodalGenerationFunction(model: string): MultimodalGenerationFunction {
  if (!GEMINI_MODELS[model]) {
    throw new Error(`No multimodal support for model: ${model}. Available: ${Object.keys(GEMINI_MODELS).join(", ")}`);
  }
  return (parts, options) => generateWithGemini(model, parts, options);
}

// Get the appropriate generation function based on model selection
export function getGenerationFunction(model: string = DEFAULT_MODEL): GenerationFunction {
  if (model === "claude") return generateWithClaude;
  if (!GEMINI_MODELS[model]) {
    throw new Error(`Unknown model: ${model}. Available: ${[...Object.keys(GEMINI_MODELS), "claude"].join(", ")}`);
  }
  return (prompt, options) => generateWithGemini(model, [{ text: prompt }], options);
}
