import { join } from 'node:path';
import { readInstance } from '../core/instance.ts';
import type { InstanceInfo } from '../core/instance.ts';
import type { CodeBotApi, CodeBotMethod, CoreEvent } from '../shared/types.ts';
import { readToken } from './serve.ts';
import type { ServerStatus } from './server.ts';

/**
 * A client of the headless server's HTTP API (src/headless/server.ts):
 * `api` implements CodeBotApi over HTTP, and `subscribe` follows the event
 * stream, reconnecting by itself. Used by the terminal client; the desktop
 * window could use the same calls to show a code-bot on another machine.
 */

export class RemoteError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'RemoteError';
    this.code = code;
    this.status = status;
  }
}

export interface Connection {
  url: string;
  token: string;
}

export interface StreamHandlers {
  event(event: CoreEvent): void;
  /** The stream is (again) connected; catch up on anything missed before this. */
  open?(status: ServerStatus): void;
  /** The stream dropped; it reconnects by itself. */
  closed?(error: unknown): void;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class Client {
  readonly url: string;
  readonly api: CodeBotApi;
  private readonly authorization: string;

  constructor(connection: Connection) {
    this.url = connection.url.replace(/\/+$/, '');
    this.authorization = `Bearer ${connection.token}`;
    this.api = new Proxy({} as CodeBotApi, {
      get: (_target, method) => (...args: unknown[]) => this.call(method as CodeBotMethod, args),
    });
  }

  private async request(path: string, body?: unknown, timeoutMs = 120_000): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.url}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: this.authorization, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new RemoteError('unreachable', `code-bot is not answering at ${this.url} (${(error as Error).message})`, 0);
    }
    let parsed: { ok?: boolean; result?: unknown; code?: string; message?: string };
    try {
      parsed = (await response.json()) as typeof parsed;
    } catch {
      throw new RemoteError('internal', `code-bot answered ${response.status} without JSON`, response.status);
    }
    if (!response.ok || !parsed.ok) {
      throw new RemoteError(parsed.code ?? 'internal', parsed.message ?? `code-bot answered ${response.status}`, response.status);
    }
    return parsed.result;
  }

  call(method: CodeBotMethod, args: unknown[]): Promise<unknown> {
    // JSON has no undefined: a left-out optional argument would arrive as null, which the schemas refuse.
    const given = [...args];
    while (given.length && given[given.length - 1] === undefined) given.pop();
    return this.request(`/api/${method}`, given);
  }

  status(timeoutMs = 5000): Promise<ServerStatus> {
    return this.request('/server/status', undefined, timeoutMs) as Promise<ServerStatus>;
  }

  async stop(): Promise<void> {
    await this.request('/server/stop', {});
  }

  /** The command and folder that continue a stopped sub-agent's session in a terminal. */
  launch(taskId: string): Promise<{ command: string; args: string[]; cwd: string }> {
    return this.request('/server/launch', { taskId }) as Promise<{ command: string; args: string[]; cwd: string }>;
  }

  /** Follows the server's events until the returned function is called. */
  subscribe(handlers: StreamHandlers): () => void {
    let closed = false;
    let controller: AbortController | undefined;
    const run = async () => {
      let wait = 500;
      while (!closed) {
        controller = new AbortController();
        try {
          const response = await fetch(`${this.url}/api/events`, {
            headers: { authorization: this.authorization, accept: 'text/event-stream' },
            signal: controller.signal,
          });
          if (!response.ok || !response.body) throw new RemoteError('stream', `The event stream answered ${response.status}`, response.status);
          const decoder = new TextDecoder();
          let buffer = '';
          for await (const chunk of response.body) {
            buffer += decoder.decode(chunk as Uint8Array, { stream: true });
            let end: number;
            while ((end = buffer.indexOf('\n\n')) >= 0) {
              const block = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              const message = parseBlock(block);
              if (!message) continue;
              wait = 500;
              if (message.event === 'ready') handlers.open?.(JSON.parse(message.data) as ServerStatus);
              else handlers.event(JSON.parse(message.data) as CoreEvent);
            }
          }
          if (!closed) handlers.closed?.(new Error('The event stream ended'));
        } catch (error) {
          if (closed) return;
          handlers.closed?.(error);
        }
        await delay(wait);
        wait = Math.min(wait * 2, 5000);
      }
    };
    void run();
    return () => {
      closed = true;
      controller?.abort();
    };
  }
}

/** One server-sent event block: its `event:` name (default "message") and joined `data:` lines; null for comments. */
export function parseBlock(block: string): { event: string; data: string } | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  return data.length ? { event, data: data.join('\n') } : null;
}

export type Found =
  | { kind: 'server'; instance: InstanceInfo; client: Client }
  | { kind: 'starting'; instance: InstanceInfo }
  | { kind: 'desktop'; instance: InstanceInfo }
  | { kind: 'none' };

/** Who runs in a data folder: a headless server (with a client once it listens), the desktop app, or nobody. */
export function findServer(userData: string): Found {
  const dataDir = join(userData, 'data');
  const instance = readInstance(dataDir);
  if (!instance) return { kind: 'none' };
  if (instance.kind === 'desktop') return { kind: 'desktop', instance };
  const token = readToken(dataDir);
  if (!token || !instance.port) return { kind: 'starting', instance };
  return { kind: 'server', instance, client: new Client({ url: `http://127.0.0.1:${instance.port}`, token }) };
}
