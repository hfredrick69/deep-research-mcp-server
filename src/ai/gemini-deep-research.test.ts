import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GeminiDeepResearchError,
  INTERACTIONS_ENDPOINT,
  MAX_AGENT,
  STANDARD_AGENT,
  buildCreateBody,
  extractReport,
  readPollIntervalMs,
  readTimeoutMs,
  runGeminiDeepResearch,
  selectAgent,
  type GeminiDeepResearchDeps,
  type InteractionResponse,
} from './gemini-deep-research.js';

// ---------------------------------------------------------------------------
// Deterministic harness: virtual clock, recorded sleeps, fake fetch, fake timers
// ---------------------------------------------------------------------------

function captureThrow(fn: () => unknown): GeminiDeepResearchError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof GeminiDeepResearchError, `expected GeminiDeepResearchError, got ${String(err)}`);
    return err;
  }
  assert.fail('expected function to throw');
}

const DUMMY_KEY = 'dummy-gemini-key-0123456789';

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal | null | undefined;
}

type Handler = (call: RecordedCall, index: number) => Response | Promise<Response>;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function hanging(call: RecordedCall): Promise<Response> {
  return new Promise((_, reject) => {
    const signal = call.signal;
    if (!signal) return;
    if (signal.aborted) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
      once: true,
    });
  });
}

class Harness {
  readonly calls: RecordedCall[] = [];
  readonly sleeps: number[] = [];
  readonly timers: { ms: number; fn: () => void; cleared: boolean }[] = [];
  time = 1_000_000;
  fireTimers = false;
  private handlers: Handler[];
  private fallback: Handler;

  constructor(handlers: Handler[], fallback?: Handler) {
    this.handlers = handlers;
    this.fallback = fallback ?? (() => json({ error: 'unexpected call' }, 599));
  }

  deps(env: NodeJS.ProcessEnv = { GEMINI_API_KEY: DUMMY_KEY }): GeminiDeepResearchDeps {
    return {
      env,
      now: () => this.time,
      sleep: async (ms) => {
        this.sleeps.push(ms);
        this.time += ms;
      },
      setTimer: (fn, ms) => {
        const entry = { ms, fn, cleared: false };
        this.timers.push(entry);
        if (this.fireTimers) setImmediate(() => { if (!entry.cleared) fn(); });
        return entry;
      },
      clearTimer: (handle) => {
        (handle as { cleared: boolean }).cleared = true;
      },
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const headers: Record<string, string> = {};
        new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
        const call: RecordedCall = { url, method: init?.method ?? 'GET', headers, body, signal: init?.signal };
        const index = this.calls.length;
        this.calls.push(call);
        const handler = this.handlers[index] ?? this.fallback;
        return handler(call, index);
      }) as typeof fetch,
    };
  }

  creates(): RecordedCall[] {
    return this.calls.filter((c) => c.method === 'POST' && c.url === INTERACTIONS_ENDPOINT);
  }

  cancels(): RecordedCall[] {
    return this.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/cancel'));
  }

  gets(): RecordedCall[] {
    return this.calls.filter((c) => c.method === 'GET');
  }
}

function completed(id: string, text = '# Report\n\nBody.', urls: string[] = ['https://example.com/a']): InteractionResponse {
  return {
    id,
    status: 'completed',
    steps: [
      {
        type: 'model_output',
        content: [
          {
            type: 'text',
            text,
            annotations: urls.map((url) => ({ type: 'url_citation', url, title: url, start_index: 0, end_index: 1 })),
          },
        ],
      },
    ],
  };
}

function inProgress(id: string): InteractionResponse {
  return { id, status: 'in_progress', steps: [] };
}

async function expectError(promise: Promise<unknown>): Promise<GeminiDeepResearchError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof GeminiDeepResearchError, `expected GeminiDeepResearchError, got ${String(err)}`);
    return err;
  }
  assert.fail('expected rejection');
}

// ---------------------------------------------------------------------------
// Agent selection and env parsing
// ---------------------------------------------------------------------------

test('selectAgent: standard below depth 3, max at depth >= 3, override wins', () => {
  assert.equal(selectAgent(undefined, {}), STANDARD_AGENT);
  assert.equal(selectAgent(1, {}), STANDARD_AGENT);
  assert.equal(selectAgent(2, {}), STANDARD_AGENT);
  assert.equal(selectAgent(3, {}), MAX_AGENT);
  assert.equal(selectAgent(5, {}), MAX_AGENT);
  assert.equal(selectAgent(1, { GEMINI_DEEP_RESEARCH_AGENT: '  custom-agent-id  ' }), 'custom-agent-id');
  assert.equal(selectAgent(4, { GEMINI_DEEP_RESEARCH_AGENT: '   ' }), MAX_AGENT);
});

test('readPollIntervalMs / readTimeoutMs: defaults, bounds and strict integer parsing', () => {
  assert.equal(readPollIntervalMs({}), 10_000);
  assert.equal(readPollIntervalMs({ GEMINI_DR_POLL_INTERVAL_MS: '  ' }), 10_000);
  assert.equal(readPollIntervalMs({ GEMINI_DR_POLL_INTERVAL_MS: '5000' }), 5000);
  assert.equal(readPollIntervalMs({ GEMINI_DR_POLL_INTERVAL_MS: '10000' }), 10_000);
  for (const bad of ['4999', '10001', '5000.5', 'abc', '-5000', 'Infinity', '1e4', '0x1388']) {
    const err = captureThrow(() => readPollIntervalMs({ GEMINI_DR_POLL_INTERVAL_MS: bad })) as unknown;
    assert.ok(err instanceof GeminiDeepResearchError, `bad value ${bad}`);
    assert.equal(err.category, 'invalid_config');
  }
  assert.equal(readTimeoutMs({}), 3_600_000);
  assert.equal(readTimeoutMs({ GEMINI_DR_TIMEOUT_MS: '1000' }), 1000);
  assert.equal(readTimeoutMs({ GEMINI_DR_TIMEOUT_MS: '3600000' }), 3_600_000);
  for (const bad of ['999', '3600001', '1.5', 'NaN', '']) {
    if (bad === '') {
      assert.equal(readTimeoutMs({ GEMINI_DR_TIMEOUT_MS: bad }), 3_600_000);
      continue;
    }
    const err = captureThrow(() => readTimeoutMs({ GEMINI_DR_TIMEOUT_MS: bad }));
    assert.equal(err.category, 'invalid_config');
  }
});

test('run: missing or blank GEMINI_API_KEY fails before any fetch', async () => {
  for (const env of [{}, { GEMINI_API_KEY: '' }, { GEMINI_API_KEY: '   ' }]) {
    const h = new Harness([]);
    const err = await expectError(runGeminiDeepResearch({ query: 'q' }, h.deps(env)));
    assert.equal(err.category, 'missing_key');
    assert.equal(h.calls.length, 0);
  }
});

test('run: invalid poll/timeout config fails before any fetch', async () => {
  const h = new Harness([]);
  const err = await expectError(
    runGeminiDeepResearch({ query: 'q' }, h.deps({ GEMINI_API_KEY: DUMMY_KEY, GEMINI_DR_TIMEOUT_MS: '12.5' })),
  );
  assert.equal(err.category, 'invalid_config');
  assert.equal(h.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Request construction
// ---------------------------------------------------------------------------

test('buildCreateBody: exact shape, prompt delimits query and prior notes, section hint clamps', () => {
  const body = buildCreateBody({
    agent: STANDARD_AGENT,
    query: 'How do heat pumps work?',
    breadth: 3,
    existingLearnings: ['note one', 'note two'],
  });
  assert.deepEqual(Object.keys(body).sort(), ['agent', 'agent_config', 'background', 'input', 'store', 'stream', 'tools'].sort());
  assert.equal(body.agent, STANDARD_AGENT);
  assert.equal(body.background, true);
  assert.equal(body.store, true);
  assert.equal(body.stream, false);
  assert.deepEqual(body.agent_config, {
    type: 'deep-research',
    thinking_summaries: 'none',
    visualization: 'off',
    collaborative_planning: false,
  });
  assert.deepEqual(body.tools, [{ type: 'google_search' }, { type: 'url_context' }]);
  assert.match(body.input, /Markdown/);
  assert.match(body.input, /How do heat pumps work\?/);
  assert.match(body.input, /note one/);
  assert.match(body.input, /note two/);
  assert.match(body.input, /unverified/i);
  assert.match(body.input, /primary sources/i);
  assert.match(body.input, /citations/i);
  assert.match(body.input, /\b8 sections\b/); // 2*3+2

  const low = buildCreateBody({ agent: STANDARD_AGENT, query: 'q', breadth: 1, existingLearnings: [] });
  assert.match(low.input, /\b4 sections\b/);
  assert.doesNotMatch(low.input, /unverified/i);
  const high = buildCreateBody({ agent: STANDARD_AGENT, query: 'q', breadth: 10, existingLearnings: [] });
  assert.match(high.input, /\b12 sections\b/);
  const dflt = buildCreateBody({ agent: STANDARD_AGENT, query: 'q' });
  assert.match(dflt.input, /\b6 sections\b/); // default breadth 2
});

test('run: create request uses fixed endpoint, key header only, JSON type, redirect error', async () => {
  const h = new Harness([() => json(completed('int-1'))]);
  const result = await runGeminiDeepResearch(
    { query: 'What is X?', depth: 3, breadth: 2 },
    h.deps({ GEMINI_API_KEY: DUMMY_KEY, GEMINI_API_ENDPOINT: 'https://evil.example/v1' }),
  );
  assert.equal(h.calls.length, 1);
  const call = h.calls[0]!;
  assert.equal(call.url, INTERACTIONS_ENDPOINT);
  assert.equal(call.method, 'POST');
  assert.equal(call.headers['x-goog-api-key'], DUMMY_KEY);
  assert.equal(call.headers['content-type'], 'application/json');
  assert.equal(call.headers['authorization'], undefined);
  assert.equal((call.body as { agent: string }).agent, MAX_AGENT);
  assert.equal(result.agent, MAX_AGENT);
  assert.equal(result.interactionId, 'int-1');
  assert.ok(!JSON.stringify(call.body).includes(DUMMY_KEY));
});

test('run: fetch init carries redirect error and an abort signal', async () => {
  let seenInit: RequestInit | undefined;
  const h = new Harness([]);
  const deps = h.deps();
  const inner = deps.fetch!;
  deps.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seenInit = init;
    return json(completed('int-1'));
  }) as typeof fetch;
  void inner;
  await runGeminiDeepResearch({ query: 'q' }, deps);
  assert.equal(seenInit?.redirect, 'error');
  assert.ok(seenInit?.signal instanceof AbortSignal);
});

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

test('run: immediate completion on POST returns report, citations and learning', async () => {
  const h = new Harness([() => json(completed('int-1', '# R\n\nText', ['https://a.example/', 'https://b.example/']))]);
  const progress: string[] = [];
  const result = await runGeminiDeepResearch(
    { query: 'q', onProgress: (status) => progress.push(status) },
    h.deps(),
  );
  assert.equal(result.content, '# R\n\nText');
  assert.deepEqual(result.visitedUrls, ['https://a.example/', 'https://b.example/']);
  assert.deepEqual(result.learnings, [`Deep research report generated by ${STANDARD_AGENT} with 2 cited URLs`]);
  assert.equal(h.calls.length, 1);
  assert.equal(h.sleeps.length, 0);
  assert.ok(progress.includes('completed'));
});

test('run: polls the same encoded id at the poll interval and reports progress each time', async () => {
  const id = 'int/with spaces';
  const h = new Harness([
    () => json(inProgress(id)),
    () => json(inProgress(id)),
    () => json(inProgress(id)),
    () => json(completed(id)),
  ]);
  const progress: { status: string; elapsedMs: number }[] = [];
  const result = await runGeminiDeepResearch(
    { query: 'q', onProgress: (status, elapsedMs) => progress.push({ status, elapsedMs }) },
    h.deps({ GEMINI_API_KEY: DUMMY_KEY, GEMINI_DR_POLL_INTERVAL_MS: '5000' }),
  );
  assert.equal(result.content, '# Report\n\nBody.');
  assert.equal(h.creates().length, 1);
  assert.equal(h.gets().length, 3);
  for (const g of h.gets()) {
    assert.equal(g.url, `${INTERACTIONS_ENDPOINT}/${encodeURIComponent(id)}`);
    assert.equal(g.headers['x-goog-api-key'], DUMMY_KEY);
    assert.equal(g.body, undefined);
  }
  assert.deepEqual(h.sleeps, [5000, 5000, 5000]);
  assert.equal(progress.filter((p) => p.status === 'in_progress').length, 4);
  assert.equal(progress.at(-1)?.status, 'completed');
  assert.equal(progress.at(-1)?.elapsedMs, 15_000);
  assert.equal(h.cancels().length, 0);
});

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

test('extractReport: last model_output only, text parts joined, citations deduped in order, offsets ignored', () => {
  const response: InteractionResponse = {
    id: 'x',
    status: 'completed',
    steps: [
      {
        type: 'model_output',
        content: [{ type: 'text', text: 'EARLY DRAFT', annotations: [{ type: 'url_citation', url: 'https://draft.example/' }] }],
      },
      { type: 'tool_call', content: [{ type: 'text', text: 'tool text' }] },
      {
        type: 'model_output',
        content: [
          { type: 'thought', text: 'thinking...' },
          {
            type: 'text',
            text: '# Título — über ünïcode 🚀',
            annotations: [
              { type: 'url_citation', url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC', title: 'wrapped', start_index: 2, end_index: 999 },
              { type: 'url_citation', url: 'https://b.example/', start_index: 0, end_index: 3 },
              { type: 'file_citation', file_id: 'f1' },
              { type: 'place_citation', place_id: 'p1' },
            ],
          },
          { type: 'image', mime_type: 'image/png', data: 'AAAA' },
          {
            type: 'text',
            text: 'Second paragraph.',
            annotations: [
              { type: 'url_citation', url: 'https://b.example/' },
              { type: 'url_citation', url: '' },
              { type: 'url_citation' },
              { type: 'url_citation', url: 'https://c.example/' },
            ],
          },
        ],
      },
    ],
  };
  const out = extractReport(response);
  assert.equal(out.content, '# Título — über ünïcode 🚀\nSecond paragraph.');
  assert.deepEqual(out.visitedUrls, [
    'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC',
    'https://b.example/',
    'https://c.example/',
  ]);
});

test('extractReport: final model_output with only images or whitespace is an empty report', () => {
  const imagesOnly: InteractionResponse = {
    id: 'x',
    status: 'completed',
    steps: [
      { type: 'model_output', content: [{ type: 'text', text: 'draft text' }] },
      { type: 'model_output', content: [{ type: 'image', mime_type: 'image/png', data: 'AAAA' }] },
    ],
  };
  const e1 = captureThrow(() => extractReport(imagesOnly));
  assert.equal(e1.category, 'empty_report');
  const whitespace: InteractionResponse = {
    id: 'x',
    status: 'completed',
    steps: [{ type: 'model_output', content: [{ type: 'text', text: '  \n\t ' }] }],
  };
  const e2 = captureThrow(() => extractReport(whitespace));
  assert.equal(e2.category, 'empty_report');
  const noSteps: InteractionResponse = { id: 'x', status: 'completed', steps: [] };
  const e3 = captureThrow(() => extractReport(noSteps));
  assert.equal(e3.category, 'empty_report');
});

test('extractReport: malformed steps shape is a protocol error', () => {
  const e = captureThrow(() =>
    extractReport({ id: 'x', status: 'completed', steps: 'nope' } as unknown as InteractionResponse),
  );
  assert.equal(e.category, 'protocol');
});

test('run: extraction failure after completed carries the interaction id in message and error', async () => {
  const h = new Harness([
    () => json({ id: 'billed-1', status: 'completed', steps: [{ type: 'model_output', content: [] }] }),
  ]);
  const err = await expectError(runGeminiDeepResearch({ query: 'q' }, h.deps()));
  assert.equal(err.category, 'empty_report');
  assert.equal(err.interactionId, 'billed-1');
  assert.equal(err.afterCompleted, true);
  assert.match(err.message, /billed-1/);
  assert.equal(h.cancels().length, 0);
});

// ---------------------------------------------------------------------------
// State table
// ---------------------------------------------------------------------------

test('run: failed / cancelled / incomplete fail as upstream without cancel', async () => {
  for (const status of ['failed', 'cancelled', 'incomplete']) {
    const h = new Harness([
      () => json(inProgress('int-2')),
      () => json({ id: 'int-2', status, steps: [], errors: [{ code: 'E', message: `boom ${DUMMY_KEY}` }] }),
    ]);
    const err = await expectError(runGeminiDeepResearch({ query: 'q' }, h.deps()));
    assert.equal(err.category, 'upstream_failed', status);
    assert.equal(err.interactionId, 'int-2');
    assert.equal(h.cancels().length, 0, status);
    assert.equal(h.creates().length, 1, status);
    assert.ok(!err.message.includes(DUMMY_KEY));
  }
});

test('run: requires_action / requires_continuation are unsupported and cancelled exactly once', async () => {
  for (const status of ['requires_action', 'requires_continuation']) {
    const h = new Harness([
      () => json({ id: 'int-3', status, steps: [], continuation_token: 'secret-token' }),
      () => json({ id: 'int-3', status: 'cancelled' }),
    ]);
    const err = await expectError(runGeminiDeepResearch({ query: 'q' }, h.deps()));
    assert.equal(err.category, 'unsupported_state', status);
    assert.equal(err.interactionId, 'int-3');
    assert.equal(h.cancels().length, 1, status);
    assert.equal(h.cancels()[0]!.url, `${INTERACTIONS_ENDPOINT}/int-3/cancel`);
    assert.equal(h.cancels()[0]!.headers['x-goog-api-key'], DUMMY_KEY);
    assert.ok(!err.message.includes('secret-token'));
    assert.equal(h.creates().length, 1);
  }
});

test('run: unknown status is a protocol error, cancelled when the id is known', async () => {
  const h = new Harness([() => json({ id: 'int-4', status: 'weird' }), () => json({})]);
  const err = await expectError(runGeminiDeepResearch({ query: 'q' }, h.deps()));
  assert.equal(err.category, 'protocol');
  assert.equal(h.cancels().length, 1);
});

test('run: missing id, missing status or non-JSON body on create is a protocol error with no cancel', async () => {
  const cases: Handler[] = [
    () => json({ status: 'in_progress' }),
    () => json({ id: '', status: 'in_progress' }),
    () => json({ id: 'int-5' }),
    () => json([1, 2, 3]),
    () => new Response('<html>not json</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
  ];
  for (const handler of cases) {
    const h = new Harness([handler]);
    const err = await expectError(runGeminiDeepResearch({ query: 'q' }, h.deps()));
    assert.equal(err.category, 'protocol');
    assert.equal(h.cancels().length, 0);
    assert.equal(h.creates().length, 1);
  }
});

test('run: GET returning a different id is a protocol error and cancels the original id', async () => {
  const h = new Harness([
    () => json(inProgress('int-6')),
    () => json(completed('other-id')),
    () => json({}),
  ]);
  const err = await expectError(runGeminiDeepResearch({ query: 'q' }, h.deps()));
  assert.equal(err.category, 'protocol');
  assert.equal(h.cancels().length, 1);
  assert.equal(h.cancels()[0]!.url, `${INTERACTIONS_ENDPOINT}/int-6/cancel`);
});

// ---------------------------------------------------------------------------
// HTTP failures and retries
// ---------------------------------------------------------------------------

test('run: 401/403 on create are auth errors, 404/400 protocol, 5xx upstream; never a second create', async () => {
  const expectations: [number, string][] = [
    [401, 'auth'],
    [403, 'auth'],
    [404, 'protocol'],
    [400, 'protocol'],
    [500, 'upstream_failed'],
    [503, 'upstream_failed'],
  ];
  for (const [status, category] of expectations) {
    const h = new Harness([() => json({ error: { message: `denied ${DUMMY_KEY}` } }, status)]);
    const err = await expectError(runGeminiDeepResearch({ query: 'q' }, h.deps()));
    assert.equal(err.category, category, `status ${status}`);
    assert.equal(h.creates().length, 1, `status ${status}`);
    assert.equal(h.cancels().length, 0);
    assert.ok(!err.message.includes(DUMMY_KEY));
  }
});

test('run: 429 on create is a quota error with no retry', async () => {
  const h = new Harness([() => json({ error: 'rate' }, 429)]);
  const err = await expectError(runGeminiDeepResearch({ query: 'q' }, h.deps()));
  assert.equal(err.category, 'quota');
  assert.equal(h.calls.length, 1);
});

test('run: network error on create is upstream_failed with one attempt and no cancel', async () => {
  const h = new Harness([() => { throw new TypeError('fetch failed'); }]);
  const err = await expectError(runGeminiDeepResearch({ query: 'q' }, h.deps()));
  assert.equal(err.category, 'upstream_failed');
  assert.equal(err.interactionId, undefined);
  assert.equal(h.calls.length, 1);
});

test('run: GET retries twice for 5xx/429/network, waiting at least the poll interval, then continues', async () => {
  const h = new Harness([
    () => json(inProgress('int-7')),
    () => json({ error: 'x' }, 503),
    () => { throw new TypeError('fetch failed'); },
    () => json(inProgress('int-7')), // success resets the retry budget
    () => json({ error: 'x' }, 429),
    () => json({ error: 'x' }, 500),
    () => json(completed('int-7')),
  ]);
  const result = await runGeminiDeepResearch({ query: 'q' }, h.deps({ GEMINI_API_KEY: DUMMY_KEY, GEMINI_DR_POLL_INTERVAL_MS: '5000' }));
  assert.equal(result.content, '# Report\n\nBody.');
  assert.equal(h.creates().length, 1);
  assert.equal(h.gets().length, 6);
  assert.ok(h.sleeps.every((ms) => ms >= 5000), JSON.stringify(h.sleeps));
});

test('run: GET failing three times consecutively exhausts retries and cancels once', async () => {
  const h = new Harness([
    () => json(inProgress('int-8')),
    () => json({ error: 'x' }, 500),
    () => json({ error: 'x' }, 502),
    () => json({ error: 'x' }, 503),
    () => json({}), // cancel
  ]);
  const err = await expectError(runGeminiDeepResearch({ query: 'q' }, h.deps()));
  assert.equal(err.category, 'upstream_failed');
  assert.equal(err.interactionId, 'int-8');
  assert.equal(h.gets().length, 3);
  assert.equal(h.cancels().length, 1);
  assert.equal(h.creates().length, 1);
});

test('run: 429 exhausted on GET reports quota', async () => {
  const h = new Harness([
    () => json(inProgress('int-9')),
    () => json({}, 429),
    () => json({}, 429),
    () => json({}, 429),
    () => json({}),
  ]);
  const err = await expectError(runGeminiDeepResearch({ query: 'q' }, h.deps()));
  assert.equal(err.category, 'quota');
  assert.equal(h.cancels().length, 1);
});

test('run: 401 on GET is not retried', async () => {
  const h = new Harness([() => json(inProgress('int-10')), () => json({}, 401), () => json({})]);
  const err = await expectError(runGeminiDeepResearch({ query: 'q' }, h.deps()));
  assert.equal(err.category, 'auth');
  assert.equal(h.gets().length, 1);
  assert.equal(h.cancels().length, 1);
});

test('run: Retry-After is honored within the deadline', async () => {
  const h = new Harness([
    () => json(inProgress('int-11')),
    () => json({}, 429, { 'retry-after': '30' }),
    () => json(completed('int-11')),
  ]);
  await runGeminiDeepResearch({ query: 'q' }, h.deps({ GEMINI_API_KEY: DUMMY_KEY, GEMINI_DR_POLL_INTERVAL_MS: '5000' }));
  assert.deepEqual(h.sleeps, [5000, 30_000]);
});

test('run: Retry-After beyond the remaining deadline fails with timeout and cancels', async () => {
  const h = new Harness([
    () => json(inProgress('int-12')),
    () => json({}, 503, { 'retry-after': '120' }),
    () => json({}),
  ]);
  const err = await expectError(
    runGeminiDeepResearch({ query: 'q' }, h.deps({ GEMINI_API_KEY: DUMMY_KEY, GEMINI_DR_TIMEOUT_MS: '60000', GEMINI_DR_POLL_INTERVAL_MS: '5000' })),
  );
  assert.equal(err.category, 'timeout');
  assert.equal(h.cancels().length, 1);
});

// ---------------------------------------------------------------------------
// Deadlines, hangs, cancellation
// ---------------------------------------------------------------------------

test('run: a hanging create is aborted after min(60000, remaining) and fails as timeout with no cancel', async () => {
  const h = new Harness([hanging]);
  h.fireTimers = true;
  const err = await expectError(runGeminiDeepResearch({ query: 'q' }, h.deps()));
  assert.equal(err.category, 'timeout');
  assert.equal(err.interactionId, undefined);
  assert.equal(h.cancels().length, 0);
  assert.equal(h.timers[0]?.ms, 60_000);
});

test('run: per-request bound shrinks to the remaining deadline', async () => {
  const h = new Harness([hanging]);
  h.fireTimers = true;
  const err = await expectError(
    runGeminiDeepResearch({ query: 'q' }, h.deps({ GEMINI_API_KEY: DUMMY_KEY, GEMINI_DR_TIMEOUT_MS: '15000' })),
  );
  assert.equal(err.category, 'timeout');
  assert.equal(h.timers[0]?.ms, 15_000);
});

test('run: a hanging GET counts as a transport failure and is retried, then times out with one cancel', async () => {
  const h = new Harness([() => json(inProgress('int-13'))], (call) => {
    if (call.url.endsWith('/cancel')) return json({});
    return hanging(call);
  });
  h.fireTimers = true;
  const err = await expectError(runGeminiDeepResearch({ query: 'q' }, h.deps()));
  assert.ok(['timeout', 'upstream_failed'].includes(err.category), err.category);
  assert.equal(h.gets().length, 3);
  assert.equal(h.cancels().length, 1);
  assert.equal(h.creates().length, 1);
});

test('run: deadline expiring during a wait fails as timeout and cancels exactly once', async () => {
  const h = new Harness([() => json(inProgress('int-14')), () => json({})]);
  const err = await expectError(
    runGeminiDeepResearch({ query: 'q' }, h.deps({ GEMINI_API_KEY: DUMMY_KEY, GEMINI_DR_TIMEOUT_MS: '1000' })),
  );
  assert.equal(err.category, 'timeout');
  assert.equal(err.interactionId, 'int-14');
  assert.deepEqual(h.sleeps, [1000]); // wait capped by the remaining deadline
  assert.equal(h.gets().length, 0);
  assert.equal(h.cancels().length, 1);
  assert.equal(h.cancels()[0]!.url, `${INTERACTIONS_ENDPOINT}/int-14/cancel`);
});

test('run: cancel request failure preserves the original error', async () => {
  const h = new Harness([
    () => json({ id: 'int-15', status: 'requires_action' }),
    () => { throw new TypeError('cancel network down'); },
  ]);
  const err = await expectError(runGeminiDeepResearch({ query: 'q' }, h.deps()));
  assert.equal(err.category, 'unsupported_state');
  assert.equal(h.cancels().length, 1);
});

test('run: a hanging cancel is bounded and does not change the original error', async () => {
  const h = new Harness([() => json({ id: 'int-16', status: 'requires_continuation' }), hanging]);
  h.fireTimers = true;
  const err = await expectError(runGeminiDeepResearch({ query: 'q' }, h.deps()));
  assert.equal(err.category, 'unsupported_state');
  assert.equal(h.cancels().length, 1);
  assert.ok(h.timers.some((t) => t.ms === 10_000));
});

test('run: external abort ends polling, cancels once, fails as cancelled', async () => {
  const controller = new AbortController();
  const h = new Harness([
    () => { controller.abort(); return json(inProgress('int-17')); },
    () => json({}),
  ]);
  const err = await expectError(runGeminiDeepResearch({ query: 'q', signal: controller.signal }, h.deps()));
  assert.equal(err.category, 'cancelled');
  assert.equal(err.interactionId, 'int-17');
  assert.equal(h.gets().length, 0);
  assert.equal(h.cancels().length, 1);
});

test('run: already-aborted signal fails as cancelled before any fetch', async () => {
  const controller = new AbortController();
  controller.abort();
  const h = new Harness([]);
  const err = await expectError(runGeminiDeepResearch({ query: 'q', signal: controller.signal }, h.deps()));
  assert.equal(err.category, 'cancelled');
  assert.equal(h.calls.length, 0);
});

test('run: a throwing progress callback does not strand the interaction', async () => {
  const h = new Harness([() => json(inProgress('int-18')), () => json(completed('int-18'))]);
  let calls = 0;
  const result = await runGeminiDeepResearch(
    { query: 'q', onProgress: () => { calls += 1; throw new Error('ui exploded'); } },
    h.deps(),
  );
  assert.equal(result.content, '# Report\n\nBody.');
  assert.ok(calls >= 2);
  assert.equal(h.cancels().length, 0);
});

test('run: upstream text echoing the key never reaches error messages', async () => {
  const h = new Harness([() => new Response(`fatal: key ${DUMMY_KEY} rejected`, { status: 500 })]);
  const err = await expectError(runGeminiDeepResearch({ query: 'q' }, h.deps()));
  assert.ok(!err.message.includes(DUMMY_KEY));
  assert.ok(!String(err.stack).includes(DUMMY_KEY));
});

test('GeminiDeepResearchError exposes an allowlisted category only', () => {
  const err = new GeminiDeepResearchError('protocol', 'bad shape');
  assert.equal(err.name, 'GeminiDeepResearchError');
  assert.equal(err.category, 'protocol');
  assert.equal(err.interactionId, undefined);
  assert.equal(err.afterCompleted, false);
});
