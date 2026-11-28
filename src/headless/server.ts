import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CodeBot } from '../core/code-bot.ts';
import { callOperation, coreHandlers } from '../core/operations.ts';
import { CodeBotError, errorMessage } from '../core/util.ts';
import type { ErrorCode } from '../core/util.ts';
import type { AppInfo, CoreEvent } from '../shared/types.ts';

/**
 * The headless server's HTTP API: the operations of CodeBotApi and the live
 * event stream, for code-bot's terminal client and (later) the MCP adapter and
 * the desktop window as a remote client. It listens on 127.0.0.1 only and every
 * request needs the token from the data folder; see docs/api.md, "HTTP".
 */

export const DEFAULT_PORT = 7413;
const BODY_LIMIT = 1024 * 1024;
const HEARTBEAT_MS = 15_000;

const STATUS: Record<ErrorCode, number> = { invalid: 400, not_found: 404, conflict: 409, busy: 423 };

export interface ServerStatus {
  version: string;
  pid: number;
  port: number;
  dataDir: string;
  fakeModels: boolean;
  startedAt: string;
  activeSubagents: number;
}

export interface HttpOptions {
  core: CodeBot;
  info: AppInfo;
  token: string;
  /** 0 picks a free port (tests). */
  port: number;
  /** Called by POST /server/stop, after the response is sent. */
  onStop?: () => void;
  heartbeatMs?: number;
}

export interface HttpServer {
  port: number;
  close(): Promise<void>;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body ?? null);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(text);
}

function fail(res: ServerResponse, status: number, code: string, message: string): void {
  send(res, status, { ok: false, code, message });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new CodeBotError('invalid', 'The request is larger than 1 MB'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** A JSON request body; null when empty. */
async function jsonBody(req: IncomingMessage): Promise<unknown> {
  const body = await readBody(req);
  if (!body.trim()) return null;
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
    throw new CodeBotError('invalid', 'Send the body as JSON (content-type: application/json)');
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new CodeBotError('invalid', 'The body is not valid JSON');
  }
}

export function startHttp(options: HttpOptions): Promise<HttpServer> {
  const { core, info } = options;
  const handlers = coreHandlers(core, info);
  const expected = digest(`Bearer ${options.token}`);
  const streams = new Set<ServerResponse>();
  const startedAt = new Date().toISOString();
  let port = options.port;

  const authorised = (req: IncomingMessage): boolean => {
    const header = req.headers.authorization;
    return typeof header === 'string' && timingSafeEqual(digest(header), expected);
  };

  /** Refuses anything a web page could send: a browser always adds Origin to these requests, and a foreign Host means DNS rebinding. */
  const local = (req: IncomingMessage): boolean => {
    if (req.headers.origin !== undefined) return false;
    const host = req.headers.host;
    return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
  };

  const status = (): ServerStatus => ({
    version: info.version,
    pid: process.pid,
    port,
    dataDir: info.dataDir,
    fakeModels: info.fakeModels,
    startedAt,
    activeSubagents: core.activeSubagents(),
  });

  const events = (req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-content-type-options': 'nosniff',
    });
    res.write(`retry: 2000\n\nevent: ready\ndata: ${JSON.stringify(status())}\n\n`);
    const listener = (event: CoreEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    const unsubscribe = core.subscribe(listener);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), options.heartbeatMs ?? HEARTBEAT_MS);
    streams.add(res);
    const done = () => {
      clearInterval(heartbeat);
      unsubscribe();
      streams.delete(res);
    };
    req.on('close', done);
    res.on('error', done);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (!local(req)) return fail(res, 403, 'forbidden', 'Only local programs may call code-bot');
    if (!authorised(req)) return fail(res, 401, 'unauthorized', 'Missing or wrong token');
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

    if (req.method === 'GET' && url.pathname === '/api/events') return events(req, res);
    if (req.method === 'GET' && url.pathname === '/server/status') return send(res, 200, { ok: true, result: status() });
    if (req.method === 'POST' && url.pathname === '/server/stop') {
      send(res, 200, { ok: true, result: null });
      setImmediate(() => options.onStop?.());
      return;
    }
    if (req.method === 'POST' && url.pathname === '/server/launch') {
      // The command that continues a stopped sub-agent's session in a terminal on this machine (the window's "Open in terminal").
      const body = (await jsonBody(req)) as { taskId?: unknown } | null;
      if (!body || typeof body.taskId !== 'string') throw new CodeBotError('invalid', 'Send { "taskId": "t_…" }');
      return send(res, 200, { ok: true, result: core.terminalLaunch(body.taskId) });
    }
    const match = /^\/api\/([A-Za-z]+)$/.exec(url.pathname);
    if (req.method !== 'POST' || !match) return fail(res, 404, 'not_found', `No route ${req.method} ${url.pathname}`);
    const args = (await jsonBody(req)) ?? [];
    if (!Array.isArray(args)) throw new CodeBotError('invalid', 'The body must be the list of arguments, as a JSON array');
    const result = await callOperation(handlers, match[1], args);
    send(res, 200, { ok: true, result: result ?? null });
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof CodeBotError) fail(res, STATUS[error.code], error.code, error.message);
      else fail(res, 500, 'internal', errorMessage(error));
    });
  });
  server.requestTimeout = 0; // the event stream stays open
  server.headersTimeout = 20_000;

  return new Promise((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'EADDRINUSE'
          ? new CodeBotError('conflict', `Port ${options.port} on 127.0.0.1 is in use. Pick another with --port or CODE_BOT_PORT.`)
          : error,
      );
    });
    server.listen(options.port, '127.0.0.1', () => {
      port = (server.address() as AddressInfo).port;
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            for (const stream of streams) stream.end();
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}
