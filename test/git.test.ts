import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runGit } from '../src/core/git.ts';

test('project bots get read-only git, and nothing that writes or runs programs', async (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'code-bot-git-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git('add', 'a.txt');
  git('commit', '-q', '-m', 'first commit');
  writeFileSync(join(repo, 'a.txt'), 'two\n');

  assert.match(await runGit(repo, ['status', '--short']), /^ M a\.txt/m);
  assert.match(await runGit(repo, ['diff']), /^\+two$/m);
  assert.match(await runGit(repo, ['log', '--oneline']), /first commit/);
  assert.match(await runGit(repo, ['branch', '--show-current']), /\S/);

  const refused = async (args: string[]) => {
    try {
      await runGit(repo, args);
      return 'ran';
    } catch (error) {
      return (error as Error).message;
    }
  };
  assert.match(await refused(['commit', '-am', 'x']), /Only these git commands/);
  assert.match(await refused(['checkout', '.']), /Only these git commands/);
  assert.match(await refused(['diff', '--output=out.txt']), /not allowed/);
  assert.match(await refused(['diff', '--no-index', 'a.txt', 'b.txt']), /not allowed/);
  assert.match(await refused(['log', '--ext-diff']), /not allowed/);
  assert.match(await refused(['branch', '-D', 'main']), /may only list/);
  assert.match(await refused(['branch', 'new-branch']), /may only list/);
  assert.match(await refused([]), /Only these git commands/);
});

test('the version agents see matches package.json', async () => {
  const { CODE_BOT_VERSION } = await import('../src/core/version.ts');
  const { readFileSync } = await import('node:fs');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  assert.equal(CODE_BOT_VERSION, pkg.version);
});
