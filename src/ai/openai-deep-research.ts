// OpenAI Deep Research engine (ChatGPT Deep Research via the Responses API).
// Uses background mode + polling because runs can take 5-30 minutes.

export interface OpenAIDeepResearchOptions {
  query: string;
  goal?: string;
  depth?: number;
  breadth?: number;
  onProgress?: (status: string) => void;
}

export interface OpenAIDeepResearchResult {
  content: string;
  visitedUrls: string[];
  learnings: string[];
}

const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const POLL_INTERVAL_MS = parseInt(process.env.OPENAI_DR_POLL_INTERVAL_MS || '15000', 10);
const TIMEOUT_MS = parseInt(process.env.OPENAI_DR_TIMEOUT_MS || String(45 * 60 * 1000), 10);

function apiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error('Missing OPENAI_API_KEY in environment variables');
  }
  return key;
}

export function pickModel(depth?: number): string {
  if (process.env.OPENAI_DEEP_RESEARCH_MODEL) {
    return process.env.OPENAI_DEEP_RESEARCH_MODEL;
  }
  return (depth ?? 2) >= 3 ? 'o3-deep-research' : 'o4-mini-deep-research';
}

// Minimal shape of a Responses API response that we consume
export interface ResponsesApiResponse {
  id?: string;
  status?: string;
  error?: { message?: string } | null;
  output?: Array<{
    type?: string;
    content?: Array<{
      type?: string;
      text?: string;
      annotations?: Array<{ type?: string; url?: string; title?: string }>;
    }>;
  }>;
}

// Pure extraction so it can be unit-tested without the API
export function extractReport(response: ResponsesApiResponse): { content: string; visitedUrls: string[] } {
  const messages = (response.output || []).filter(o => o.type === 'message');
  const last = messages[messages.length - 1];
  const textBlocks = (last?.content || []).filter(c => c.type === 'output_text');
  const content = textBlocks.map(c => c.text || '').join('\n');

  const urls = new Set<string>();
  for (const block of textBlocks) {
    for (const a of block.annotations || []) {
      if (a.type === 'url_citation' && a.url) {
        urls.add(a.url);
      }
    }
  }
  return { content, visitedUrls: Array.from(urls) };
}

async function openaiFetch(path: string, init?: RequestInit): Promise<ResponsesApiResponse> {
  const res = await fetch(`${OPENAI_BASE_URL}${path}`, {
    ...init,
    headers: {
      'Authorization': `Bearer ${apiKey()}`,
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI API ${res.status}: ${errText.slice(0, 500)}`);
  }
  return res.json() as Promise<ResponsesApiResponse>;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function runOpenAIDeepResearch(options: OpenAIDeepResearchOptions): Promise<OpenAIDeepResearchResult> {
  const { query, goal, depth, breadth, onProgress } = options;
  const model = pickModel(depth);

  const systemMessage =
    'You are a professional researcher producing a structured, comprehensive, data-rich report. ' +
    'Include specific figures, dates, vendor/product names, and inline citations for every claim. ' +
    'Prefer primary and reputable sources. Format the report in Markdown with clear section headers.' +
    (breadth ? ` Cover roughly ${Math.min(12, Math.max(4, breadth * 2 + 2))} major sections.` : '') +
    (goal ? `\n\nResearch goal/brief: ${goal}` : '');

  onProgress?.(`Starting ${model} deep research run`);

  const created = await openaiFetch('/responses', {
    method: 'POST',
    body: JSON.stringify({
      model,
      background: true,
      reasoning: { summary: 'auto' },
      tools: [{ type: 'web_search_preview' }],
      input: [
        { role: 'developer', content: [{ type: 'input_text', text: systemMessage }] },
        { role: 'user', content: [{ type: 'input_text', text: query }] },
      ],
    }),
  });

  if (!created.id) {
    throw new Error('OpenAI API did not return a response id');
  }

  const startedAt = Date.now();
  let current = created;
  while (current.status === 'queued' || current.status === 'in_progress') {
    if (Date.now() - startedAt > TIMEOUT_MS) {
      await openaiFetch(`/responses/${created.id}/cancel`, { method: 'POST' }).catch(() => {});
      throw new Error(`Deep research run timed out after ${Math.round(TIMEOUT_MS / 60000)} minutes`);
    }
    await sleep(POLL_INTERVAL_MS);
    current = await openaiFetch(`/responses/${created.id}`);
    onProgress?.(`Deep research ${current.status} (${Math.round((Date.now() - startedAt) / 1000)}s elapsed)`);
  }

  if (current.status !== 'completed') {
    throw new Error(`Deep research run ended with status "${current.status}": ${current.error?.message || 'no error detail'}`);
  }

  const { content, visitedUrls } = extractReport(current);
  if (!content) {
    throw new Error('Deep research run completed but returned no report text');
  }

  return {
    content,
    visitedUrls,
    learnings: [`Deep research report generated by ${model} with ${visitedUrls.length} cited sources`],
  };
}
