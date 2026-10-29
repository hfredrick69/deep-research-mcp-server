import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import process from 'node:process';
import { runOpenAIDeepResearch, pickModel } from './ai/openai-deep-research.js';
import {
  GeminiDeepResearchError,
  runGeminiDeepResearch,
  type GeminiDeepResearchDeps,
} from './ai/gemini-deep-research.js';
import { logger } from './logger.js';

// STRICT COMPATIBILITY INTERFACE
export interface ResearchProgress {
  currentDepth: number;
  totalDepth: number;
  currentBreadth: number;
  totalBreadth: number;
  totalQueries: number;
  completedQueries: number;
  currentQuery: string;
}

export interface ResearchOptions {
  query: string;
  depth?: number;
  breadth?: number;
  existingLearnings?: string[];
  onProgress?: (progress: ResearchProgress) => void;
  /** Internal: aborts the run when the MCP client cancels the request. Not part of the tool schema. */
  signal?: AbortSignal;
}

export interface ResearchResult {
  learnings: string[];
  visitedUrls: string[];
  reportPath?: string;
  content?: string; // Added to return full report
}

export type ResearchProviderName = 'gemini' | 'gemini-legacy' | 'openai';

const PROVIDER_NAMES: readonly ResearchProviderName[] = ['gemini', 'gemini-legacy', 'openai'];

/**
 * Resolve RESEARCH_PROVIDER once per run. Unset/blank selects the Google Deep Research
 * agent; `gemini-legacy` selects the outline/chapter loop; `openai` the Responses API
 * implementation. Unknown names are rejected explicitly (never a silent fallback).
 */
export function resolveResearchProvider(env: NodeJS.ProcessEnv = process.env): ResearchProviderName {
  const raw = (env.RESEARCH_PROVIDER ?? '').trim().toLowerCase();
  if (raw === '') return 'gemini';
  const match = PROVIDER_NAMES.find(name => name === raw);
  if (!match) {
    throw new GeminiDeepResearchError(
      'invalid_config',
      `RESEARCH_PROVIDER is not one of ${PROVIDER_NAMES.join(', ')}`,
    );
  }
  return match;
}

type LegacyGeminiModule = Pick<typeof import('./ai/providers.js'), 'callGeminiProConfigurable'>;

/** Narrow injection points for tests. Production callers pass nothing. */
export interface ResearchDeps {
  env?: NodeJS.ProcessEnv;
  agentDeps?: GeminiDeepResearchDeps;
  runOpenAI?: typeof runOpenAIDeepResearch;
  loadLegacy?: () => Promise<LegacyGeminiModule>;
  writeFile?: (filePath: string, content: string) => Promise<void>;
  cwd?: () => string;
  now?: () => Date;
}

interface ResolvedDeps {
  env: NodeJS.ProcessEnv;
  agentDeps: GeminiDeepResearchDeps;
  runOpenAI: typeof runOpenAIDeepResearch;
  loadLegacy: () => Promise<LegacyGeminiModule>;
  writeFile: (filePath: string, content: string) => Promise<void>;
  cwd: () => string;
  now: () => Date;
}

function resolveDeps(deps: ResearchDeps): ResolvedDeps {
  const env = deps.env ?? process.env;
  return {
    env,
    agentDeps: { env, ...(deps.agentDeps ?? {}) },
    runOpenAI: deps.runOpenAI ?? runOpenAIDeepResearch,
    loadLegacy: deps.loadLegacy ?? (() => import('./ai/providers.js')),
    writeFile: deps.writeFile ?? ((filePath, content) => fs.writeFile(filePath, content, 'utf-8')),
    cwd: deps.cwd ?? (() => process.cwd()),
    now: deps.now ?? (() => new Date()),
  };
}

export async function research(options: ResearchOptions, deps: ResearchDeps = {}): Promise<ResearchResult> {
  const resolved = resolveDeps(deps);
  const provider = resolveResearchProvider(resolved.env);
  switch (provider) {
    case 'gemini':
      return researchWithGeminiAgent(options, resolved);
    case 'gemini-legacy':
      return researchWithGeminiLegacy(options, resolved);
    case 'openai':
      return researchWithOpenAI(options, resolved);
  }
}

function reportFileName(prefix: string, now: Date): string {
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  return `${prefix}_${timestamp}.md`;
}

function safeProgress(onProgress: ResearchOptions['onProgress'], progress: ResearchProgress): void {
  if (!onProgress) return;
  try {
    onProgress(progress);
  } catch (err) {
    logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'Progress callback threw; continuing');
  }
}

/** Single-task progress shape: one unit of work, never fabricated sub-queries or percentages. */
function singleTaskProgress(status: string, done: boolean): ResearchProgress {
  return {
    currentDepth: done ? 0 : 1,
    totalDepth: 1,
    currentBreadth: done ? 0 : 1,
    totalBreadth: 1,
    totalQueries: 1,
    completedQueries: done ? 1 : 0,
    currentQuery: status,
  };
}

// Google Deep Research agent (Gemini Interactions API) — the default engine.
async function researchWithGeminiAgent(options: ResearchOptions, deps: ResolvedDeps): Promise<ResearchResult> {
  const { query, depth, breadth, existingLearnings, onProgress, signal } = options;

  logger.info({ depth: depth ?? 2, breadth: breadth ?? 2 }, 'Starting Gemini Deep Research agent run');

  const run = await runGeminiDeepResearch(
    {
      query,
      ...(depth !== undefined ? { depth } : {}),
      ...(breadth !== undefined ? { breadth } : {}),
      ...(existingLearnings ? { existingLearnings } : {}),
      ...(signal ? { signal } : {}),
      onProgress: status => safeProgress(onProgress, singleTaskProgress(status, false)),
    },
    deps.agentDeps,
  );

  const report = `# ${query}\n\n*Generated by Gemini Deep Research (${run.agent})*\n\n${run.content}`;
  const fullPath = path.resolve(deps.cwd(), reportFileName('deep_research_report', deps.now()));

  try {
    await deps.writeFile(fullPath, report);
  } catch (err) {
    logger.error(
      { interactionId: run.interactionId, error: err instanceof Error ? err.message : String(err) },
      'Failed to persist the Deep Research report',
    );
    throw new GeminiDeepResearchError(
      'persist_failed',
      `Failed to write the research report to disk (interaction ${run.interactionId})`,
      { interactionId: run.interactionId, afterCompleted: true },
    );
  }

  logger.info({ interactionId: run.interactionId, reportPath: fullPath }, 'Deep Research report saved');
  safeProgress(onProgress, singleTaskProgress('completed', true));

  return {
    learnings: run.learnings,
    visitedUrls: run.visitedUrls,
    reportPath: fullPath,
    content: report,
  };
}

// OpenAI Deep Research engine (Responses API) — explicit opt-in via RESEARCH_PROVIDER=openai.
async function researchWithOpenAI(options: ResearchOptions, deps: ResolvedDeps): Promise<ResearchResult> {
  const { query, depth, breadth, onProgress } = options;
  const model = pickModel(depth);

  console.error('[Agent] Starting OpenAI deep research (' + model + ') for: ' + query);

  const result = await deps.runOpenAI({
    query,
    depth: depth ?? 2,
    breadth: breadth ?? 2,
    onProgress: status => safeProgress(onProgress, singleTaskProgress(status, false)),
  });

  const report = `# ${query}\n\n*Generated by OpenAI Deep Research (${model})*\n\n${result.content}`;
  const fullPath = path.resolve(deps.cwd(), reportFileName('deep_research_report', deps.now()));
  await deps.writeFile(fullPath, report);
  console.error('[Agent] Report saved to ' + fullPath);

  return {
    learnings: result.learnings,
    visitedUrls: result.visitedUrls,
    reportPath: fullPath,
    content: report,
  };
}

// Legacy Gemini outline/chapter loop (RESEARCH_PROVIDER=gemini-legacy). Kept intact for rollback.
async function researchWithGeminiLegacy(options: ResearchOptions, deps: ResolvedDeps): Promise<ResearchResult> {
  const { query, onProgress } = options;
  const { callGeminiProConfigurable } = await deps.loadLegacy();
  const learnings: string[] = [];

  console.error('[Agent] Starting Deep Research (legacy Gemini loop) for: ' + query);

  const outlinePrompt = `
    ACT AS: Expert Research Strategist.
    Topic: "${query}".
    Goal: Create a detailed Table of Contents for a comprehensive industry whitepaper.
    
    Return ONLY a JSON list of section titles. Example:
    ["1. Executive Summary", "2. Market Analysis", ...]
    
    Limit to 8-12 high-impact sections.
  `;

  const outlineRaw = await callGeminiProConfigurable(outlinePrompt, { json: true });
  let sections: string[] = [];

  try {
    const cleanJson = outlineRaw.replace(/```json/g, '').replace(/```/g, '').trim();
    sections = JSON.parse(cleanJson);
  } catch (e) {
    console.error("[Agent] Failed to parse outline JSON. Using fallback.");
    sections = [
      "1. Executive Summary",
      "2. Key Technologies & Innovations",
      "3. Market Analysis & Adoption Trends",
      "4. Vendor Landscape & Comparisons",
      "5. ROI & Business Impact",
      "6. Future Outlook"
    ];
  }

  let fullReport = '# ' + query + '\n\n*Generated by Gemini Agentic Researcher*\n\n';
  const totalSections = sections.length;

  for (let i = 0; i < totalSections; i++) {
    const section = sections[i];
    if (!section) continue;

    safeProgress(onProgress, {
      currentDepth: totalSections - i,
      totalDepth: totalSections,
      currentBreadth: 1,
      totalBreadth: 1,
      totalQueries: totalSections,
      completedQueries: i,
      currentQuery: 'Researching: ' + section
    });

    const sectionPrompt = `
      ACT AS: Senior Industry Analyst.
      TASK: Write a comprehensive, detailed chapter for the section: "${section}".
      CONTEXT: This is part of a larger report on "${query}".
      
      REQUIREMENTS:
      - Use Google Search to find real-world data, vendor names, and statistics from 2025-2026.
      - Write at least 1500 words for this section. Be extremely verbose and detailed.
      - Include specific adoption rates, costs, and ROI metrics if applicable.
      - Name specific companies and products.
      - FORMAT: Markdown. Use tables where appropriate.
      - CRITICAL: DO NOT include the chapter title "${section}" as a header at the start. Start directly with the text of the chapter.
    `;

    const content = await callGeminiProConfigurable(sectionPrompt, { tools: [{ googleSearch: {} }] });

    // Strip duplicate headers if the LLM ignored instructions
    let cleanContent = content.trim();
    // Handle cases where LLM includes/excludes numbering or uses different header styles
    const titleWithoutNumber = section.replace(/^\d+[\.\)]\s*/, '');
    const sectionTitleRegex = new RegExp(`^#*\\s*(\\d+[\\.\\)]\\s*)?${escapeRegExp(titleWithoutNumber)}[:.]?\\s*`, 'i');
    cleanContent = cleanContent.replace(sectionTitleRegex, '').trim();

    fullReport += '\n\n## ' + section + '\n\n' + cleanContent + '\n\n---\n';
    learnings.push('Completed section: ' + section);
  }

  const fullPath = path.resolve(deps.cwd(), reportFileName('agentic_report', deps.now()));

  await deps.writeFile(fullPath, fullReport);
  console.error('[Agent] Report saved to ' + fullPath);

  return {
    learnings,
    visitedUrls: [],
    reportPath: fullPath,
    content: fullReport // Return the full report here
  };
}

// Update writeFinalReport to actually return the content if we have it
export async function writeFinalReport(params: any): Promise<string> {
  // If we were called with learnings that look like our full report content, return it
  if (params.learnings && params.learnings.length > 0 && params.learnings[0].startsWith('#')) {
      return params.learnings[0];
  }
  return "Report generation is handled inside the research loop in this engine.";
}

export function validateAcademicInput(input: string): boolean { return true; }
export function validateAcademicOutput(text: string): boolean { return true; }
export async function conductResearch(query: string, depth: number = 3): Promise<any> { return {}; }

function escapeRegExp(string: string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
