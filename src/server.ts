/**
 * Side-effect-free MCP server factory for the deep-research tool.
 *
 * Nothing in this module reads the environment at import time: every
 * configuration value is read inside the function that needs it, from the
 * `env` passed to `createServer()` (default `process.env`). This keeps the
 * factory testable with injected env/research/upload/cache/notification deps
 * and lets `mcp-server.ts` load `.env.local` before anything is read.
 */
import process from 'node:process';
import { Buffer } from 'node:buffer';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { LRUCache } from 'lru-cache';
import type { Request, Response, NextFunction } from 'express';
import {
  BlobServiceClient,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
} from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import {
  research as defaultResearch,
  resolveResearchProvider,
  type ResearchDeps,
  type ResearchOptions,
  type ResearchProgress,
  type ResearchProviderName,
  type ResearchResult,
} from './deep-research.js';
import {
  GeminiDeepResearchError,
  readPollIntervalMs,
  readTimeoutMs,
  selectAgent,
  type GeminiDeepResearchErrorCategory,
} from './ai/gemini-deep-research.js';
import { pickModel } from './ai/openai-deep-research.js';
import { logger } from './logger.js';

export const SERVER_NAME = 'deep-research';
export const SERVER_VERSION = '1.0.0';
const LEGACY_DEFAULT_MODEL = 'gemini-2.5-flash';
const SIZE_THRESHOLD_KB = 50;

export interface MCPResearchResult {
  content: { type: 'text'; text: string }[];
  metadata: {
    learnings: string[];
    visitedUrls: string[];
    stats: { totalLearnings: number; totalSources: number };
    reportUrl?: string;
    reportSizeKB?: number;
    errorCategory?: GeminiDeepResearchErrorCategory;
    interactionId?: string;
  };
  isError?: boolean;
  [key: string]: unknown;
}

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Injection points for tests. Production callers pass nothing. */
export interface ServerDeps {
  env?: NodeJS.ProcessEnv;
  research?: (options: ResearchOptions, deps?: ResearchDeps) => Promise<ResearchResult>;
  uploadReport?: (content: string, query: string) => Promise<string>;
  cache?: LRUCache<string, MCPResearchResult>;
  sendNotification?: (extra: ToolExtra, notification: ServerNotification) => Promise<void>;
}

export interface ResearchConfigSummary {
  provider: ResearchProviderName | 'invalid';
  agent: string;
  problems: string[];
}

// ---------------------------------------------------------------------------
// Configuration description (never throws, never echoes values)
// ---------------------------------------------------------------------------

export function describeResearchConfig(env: NodeJS.ProcessEnv = process.env): ResearchConfigSummary {
  const problems: string[] = [];
  let provider: ResearchProviderName;
  try {
    provider = resolveResearchProvider(env);
  } catch (err) {
    problems.push(err instanceof Error ? err.message : 'RESEARCH_PROVIDER is invalid');
    return { provider: 'invalid', agent: 'invalid', problems };
  }

  let agent: string;
  switch (provider) {
    case 'gemini':
      agent = selectAgent(2, env);
      for (const read of [readPollIntervalMs, readTimeoutMs]) {
        try {
          read(env);
        } catch (err) {
          problems.push(err instanceof Error ? err.message : 'invalid Gemini Deep Research timing configuration');
        }
      }
      if (!env.GEMINI_API_KEY) problems.push('GEMINI_API_KEY is not set');
      break;
    case 'gemini-legacy':
      agent = env.GEMINI_MODEL || LEGACY_DEFAULT_MODEL;
      if (!env.GEMINI_API_KEY) problems.push('GEMINI_API_KEY is not set');
      break;
    case 'openai':
      agent = env.OPENAI_DEEP_RESEARCH_MODEL || pickModel(2);
      if (!env.OPENAI_API_KEY) problems.push('OPENAI_API_KEY is not set');
      break;
  }
  return { provider, agent, problems };
}

/** Strict counterpart used per call: throws GeminiDeepResearchError('invalid_config') on bad config. */
function resolveEngine(env: NodeJS.ProcessEnv, depth: number): { provider: ResearchProviderName; agent: string } {
  const provider = resolveResearchProvider(env);
  switch (provider) {
    case 'gemini':
      readPollIntervalMs(env);
      readTimeoutMs(env);
      return { provider, agent: selectAgent(depth, env) };
    case 'gemini-legacy':
      return { provider, agent: env.GEMINI_MODEL || LEGACY_DEFAULT_MODEL };
    case 'openai':
      return { provider, agent: env.OPENAI_DEEP_RESEARCH_MODEL || pickModel(depth) };
  }
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

let defaultCache: LRUCache<string, MCPResearchResult> | undefined;

function readCacheTtlMs(env: NodeJS.ProcessEnv): number {
  const parsed = parseInt(env.PROVIDER_CACHE_TTL_MS || '600000', 10);
  return Math.max(1000, Math.min(86_400_000, Number.isFinite(parsed) ? parsed : 600_000));
}

function getDefaultCache(env: NodeJS.ProcessEnv): LRUCache<string, MCPResearchResult> {
  if (!defaultCache) {
    defaultCache = new LRUCache<string, MCPResearchResult>({ max: 50, ttl: readCacheTtlMs(env) });
  }
  return defaultCache;
}

function hashKey(obj: unknown): string {
  try {
    return createHash('sha256').update(JSON.stringify(obj)).digest('hex');
  } catch {
    return createHash('sha256').update(String(obj)).digest('hex');
  }
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

interface ClassifiedError {
  category: GeminiDeepResearchErrorCategory;
  interactionId?: string;
  message: string;
}

function classifyError(err: unknown): ClassifiedError {
  if (err instanceof GeminiDeepResearchError) {
    return { category: err.category, interactionId: err.interactionId, message: err.message };
  }
  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : '';
  let category: GeminiDeepResearchErrorCategory = 'unknown';
  if (name === 'AbortError') category = 'cancelled';
  else if (/Missing OPENAI_API_KEY/.test(message)) category = 'missing_key';
  else if (/^OpenAI API (401|403)\b/.test(message)) category = 'auth';
  else if (/^OpenAI API 429\b/.test(message)) category = 'quota';
  else if (/timed out/i.test(message)) category = 'timeout';
  else if (/^OpenAI API \d{3}\b/.test(message)) category = 'upstream_failed';
  return { category, message };
}

function errorEnvelope(classified: ClassifiedError): MCPResearchResult {
  const idPart = classified.interactionId ? ` Interaction id: ${classified.interactionId}.` : '';
  return {
    content: [{ type: 'text', text: `Deep research failed. Category: ${classified.category}.${idPart} Details are in the server log.` }],
    metadata: {
      learnings: [],
      visitedUrls: [],
      stats: { totalLearnings: 0, totalSources: 0 },
      errorCategory: classified.category,
      ...(classified.interactionId ? { interactionId: classified.interactionId } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Azure Blob upload (HTTP mode, large reports)
// ---------------------------------------------------------------------------

export async function uploadReportToAzureBlob(content: string, query: string): Promise<string> {
  const account = process.env.AZURE_STORAGE_ACCOUNT_NAME || '';
  const containerName = process.env.AZURE_STORAGE_CONTAINER_NAME || 'research-reports';
  if (!account) {
    logger.warn('AZURE_STORAGE_ACCOUNT_NAME not configured');
    throw new Error('Azure Blob Storage not configured');
  }
  const blobServiceClient = new BlobServiceClient(`https://${account}.blob.core.windows.net`, new DefaultAzureCredential());
  const containerClient = blobServiceClient.getContainerClient(containerName);
  await containerClient.createIfNotExists({ access: undefined });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const sanitizedQuery = query.slice(0, 50).replace(/[^a-zA-Z0-9]/g, '_');
  const blobName = `reports/${sanitizedQuery}_${timestamp}.md`;
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);
  await blockBlobClient.upload(content, Buffer.byteLength(content, 'utf8'), {
    blobHTTPHeaders: { blobContentType: 'text/markdown' },
    metadata: { query: query.slice(0, 256), generatedat: new Date().toISOString() },
  });

  const expiresOn = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const userDelegationKey = await blobServiceClient.getUserDelegationKey(new Date(), expiresOn);
  const sasToken = generateBlobSASQueryParameters(
    { containerName, blobName, permissions: BlobSASPermissions.parse('r'), expiresOn },
    userDelegationKey,
    account,
  ).toString();
  logger.info({ blobName, account }, 'Report uploaded to Azure Blob Storage');
  return `${blockBlobClient.url}?${sasToken}`;
}

// ---------------------------------------------------------------------------
// HTTP auth middleware (reads MCP_API_KEY at call time)
// ---------------------------------------------------------------------------

export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  const apiKey = process.env.MCP_API_KEY;
  if (!apiKey) {
    next();
    return;
  }
  const providedKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  if (providedKey !== apiKey) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

const TOOL_DESCRIPTION =
  "Deep research pipeline powered by Google's Gemini Deep Research agent (Interactions API). " +
  'The standard agent handles depth 1-2; depth >= 3 selects the max agent. ' +
  'Runs typically take 5-20 minutes; the max tier can take up to 60. ' +
  'Alternative engines are selectable server-side via RESEARCH_PROVIDER=gemini-legacy (Gemini Pro + Google Search loop) or RESEARCH_PROVIDER=openai. ' +
  'IMPORTANT: If this tool returns a URL to the full report, you MUST automatically download the report using the provided curl command and save it to a local .md file. ' +
  'Do not ask the user - just download and save it immediately after receiving the response.';

async function defaultSendNotification(extra: ToolExtra, notification: ServerNotification): Promise<void> {
  await extra.sendNotification(notification);
}

export function createServer(deps: ServerDeps = {}): McpServer {
  const env = deps.env ?? process.env;
  const runResearch = deps.research ?? defaultResearch;
  const uploadReport = deps.uploadReport ?? uploadReportToAzureBlob;
  const cache = deps.cache ?? getDefaultCache(env);
  const sendNotification = deps.sendNotification ?? defaultSendNotification;

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    'deepResearch.run',
    {
      title: 'Deep Research',
      description: TOOL_DESCRIPTION,
      inputSchema: {
        query: z.string().min(1).describe('The research query to investigate'),
        depth: z.number().min(1).max(5).optional().describe('How deep to go in the research tree (1-5)'),
        breadth: z.number().min(1).max(5).optional().describe('How broad to make each research level (1-5)'),
        existingLearnings: z.array(z.string()).optional().describe('Optional learnings to build upon'),
        goal: z.string().optional().describe('Optional goal/brief to steer synthesis'),
        flags: z.object({ grounding: z.boolean().optional(), urlContext: z.boolean().optional() }).optional(),
      },
    },
    async ({ query, depth, breadth, existingLearnings = [] }, extra): Promise<MCPResearchResult> => {
      const effectiveDepth = depth ?? 2;
      const effectiveBreadth = breadth ?? 2;
      try {
        const engine = resolveEngine(env, effectiveDepth);
        const cacheKey = hashKey({
          provider: engine.provider,
          agent: engine.agent,
          query,
          depth: effectiveDepth,
          breadth: effectiveBreadth,
          existingLearnings,
        });
        const cached = cache.get(cacheKey);
        if (cached) {
          logger.info({ key: cacheKey.slice(0, 8), query }, '[mcp-cache] HIT');
          return cached;
        }
        logger.info({ key: cacheKey.slice(0, 8), query }, '[mcp-cache] MISS');
        logger.info({ query, provider: engine.provider, agent: engine.agent }, 'Starting research');

        const progressToken = extra._meta?.progressToken;
        let tick = 0;
        let forwardProgress = progressToken !== undefined;
        const onProgress = (progress: ResearchProgress): void => {
          const message = `Researching: ${progress.currentQuery || '...'}`;
          logger.info({ progress }, message);
          if (!forwardProgress || progressToken === undefined) return;
          tick += 1;
          try {
            Promise.resolve()
              .then(() => sendNotification(extra, {
                method: 'notifications/progress',
                params: { progressToken, progress: tick, message },
              }))
              .catch((err: unknown) => {
                forwardProgress = false;
                logger.debug({ err: err instanceof Error ? err.message : String(err) }, 'Progress notification failed; no further progress will be forwarded');
              });
          } catch (err) {
            forwardProgress = false;
            logger.debug({ err: err instanceof Error ? err.message : String(err) }, 'Progress notification threw; no further progress will be forwarded');
          }
        };

        const result = await runResearch(
          { query, depth: effectiveDepth, breadth: effectiveBreadth, existingLearnings, onProgress, signal: extra.signal },
          { env },
        );
        logger.info('Research completed.');

        let reportContent: string;
        if (result.content) {
          reportContent = result.content;
        } else if (result.reportPath) {
          try {
            reportContent = fs.readFileSync(result.reportPath, 'utf-8');
          } catch (err) {
            logger.error({ err }, 'Error reading report file');
            reportContent = 'Error reading report file.';
          }
        } else {
          reportContent = '# Error: No report content generated.';
        }

        const reportSizeKB = Math.round(Buffer.byteLength(reportContent, 'utf8') / 1024);
        const isHttpMode = env.MCP_HTTP_MODE === 'true';
        const useUrlMode = isHttpMode && reportSizeKB > SIZE_THRESHOLD_KB;
        const stats = { totalLearnings: result.learnings.length, totalSources: result.visitedUrls.length };

        let finalResult: MCPResearchResult;
        if (useUrlMode) {
          let reportUrl: string;
          try {
            reportUrl = await uploadReport(reportContent, query);
            logger.info({ reportUrl, reportSizeKB, mode: 'azure-blob' }, 'Report uploaded successfully');
          } catch (err) {
            logger.error({ err }, 'Failed to upload report to Azure Blob Storage');
            reportUrl = 'ERROR: Failed to upload report to cloud storage';
          }
          const suggestedFilename = query.slice(0, 40).replace(/[^a-zA-Z0-9]/g, '_').toLowerCase() + '_report.md';
          const text = [
            '## 🚀 RESEARCH COMPLETE',
            '',
            `**Report Size:** ${reportSizeKB} KB`,
            `**Full Report URL:** ${reportUrl}`,
            '',
            '---',
            '',
            '## ⚠️ ACTION REQUIRED: Download and save the full report',
            '',
            `The complete report (${reportSizeKB} KB) has been uploaded to Azure Blob Storage.`,
            '',
            '**You MUST download and save it locally:**',
            '',
            '```bash',
            `curl -L '${reportUrl}' -o ${suggestedFilename}`,
            '```',
            '',
            `**Suggested filename:** \`${suggestedFilename}\``,
            '',
            '---',
            '',
            'Download the file above to get the complete research output.',
          ].join('\n');
          finalResult = {
            content: [{ type: 'text', text }],
            metadata: { learnings: result.learnings, visitedUrls: result.visitedUrls, stats, reportUrl, reportSizeKB },
          };
        } else {
          logger.info({ reportSizeKB, mode: isHttpMode ? 'http-inline' : 'stdio-inline' }, 'Returning full report content inline');
          finalResult = {
            content: [{ type: 'text', text: `## 🚀 RESEARCH COMPLETE\n\n${reportContent}` }],
            metadata: { learnings: result.learnings, visitedUrls: result.visitedUrls, stats, reportSizeKB },
          };
        }
        cache.set(cacheKey, finalResult);
        return finalResult;
      } catch (err) {
        const classified = classifyError(err);
        logger.error(
          { category: classified.category, interactionId: classified.interactionId, err: classified.message },
          'Error during deep research',
        );
        return errorEnvelope(classified);
      }
    },
  );

  server.registerResource(
    'capabilities',
    'mcp://capabilities',
    { title: 'Server Capabilities', description: 'Feature flags and environment info', mimeType: 'application/json' },
    async (uri) => {
      const summary = describeResearchConfig(env);
      let pollIntervalMs: number | null = null;
      let timeoutMs: number | null = null;
      try { pollIntervalMs = readPollIntervalMs(env); } catch { /* reported in configProblems */ }
      try { timeoutMs = readTimeoutMs(env); } catch { /* reported in configProblems */ }
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify({
            name: SERVER_NAME,
            version: SERVER_VERSION,
            provider: summary.provider,
            agent: summary.agent,
            pollIntervalMs,
            timeoutMs,
            legacyFlagsActive: summary.provider === 'gemini-legacy',
            configProblems: summary.problems,
            openaiDeepResearchModel: env.OPENAI_DEEP_RESEARCH_MODEL || 'o4-mini-deep-research (depth>=3: o3-deep-research)',
            geminiModel: env.GEMINI_MODEL || LEGACY_DEFAULT_MODEL,
            googleSearchEnabled: (env.ENABLE_GEMINI_GOOGLE_SEARCH || 'true').toLowerCase() === 'true',
            urlContextEnabled: (env.ENABLE_URL_CONTEXT || 'true').toLowerCase() === 'true',
            functionsEnabled: (env.ENABLE_GEMINI_FUNCTIONS || 'false').toLowerCase() === 'true',
            codeExecEnabled: (env.ENABLE_GEMINI_CODE_EXECUTION || 'false').toLowerCase() === 'true',
            providerCacheTtlMs: cache.ttl,
          }),
        }],
      };
    },
  );

  return server;
}
