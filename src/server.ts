/**
 * Side-effect-free MCP server factory for the deep-research tool.
 *
 * Nothing in this module reads the environment at import time: every
 * configuration value is read inside the function that needs it, from the
 * `env` passed to `createServer()` (default `process.env`). This keeps the
 * factory testable with injected env/research/upload/cache/notification deps
 * and lets `mcp-server.ts` load `.env.local` before anything is read.
 *
 * Transport-specific result shaping:
 * - HTTP mode (`MCP_HTTP_MODE=true`): reports above 50 KB are uploaded to
 *   Azure Blob Storage and a SAS URL is returned; smaller reports are inline.
 * - stdio mode: reports whose inline text exceeds `MCP_STDIO_INLINE_MAX_BYTES`
 *   (default 32,768 bytes) are returned as a compact envelope that names the
 *   locally saved report file; smaller reports are returned inline.
 */
import process from 'node:process';
import { Buffer } from 'node:buffer';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import {
  LoggingLevelSchema,
  SetLevelRequestSchema,
  type LoggingLevel,
  type ServerNotification,
  type ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';
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
  resolveReportDirectory,
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

/** Default stdio inline limit, in UTF-8 bytes of the first text item (heading + report). */
export const DEFAULT_STDIO_INLINE_MAX_BYTES = 32_768;
/** Upper bound for the serialized stdio file envelope; arrays are dropped to stay under it. */
export const MAX_COMPACT_RESULT_BYTES = 16_384;

const RESPONSE_FORMAT_VERSION = 2;
const HEARTBEAT_INTERVAL_MS = 30_000;
const EXCERPT_MAX_BYTES = 1_200;
const EXCERPT_MAX_HEADINGS = 5;
const EXCERPT_HEADING_MAX_BYTES = 120;
const AGENT_LABEL_MAX_BYTES = 128;
const REQUEST_ID_MAX_BYTES = 128;
const RESULT_HEADING = '## 🚀 RESEARCH COMPLETE';
const INLINE_RECOVERY_WARNING = 'Warning: report file unavailable; the complete report is included below.';
const TRUNCATION_MARKER = '… [truncated]';
const LEVEL_ORDER: readonly LoggingLevel[] = LoggingLevelSchema.options;

export interface MCPResearchResult {
  content: { type: 'text'; text: string }[];
  metadata: {
    learnings: string[];
    visitedUrls: string[];
    stats: { totalLearnings: number; totalSources: number };
    reportUrl?: string;
    reportSizeKB?: number;
    reportSizeBytes?: number;
    reportPath?: string;
    provider?: ResearchProviderName;
    agent?: string;
    elapsedMs?: number;
    metadataTruncated?: boolean;
    persistWarning?: string;
    errorCategory?: GeminiDeepResearchErrorCategory;
    interactionId?: string;
  };
  isError?: boolean;
  [key: string]: unknown;
}

/** What the cache stores: the shaped result plus how the report was delivered. */
export interface CachedResearchResult {
  result: MCPResearchResult;
  deliveredAs: 'inline' | 'file' | 'url';
}

export type ReportFileInspection =
  | { ok: true; sizeBytes: number }
  | { ok: false; reason: 'missing' | 'not_a_file' | 'unreadable' };

export interface ReportExcerpt {
  kind: 'summary' | 'opening' | 'beginning';
  excerpt: string;
  headings: string[];
  truncated: boolean;
  headingsTruncated: boolean;
}

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Injection points for tests. Production callers pass nothing. */
export interface ServerDeps {
  env?: NodeJS.ProcessEnv;
  research?: (options: ResearchOptions, deps?: ResearchDeps) => Promise<ResearchResult>;
  uploadReport?: (content: string, query: string) => Promise<string>;
  cache?: LRUCache<string, CachedResearchResult>;
  sendNotification?: (extra: ToolExtra, notification: ServerNotification) => Promise<void>;
  /** Launch directory used to resolve the runner's report directory. */
  cwd?: () => string;
  inspectReportFile?: (reportPath: string) => ReportFileInspection | Promise<ReportFileInspection>;
  now?: () => Date;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface ResearchConfigSummary {
  provider: ResearchProviderName | 'invalid';
  agent: string;
  problems: string[];
}

// ---------------------------------------------------------------------------
// stdio inline limit
// ---------------------------------------------------------------------------

/**
 * Reads `MCP_STDIO_INLINE_MAX_BYTES`: trimmed decimal digits forming a
 * nonnegative safe integer. Unset or blank means the default. Anything else
 * is an `invalid_config` error whose message never echoes the value.
 */
export function readStdioInlineMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MCP_STDIO_INLINE_MAX_BYTES;
  if (raw === undefined) return DEFAULT_STDIO_INLINE_MAX_BYTES;
  const trimmed = raw.trim();
  if (trimmed === '') return DEFAULT_STDIO_INLINE_MAX_BYTES;
  const message = 'MCP_STDIO_INLINE_MAX_BYTES must be a nonnegative integer number of bytes';
  if (!/^\d+$/.test(trimmed)) throw new GeminiDeepResearchError('invalid_config', message);
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) throw new GeminiDeepResearchError('invalid_config', message);
  return value;
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

  if (env.MCP_HTTP_MODE !== 'true') {
    try {
      readStdioInlineMaxBytes(env);
    } catch (err) {
      problems.push(err instanceof Error ? err.message : 'MCP_STDIO_INLINE_MAX_BYTES is invalid');
    }
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

let defaultCache: LRUCache<string, CachedResearchResult> | undefined;

function readCacheTtlMs(env: NodeJS.ProcessEnv): number {
  const parsed = parseInt(env.PROVIDER_CACHE_TTL_MS || '600000', 10);
  return Math.max(1000, Math.min(86_400_000, Number.isFinite(parsed) ? parsed : 600_000));
}

function getDefaultCache(env: NodeJS.ProcessEnv): LRUCache<string, CachedResearchResult> {
  if (!defaultCache) {
    defaultCache = new LRUCache<string, CachedResearchResult>({ max: 50, ttl: readCacheTtlMs(env) });
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
// Secret scrubbing for retained diagnostics
// ---------------------------------------------------------------------------

const SECRET_ENV_NAMES = ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'MCP_API_KEY', 'AZURE_CLIENT_SECRET'] as const;

/** Replaces any configured credential value (8+ chars) found in `message` with `[redacted]`. */
export function scrubSecrets(message: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = message;
  for (const name of SECRET_ENV_NAMES) {
    const value = env[name];
    if (typeof value === 'string' && value.length >= 8 && out.includes(value)) {
      out = out.split(value).join('[redacted]');
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

export interface ClassifiedError {
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

function errorEnvelope(classified: ClassifiedError, note?: string): MCPResearchResult {
  const idPart = classified.interactionId ? ` Interaction id: ${classified.interactionId}.` : '';
  const notePart = note ? ` ${note}` : '';
  return {
    content: [{
      type: 'text',
      text: `Deep research failed. Category: ${classified.category}.${idPart}${notePart} Details are in the server log.`,
    }],
    metadata: {
      learnings: [],
      visitedUrls: [],
      stats: { totalLearnings: 0, totalSources: 0 },
      errorCategory: classified.category,
      ...(classified.interactionId ? { interactionId: classified.interactionId } : {}),
    },
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// UTF-8 helpers and report excerpt
// ---------------------------------------------------------------------------

/** Clips `str` to at most `maxBytes` UTF-8 bytes on a code-point boundary, appending the marker when clipped. */
function clipUtf8(str: string, maxBytes: number, marker: string = TRUNCATION_MARKER): string {
  if (Buffer.byteLength(str, 'utf8') <= maxBytes) return str;
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8'));
  let used = 0;
  let out = '';
  for (const ch of str) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (used + b > budget) break;
    used += b;
    out += ch;
  }
  return out + marker;
}

type LineKind =
  | { kind: 'blank' }
  | { kind: 'hr' }
  | { kind: 'code' }
  | { kind: 'fence' }
  | { kind: 'heading'; text: string }
  | { kind: 'text'; text: string };

function classifyLines(report: string): LineKind[] {
  const lines = report.split(/\r?\n/);
  const out: LineKind[] = [];
  let fence: { char: string; length: number } | null = null;
  for (const line of lines) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[1]!.charAt(0) === fence.char && fenceMatch[1]!.length >= fence.length) {
        fence = null;
        out.push({ kind: 'fence' });
      } else {
        out.push({ kind: 'code' });
      }
      continue;
    }
    if (fenceMatch) {
      fence = { char: fenceMatch[1]!.charAt(0), length: fenceMatch[1]!.length };
      out.push({ kind: 'fence' });
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (heading) {
      out.push({ kind: 'heading', text: heading[2]!.replace(/\s+#+$/, '') });
      continue;
    }
    if (line.trim() === '') {
      out.push({ kind: 'blank' });
      continue;
    }
    if (/^\s{0,3}([-*_])\s*(\1\s*){2,}$/.test(line)) {
      out.push({ kind: 'hr' });
      continue;
    }
    out.push({ kind: 'text', text: line });
  }
  return out;
}

/**
 * Builds a short, code-point-safe excerpt of a Markdown report: the prose under
 * an "Executive Summary"/"Summary" heading, else the first substantive
 * paragraph after the title and any "Generated by" preamble, else the raw
 * beginning. Fenced code is skipped. Also collects up to five headings.
 */
export function buildReportExcerpt(report: string): ReportExcerpt {
  const lines = classifyLines(report);

  const allHeadings = lines.filter((l): l is { kind: 'heading'; text: string } => l.kind === 'heading');
  const headingsTruncated = allHeadings.length > EXCERPT_MAX_HEADINGS;
  const headings = allHeadings
    .slice(0, EXCERPT_MAX_HEADINGS)
    .map(h => clipUtf8(h.text, EXCERPT_HEADING_MAX_BYTES));

  const paragraphsFrom = (start: number, stopAtHeading: boolean): string[] => {
    const paragraphs: string[] = [];
    let current: string[] = [];
    const flush = (): void => {
      if (current.length > 0) {
        paragraphs.push(current.join('\n'));
        current = [];
      }
    };
    for (let i = start; i < lines.length; i += 1) {
      const line = lines[i]!;
      if (line.kind === 'text') {
        current.push(line.text);
        continue;
      }
      if (line.kind === 'heading' && stopAtHeading) {
        flush();
        break;
      }
      flush();
    }
    flush();
    return paragraphs;
  };

  let kind: ReportExcerpt['kind'] = 'beginning';
  let excerpt = '';

  const summaryIndex = lines.findIndex(l => l.kind === 'heading' && /^(executive\s+summary|summary)\b/i.test(l.text));
  if (summaryIndex !== -1) {
    const summaryParagraphs = paragraphsFrom(summaryIndex + 1, true);
    if (summaryParagraphs.length > 0) {
      kind = 'summary';
      excerpt = summaryParagraphs.join('\n\n');
    }
  }

  if (kind === 'beginning') {
    const opening = paragraphsFrom(0, false).find(p => !/^(\*|_|>)?\s*generated\b/i.test(p));
    if (opening !== undefined) {
      kind = 'opening';
      excerpt = opening;
    }
  }

  if (kind === 'beginning') {
    excerpt = report.trim();
  }

  const clipped = clipUtf8(excerpt, EXCERPT_MAX_BYTES);
  return { kind, excerpt: clipped, headings, truncated: clipped !== excerpt, headingsTruncated };
}

// ---------------------------------------------------------------------------
// Report file inspection
// ---------------------------------------------------------------------------

/**
 * Inspects the path without following symlinks and without blocking: lstat first
 * (a symlink, FIFO, socket or directory is `not_a_file` before anything is opened),
 * then a non-blocking, no-follow read-only open whose descriptor is fstat'd so the
 * size reported belongs to the entry that was actually opened.
 */
export function inspectReportFile(reportPath: string): ReportFileInspection {
  let fd: number | undefined;
  try {
    const lst = fs.lstatSync(reportPath);
    if (!lst.isFile()) return { ok: false, reason: 'not_a_file' };
    fd = fs.openSync(reportPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.ino !== lst.ino || st.dev !== lst.dev) return { ok: false, reason: 'not_a_file' };
    return { ok: true, sizeBytes: st.size };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, reason: 'missing' };
    return { ok: false, reason: 'unreadable' };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore close errors */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// stdio result shaping
// ---------------------------------------------------------------------------

type ArtifactStatus =
  | { status: 'none' }
  | { status: 'unavailable'; reason: string }
  | { status: 'verified'; path: string; sizeBytes: number };

interface BuildStdioResultInput {
  result: ResearchResult;
  provider: ResearchProviderName;
  agent: string;
  elapsedMs: number;
  inlineMaxBytes: number;
  reportDirectory: string;
  inspect: (reportPath: string) => ReportFileInspection | Promise<ReportFileInspection>;
}

export type BuildStdioResultOutcome =
  | { ok: true; entry: CachedResearchResult }
  | { ok: false; error: ClassifiedError };

function formatInt(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * Shapes a runner result for stdio delivery: inline when the heading plus
 * report fits `inlineMaxBytes`, otherwise a compact envelope naming the
 * verified local report file. Falls back to inline (with a warning) whenever
 * the file cannot be verified, and errors only when no report text exists.
 */
export async function buildStdioResult(input: BuildStdioResultInput): Promise<BuildStdioResultOutcome> {
  const { result, provider, agent, elapsedMs, inlineMaxBytes, reportDirectory, inspect } = input;
  const hasText = typeof result.content === 'string' && result.content.trim() !== '';

  const verify = async (): Promise<ArtifactStatus> => {
    const reportPath = result.reportPath;
    if (reportPath === undefined) return { status: 'none' };
    if (typeof reportPath !== 'string' || reportPath === '') return { status: 'unavailable', reason: 'not_saved' };
    if (!path.isAbsolute(reportPath) || /[\u0000-\u001f\u007f]/.test(reportPath)) {
      return { status: 'unavailable', reason: 'invalid_path' };
    }
    if (path.dirname(reportPath) !== reportDirectory) return { status: 'unavailable', reason: 'outside_report_directory' };
    let inspection: ReportFileInspection;
    try {
      inspection = await inspect(reportPath);
    } catch {
      inspection = { ok: false, reason: 'unreadable' };
    }
    if (!inspection.ok) return { status: 'unavailable', reason: inspection.reason };
    return { status: 'verified', path: reportPath, sizeBytes: inspection.sizeBytes };
  };

  let artifact = await verify();

  let report: string;
  if (hasText) {
    report = result.content as string;
  } else {
    if (artifact.status === 'none') {
      return { ok: false, error: { category: 'empty_report', message: 'The research produced no report text and no report file' } };
    }
    if (artifact.status !== 'verified') {
      return { ok: false, error: { category: 'persist_failed', message: `Report file unavailable (${artifact.reason}) and no inline text was returned` } };
    }
    try {
      report = fs.readFileSync(artifact.path, 'utf8');
    } catch {
      return { ok: false, error: { category: 'persist_failed', message: 'Report file could not be read and no inline text was returned' } };
    }
    if (report.trim() === '') {
      return { ok: false, error: { category: 'empty_report', message: 'The saved report file is empty' } };
    }
  }

  const reportBytes = Buffer.byteLength(report, 'utf8');
  if (artifact.status === 'verified' && hasText && artifact.sizeBytes !== reportBytes) {
    artifact = { status: 'unavailable', reason: 'size_mismatch' };
  }

  const inlineText = `${RESULT_HEADING}\n\n${report}`;
  const exceeds = Buffer.byteLength(inlineText, 'utf8') > inlineMaxBytes;
  const fileUsable = artifact.status === 'verified' && !result.persistWarning;
  const stats = { totalLearnings: result.learnings.length, totalSources: result.visitedUrls.length };
  const agentLabel = clipUtf8(agent, AGENT_LABEL_MAX_BYTES);

  const metadata: MCPResearchResult['metadata'] = {
    learnings: result.learnings,
    visitedUrls: result.visitedUrls,
    stats,
    reportSizeKB: Math.round(reportBytes / 1024),
    reportSizeBytes: reportBytes,
    provider,
    agent: agentLabel,
    elapsedMs,
  };
  if (fileUsable && artifact.status === 'verified') metadata.reportPath = artifact.path;

  if (!(exceeds && fileUsable)) {
    const warn = Boolean(result.persistWarning) || artifact.status === 'unavailable' || (exceeds && !fileUsable);
    if (warn) {
      const reason = artifact.status === 'unavailable' ? artifact.reason : 'not_saved';
      metadata.persistWarning = result.persistWarning
        ?? `Report file unavailable (${reason}); the complete report is returned inline.`;
    }
    const text = warn ? `${RESULT_HEADING}\n\n${INLINE_RECOVERY_WARNING}\n\n${report}` : inlineText;
    return { ok: true, entry: { result: { content: [{ type: 'text', text }], metadata }, deliveredAs: 'inline' } };
  }

  // File mode: compact envelope pointing at the verified local file.
  const reportPath = metadata.reportPath as string;
  const excerpt = buildReportExcerpt(report);
  const excerptLabel = excerpt.kind === 'summary'
    ? 'Executive Summary'
    : excerpt.kind === 'opening' ? 'opening paragraph' : 'beginning of report';
  const lines: string[] = [
    RESULT_HEADING,
    '',
    `The report was saved locally; at ${formatInt(reportBytes)} bytes it exceeds the inline limit of ${formatInt(inlineMaxBytes)} bytes, so it is not included in this response.`,
    '',
    `**Report file:** ${JSON.stringify(reportPath)}`,
    `**Report size:** ${formatInt(reportBytes)} bytes (${(reportBytes / 1024).toFixed(1)} KiB)`,
    `**Learnings:** ${stats.totalLearnings}`,
    `**Sources:** ${stats.totalSources}`,
    `**Engine:** ${provider} / ${agentLabel}`,
    `**Elapsed:** ${(elapsedMs / 1000).toFixed(1)} s`,
    '',
    'Read this local Markdown file for the complete report.',
    '',
    `### Excerpt (${excerptLabel})`,
    '',
    excerpt.excerpt,
  ];
  if (excerpt.headings.length > 0) {
    lines.push('', '### Headings', '');
    for (const h of excerpt.headings) lines.push(`- ${h}`);
    if (excerpt.headingsTruncated) lines.push('- … [more headings omitted]');
  }

  const envelope: MCPResearchResult = { content: [{ type: 'text', text: lines.join('\n') }], metadata };
  if (Buffer.byteLength(JSON.stringify(envelope), 'utf8') > MAX_COMPACT_RESULT_BYTES) {
    envelope.metadata = { ...metadata, learnings: [], visitedUrls: [], metadataTruncated: true };
    envelope.content = [{
      type: 'text',
      text: `${lines.join('\n')}\n\n_Note: the learnings and sources lists were omitted from this response to keep it compact; the totals remain in metadata.stats._`,
    }];
    if (Buffer.byteLength(JSON.stringify(envelope), 'utf8') > MAX_COMPACT_RESULT_BYTES) {
      logger.warn({ bytes: Buffer.byteLength(JSON.stringify(envelope), 'utf8') }, 'stdio file envelope exceeds the compact limit even without arrays');
    }
  }
  return { ok: true, entry: { result: envelope, deliveredAs: 'file' } };
}

// ---------------------------------------------------------------------------
// Progress reporting
// ---------------------------------------------------------------------------

export type ProgressStage = 'starting' | 'researching' | 'finalizing' | 'heartbeat' | 'completed' | 'failed' | 'cancelled';
type ProgressPhase = 'starting' | 'researching' | 'finalizing';
export type ProgressOutcome = 'completed' | 'failed' | 'cancelled';

export interface ProgressReporterOptions {
  mode: 'token' | 'log' | 'silent';
  progressToken?: string | number;
  requestId: string;
  send: (notification: ServerNotification) => Promise<void>;
  now: () => Date;
  setTimer: (callback: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  levelAllows: () => boolean;
  env: NodeJS.ProcessEnv;
}

export interface ProgressReporter {
  start(): void;
  update(progress: ResearchProgress): void;
  finish(outcome: ProgressOutcome): void;
  dispose(): void;
}

function nonNegativeInt(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/**
 * Server-authored progress with one in-flight send and no queue. Token-bearing
 * requests get `notifications/progress`; tokenless stdio requests get
 * `notifications/message` at level info; HTTP tokenless requests stay silent.
 * A rejected or throwing send disables all further forwarding.
 */
export function createProgressReporter(options: ProgressReporterOptions): ProgressReporter {
  const { mode, progressToken, requestId, send, now, setTimer, clearTimer, levelAllows, env } = options;
  const startedAt = now().getTime();
  let disposed = false;
  let pending = false;
  let count = 0;
  let lastElapsed = 0;
  let phase: ProgressPhase = 'starting';
  let timer: unknown;

  const elapsed = (): number => {
    lastElapsed = Math.max(lastElapsed, Math.max(0, now().getTime() - startedAt));
    return lastElapsed;
  };

  const stopHeartbeat = (): void => {
    if (timer !== undefined) {
      clearTimer(timer);
      timer = undefined;
    }
  };

  const disable = (err: unknown): void => {
    disposed = true;
    stopHeartbeat();
    const message = err instanceof Error ? err.message : String(err);
    logger.debug({ err: scrubSecrets(message, env) }, 'Progress notification failed; no further progress will be forwarded');
  };

  const emit = (stage: ProgressStage, message: string): void => {
    if (disposed || pending || mode === 'silent') return;
    if (mode === 'log' && !levelAllows()) return;
    const elapsedMs = elapsed();
    let notification: ServerNotification;
    if (mode === 'token') {
      count += 1;
      notification = {
        method: 'notifications/progress',
        params: { progressToken: progressToken as string | number, progress: count, message },
      };
    } else {
      notification = {
        method: 'notifications/message',
        params: { level: 'info', logger: 'deep-research', data: { requestId, stage, elapsedMs, message } },
      };
    }
    pending = true;
    try {
      Promise.resolve(send(notification)).then(
        () => { pending = false; },
        (err: unknown) => { pending = false; disable(err); },
      );
    } catch (err) {
      pending = false;
      disable(err);
    }
  };

  const arm = (): void => {
    if (disposed) return;
    timer = setTimer(() => {
      timer = undefined;
      if (disposed) return;
      emit('heartbeat', `Still ${phase}; ${Math.floor(elapsed() / 1000)}s elapsed.`);
      arm();
    }, HEARTBEAT_INTERVAL_MS);
  };

  return {
    start(): void {
      if (disposed) return;
      emit('starting', 'Deep research started.');
      arm();
    },
    update(progress: ResearchProgress): void {
      if (disposed) return;
      const total = nonNegativeInt(progress.totalQueries);
      const done = nonNegativeInt(progress.completedQueries);
      const finalizing = total > 0 && done >= total;
      phase = finalizing ? 'finalizing' : 'researching';
      if (finalizing) {
        emit('finalizing', 'Finalizing the report.');
      } else {
        const depth = nonNegativeInt(progress.currentDepth);
        const totalDepth = nonNegativeInt(progress.totalDepth);
        emit('researching', `Researching (depth ${depth}/${totalDepth}, ${done}/${total} queries complete).`);
      }
    },
    finish(outcome: ProgressOutcome): void {
      if (disposed) return;
      stopHeartbeat();
      if (outcome === 'completed') emit('completed', 'Research complete; preparing the response.');
      else if (outcome === 'failed') emit('failed', 'Research failed; see the server log.');
      else emit('cancelled', 'Research cancelled.');
      disposed = true;
    },
    dispose(): void {
      disposed = true;
      stopHeartbeat();
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
  'For a local-file result, read the absolute report path given in the response. ' +
  'For an HTTP URL result, download the report from the returned URL if you need its full text. ' +
  'Inline results already contain the report.';

async function defaultSendNotification(extra: ToolExtra, notification: ServerNotification): Promise<void> {
  await extra.sendNotification(notification);
}

function defaultSetTimer(callback: () => void, ms: number): unknown {
  const handle = setTimeout(callback, ms);
  handle.unref?.();
  return handle;
}

function defaultClearTimer(handle: unknown): void {
  clearTimeout(handle as NodeJS.Timeout);
}

const CANCELLED: ClassifiedError = { category: 'cancelled', message: 'Request cancelled' };

export function createServer(deps: ServerDeps = {}): McpServer {
  const env = deps.env ?? process.env;
  const runResearch = deps.research ?? defaultResearch;
  const uploadReport = deps.uploadReport ?? uploadReportToAzureBlob;
  const cache = deps.cache ?? getDefaultCache(env);
  const sendNotification = deps.sendNotification ?? defaultSendNotification;
  const cwd = deps.cwd ?? ((): string => process.cwd());
  const inspect = deps.inspectReportFile ?? inspectReportFile;
  const now = deps.now ?? ((): Date => new Date());
  const setTimer = deps.setTimer ?? defaultSetTimer;
  const clearTimer = deps.clearTimer ?? defaultClearTimer;
  const httpMode = env.MCP_HTTP_MODE === 'true';

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    httpMode ? undefined : { capabilities: { logging: {} } },
  );

  // stdio only: honour logging/setLevel for the tokenless progress channel.
  // Uses the public low-level Server API (SDK 1.17.2) because McpServer has no
  // setLevel helper.
  let minLogLevel: LoggingLevel = 'info';
  if (!httpMode) {
    server.server.setRequestHandler(SetLevelRequestSchema, async (request) => {
      minLogLevel = request.params.level;
      return {};
    });
  }
  const levelAllows = (): boolean => LEVEL_ORDER.indexOf('info') >= LEVEL_ORDER.indexOf(minLogLevel);

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
      const startedAtMs = now().getTime();
      let reporter: ProgressReporter | undefined;
      const onAbort = (): void => { reporter?.dispose(); };
      extra.signal.addEventListener('abort', onAbort, { once: true });
      try {
        const engine = resolveEngine(env, effectiveDepth);
        const inlineMaxBytes = httpMode ? null : readStdioInlineMaxBytes(env);
        const reportDirectory = resolveReportDirectory(env, cwd());
        if (extra.signal.aborted) return errorEnvelope(CANCELLED);

        const cacheKey = hashKey({
          format: RESPONSE_FORMAT_VERSION,
          transport: httpMode ? 'http' : 'stdio',
          inlineMaxBytes,
          reportDirectory,
          provider: engine.provider,
          agent: engine.agent,
          query,
          depth: effectiveDepth,
          breadth: effectiveBreadth,
          existingLearnings,
        });
        const shortKey = cacheKey.slice(0, 8);

        const cached = cache.get(cacheKey);
        if (cached) {
          if (cached.deliveredAs === 'file') {
            const cachedPath = cached.result.metadata.reportPath;
            const expectedBytes = cached.result.metadata.reportSizeBytes;
            let valid = false;
            if (typeof cachedPath === 'string' && typeof expectedBytes === 'number') {
              try {
                const inspection = await inspect(cachedPath);
                valid = inspection.ok && inspection.sizeBytes === expectedBytes;
              } catch {
                valid = false;
              }
            }
            if (!valid) {
              cache.delete(cacheKey);
              logger.warn({ key: shortKey }, '[mcp-cache] cached report file is no longer valid; entry evicted');
              return errorEnvelope(
                { category: 'persist_failed', message: 'cached report file invalid' },
                'The cached report file is no longer valid and the research was not rerun; submit the request again to regenerate it.',
              );
            }
          }
          logger.info({ key: shortKey }, '[mcp-cache] HIT');
          return cached.result;
        }
        logger.info({ key: shortKey }, '[mcp-cache] MISS');
        logger.info({ provider: engine.provider, agent: engine.agent, depth: effectiveDepth, breadth: effectiveBreadth }, 'Starting research');

        const progressToken = extra._meta?.progressToken;
        reporter = createProgressReporter({
          mode: progressToken !== undefined ? 'token' : httpMode ? 'silent' : 'log',
          progressToken,
          requestId: clipUtf8(String(extra.requestId), REQUEST_ID_MAX_BYTES),
          send: (notification) => sendNotification(extra, notification),
          now,
          setTimer,
          clearTimer,
          levelAllows,
          env,
        });
        reporter.start();
        if (extra.signal.aborted) {
          reporter.dispose();
          return errorEnvelope(CANCELLED);
        }

        const activeReporter = reporter;
        const result = await runResearch(
          {
            query,
            depth: effectiveDepth,
            breadth: effectiveBreadth,
            existingLearnings,
            onProgress: (progress) => activeReporter.update(progress),
            signal: extra.signal,
          },
          { env, cwd, ...(deps.now ? { now: deps.now } : {}) },
        );
        const resolvedBeforeAbort = !extra.signal.aborted;
        const elapsedMs = Math.max(0, now().getTime() - startedAtMs);
        logger.info({ elapsedMs }, 'Research completed.');

        let entry: CachedResearchResult;
        let cacheable = true;
        if (httpMode) {
          let reportContent: string;
          if (result.content) {
            reportContent = result.content;
          } else if (result.reportPath) {
            try {
              reportContent = fs.readFileSync(result.reportPath, 'utf-8');
            } catch (err) {
              logger.error({ err: scrubSecrets(err instanceof Error ? err.message : String(err), env) }, 'Error reading report file');
              reportContent = 'Error reading report file.';
            }
          } else {
            reportContent = '# Error: No report content generated.';
          }

          const reportSizeKB = Math.round(Buffer.byteLength(reportContent, 'utf8') / 1024);
          const useUrlMode = reportSizeKB > SIZE_THRESHOLD_KB;
          const stats = { totalLearnings: result.learnings.length, totalSources: result.visitedUrls.length };

          if (useUrlMode) {
            if (extra.signal.aborted) {
              // Never upload for a request nobody is waiting on.
              reporter.dispose();
              return errorEnvelope(CANCELLED);
            }
            let reportUrl: string;
            try {
              reportUrl = await uploadReport(reportContent, query);
              logger.info({ reportSizeKB, mode: 'azure-blob' }, 'Report uploaded successfully');
            } catch (err) {
              logger.error({ err: scrubSecrets(err instanceof Error ? err.message : String(err), env) }, 'Failed to upload report to Azure Blob Storage');
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
            entry = {
              result: {
                content: [{ type: 'text', text }],
                metadata: { learnings: result.learnings, visitedUrls: result.visitedUrls, stats, reportUrl, reportSizeKB },
              },
              deliveredAs: 'url',
            };
          } else {
            logger.info({ reportSizeKB, mode: 'http-inline' }, 'Returning full report content inline');
            entry = {
              result: {
                content: [{ type: 'text', text: `## 🚀 RESEARCH COMPLETE\n\n${reportContent}` }],
                metadata: { learnings: result.learnings, visitedUrls: result.visitedUrls, stats, reportSizeKB },
              },
              deliveredAs: 'inline',
            };
          }
        } else {
          const shaped = await buildStdioResult({
            result,
            provider: engine.provider,
            agent: engine.agent,
            elapsedMs,
            inlineMaxBytes: inlineMaxBytes as number,
            reportDirectory,
            inspect,
          });
          if (!shaped.ok) {
            reporter.finish('failed');
            logger.error(
              { category: shaped.error.category, err: scrubSecrets(shaped.error.message, env) },
              'Research finished without a usable report',
            );
            return errorEnvelope(shaped.error);
          }
          entry = shaped.entry;
          logger.info(
            { mode: `stdio-${entry.deliveredAs}`, reportSizeBytes: entry.result.metadata.reportSizeBytes },
            entry.deliveredAs === 'file' ? 'Returning report file reference' : 'Returning full report content inline',
          );
          // A result delivered by file reference is only cacheable with a verified file;
          // inline results always carry the full text.
          cacheable = entry.deliveredAs === 'inline' || typeof entry.result.metadata.reportPath === 'string';
        }

        if (extra.signal.aborted) {
          if (resolvedBeforeAbort && cacheable) cache.set(cacheKey, entry);
          reporter.dispose();
          return errorEnvelope(CANCELLED);
        }
        if (cacheable) cache.set(cacheKey, entry);
        reporter.finish('completed');
        return entry.result;
      } catch (err) {
        const classified = classifyError(err);
        reporter?.finish(classified.category === 'cancelled' ? 'cancelled' : 'failed');
        logger.error(
          { category: classified.category, interactionId: classified.interactionId, err: scrubSecrets(classified.message, env) },
          'Error during deep research',
        );
        return errorEnvelope(classified);
      } finally {
        extra.signal.removeEventListener('abort', onAbort);
        reporter?.dispose();
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
