import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { CodeBotError } from './util.ts';

/**
 * One core per data folder. The desktop app and the headless server both take
 * this lock before opening the database: two cores on one database would both
 * run routines, both resume sub-agents and overwrite each other's state.
 * The file also tells terminals where the server listens.
 */

export type InstanceKind = 'desktop' | 'server';

export interface InstanceInfo {
  pid: number;
  kind: InstanceKind;
  /** The headless server's port on 127.0.0.1; null for the desktop app (it has no listener). */
  port: number | null;
  version: string;
  startedAt: string;
}

export const INSTANCE_FILE = 'instance.json';

/** Whether a process with this id exists (EPERM: it exists, under another user). */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parse(text: string): InstanceInfo | null {
  try {
    const value = JSON.parse(text) as Partial<InstanceInfo>;
    if (typeof value.pid !== 'number' || (value.kind !== 'desktop' && value.kind !== 'server')) return null;
    return {
      pid: value.pid,
      kind: value.kind,
      port: typeof value.port === 'number' ? value.port : null,
      version: String(value.version ?? ''),
      startedAt: String(value.startedAt ?? ''),
    };
  } catch {
    return null;
  }
}

/** The code-bot that holds the data folder, if one is running. */
export function readInstance(dataDir: string): InstanceInfo | null {
  let text: string;
  try {
    text = readFileSync(join(dataDir, INSTANCE_FILE), 'utf8');
  } catch {
    return null;
  }
  const info = parse(text);
  return info && processAlive(info.pid) ? info : null;
}

export function describeInstance(info: InstanceInfo): string {
  return info.kind === 'server'
    ? `code-bot is running headless in this data folder (process ${info.pid}, port ${info.port ?? 'unknown'}). Stop it with "code-bot stop" first.`
    : `The code-bot desktop app is using this data folder (process ${info.pid}). Close it first.`;
}

export class InstanceLock {
  readonly path: string;
  private info: InstanceInfo;
  private released = false;

  constructor(path: string, info: InstanceInfo) {
    this.path = path;
    this.info = info;
  }

  get current(): InstanceInfo {
    return this.info;
  }

  /** Records a change, such as the port once the server listens. */
  update(patch: Partial<Pick<InstanceInfo, 'port'>>): void {
    this.info = { ...this.info, ...patch };
    writeFileSync(this.path, `${JSON.stringify(this.info, null, 2)}\n`);
  }

  /** Removes the file, if it is still ours. */
  release(): void {
    if (this.released) return;
    this.released = true;
    try {
      const holder = parse(readFileSync(this.path, 'utf8'));
      if (holder?.pid === this.info.pid) unlinkSync(this.path);
    } catch {
      // Already gone.
    }
  }
}

/**
 * Takes the data folder for this process. Throws a `conflict` CodeBotError
 * naming the other code-bot when one runs; takes over a lock whose process is gone.
 */
export function acquireInstance(dataDir: string, kind: InstanceKind, version: string): InstanceLock {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, INSTANCE_FILE);
  const info: InstanceInfo = { pid: process.pid, kind, port: null, version, startedAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 3; attempt++) {
    let fd: number;
    try {
      fd = openSync(path, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let holder: InstanceInfo | null = null;
      try {
        holder = parse(readFileSync(path, 'utf8'));
      } catch {
        // Removed in the meantime: try again.
      }
      // A live holder keeps it, even this process: one core per data folder, also within a process.
      if (holder && processAlive(holder.pid)) {
        throw new CodeBotError('conflict', `${describeInstance(holder)} (If no code-bot is running, delete ${path}.)`);
      }
      // Left behind by a process that ended without cleaning up, or half written.
      try {
        unlinkSync(path);
      } catch {
        // Someone else removed it.
      }
      continue;
    }
    try {
      writeSync(fd, `${JSON.stringify(info, null, 2)}\n`);
    } finally {
      closeSync(fd);
    }
    const lock = new InstanceLock(path, info);
    process.once('exit', () => lock.release());
    return lock;
  }
  throw new CodeBotError('conflict', `Could not take ${path}; another code-bot may be starting at the same moment.`);
}
