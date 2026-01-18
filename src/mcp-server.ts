import * as fs_node from 'node:fs';
import * as path_node from 'node:path';
import { config } from 'dotenv';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import { research, writeFinalReport, type ResearchProgress, type ResearchOptions } from "./deep-research.js";
import { LRUCache } from 'lru-cache';
import { logger } from './logger.js';
import express, { Request, Response, NextFunction } from 'express';
import { Storage } from '@google-cloud/storage';


// Get the directory name of the current module
const __dirname = fileURLToPath(new URL('.', import.meta.url));

// Load environment variables from .env.local
config({ path: resolve(__dirname, '../.env.local') });

// Log environment variables for debugging (excluding sensitive values)
logger.info({ env: {
  hasGeminiKey: !!process.env.GEMINI_API_KEY,
}}, 'Environment check');

// GCS configuration for storing full reports
const GCS_BUCKET_NAME = process.env.GCS_BUCKET_NAME || 'deep-research-reports-gen-lang-client-0824947382';
const storage = new Storage();

async function uploadReportToGCS(content: string, query: string): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const sanitizedQuery = query.slice(0, 50).replace(/[^a-zA-Z0-9]/g, '_');
  const filename = `reports/${sanitizedQuery}_${timestamp}.md`;

  const bucket = storage.bucket(GCS_BUCKET_NAME);
  const file = bucket.file(filename);

  await file.save(content, {
    contentType: 'text/markdown',
    metadata: {
      query: query,
      generatedAt: new Date().toISOString(),
    },
  });

  // Generate a signed URL valid for 7 days
  const [signedUrl] = await file.getSignedUrl({
    action: 'read',
    expires: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
  });

  logger.info({ filename, bucket: GCS_BUCKET_NAME }, 'Report uploaded to GCS');
  return signedUrl;
}

// Change the interface name in mcp-server.ts to avoid conflict
interface MCPResearchResult {
    content: { type: "text"; text: string; }[];
    metadata: {
        learnings: string[];
        visitedUrls: string[];
        stats: {
            totalLearnings: number;
            totalSources: number;
        };
        reportUrl?: string;
        reportSizeKB?: number;
    };
    [key: string]: unknown;
}

// Update cache definition with TTL aligned to provider
const MCP_CACHE_TTL_MS = Math.max(1000, Math.min(86_400_000, parseInt(process.env.PROVIDER_CACHE_TTL_MS || '600000', 10)));
const deepResearchCache = new LRUCache<string, MCPResearchResult>({
  max: 50,
  ttl: MCP_CACHE_TTL_MS,
});

function hashKey(obj: unknown): string {
  try {
    return createHash('sha256').update(JSON.stringify(obj)).digest('hex');
  } catch {
    return String(obj);
  }
}

// Factory function to create a new MCP server instance
function createServer(): McpServer {
  const server = new McpServer({
    name: "deep-research",
    version: "1.0.0"
  });

  // Define the deep research tool (modern API)
  server.registerTool(
    "deepResearch.run",
    {
      title: "Deep Research",
      description: "Gemini-only deep research pipeline (Google Search grounding + URL context).",
      inputSchema: {
        query: z.string().min(1).describe("The research query to investigate"),
        depth: z.number().min(1).max(5).optional().describe("How deep to go in the research tree (1-5)"),
        breadth: z.number().min(1).max(5).optional().describe("How broad to make each research level (1-5)"),
        existingLearnings: z.array(z.string()).optional().describe("Optional learnings to build upon"),
        goal: z.string().optional().describe("Optional goal/brief to steer synthesis"),
        flags: z.object({ grounding: z.boolean().optional(), urlContext: z.boolean().optional() }).optional(),
      }
    },
    async ({ query, depth, breadth, existingLearnings = [] }): Promise<MCPResearchResult> => {
      // 1. Create cache key
      const cacheKey = hashKey({ query, depth, breadth, existingLearnings });

      // 2. Check cache
      const cachedResult = deepResearchCache.get(cacheKey);
      if (cachedResult) {
        logger.info({ key: cacheKey.slice(0,8), query }, '[mcp-cache] HIT');
        return cachedResult;
      } else {
        logger.info({ key: cacheKey.slice(0,8), query }, '[mcp-cache] MISS');
      }

      try {
        logger.info({ query }, 'Starting research');
        const result = await research({
          query,
          depth: depth ?? 2,
          breadth: breadth ?? 2,
          existingLearnings: existingLearnings,
          onProgress: (progress: ResearchProgress) => {
             // Simple progress log
             const msg = `Researching: ${progress.currentQuery || '...'}`;
             logger.info({ progress }, msg);
          }
        } as ResearchOptions);

        logger.info({ query }, 'Research completed.');

        // CRITICAL FIX: Use the content directly from the research result
        // The research() function now returns the full report in 'content' (if using our custom engine)
        // or we read it from the file it saved.

        let reportContent = (result as any).content;

        if (!reportContent && result.reportPath) {
            // Fallback: Read the file if content wasn't returned in memory
            try {
              reportContent = fs_node.readFileSync(result.reportPath, 'utf-8');
            } catch (e) {
              reportContent = "Error reading report file.";
            }
        }

        if (!reportContent) {
            reportContent = "# Error: No report content generated.";
        }

        const reportSizeKB = Math.round(Buffer.byteLength(reportContent, 'utf8') / 1024);
        const isHttpMode = process.env.MCP_HTTP_MODE === 'true';

        // Size threshold for auto-switching to URL mode (50KB)
        const SIZE_THRESHOLD_KB = 50;
        const useUrlMode = isHttpMode || reportSizeKB > SIZE_THRESHOLD_KB;

        let finalResult: MCPResearchResult;

        if (useUrlMode) {
          // URL mode: Upload to GCS and return URL with download instructions
          // Used for HTTP mode OR when report exceeds size threshold
          let reportUrl = '';

          try {
            reportUrl = await uploadReportToGCS(reportContent, query);
            const reason = isHttpMode ? 'http' : 'size-threshold';
            logger.info({ reportUrl, reportSizeKB, mode: reason }, 'Report uploaded successfully');
          } catch (gcsError) {
            logger.error({ err: gcsError }, 'Failed to upload report to GCS');
            reportUrl = 'ERROR: Failed to upload report to cloud storage';
          }

          // Generate a suggested filename from the query
          const suggestedFilename = query.slice(0, 40).replace(/[^a-zA-Z0-9]/g, '_').toLowerCase() + '_report.md';

          const sizeNote = !isHttpMode
            ? `\n\n> **Note:** Report size (${reportSizeKB} KB) exceeds ${SIZE_THRESHOLD_KB} KB threshold, using URL mode for reliability.`
            : '';

          finalResult = {
            content: [
              {
                type: "text",
                text: `## 🚀 RESEARCH COMPLETE

**Report Size:** ${reportSizeKB} KB
**Full Report URL:** ${reportUrl}${sizeNote}

---

## ⚠️ ACTION REQUIRED: Download and save the full report

The complete report (${reportSizeKB} KB) has been uploaded to cloud storage.

**You MUST download and save it locally:**

\`\`\`bash
curl -L '${reportUrl}' -o ${suggestedFilename}
\`\`\`

**Suggested filename:** \`${suggestedFilename}\`

---

Download the file above to get the complete research output.`
              }
            ],
            metadata: {
              learnings: result.learnings,
              visitedUrls: result.visitedUrls,
              stats: {
                totalLearnings: result.learnings.length,
                totalSources: result.visitedUrls.length
              },
              reportUrl: reportUrl,
              reportSizeKB: reportSizeKB
            }
          };
        } else {
          // Inline mode: Return full content directly (stdio mode + small report)
          logger.info({ reportSizeKB, mode: 'stdio-inline' }, 'Returning full report content inline');

          finalResult = {
            content: [
              {
                type: "text",
                text: `## 🚀 RESEARCH COMPLETE\n\n${reportContent}`
              }
            ],
            metadata: {
              learnings: result.learnings,
              visitedUrls: result.visitedUrls,
              stats: {
                totalLearnings: result.learnings.length,
                totalSources: result.visitedUrls.length
              },
              reportSizeKB: reportSizeKB
            }
          };
        }

        // Store in cache
        deepResearchCache.set(cacheKey, finalResult);

        return finalResult;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error({ err: errorMessage }, 'Error during deep research');
        return {
          content: [{ type: "text", text: `Error during deep research: ${errorMessage}` }],
          metadata: { learnings: [], visitedUrls: [], stats: { totalLearnings: 0, totalSources: 0 } }
        } as MCPResearchResult;
      }
    }
  );

  // Expose capabilities as a simple resource (Gemini-only flags)
  server.registerResource(
    "capabilities",
    "mcp://capabilities",
    {
      title: "Server Capabilities",
      description: "Feature flags and environment info",
      mimeType: "application/json"
    },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        text: JSON.stringify({
          name: "deep-research",
          version: "1.0.0",
          geminiModel: process.env.GEMINI_MODEL || "gemini-2.5-flash",
          googleSearchEnabled: (process.env.ENABLE_GEMINI_GOOGLE_SEARCH || 'true').toLowerCase() === 'true',
          urlContextEnabled: (process.env.ENABLE_URL_CONTEXT || 'true').toLowerCase() === 'true',
          functionsEnabled: (process.env.ENABLE_GEMINI_FUNCTIONS || 'false').toLowerCase() === 'true',
          codeExecEnabled: (process.env.ENABLE_GEMINI_CODE_EXECUTION || 'false').toLowerCase() === 'true',
          providerCacheTtlMs: MCP_CACHE_TTL_MS,
        })
      }]
    })
  );

  return server;
}

// API Key authentication middleware
function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  const apiKey = process.env.MCP_API_KEY;
  if (!apiKey) {
    // No API key configured = no auth required (development mode)
    next();
    return;
  }

  const providedKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  if (providedKey !== apiKey) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

// Start the MCP server
const isHttpMode = process.env.MCP_HTTP_MODE === 'true';

if (isHttpMode) {
  // HTTP mode for remote access (Azure Container Apps, Cloud Run, etc.)
  // Using stateless pattern - each request gets a fresh server instance
  const app = express();
  const port = parseInt(process.env.PORT || '8080', 10);

  app.use(express.json());

  // Health check endpoint (no auth required)
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', mode: 'http', version: '1.0.0' });
  });

  // MCP endpoint - POST only (stateless pattern from SDK example)
  app.post('/mcp', apiKeyAuth, async (req, res) => {
    // Create fresh server instance per request (SDK pattern)
    const server = createServer();

    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // Stateless mode
        enableJsonResponse: true, // Return JSON instead of SSE for better client compatibility
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);

      res.on('close', () => {
        transport.close();
        server.close();
      });
    } catch (error) {
      logger.error({ err: error }, 'Error handling MCP request');
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  // Reject other methods on /mcp
  app.get('/mcp', (_req, res) => {
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
  });

  app.delete('/mcp', (_req, res) => {
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
  });

  // SSE transport for clients that don't support StreamableHTTP (e.g., Claude Code)
  const sseTransports = new Map<string, SSEServerTransport>();

  app.get('/sse', apiKeyAuth, (req, res) => {
    logger.info('SSE connection established');
    const transport = new SSEServerTransport('/messages', res);
    const sessionId = randomUUID();
    sseTransports.set(sessionId, transport);

    const server = createServer();
    server.connect(transport).catch((err) => {
      logger.error({ err }, 'SSE server connection error');
    });

    res.on('close', () => {
      logger.info({ sessionId }, 'SSE connection closed');
      sseTransports.delete(sessionId);
      transport.close();
      server.close();
    });
  });

  app.post('/messages', apiKeyAuth, async (req, res) => {
    const sessionId = req.query.sessionId as string;
    const transport = sseTransports.get(sessionId);
    if (!transport) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    await transport.handlePostMessage(req, res, req.body);
  });

  app.listen(port, () => {
    logger.info({ port, mode: 'http' }, `MCP server running on port ${port}`);
  });
} else {
  // stdio mode for local CLI usage
  const server = createServer();
  const transport = new StdioServerTransport();
  server.connect(transport)
    .then(() => { logger.info({ mode: 'stdio' }, 'MCP server running'); })
    .catch((err: Error) => { logger.error({ err }, 'MCP server error'); });
}
