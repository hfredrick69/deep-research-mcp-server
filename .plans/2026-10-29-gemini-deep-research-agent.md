# Gemini Deep Research agent implementation plan

## Functional specification

### Outcome and caller contract

- Default to Google's Deep Research agent through the Gemini Interactions REST API.
  Preserve `ResearchOptions`, `ResearchProgress`, `ResearchResult`, and MCP result envelopes.
- The actual registered tool is `deepResearch.run` (`src/mcp-server.ts:138`); clients may
  expose it as `deepResearch_run`. Do not rename it or change its input schema, defaults,
  metadata, statistics, or inline/report-URL delivery contract.
- Retain query, depth/breadth 1–5 (default 2), existingLearnings, goal, and flags in the
  schema. Currently goal/flags are accepted but discarded; retain that behavior explicitly.
  The new agent consumes existingLearnings as unverified prior context, not established facts.
- Preserve HTTP/SSE/stdio transports, `MCP_API_KEY` authentication, and the existing HTTP
  report-size threshold/Azure upload behavior. No deployment or client-config changes.

### Selection, configuration, and request flow

1. Resolve `RESEARCH_PROVIDER` once per run, trimming/lowercasing: unset/blank or `gemini`
   selects the new agent; `gemini-legacy` selects the existing outline/chapter loop;
   `openai` selects the existing Responses implementation. Reject unknown names explicitly;
   never silently fall back after a configuration or provider failure.
2. Select `deep-research-preview-04-2026` for depth < 3 (including default 2), and
   `deep-research-max-preview-04-2026` for depth >= 3. A nonblank trimmed
   `GEMINI_DEEP_RESEARCH_AGENT` overrides either tier. Read settings at call time, after
   dotenv startup, not at module import. Do not require a key merely to import/start.
3. Require nonblank `GEMINI_API_KEY` before any network request. Use native Node `fetch`
   against fixed `https://generativelanguage.googleapis.com/v1beta/interactions`;
   send the key only in `x-goog-api-key`, with JSON content type and `redirect: 'error'`.
   Do not inherit `GEMINI_API_ENDPOINT` or add an arbitrary agent endpoint override.
4. POST once with `{agent, input, background: true, store: true, stream: false,
   agent_config: {type: 'deep-research', thinking_summaries: 'none', visualization: 'off',
   collaborative_planning: false}, tools: [{type: 'google_search'}, {type: 'url_context'}]}`.
   `input` is a Markdown-report instruction plus separately delimited query/prior notes;
   request primary sources, dates, citations, and roughly clamp(2*breadth+2, 4, 12) sections.
   Breadth is a coverage hint; depth selects the tier, neither promises a literal tree.
   Send no structured-output schema, function declarations, or invented generation knobs.
5. Validate a nonempty interaction id and known status, then poll GET `/{encodedId}`.
   `GEMINI_DR_POLL_INTERVAL_MS` defaults to 10000; accept integers 5000–10000.
   `GEMINI_DR_TIMEOUT_MS` defaults to 3600000; accept integers 1000–3600000.
   Reject malformed, fractional, nonfinite, or out-of-range values before POST.
6. An absolute deadline starts before POST and covers HTTP bodies, polling, and waits.
   Abort each request/body read after min(60000 ms, remaining deadline); cap waits by the
   remaining time and recheck before GET. A stuck create/GET must not defeat the timeout.
   Never retry POST creation automatically: an ambiguous response may already have billed.
   GET alone may retry twice consecutively for transport failures, 429, or 5xx; use at
   least the poll interval, honor Retry-After within the remaining deadline, reset after
   a successful GET, and fail when exhausted. Other HTTP/JSON/protocol failures stop.
7. On abandonment after a known active id, best-effort POST `/{encodedId}/cancel` once,
   with a separate 10-second abort bound, then retain the original failure even if cancel
   fails. No DELETE or automatic restart. If create fails before yielding an id, cancellation
   is impossible; log this uncertainty and never claim that the remote task was stopped.

### Flows, states, and failure modes

| Observed state | Required behavior |
| --- | --- |
| `in_progress` | Emit safe status/elapsed progress, wait, poll the same id. |
| `completed` (including initial POST) | Extract the final report; reject empty/whitespace-only text. |
| `failed`, `cancelled`, `incomplete` | Fail; no partial-success report or success cache entry. |
| `requires_action` | Fail as unsupported interactive planning; best-effort cancel. |
| `requires_continuation` | Fail as unsupported continuation; best-effort cancel; never present a partial report as complete. |
| Missing/unknown status, invalid/mismatched id, malformed JSON/shape | Protocol error; cancel if a possibly active id is known. |
| Missing key/config error, HTTP/auth/quota failure, deadline | Stable safe error; cancel only when a possibly active id is known. |

- No continuation/resume request is invented: the brief gives a token but no continuation
  request contract. Make this limitation explicit in docs; future support is separate work.
- Map polling into the existing one-task progress shape: totals = 1, currentDepth and
  currentBreadth = 1 while running, completedQueries = 0; after report persistence emit
  currentDepth/currentBreadth = 0 and completedQueries = 1. Never fabricate percentages,
  source counts, or subqueries. Callback exceptions must not strand an active interaction.
- Failures throw safe categorized errors internally; the MCP catch returns a generic
  research-error message and the existing empty metadata envelope. Preserve the envelope
  without adding `isError` or exposing Google's response text. Never cache failures.
- Logs carry allowlisted operation/status/code, elapsed time, and interaction id; diagnostic
  messages are bounded and redact configured keys before logging. Do not dump request/
  response objects, headers, prompts, or continuation tokens. All pino output goes to
  stderr (round-1 revision): `src/logger.ts` passes `pino.destination(2)` (and
  `destination: 2` for the pino-pretty transport) so the 10-second poll logs of a long run
  never mix into the stdio JSON-RPC channel (repo rule docs/rules/mcp-server-rules.md).
  Wider logger cleanup remains separate.

### Report extraction and persistence

- Any extraction or protocol failure AFTER a `completed` status (already billed) logs the
  interaction id at warn level and includes it in the caller-visible error text, so the
  stored report can be recovered within retention.

- Pure extraction uses only the last `steps[]` entry with `type: 'model_output'`, joining
  its text parts in order with newlines. Do not concatenate earlier drafts or fall back to
  an earlier text step if the final output has only images. Ignore images/tool/thought parts.
- Extract only nonempty `url_citation.url` annotations from those final text parts; preserve
  first appearance order and deduplicate exact strings. Ignore file/place citations.
  Keep wrapped URLs opaque: no normalization, redirect resolution, or source-fetch requests.
  Preserve report Markdown and ignore byte offsets; never splice them as JS string indices.
- Return one factual learning: report generated by the selected agent with N cited URLs.
  Thinking summaries are neither research findings nor required for progress.
- In `research()`, wrap the report with query title and selected-agent attribution; write
  UTF-8 Markdown to a timestamped `deep_research_report_*.md` under `process.cwd()` as today.
  Return absolute reportPath, identical full content, learnings, and visitedUrls. Treat a
  write failure as failure; do not cache success or claim final completion before persistence.

### Assumptions, boundaries, and existing working state

- API shapes, agent ids, availability, 60-minute limit, and storage retention come from
  the supplied brief; no network verification is permitted in this planning task. Fixtures
  must encode these assumptions; a later authorized smoke test must validate them.
- Background mode requires storage: queries/prior notes/report persist upstream (brief:
  55 days paid / 1 day free). No automatic deletion, retention promise, or new credential store.
  Max can cost more (brief estimates standard $1–3, Max $3–7/task); document tier selection.
- MCP caller/HTTP infrastructure deadlines must accommodate long runs. Server timeout
  does not extend a client's timeout. Durable jobs, resumability, webhooks, streaming, and
  concurrency admission controls are outside this bounded change. (Client cancellation via
  `extra.signal` and progress notifications ARE in scope since round 1; see section 3.)
- **Live launch path (verified 2026-10-29, key names only, no values):** Claude Code's
  `~/.claude.json` runs `node /Users/herbert/tools/deep-research-mcp-server/dist/mcp-server.js`
  directly with env keys GEMINI_API_KEY, GEMINI_MODEL, ENABLE_GEMINI_GOOGLE_SEARCH,
  ENABLE_URL_CONTEXT, LOG_LEVEL, APIFY_LOG_LEVEL and no RESEARCH_PROVIDER.
  `~/tools/gemini-mcp-wrapper.js` `spawn`s the same `dist/mcp-server.js` (it does not import
  it) and is not referenced by the live client config. `.env.local` (loaded by the entry
  from `../.env.local`, dotenv does not override client env) sets `RESEARCH_PROVIDER=openai`,
  so the live tool today routes to the retired OpenAI agents and is non-functional. Codex's
  `~/.codex/config.toml` points at a Cloud Run deployment of this server, which this change
  does not touch or redeploy.
- **Expected live effect and go-live:** after `npm run build` and changing the one
  non-secret line in `.env.local` from `RESEARCH_PROVIDER=openai` to
  `RESEARCH_PROVIDER=gemini` (edited with a targeted `sed`, never printing the file), the
  next Claude Code restart runs the paid Deep Research agent by default
  (standard tier ~$1–3/task at depth 1–2, Max ~$3–7 at depth ≥3). Herbert's instruction
  "switch deep-research MCP to Google's Deep Research agent … make it default" is the
  acknowledgment of this paid default. No existing live value needs an alias: `openai` stays
  a valid (retired-agent) name; `gemini` becomes the agent; `gemini-legacy` is the old loop.
- Local Node is v24.21.0, package engines are 20.x; use Node-20-compatible APIs. Installed
  `@google/genai` is 1.13.0 and its GoogleGenAI declaration has no Interactions client.
  Keep SDK, package manifests/lockfile, tsconfig, `src/ai/providers.ts`, and OpenAI code/tests
  unchanged. The OpenAI path remains selectable but its retired agents are not repaired.
- Existing legacy raw fetch puts its key in a query URL; this pre-existing defect is not
  copied into the agent client. Broader legacy security, CLI writeFinalReport, splitter,
  and logger cleanup are separate tasks; do not characterize them as fixed here.
- Base implementation on the CURRENT working tree, not HEAD ae990ee (2026-01-17).
  Observed modified files: .env.example, .gitignore, CHANGELOG.md, package(-lock).json,
  src/deep-research.ts, src/mcp-server.ts; untracked OpenAI client/tests, reports, images,
  guide, and .plans also predate this implementation. Preserve all existing work.
  Capture a scoped baseline before edits; never reset/clean/stash away backlog, sweep it
  into a commit, or delete untracked files without Herbert's permission.
- **Historical plan-authoring constraints (Codex authoring task only, superseded for the
  implementation session):** the authoring task itself performed no implementation, installs,
  network commands, secret-file reads (`gemini_keys.json`, `.env.local`), or reviewer
  invocation, and its brief said review was skipped. That applied to writing this document
  only. The plan has since been reviewed (rounds 1–2) and the implementation session has the
  authorizations below; where this document still reads as forbidding one of them, the list
  below wins.
- **Implementation-session authorizations (granted by Herbert in the 2026-10-29 session,
  not recorded anywhere in this repo; everything not listed stays forbidden):**
  1. One standard-tier depth-1/breadth-1 live Deep Research run (paid, ~$1–3), as the
     go-live acceptance test. No Max, legacy, OpenAI, or Azure live calls.
  2. `.env.local` is read only by the entry's dotenv inside the child process. The
     implementation session never opens, prints, or diffs it; it may run equality/count greps
     on the non-secret `RESEARCH_PROVIDER` line and name-only existence checks of keys.
  3. One guarded single-line edit of `.env.local` (`RESEARCH_PROVIDER=openai` →
     `RESEARCH_PROVIDER=gemini`), only after the live run passes, per the procedure in
     Verification. A backup copy goes to the session scratch directory, never into the repo
     (`.env.local.bak` would not be gitignored; only `.env` and `.env.local` are).
  4. `npm run build` overwriting `dist/` after the hashed baseline copy exists.
  5. Cross-provider review rounds (policy cap 3) and the deep security review before commit.
  6. **Commit policy (round-3 revision): no commit is made in this session without Herbert's
     explicit decision.** The tracked `src/deep-research.ts` already imports the untracked June
     file `src/ai/openai-deep-research.ts`, so any commit of this change must either (a) stay
     uncommitted, leaving the working tree for Herbert with the touched-file list recorded in
     `.plans/DECISIONS.md`, or (b) with Herbert's permission, first commit the June leftover
     work (`src/ai/openai-deep-research.ts`, its test, and the June hunks it needs) as its own
     commit and only then commit this change on top. The committed tree must build on its own,
     checked in a scratch `git worktree` of the staged state; never a commit that does not
     build or that silently sweeps in leftover work. No `approved.json` token exists after
     round 3, so a commit also needs Herbert's logged `PLAN_REVIEW_OVERRIDE` (see Review
     findings, Round 3).
  7. **Key comparison dropped (round-3 revision):** no digest or any other read of the
     `GEMINI_API_KEY` value in `.env.local` or `~/.claude.json`. "Production key not compared"
     is a fixed, recorded verification gap.
  8. **The "First Claude Code run" is a second paid run and is started by Herbert**, or on his
     separate approval, never by the implementing session. Whoever runs it records it in
     `.plans/DECISIONS.md`; the implementing session only leaves the follow-up note.
  `gemini_keys.json` stays unopened and uncommitted (now gitignored).

### Independent assessment of Claude's declared conclusions

1. **Accept REST fetch.** A major SDK upgrade would affect generation/embedding/token
   helpers; the installed SDK cannot serve this API. No dependency change is needed.
2. **Accept tier selection; strengthen lifecycle.** Preserve the current depth threshold,
   disclose cost, validate env, bound requests/body reads/cancel, and prevent duplicate POSTs.
3. **Accept provider migration; reject catch-all routing.** `gemini` changes meaning;
   document `gemini-legacy` migration and explicitly reject unknown provider names.
4. **Partly overturn.** Keep visualization off, collaborative planning off, and the two
   tools; use thinking_summaries **none**, not auto. Polling already supports progress and
   the brief supplies no thought-summary schema. Explicitly require `store: true`.
5. **Accept citation mapping; reject thoughts as learnings.** Extract the last model output
   only; use the factual completion learning, preserving citation URLs without decoding.
6. **Expand coverage.** Include requires_action/continuation/unknown states, aborts, bounded
   retries, malformed payloads, caller-error redaction, dispatch/cache and MCP compatibility.
   Google's detailed errors belong in sanitized logs, not caller-visible error text.
7. **Qualify verification.** The current suite is already red; distinguish regressions.
   A real depth-1 MCP call is not part of the plan-authoring task; it is the go-live
   condition of the implementation session (authorized by Herbert, see Verification).

## File-by-file implementation sequence (test first)

### 1. Agent client and deterministic fixtures

- First add `src/ai/gemini-deep-research.test.ts` (node:test + assert/strict), then implement
  `src/ai/gemini-deep-research.ts` with small runtime guards, pure selector/extractor,
  typed consumed response fields, request builder, and create/poll/cancel state machine.
  The client accepts an optional external `AbortSignal` (caller cancellation) alongside the
  injected fetch/clock/sleep seams; an external abort ends polling, sends the single
  best-effort cancel, and fails with category `cancelled` (tested).
  Accept internal injected fetch/clock/sleep/abort-timer dependencies for deterministic
  lifecycle tests; production defaults use native APIs. No SDK or import-time key lookup.
- Red tests: depth defaults/boundaries/override, strict env parsing, key absence before
  fetch, exact body/headers/host, context/breadth prompt inclusion, immediate completion,
  repeated progress, and final-step extraction with multiple text blocks/duplicate URLs,
  Unicode byte offsets, redirect URLs, other citations, earlier drafts, images, and no text.
- Red lifecycle tests: every state in the table; malformed/missing id/status/steps/content;
  401/403/404/429/5xx and network errors; GET retry limit/deadline/Retry-After; no duplicate
  creation; hanging create, GET, JSON body, and cancel; timeout during sleep; exactly one
  cancellation; cancel failure preserves original error; callback throws; safe error/log
  redaction using dummy secrets echoed by upstream. No real timers, sockets, or credentials.
- Make tests pass before integrating. Return `{content, visitedUrls, learnings}` plus
  selected-agent identity internally if needed; do not extend the public ResearchResult.

### 2. Research dispatch and report adapter

- First add `src/deep-research.test.ts`; then edit `src/deep-research.ts` to export one
  shared provider resolver, dispatch explicitly, rename the legacy implementation/comment,
  and add the agent adapter. Keep existing OpenAI/legacy implementation behavior intact.
- Test all names, case/whitespace/default/invalid selection, lazy legacy loading, and
  calling explicit OpenAI without a Gemini key. Use fake fetch responses for all engines.
  Agent tests cover existingLearnings, depth/breadth, progress through saved completion,
  content/path/source metadata, and write failure without a successful result.
- Use disposable temp directories for file assertions, restore cwd/env/fetch in finally,
  and serialize tests that mutate process globals. Do not create reports in the repository.

### 3. MCP integration and compatibility

- First add `src/server.test.ts`; then create `src/server.ts` (revised in review round 1,
  replacing argv/`import.meta.url` gating). `src/server.ts` is a side-effect-free factory
  module: it exports `createServer` (narrow injectable research/upload/cache dependencies,
  production defaults unchanged), `apiKeyAuth`, and the helpers below, and it reads
  `process.env` only inside function bodies at call time, never at module top level
  (ESM imports run before the entry's body, so module-level env reads would run before
  dotenv). `src/mcp-server.ts` stays the entry point every launcher uses (`node
  dist/mcp-server.js` from Claude Code's config and from `~/tools/gemini-mcp-wrapper.js`,
  which spawns it): it loads dotenv first, unconditionally, then imports/calls the factory,
  logs startup, and starts the transport. No execution-detection logic anywhere. Importing
  `src/server.ts` in tests must neither read `.env.local` nor start a listener.
- Share provider/agent resolution for execution, startup diagnostics, tool description,
  and capabilities through a NON-THROWING `describeResearchConfig()` returning
  `{ provider: <name> | 'invalid', agent: <id> | 'invalid', problems: string[] }` (safe
  strings, no values echoed). Only the execution path resolves strictly and may throw, and
  only inside the tool handler's try/catch. A typo in `RESEARCH_PROVIDER` or a bad
  `GEMINI_DR_*` value must still let `createServer`, `initialize`, `tools/list`, and
  capabilities succeed, while the tool call returns the safe error envelope (tested).
  Preserve capability keys; add agent identity and report active tool flags truthfully.
  Mark GEMINI_MODEL and legacy flags as legacy settings in documentation. Preserve download
  instructions; replace retired-model default claims with agent timings.
- Include resolved provider, selected agent/model, and normalized input defaults in cache
  identity; reuse existing TTL/size policy. Resolve configuration inside the error boundary.
  **The default cache stays one lazily created, process-wide module-level instance** (HTTP
  mode calls `createServer()` per request at `src/mcp-server.ts:374`; a cache built inside
  the factory would silently disable HTTP caching). The injectable cache dependency is for
  tests only; a test asserts that two `createServer()` instances with default dependencies
  share one cache. `src/logger.ts` branches its options so a pino `transport` and a
  destination stream are never both passed (pino rejects that combination): non-pretty →
  `pino(opts, pino.destination(2))`; pretty → `transport.options.destination = 2`. The entry
  `src/mcp-server.ts` loads dotenv, then loads the factory with a dynamic
  `await import('./server.js')` so that no module-level env read (logger `LOG_LEVEL`, the
  OpenAI module's constants) runs before dotenv; static imports of those modules move out
  of the entry.
  Replace raw error forwarding with the safe error envelope: caller-visible text is the
  generic research-error sentence plus a stable category code from a fixed allowlist
  (`missing_key`, `invalid_config`, `auth`, `quota`, `timeout`, `cancelled`, `unsupported_state`,
  `protocol`, `upstream_failed`, `empty_report`, `persist_failed`, `unknown`) and, when known,
  the interaction id (needed to recover the stored report within retention). Upstream
  message text stays in sanitized logs only.
- Client cancellation: `ResearchOptions` gains an optional internal `signal?: AbortSignal`
  (not part of the MCP input schema). The tool handler passes `extra.signal` (SDK 1.17.2
  aborts it on `notifications/cancelled`). The agent client treats an external abort as
  abandonment: stop polling, send the single best-effort cancel, fail with category
  `cancelled`. Do not cache. In-flight de-duplication by cache key is NOT added (rebutted in
  round 1: a cancelled task is already stopped, so a retry does not double-bill).
- Long-run keep-alive: when the client supplies `_meta.progressToken`, forward each poll
  tick as an MCP `notifications/progress` via `extra.sendNotification` (no `total`, safe
  message). The `progress` value must be strictly increasing as MCP requires: use a
  per-request tick counter (or elapsed milliseconds), never whole elapsed seconds, which can
  repeat. Never fabricate completion percentages. Missing token → no notification.
  **Forwarding never rejects unhandled (round-2 revision):** SDK 1.17.2's `notification()`
  throws `Not connected` once the transport has closed and closing does not abort
  `extra.signal`, so each send is awaited inside try/catch (or given `.catch()`), logged at
  debug level, and forwarding stops after the first failure while polling continues. A
  `src/server.test.ts` case makes the injected `sendNotification` reject and asserts that
  research still completes, the result is returned and cached, and no `unhandledRejection`
  fires (listener installed for the test).
- **Claude Code tool-timeout behaviour is UNVERIFIED by this plan's live run.** The scripted
  acceptance run is a separate stdio client with its own ≥60-minute deadline, so it says
  nothing about Claude Code's timeout. The first real Claude Code call happens only after the
  `.env.local` flip and a client restart. That call is a named, monitored follow-up step (see
  Verification, "First Claude Code run"), not part of this session's acceptance. If Claude
  Code sends `notifications/cancelled` before completion, the `extra.signal` wiring cancels
  the paid task (one standard-tier charge, no report); the documented response is rollback
  to `RESEARCH_PROVIDER=gemini-legacy` and a separate fix, not retries.
- Use installed SDK InMemoryTransport (`@modelcontextprotocol/sdk/inMemory.js`, 1.17.2)
  with stub research/upload and an isolated cache: assert registered name/schema, default
  arguments, inline content/metadata, HTTP large-report URL branch, Azure upload-failure
  behavior, caching/no cache on errors, provider/agent cache separation, capabilities,
  secret-free failures, the category-code error text, that an invalid `RESEARCH_PROVIDER`
  or `GEMINI_DR_POLL_INTERVAL_MS` still lets `initialize`/`tools/list` succeed while the
  tool call returns the envelope, and that `extra.signal` reaches the research dependency.
  Preserve goal/flags behavior.
  Test existing apiKeyAuth directly with fake requests/responses (no key, wrong key, valid
  x-api-key and Bearer); export the middleware only as a test seam, without changing policy.

### 4. Configuration and release notes

- Update `.env.example`: provider values/default and migration, key requirements by provider,
  GEMINI_DEEP_RESEARCH_AGENT, GEMINI_DR_POLL_INTERVAL_MS, GEMINI_DR_TIMEOUT_MS with bounds,
  tiers/cost/storage/deadline expectations, and legacy-only settings. Correct its Node-22
  claim to package target 20.x; do not add real secrets or remove unrelated existing edits.
- Add an unreleased `CHANGELOG.md` entry: new default, explicit legacy fallback, unchanged
  MCP contract, unsupported interactive/continuation states, and OpenAI retirement limitation.
  Do not bump versions, repair historical entries, or touch package files.
- Round-3 additions: `CHANGELOG.md` and `.env.example` state that a remote deployment (the
  Cloud Run instance Codex's config points at) with `RESEARCH_PROVIDER` unset will switch to
  the paid Google agent on its next redeploy, so deployers set the provider explicitly; the
  CHANGELOG also records that standard `notifications/progress` are now sent when the
  client supplies a `progressToken`, and that logs now go to stderr. Add one short note to
  `docs/rules/mcp-server-rules.md` saying standard progress notifications are emitted on a
  token (a full rewrite of that outdated doc is out of scope).

## Verification commands and acceptance

Commands below use already-installed tools; no install or npx download. Deterministic
verification makes no live provider call and does not overwrite `dist/`.

**Baseline capture (before the first edit):** copy `src/deep-research.ts`, `src/mcp-server.ts`,
`src/logger.ts`, `.env.example`, `CHANGELOG.md` and the whole `dist/` directory to a scratch
directory outside the repo and record `shasum -a 256` for each file. Rollback of this change
diffs against those copies (git cannot restore the uncommitted June state).

```sh
./node_modules/.bin/tsx --test src/ai/gemini-deep-research.test.ts src/deep-research.test.ts src/server.test.ts src/ai/openai-deep-research.test.ts
npm test
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/tsc --outDir <scratch>/dist-check      # emit check without touching dist/
git diff --check -- src/ai/gemini-deep-research.ts src/ai/gemini-deep-research.test.ts src/deep-research.ts src/deep-research.test.ts src/server.ts src/server.test.ts src/mcp-server.ts src/logger.ts .env.example CHANGELOG.md
# go-live moment (only after everything above is green):
npm run build                                               # overwrites dist/, backed up above
```

- Credential-free startup check after the build: launch `node dist/mcp-server.js` over stdio
  with `GEMINI_API_KEY=` set to the EMPTY string (dotenv does not override a present variable,
  so leaving it unset would load the real key from `.env.local`), `OPENAI_API_KEY=` empty,
  and `RESEARCH_PROVIDER=not-a-provider`; send `initialize`, `tools/list` and read
  `mcp://capabilities`; confirm all succeed, capabilities report `provider: invalid` with a
  problem listed, no tool call is made, and stdout carries only JSON-RPC lines.

- **Observed during planning:** `node --version` = v24.21.0; `./node_modules/.bin/tsc
  --noEmit` exits 0; `npm test` exits 1, 5 passed/2 failed. The existing splitter failures
  are “Should handle special characters and large texts” and “Should handle chunkSize
  equal to chunkOverlap.” All three existing OpenAI tests pass. No emitted build was run.
- Implement in red/green increments. New tests and existing OpenAI tests must pass; build
  and type-check must pass. Full suite must show no additional failures versus this baseline;
  explicitly report the two inherited failures, never claim an entirely green suite or
  weaken/fix unrelated tests. Check Node 20 too if already installed; do not download it.
- Diff checks must distinguish pre-existing warnings; inspect new untracked source files
  explicitly because ordinary git diff omits them. Review only this task's delta to baseline.
- **Live acceptance (authorized by Herbert for THIS session, 2026-10-29; a go-live
  condition, not deferred):** immediately after `npm run build`, one standard-tier
  depth-1/breadth-1 stdio MCP run against `node dist/mcp-server.js`, driven by a harness
  script kept in the session scratch directory (not in tracked files) with the child's
  `cwd` set to a scratch directory so the report file lands outside the repo.
  - **Child env (round-2 revision):** the harness passes `RESEARCH_PROVIDER=gemini`
    explicitly (non-secret, fine on a command line) because `.env.local` still says
    `openai` at this point and dotenv never overrides a present variable, and
    `StdioClientTransport` forwards only `getDefaultEnvironment()` plus `params.env`.
    It passes no `GEMINI_DEEP_RESEARCH_AGENT` and no `GEMINI_API_KEY`; the key is loaded
    from `.env.local` by the entry's dotenv (never on a command line or in logs).
  - **Pre-flight before any paid call:** confirm by name only (`cut -d= -f1`) that
    `.env.local` contains `GEMINI_API_KEY`; then read `mcp://capabilities` through the
    harness and require `provider: gemini`, `agent: deep-research-preview-04-2026`, and an
    empty `problems` list. If any differs, abort without calling the tool.
  - **Key provenance (round-3 revision): not compared.** Claude Code's config supplies its
    own `GEMINI_API_KEY`, which takes precedence over `.env.local` in production. No digest
    or other read of either value is performed (authorization 7); "production key not
    compared" is recorded as a fixed verification gap.
  - **Client deadline 70 minutes** (the server's 60-minute `GEMINI_DR_TIMEOUT_MS` default plus
    a margin, so the server's own timeout envelope arrives before the SDK client cancels),
    a public query. The harness runs detached with stdout/stderr logs in scratch and is
    polled for status, never held in a foreground command. **An interrupted or ambiguous
    run is never retried without Herbert's re-authorization**; its result is recovered from
    the report file in the scratch `cwd` or the interaction id in the stderr log. Verify:
    returned report equals the written `deep_research_report_<ts>.md`, citations present,
    progress values strictly increasing, selected agent is `deep-research-preview-04-2026`,
    **consumed fields present and parsed** (the harness cannot observe the full REST shape;
    the server emits one allowlisted debug summary: status values seen, step counts per
    type, annotation counts by type, whether `errors[]` was present, no text or URLs),
    stdout clean. Do not perform Max, legacy, OpenAI, or Azure live calls. If this run
    fails, do NOT flip `.env.local`; restore `dist/` from the baseline copy and report.
    Until it passes, API compatibility is fixture-tested, not live-verified.
- **Guarded `.env.local` flip (only after the live run passes):** (1) `grep -c
  '^RESEARCH_PROVIDER=openai$' .env.local` must print exactly `1`; (2) `cp -p .env.local
  <scratch>/env.local.before` (backup outside the repo, permissions preserved); (3) `sed -i ''
  's/^RESEARCH_PROVIDER=openai$/RESEARCH_PROVIDER=gemini/' .env.local` (BSD sed syntax, no
  `.bak` inside the repo); (4) post-checks: `grep -c '^RESEARCH_PROVIDER=gemini$'` prints
  `1`, `grep -c '^RESEARCH_PROVIDER=openai$'` prints `0`, `wc -l` matches the backup, and
  `ls -l` shows unchanged permissions. Any failed check → restore from the scratch backup
  and report. Nothing prints file contents.
- **First Claude Code run (follow-up, monitored, after the flip and a client restart;
  started by Herbert or on his separate approval, never by the implementing session; a
  second paid run, ~$1–3):** one depth-1 `deepResearch.run` from Claude Code itself,
  recording interaction id, elapsed time, and outcome in `.plans/DECISIONS.md`. Claude Code's tool-timeout behaviour is
  unverified until this step happens; the running server in the implementing session was
  started from the old `dist/` and cannot test the new build. If Claude Code cancels the
  run, roll back to `RESEARCH_PROVIDER=gemini-legacy`; the fix is separate work.
- Rollback after go-live, stated accurately (round-3 revision): restoring `.env.local` from
  the scratch backup returns to the previous state, which is **non-working** (it routes to
  retired OpenAI agents). `RESEARCH_PROVIDER=gemini-legacy` plus a client restart (clears
  the in-memory cache) is an **unverified** fallback: the legacy loop has not been exercised
  since June and this plan forbids legacy live calls, so it is not known-good. Restoring the
  backed-up `dist/` reverts the code but not the provider setting. OpenAI is not a
  reliable rollback while its agents are retired. Revert only this change's hunks against
  the captured baseline copies; preserve pre-existing files, reports, and edits.

## Review findings

### Round 1 — 2026-10-29, `codex-fable-review --phase plan` (claude-opus-5-5), verdict REVISE
Record: `.plans/.codex-review/reviews/fable-2026-10-29-gemini-deep-research-agent-20261029T173713Z-54218.json`.
Reconciled by Claude (Fable 5.1); every finding has a disposition and the accepted ones are
applied in the sections above.

| # | Sev | Finding | Disposition |
| --- | --- | --- | --- |
| 1 | HIGH | argv/`import.meta.url` startup gating is fragile and ignores the launcher | **Accepted (preferred option).** Section 3 now specifies a side-effect-free `src/server.ts` factory (env read at call time) and an unconditional `src/mcp-server.ts` entry that loads dotenv first. Verified: the wrapper `spawn`s `dist/mcp-server.js`, Claude Code runs it directly; no launcher imports the module, but the factory design removes the detection hazard regardless. |
| 2 | HIGH | Live `RESEARCH_PROVIDER` and launch path unknown | **Accepted.** Verified without printing values: client config sets no RESEARCH_PROVIDER; `.env.local` sets `openai` (live tool currently dead). Expected live effect, the one-line `.env.local` change, and Herbert's acknowledgment (his instruction to make the agent the default) are recorded under Assumptions. No alias needed. |
| 3 | MEDIUM | `npm run build` overwrites `dist/`; "no deployment" claim inaccurate | **Accepted.** Deterministic emit check goes to a scratch `--outDir`; `dist/` is backed up with hashes before `npm run build`, which is named as the go-live moment and is immediately followed by the live run; rollback defined. The reviewer's "deferred live test" premise is superseded: Herbert authorized the live depth-1 run in this session. |
| 4 | MEDIUM | Throwing resolver would crash startup / description | **Accepted.** Non-throwing `describeResearchConfig()` for description, capabilities and startup log; strict resolution only inside the tool handler's try/catch; invalid-env test added. |
| 5 | MEDIUM | Client cancellation never cancels the paid interaction | **Accepted** for the `AbortSignal` (`extra.signal`) plumbing and single cancel. **Rebutted** for in-flight de-duplication by cache key: once an abort cancels the interaction, a retry creates a fresh task rather than a duplicate paid run; dedupe adds state for no billing benefit. |
| 6 | MEDIUM | pino logs go to stdout on the stdio transport | **Accepted.** `src/logger.ts` gets `pino.destination(2)` (stderr), also for the pretty transport; stdout cleanliness is asserted in the credential-free startup check and the live run. |
| 7 | LOW | Fully generic caller error hides actionable info | **Accepted.** Allowlisted category code plus interaction id (when known) in the caller text; upstream text only in sanitized logs. |
| 8 | LOW | Baseline/rollback method unspecified | **Accepted.** Scratch copies with sha256 of every pre-existing touched file and `dist/` before the first edit. |
| 9 | LOW | Strict shape handling could fail every call after billing | **Accepted.** Live run is a go-live condition; post-`completed` extraction/protocol failures log and surface the interaction id. |

Reviewer verification gaps, addressed: wrapper read (spawns, no key literals); `.env.local`
key names and `RESEARCH_PROVIDER` class checked by equality only; Codex points at a
separate Cloud Run deployment (untouched); client tool-timeout behaviour is observed in
the live run and reported, with progress notifications added as the standard mitigation.

Claude's own two reconciliation items: (a) the live depth-1 run is authorized in this
session, so "deferred" wording was replaced; (b) the section-3 test harness was judged
heavier than needed, but finding 1's factory design is the correct fix and makes the
InMemoryTransport tests natural, so the scope is kept (apiKeyAuth tests stay small).

### Round 2 — 2026-10-29, `codex-fable-review --phase plan` (claude-opus-5-5), verdict REVISE
Record: `.plans/.codex-review/reviews/fable-2026-10-29-gemini-deep-research-agent-20261029T174659Z-59483.json`.
Reconciled by Claude (Fable 5.1); all eight findings accepted and applied above. The
reviewer's SDK claims were re-verified against `node_modules/@modelcontextprotocol/sdk`
1.17.2 (`getDefaultEnvironment` in client/stdio.js; `Not connected` in shared/protocol.js)
and `.gitignore` (only `.env` / `.env.local` are ignored, so no `.bak` in the repo).

| # | Sev | Finding | Disposition |
| --- | --- | --- | --- |
| 1 | HIGH | Live acceptance run would resolve `openai` from `.env.local` and make a forbidden live OpenAI call | **Accepted.** Harness passes `RESEARCH_PROVIDER=gemini` in the child env, no agent override, no key; pre-flight reads `mcp://capabilities` and aborts unless provider/agent/problems match. |
| 2 | MEDIUM | Progress-notification forwarding can reject unhandled and crash the process | **Accepted.** Each send awaited in try/catch, debug-logged, forwarding stops after first failure, polling continues; test with a rejecting `sendNotification` and an `unhandledRejection` listener. |
| 3 | MEDIUM | Scripted live run cannot show Claude Code's tool-timeout behaviour | **Accepted.** Claim removed; behaviour stated as unverified; a monitored "First Claude Code run" follow-up step added with rollback to `gemini-legacy` if the client cancels. |
| 4 | MEDIUM | Plan contradicts itself on what the implementation session may do | **Accepted.** Authoring constraints marked historical; explicit "Implementation-session authorizations" list added, noting Herbert's approvals come from the session, not the repo. |
| 5 | LOW | `.env.local` edit lacks safeguards | **Accepted.** Guarded flip procedure: pre-count, scratch backup, BSD `sed -i ''`, post-counts, line count and permissions check, restore on failure. |
| 6 | LOW | "Credential-free" startup check still loads the key via dotenv | **Accepted.** `GEMINI_API_KEY=` and `OPENAI_API_KEY=` set to empty strings, which dotenv does not override; capabilities checked for `provider: invalid`. |
| 7 | LOW | Live run may test a different key than production uses | **Accepted.** Name-only existence check of `GEMINI_API_KEY` in `.env.local`; sha256 same/different comparison with the client-config key, or a recorded verification gap. |
| 8 | LOW | Details that could change existing behaviour (HTTP cache, pino options, import order, report cwd, progress monotonicity) | **Accepted, all five.** Module-level lazy cache shared across `createServer()` instances (tested); logger options branched; entry uses dynamic `import('./server.js')` after dotenv; harness `cwd` is scratch; progress uses a strictly increasing tick counter. |

### Round 3 — 2026-10-29, `codex-fable-review --phase plan` (claude-opus-5-5), verdict REVISE
Record: `.plans/.codex-review/reviews/fable-2026-10-29-gemini-deep-research-agent-20261029T175540Z-69699.json`.
Reconciled by Claude (Fable 5.1). Round 3 is the last round allowed by the policy cap. Every
finding concerns authority text, sequencing, the harness, or record-keeping; none concerns the
change itself. Under the Proportionality rule ("a round whose only findings concern the
harness, record-keeping or formatting counts as APPROVE-with-notes") the notes are recorded
and applied above, and no fourth round is commissioned. The reviewer wrote the same: "Neither
needs another full review round." Because no `approved.json` token exists, the commit gate
needs Herbert's explicit OK via a logged `PLAN_REVIEW_OVERRIDE`, and the commit scope itself
is Herbert's decision (authorization 6). Both are surfaced to him before any commit.

| # | Sev | Finding | Disposition |
| --- | --- | --- | --- |
| 1 | MEDIUM | Verification steps exceed the authorization list (digest read of secret key values; second paid run with no owner) | **Accepted.** Key comparison dropped entirely; "production key not compared" is a fixed gap (authorization 7). The First Claude Code run is a second paid run started by Herbert or on his separate approval, never by the implementing session (authorization 8). |
| 2 | MEDIUM | No commit policy; tracked `src/deep-research.ts` imports untracked June file `src/ai/openai-deep-research.ts` | **Accepted.** Authorization 6: no commit without Herbert's decision between (a) leave uncommitted with a touched-file list, or (b) commit the June leftover work first as its own commit, then this change; committed tree must build, checked in a scratch worktree. |
| 3 | LOW | Harness deadline equals server deadline; executor timeout; no-retry rule unstated | **Accepted.** Client deadline 70 min; harness runs detached with scratch logs and is polled; an interrupted or ambiguous run is never retried without Herbert's re-authorization; recovery from the report file or logged interaction id. |
| 4 | LOW | Rollback to `gemini-legacy` not shown to work | **Accepted.** Rollback paragraph reworded: restoring `.env.local` returns to a non-working state; `gemini-legacy` is an unverified fallback, not known-good. |
| 5 | LOW | "REST shape matches fixtures" unobservable under the logging policy | **Accepted.** Criterion reworded to "consumed fields present and parsed"; the server emits one allowlisted debug summary (statuses, step counts per type, annotation counts by type, `errors[]` presence; no text or URLs). |
| 6 | LOW | Effect on a future Cloud Run redeploy not flagged | **Accepted.** `CHANGELOG.md` and `.env.example` warn that remote deployments with `RESEARCH_PROVIDER` unset switch to the paid agent on redeploy. |
| 7 | LOW | Rule doc conflicts with new progress notifications | **Accepted.** CHANGELOG line plus a one-line note in `docs/rules/mcp-server-rules.md`; full rewrite out of scope. |
