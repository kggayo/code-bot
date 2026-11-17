import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cleanWorktreeFiles, matchFiles, slug } from '../src/core/worktrees.ts';
import { idle, mockSubagents, setup, texts, waitFor } from './helpers.ts';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=code-bot test', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** A repository with one commit, an ignored .env and an untracked local config file. */
function repository(path: string): string {
  git(path, 'init', '-q', '-b', 'main');
  writeFileSync(join(path, 'README.md'), '# demo\n');
  writeFileSync(join(path, '.gitignore'), '.env\nconfig/local.json\n');
  git(path, 'add', '.');
  git(path, 'commit', '-q', '-m', 'first');
  writeFileSync(join(path, '.env'), 'SECRET=1\n');
  mkdirSync(join(path, 'config'));
  writeFileSync(join(path, 'config', 'local.json'), '{}\n');
  return path;
}

test('file patterns for worktrees match names, wildcards and any depth, but never node_modules', (t) => {
  const { folder } = setup(t);
  const root = folder('patterns');
  mkdirSync(join(root, 'app', 'node_modules', 'x'), { recursive: true });
  mkdirSync(join(root, 'config'), { recursive: true });
  for (const file of ['.env', '.env.local', 'app/.env', 'app/node_modules/x/.env', 'config/a.local.json', 'config/b.json']) {
    writeFileSync(join(root, file), '');
  }
  assert.deepEqual(matchFiles(root, '.env.*'), ['.env.local']);
  assert.deepEqual(matchFiles(root, '**/.env').sort(), ['.env', 'app/.env']);
  assert.deepEqual(matchFiles(root, 'config/*.local.json'), ['config/a.local.json']);
  assert.deepEqual(matchFiles(root, 'config/**'), ['config']);
  assert.equal(slug('Fix the login bug!'), 'fix-the-login-bug');
  assert.throws(() => cleanWorktreeFiles(['../outside']), /outside the project folder/);
  assert.throws(() => cleanWorktreeFiles(['C:/abs']), /relative to the project folder/);
  assert.deepEqual(cleanWorktreeFiles([' .env ', '.env', 'config\\x.json']), ['.env', 'config/x.json']);
});

test('with worktrees each sub-agent gets its own branch, the untracked files it needs, and cleanup on archive', async (t) => {
  const { core, folder } = setup(t);
  const repo = repository(folder('wt'));
  const bot = core.createBot({
    name: 'wt',
    description: '',
    folders: [repo],
    instructions: '',
    model: null,
    effort: null,
    subagents: mockSubagents({ isolation: 'worktree', worktreeFiles: ['.env', 'config/*.json'] }),
  });

  core.sendToBot(bot.id, 'task: hello');
  await waitFor(core, () => texts(core, bot.id).find((text) => text.includes('finished:')));
  const [task] = core.listTasks({ botId: bot.id });
  const worktree = task!.worktree!;
  assert.match(worktree.branch, /^code-bot\/t_[0-9a-f]{10}-hello$/);
  assert.equal(worktree.base, 'main');
  assert.equal(task!.cwd, worktree.path);
  assert.ok(existsSync(join(worktree.path, 'README.md')));
  assert.equal(readFileSync(join(worktree.path, '.env'), 'utf8'), 'SECRET=1\n');
  assert.ok(existsSync(join(worktree.path, 'config', 'local.json')));
  assert.match(git(repo, 'branch', '--list', worktree.branch), /code-bot\//);
  // The project folder itself is untouched.
  assert.equal(git(repo, 'status', '--porcelain'), '');

  // Uncommitted work blocks archiving unless it is discarded on purpose.
  writeFileSync(join(worktree.path, 'draft.txt'), 'draft');
  await assert.rejects(core.setTaskArchived(task!.id, true), /uncommitted changes/);
  git(worktree.path, 'add', 'draft.txt');
  git(worktree.path, 'commit', '-q', '-m', 'draft');
  await core.setTaskArchived(task!.id, true);
  assert.ok(!existsSync(worktree.path));
  assert.equal(core.tasks.getTask(task!.id).worktree?.removed, true);
  // Unmerged work keeps its branch.
  assert.match(git(repo, 'branch', '--list', worktree.branch), /code-bot\//);

  // A message brings the worktree back from its branch and continues there.
  core.sendToTask(task!.id, 'continue please');
  await waitFor(core, () => core.tasks.getTask(task!.id).state === 'done' && core.tasks.getTask(task!.id).lastResult?.includes('continue please'));
  assert.ok(existsSync(join(worktree.path, 'draft.txt')));
  assert.equal(core.tasks.getTask(task!.id).worktree?.removed, false);
  assert.equal(core.tasks.getTask(task!.id).archivedAt, null);
  await idle(core);

  // A merged branch is deleted with its worktree.
  git(repo, 'merge', '-q', '--ff-only', worktree.branch);
  await core.setTaskArchived(task!.id, true);
  assert.equal(git(repo, 'branch', '--list', worktree.branch), '');
});

test('a project bot can start one sub-agent in the shared folder, and a folder without git cannot have worktrees', async (t) => {
  const { core, folder, brain } = setup(t);
  const repo = repository(folder('mixed'));
  const plain = folder('plain');
  const bot = core.createBot({
    name: 'mixed',
    description: '',
    folders: [repo, plain],
    instructions: '',
    model: null,
    effort: null,
    subagents: mockSubagents({ isolation: 'worktree' }),
  });
  const outcomes: Record<string, string> = {};
  brain.overrides.set(bot.id, async (input, tools) => {
    // Only the user's message starts work; updates about the sub-agents are just acknowledged.
    if (input.prompt !== 'go') return 'noted';
    const shared = (await tools.call('start_subagent', { title: 'merge', brief: 'merge the branch', worktree: false })) as { branch: string | null };
    outcomes.shared = String(shared.branch);
    try {
      await tools.call('start_subagent', { title: 'plain', brief: 'work in plain', folder: plain });
      outcomes.plain = 'started';
    } catch (error) {
      outcomes.plain = error instanceof Error ? error.message : String(error);
    }
    return 'done';
  });
  core.sendToBot(bot.id, 'go');
  await waitFor(core, () => outcomes.plain);
  assert.equal(outcomes.shared, 'null');
  assert.match(outcomes.plain ?? '', /not in a git repository/);
  const [task] = core.listTasks({ botId: bot.id });
  assert.equal(task?.cwd, repo);
  assert.equal(task?.worktree, null);
  await idle(core);
});
