import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeInstance } from '../core/instance.ts';
import { findServer } from './client.ts';
import type { Client } from './client.ts';

/**
 * Starting the headless server in the background, the way tmux starts its
 * server: the first `code-bot` command that needs it starts `code-bot serve`
 * detached (no window on Windows), logging to data/server.log, and waits for it.
 */

export const LOG_FILE = 'server.log';
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;

/** bin/code-bot.cjs: the command that runs code-bot with this Node. */
export function launcherPath(): string {
  return fileURLToPath(new URL('../../bin/code-bot.cjs', import.meta.url));
}

/** How to run code-bot itself again: this Node, the launcher, and the given arguments. */
export function selfCommand(args: string[]): { command: string; args: string[] } {
  return { command: process.execPath, args: [launcherPath(), ...args] };
}

/** The last lines of the server's log, to explain why it did not start. */
export function logTail(userData: string, lines = 15): string {
  try {
    return readFileSync(join(userData, 'data', LOG_FILE), 'utf8').trimEnd().split(/\r?\n/).slice(-lines).join('\n');
  } catch {
    return '';
  }
}

function startInBackground(userData: string, port: number | undefined, env: NodeJS.ProcessEnv): ChildProcess {
  const dataDir = join(userData, 'data');
  mkdirSync(dataDir, { recursive: true });
  const log = join(dataDir, LOG_FILE);
  if (existsSync(log) && statSync(log).size > LOG_ROTATE_BYTES) renameSync(log, `${log}.1`);
  const fd = openSync(log, 'a');
  try {
    const { command, args } = selfCommand(['serve', '--data', userData, ...(port === undefined ? [] : ['--port', String(port)])]);
    const child = spawn(command, args, { detached: true, stdio: ['ignore', fd, fd], windowsHide: true, env, cwd: homedir() });
    child.unref();
    return child;
  } finally {
    closeSync(fd);
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A client for the server of this data folder, starting the server first when none runs. */
export async function ensureServer(
  userData: string,
  options: { port?: number; env?: NodeJS.ProcessEnv; timeoutMs?: number; onStart?: () => void } = {},
): Promise<Client> {
  const found = findServer(userData);
  if (found.kind === 'desktop') throw new Error(describeInstance(found.instance));
  if (found.kind === 'server') {
    try {
      await found.client.status(3000);
      return found.client;
    } catch {
      // Still starting, or stuck: wait below.
    }
  }
  let child: ChildProcess | undefined;
  let exited: number | null = null;
  if (found.kind === 'none') {
    options.onStart?.();
    child = startInBackground(userData, options.port, options.env ?? process.env);
    child.once('exit', (code) => {
      exited = code ?? 1;
    });
  }
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    await delay(200);
    const now = findServer(userData);
    if (now.kind === 'desktop') throw new Error(describeInstance(now.instance));
    if (now.kind === 'server') {
      try {
        await now.client.status(1500);
        return now.client;
      } catch {
        // Not listening yet.
      }
    }
    if (exited !== null) {
      const tail = logTail(userData);
      throw new Error(`code-bot did not start (exit code ${exited}).${tail ? `\n${tail}` : ''}`);
    }
  }
  const tail = logTail(userData);
  throw new Error(
    `code-bot did not answer within ${Math.round((options.timeoutMs ?? 30_000) / 1000)} seconds.${tail ? `\nThe end of ${join(userData, 'data', LOG_FILE)}:\n${tail}` : ''}`,
  );
}
