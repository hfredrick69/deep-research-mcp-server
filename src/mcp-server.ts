/**
 * Process entry point. Loads `.env.local` first, then imports the server
 * factory and logger so neither reads an environment that is not yet populated.
 * Transport wiring (stdio / Streamable HTTP / SSE) is unchanged.
 */
import process from 'node:process';
import { config } from 'dotenv';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import express, { type Request, type Response } from 'express';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
config({ path: resolve(__dirname, '../.env.local') });

const [{ createServer, apiKeyAuth, describeResearchConfig, SERVER_VERSION }, { logger }] = await Promise.all([
  import('./server.js'),
  import('./logger.js'),
]);

const startupConfig = describeResearchConfig(process.env);
logger.info(
  {
    env: {
      provider: startupConfig.provider,
      agent: startupConfig.agent,
      configProblems: startupConfig.problems,
      hasGeminiKey: !!process.env.GEMINI_API_KEY,
      hasOpenAIKey: !!process.env.OPENAI_API_KEY,
    },
  },
  'Environment check',
);
if (startupConfig.problems.length > 0) {
  logger.warn({ configProblems: startupConfig.problems }, 'Research configuration has problems; tool calls will return invalid_config / missing_key until fixed');
}

if (process.env.MCP_HTTP_MODE === 'true') {
  const app = express();
  const port = parseInt(process.env.PORT || '8080', 10);
  app.use(express.json());

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', mode: 'http', version: SERVER_VERSION });
  });

  app.post('/mcp', apiKeyAuth, async (req: Request, res: Response) => {
    try {
      const server = createServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on('close', () => {
        transport.close();
        server.close();
      });
    } catch (error) {
      logger.error({ err: error }, 'Error handling MCP request');
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  });

  const methodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
  };
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  const sseTransports = new Map<string, SSEServerTransport>();

  app.get('/sse', apiKeyAuth, async (_req: Request, res: Response) => {
    logger.info('SSE connection established');
    const transport = new SSEServerTransport('/messages', res);
    const sessionId = randomUUID();
    sseTransports.set(sessionId, transport);
    const server = createServer();
    server.connect(transport).catch((err: Error) => logger.error({ err }, 'SSE server connection error'));
    res.on('close', () => {
      logger.info({ sessionId }, 'SSE connection closed');
      sseTransports.delete(sessionId);
      transport.close();
      server.close();
    });
  });

  app.post('/messages', apiKeyAuth, async (req: Request, res: Response) => {
    const sessionId = req.query.sessionId as string;
    const transport = sseTransports.get(sessionId);
    if (!transport) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    await transport.handlePostMessage(req, res, req.body);
  });

  app.listen(port, () => logger.info({ port, mode: 'http' }, `MCP server running on port ${port}`));
} else {
  const server = createServer();
  const transport = new StdioServerTransport();
  server
    .connect(transport)
    .then(() => logger.info({ mode: 'stdio' }, 'MCP server running'))
    .catch((err: Error) => logger.error({ err }, 'MCP server error'));
}
