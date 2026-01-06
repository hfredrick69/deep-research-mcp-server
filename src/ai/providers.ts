import { GoogleGenAI } from "@google/genai";
import { logger } from "../logger.js";
import { LRUCache } from 'lru-cache';
import { createHash } from 'node:crypto';
import { RecursiveCharacterTextSplitter } from './text-splitter.js';
import { getEncoding, type Tiktoken, type TiktokenEncoding } from 'js-tiktoken';
import { cosineSimilarity } from 'ai';

// Environment and client setup
function clampNumber(n: number, min: number, max: number): number {
  if (Number.isNaN(n)) {
    return min;
  }
  return Math.max(min, Math.min(max, n));
}

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  throw new Error('Missing GEMINI_API_KEY in environment variables');
}

const client = new GoogleGenAI({
  apiKey: API_KEY,
  ...(process.env.GEMINI_API_ENDPOINT ? { apiEndpoint: process.env.GEMINI_API_ENDPOINT } : {}),
});

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const MAX_TOKENS = clampNumber(parseInt(process.env.GEMINI_MAX_OUTPUT_TOKENS || '65536', 10), 1024, 65000);
const TEMPERATURE = parseFloat(process.env.GEMINI_TEMPERATURE || '0.4');
const TOP_P = parseFloat(process.env.GEMINI_TOP_P || '0.9');
const TOP_K = clampNumber(parseInt(process.env.GEMINI_TOP_K || '40', 10), 1, 1000);
const CANDIDATE_COUNT = clampNumber(parseInt(process.env.GEMINI_CANDIDATE_COUNT || '2', 10), 1, 8);
const THINKING_BUDGET_TOKENS = clampNumber(parseInt(process.env.THINKING_BUDGET_TOKENS || '1500', 10), 0, 8000);
const ENABLE_URL_CONTEXT = (process.env.ENABLE_URL_CONTEXT || 'true').toLowerCase() === 'true';
const ENABLE_GEMINI_GOOGLE_SEARCH = (process.env.ENABLE_GEMINI_GOOGLE_SEARCH || 'true').toLowerCase() === 'true';
const ENABLE_GEMINI_CODE_EXECUTION = (process.env.ENABLE_GEMINI_CODE_EXECUTION || 'false').toLowerCase() === 'true';
const ENABLE_GEMINI_FUNCTIONS = (process.env.ENABLE_GEMINI_FUNCTIONS || 'false').toLowerCase() === 'true';
const ENABLE_PROVIDER_CACHE = (process.env.ENABLE_PROVIDER_CACHE || 'true').toLowerCase() === 'true';
const PROVIDER_CACHE_MAX = clampNumber(parseInt(process.env.PROVIDER_CACHE_MAX || '100', 10), 10, 5000);
const PROVIDER_CACHE_TTL_MS = clampNumber(parseInt(process.env.PROVIDER_CACHE_TTL_MS || '600000', 10), 1000, 86400000);

// Convenience alias
const ai = client;

// Embeddings model lives here to avoid cycles
const EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL || 'text-embedding-004';

// Centralized embeddings generation (Gemini-only)
type EmbedVector = number[];
type EmbedResponse = { embeddings?: Array<{ values?: EmbedVector }> };
export async function generateTextEmbedding(text: string): Promise<number[]> {
  const res: EmbedResponse = await ai.models.embedContent({
    model: EMBEDDING_MODEL,
    contents: [{ role: 'user', parts: [{ text }] }],
  }) as unknown as EmbedResponse;
  const values = res?.embeddings?.[0]?.values;
  return Array.isArray(values) ? values : [];
}

// Shared generation config (optionally enforce JSON via responseMimeType)
type Empty = Record<string, never>;
type Tool = { googleSearch: Empty } | { codeExecution: Empty };
type GenExtra = Partial<{ responseMimeType: string; responseSchema: object; tools: Tool[] }>;
function baseConfig(extra?: GenExtra) {
  return {
    temperature: TEMPERATURE,
    maxOutputTokens: MAX_TOKENS,
    candidateCount: CANDIDATE_COUNT,
    topP: TOP_P,
    topK: TOP_K,
    ...(extra?.responseMimeType ? { responseMimeType: extra.responseMimeType } : {}),
    ...(extra?.responseSchema ? { responseSchema: extra.responseSchema } : {}),
  };
}

// Input type kept compatible with the project
type Part = { text?: string };
type ContentMsg = { role: string; parts: Part[] };
type ContentArg = string | { contents: ContentMsg[] };

// Provider-level cache (optional)
type GenerateRaw = { candidates?: Array<{ content?: { parts?: Array<Part> } }> };
type GenerateWrapped = GenerateRaw & { response: { text: () => Promise<string> } };
const providerCache = ENABLE_PROVIDER_CACHE
  ? new LRUCache<string, GenerateWrapped>({ max: PROVIDER_CACHE_MAX, ttl: PROVIDER_CACHE_TTL_MS })
  : null;

function hashKey(obj: unknown): string {
  try {
    return createHash('sha256').update(JSON.stringify(obj)).digest('hex');
  } catch {
    // Fallback to toString in pathological cases
    return String(obj);
  }
}

// Default tool set based on env flags; merged with any extra.tools at call time
function defaultTools(): Tool[] {
  const tools: Tool[] = [];
  if (ENABLE_GEMINI_GOOGLE_SEARCH) {
    tools.push({ googleSearch: {} });
  }
  if (ENABLE_GEMINI_CODE_EXECUTION) {
    tools.push({ codeExecution: {} });
  }
  // Functions require explicit declarations from caller; gate by flag but do not add empty set
  return tools;
}

// Unified raw->text extractor used across helpers
function extractTextFromRaw(r: GenerateRaw): string {
  const parts = r.candidates?.[0]?.content?.parts;
  const firstText = parts?.find((p) => typeof p.text === 'string')?.text;
  return firstText ?? '';
}

// Core generator: normalize ContentArg and call model.generateContent
async function generateContentInternal(prompt: ContentArg, extra?: GenExtra): Promise<GenerateWrapped> {
  const contents: ContentMsg[] =
    typeof prompt === 'string'
      ? [{ role: 'user', parts: [{ text: prompt }] }]
      : prompt.contents;

  const toolsCombined = [
    ...defaultTools(),
    ...(ENABLE_GEMINI_FUNCTIONS ? (extra?.tools || []) : []),
  ];
  const configObj = baseConfig(extra);
  const cacheKey = ENABLE_PROVIDER_CACHE ? hashKey({ MODEL, contents, config: configObj, tools: toolsCombined }) : '';
  if (providerCache && cacheKey) {
    const hit = providerCache.get(cacheKey);
    if (hit) {
      // Basic hit log
      logger.info({ key: cacheKey.slice(0,8) }, "[provider-cache] HIT");
      return hit;
    } else {
      logger.info({ key: cacheKey.slice(0,8) }, "[provider-cache] MISS");
    }
  }

  const request: { model: string; contents: ContentMsg[]; config: ReturnType<typeof baseConfig>; tools?: Tool[] } = {
    model: MODEL,
    contents,
    config: baseConfig(extra),
  };
  if (toolsCombined.length > 0) {
    request.tools = toolsCombined;
  }

  const raw = await ai.models.generateContent(request);

  // Back-compat shim: expose response.text() like older code expects
  const textVal = extractTextFromRaw(raw as unknown as GenerateRaw);
  const wrapped = Object.assign({}, raw, {
    response: {
      text: async () => textVal,
    },
  });
  if (providerCache) {
    providerCache.set(cacheKey, wrapped);
  }
  return wrapped;
}

// Maintain expected exports
export const o3MiniModel = {
  generateContent: (prompt: ContentArg) => generateContentInternal(prompt),
};

export const o3MiniModel2 = {
  generateContent: (prompt: ContentArg) => generateContentInternal(prompt),
};

export const researchModel = {
  generateContent: (prompt: ContentArg) => generateContentInternal(prompt),
};

// Token counting via model.countTokens
export async function countTokens(contents: Array<{ role: string; parts: Array<{ text?: string }> }>) {
  const res = await ai.models.countTokens({ model: MODEL, contents });
  return (res.totalTokens as number) ?? 0;
}

// Trims a prompt based on token count
export async function trimPrompt(prompt: string, maxTokens: number) {
  if (!prompt) {
    return '';
  }
  const contents = [{ role: 'user', parts: [{ text: prompt }] }];
  const tokenLength = await countTokens(contents);

  if (tokenLength <= maxTokens) {
    return prompt;
  }

  // simple resize by characters proportional to overflow
  const overflowTokens = tokenLength - maxTokens;
  const approxCharsPerToken = Math.max(2, Math.floor(prompt.length / Math.max(1, tokenLength)));
  const sliceLen = Math.max(140, prompt.length - overflowTokens * approxCharsPerToken);
  return prompt.slice(0, sliceLen);
}

// Function for managing prompts
export function createPrompt(template: string, variables: Record<string, string>): string {
  let prompt = template;
  for (const key in variables) {
    prompt = prompt.replace(`{{${key}}`, variables[key] ?? '');
  }
  return prompt;
}

// Configurable text call; returns string. Adds JSON response MIME when requested.

// REPLACEMENT: Raw Fetch Implementation

// REPLACEMENT: Raw Fetch Implementation
export async function callGeminiProConfigurable(
  prompt: string,
  opts?: { json?: boolean; schema?: object; tools?: Tool[] }
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || 'models/gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${apiKey}`;

  // Prepend JSON instructions if needed (since we disabled strict mode)
  let finalPrompt = prompt;
  if (opts?.json) {
     finalPrompt = "You must return a valid JSON object. Do not include markdown formatting like ```json. \n\n" + prompt;
  }

  const requestBody: any = {
    contents: [{
      role: 'user',
      parts: [{ text: finalPrompt }]
    }],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 8192
    }
  };

  // Google Search Tool injection
  if (opts?.tools && opts.tools.some(t => 'googleSearch' in t)) {
    requestBody.tools = [{ googleSearch: {} }];
  } else if (process.env.ENABLE_GEMINI_GOOGLE_SEARCH === 'true') {
     // Force search if enabled globally and appropriate (though usually we want explicit control)
  }

  try {
    console.error(`[RawFetch] STARTING REQUEST to ${model}`);
    console.error(`[RawFetch] Prompt Length: ${finalPrompt.length}`);
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[RawFetch] HTTP ERROR ${response.status}: ${errText}`);
      // Allow fallback to empty string so the agent retries or moves on
      return '';
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (!text) {
        console.error('[RawFetch] Empty response content:', JSON.stringify(data));
        return '';
    }
    
    return text;

  } catch (error) {
    console.error('[RawFetch] Exception:', error);
    return ''; 
  }
}



// Add type export to align with deep-research.ts
export type ResearchResultOutput = {
  content: string;
  sources: string[];
  methodology: string;
  limitations: string;
  citations: Array<{ source: string; context: string }>;
  learnings: string[];
  visitedUrls: string[];
};

// Text splitter utilities retained
const TextProcessingConfig: { MIN_CHUNK_SIZE: number; MAX_CHUNK_SIZE: number; CHUNK_OVERLAP: number } = {
  MIN_CHUNK_SIZE: 140,
  MAX_CHUNK_SIZE: 8192,
  CHUNK_OVERLAP: 20,
};

export function getChunkSize(): number {
  return process.env.CHUNK_SIZE ? Number(process.env.CHUNK_SIZE) : TextProcessingConfig.MIN_CHUNK_SIZE;
}

export interface TextSplitter {
  splitText(text: string): Promise<string[]>;
  chunkSize: number;
}

// Export a real SemanticTextSplitter here (providers owns embeddings)
export class SemanticTextSplitter implements TextSplitter {
  chunkSize: number;
  chunkOverlap: number;
  private sentenceRegex = /(?<=[.!?])\s+/g;
  private tokenizer: Tiktoken;
  private clean(s: string) { return s.replace(/\s+/g, ' ').trim(); }

  constructor(params?: { chunkSize?: number; chunkOverlap?: number }) {
    this.chunkSize = params?.chunkSize ?? TextProcessingConfig.MIN_CHUNK_SIZE;
    this.chunkOverlap = params?.chunkOverlap ?? TextProcessingConfig.CHUNK_OVERLAP;
    // Use OpenAI o200k_base encoding for robust token estimation
    const enc: TiktokenEncoding = (process.env.TIKTOKEN_ENCODING as TiktokenEncoding) || 'o200k_base';
    try {
      this.tokenizer = getEncoding(enc);
    } catch {
      // last-resort fallback to a naive tokenizer
      this.tokenizer = {
        encode: (text: string) => Array.from(new TextEncoder().encode(text)),
        decode: (tokens: number[]) => new TextDecoder().decode(Uint8Array.from(tokens)),
        free: () => {},
      } as unknown as Tiktoken;
    }
  }

  private tokenCount(s: string): number {
    try {
      return this.tokenizer.encode(s).length;
    } catch {
      // fallback
      return Math.ceil(s.length / 4);
    }
  }

  async splitText(text: string): Promise<string[]> {
    if (!text?.trim()) {
      return [];
    }

    // Start with sentence segmentation; fallback to recursive splitter if needed
    const normalized = text.replace(/\r\n?/g, '\n');
    const sentences = normalized
      .split(this.sentenceRegex)
      .map(s => this.clean(s))
      .filter(Boolean);

    // If too few sentences, fallback to recursive character splitter
    if (sentences.length <= 1) {
      const rc = new RecursiveCharacterTextSplitter({ chunkSize: this.chunkSize, chunkOverlap: this.chunkOverlap });
      return rc.splitText(normalized);
    }

    // Compute embeddings for semantic grouping
    const embs = await Promise.all(sentences.map(s => generateTextEmbedding(s)));

    // Simple greedy grouping by similarity to current centroid until chunk token budget reached
    const chunks: string[] = [];
    let i = 0;
    while (i < sentences.length) {
      const start = i;
      const first = sentences[i];
      if (!first) {
        break;
      }
      let current = first;
      let centroid = embs[i] ?? [];
      i++;

      while (i < sentences.length) {
        const next = sentences[i];
        if (!next) {
          break;
        }
        const nextEmb = embs[i] ?? [];
        const sim = centroid.length && nextEmb.length ? cosineSimilarity(centroid, nextEmb) : 0;
        const merged = `${current} ${next}`.trim();
        const mergedTokens = this.tokenCount(merged);
        const withinBudget = mergedTokens <= this.chunkSize;

        // Merge if semantically close or still far from budget target
        if (withinBudget && sim >= 0.65) {
          current = merged;
          // update centroid (simple average)
          if (centroid.length && nextEmb.length && centroid.length === nextEmb.length) {
            centroid = centroid.map((v, k) => (v + (nextEmb[k] as number)) / 2);
          }
          i++;
        } else {
          break;
        }
      }

      // Ensure minimal overlap by pulling back part of last sentence if significantly over budget
      chunks.push(current);
      if (i < sentences.length && this.chunkOverlap > 0) {
        // overlap by reusing the last sentence of this chunk as the first of next chunk when possible
        i = Math.max(start + 1, i - 1);
      }
    }
    return chunks.map(c => this.clean(c)).filter(Boolean);
  }
}

export async function semanticChunking(text: string, splitterOpt?: TextSplitter) {
  const effectiveSplitter = splitterOpt || new SemanticTextSplitter({
    chunkSize: getChunkSize(),
    chunkOverlap: TextProcessingConfig.CHUNK_OVERLAP,
  });
  try {
    return await effectiveSplitter.splitText(text);
  } catch (error) {
    console.error('Chunking error:', error);
    return [text];
  }
}

// Adaptive prompt utilities
export async function adaptivePrompt(
  basePrompt: string,
  context: string[],
  similarityThreshold = 0.8
) {
  // Compute embeddings locally using the embeddings helper above
  const baseEmbedding = await generateTextEmbedding(basePrompt);
  const contextEmbeddings = await Promise.all(context.map(txt => generateTextEmbedding(txt)));
  const relevantContext = context.filter(
    (_ , i) =>
      baseEmbedding &&
      contextEmbeddings[i] &&
      cosineSimilarity(baseEmbedding, contextEmbeddings[i]) > similarityThreshold
  );
  return `${basePrompt}\n\nRelevant Context:\n${relevantContext.join('\n')}`;
}

// Helper to extract text from GenerateContentResponse consistently
export function extractText(raw: unknown): string {
  return extractTextFromRaw(raw as GenerateRaw);
}

// Convenience helper to call with explicit tools (e.g., function calling)
export async function generateWithTools(prompt: ContentArg, tools: Tool[], extra?: Omit<GenExtra, 'tools'>) {
  return generateContentInternal(prompt, { ...(extra || {}), tools });
}

// Simple citation extractor for URLs and bracketed references
export function extractCitations(text: string): { urls: string[]; refs: string[] } {
  if (!text) {
    return { urls: [], refs: [] };
  }
  const urlRegex = /(https?:\/\/[^\s)]+)(?=[)\s]|$)/g;
  const refRegex = /\[\[(\d+)\]\]/g;
  const urls = Array.from(new Set(
    Array.from(text.matchAll(urlRegex))
      .map(m => m[1])
      .filter((u): u is string => typeof u === 'string')
  ));
  const refs = Array.from(new Set(Array.from(text.matchAll(refRegex)).map(m => m[0])));
  return { urls, refs };
}

// Simple concurrency pool (no external deps)
async function runWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T, idx: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let inFlight = 0;
  let index = 0;
  return await new Promise<R[]>((resolve, reject) => {
    const next = () => {
      if (index >= items.length && inFlight === 0) {
        return resolve(results);
      }
      while (inFlight < limit && index < items.length) {
        const i = index++;
        inFlight++;
        const item = items[i];
        if (item === undefined) { inFlight--; continue; }
        Promise.resolve(worker(item, i))
          .then((res) => { results[i] = res; })
          .catch(reject)
          .finally(() => { inFlight--; next(); });
      }
    };
    next();
  });
}

// Batch generation using existing config/tools/caching
export async function generateBatch(prompts: ContentArg[], extra?: GenExtra, concurrency = clampNumber(parseInt(process.env.CONCURRENCY_LIMIT || '5', 10), 1, 64)) {
  return runWithConcurrency<ContentArg, GenerateWrapped>(prompts, concurrency, (p) => generateContentInternal(p, extra));
}

// Batch with explicit tools support (e.g., function calling)
export async function generateBatchWithTools(prompts: ContentArg[], tools: Tool[], extra?: Omit<GenExtra, 'tools'>, concurrency = clampNumber(parseInt(process.env.CONCURRENCY_LIMIT || '5', 10), 1, 64)) {
  return runWithConcurrency(prompts, concurrency, (p) => generateContentInternal(p, { ...(extra || {}), tools }));
}

// Structured helpers for analysis → final pipeline with optional URL grounding
export async function generateAnalysisPlan(
  userPrompt: string,
  context: string[],
  urlContext?: { url: string; snippet: string }[],
  schema: object = {
    type: 'object',
    properties: {
      plan: { type: 'array', items: { type: 'string' } },
      risks: { type: 'array', items: { type: 'string' } },
      missingInfo: { type: 'array', items: { type: 'string' } }
    },
    required: ['plan'],
    additionalProperties: false,
  }
): Promise<string> {
  const urlBlock = ENABLE_URL_CONTEXT && urlContext?.length
    ? `\n\nURL Context:\n${urlContext.map(u => `- ${u.url}: ${u.snippet}`).join('\n')}`
    : '';
  const prompt = `You are a precise research strategist. Produce a concise JSON plan for answering the user query.\n` +
    `User Query:\n${userPrompt}\n\nContext:\n${context.join('\n')}\n${urlBlock}\n\n` +
    `Constraints: Use at most ${THINKING_BUDGET_TOKENS} tokens for analysis. Do not include the final answer.`;
  return await callGeminiProConfigurable(prompt, { json: true, schema });
}

export async function generateFinalFromPlan(
  planJson: string,
  context: string[],
  urlContext?: { url: string; snippet: string }[],
  schema: object = {
    type: 'object',
    properties: {
      sections: { type: 'array', items: { type: 'string' } },
      citations: { type: 'array', items: { type: 'string' } }
    },
    required: ['sections'],
    additionalProperties: false,
  }
): Promise<string> {
  const urlBlock = ENABLE_URL_CONTEXT && urlContext?.length
    ? `\n\nURL Context:\n${urlContext.map(u => `- ${u.url}: ${u.snippet}`).join('\n')}`
    : '';
  const prompt = `Using the provided JSON plan, write the final structured output as JSON (sections and citations).\n` +
    `Plan JSON:\n${planJson}\n\nContext:\n${context.join('\n')}\n${urlBlock}`;
  return await callGeminiProConfigurable(prompt, { json: true, schema });
}
