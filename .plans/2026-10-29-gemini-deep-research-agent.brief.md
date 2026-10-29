# Handoff brief: switch deep-research MCP to Google's Deep Research agent

Written by Claude (Fable) 2026-10-29 for Codex, who authors the plan. Claude reviews.

## Task
Replace the MCP's default research engine with Google's Deep Research agent via the
Gemini Interactions API. Keep the MCP tool surface (`deepResearch_run` inputs/outputs,
`ResearchResult`) unchanged for callers. Keep the legacy Gemini loop and the OpenAI
Responses path selectable by name via `RESEARCH_PROVIDER`.

Plan file to write EARLY and refine in place:
`.plans/2026-10-29-gemini-deep-research-agent.md` (<= ~250 lines; the change itself is
probably 250–400 production lines + tests). Do NOT run your own sub-review. Do NOT read
`gemini_keys.json` or `.env.local` (secrets). Never print or echo any API key.

## Repo facts (verified by Claude)
- Repo: /Users/herbert/tools/deep-research-mcp-server (own git repo, last commit ae990ee
  2026-01-17). Large PRE-EXISTING uncommitted churn from 2026-06-12 (modified
  .env.example, CHANGELOG.md, package(-lock).json, src/deep-research.ts, src/mcp-server.ts;
  untracked src/ai/openai-deep-research.ts + .test.ts, report .md/.pdf files, images,
  GEMINI_RESEARCH_GUIDE.md). The plan must say how to treat that backlog (it is the
  current working state the new code builds on; deleting untracked files needs Herbert's OK).
- Node v24.21.0 locally; package.json engines "20.x"; TS NodeNext, strict,
  noUncheckedIndexedAccess; tests: `tsx --test 'src/**/*.test.ts'` (node:test + assert/strict);
  build `tsc`. tsconfig `types: ["@google/genai"]`.
- `@google/genai` installed ^1.13.0 (NO `client.interactions`); interactions needs >= 2.3.0;
  latest 2.32.0 (node >= 20). src/ai/providers.ts uses `ai.models.generateContent`,
  `embedContent`, `countTokens` plus a raw-fetch fallback. A major bump may break it.
- src/deep-research.ts: `research()` picks provider via `process.env.RESEARCH_PROVIDER ||
  'openai'`; `researchWithOpenAI` -> src/ai/openai-deep-research.ts (`pickModel` returns
  retired `o3-deep-research`/`o4-mini-deep-research`; create/poll/cancel on Responses API);
  `researchWithGemini` = legacy outline + per-section loop on gemini-2.5-flash with
  googleSearch grounding. Both write a report .md to process.cwd() and return
  `{learnings, visitedUrls, reportPath, content}`.
- src/mcp-server.ts: loads `.env.local`; provider default 'openai' at lines ~28 and ~322;
  tool description (~line 141) names the OpenAI models; schema depth 1–5, breadth 1–5,
  existingLearnings; defaults depth 2 / breadth 2; LRU result cache keyed by hash; HTTP
  mode + Azure blob for reports > 50 KB; status block (~322–328) reports model names.
- RESEARCH_PROVIDER is not set in any MCP client config today -> default path runs.

## Interactions API facts (from ai.google.dev, 2026-10-29)
- Agents: `deep-research-preview-04-2026` (~$1–3/task), `deep-research-max-preview-04-2026`
  (~$3–7/task). Max 60 min, most < 20 min. `background: true` and store required.
  No structured output, no custom function calling.
- REST: `POST https://generativelanguage.googleapis.com/v1beta/interactions`, header
  `x-goog-api-key`. `GET /v1beta/interactions/{id}` (query `stream`, `last_event_id`).
  `POST /v1beta/interactions/{id}/cancel` (background runs only).
  `DELETE /v1beta/interactions/{id}`.
- Request: `{agent, input: string | parts[], background: true, stream?, agent_config:
  {type: "deep-research", thinking_summaries: "auto"|"none", visualization: "auto"|"off",
  collaborative_planning: bool}, tools: [{type: google_search|url_context|code_execution|
  mcp_server|file_search}], previous_interaction_id?, webhook_config?, labels?}`.
- Response: `id`, `status` in {in_progress, requires_action, completed, failed, cancelled,
  incomplete, requires_continuation}, `created`, `updated`, `steps[]` (output only;
  `model_output` steps carry `content[]` parts: `text {text, annotations[]}`, `image
  {data|uri, mime_type}`), `usage {total_input_tokens, total_output_tokens,
  total_thought_tokens, total_tool_use_tokens, total_tokens, grounding_tool_count[]}`,
  `errors[] {code, message}`, `continuation_token` when requires_continuation.
- Citations: `text.annotations[]` with `type: "url_citation"` -> `{url, title, start_index,
  end_index}` (byte offsets, end exclusive). Also `file_citation`, `place_citation`.
  Press reports say Deep Research URLs may be "wrapped" redirect links; treat as opaque.
- Final report text = last `model_output` step's text parts (SDK calls it `output_text`).
- Poll every 5–10 s. Retention 55 days paid / 1 day free.

## Claude's DECLARED conclusions (challenge these; they are a view, not a spec)
1. Implement with plain `fetch` in a new `src/ai/gemini-deep-research.ts` (pure extractor +
   thin client, like openai-deep-research.ts) rather than bumping `@google/genai` to 2.x.
2. Agent selection by depth: >= 3 -> Max, else standard; env override
   `GEMINI_DEEP_RESEARCH_AGENT`. Poll interval/timeout env vars; on timeout cancel the
   interaction then throw.
3. `RESEARCH_PROVIDER` default becomes the Google agent (name e.g. `gemini`), legacy loop
   renamed to `gemini-legacy`, `openai` unchanged (still retired upstream; out of scope).
4. agent_config: thinking_summaries "auto" (feed progress callbacks), visualization "off",
   collaborative_planning false; tools google_search + url_context.
5. Map annotations -> visitedUrls (dedupe, order of appearance); learnings = thought
   summaries or a single "report generated" line; write report file like today.
6. Update tool description, status block, .env.example (RESEARCH_PROVIDER + new vars),
   CHANGELOG. Tests: agent selection, request body shaping, extractReport fixtures
   (text + annotations + images ignored), status mapping (failed/cancelled/incomplete ->
   error with Google's message), timeout -> cancel called, missing key -> error pre-network.
7. Verification: npm test, npm run build, one live depth-1 run via the MCP tool.

## Plan requirements
- Functional spec section first (outcome, flows, states, failure modes, assumptions,
  out of scope), then file-by-file steps with test-first ordering (TDD), then verification
  commands, then a short "Review findings" section left empty for Claude's reconciliation.
- Call out anything in the DECLARED list you disagree with and why.
- Security: no key logging, no key in URLs (header only), generic errors to callers,
  detailed to logs; respect existing MCP_API_KEY/HTTP mode behaviour.
