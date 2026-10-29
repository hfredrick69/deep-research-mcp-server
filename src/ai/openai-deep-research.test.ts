import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractReport, pickModel, type ResponsesApiResponse } from './openai-deep-research.js';

test('extractReport pulls text and citations from the final message', () => {
  const response: ResponsesApiResponse = {
    status: 'completed',
    output: [
      { type: 'reasoning' },
      { type: 'web_search_call' },
      {
        type: 'message',
        content: [
          {
            type: 'output_text',
            text: '# Report\n\nFindings here.',
            annotations: [
              { type: 'url_citation', url: 'https://example.com/a', title: 'A' },
              { type: 'url_citation', url: 'https://example.com/a', title: 'A dup' },
              { type: 'url_citation', url: 'https://example.com/b', title: 'B' },
            ],
          },
        ],
      },
    ],
  };
  const { content, visitedUrls } = extractReport(response);
  assert.equal(content, '# Report\n\nFindings here.');
  assert.deepEqual(visitedUrls, ['https://example.com/a', 'https://example.com/b']);
});

test('extractReport returns empty result for missing output', () => {
  const { content, visitedUrls } = extractReport({ status: 'completed' });
  assert.equal(content, '');
  assert.deepEqual(visitedUrls, []);
});

test('pickModel maps depth to model tier', () => {
  delete process.env.OPENAI_DEEP_RESEARCH_MODEL;
  assert.equal(pickModel(2), 'o4-mini-deep-research');
  assert.equal(pickModel(3), 'o3-deep-research');
  assert.equal(pickModel(undefined), 'o4-mini-deep-research');
  process.env.OPENAI_DEEP_RESEARCH_MODEL = 'custom-model';
  assert.equal(pickModel(5), 'custom-model');
  delete process.env.OPENAI_DEEP_RESEARCH_MODEL;
});
