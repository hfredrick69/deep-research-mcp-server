import process from 'node:process';

import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Public constants and types
// ---------------------------------------------------------------------------

export const INTERACTIONS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
export const STANDARD_AGENT = 'deep-research-preview-04-2026';
export const MAX_AGENT = 'deep-research-max-preview-04-2026';

const DEFAULT_POLL_INTERVAL_MS = 10_000;
const MIN_POLL_INTERVAL_MS = 5_000;
const MAX_POLL_INTERVAL_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 3_600_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 3_600_000;
const PER_REQUEST_BOUND_MS = 60_000;
const CANCEL_BOUND_MS = 10_000;
const MAX_CONSECUTIVE_GET_RETRIES = 2;
const DEFAULT_BREADTH = 2;

export type GeminiDeepResearchErrorCategory =
  | 'missing_key'
  | 'invalid_config'
  | 'auth'
  | 'quota'
  | 'timeout'
  | 'cancelled'
  | 'unsupported_state'
  | 'protocol'
  | 'upstream_failed'
  | 'empty_report'
  | 'persist_failed'
  | 'unknown';

export class GeminiDeepResearchError extends Error {
  readonly category: GeminiDeepResearchErrorCategory;
  readonly interactionId: string | undefined;
  readonly afterCompleted: boolean;

  constructor(
    category: GeminiDeepResearchErrorCategory,
    message: string,
    options: { interactionId?: string; afterCompleted?: boolean } = {},
  ) {
    super(message);
    this.name = 'GeminiDeepResearchError';
    this.category = category;
    this.interactionId = options.interactionId;
    this.afterCompleted = options.afterCompleted ?? false;
  }
}

/** Only the fields this module consumes; everything else is carried as unknown. */
export interface InteractionAnnotation {
  type?: string;
  url?: string;
  title?: string;
  start_index?: number;
  end_index?: number;
  [key: string]: unknown;
}

export interface InteractionPart {
  type?: string;
  text?: string;
  annotations?: InteractionAnnotation[];
  [key: string]: unknown;
}

export interface InteractionStep {
  type?: string;
  content?: InteractionPart[];
  [key: string]: unknown;
}

export interface InteractionResponse {
  id?: string;
  status?: string;
  steps?: InteractionStep[];
  errors?: { code?: string; message?: string }[];
  continuation_token?: string;
  usage?: unknown;
  [key: string]: unknown;
}

export interface CreateInteractionBody {
  agent: string;
  input: string;
  background: true;
  store: true;
  stream: false;
  agent_config: {
    type: 'deep-research';
    thinking_summaries: 'none';
    visualization: 'off';
    collaborative_planning: false;
  };
  tools: [{ type: 'google_search' }, { type: 'url_context' }];
}

export interface GeminiDeepResearchDeps {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  fetch?: typeof fetch;
}

export interface GeminiDeepResearchOptions {
  query: string;
  depth?: number;
  breadth?: number;
  existingLearnings?: string[];
  onProgress?: (status: string, elapsedMs: number) => void;
  signal?: AbortSignal;
}

export interface GeminiDeepResearchResult {
  content: string;
  visitedUrls: string[];
  learnings: string[];
  agent: string;
  interactionId: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export function selectAgent(depth: number | undefined, env: NodeJS.ProcessEnv): string {
  const override = env.GEMINI_DEEP_RESEARCH_AGENT?.trim();
  if (override) return override;
  return (depth ?? 2) >= 3 ? MAX_AGENT : STANDARD_AGENT;
}

function readIntEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed === '') return fallback;
  if (!/^\d+$/.test(trimmed)) {
    throw new GeminiDeepResearchError('invalid_config', `${name} must be an integer between ${min} and ${max} (milliseconds)`);
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new GeminiDeepResearchError('invalid_config', `${name} must be an integer between ${min} and ${max} (milliseconds)`);
  }
  return value;
}

export function readPollIntervalMs(env: NodeJS.ProcessEnv): number {
  return readIntEnv(env, 'GEMINI_DR_POLL_INTERVAL_MS', DEFAULT_POLL_INTERVAL_MS, MIN_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS);
}

export function readTimeoutMs(env: NodeJS.ProcessEnv): number {
  return readIntEnv(env, 'GEMINI_DR_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
}

// ---------------------------------------------------------------------------
// Request construction
// ---------------------------------------------------------------------------

export function buildCreateBody(params: {
  agent: string;
  query: string;
  breadth?: number;
  existingLearnings?: string[];
}): CreateInteractionBody {
  const breadth = params.breadth ?? DEFAULT_BREADTH;
  const sections = Math.min(12, Math.max(4, 2 * breadth + 2));
  const notes = (params.existingLearnings ?? []).map((n) => n.trim()).filter((n) => n.length > 0);

  const lines: string[] = [
    'You are preparing a research report for an analyst.',
    `Write the final answer as a well-structured Markdown report with approximately ${sections} sections,`,
    'opening with an executive summary and closing with a conclusion.',
    'Rely on primary sources wherever possible, state the dates of the evidence you use,',
    'and provide inline citations for every substantive claim.',
    '',
    '<research_query>',
    params.query,
    '</research_query>',
  ];

  if (notes.length > 0) {
    lines.push(
      '',
      '<prior_notes>',
      'The following notes come from earlier research and are unverified prior context; check them before relying on them.',
      ...notes.map((n) => `- ${n}`),
      '</prior_notes>',
    );
  }

  return {
    agent: params.agent,
    input: lines.join('\n'),
    background: true,
    store: true,
    stream: false,
    agent_config: {
      type: 'deep-research',
      thinking_summaries: 'none',
      visualization: 'off',
      collaborative_planning: false,
    },
    tools: [{ type: 'google_search' }, { type: 'url_context' }],
  };
}

// ---------------------------------------------------------------------------
// Report extraction
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function extractReport(response: InteractionResponse): { content: string; visitedUrls: string[] } {
  const steps = response.steps;
  if (steps !== undefined && !Array.isArray(steps)) {
    throw new GeminiDeepResearchError('protocol', 'Interaction response field "steps" is not an array');
  }
  let final: InteractionStep | undefined;
  for (const step of steps ?? []) {
    if (!isRecord(step)) {
      throw new GeminiDeepResearchError('protocol', 'Interaction response contains a malformed step');
    }
    if (step.type === 'model_output') final = step;
  }
  if (!final) {
    throw new GeminiDeepResearchError('empty_report', 'Interaction completed without a model_output step');
  }
  const content = final.content ?? [];
  if (!Array.isArray(content)) {
    throw new GeminiDeepResearchError('protocol', 'Final model_output step has a malformed "content" field');
  }

  const texts: string[] = [];
  const visitedUrls: string[] = [];
  const seen = new Set<string>();
  for (const part of content) {
    if (!isRecord(part) || part.type !== 'text' || typeof part.text !== 'string') continue;
    texts.push(part.text);
    const annotations = Array.isArray(part.annotations) ? part.annotations : [];
    for (const annotation of annotations) {
      if (!isRecord(annotation) || annotation.type !== 'url_citation') continue;
      const url = annotation.url;
      if (typeof url !== 'string' || url.length === 0 || seen.has(url)) continue;
      seen.add(url);
      visitedUrls.push(url);
    }
  }

  const report = texts.join('\n');
  if (report.trim().length === 0) {
    throw new GeminiDeepResearchError('empty_report', 'Interaction completed but the final model_output contains no report text');
  }
  return { content: report, visitedUrls };
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

type RequestOutcome =
  | { kind: 'response'; status: number; retryAfterMs: number | undefined; body: unknown; parseError: boolean }
  | { kind: 'network'; message: string }
  | { kind: 'timeout' }
  | { kind: 'aborted' };

interface Runtime {
  env: NodeJS.ProcessEnv;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  fetch: typeof fetch;
  apiKey: string;
  signal: AbortSignal | undefined;
}

function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length > 0) out = out.split(secret).join('[REDACTED]');
  }
  return out;
}

function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  const wallNow = Date.now();
  void now;
  return Math.max(0, date - wallNow);
}

async function performRequest(
  rt: Runtime,
  url: string,
  init: { method: 'GET' | 'POST'; body?: string },
  boundMs: number,
  honorExternalSignal: boolean,
): Promise<RequestOutcome> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = rt.setTimer(() => {
    timedOut = true;
    controller.abort();
  }, boundMs);
  const onExternalAbort = () => controller.abort();
  const external = honorExternalSignal ? rt.signal : undefined;
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }

  const headers: Record<string, string> = { 'x-goog-api-key': rt.apiKey, accept: 'application/json' };
  if (init.body !== undefined) headers['content-type'] = 'application/json';

  try {
    const response = await rt.fetch(url, {
      method: init.method,
      headers,
      body: init.body,
      redirect: 'error',
      signal: controller.signal,
    });
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), rt.now());
    let text: string;
    try {
      text = await response.text();
    } catch (err) {
      if (controller.signal.aborted) return external?.aborted ? { kind: 'aborted' } : { kind: 'timeout' };
      return { kind: 'network', message: err instanceof Error ? err.message : String(err) };
    }
    let body: unknown;
    let parseError = false;
    try {
      body = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      parseError = true;
    }
    return { kind: 'response', status: response.status, retryAfterMs, body, parseError };
  } catch (err) {
    if (controller.signal.aborted) {
      if (external?.aborted) return { kind: 'aborted' };
      if (timedOut) return { kind: 'timeout' };
      return { kind: 'aborted' };
    }
    return { kind: 'network', message: err instanceof Error ? err.message : String(err) };
  } finally {
    rt.clearTimer(timer);
    if (external) external.removeEventListener('abort', onExternalAbort);
  }
}

function categoryForHttpStatus(status: number): GeminiDeepResearchErrorCategory {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'quota';
  if (status >= 500) return 'upstream_failed';
  return 'protocol';
}

function isRetryableOutcome(outcome: RequestOutcome): boolean {
  if (outcome.kind === 'network' || outcome.kind === 'timeout') return true;
  if (outcome.kind === 'response') return outcome.status === 429 || outcome.status >= 500;
  return false;
}

function categoryForFailedOutcome(outcome: RequestOutcome): GeminiDeepResearchErrorCategory {
  switch (outcome.kind) {
    case 'network':
      return 'upstream_failed';
    case 'timeout':
      return 'timeout';
    case 'aborted':
      return 'cancelled';
    case 'response':
      return categoryForHttpStatus(outcome.status);
  }
}

/**
 * Shape of an interaction id this client is willing to put into a URL path, a log line or a
 * progress message. Anything else is a protocol violation, not an id to be encoded and retried.
 */
const INTERACTION_ID_PATTERN = /^[A-Za-z0-9_.-]{1,256}$/;

const KNOWN_STATUSES = new Set([
  'in_progress',
  'requires_action',
  'completed',
  'failed',
  'cancelled',
  'incomplete',
  'requires_continuation',
]);

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

interface DebugSummary {
  statusesSeen: string[];
  stepTypes: Record<string, number>;
  annotationTypes: Record<string, number>;
  errorsPresent: boolean;
  getCount: number;
  retryCount: number;
}

function summarizeResponse(summary: DebugSummary, response: InteractionResponse): void {
  if (typeof response.status === 'string') summary.statusesSeen.push(response.status);
  if (Array.isArray(response.errors) && response.errors.length > 0) summary.errorsPresent = true;
  summary.stepTypes = {};
  summary.annotationTypes = {};
  if (!Array.isArray(response.steps)) return;
  for (const step of response.steps) {
    if (!isRecord(step)) continue;
    const type = typeof step.type === 'string' ? step.type : 'unknown';
    summary.stepTypes[type] = (summary.stepTypes[type] ?? 0) + 1;
    if (!Array.isArray(step.content)) continue;
    for (const part of step.content) {
      if (!isRecord(part) || !Array.isArray(part.annotations)) continue;
      for (const annotation of part.annotations) {
        if (!isRecord(annotation)) continue;
        const aType = typeof annotation.type === 'string' ? annotation.type : 'unknown';
        summary.annotationTypes[aType] = (summary.annotationTypes[aType] ?? 0) + 1;
      }
    }
  }
}

export async function runGeminiDeepResearch(
  options: GeminiDeepResearchOptions,
  deps: GeminiDeepResearchDeps = {},
): Promise<GeminiDeepResearchResult> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const fetchImpl = deps.fetch ?? fetch;
  const signal = options.signal;

  if (signal?.aborted) {
    throw new GeminiDeepResearchError('cancelled', 'Research was cancelled before it started');
  }

  const apiKey = env.GEMINI_API_KEY?.trim() ?? '';
  if (apiKey.length === 0) {
    throw new GeminiDeepResearchError('missing_key', 'GEMINI_API_KEY is not set; the Gemini Deep Research agent needs it');
  }
  const pollIntervalMs = readPollIntervalMs(env);
  const timeoutMs = readTimeoutMs(env);
  const agent = selectAgent(options.depth, env);
  const secrets = [apiKey];
  const redact = (text: string) => redactSecrets(text, secrets);

  const rt: Runtime = { env, now, sleep, setTimer, clearTimer, fetch: fetchImpl, apiKey, signal };
  const start = now();
  const deadline = start + timeoutMs;
  const remaining = () => deadline - now();
  const elapsed = () => now() - start;
  const summary: DebugSummary = {
    statusesSeen: [],
    stepTypes: {},
    annotationTypes: {},
    errorsPresent: false,
    getCount: 0,
    retryCount: 0,
  };

  let progressWarned = false;
  const reportProgress = (status: string) => {
    if (!options.onProgress) return;
    try {
      options.onProgress(status, elapsed());
    } catch (err) {
      if (!progressWarned) {
        progressWarned = true;
        logger.warn({ op: 'progress', error: redact(err instanceof Error ? err.message : String(err)) }, 'Progress callback threw; the research continues');
      }
    }
  };

  const fail = (
    category: GeminiDeepResearchErrorCategory,
    message: string,
    interactionId?: string,
    afterCompleted = false,
  ): GeminiDeepResearchError => new GeminiDeepResearchError(category, redact(message), { interactionId, afterCompleted });

  const cancelInteraction = async (id: string): Promise<void> => {
    const url = `${INTERACTIONS_ENDPOINT}/${encodeURIComponent(id)}/cancel`;
    try {
      const outcome = await performRequest(rt, url, { method: 'POST', body: '{}' }, CANCEL_BOUND_MS, false);
      logger.info(
        { op: 'cancel', interactionId: id, outcome: outcome.kind, status: outcome.kind === 'response' ? outcome.status : undefined, elapsedMs: elapsed() },
        'Best-effort cancel of abandoned interaction',
      );
    } catch (err) {
      logger.warn({ op: 'cancel', interactionId: id, error: redact(err instanceof Error ? err.message : String(err)) }, 'Cancel request threw');
    }
  };

  const failAndCancel = async (
    category: GeminiDeepResearchErrorCategory,
    message: string,
    id: string,
  ): Promise<GeminiDeepResearchError> => {
    await cancelInteraction(id);
    return fail(category, message, id);
  };

  const waitAbortable = async (ms: number): Promise<void> => {
    if (ms <= 0) return;
    if (!signal) {
      await sleep(ms);
      return;
    }
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<void>((resolve) => {
      onAbort = () => resolve();
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      await Promise.race([sleep(ms), aborted]);
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  };

  const logDebugSummary = (outcome: string) => {
    logger.debug({ op: 'summary', outcome, agent, elapsedMs: elapsed(), ...summary }, 'Gemini Deep Research run summary');
  };

  // ---- create -------------------------------------------------------------
  const body = buildCreateBody({
    agent,
    query: options.query,
    breadth: options.breadth,
    existingLearnings: options.existingLearnings,
  });
  const createBound = Math.min(PER_REQUEST_BOUND_MS, Math.max(1, remaining()));
  const createOutcome = await performRequest(
    rt,
    INTERACTIONS_ENDPOINT,
    { method: 'POST', body: JSON.stringify(body) },
    createBound,
    true,
  );

  if (createOutcome.kind === 'aborted') {
    logger.warn({ op: 'create', outcome: 'aborted', elapsedMs: elapsed() }, 'Create aborted before an interaction id was returned; a billed interaction may exist upstream');
    throw fail('cancelled', 'Research was cancelled while the interaction was being created');
  }
  if (createOutcome.kind === 'timeout') {
    logger.warn({ op: 'create', outcome: 'timeout', elapsedMs: elapsed() }, 'Create timed out before an interaction id was returned; a billed interaction may exist upstream');
    throw fail('timeout', `Creating the interaction did not complete within ${createBound} ms`);
  }
  if (createOutcome.kind === 'network') {
    logger.warn({ op: 'create', outcome: 'network', elapsedMs: elapsed() }, 'Create failed at the transport level; a billed interaction may exist upstream');
    throw fail('upstream_failed', `Creating the interaction failed: ${createOutcome.message}`);
  }
  logger.info({ op: 'create', status: createOutcome.status, agent, elapsedMs: elapsed() }, 'Interaction create request finished');
  if (createOutcome.status < 200 || createOutcome.status >= 300) {
    throw fail(categoryForHttpStatus(createOutcome.status), `Interaction create returned HTTP ${createOutcome.status}`);
  }
  if (createOutcome.parseError || !isRecord(createOutcome.body)) {
    throw fail('protocol', 'Interaction create returned a response that is not a JSON object');
  }
  const created = createOutcome.body as InteractionResponse;
  if (typeof created.id !== 'string' || !INTERACTION_ID_PATTERN.test(created.id)) {
    // The id is deliberately not echoed: a malformed one is untrusted upstream data.
    throw fail('protocol', 'Interaction create response is missing or has a malformed id');
  }
  if (typeof created.status !== 'string' || created.status.length === 0) {
    throw fail('protocol', 'Interaction create response is missing a status');
  }
  const interactionId = created.id;
  logger.info({ op: 'create', interactionId, interactionStatus: KNOWN_STATUSES.has(created.status) ? created.status : 'unknown' }, 'Interaction created');
  summarizeResponse(summary, created);
  // Only a recognised status reaches the client's progress channel; unknown ones are sanitised.
  reportProgress(KNOWN_STATUSES.has(created.status) ? created.status : 'unknown');

  // ---- poll ---------------------------------------------------------------
  let current: InteractionResponse = created;
  let consecutiveRetries = 0;

  const throwIfAborted = async (): Promise<void> => {
    if (signal?.aborted) {
      logDebugSummary('cancelled');
      throw await failAndCancel('cancelled', `Research was cancelled (interaction ${interactionId})`, interactionId);
    }
  };

  const pollOnce = async (): Promise<RequestOutcome> => {
    summary.getCount += 1;
    const bound = Math.min(PER_REQUEST_BOUND_MS, Math.max(1, remaining()));
    return performRequest(rt, `${INTERACTIONS_ENDPOINT}/${encodeURIComponent(interactionId)}`, { method: 'GET' }, bound, true);
  };

  for (;;) {
    await throwIfAborted();
    const status = current.status ?? '';

    if (status === 'completed') {
      reportProgress('completed');
      logger.info({ op: 'poll', interactionId, interactionStatus: 'completed', elapsedMs: elapsed(), gets: summary.getCount }, 'Interaction completed');
      let extracted: { content: string; visitedUrls: string[] };
      try {
        extracted = extractReport(current);
      } catch (err) {
        logDebugSummary('extraction_failed');
        if (err instanceof GeminiDeepResearchError) {
          logger.warn({ op: 'extract', interactionId, category: err.category }, 'Completed interaction could not be turned into a report');
          throw fail(err.category, `${err.message} (interaction ${interactionId})`, interactionId, true);
        }
        throw fail('unknown', `Report extraction failed (interaction ${interactionId})`, interactionId, true);
      }
      logDebugSummary('completed');
      return {
        content: extracted.content,
        visitedUrls: extracted.visitedUrls,
        learnings: [`Deep research report generated by ${agent} with ${extracted.visitedUrls.length} cited URLs`],
        agent,
        interactionId,
      };
    }

    if (status === 'failed' || status === 'cancelled' || status === 'incomplete') {
      reportProgress(status);
      const codes = Array.isArray(current.errors)
        ? current.errors.map((e) => (isRecord(e) && typeof e.code === 'string' ? e.code : 'unknown'))
        : [];
      logger.warn({ op: 'poll', interactionId, interactionStatus: status, errorCodes: codes, elapsedMs: elapsed() }, 'Interaction ended without a report');
      logDebugSummary(status);
      throw fail(
        'upstream_failed',
        `Interaction ${interactionId} ended with status ${status}${codes.length ? ` (upstream error codes: ${codes.join(', ')})` : ''}`,
        interactionId,
      );
    }

    if (status === 'requires_action' || status === 'requires_continuation') {
      reportProgress(status);
      logger.warn({ op: 'poll', interactionId, interactionStatus: status }, 'Interaction entered a state this client does not support');
      logDebugSummary(status);
      throw await failAndCancel(
        'unsupported_state',
        `Interaction ${interactionId} entered status ${status}, which this client does not support`,
        interactionId,
      );
    }

    if (status !== 'in_progress') {
      logger.warn({ op: 'poll', interactionId, interactionStatus: 'unknown' }, 'Interaction reported an unknown status');
      logDebugSummary('protocol');
      throw await failAndCancel('protocol', `Interaction ${interactionId} reported an unrecognised status`, interactionId);
    }

    // in_progress: heartbeat, wait, poll (with bounded transport retries)
    reportProgress('in_progress');
    let waitMs = pollIntervalMs;
    for (;;) {
      const left = remaining();
      if (left <= 0) {
        logDebugSummary('timeout');
        throw await failAndCancel('timeout', `Research did not finish within ${timeoutMs} ms (interaction ${interactionId})`, interactionId);
      }
      await waitAbortable(Math.min(waitMs, left));
      await throwIfAborted();
      if (remaining() <= 0) {
        logDebugSummary('timeout');
        throw await failAndCancel('timeout', `Research did not finish within ${timeoutMs} ms (interaction ${interactionId})`, interactionId);
      }

      const outcome = await pollOnce();
      if (outcome.kind === 'aborted') {
        logDebugSummary('cancelled');
        throw await failAndCancel('cancelled', `Research was cancelled (interaction ${interactionId})`, interactionId);
      }

      if (outcome.kind === 'response' && outcome.status >= 200 && outcome.status < 300) {
        if (outcome.parseError || !isRecord(outcome.body)) {
          logDebugSummary('protocol');
          throw await failAndCancel('protocol', `Interaction ${interactionId} poll returned a response that is not a JSON object`, interactionId);
        }
        const polled = outcome.body as InteractionResponse;
        if (polled.id !== interactionId || typeof polled.status !== 'string') {
          logDebugSummary('protocol');
          throw await failAndCancel('protocol', `Interaction ${interactionId} poll returned a mismatched id or missing status`, interactionId);
        }
        consecutiveRetries = 0;
        summarizeResponse(summary, polled);
        logger.debug({ op: 'poll', interactionId, interactionStatus: KNOWN_STATUSES.has(polled.status) ? polled.status : 'unknown', elapsedMs: elapsed() }, 'Polled interaction');
        current = polled;
        break;
      }

      // Transport-level or HTTP failure on GET
      if (!isRetryableOutcome(outcome) || consecutiveRetries >= MAX_CONSECUTIVE_GET_RETRIES) {
        const category = categoryForFailedOutcome(outcome);
        logger.warn(
          { op: 'poll', interactionId, outcome: outcome.kind, status: outcome.kind === 'response' ? outcome.status : undefined, retries: consecutiveRetries },
          'Polling failed',
        );
        logDebugSummary(category);
        throw await failAndCancel(
          category,
          outcome.kind === 'response'
            ? `Polling interaction ${interactionId} returned HTTP ${outcome.status}`
            : `Polling interaction ${interactionId} failed (${outcome.kind})`,
          interactionId,
        );
      }
      consecutiveRetries += 1;
      summary.retryCount += 1;
      const retryAfterMs = outcome.kind === 'response' ? outcome.retryAfterMs : undefined;
      if (retryAfterMs !== undefined && retryAfterMs > remaining()) {
        logDebugSummary('timeout');
        throw await failAndCancel(
          'timeout',
          `Upstream asked to retry after ${retryAfterMs} ms, beyond the remaining deadline (interaction ${interactionId})`,
          interactionId,
        );
      }
      waitMs = Math.max(pollIntervalMs, retryAfterMs ?? 0);
      logger.debug(
        { op: 'poll', interactionId, outcome: outcome.kind, status: outcome.kind === 'response' ? outcome.status : undefined, retry: consecutiveRetries, waitMs },
        'Transient polling failure; retrying',
      );
    }
  }
}
