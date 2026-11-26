// Live check of the desktop app with real Claude models. It spends a little
// model usage (haiku, low effort). Claude Code must be signed in on this
// machine (`claude auth status`). Build first (npm run live does both).
//
//   node scripts/live-check.ts
//
// It works in a throwaway project folder it creates itself, and grants the
// approvals it is asked for there. Screenshots go to CODE_BOT_SHOTS, if set.
// A tiny local MCP server ("probe") checks that MCP servers from a project's
// settings reach its sub-agents.
//
// With CODE_BOT_LIVE_CODEX=1 it also runs a project bot whose sub-agents are
// Codex (signed in with `codex login`), on the cheapest fast model Codex
// offers: a sub-agent creates a file after an approval, then the project bot
// continues the same Codex session with a follow-up, and a Codex sub-agent
// calls the probe server after an approval. That uses Codex usage.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import type { Page } from 'playwright-core';
import { CodexEngine } from '../src/core/engines/codex.ts';
import type { CodexModel } from '../src/core/engines/codex.ts';
import { joinCommandLine } from '../src/shared/command-line.ts';
import type { DesktopBridge, Task, TaskView } from '../src/shared/types.ts';

// The page-side callbacks below run in the window; this file is type-checked without DOM types.
declare const document: { querySelector(selector: string): unknown; querySelectorAll(selector: string): { length: number } };
declare const window: { codeBot: DesktopBridge };

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const userData = mkdtempSync(join(tmpdir(), 'code-bot-live-'));
const withCodex = process.env.CODE_BOT_LIVE_CODEX === '1';
const codexDir = join(userData, 'projects', 'kestrel');
const projectDir = join(userData, 'projects', 'heron');
mkdirSync(projectDir, { recursive: true });
writeFileSync(
  join(projectDir, 'CLAUDE.md'),
  '# Heron\n\nThe internal codename of this project is BLUE-HERON. Mention it when asked what the codename is.\n',
);
// A git repository with its own committer, so a sub-agent can work on a worktree branch and commit.
const git = (...args: string[]) => execFileSync('git', args, { cwd: projectDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
git('init', '-q', '-b', 'main');
git('config', 'user.email', 'live-check@example.com');
git('config', 'user.name', 'code-bot live check');
git('add', 'CLAUDE.md');
git('commit', '-q', '-m', 'first');
const shots = process.env.CODE_BOT_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const MINUTES = 60_000;

// A minimal MCP server over stdio with one tool, "probe", that answers with a marker.
const PROBE_MARKER = 'PROBE-MARKER-7431';
const probeServer = join(userData, 'probe-mcp.mjs');
writeFileSync(
  probeServer,
  `import { createInterface } from 'node:readline';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) continue;
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1.0.0' } } });
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: [{ name: 'probe', description: 'Returns a fixed marker word.', inputSchema: { type: 'object', properties: {} } }] } });
  } else if (method === 'tools/call') {
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: '${PROBE_MARKER}' }] } });
  } else {
    send({ jsonrpc: '2.0', id, result: {} });
  }
}
`,
);

const app = await electron.launch({
  args: [root],
  cwd: root,
  env: { ...process.env, CODE_BOT_USER_DATA: userData, CODE_BOT_NO_QUIT_PROMPT: '1' },
});
const page = await app.firstWindow();
const conversation = page.locator('.conversation .log');

let step = 0;
async function check(name: string, run: () => Promise<void>) {
  step += 1;
  const started = Date.now();
  try {
    await run();
    console.log(`  ok   ${step}. ${name} (${Math.round((Date.now() - started) / 1000)}s)`);
  } catch (error) {
    console.log(`  FAIL ${step}. ${name}`);
    if (shots) await page.screenshot({ path: join(shots, `live-failure-${step}.png`) });
    throw error;
  }
}

async function say(text: string) {
  const box = page.locator('[data-testid="composer"] textarea');
  await box.fill(text);
  await box.press('Enter');
  await page.locator('.msg.user', { hasText: text }).last().waitFor();
}

async function open(testId: string, heading: string) {
  await page.getByTestId(testId).click();
  await page.locator('.conv-title h1', { hasText: heading }).waitFor();
}

/** Every bot quiet, nothing working and nothing waiting for an answer. */
function quiet(target: Page): Promise<boolean> {
  return target.evaluate(
    () =>
      document.querySelectorAll('.sidebar .spinner, .sidebar .badge.working, .sidebar .badge.needs').length === 0 &&
      !document.querySelector('.typing'),
  );
}

async function idle(target: Page) {
  await target.waitForFunction(
    () =>
      document.querySelectorAll('.sidebar .spinner, .sidebar .badge.working').length === 0 &&
      !document.querySelector('.typing'),
    undefined,
    { timeout: 4 * MINUTES, polling: 1000 },
  );
}

/** The Codex model the Codex live check would pick: one marked cheap or fast that takes low effort. */
function cheapestFast(models: CodexModel[]): CodexModel | undefined {
  const usable = models.filter((model) => model.efforts.length === 0 || model.efforts.includes('low'));
  return (
    usable.find((model) => /affordable|cheap|mini|efficient/i.test(`${model.name} ${model.description}`)) ??
    usable.find((model) => /fast/i.test(model.description)) ??
    models.find((model) => model.isDefault)
  );
}

/** Adds the probe MCP server ("node probe-mcp.mjs") in the open project bot's settings. */
async function addProbeServer(allowTools: boolean) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '+ Add MCP server' }).click();
  const row = dialog.getByTestId('mcp-server').last();
  await row.locator('input[name="mcpName"]').fill('probe');
  await row.locator('input[name="mcpCommand"]').fill(joinCommandLine([process.execPath, probeServer]));
  if (allowTools) await row.locator('input[name="mcpAllowTools"]').check();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await dialog.waitFor({ state: 'detached' });
}

/** The newest sub-agent of the given engine. */
async function newestTask(engine: string): Promise<Task> {
  const tasks = (await page.evaluate(() => window.codeBot.call('listTasks', [{}]))) as Task[];
  const task = tasks.filter((candidate) => candidate.engine === engine).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  assert.ok(task, `no ${engine} sub-agent`);
  return task;
}

/** Allows every approval that shows up in the open conversation until all is quiet. Returns how many. */
async function approveUntilQuiet(target: Page, onFirst?: () => Promise<void>): Promise<number> {
  const deadline = Date.now() + 5 * MINUTES;
  const cards = target.locator('.conversation .request-card');
  let approvals = 0;
  for (;;) {
    // Find an open approval by position: a ":not(.closed)" locator would move on once it closes.
    let open = -1;
    const count = await cards.count();
    for (let index = 0; index < count && open < 0; index += 1) {
      const card = cards.nth(index);
      const closed = ((await card.getAttribute('class')) ?? '').includes('closed');
      if (!closed && (await card.getByRole('button', { name: 'Allow' }).count()) > 0) open = index;
    }
    if (open >= 0) {
      if (approvals === 0) await onFirst?.();
      await cards.nth(open).getByRole('button', { name: 'Allow' }).click();
      await cards.nth(open).locator('.request-outcome').waitFor();
      approvals += 1;
      continue;
    }
    if (await quiet(target)) return approvals;
    if (Date.now() > deadline) throw new Error('code-bot did not settle within 5 minutes');
    await target.waitForTimeout(1000);
  }
}

try {
  await check('the sign-in check finds Claude Code signed in', async () => {
    await page.getByTestId('bot-main').waitFor();
    await page.getByTestId('app-settings').click();
    await page.locator('.engine-list li[data-ready="true"]').getByText('Claude Code', { exact: true }).waitFor({ timeout: MINUTES });
    assert.equal(await page.getByTestId('engine-banner').count(), 0);
    await page.keyboard.press('Escape');
  });

  await check('the main bot uses haiku at low effort', async () => {
    await page.getByTestId('bot-main').waitFor();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('input[name="botModel"]').fill('haiku');
    await dialog.locator('select[name="botEffort"]').selectOption('low');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await dialog.waitFor({ state: 'detached' });
  });

  await check('a project bot is created for the throwaway project', async () => {
    await page.getByRole('button', { name: '+ New project bot' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('input[name="name"]').fill('heron');
    await dialog.locator('textarea[name="description"]').fill('Heron: a tiny throwaway project used to test code-bot');
    await dialog.locator('input[name="folderPath"]').fill(projectDir);
    await dialog.getByRole('button', { name: 'Add folder' }).click();
    await dialog.locator('input[name="botModel"]').fill('haiku');
    await dialog.locator('select[name="botEffort"]').selectOption('low');
    await dialog.locator('input[name="subModel"]').fill('haiku');
    await dialog.locator('select[name="subEffort"]').selectOption('low');
    await dialog.locator('select[name="permissionMode"]').selectOption('default');
    await dialog.getByRole('button', { name: 'Create bot' }).click();
    await dialog.waitFor({ state: 'detached' });
    await page.getByTestId('bot-heron').waitFor();
  });

  await check('main bot -> project bot -> report back: the codename comes from the project CLAUDE.md', async () => {
    await open('bot-main', 'Main bot');
    await say('Ask the heron project bot what the internal codename of its project is, and tell me.');
    await conversation.locator('.msg.report').first().waitFor({ timeout: 3 * MINUTES });
    await conversation.locator('.msg.bot', { hasText: 'BLUE-HERON' }).last().waitFor({ timeout: 3 * MINUTES });
    await idle(page);
    if (shots) await page.screenshot({ path: join(shots, 'live-1-main.png') });
  });

  await check('talking to the project bot: a sub-agent asks to write a file, you approve, the bot reports', async () => {
    await open('bot-heron', 'heron');
    await say(
      'Have a sub-agent create a file named greeting.txt in the project folder containing exactly the word hello. Nothing else.',
    );
    await conversation.locator('.request-card').first().waitFor({ timeout: 3 * MINUTES });
    const approvals = await approveUntilQuiet(page, async () => {
      if (shots) await page.screenshot({ path: join(shots, 'live-2-approval.png') });
    });
    console.log(`       (${approvals} approval(s) given)`);
    assert.ok(approvals >= 1, 'no approval was asked for');
    assert.ok(existsSync(join(projectDir, 'greeting.txt')), 'greeting.txt was not created');
    assert.equal(readFileSync(join(projectDir, 'greeting.txt'), 'utf8').trim(), 'hello');
    const lastReply = await conversation.locator('.msg.bot').last().innerText();
    assert.match(lastReply, /greeting\.txt|done|created/i);
    if (shots) await page.screenshot({ path: join(shots, 'live-3-project.png') });
  });

  await check('with worktrees: a sub-agent commits on its own branch and the project folder is untouched', async () => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('select[name="isolation"]').selectOption('worktree');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await dialog.waitFor({ state: 'detached' });
    await say(
      'Have a sub-agent create a file named notes.md containing exactly the line "from the worktree" and commit it on its branch with the message "Add notes". Then tell me the branch name.',
    );
    await conversation.locator('.request-card').last().waitFor({ timeout: 3 * MINUTES });
    const approvals = await approveUntilQuiet(page);
    console.log(`       (${approvals} approval(s) given)`);
    const branches = git('branch', '--list', 'code-bot/*').trim();
    assert.match(branches, /code-bot\/t_[0-9a-f]{10}/, 'no code-bot branch was made');
    const branch = branches.split(/\r?\n/).map((line) => line.replace(/^[*+ ]+/, '').trim()).pop() ?? '';
    assert.equal(git('show', `${branch}:notes.md`).trim(), 'from the worktree');
    assert.ok(!existsSync(join(projectDir, 'notes.md')), 'the sub-agent wrote into the project folder instead of its worktree');
    const lastReply = await conversation.locator('.msg.bot').last().innerText();
    assert.ok(lastReply.includes('code-bot/t_'), `the project bot did not name the branch: ${lastReply}`);
    if (shots) await page.screenshot({ path: join(shots, 'live-4-worktree.png') });
  });

  await check('the sub-agent ran on the configured model', async () => {
    await page.locator('.panel').getByTestId('subagent-item').first().click();
    await page.locator('.panel').getByText(/Session started · claude-haiku/).first().waitFor();
    await page.locator('.panel .panel-head button.link').first().click();
  });

  await check("the worktree sub-agent's branch is merged into the project folder from its panel", async () => {
    await page.locator('.panel').getByTestId('subagent-item').first().click();
    const actions = page.locator('.panel').getByTestId('branch-actions');
    await actions.getByRole('button', { name: 'Merge into main' }).click();
    await actions.getByRole('button', { name: 'Merge', exact: true }).click();
    await actions.getByTestId('branch-merged').waitFor({ timeout: MINUTES });
    assert.equal(readFileSync(join(projectDir, 'notes.md'), 'utf8').trim(), 'from the worktree');
    await page.locator('.panel .panel-head button.link').first().click();
  });

  await check("an MCP server from the project's settings reaches a sub-agent, and its allowed tool runs without asking", async () => {
    await addProbeServer(true);
    await say(
      'Have a sub-agent call the probe tool of its "probe" MCP server once and report exactly what the tool returned. Nothing else. Start it with the project\'s normal permissions, not plan mode.',
    );
    const approvals = await approveUntilQuiet(page);
    console.log(`       (${approvals} approval(s) given)`);
    const task = await newestTask('claude');
    // In plan mode every MCP tool asks, by design; then this check says nothing.
    assert.notEqual(task.permissionMode, 'plan', 'the project bot started the sub-agent in plan mode, where every MCP tool asks');
    assert.ok(task.lastResult?.includes(PROBE_MARKER), `the sub-agent did not get the marker: ${task.lastResult}`);
    const view = (await page.evaluate((id) => window.codeBot.call('getTask', [id]), task.id)) as TaskView;
    const asked = view.events.filter((event) => event.type === 'request' && JSON.stringify(event.data).includes('mcp__probe'));
    assert.equal(asked.length, 0, 'the allowed probe tool asked for approval');
    if (shots) await page.screenshot({ path: join(shots, 'live-4b-mcp.png') });
  });

  await check('asked in the conversation, the main bot proposes a routine, which you create from its card', async () => {
    await open('bot-main', 'Main bot');
    await say('Every weekday at 09:00, ask the heron project bot for a one-line status. Please set that up as a routine.');
    const card = conversation.getByTestId('routine-proposal').last();
    await card.waitFor({ timeout: 3 * MINUTES });
    await card.getByText('Every weekday at 09:00').waitFor();
    assert.equal(((await page.evaluate(() => window.codeBot.call('listRoutines', []))) as unknown[]).length, 0, 'created before you clicked');
    await card.scrollIntoViewIfNeeded();
    if (shots) await page.screenshot({ path: join(shots, 'live-4c-routine.png') });
    await card.getByRole('button', { name: 'Create routine' }).click();
    await card.getByTestId('routine-proposal-outcome').getByText(/^Created/).waitFor();
    const routines = (await page.evaluate(() => window.codeBot.call('listRoutines', []))) as { schedule: unknown }[];
    assert.deepEqual(routines.map((routine) => routine.schedule), [{ kind: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] }]);
    await idle(page);
  });
  if (withCodex) {
    let codexModel = '';
    await check('Codex: a project bot with Codex sub-agents is created', async () => {
      const engine = new CodexEngine();
      const status = await engine.check();
      assert.ok(status.ready, `Codex is not ready: ${status.detail}`);
      codexModel = cheapestFast(await engine.models())?.id ?? '';
      assert.ok(codexModel, 'Codex offers no model to use');
      console.log(`       (Codex model ${codexModel} at low effort)`);
      mkdirSync(codexDir, { recursive: true });
      const git = (...args: string[]) => execFileSync('git', args, { cwd: codexDir, stdio: 'ignore' });
      git('init', '-q', '-b', 'main');
      git('config', 'user.email', 'live-check@example.com');
      git('config', 'user.name', 'code-bot live check');
      writeFileSync(join(codexDir, 'README.md'), '# Kestrel\n');
      git('add', 'README.md');
      git('commit', '-q', '-m', 'first');

      await page.getByRole('button', { name: '+ New project bot' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.locator('input[name="name"]').fill('kestrel');
      await dialog.locator('textarea[name="description"]').fill('Kestrel: a tiny throwaway project for testing Codex sub-agents');
      await dialog.locator('input[name="folderPath"]').fill(codexDir);
      await dialog.getByRole('button', { name: 'Add folder' }).click();
      await dialog.locator('input[name="botModel"]').fill('haiku');
      await dialog.locator('select[name="botEffort"]').selectOption('low');
      await dialog.locator('select[name="engine"]').selectOption('codex');
      await dialog.locator('input[name="subModel"]').fill(codexModel);
      await dialog.locator('select[name="subEffort"]').selectOption('low');
      await dialog.locator('select[name="permissionMode"]').selectOption('default');
      await dialog.getByRole('button', { name: 'Create bot' }).click();
      await dialog.waitFor({ state: 'detached' });
      await page.getByTestId('bot-kestrel').waitFor();
    });

    let taskId = '';
    let sessionId = '';
    await check('Codex: the sub-agent creates a file after your approval, and the project bot reports', async () => {
      await open('bot-kestrel', 'kestrel');
      await say('Have a sub-agent create a file named hello.txt in the project folder containing exactly the word hello. Nothing else.');
      await conversation.locator('.request-card').first().waitFor({ timeout: 5 * MINUTES });
      const approvals = await approveUntilQuiet(page);
      console.log(`       (${approvals} approval(s) given)`);
      assert.ok(existsSync(join(codexDir, 'hello.txt')), 'hello.txt was not created');
      assert.equal(readFileSync(join(codexDir, 'hello.txt'), 'utf8').trim(), 'hello');
      const tasks = (await page.evaluate(() => window.codeBot.call('listTasks', [{}]))) as {
        id: string;
        engine: string;
        engineSessionId: string | null;
      }[];
      const task = tasks.find((candidate) => candidate.engine === 'codex');
      assert.ok(task?.engineSessionId, 'no Codex sub-agent with a session');
      taskId = task.id;
      sessionId = task.engineSessionId;
      if (shots) await page.screenshot({ path: join(shots, 'live-5-codex.png') });
    });

    await check('Codex: a follow-up continues the same Codex session', async () => {
      await say(
        `Send your sub-agent ${taskId} a follow-up message (continue it, do not start a new one) asking which file it created, then tell me its answer.`,
      );
      await approveUntilQuiet(page);
      const view = (await page.evaluate((id) => window.codeBot.call('getTask', [id]), taskId)) as TaskView;
      const sessions = view.events
        .filter((event) => event.type === 'session')
        .map((event) => (event.data as { sessionId: string }).sessionId);
      assert.ok(sessions.length >= 2, `the sub-agent was not continued (${sessions.length} session start(s))`);
      assert.ok(sessions.every((id) => id === sessionId), 'the follow-up started a different Codex session');
      assert.match(view.task.lastResult ?? '', /hello\.txt/);
      const lastReply = await conversation.locator('.msg.bot').last().innerText();
      assert.match(lastReply, /hello\.txt/);
    });

    await check("Codex: an MCP server from the project's settings reaches a sub-agent, and its tool asks first", async () => {
      await addProbeServer(false);
      await say('Have a new sub-agent call the probe tool of its "probe" MCP server once and report exactly what the tool returned. Nothing else.');
      await conversation.locator('.request-card').last().waitFor({ timeout: 5 * MINUTES });
      const approvals = await approveUntilQuiet(page);
      console.log(`       (${approvals} approval(s) given)`);
      assert.ok(approvals >= 1, 'the probe tool ran without asking');
      const task = await newestTask('codex');
      assert.ok(task.lastResult?.includes(PROBE_MARKER), `the Codex sub-agent did not get the marker: ${task.lastResult}`);
      if (shots) await page.screenshot({ path: join(shots, 'live-6-codex-mcp.png') });
    });

    // Keep the owner's Codex history tidy; `codex unarchive <id>` brings the thread back.
    if (sessionId) {
      const command = new CodexEngine().resumeCommand(sessionId)?.command;
      if (command && !/\.(cmd|bat)$/i.test(command)) execFileSync(command, ['archive', sessionId], { stdio: 'ignore' });
    }
  }
  console.log('All live checks passed.');
} finally {
  await app.close();
  rmSync(userData, { recursive: true, force: true });
}
