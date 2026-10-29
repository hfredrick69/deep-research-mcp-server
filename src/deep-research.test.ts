import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import process from 'node:process';
import {
  research,
  resolveResearchProvider,
  type ResearchDeps,
  type ResearchProgress,
} from './deep-research.js';
import {
  GeminiDeepResearchError,
  INTERACTIONS_ENDPOINT,
  MAX_AGENT,
  STANDARD_AGENT,
  type GeminiDeepResearchDeps,
} from './ai/gemini-deep-research.js';

const DUMMY_GEMINI_KEY = 'dummy-gemini-key-0123456789';
const DUMMY_OPENAI_KEY = 'dummy-openai-key-0123456789';
const SCRATCH_ROOT = process.env.DEEP_RESEARCH_TEST_TMP ?? path.join(process.cwd(), 'node_modules', '.deep-research-test-tmp');

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  await fs.mkdir(SCRATCH_ROOT, { recursive: true });
  const dir = await fs.mkdtemp(path.join(SCRATCH_ROOT, 'run-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function captureRejection(p: Promise<unknown>): Promise<GeminiDeepResearchError> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof GeminiDeepResearchError, `expected GeminiDeepResearchError, got ${String(err)}`);
    return err;
  }
  assert.fail('expected promise to reject');
}

function captureThrow(fn: () => unknown): GeminiDeepResearchError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof GeminiDeepResearchError, `expected GeminiDeepResearchError, got ${String(err)}`);
    return err;
  }
  assert.fail('expected function to throw');
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
  signal: AbortSignal | null | undefined;
}

/** Fake Interactions API: create returns in_progress, first GET returns completed. */
function fakeAgentApi(opts: { text?: string; urls?: string[]; id?: string } = {}) {
  const id = opts.id ?? 'interaction-test-1';
  const text = opts.text ?? '## Executive summary\n\nBody text with a claim.\n\n## Conclusion\n\nDone.';
  const urls = opts.urls ?? ['https://example.org/a', 'https://example.org/b'];
  const calls: RecordedCall[] = [];
  const completed = {
    id,
    status: 'completed',
    steps: [
      {
        type: 'model_output',
        content: [
          {
            type: 'text',
            text,
            annotations: urls.map((url, i) => ({ type: 'url_citation', url, title: `Source ${i}`, start_index: 0, end_index: 1 })),
          },
        ],
      },
    ],
  };
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body, signal: init?.signal });
    if (method === 'POST' && url === INTERACTIONS_ENDPOINT) {
      return jsonResponse({ id, status: 'in_progress', steps: [] });
    }
    if (method === 'GET' && url === `${INTERACTIONS_ENDPOINT}/${encodeURIComponent(id)}`) {
      return jsonResponse(completed);
    }
    if (method === 'POST' && url.endsWith('/cancel')) {
      return jsonResponse({ id, status: 'cancelled' });
    }
    return jsonResponse({ error: 'unexpected' }, 599);
  };
  const agentDeps: GeminiDeepResearchDeps = {
    fetch: fetchImpl as typeof fetch,
    sleep: async () => {},
    now: (() => {
      let t = 1_000_000;
      return () => (t += 1000);
    })(),
  };
  return { calls, agentDeps, id, text, urls };
}

function createBody(calls: RecordedCall[]): Record<string, unknown> {
  const create = calls.find(c => c.method === 'POST' && c.url === INTERACTIONS_ENDPOINT);
  assert.ok(create, 'expected a create POST');
  return create.body as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// resolveResearchProvider
// ---------------------------------------------------------------------------

test('resolveResearchProvider: unset or blank selects the Gemini agent', () => {
  assert.equal(resolveResearchProvider({}), 'gemini');
  assert.equal(resolveResearchProvider({ RESEARCH_PROVIDER: '' }), 'gemini');
  assert.equal(resolveResearchProvider({ RESEARCH_PROVIDER: '   ' }), 'gemini');
});

test('resolveResearchProvider: trims and lowercases all names', () => {
  assert.equal(resolveResearchProvider({ RESEARCH_PROVIDER: 'gemini' }), 'gemini');
  assert.equal(resolveResearchProvider({ RESEARCH_PROVIDER: ' Gemini\t' }), 'gemini');
  assert.equal(resolveResearchProvider({ RESEARCH_PROVIDER: 'GEMINI-LEGACY' }), 'gemini-legacy');
  assert.equal(resolveResearchProvider({ RESEARCH_PROVIDER: ' gemini-legacy ' }), 'gemini-legacy');
  assert.equal(resolveResearchProvider({ RESEARCH_PROVIDER: 'openai' }), 'openai');
  assert.equal(resolveResearchProvider({ RESEARCH_PROVIDER: 'OpenAI ' }), 'openai');
});

test('resolveResearchProvider: unknown names are rejected explicitly without echoing the value', () => {
  const err = captureThrow(() => resolveResearchProvider({ RESEARCH_PROVIDER: 'bing-secret-name' }));
  assert.equal(err.category, 'invalid_config');
  assert.match(err.message, /RESEARCH_PROVIDER/);
  assert.doesNotMatch(err.message, /bing-secret-name/);
  captureThrow(() => resolveResearchProvider({ RESEARCH_PROVIDER: 'gemini legacy' }));
  captureThrow(() => resolveResearchProvider({ RESEARCH_PROVIDER: 'google' }));
});

test('resolveResearchProvider: defaults to process.env when no env is passed', () => {
  const before = process.env.RESEARCH_PROVIDER;
  try {
    process.env.RESEARCH_PROVIDER = 'gemini-legacy';
    assert.equal(resolveResearchProvider(), 'gemini-legacy');
    delete process.env.RESEARCH_PROVIDER;
    assert.equal(resolveResearchProvider(), 'gemini');
  } finally {
    if (before === undefined) delete process.env.RESEARCH_PROVIDER;
    else process.env.RESEARCH_PROVIDER = before;
  }
});

// ---------------------------------------------------------------------------
// research(): Gemini agent path
// ---------------------------------------------------------------------------

test('agent path: writes a report under cwd, returns identical content, metadata and progress', async () => {
  await withTempDir(async dir => {
    const api = fakeAgentApi();
    const progress: ResearchProgress[] = [];
    const legacyLoads: number[] = [];
    const deps: ResearchDeps = {
      env: { GEMINI_API_KEY: DUMMY_GEMINI_KEY },
      agentDeps: api.agentDeps,
      cwd: () => dir,
      loadLegacy: async () => {
        legacyLoads.push(1);
        throw new Error('legacy must not load on the agent path');
      },
    };
    const result = await research({ query: 'Quantum networking market 2026', onProgress: p => progress.push({ ...p }) }, deps);

    assert.equal(legacyLoads.length, 0);
    assert.ok(result.reportPath, 'reportPath present');
    assert.ok(path.isAbsolute(result.reportPath));
    assert.equal(path.dirname(result.reportPath), dir);
    assert.match(path.basename(result.reportPath), /^deep_research_report_\d{4}-\d{2}-\d{2}T[\d-]+Z\.md$/);

    const onDisk = await fs.readFile(result.reportPath, 'utf-8');
    assert.equal(onDisk, result.content);
    assert.ok(result.content?.startsWith('# Quantum networking market 2026\n\n'));
    assert.match(result.content ?? '', new RegExp(`\\*Generated by Gemini Deep Research \\(${STANDARD_AGENT}\\)\\*`));
    assert.ok(result.content?.endsWith(api.text), 'full agent text preserved at the end of the report');

    assert.deepEqual(result.visitedUrls, api.urls);
    assert.deepEqual(result.learnings, [`Deep research report generated by ${STANDARD_AGENT} with 2 cited URLs`]);

    assert.ok(progress.length >= 2, 'at least one running tick plus the completion tick');
    const running = progress.slice(0, -1);
    for (const p of running) {
      assert.equal(p.totalDepth, 1);
      assert.equal(p.totalBreadth, 1);
      assert.equal(p.totalQueries, 1);
      assert.equal(p.currentDepth, 1);
      assert.equal(p.currentBreadth, 1);
      assert.equal(p.completedQueries, 0);
      assert.equal(typeof p.currentQuery, 'string');
      assert.ok(p.currentQuery.length > 0);
    }
    const last = progress[progress.length - 1]!;
    assert.deepEqual(last, {
      currentDepth: 0,
      totalDepth: 1,
      currentBreadth: 0,
      totalBreadth: 1,
      totalQueries: 1,
      completedQueries: 1,
      currentQuery: 'completed',
    });

    const entries = await fs.readdir(dir);
    assert.equal(entries.length, 1, 'exactly one report written');
  });
});

test('agent path: default cwd is process.cwd()', async () => {
  await withTempDir(async dir => {
    const api = fakeAgentApi();
    const previous = process.cwd();
    process.chdir(dir);
    try {
      const result = await research(
        { query: 'cwd default' },
        { env: { GEMINI_API_KEY: DUMMY_GEMINI_KEY }, agentDeps: api.agentDeps },
      );
      assert.equal(path.dirname(result.reportPath!), await fs.realpath(dir));
    } finally {
      process.chdir(previous);
    }
  });
});

test('agent path: existingLearnings become delimited prior notes, depth picks the tier, breadth sets sections', async () => {
  await withTempDir(async dir => {
    const api = fakeAgentApi();
    const result = await research(
      {
        query: 'Edge AI chips',
        depth: 3,
        breadth: 4,
        existingLearnings: ['Note one', 'Note two'],
      },
      { env: { GEMINI_API_KEY: DUMMY_GEMINI_KEY }, agentDeps: api.agentDeps, cwd: () => dir },
    );
    const body = createBody(api.calls);
    assert.equal(body.agent, MAX_AGENT);
    const input = String(body.input);
    assert.match(input, /<research_query>\s*Edge AI chips\s*<\/research_query>/);
    assert.match(input, /<prior_notes>[\s\S]*- Note one\n- Note two[\s\S]*<\/prior_notes>/);
    assert.match(input, /approximately 10 sections/);
    assert.match(result.content ?? '', new RegExp(`\\(${MAX_AGENT}\\)`));
    assert.deepEqual(result.learnings, [`Deep research report generated by ${MAX_AGENT} with 2 cited URLs`]);
  });
});

test('agent path: default depth/breadth select the standard tier with six sections and no prior notes', async () => {
  await withTempDir(async dir => {
    const api = fakeAgentApi();
    await research({ query: 'Defaults' }, { env: { GEMINI_API_KEY: DUMMY_GEMINI_KEY }, agentDeps: api.agentDeps, cwd: () => dir });
    const body = createBody(api.calls);
    assert.equal(body.agent, STANDARD_AGENT);
    assert.match(String(body.input), /approximately 6 sections/);
    assert.doesNotMatch(String(body.input), /<prior_notes>/);
  });
});

test('agent path: GEMINI_DEEP_RESEARCH_AGENT override wins and is attributed', async () => {
  await withTempDir(async dir => {
    const api = fakeAgentApi();
    const result = await research(
      { query: 'Override', depth: 3 },
      {
        env: { GEMINI_API_KEY: DUMMY_GEMINI_KEY, GEMINI_DEEP_RESEARCH_AGENT: ' custom-agent-id ' },
        agentDeps: api.agentDeps,
        cwd: () => dir,
      },
    );
    assert.equal(createBody(api.calls).agent, 'custom-agent-id');
    assert.match(result.content ?? '', /\(custom-agent-id\)/);
  });
});

test('agent path: report write failure is persist_failed with the interaction id and no success', async () => {
  await withTempDir(async dir => {
    const api = fakeAgentApi({ id: 'interaction-persist' });
    const err = await captureRejection(
      research(
        { query: 'Persist failure' },
        {
          env: { GEMINI_API_KEY: DUMMY_GEMINI_KEY },
          agentDeps: api.agentDeps,
          cwd: () => dir,
          writeFile: async () => {
            throw new Error('EACCES: permission denied, open /secret/path');
          },
        },
      ),
    );
    assert.equal(err.category, 'persist_failed');
    assert.equal(err.interactionId, 'interaction-persist');
    assert.equal(err.afterCompleted, true);
    assert.deepEqual(await fs.readdir(dir), []);
  });
});

test('agent path: missing key fails before any network call', async () => {
  await withTempDir(async dir => {
    const api = fakeAgentApi();
    const err = await captureRejection(research({ query: 'No key' }, { env: {}, agentDeps: api.agentDeps, cwd: () => dir }));
    assert.equal(err.category, 'missing_key');
    assert.equal(api.calls.length, 0);
    assert.deepEqual(await fs.readdir(dir), []);
  });
});

test('agent path: the signal option reaches the agent client', async () => {
  await withTempDir(async dir => {
    const api = fakeAgentApi();
    const controller = new AbortController();
    controller.abort();
    const err = await captureRejection(
      research(
        { query: 'Aborted', signal: controller.signal },
        { env: { GEMINI_API_KEY: DUMMY_GEMINI_KEY }, agentDeps: api.agentDeps, cwd: () => dir },
      ),
    );
    assert.equal(err.category, 'cancelled');
    assert.equal(api.calls.length, 0);
    assert.deepEqual(await fs.readdir(dir), []);
  });
});

test('agent path: a throwing progress callback does not strand the run', async () => {
  await withTempDir(async dir => {
    const api = fakeAgentApi();
    let calls = 0;
    const result = await research(
      {
        query: 'Throwing callback',
        onProgress: () => {
          calls += 1;
          throw new Error('consumer bug');
        },
      },
      { env: { GEMINI_API_KEY: DUMMY_GEMINI_KEY }, agentDeps: api.agentDeps, cwd: () => dir },
    );
    assert.ok(calls >= 2);
    assert.ok(result.reportPath);
  });
});

// ---------------------------------------------------------------------------
// research(): gemini-legacy path
// ---------------------------------------------------------------------------

test('legacy path: loads the legacy module lazily and keeps the agentic report format', async () => {
  await withTempDir(async dir => {
    const prompts: string[] = [];
    const legacy = {
      callGeminiProConfigurable: async (prompt: string) => {
        prompts.push(prompt);
        if (prompts.length === 1) {
          return '```json\n["1. Executive Summary", "2. Outlook"]\n```';
        }
        return '## 1. Executive Summary\nSection body for prompt ' + prompts.length;
      },
    };
    let loads = 0;
    const progress: ResearchProgress[] = [];
    const agentCalls: RecordedCall[] = [];
    const result = await research(
      { query: 'Legacy topic', onProgress: p => progress.push({ ...p }) },
      {
        env: { RESEARCH_PROVIDER: 'gemini-legacy', GEMINI_API_KEY: DUMMY_GEMINI_KEY },
        cwd: () => dir,
        loadLegacy: async () => {
          loads += 1;
          return legacy;
        },
        agentDeps: {
          fetch: (async (input: string | URL | Request) => {
            agentCalls.push({ url: String(input), method: 'GET', body: undefined, signal: undefined });
            return jsonResponse({}, 599);
          }) as typeof fetch,
        },
      },
    );
    assert.equal(loads, 1);
    assert.equal(agentCalls.length, 0, 'agent API never contacted on the legacy path');
    assert.equal(prompts.length, 3);
    assert.match(path.basename(result.reportPath!), /^agentic_report_/);
    assert.equal(path.dirname(result.reportPath!), dir);
    assert.ok(result.content?.startsWith('# Legacy topic\n\n*Generated by Gemini Agentic Researcher*'));
    assert.match(result.content ?? '', /## 1\. Executive Summary\n\nSection body for prompt 2/);
    assert.deepEqual(result.learnings, ['Completed section: 1. Executive Summary', 'Completed section: 2. Outlook']);
    assert.deepEqual(result.visitedUrls, []);
    assert.equal(await fs.readFile(result.reportPath!, 'utf-8'), result.content);
    assert.equal(progress.length, 2);
    assert.equal(progress[0]!.totalQueries, 2);
    assert.equal(progress[0]!.currentQuery, 'Researching: 1. Executive Summary');
  });
});

test('legacy path: unparseable outline falls back to the built-in sections', async () => {
  await withTempDir(async dir => {
    let n = 0;
    const result = await research(
      { query: 'Legacy fallback' },
      {
        env: { RESEARCH_PROVIDER: 'gemini-legacy' },
        cwd: () => dir,
        loadLegacy: async () => ({
          callGeminiProConfigurable: async () => {
            n += 1;
            return n === 1 ? 'not json at all' : `body ${n}`;
          },
        }),
      },
    );
    assert.equal(result.learnings.length, 6);
    assert.equal(result.learnings[0], 'Completed section: 1. Executive Summary');
  });
});

// ---------------------------------------------------------------------------
// research(): explicit OpenAI path (no Gemini key required)
// ---------------------------------------------------------------------------

test('openai path: explicit selection works without a Gemini key and writes the OpenAI report', async () => {
  await withTempDir(async dir => {
    const realFetch = globalThis.fetch;
    const envBefore = { ...process.env };
    const openaiCalls: RecordedCall[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      openaiCalls.push({ url, method: init?.method ?? 'GET', body: init?.body, signal: init?.signal });
      return jsonResponse({
        id: 'resp_1',
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: 'OpenAI report body',
                annotations: [{ type: 'url_citation', url: 'https://example.com/o' }],
              },
            ],
          },
        ],
      });
    }) as typeof fetch;
    try {
      delete process.env.GEMINI_API_KEY;
      process.env.OPENAI_API_KEY = DUMMY_OPENAI_KEY;
      const progress: ResearchProgress[] = [];
      const result = await research(
        { query: 'OpenAI topic', onProgress: p => progress.push({ ...p }) },
        {
          env: { RESEARCH_PROVIDER: 'openai' },
          cwd: () => dir,
          loadLegacy: async () => {
            throw new Error('legacy must not load on the openai path');
          },
        },
      );
      assert.equal(openaiCalls.length, 1);
      assert.match(openaiCalls[0]!.url, /\/responses$/);
      assert.match(path.basename(result.reportPath!), /^deep_research_report_/);
      assert.equal(path.dirname(result.reportPath!), dir);
      assert.match(result.content ?? '', /\*Generated by OpenAI Deep Research \(o4-mini-deep-research\)\*/);
      assert.ok(result.content?.endsWith('OpenAI report body'));
      assert.deepEqual(result.visitedUrls, ['https://example.com/o']);
      assert.equal(await fs.readFile(result.reportPath!, 'utf-8'), result.content);
      assert.ok(progress.length >= 1);
      assert.equal(progress[0]!.totalQueries, 1);
    } finally {
      globalThis.fetch = realFetch;
      for (const key of Object.keys(process.env)) {
        if (!(key in envBefore)) delete process.env[key];
      }
      Object.assign(process.env, envBefore);
    }
  });
});
