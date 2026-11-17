import { execFile, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { TaskWorktree } from '../shared/types.ts';
import { CodeBotError } from './util.ts';

/**
 * Git worktrees for sub-agents: each one works on its own branch in its own
 * folder, made from the project folder's current commit, so sub-agents of one
 * project do not edit the same files. Unlike the project bots' `git` tool these
 * commands change the repository (they add worktrees and branches), so they are
 * run by code-bot itself, never on a bot's say-so.
 */

const GIT_OPTIONS = ['-c', 'core.fsmonitor=false', '-c', 'color.ui=never', '--no-pager'];
const GIT_TIMEOUT_MS = 120_000;

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      [...GIT_OPTIONS, ...args],
      { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr).trim().split(/\r?\n/).slice(-3).join(' ') || error.message;
          reject(new CodeBotError('invalid', `git ${args[0]} failed: ${detail}`));
        } else {
          resolvePromise(String(stdout));
        }
      },
    );
  });
}

function gitSync(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', [...GIT_OPTIONS, ...args], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const detail = typeof stderr === 'string' && stderr.trim() ? stderr.trim().split(/\r?\n/).slice(-3).join(' ') : String(error);
    throw new CodeBotError('invalid', `git ${args[0]} failed: ${detail}`);
  }
}

function canonical(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

/** Branch-name-safe words from a title: "Fix the login bug!" → "fix-the-login-bug". */
export function slug(text: string, max = 32): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
}

/**
 * Checks a list of files to copy into new worktrees. Each entry is a path or
 * glob pattern relative to the project folder; nothing may point outside it.
 */
export function cleanWorktreeFiles(entries: unknown): string[] {
  if (entries === undefined || entries === null) return [];
  if (!Array.isArray(entries)) throw new CodeBotError('invalid', 'Files to copy must be a list');
  const clean: string[] = [];
  for (const raw of entries) {
    const entry = String(raw ?? '').trim().replace(/\\/g, '/');
    if (!entry) continue;
    if (isAbsolute(entry) || /^[a-zA-Z]:/.test(entry) || entry.startsWith('/')) {
      throw new CodeBotError('invalid', `Use a path relative to the project folder, not "${entry}"`);
    }
    if (entry.split('/').includes('..')) throw new CodeBotError('invalid', `"${entry}" points outside the project folder`);
    if (entry.length > 200) throw new CodeBotError('invalid', 'Keep each file pattern under 200 characters');
    if (!clean.includes(entry)) clean.push(entry);
  }
  if (clean.length > 30) throw new CodeBotError('invalid', 'List at most 30 files or patterns to copy');
  return clean;
}

export interface CreatedWorktree {
  worktree: TaskWorktree;
  /** Where the sub-agent starts: the worktree, or the subfolder matching the project folder. */
  cwd: string;
  /** Files copied in, relative to the project folder. */
  copied: string[];
}

/**
 * Makes a worktree for one sub-agent at <root>/<taskId> on a new branch
 * "code-bot/<taskId>-<title words>", from the project folder's current commit,
 * and copies in the listed untracked files (such as .env) that a fresh
 * checkout lacks.
 */
export async function createWorktree(options: {
  folder: string;
  root: string;
  taskId: string;
  title: string;
  files: string[];
}): Promise<CreatedWorktree> {
  const { folder, root, taskId } = options;
  let toplevel: string;
  try {
    toplevel = canonical((await git(folder, ['rev-parse', '--show-toplevel'])).trim());
  } catch {
    throw new CodeBotError('invalid', `${folder} is not in a git repository, so it cannot have worktrees`);
  }
  let baseCommit: string;
  try {
    baseCommit = (await git(folder, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  } catch {
    throw new CodeBotError('invalid', `The repository at ${toplevel} has no commits yet, so it cannot have worktrees`);
  }
  const base = (await git(folder, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || 'HEAD';
  const words = slug(options.title);
  const branch = `code-bot/${taskId}${words ? `-${words}` : ''}`;
  mkdirSync(root, { recursive: true });
  const target = join(canonical(root), taskId);
  if (existsSync(target)) throw new CodeBotError('conflict', `The worktree folder ${target} already exists`);
  await git(toplevel, ['worktree', 'add', '-b', branch, target, baseCommit]);

  const path = canonical(target);
  const inside = relative(toplevel, folder);
  const cwd = inside ? join(path, inside) : path;
  const copied = copyFiles(folder, cwd, options.files);
  return {
    worktree: { path, branch, base, baseCommit, folder, removed: false },
    cwd,
    copied,
  };
}

const SKIPPED_FOLDERS = new Set(['node_modules', '.git']);
const MAX_MATCHES = 200;
const MAX_DEPTH = 12;

function segmentRegex(segment: string): RegExp {
  const source = segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  return new RegExp(`^${source}$`, process.platform === 'win32' ? 'i' : '');
}

/**
 * Paths under `root` matching a pattern relative to it. Supports `*` and `?`
 * within a name and `**` for any depth; dotfiles match when named (".env").
 * node_modules and .git are never searched.
 */
export function matchFiles(root: string, pattern: string): string[] {
  const segments = pattern.split('/').filter((part) => part && part !== '.');
  const results = new Set<string>();
  const walk = (dir: string, prefix: string, index: number, depth: number): void => {
    if (results.size >= MAX_MATCHES || depth > MAX_DEPTH) return;
    const segment = segments[index];
    if (segment === undefined) return;
    const last = index === segments.length - 1;
    if (segment === '**') {
      // A trailing "**" means the whole folder; otherwise zero folders deep, or one more and stay on "**".
      if (last) {
        if (prefix) results.add(prefix.slice(0, -1));
        return;
      }
      walk(dir, prefix, index + 1, depth);
      for (const entry of safeEntries(dir)) {
        if (entry.isDirectory() && !SKIPPED_FOLDERS.has(entry.name)) {
          walk(join(dir, entry.name), `${prefix}${entry.name}/`, index, depth + 1);
        }
      }
      return;
    }
    if (!/[*?]/.test(segment)) {
      const path = join(dir, segment);
      if (!existsSync(path)) return;
      if (last) results.add(`${prefix}${segment}`);
      else if (!SKIPPED_FOLDERS.has(segment)) walk(path, `${prefix}${segment}/`, index + 1, depth + 1);
      return;
    }
    const regex = segmentRegex(segment);
    for (const entry of safeEntries(dir)) {
      if (!regex.test(entry.name) || SKIPPED_FOLDERS.has(entry.name)) continue;
      if (last) results.add(`${prefix}${entry.name}`);
      else if (entry.isDirectory()) walk(join(dir, entry.name), `${prefix}${entry.name}/`, index + 1, depth + 1);
    }
  };
  walk(root, '', 0, 0);
  return [...results];
}

function safeEntries(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Copies untracked files that match the patterns from the project folder into the worktree. */
export function copyFiles(from: string, to: string, patterns: string[]): string[] {
  const copied: string[] = [];
  for (const pattern of patterns) {
    for (const match of matchFiles(from, pattern)) {
      const relativePath = match.replace(/\\/g, '/');
      if (relativePath.split('/').includes('..')) continue;
      const source = join(from, match);
      const target = join(to, match);
      // Tracked files are already in the checkout; never overwrite what git put there.
      if (existsSync(target)) continue;
      mkdirSync(dirname(target), { recursive: true });
      cpSync(source, target, { recursive: true, errorOnExist: false, force: false });
      copied.push(relativePath);
    }
  }
  return copied;
}

export type WorktreeStatus = 'clean' | 'dirty' | 'missing';

/** Whether a worktree has uncommitted changes (untracked files count). */
export async function worktreeStatus(worktree: TaskWorktree): Promise<WorktreeStatus> {
  if (worktree.removed || !existsSync(worktree.path)) return 'missing';
  const output = await git(worktree.path, ['status', '--porcelain', '--untracked-files=normal']);
  return output.trim() ? 'dirty' : 'clean';
}

/**
 * Removes a worktree folder. The branch stays unless it is fully merged into
 * the project folder's current branch, so no committed work is lost.
 */
export async function removeWorktree(worktree: TaskWorktree, force: boolean): Promise<{ branchDeleted: boolean }> {
  if (existsSync(worktree.path)) {
    await git(worktree.folder, ['worktree', 'remove', ...(force ? ['--force'] : []), worktree.path]);
  } else {
    await git(worktree.folder, ['worktree', 'prune']).catch(() => '');
  }
  let branchDeleted = false;
  try {
    await git(worktree.folder, ['branch', '-d', worktree.branch]);
    branchDeleted = true;
  } catch {
    // Not merged (or already gone): keep it.
  }
  return { branchDeleted };
}

/**
 * Brings back a removed worktree from its branch, at the same path, so the
 * sub-agent's session (tied to its folder) can continue. Synchronous: it runs
 * right before a turn starts.
 */
export function restoreWorktree(worktree: TaskWorktree): TaskWorktree {
  if (existsSync(worktree.path)) return { ...worktree, removed: false };
  try {
    gitSync(worktree.folder, ['rev-parse', '--verify', '--quiet', `refs/heads/${worktree.branch}`]);
  } catch {
    throw new CodeBotError(
      'conflict',
      `The worktree ${worktree.path} was removed and its branch ${worktree.branch} no longer exists, so this sub-agent cannot continue`,
    );
  }
  gitSync(worktree.folder, ['worktree', 'prune']);
  gitSync(worktree.folder, ['worktree', 'add', worktree.path, worktree.branch]);
  return { ...worktree, removed: false };
}
