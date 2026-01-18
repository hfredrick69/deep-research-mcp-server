# Changelog

All notable changes to the Deep Research MCP Server are documented in this file.

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
