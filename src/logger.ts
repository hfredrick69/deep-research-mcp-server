import process from 'node:process';
import pino from 'pino';

// All log output goes to stderr: in stdio MCP mode stdout carries the JSON-RPC
// stream, and any stray line there corrupts the protocol. The non-pretty
// destination is synchronous so the last lines are not lost if the process
// crashes or is killed by a stall watchdog.
const level = (process.env.LOG_LEVEL || 'info') as pino.LevelWithSilent;
const pretty = (process.env.LOG_PRETTY || 'false').toLowerCase() === 'true';

export const logger = pretty
  ? pino({
      level,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:standard', singleLine: false, destination: 2 },
      },
    })
  : pino({ level }, pino.destination({ dest: 2, sync: true }));

export function redactIfNeeded<T>(obj: T): T | string {
  const redacted = (process.env.PROGRESS_REDACT_BODIES || 'false').toLowerCase() === 'true';
  if (!redacted) return obj;
  return '[REDACTED]';
}
