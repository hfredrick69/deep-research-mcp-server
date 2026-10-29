import { test } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LRUCache } from 'lru-cache';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  apiKeyAuth,
  createServer,
  describeResearchConfig,
  type MCPResearchResult,
  type ServerDeps,
} from './server.js';
import { GeminiDeepResearchError, MAX_AGENT, STANDARD_AGENT } from './ai/gemini-deep-research.js';
import type { ResearchOptions, ResearchResult } from './deep-research.js';

const DUMMY_GEMINI_KEY = 'dummy-gemini-key-0123456789';
const DUMMY_OPENAI_KEY = 'dummy-openai-key-0123456789';

const GEMINI_ENV: NodeJS.ProcessEnv = { GEMINI_API_KEY: DUMMY_GEMINI_KEY };
const OPENAI_ENV: NodeJS.ProcessEnv = { RESEARCH_PROVIDER: 'openai', OPENAI_API_KEY: DUMMY_OPENAI_KEY };

interface ResearchStub {
  fn: NonNullable<ServerDeps['research']>;
  calls: ResearchOptions[];
}

function stubResearch(impl: (options: ResearchOptions) => Promise<ResearchResult>): ResearchStub {
  const calls: ResearchOptions[] = [];
  const fn: NonNullable<ServerDeps['research']> = async (options) => {
    calls.push(options);
    return impl(options);
  };
  return { fn, calls };
}

function okResult(content = '# Report\n\nbody'): ResearchResult {
  return { learnings: ['l1', 'l2'], visitedUrls: ['https://example.test/a'], content, reportPath: '/dev/null' };
}

async function connect(deps: ServerDeps): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'server-test', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function callRun(client: Client, args: Record<string, unknown>, options?: Parameters<Client['callTool']>[2]): Promise<MCPResearchResult> {
  const result = await client.callTool({ name: 'deepResearch.run', arguments: args }, undefined, options);
  return result as unknown as MCPResearchResult;
}

function textOf(result: MCPResearchResult): string {
  return result.content.map(part => part.text).join('\n');
}

test('registers deepResearch.run with the documented input schema', async () => {
  const { client, close } = await connect({ env: GEMINI_ENV, research: stubResearch(async () => okResult()).fn });
  try {
    const { tools } = await client.listTools();
    const tool = tools.find(t => t.name === 'deepResearch.run');
    assert.ok(tool, 'tool registered');
    assert.match(tool.description ?? '', /Gemini Deep Research/);
    assert.match(tool.description ?? '', /you MUST automatically download the report/i);
    const props = (tool.inputSchema as { properties: Record<string, unknown>; required?: string[] }).properties;
    assert.deepEqual(Object.keys(props).sort(), ['breadth', 'depth', 'existingLearnings', 'flags', 'goal', 'query']);
    assert.deepEqual((tool.inputSchema as { required?: string[] }).required, ['query']);
  } finally {
    await close();
  }
});

test('applies default depth/breadth/existingLearnings and forwards the request signal', async () => {
  const stub = stubResearch(async () => okResult());
  const { client, close } = await connect({ env: GEMINI_ENV, research: stub.fn });
  try {
    await callRun(client, { query: 'defaults' });
    assert.equal(stub.calls.length, 1);
    const opts = stub.calls[0]!;
    assert.equal(opts.query, 'defaults');
    assert.equal(opts.depth, 2);
    assert.equal(opts.breadth, 2);
    assert.deepEqual(opts.existingLearnings, []);
    assert.ok(opts.signal instanceof AbortSignal, 'signal forwarded');
    assert.equal(opts.signal.aborted, false);
  } finally {
    await close();
  }
});

test('returns the report inline with metadata in stdio mode', async () => {
  const { client, close } = await connect({ env: GEMINI_ENV, research: stubResearch(async () => okResult('# Inline\n\nhello')).fn });
  try {
    const result = await callRun(client, { query: 'inline' });
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0]!.type, 'text');
    assert.match(result.content[0]!.text, /RESEARCH COMPLETE/);
    assert.match(result.content[0]!.text, /# Inline\n\nhello/);
    assert.deepEqual(result.metadata.learnings, ['l1', 'l2']);
    assert.deepEqual(result.metadata.visitedUrls, ['https://example.test/a']);
    assert.deepEqual(result.metadata.stats, { totalLearnings: 2, totalSources: 1 });
    assert.equal(result.metadata.reportUrl, undefined);
    assert.equal(typeof result.metadata.reportSizeKB, 'number');
    assert.equal(result.isError, undefined);
  } finally {
    await close();
  }
});

test('uploads large reports in HTTP mode and returns the download instructions', async () => {
  const big = '# Big\n\n' + 'x'.repeat(60 * 1024);
  const uploads: Array<{ content: string; query: string }> = [];
  const { client, close } = await connect({
    env: { ...GEMINI_ENV, MCP_HTTP_MODE: 'true' },
    research: stubResearch(async () => okResult(big)).fn,
    uploadReport: async (content, query) => {
      uploads.push({ content, query });
      return 'https://example.test/reports/big.md?sig=abc';
    },
  });
  try {
    const result = await callRun(client, { query: 'Big Query!' });
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0]!.query, 'Big Query!');
    assert.equal(uploads[0]!.content.length, big.length);
    const text = textOf(result);
    assert.match(text, /ACTION REQUIRED/);
    assert.ok(text.includes("curl -L 'https://example.test/reports/big.md?sig=abc' -o big_query__report.md"));
    assert.equal(result.metadata.reportUrl, 'https://example.test/reports/big.md?sig=abc');
    assert.ok((result.metadata.reportSizeKB ?? 0) > 50);
    assert.ok(!text.includes('x'.repeat(1024)), 'full report body is not inlined in URL mode');
  } finally {
    await close();
  }
});

test('keeps small reports inline in HTTP mode', async () => {
  let uploads = 0;
  const { client, close } = await connect({
    env: { ...GEMINI_ENV, MCP_HTTP_MODE: 'true' },
    research: stubResearch(async () => okResult('# Small')).fn,
    uploadReport: async () => { uploads += 1; return 'unused'; },
  });
  try {
    const result = await callRun(client, { query: 'small' });
    assert.equal(uploads, 0);
    assert.match(textOf(result), /# Small/);
    assert.equal(result.metadata.reportUrl, undefined);
  } finally {
    await close();
  }
});

test('reports an upload failure without failing the call', async () => {
  const big = '# Big\n\n' + 'y'.repeat(60 * 1024);
  const { client, close } = await connect({
    env: { ...GEMINI_ENV, MCP_HTTP_MODE: 'true' },
    research: stubResearch(async () => okResult(big)).fn,
    uploadReport: async () => { throw new Error('azure down; key=' + DUMMY_GEMINI_KEY); },
  });
  try {
    const result = await callRun(client, { query: 'upload-fail' });
    assert.equal(result.metadata.reportUrl, 'ERROR: Failed to upload report to cloud storage');
    assert.match(textOf(result), /ERROR: Failed to upload report to cloud storage/);
    assert.ok(!textOf(result).includes(DUMMY_GEMINI_KEY));
  } finally {
    await close();
  }
});

test('caches successful results per query and never caches failures', async () => {
  let fail = false;
  const stub = stubResearch(async () => {
    if (fail) throw new GeminiDeepResearchError('upstream_failed', 'boom');
    return okResult();
  });
  const { client, close } = await connect({ env: GEMINI_ENV, research: stub.fn, cache: new LRUCache({ max: 10, ttl: 60_000 }) });
  try {
    await callRun(client, { query: 'same' });
    await callRun(client, { query: 'same' });
    assert.equal(stub.calls.length, 1, 'second identical call served from cache');
    await callRun(client, { query: 'same', depth: 3 });
    assert.equal(stub.calls.length, 2, 'different depth is a different key');

    fail = true;
    const first = await callRun(client, { query: 'failing' });
    const second = await callRun(client, { query: 'failing' });
    assert.equal(stub.calls.length, 4, 'failures are not cached');
    assert.equal(first.metadata.errorCategory, 'upstream_failed');
    assert.equal(second.metadata.errorCategory, 'upstream_failed');
  } finally {
    await close();
  }
});

test('cache keys separate providers and agents', async () => {
  const cache = new LRUCache<string, MCPResearchResult>({ max: 10, ttl: 60_000 });
  const stubA = stubResearch(async () => okResult('# A'));
  const stubB = stubResearch(async () => okResult('# B'));
  const stubC = stubResearch(async () => okResult('# C'));
  const a = await connect({ env: GEMINI_ENV, research: stubA.fn, cache });
  const b = await connect({ env: OPENAI_ENV, research: stubB.fn, cache });
  const c = await connect({ env: { ...GEMINI_ENV, GEMINI_DEEP_RESEARCH_AGENT: MAX_AGENT }, research: stubC.fn, cache });
  try {
    assert.match(textOf(await callRun(a.client, { query: 'q' })), /# A/);
    assert.match(textOf(await callRun(b.client, { query: 'q' })), /# B/);
    assert.match(textOf(await callRun(c.client, { query: 'q' })), /# C/);
    assert.equal(stubA.calls.length, 1);
    assert.equal(stubB.calls.length, 1);
    assert.equal(stubC.calls.length, 1);
  } finally {
    await a.close();
    await b.close();
    await c.close();
  }
});

test('two default createServer() instances share one cache', async () => {
  const stub1 = stubResearch(async () => okResult('# shared'));
  const stub2 = stubResearch(async () => okResult('# should-not-run'));
  const query = `shared-cache-${Date.now()}-${Math.random()}`;
  const s1 = await connect({ env: GEMINI_ENV, research: stub1.fn });
  const s2 = await connect({ env: GEMINI_ENV, research: stub2.fn });
  try {
    await callRun(s1.client, { query });
    const second = await callRun(s2.client, { query });
    assert.match(textOf(second), /# shared/);
    assert.equal(stub2.calls.length, 0);
  } finally {
    await s1.close();
    await s2.close();
  }
});

test('exposes the capabilities resource with agent and config details', async () => {
  const { client, close } = await connect({
    env: { ...GEMINI_ENV, GEMINI_DR_POLL_INTERVAL_MS: '7000', GEMINI_DR_TIMEOUT_MS: '600000' },
    research: stubResearch(async () => okResult()).fn,
    cache: new LRUCache({ max: 10, ttl: 12_345 }),
  });
  try {
    const { resources } = await client.listResources();
    assert.ok(resources.some(r => r.uri === 'mcp://capabilities'));
    const read = await client.readResource({ uri: 'mcp://capabilities' });
    const text = read.contents[0]!.text as string;
    const caps = JSON.parse(text);
    assert.equal(caps.name, 'deep-research');
    assert.equal(caps.provider, 'gemini');
    assert.equal(caps.agent, STANDARD_AGENT);
    assert.equal(caps.pollIntervalMs, 7000);
    assert.equal(caps.timeoutMs, 600000);
    assert.equal(caps.legacyFlagsActive, false);
    assert.deepEqual(caps.configProblems, []);
    assert.equal(caps.providerCacheTtlMs, 12_345);
    for (const key of ['openaiDeepResearchModel', 'geminiModel', 'googleSearchEnabled', 'urlContextEnabled', 'functionsEnabled', 'codeExecEnabled', 'version']) {
      assert.ok(key in caps, `capabilities keeps ${key}`);
    }
    assert.ok(!text.includes(DUMMY_GEMINI_KEY));
  } finally {
    await close();
  }
});

test('capabilities marks legacy flags active for gemini-legacy', async () => {
  const { client, close } = await connect({ env: { ...GEMINI_ENV, RESEARCH_PROVIDER: 'gemini-legacy', GEMINI_MODEL: 'gemini-2.5-pro' }, research: stubResearch(async () => okResult()).fn });
  try {
    const read = await client.readResource({ uri: 'mcp://capabilities' });
    const caps = JSON.parse(read.contents[0]!.text as string);
    assert.equal(caps.provider, 'gemini-legacy');
    assert.equal(caps.agent, 'gemini-2.5-pro');
    assert.equal(caps.legacyFlagsActive, true);
  } finally {
    await close();
  }
});

test('maps GeminiDeepResearchError to a category envelope without upstream text', async () => {
  const { client, close } = await connect({
    env: GEMINI_ENV,
    research: stubResearch(async () => {
      throw new GeminiDeepResearchError('upstream_failed', `upstream said ${DUMMY_GEMINI_KEY}`, { interactionId: 'int_abc123' });
    }).fn,
  });
  try {
    const result = await callRun(client, { query: 'fails' });
    assert.equal(textOf(result), 'Deep research failed. Category: upstream_failed. Interaction id: int_abc123. Details are in the server log.');
    assert.equal(result.metadata.errorCategory, 'upstream_failed');
    assert.equal(result.metadata.interactionId, 'int_abc123');
    assert.deepEqual(result.metadata.learnings, []);
    assert.deepEqual(result.metadata.stats, { totalLearnings: 0, totalSources: 0 });
    assert.ok(!JSON.stringify(result).includes(DUMMY_GEMINI_KEY));
  } finally {
    await close();
  }
});

test('maps OpenAI and generic errors to categories', async () => {
  const cases: Array<[Error, string]> = [
    [new Error('Missing OPENAI_API_KEY in environment variables'), 'missing_key'],
    [new Error(`OpenAI API 401: invalid key ${DUMMY_OPENAI_KEY}`), 'auth'],
    [new Error('OpenAI API 403: forbidden'), 'auth'],
    [new Error('OpenAI API 429: rate limited'), 'quota'],
    [new Error('OpenAI API 500: upstream'), 'upstream_failed'],
    [new Error('Deep research run timed out after 60 minutes'), 'timeout'],
    [Object.assign(new Error('aborted'), { name: 'AbortError' }), 'cancelled'],
    [new Error('something else entirely'), 'unknown'],
  ];
  for (const [err, category] of cases) {
    const { client, close } = await connect({ env: OPENAI_ENV, research: stubResearch(async () => { throw err; }).fn });
    try {
      const result = await callRun(client, { query: `err-${category}` });
      assert.equal(result.metadata.errorCategory, category, err.message);
      assert.equal(textOf(result), `Deep research failed. Category: ${category}. Details are in the server log.`);
      assert.ok(!textOf(result).includes(DUMMY_OPENAI_KEY));
    } finally {
      await close();
    }
  }
});

test('invalid RESEARCH_PROVIDER still serves initialize and tools/list, and envelopes the call', async () => {
  const stub = stubResearch(async () => okResult());
  const { client, close } = await connect({ env: { RESEARCH_PROVIDER: 'bing', GEMINI_API_KEY: DUMMY_GEMINI_KEY }, research: stub.fn });
  try {
    const { tools } = await client.listTools();
    assert.ok(tools.some(t => t.name === 'deepResearch.run'));
    const result = await callRun(client, { query: 'x' });
    assert.equal(result.metadata.errorCategory, 'invalid_config');
    assert.equal(stub.calls.length, 0);
    assert.ok(!textOf(result).includes('bing'));
  } finally {
    await close();
  }
});

test('invalid GEMINI_DR_POLL_INTERVAL_MS is rejected before the agent is called', async () => {
  const stub = stubResearch(async () => okResult());
  const { client, close } = await connect({ env: { ...GEMINI_ENV, GEMINI_DR_POLL_INTERVAL_MS: 'soon' }, research: stub.fn });
  try {
    const result = await callRun(client, { query: 'x' });
    assert.equal(result.metadata.errorCategory, 'invalid_config');
    assert.equal(stub.calls.length, 0);
  } finally {
    await close();
  }
});

test('forwards progress as strictly increasing notifications when the client sends a progressToken', async () => {
  const stub = stubResearch(async (options) => {
    for (let i = 1; i <= 3; i += 1) {
      options.onProgress?.({ currentDepth: 1, totalDepth: 1, currentBreadth: 1, totalBreadth: 1, totalQueries: 1, completedQueries: 0, currentQuery: `step ${i}` });
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    return okResult();
  });
  const { client, close } = await connect({ env: GEMINI_ENV, research: stub.fn });
  try {
    const seen: Array<{ progress: number; message?: string }> = [];
    await callRun(client, { query: 'progress' }, { onprogress: p => { seen.push({ progress: p.progress, message: p.message }); } });
    assert.ok(seen.length >= 3, `expected >= 3 progress notifications, got ${seen.length}`);
    for (let i = 1; i < seen.length; i += 1) {
      assert.ok(seen[i]!.progress > seen[i - 1]!.progress, 'progress strictly increasing');
    }
    assert.ok(seen.some(p => (p.message ?? '').includes('step 1')));
  } finally {
    await close();
  }
});

test('does not send progress notifications without a progressToken', async () => {
  const sent: unknown[] = [];
  const stub = stubResearch(async (options) => {
    options.onProgress?.({ currentDepth: 1, totalDepth: 1, currentBreadth: 1, totalBreadth: 1, totalQueries: 1, completedQueries: 0, currentQuery: 'quiet' });
    return okResult();
  });
  const { client, close } = await connect({ env: GEMINI_ENV, research: stub.fn, sendNotification: async (_extra, n) => { sent.push(n); } });
  try {
    await callRun(client, { query: 'no-token' });
    assert.equal(sent.length, 0);
  } finally {
    await close();
  }
});

test('a rejecting notification send does not fail or un-cache the research', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  let sends = 0;
  const stub = stubResearch(async (options) => {
    for (let i = 1; i <= 3; i += 1) {
      options.onProgress?.({ currentDepth: 1, totalDepth: 1, currentBreadth: 1, totalBreadth: 1, totalQueries: 1, completedQueries: 0, currentQuery: `step ${i}` });
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    return okResult('# survived');
  });
  const { client, close } = await connect({
    env: GEMINI_ENV,
    research: stub.fn,
    cache: new LRUCache({ max: 10, ttl: 60_000 }),
    sendNotification: async () => { sends += 1; throw new Error('transport gone'); },
  });
  try {
    const result = await callRun(client, { query: 'notify-fail' }, { onprogress: () => {} });
    assert.match(textOf(result), /# survived/);
    assert.equal(result.metadata.errorCategory, undefined);
    assert.equal(sends, 1, 'stops forwarding after the first failure');
    await callRun(client, { query: 'notify-fail' }, { onprogress: () => {} });
    assert.equal(stub.calls.length, 1, 'result was cached despite the notification failure');
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    await close();
  }
});

test('describeResearchConfig never throws and lists problems without values', () => {
  assert.deepEqual(describeResearchConfig({ GEMINI_API_KEY: DUMMY_GEMINI_KEY }), { provider: 'gemini', agent: STANDARD_AGENT, problems: [] });

  const missing = describeResearchConfig({});
  assert.equal(missing.provider, 'gemini');
  assert.deepEqual(missing.problems, ['GEMINI_API_KEY is not set']);

  const invalid = describeResearchConfig({ RESEARCH_PROVIDER: 'bing' });
  assert.equal(invalid.provider, 'invalid');
  assert.equal(invalid.agent, 'invalid');
  assert.equal(invalid.problems.length, 1);
  assert.ok(!invalid.problems.join(' ').includes('bing'));

  const openai = describeResearchConfig({ RESEARCH_PROVIDER: 'openai', OPENAI_API_KEY: DUMMY_OPENAI_KEY });
  assert.equal(openai.provider, 'openai');
  assert.equal(openai.agent, 'o4-mini-deep-research');
  assert.deepEqual(openai.problems, []);
  assert.deepEqual(describeResearchConfig({ RESEARCH_PROVIDER: 'openai' }).problems, ['OPENAI_API_KEY is not set']);

  const legacy = describeResearchConfig({ RESEARCH_PROVIDER: 'gemini-legacy', GEMINI_API_KEY: DUMMY_GEMINI_KEY });
  assert.equal(legacy.provider, 'gemini-legacy');
  assert.equal(legacy.agent, 'gemini-2.5-flash');
  assert.deepEqual(legacy.problems, []);

  const badPoll = describeResearchConfig({ GEMINI_API_KEY: DUMMY_GEMINI_KEY, GEMINI_DR_POLL_INTERVAL_MS: 'soon', GEMINI_DR_TIMEOUT_MS: '-5' });
  assert.equal(badPoll.problems.length, 2);
  assert.ok(!badPoll.problems.join(' ').includes('soon'));
  assert.ok(!JSON.stringify(badPoll).includes(DUMMY_GEMINI_KEY));
});

interface FakeRes { statusCode?: number; body?: unknown; status(code: number): FakeRes; json(body: unknown): FakeRes }

function fakeRes(): FakeRes {
  const res: FakeRes = {
    status(code) { res.statusCode = code; return res; },
    json(body) { res.body = body; return res; },
  };
  return res;
}

function runAuth(headers: Record<string, string>): { nextCalled: boolean; res: FakeRes } {
  const res = fakeRes();
  let nextCalled = false;
  apiKeyAuth({ headers } as never, res as never, () => { nextCalled = true; });
  return { nextCalled, res };
}

test('apiKeyAuth passes everything through when MCP_API_KEY is unset', () => {
  const prev = process.env.MCP_API_KEY;
  delete process.env.MCP_API_KEY;
  try {
    const { nextCalled, res } = runAuth({});
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, undefined);
  } finally {
    if (prev !== undefined) process.env.MCP_API_KEY = prev;
  }
});

test('apiKeyAuth enforces x-api-key and Bearer when MCP_API_KEY is set', () => {
  const prev = process.env.MCP_API_KEY;
  process.env.MCP_API_KEY = 'dummy-mcp-key-0123456789';
  try {
    const wrong = runAuth({ 'x-api-key': 'nope' });
    assert.equal(wrong.nextCalled, false);
    assert.equal(wrong.res.statusCode, 401);
    assert.deepEqual(wrong.res.body, { error: 'Unauthorized' });

    const none = runAuth({});
    assert.equal(none.nextCalled, false);
    assert.equal(none.res.statusCode, 401);

    assert.equal(runAuth({ 'x-api-key': 'dummy-mcp-key-0123456789' }).nextCalled, true);
    assert.equal(runAuth({ authorization: 'Bearer dummy-mcp-key-0123456789' }).nextCalled, true);
  } finally {
    if (prev === undefined) delete process.env.MCP_API_KEY; else process.env.MCP_API_KEY = prev;
  }
});

test('logger writes to stderr and keeps stdout clean', async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const loggerPath = path.join(here, 'logger.ts');
  const code = `import { logger } from ${JSON.stringify(loggerPath)}; logger.info('logger-stderr-probe');`;
  const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { env: { ...process.env, LOG_LEVEL: 'info', LOG_PRETTY: 'false' } }, (error, out, err) => {
      if (error) reject(new Error(`child failed: ${error.message}\n${err}`)); else resolve({ stdout: out, stderr: err });
    });
  });
  assert.equal(stdout, '');
  assert.match(stderr, /logger-stderr-probe/);
});
