import { GoogleGenAI } from "@google/genai";
import { debugStreamStart, debugStreamWrite, debugStreamEnd } from "./debug";

// Simple provider functions that just handle the generation call
// Cache logic remains in AIClient

export interface StreamingOptions {
  debugFilename?: string;
}

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

export async function generateWithGeminiPro(prompt: string, options?: StreamingOptions): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY environment variable is required");
  }
  
  const ai = new GoogleGenAI({ apiKey });
  
  const config = { responseMimeType: "text/plain" };
  const contents = [{
    role: "user" as const,
    parts: [{ text: prompt }]
  }];
  
  const response = await ai.models.generateContentStream({
    model: "gemini-2.5-pro-preview-06-05",
    config,
    contents,
  });
  
  return processStream(response, chunk => chunk.text || '', options);
}

export async function generateWithGeminiFlash(prompt: string, options?: StreamingOptions): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY environment variable is required");
  }
  
  const ai = new GoogleGenAI({ apiKey });
  
  const config = { 
    responseMimeType: "text/plain",
    thinkingConfig: {
      thinkingBudget: 14000,
    }
  };
  const contents = [{
    role: "user" as const,
    parts: [{ text: prompt }]
  }];
  
  const response = await ai.models.generateContentStream({
    model: "gemini-2.5-flash-preview-05-20",
    config,
    contents,
  });
  
  return processStream(response, chunk => chunk.text || '', options);
}

export async function generateWithGeminiFlashLite(prompt: string, options?: StreamingOptions): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY environment variable is required");
  }
  
  const ai = new GoogleGenAI({ apiKey });
  
  const config = { 
    responseMimeType: "text/plain",
    // thinkingConfig: {
    //   thinkingBudget: 14000,
    // }
  };
  const contents = [{
    role: "user" as const,
    parts: [{ text: prompt }]
  }];
  
  const response = await ai.models.generateContentStream({
    model: "gemini-2.5-flash-lite-preview-06-17",
    config,
    contents,
  });
  
  return processStream(response, chunk => chunk.text || '', options);
}

export async function generateWithGemini3Flash(prompt: string, options?: StreamingOptions): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY environment variable is required");
  }
  
  const ai = new GoogleGenAI({ apiKey });
  
  const config = { 
    responseMimeType: "text/plain",
  };
  const contents = [{
    role: "user" as const,
    parts: [{ text: prompt }]
  }];
  
  const MAX_RETRIES = 5;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await ai.models.generateContentStream({
        model: "gemini-3-flash-preview",
        config,
        contents,
      });
      return await processStream(response, chunk => chunk.text || '', options);
    } catch (err: any) {
      const msg = err?.message || String(err);
      if ((msg.includes('429') || msg.includes('503')) && attempt < MAX_RETRIES - 1) {
        const backoff = Math.min(5000 * Math.pow(2, attempt), 60000);
        console.log(`   \ud83d\udd04 Gemini ${msg.includes('429') ? '429' : '503'}, retrying in ${(backoff/1000).toFixed(0)}s (attempt ${attempt+1}/${MAX_RETRIES})...`);
        await new Promise(r => setTimeout(r, backoff));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Max retries exceeded for gemini-3-flash');
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

// Map of model names to generation functions
export const MODEL_FUNCTIONS = {
  "gemini-pro": generateWithGeminiPro,
  "gemini-flash": generateWithGeminiFlash,
  "gemini-flash-lite": generateWithGeminiFlashLite,
  "claude": generateWithClaude,
  "gemini-3-flash": generateWithGemini3Flash
} as const;

export type ModelName = keyof typeof MODEL_FUNCTIONS;

export type GenerationFunction = (prompt: string, options?: StreamingOptions) => Promise<string>;

// Get the appropriate generation function based on model selection
export function getGenerationFunction(model: string = "gemini-pro"): GenerationFunction {
  const fn = MODEL_FUNCTIONS[model as ModelName];
  if (!fn) {
    throw new Error(`Unknown model: ${model}. Available: ${Object.keys(MODEL_FUNCTIONS).join(", ")}`);
  }
  return fn;
}