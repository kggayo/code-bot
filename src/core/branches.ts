/**
 * Handing over a sub-agent's worktree branch, on the user's click (never a bot's): merging it into
 * the project folder, or pushing it and opening a pull request. Like worktrees.ts these commands
 * change the repository, so code-bot runs them itself. Pushing and gh use the user's own git
 * credentials and gh sign-in on this computer; code-bot handles no credentials.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { TaskWorktree } from '../shared/types.ts';
import { CodeBotError } from './util.ts';
import { git } from './worktrees.ts';

const GH_TIMEOUT_MS = 120_000;
/** No prompt may wait for input nobody can give: git and gh fail instead. */
const QUIET_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' };

export interface BranchFacts {
  /** The branch the project folder is on now; null when detached. */
  folderBranch: string | null;
  /** Commits on the sub-agent's branch that the folder's current commit does not have. */
  ahead: number;
  /** The project folder has uncommitted changes to tracked files. */
  folderDirty: boolean;
  /** The sub-agent's worktree has uncommitted changes, which are not part of its branch. */
  worktreeDirty: boolean;
  /** The remote the branch would be pushed to; null when the repository has none. */
  remote: string | null;
  /** "owner/repo" (or "host/owner/repo") when the remote is on GitHub. */
  githubRepo: string | null;
  /** The sub-agent's branch still exists. */
  branchExists: boolean;
}

const trimmed = (text: string) => text.trim();
const quiet = (promise: Promise<string>) => promise.then(trimmed).catch(() => '');

export async function branchFacts(worktree: TaskWorktree): Promise<BranchFacts> {
  const folder = worktree.folder;
  const ref = `refs/heads/${worktree.branch}`;
  const branchExists = Boolean(await quiet(git(folder, ['rev-parse', '--verify', '--quiet', ref])));
  const folderBranch = (await quiet(git(folder, ['symbolic-ref', '--quiet', '--short', 'HEAD']))) || null;
  const ahead = branchExists ? Number(await quiet(git(folder, ['rev-list', '--count', `HEAD..${ref}`]))) || 0 : 0;
  const folderDirty = Boolean(await quiet(git(folder, ['status', '--porcelain', '--untracked-files=no'])));
  const worktreeDirty =
    !worktree.removed && existsSync(worktree.path)
      ? Boolean(await quiet(git(worktree.path, ['status', '--porcelain', '--untracked-files=normal'])))
      : false;
  const remote = await remoteFor(worktree);
  const githubRepo = remote ? githubRepoOf(await quiet(git(folder, ['remote', 'get-url', remote]))) : null;
  return { folderBranch, ahead, folderDirty, worktreeDirty, remote, githubRepo, branchExists };
}

/** The remote of the branch the worktree was made from, else origin, else the only remote. */
async function remoteFor(worktree: TaskWorktree): Promise<string | null> {
  const folder = worktree.folder;
  if (worktree.base !== 'HEAD') {
    const configured = await quiet(git(folder, ['config', '--get', `branch.${worktree.base}.remote`]));
    if (configured && configured !== '.') return configured;
  }
  const remotes = (await quiet(git(folder, ['remote']))).split(/\r?\n/).filter(Boolean);
  return remotes.includes('origin') ? 'origin' : (remotes[0] ?? null);
}

/** "owner/repo" for github.com remotes, "host/owner/repo" for GitHub Enterprise-looking ones, else null. */
export function githubRepoOf(url: string): string | null {
  const match =
    /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|[^@/]+@)([^/:]+(?::\d+)?)[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  if (!match) return null;
  const [, host, owner, repo] = match as unknown as [string, string, string, string];
  const name = host.replace(/:\d+$/, '').toLowerCase();
  if (name === 'github.com' || name === 'www.github.com') return `${owner}/${repo}`;
  return name.includes('github') ? `${name}/${owner}/${repo}` : null;
}

/** Why the branch cannot be merged into the project folder now, or null. */
export function mergeBlocker(worktree: TaskWorktree, facts: BranchFacts): string | null {
  if (!facts.branchExists) return `The branch ${worktree.branch} no longer exists`;
  if (!facts.folderBranch) return 'The project folder is not on a branch (detached HEAD); check out the branch to merge into first';
  if (facts.folderBranch === worktree.branch) return `The project folder is on ${worktree.branch} itself`;
  if (facts.folderDirty) return `The project folder has uncommitted changes on ${facts.folderBranch}; commit or stash them first`;
  if (facts.ahead === 0) return `${facts.folderBranch} already has everything on ${worktree.branch}`;
  return null;
}

/**
 * Merges the sub-agent's branch into the branch the project folder is on, with the user's own git
 * settings and identity. On a conflict the merge is undone, so the folder is left as it was.
 */
export async function mergeBranch(worktree: TaskWorktree): Promise<{ into: string; commit: string; fastForward: boolean }> {
  const facts = await branchFacts(worktree);
  const blocker = mergeBlocker(worktree, facts);
  if (blocker) throw new CodeBotError('conflict', blocker);
  const folder = worktree.folder;
  const into = facts.folderBranch as string;
  const tip = (await git(folder, ['rev-parse', `refs/heads/${worktree.branch}`])).trim();
  try {
    await git(folder, ['merge', '--no-edit', `refs/heads/${worktree.branch}`], QUIET_ENV);
  } catch (error) {
    const merging = Boolean(await quiet(git(folder, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])));
    if (!merging) throw error;
    const files = (await quiet(git(folder, ['diff', '--name-only', '--diff-filter=U']))).split(/\r?\n/).filter(Boolean);
    await git(folder, ['merge', '--abort']).catch(() => '');
    const listed = files.slice(0, 8).join(', ') + (files.length > 8 ? ` and ${files.length - 8} more` : '');
    throw new CodeBotError(
      'conflict',
      `Merging ${worktree.branch} into ${into} conflicts${listed ? ` in ${listed}` : ''}. Nothing was changed. Ask the sub-agent to merge ${into} into its branch and resolve the conflicts, then merge again.`,
    );
  }
  const commit = (await git(folder, ['rev-parse', 'HEAD'])).trim();
  return { into, commit, fastForward: commit === tip };
}

/** Why the branch cannot be pushed now, or null. */
export function pushBlocker(worktree: TaskWorktree, facts: BranchFacts): string | null {
  if (!facts.branchExists) return `The branch ${worktree.branch} no longer exists`;
  if (!facts.remote) return 'This repository has no remote to push to';
  return null;
}

/**
 * Pushes the branch to the remote and opens a pull request into the branch the worktree was made
 * from, with gh when it is installed. Without gh (or on a remote that is not GitHub) the branch is
 * pushed and, on GitHub, the page to create the pull request is returned instead.
 */
export async function pushAndOpenPullRequest(
  worktree: TaskWorktree,
  pull: { title: string; body: string },
  gh: string | null,
): Promise<{ remote: string; url: string | null; created: boolean }> {
  const facts = await branchFacts(worktree);
  const blocker = pushBlocker(worktree, facts);
  if (blocker) throw new CodeBotError('conflict', blocker);
  const remote = facts.remote as string;
  const branch = worktree.branch;
  await git(worktree.folder, ['push', '--set-upstream', remote, `refs/heads/${branch}:refs/heads/${branch}`], QUIET_ENV);
  if (!facts.githubRepo) return { remote, url: null, created: false };
  const base = worktree.base !== 'HEAD' ? worktree.base : null;
  if (!gh) {
    const host = facts.githubRepo.split('/').length === 3 ? facts.githubRepo.split('/')[0] : 'github.com';
    const repo = facts.githubRepo.split('/').slice(-2).join('/');
    const compare = base ? `${encodeURIComponent(base)}...${encodeURIComponent(branch)}` : encodeURIComponent(branch);
    return { remote, url: `https://${host}/${repo}/compare/${compare}?expand=1`, created: false };
  }
  const args = ['pr', 'create', '--repo', facts.githubRepo, '--head', branch, '--title', pull.title, '--body', pull.body];
  if (base) args.push('--base', base);
  try {
    const output = await runGh(gh, worktree.folder, args);
    return { remote, url: lastUrl(output), created: true };
  } catch (error) {
    // gh says so when the branch already has a pull request, with its address.
    const message = error instanceof Error ? error.message : String(error);
    const existing = /already exists/i.test(message) ? lastUrl(message) : null;
    if (existing) return { remote, url: existing, created: false };
    throw new CodeBotError('invalid', `The branch was pushed to ${remote}, but gh could not open the pull request: ${message}`);
  }
}

function lastUrl(text: string): string | null {
  const urls = text.match(/https?:\/\/\S+/g);
  return urls ? (urls[urls.length - 1] as string).replace(/[).,]+$/, '') : null;
}

function runGh(gh: string, cwd: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(gh, args, { cwd, timeout: GH_TIMEOUT_MS, windowsHide: true, env: QUIET_ENV }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr).trim().split(/\r?\n/).slice(-3).join(' ') || error.message));
      else resolvePromise(String(stdout));
    });
  });
}

/** The gh program when it is installed ("gh" on the PATH), else null. */
export function findGh(): Promise<string | null> {
  return new Promise((resolvePromise) => {
    execFile('gh', ['--version'], { timeout: 15_000, windowsHide: true, env: QUIET_ENV }, (error) => resolvePromise(error ? null : 'gh'));
  });
}
