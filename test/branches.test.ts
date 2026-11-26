import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { githubRepoOf } from '../src/core/branches.ts';
import { recentSubagents } from '../src/core/prompts.ts';
import type { Task } from '../src/shared/types.ts';
import { idle, mockSubagents, setup, texts, waitFor } from './helpers.ts';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** A repository on main with one commit and its own identity, so merges can make commits. */
function repository(path: string): string {
  git(path, 'init', '-q', '-b', 'main');
  git(path, 'config', 'user.email', 'test@example.com');
  git(path, 'config', 'user.name', 'code-bot test');
  // Files read back exactly as written, whatever the machine's own autocrlf setting.
  git(path, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(path, 'README.md'), '# demo\n');
  git(path, 'add', '.');
  git(path, 'commit', '-q', '-m', 'first');
  return path;
}

function commit(cwd: string, file: string, content: string, message: string): void {
  writeFileSync(join(cwd, file), content);
  git(cwd, 'add', file);
  git(cwd, '-c', 'user.email=test@example.com', '-c', 'user.name=code-bot test', 'commit', '-q', '-m', message);
}

/** A project with worktrees and one finished sub-agent; returns it and its worktree. */
async function finishedSubagent(t: Parameters<typeof setup>[0], name: string) {
  const context = setup(t);
  const repo = repository(context.folder(name));
  const bot = context.core.createBot({
    name,
    description: '',
    folders: [repo],
    instructions: '',
    model: null,
    effort: null,
    subagents: mockSubagents({ isolation: 'worktree' }),
  });
  context.core.sendToBot(bot.id, 'task: add the page');
  await waitFor(context.core, () => texts(context.core, bot.id).find((text) => text.includes('finished:')));
  await idle(context.core);
  const task = context.core.listTasks({ botId: bot.id })[0] as Task;
  return { ...context, repo, bot, task, worktree: task.worktree! };
}

test('a finished sub-agent branch can be merged into the project folder, which must be clean', async (t) => {
  const { core, repo, task, worktree, events } = await finishedSubagent(t, 'merging');

  let status = await core.getBranchStatus(task.id);
  assert.equal(status.folderBranch, 'main');
  assert.equal(status.ahead, 0);
  assert.equal(status.mergeBlocked, `main already has everything on ${worktree.branch}`);
  assert.equal(status.pushBlocked, 'This repository has no remote to push to');

  commit(worktree.path, 'page.html', '<h1>page</h1>\n', 'Add the page');
  writeFileSync(join(worktree.path, 'draft.txt'), 'not committed');
  status = await core.getBranchStatus(task.id);
  assert.equal(status.ahead, 1);
  assert.equal(status.mergeBlocked, null);
  assert.equal(status.worktreeDirty, true);

  // Uncommitted changes in the project folder stop the merge before it starts.
  writeFileSync(join(repo, 'README.md'), '# changed\n');
  assert.equal((await core.getBranchStatus(task.id)).mergeBlocked, 'The project folder has uncommitted changes on main; commit or stash them first');
  await assert.rejects(core.mergeBranch(task.id), /uncommitted changes on main/);
  git(repo, 'checkout', '--', 'README.md');

  status = await core.mergeBranch(task.id);
  assert.equal(readFileSync(join(repo, 'page.html'), 'utf8'), '<h1>page</h1>\n');
  assert.ok(!existsSync(join(repo, 'draft.txt')), 'uncommitted work in the worktree is not merged');
  assert.equal(status.merged?.into, 'main');
  assert.equal(status.merged?.commit, git(repo, 'rev-parse', 'HEAD').trim());
  assert.equal(status.ahead, 0);
  const merged = events.find((event) => event.scope === 'task' && event.type === 'branch.merged');
  assert.deepEqual(merged?.data, { into: 'main', commit: status.merged?.commit, fastForward: true });
  // The project bot sees it in its list of recent sub-agents.
  assert.match(recentSubagents([core.tasks.getTask(task.id)]), /\(the user merged it into main\)/);
});

test('a merge that conflicts is undone and says where', async (t) => {
  const { core, repo, task, worktree } = await finishedSubagent(t, 'conflicting');
  commit(worktree.path, 'README.md', '# from the sub-agent\n', 'Change the readme');
  commit(repo, 'README.md', '# from the user\n', 'Change the readme too');

  await assert.rejects(core.mergeBranch(task.id), (error: Error) => {
    assert.match(error.message, new RegExp(`Merging ${worktree.branch} into main conflicts in README\\.md\\. Nothing was changed\\.`));
    return true;
  });
  assert.equal(git(repo, 'status', '--porcelain'), '');
  assert.equal(readFileSync(join(repo, 'README.md'), 'utf8'), '# from the user\n');
  assert.equal(core.tasks.getTask(task.id).worktree?.merged, undefined);
});

test('a finished sub-agent branch can be pushed to the remote', async (t) => {
  const { core, repo, task, worktree, folder, events } = await finishedSubagent(t, 'pushing');
  const remote = folder('remote.git');
  git(remote, 'init', '-q', '--bare');
  git(repo, 'remote', 'add', 'origin', remote);
  commit(worktree.path, 'page.html', 'page\n', 'Add the page');

  let status = await core.getBranchStatus(task.id);
  assert.equal(status.remote, 'origin');
  assert.equal(status.githubRepo, null);
  assert.equal(status.pushBlocked, null);

  status = await core.openPullRequest(task.id);
  assert.equal(git(remote, 'rev-parse', `refs/heads/${worktree.branch}`).trim(), git(worktree.path, 'rev-parse', 'HEAD').trim());
  assert.equal(status.pullRequest?.remote, 'origin');
  assert.equal(status.pullRequest?.url, null);
  assert.equal(status.pullRequest?.created, false);
  const pushed = events.find((event) => event.scope === 'task' && event.type === 'branch.pushed');
  assert.deepEqual(pushed?.data, { branch: worktree.branch, remote: 'origin', url: null, created: false });
  assert.match(recentSubagents([core.tasks.getTask(task.id)]), /\(the user pushed it\)/);
});

test('a sub-agent that is working, or worked without a branch, cannot be handed over', async (t) => {
  const { core, brain, projectBot } = setup(t);
  const plain = projectBot('plain');
  brain.overrides.set(plain.id, async (_input, tools) => {
    await tools.call('start_subagent', { title: 'Wait', brief: 'hold on until told' });
    return 'Started.';
  });
  core.sendToBot(plain.id, 'go');
  const task = await waitFor(core, () => core.listTasks({ botId: plain.id })[0]);
  await assert.rejects(core.getBranchStatus(task.id), /did not work on its own branch/);
  await assert.rejects(core.mergeBranch(task.id), /did not work on its own branch/);
  await core.cancelTask(task.id);
});

test('GitHub remotes are recognised in their usual forms', () => {
  assert.equal(githubRepoOf('https://github.com/kggayo/code-bot.git'), 'kggayo/code-bot');
  assert.equal(githubRepoOf('https://user@github.com/kggayo/code-bot'), 'kggayo/code-bot');
  assert.equal(githubRepoOf('git@github.com:kggayo/code-bot.git'), 'kggayo/code-bot');
  assert.equal(githubRepoOf('ssh://git@github.com/kggayo/code-bot.git'), 'kggayo/code-bot');
  assert.equal(githubRepoOf('https://github.com:443/kggayo/code-bot/'), 'kggayo/code-bot');
  assert.equal(githubRepoOf('https://github.example.com/team/app.git'), 'github.example.com/team/app');
  assert.equal(githubRepoOf('https://gitlab.com/team/app.git'), null);
  assert.equal(githubRepoOf('C:\\repos\\remote.git'), null);
  assert.equal(githubRepoOf('/srv/git/remote.git'), null);
});

test('archiving waits for a branch check that is still running in the worktree', async (t) => {
  // On Windows a folder cannot be removed while a git status runs in it.
  const { core, task, worktree } = await finishedSubagent(t, 'racing');
  const checks = [core.getBranchStatus(task.id), core.getBranchStatus(task.id)];
  await core.setTaskArchived(task.id, true);
  await Promise.all(checks);
  assert.ok(!existsSync(worktree.path), 'the worktree was not removed');
  assert.equal(core.tasks.getTask(task.id).worktree?.removed, true);
});
