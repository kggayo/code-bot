import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCore } from '../core/boot.ts';
import type { StartedCore } from '../core/boot.ts';
import { acquireInstance } from '../core/instance.ts';
import { errorMessage } from '../core/util.ts';
import { CODE_BOT_VERSION } from '../core/version.ts';
import { DEFAULT_PORT, startHttp } from './server.ts';
import type { HttpServer } from './server.ts';

/**
 * `code-bot serve`: the whole orchestrator in one process without a window,
 * reachable from this machine over HTTP on 127.0.0.1 with the token in the
 * data folder. It takes the data folder's lock first (src/core/instance.ts),
 * so it never runs next to the desktop app on the same database.
 */

export const TOKEN_FILE = 'api-token';

/** The API token: made at the first start, readable only by this OS user. */
export function ensureToken(dataDir: string): string {
  const path = join(dataDir, TOKEN_FILE);
  if (existsSync(path)) {
    if (process.platform !== 'win32' && (statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600);
    const token = readFileSync(path, 'utf8').trim();
    if (token.length >= 32) return token;
  }
  const token = randomBytes(32).toString('base64url');
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  return token;
}

export function readToken(dataDir: string): string | null {
  try {
    const token = readFileSync(join(dataDir, TOKEN_FILE), 'utf8').trim();
    return token || null;
  } catch {
    return null;
  }
}

export function portFrom(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`"${value}" is not a port number`);
  return port;
}

export interface ServeOptions {
  userData: string;
  port?: number;
  fakeModels?: boolean;
  enableMockEngine?: boolean;
  claudeExecutable?: string;
  log?: (line: string) => void;
}

export interface RunningServer {
  port: number;
  started: StartedCore;
  /** Stops the HTTP server and the core (sub-agents stay resumable), then frees the data folder. */
  stop(): Promise<void>;
  /** Settles once stopped, also after POST /server/stop. */
  stopped: Promise<void>;
}

export async function runServer(options: ServeOptions): Promise<RunningServer> {
  const log = options.log ?? ((line: string) => console.log(line));
  const dataDir = join(options.userData, 'data');
  const lock = acquireInstance(dataDir, 'server', CODE_BOT_VERSION);
  let started: StartedCore | undefined;
  let http: HttpServer | undefined;
  let stopping: Promise<void> | undefined;
  let markStopped: () => void = () => {};
  const stopped = new Promise<void>((resolve) => {
    markStopped = resolve;
  });

  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      await http?.close().catch((error: unknown) => log(`code-bot: closing the HTTP server failed: ${errorMessage(error)}`));
      await started?.core.shutdown().catch((error: unknown) => log(`code-bot: shutdown failed: ${errorMessage(error)}`));
      started?.store.close();
      lock.release();
      markStopped();
    })();
    return stopping;
  };

  try {
    const token = ensureToken(dataDir);
    started = createCore({
      userData: options.userData,
      fakeModels: options.fakeModels,
      enableMockEngine: options.enableMockEngine,
      claudeExecutable: options.claudeExecutable,
    });
    http = await startHttp({
      core: started.core,
      info: started.info,
      token,
      port: options.port ?? DEFAULT_PORT,
      onStop: () => {
        log('code-bot: stopping (asked over HTTP)');
        void stop();
      },
    });
  } catch (error) {
    await stop();
    throw error;
  }
  lock.update({ port: http.port });
  return { port: http.port, started, stop, stopped };
}
