# Deep Research MCP Server

[![Node.js](https://img.shields.io/badge/node.js-v22.x-green?style=flat-square&logo=node.js)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-%5E5.9.2-blue?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![Gemini API](https://img.shields.io/badge/Gemini_2.5-Flash-purple?style=flat-square&logo=google-gemini)](https://makersuite.google.com/app/apikey)
[![MCP](https://img.shields.io/badge/MCP-Model_Context_Protocol-lightgrey?style=flat-square)](https://github.com/modelcontextprotocol)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)

**Your AI-Powered Research Assistant.** Conduct iterative, deep research using Google Gemini 2.5 Flash with Google Search Grounding and URL context. No web-scraping dependency is required.

---

## Table of Contents

* [Features](#features)
* [Why This Project](#why-this-project)
* [Workflow Diagram](#workflow-diagram)
* [Persona Agents](#persona-agents)
* [How It Works](#how-it-works)
* [Project Structure](#project-structure)
* [Requirements](#requirements)
* [Setup](#setup)
* [Usage](#usage)
  * [As MCP Tool](#as-mcp-tool)
  * [Standalone CLI Usage](#standalone-cli-usage)
  * [MCP Inspector Testing](#mcp-inspector-testing)
* [Configuration](#configuration)
* [Quickstart](#quickstart)
* [Example Output](#example-output)
* [Support](#support)
* [Contributing](#contributing)
* [Roadmap](#roadmap)
* [License](#license)

The goal of this project is to provide the *simplest* yet *most effective* implementation of a deep research agent.  It's designed to be easily understood, modified, and extended, aiming for a codebase under 500 lines of code (LoC).

**Key Features:**

* **MCP Integration:** Runs as a Model Context Protocol (MCP) server/tool for seamless agent integration.
* **Gemini 2.5 Flash Pipeline:** Long-context reasoning, structured JSON outputs, and tool use (Google Search Grounding, Code Execution, Functions) via env flags.
* **Iterative Deep Dive:** Query refinement + result analysis with learned context carried forward.
* **Depth & Breadth Control:** Tune exploration scope precisely.
* **Semantic/Recursive Splitting:** Token-aware chunking for robust summarization and analysis.
* **Batching + Caching:** Concurrency-limited batched model calls with LRU caches across prompts/results.
* **Professional Reports:** Generates structured Markdown (Abstract, ToC, Intro, Body, Methodology, Limitations, Key Learnings, References).

## Why This Project

* **Gemini-first, modern pipeline:** Built around Gemini 2.5 Flash with optional tools (Search Grounding, Code Execution, Functions).
* **Minimal, understandable core:** Plain TypeScript; easy to audit and extend.
* **Deterministic outputs:** Zod-validated JSON and consistent report scaffolding.
* **Agent-ready:** Clean MCP server entry; works with Inspector and MCP-aware clients.

## Workflow Diagram

```mermaid
flowchart TB
    subgraph Input
        Q[User Query]
        B[Breadth Parameter]
        D[Depth Parameter]
    end

    DR[Deep Research] -->
    SQ[SERP Queries] -->
    PR[Process Results]

    subgraph Results[Results]
        direction TB
        NL((Learnings))
        ND((Directions))
    end

    PR --> NL
    PR --> ND

    DP{depth > 0?}

    RD["Next Direction:
    - Prior Goals
    - New Questions
    - Learnings"]

    MR[Markdown Report]

    %% Main Flow
    Q & B & D --> DR

    %% Results to Decision
    NL & ND --> DP

    %% Circular Flow
    DP -->|Yes| RD
    RD -->|New Context| DR

    %% Final Output
    DP -->|No| MR

    %% Styling
    classDef input fill:#7bed9f,stroke:#2ed573,color:black
    classDef process fill:#70a1ff,stroke:#1e90ff,color:black
    classDef recursive fill:#ffa502,stroke:#ff7f50,color:black
    classDef output fill:#ff4757,stroke:#ff6b81,color:black
    classDef results fill:#a8e6cf,stroke:#3b7a57,color:black

    class Q,B,D input
    class DR,SQ,PR process
    class DP,RD recursive
    class MR output
    class NL,ND results
```

## Persona Agents

**What are Persona Agents?**

In `deep-research`, we utilize the concept of "persona agents" to guide the behavior of the Gemini language models.  Instead of simply prompting the LLM with a task, we imbue it with a specific **role, skills, personality, communication style, and values.** This approach helps to:

* **Focus the LLM's Output:** By defining a clear persona, we encourage the LLM to generate responses that are aligned with the desired expertise and perspective.
* **Improve Consistency:** Personas help maintain a consistent tone and style throughout the research process.
* **Enhance Task-Specific Performance:**  Tailoring the persona to the specific task (e.g., query generation, learning extraction, feedback) optimizes the LLM's output for that stage of the research.

**Examples of Personas in use:**

* **Expert Research Strategist & Query Generator:**  Used for generating search queries, this persona emphasizes strategic thinking, comprehensive coverage, and precision in query formulation.
* **Expert Research Assistant & Insight Extractor:**  When processing web page content, this persona focuses on meticulous analysis, factual accuracy, and extracting key learnings relevant to the research query.
* **Expert Research Query Refiner & Strategic Advisor:**  For generating follow-up questions, this persona embodies strategic thinking, user intent understanding, and the ability to guide users towards clearer and more effective research questions.
* **Professional Doctorate Level Researcher (System Prompt):**  This overarching persona, applied to the main system prompt, sets the tone for the entire research process, emphasizing expert-level analysis, logical structure, and in-depth investigation.

By leveraging persona agents, `deep-research` aims to achieve more targeted, consistent, and high-quality research outcomes from the Gemini language models.

## How It Works

Core modules:

* `src/deep-research.ts` — orchestrates queries, batching, analysis, and synthesis
  * `generateSerpQueries()` uses Gemini to propose SERP-style queries from your prompt and prior learnings
  * `processSerpResult()` splits content, batches Gemini calls with tools enabled, extracts learnings and citations
  * `conductResearch()` runs analysis passes over semantic chunks
  * `writeFinalReport()` builds the final professional Markdown report
* `src/ai/providers.ts` — GoogleGenAI wrapper for Gemini 2.5 Flash, batching, token control, optional tools
* `src/ai/text-splitter.ts` — RecursiveCharacter and Semantic splitters
* `src/mcp-server.ts` — MCP server entry point and types
* `src/run.ts` — CLI entry point

Pipeline highlights:

* Structured JSON outputs validated with Zod
* Concurrency-limited batching (`generateBatch`, `generateBatchWithTools`)
* LRU caches for prompts, SERP proposals, and reports
* Optional Gemini tools via flags: Google Search Grounding, Code Execution, Functions

## Project Structure

```text
deep-research-mcp-server/
├─ src/
│  ├─ ai/
│  │  ├─ providers.ts           # Gemini wrapper, tools, batching, caching
│  │  └─ text-splitter.ts       # Semantic/recursive splitters
│  ├─ mcp-server.ts             # MCP server entry/types
│  ├─ deep-research.ts          # Orchestrator: queries → analysis → synthesis
│  ├─ prompt.ts                 # System + templates
│  ├─ feedback.ts               # Refinement/feedback loop
│  ├─ output-manager.ts         # Report/output formatting
│  ├─ progress-manager.ts       # CLI progress
│  ├─ terminal-utils.ts         # CLI helpers
│  ├─ types.ts                  # Zod schemas/types
│  └─ utils/                    # JSON/sanitize helpers
├─ dist/                        # Build output
├─ .env.example                 # Environment template
├─ package.json                 # Scripts/deps
└─ README.md
```

## Requirements

* [Node.js](https://nodejs.org/) v22.x
* [Google Gemini API key](https://makersuite.google.com/app/apikey)

## Setup

### Node.js

1. **Clone the repository:**

    ```bash
    git clone [your-repo-link-here]
    ```

2. **Install dependencies:**

    ```bash
    npm install
    ```

3. **Set up environment variables:** Create a `.env.local` file in the project root:

    ```bash
    # Required
    GEMINI_API_KEY="your_gemini_key"

    # Recommended defaults
    GEMINI_MODEL=gemini-2.5-flash
    GEMINI_MAX_OUTPUT_TOKENS=65536
    CONCURRENCY_LIMIT=5

    # Gemini tools (enable as needed)
    ENABLE_GEMINI_GOOGLE_SEARCH=true
    ENABLE_GEMINI_CODE_EXECUTION=false
    ENABLE_GEMINI_FUNCTIONS=false
    ```

4. **Build the project:**

    ```bash
    npm run build
    ```

## Usage

### As MCP Tool

To run `deep-research` as an MCP tool, start the MCP server:

```bash
node --env-file .env.local dist/mcp-server.js
```

You can then invoke the `deep-research` tool from any MCP-compatible agent using the following parameters:

* `query` (string, required): The research query.
* `depth` (number, optional, 1-5): Research depth (default: moderate).
* `breadth` (number, optional, 1-5): Research breadth (default: moderate).
* `existingLearnings` (string[], optional):  Pre-existing research findings to guide research.

**Example MCP Tool Arguments (JSON shape):**

```json
{
  "name": "deep-research",
  "arguments": {
    "query": "State of multi-agent research agents in 2025",
    "depth": 3,
    "breadth": 3,
    "existingLearnings": [
      "Tool use improves grounding",
      "Batching reduces latency"
    ]
  }
}
```

```typescript
const mcp = new ModelContextProtocolClient(); // Assuming MCP client is initialized

async function invokeDeepResearchTool() {
  try {
    const result = await mcp.invoke("deep-research", {
      query: "Explain the principles of blockchain technology",
      depth: 2,
      breadth: 4
    });

    if (result.isError) {
      console.error("MCP Tool Error:", result.content[0].text);
    } else {
      console.log("Research Report:\n", result.content[0].text);
      console.log("Sources:\n", result.metadata.visitedUrls);
    }
  } catch (error) {
    console.error("MCP Invoke Error:", error);
  }
}

invokeDeepResearchTool();
```

### Standalone CLI Usage

To run `deep-research` directly from the command line:

```bash
npm run start "your research query"
```

**Example:**

```bash
npm run start "what are latest developments in ai research agents"
```

### MCP Inspector Testing

For interactive testing and debugging of the MCP server, use the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector node --env-file .env.local dist/mcp-server.js
```

### MCP Integration Tips

* **Environment**: Provide `GEMINI_API_KEY` to the MCP server process; model and tool flags via env.
* **Stateless calls**: The server derives behavior from env; keep flags in sync with your client profile.
* **Latency**: Enable batching and reasonable `CONCURRENCY_LIMIT` to balance speed vs rate limits.

## Deployment Modes

The server supports two deployment modes:

### Local Mode (stdio)

For Claude Code, Gemini CLI, and other local MCP clients:

```bash
node --env-file .env.local dist/mcp-server.js
```

**Behavior:**
- The runner always writes the full report to `deep_research_report_<timestamp>.md` in the
  directory the server was launched from (never overwriting an existing file).
- The response text (the `## 🚀 RESEARCH COMPLETE` heading plus the report) is measured in
  UTF-8 bytes. At or below `MCP_STDIO_INLINE_MAX_BYTES` (default 32768) the report is
  returned inline. Above it, the response is a compact envelope (at most 16 KiB) carrying the
  absolute report path, exact byte size, learning and source counts, provider/agent, elapsed
  time, a short excerpt of the report's headings, and the instruction to read the file.
- If the report file cannot be written or verified, the full report is returned inline with
  a visible warning and `metadata.persistWarning`, regardless of size.
- Nothing is uploaded in stdio mode. See [Report Delivery](#report-delivery) for the rules.

### HTTP Mode (Cloud Run / Remote)

For Codex and other remote MCP clients:

```bash
# Set environment variable
export MCP_HTTP_MODE=true

# Or deploy to Cloud Run
gcloud run deploy deep-research-mcp \
  --source . \
  --region=us-central1 \
  --allow-unauthenticated \
  --set-env-vars="MCP_HTTP_MODE=true,GEMINI_API_KEY=xxx,MCP_API_KEY=xxx,AZURE_STORAGE_ACCOUNT_NAME=xxx,AZURE_STORAGE_CONTAINER_NAME=research-reports"
```

**Behavior:**
- Reports of 50 KB or less are returned inline; larger reports are uploaded to Azure Blob
  Storage and the response carries a read-only SAS URL (7-day expiry) with a curl download
  command. Local report paths are never exposed over HTTP.
- `MCP_STDIO_INLINE_MAX_BYTES` is ignored in HTTP mode.
- API key authentication via `x-api-key` header

**Endpoints:**
- `POST /mcp` - MCP protocol endpoint
- `GET /health` - Health check
- `GET /sse` - SSE transport (alternative to StreamableHTTP)

## Azure Blob Storage Integration (HTTP mode only)

In HTTP mode, reports larger than 50 KB are uploaded to Azure Blob Storage and delivered as
a read-only SAS URL. Authentication uses `DefaultAzureCredential` (managed identity in Azure
Container Apps; `az login` or `AZURE_CLIENT_ID`/`AZURE_CLIENT_SECRET`/`AZURE_TENANT_ID`
locally). The identity needs the **Storage Blob Data Contributor** role on the container and
permission to request a user delegation key.

```bash
export AZURE_STORAGE_ACCOUNT_NAME=your-storage-account
export AZURE_STORAGE_CONTAINER_NAME=research-reports   # default
```

If the account is not configured or the upload fails, the HTTP response still arrives but
its URL field reads `ERROR: Failed to upload report to cloud storage`; the report text is
not included. Stdio mode never uploads anything.

## Report Delivery

How the full report reaches the client depends on the transport and the size of the
response text:

| Response text | stdio mode | HTTP mode |
|---------------|------------|-----------|
| ≤ `MCP_STDIO_INLINE_MAX_BYTES` (default 32768 bytes) | Inline | Inline if ≤ 50 KB |
| > `MCP_STDIO_INLINE_MAX_BYTES` | File envelope (path + metadata) | Azure SAS URL if > 50 KB |

The stdio limit is measured in UTF-8 bytes of the complete text item (heading plus report),
so multi-byte characters count more than once. A response exactly at the limit stays inline.

### `MCP_STDIO_INLINE_MAX_BYTES`

- Unset or blank: default `32768`.
- A trimmed string of decimal digits is accepted as a nonnegative safe integer. `0` forces the
  file envelope for every nonempty report.
- Anything else (negative, fractional, units, hex, junk, or above `Number.MAX_SAFE_INTEGER`)
  makes every tool call return an `invalid_config` error before any research is started. The
  rejected value is never echoed to the client or the log.
- Ignored in HTTP mode.

### File envelope (stdio)

The envelope is a single text item that begins with `## 🚀 RESEARCH COMPLETE` and is capped at
16 KiB. It contains the JSON-quoted absolute path of the report, the exact size in bytes
(plus rounded KiB), the learning and source counts, provider and agent, elapsed time, the
sentence "Read this local Markdown file for the complete report.", and an excerpt of up to
1,200 bytes built from the report's first headings. `metadata` carries `reportPath`,
`reportSizeBytes`, `learnings`, `visitedUrls`, `provider`, `agent` and `elapsedMs`. When the
learnings and source arrays would push the envelope past 16 KiB they are replaced with empty
arrays, `metadata.metadataTruncated` is set to `true`, and the text says so; the complete
lists are still in the report file.

Clients that should read the report (Claude Code, Gemini CLI, Codex) must have access to
the directory the server was launched from. The server does not delete report files; prune
`deep_research_report_*.md` yourself.

### Recovery and cache rules

- Only the path the research runner produced is trusted. It must be absolute, contain no
  control characters, sit directly in the launch directory, and refer to a regular file whose
  size matches the report. Anything else is treated as unavailable.
- If the file cannot be written (`persistWarning`) or fails verification, the full report is
  returned inline, prefixed with `Warning: report file unavailable; the complete report is
  included below.`, with `metadata.persistWarning` set and no `reportPath`. This happens even
  when the report exceeds the inline limit.
- An empty report is an `empty_report` error. A missing report with no file is `persist_failed`.
- Successful results are cached for 24 hours. A cached file-envelope result is revalidated on
  every hit; if the file has since been removed or changed, the entry is evicted and the call
  returns a `persist_failed` error (with `isError: true`) saying the research was not rerun.
  Submit the request again to regenerate it. Errors are never cached.
- All classified error envelopes carry `isError: true` on both transports.

### Progress

- Clients that send `_meta.progressToken` receive standard `notifications/progress` on both
  transports.
- Stdio clients without a token receive `notifications/message` log notifications
  (`level: "info"`, `logger: "deep-research"`, data `{ requestId, stage, elapsedMs, message }`):
  `starting` immediately, a heartbeat every 30 seconds, and one terminal message. The server
  advertises the `logging` capability and honours `logging/setLevel`; set the level above
  `info` to silence them. HTTP clients without a token receive nothing.
- Notification bodies never contain the query, provider text, or URLs.

### Offline smoke test

Exercises the stdio transport end to end with a fake research runner and no API key:

```bash
node --import tsx --test --test-name-pattern='offline stdio smoke' src/server.test.ts
```

## Configuration

### Required

| Variable | Description |
|----------|-------------|
| `GEMINI_API_KEY` | Google Gemini API key |

### Gemini Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `GEMINI_MODEL` | `gemini-2.5-flash` | Gemini model to use |
| `GEMINI_MAX_OUTPUT_TOKENS` | `65536` | Maximum output tokens |
| `CONCURRENCY_LIMIT` | `5` | Concurrent API calls |
| `ENABLE_GEMINI_GOOGLE_SEARCH` | `false` | Enable Google Search Grounding |
| `ENABLE_GEMINI_CODE_EXECUTION` | `false` | Enable code execution tool |
| `ENABLE_GEMINI_FUNCTIONS` | `false` | Enable function calling |

### Server Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_HTTP_MODE` | `false` | Enable HTTP transport (for Cloud Run) |
| `MCP_API_KEY` | (none) | API key for HTTP authentication |
| `PORT` | `8080` | HTTP server port |

### Storage and Delivery Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_STDIO_INLINE_MAX_BYTES` | `32768` | stdio only. UTF-8 byte limit for inline reports; larger responses become a file envelope. `0` forces file mode; invalid values make every call fail with `invalid_config`. |
| `AZURE_STORAGE_ACCOUNT_NAME` | (none) | HTTP only. Storage account for reports over 50 KB. |
| `AZURE_STORAGE_CONTAINER_NAME` | `research-reports` | HTTP only. Blob container for uploaded reports. |

Optional providers (planned/behind flags): Exa/Tavily can be integrated later; Firecrawl is not required for the current pipeline.

## Quickstart

1) Clone and install

```bash
git clone https://github.com/ssdeanx/deep-research-mcp-server
cd deep-research-mcp-server
npm i && npm run build
```

2) Create `.env.local` (see [Setup](#setup))

3) Run as MCP server (Inspector)

```bash
npx @modelcontextprotocol/inspector node --env-file .env.local dist/mcp-server.js
```

4) Or run as CLI

```bash
npm run start "state of multi-agent research agents in 2025"
```

## Example Output

```markdown
# Abstract
Concise overview of the research goal, scope, method, and key findings.

# Table of Contents
...

# Introduction
Context and framing.

# Body
Evidence-backed sections with citations.

# Methodology
How sources were found and analyzed.

# Limitations
Assumptions and risks.

# Key Learnings
Bulleted insights and takeaways.

# References
Normalized citations to visited URLs.
```

## Support

* **Issues:** Use GitHub Issues for bugs and feature requests.
* **Discussions:** Propose ideas or ask questions.
* **Security:** Do not file public issues for sensitive disclosures; contact maintainers privately.

## Contributing

* **PRs welcome:** Please open an issue first for significant changes.
* **Standards:** TypeScript 5.x, Node.js 22.x, lint/type-check before PRs.
* **Checks:** `npm run build` and `tsc --noEmit` must pass.
* **Docs:** Update `README.md` and `.env.example` when changing env/config.

## Roadmap

* **Exa search integration** (behind `ENABLE_EXA_PRIMARY`), Google grounding for augmentation.
* **Provider cleanup:** Remove Firecrawl after Exa migration (explicit approval required).
* **CI/CD:** Add GitHub Actions for build/lint/test and badge.
* **Examples:** Add sample reports and prompts.

## Troubleshooting

* **Missing API key**: Ensure `GEMINI_API_KEY` is set in `.env.local` and processes are started with `--env-file .env.local`.
* **Model/tool flags**: If grounding or functions aren’t active, verify `ENABLE_GEMINI_GOOGLE_SEARCH`, `ENABLE_GEMINI_CODE_EXECUTION`, `ENABLE_GEMINI_FUNCTIONS`.
* **Rate limits/latency**: Lower `CONCURRENCY_LIMIT` (e.g., 3) or rerun with fewer simultaneous queries.
* **Output too long**: Reduce depth/breadth or lower `GEMINI_MAX_OUTPUT_TOKENS`.
* **Schema parse errors**: Rerun; the pipeline validates/repairs JSON, but extreme prompts may exceed budgets—trim prompt or reduce chunk size.

## License

[MIT License](LICENSE) - Free and Open Source. Use it freely!

---

## **🚀 Let's dive deep into research! 🚀**

## Recent Improvements (v0.3.0)

> ✨ Highlights of the latest changes. See also [Roadmap](#roadmap).

<details>
  <summary><strong>🧪 Enhanced Research Validation</strong></summary>

* ✅ Input validation: Minimum 10 characters + 3 words
* 📈 Output validation: Citation density (1.5+ per 100 words)
* 🔍 Recent sources check (3+ post-2019 references)
* ⚖️ Conflict disclosure enforcement
</details>

<details>
  <summary><strong>🧠 Gemini Integration Upgrades</strong></summary>

* Consolidated on Gemini 2.5 Flash (long-context, structured JSON)
* Optional tools via env flags: Search Grounding, Code Execution, Functions
* Semantic + recursive splitting for context management
* Robust batching with concurrency control and caching
* Enhanced context management via semantic search
* Improved error handling and logging

</details>

<details>
  <summary><strong>🧹 Code Quality Improvements</strong></summary>

* 🚀 Added concurrent processing pipeline
* Removed redundant academic-validators module
* 🛡️ Enhanced type safety across interfaces
* 📦 Optimized dependencies (≈30% smaller node_modules)

</details>

<details>
  <summary><strong>🆕 New Features</strong></summary>

* 📊 Research metrics tracking (sources/learnings ratio)

</details>
* 📑 Auto-generated conflict disclosure statements
* 🔄 Recursive research depth control (1-5 levels)
* 📈 Research metrics tracking (sources/learnings ratio)
* 🤖 MCP tool integration improvements

**Performance:**

* 🚀 30% faster research cycles
* ⚡ 40% faster initial research cycles
* 📉 60% reduction in API errors
* 🧮 25% more efficient token usage
