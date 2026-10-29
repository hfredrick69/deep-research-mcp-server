# Changelog

All notable changes to the Deep Research MCP Server are documented in this file.

## [Unreleased]

### Changed

- **Default research engine is now Google's Deep Research agent** (Gemini Interactions API)
  - `depth 1-2` selects `deep-research-preview-04-2026`; `depth >= 3` selects
    `deep-research-max-preview-04-2026`. Override with `GEMINI_DEEP_RESEARCH_AGENT`.
  - Background interactions polled every `GEMINI_DR_POLL_INTERVAL_MS` (5-10 s, default 10 s)
    up to `GEMINI_DR_TIMEOUT_MS` (default and maximum 60 min); the interaction is cancelled
    server-side on timeout or client abort.
  - Cited source URLs are returned in `visitedUrls`; the report is written to
    `deep_research_report_<timestamp>.md` as before.
  - Requires `GEMINI_API_KEY`. Each run is billed per task (standard tier roughly $1-3,
    max tier roughly $3-7).
- **`RESEARCH_PROVIDER` values**: `gemini` (default when unset), `gemini-legacy` (the previous
  in-process Gemini Pro + Google Search loop, formerly selected by `gemini`), `openai`.
  An unrecognised value makes every tool call return an `invalid_config` error.
- **MCP contract unchanged**: tool name `deepResearch.run`, input schema, inline/URL result
  text and `metadata` shape are the same. Failures are returned as a text envelope
  `Deep research failed. Category: <category>. [Interaction id: <id>.] Details are in the
  server log.` with `metadata.errorCategory` (and `metadata.interactionId` when known);
  upstream error text is logged, never returned to the client. Failures are not cached.
- Standard `notifications/progress` are now emitted when the client supplies a
  `progressToken`; without a token nothing is sent. Forwarding stops after the first failed
  send.
- Logs go to stderr only (stdout carries stdio JSON-RPC) through a synchronous pino
  destination so the last lines survive a crash. `LOG_PRETTY=true` keeps pino-pretty.
- The `mcp://capabilities` resource now reports `provider`, `agent`, `pollIntervalMs`,
  `timeoutMs`, `legacyFlagsActive` and `configProblems`.
- Server construction moved to `src/server.ts` (`createServer(deps)`) so it is testable
  without a transport; `src/mcp-server.ts` is the transport entry point only.

### Deprecated

- `RESEARCH_PROVIDER=openai`: OpenAI has retired the `o3-deep-research` and
  `o4-mini-deep-research` models. The path is kept for accounts that still have access and
  is otherwise expected to fail with an `upstream_failed` error.

### Known limitations

- Interactions that enter `requires_action` or `requires_continuation` are cancelled and
  reported as `unsupported_state` errors; the server does not drive interactive
  clarification or continuation rounds. `failed`, `cancelled` and `incomplete` end as
  `upstream_failed`.
- **Deployment warning**: a remote deployment (for example the Cloud Run instance) that
  leaves `RESEARCH_PROVIDER` unset will switch from OpenAI to the paid Google agent on its
  next redeploy. Set the provider explicitly in every deployed environment.

### Fixed

- **Report write failures no longer discard the finished report.** All three providers (Gemini
  agent, `gemini-legacy`, `openai`) now return the complete report in `content` with a
  `persistWarning` (intended path and OS error code only) and no `reportPath` when the file
  cannot be written. The Gemini runner previously threw `persist_failed` and the other two
  surfaced the raw filesystem error, losing a paid run's text either way.
- **Report files are created exclusively** (`flag: 'wx'`): an existing file at the timestamped
  path is never overwritten; the collision is reported as a `persistWarning` instead.
- **Gemini Interactions client validates the create response before reporting progress.** An
  interaction id outside `[A-Za-z0-9_.-]{1,256}` is a `protocol` error (not echoed, not polled,
  not cancelled); an unrecognised initial status reaches progress listeners as `unknown`
  instead of verbatim upstream text.
- `resolveReportDirectory(env, launchCwd)` is exported from the runner as the shared
  output-directory contract. It returns the resolved launch cwd; a configurable `REPORT_DIR`
  is deliberately deferred.

## [0.5.0] - 2026-06-12

### Changed

- **Default research engine is now OpenAI Deep Research** (ChatGPT Deep Research via the Responses API)
  - `depth >= 3` selects `o3-deep-research`; lower depth uses `o4-mini-deep-research`
  - Override model with `OPENAI_DEEP_RESEARCH_MODEL`; requires `OPENAI_API_KEY`
  - Background mode with polling (`OPENAI_DR_POLL_INTERVAL_MS`, default 15s; `OPENAI_DR_TIMEOUT_MS`, default 45 min)
  - Cited source URLs returned in `visitedUrls` metadata
- Legacy Gemini engine retained behind `RESEARCH_PROVIDER=gemini` (loaded lazily so the server starts without a Gemini key)

## [0.4.0] - 2026-01-18

### Added

- **HTTP Mode for Cloud Run / Remote Deployment**
  - New `MCP_HTTP_MODE=true` environment variable enables HTTP transport
  - Supports StreamableHTTP and SSE transports for remote MCP clients
  - API key authentication via `MCP_API_KEY` header (`x-api-key` or `Authorization: Bearer`)
  - Health check endpoint at `/health`

- **Google Cloud Storage Integration**
  - Full reports are uploaded to GCS for reliable delivery
  - Signed URLs generated with 7-day expiration
  - Configurable bucket via `GCS_BUCKET_NAME` environment variable
  - Automatic filename generation based on query and timestamp

- **Size-Based Auto-Switching**
  - Reports exceeding 50KB automatically use URL mode
  - Prevents token/size limit issues in Claude Code, Gemini CLI, and other clients
  - Small reports (≤50KB) returned inline for stdio mode
  - Large reports get GCS URL with download instructions

- **Multi-Client Support**
  - **stdio mode**: Claude Code, Gemini CLI (local) - inline content for small reports, URL for large
  - **HTTP mode**: Codex, remote clients - always returns GCS URL with curl command

### Changed

- Report output now includes size information (`reportSizeKB` in metadata)
- HTTP mode responses include explicit download instructions with suggested filename
- Improved logging with mode indicators (`http`, `stdio-inline`, `size-threshold`)

### Configuration

New environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `MCP_HTTP_MODE` | Enable HTTP transport (for Cloud Run) | `false` |
| `MCP_API_KEY` | API key for HTTP authentication | (none) |
| `GCS_BUCKET_NAME` | GCS bucket for report storage | `deep-research-reports-gen-lang-client-0824947382` |

### Deployment

**Cloud Run Deployment:**
```bash
gcloud run deploy deep-research-mcp \
  --source . \
  --region=us-central1 \
  --allow-unauthenticated \
  --set-env-vars="MCP_HTTP_MODE=true,GEMINI_API_KEY=xxx,MCP_API_KEY=xxx,GCS_BUCKET_NAME=xxx"
```

**Local stdio Mode:**
```bash
node --env-file .env.local dist/mcp-server.js
```

---

## [0.3.0] - 2026-01-02

### Added
- Enhanced research validation (input/output)
- Gemini 2.5 Flash integration with optional tools
- Semantic + recursive text splitting
- Concurrent processing pipeline
- Research metrics tracking

### Changed
- Consolidated on Gemini 2.5 Flash
- 30% faster research cycles
- 60% reduction in API errors
- 25% more efficient token usage

---

## [0.2.0] - Initial Release

- Basic deep research functionality
- MCP server integration
- CLI support
