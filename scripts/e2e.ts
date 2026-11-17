// End-to-end check of the desktop app with scripted bots and mock sub-agents (no model usage).
// Build first (npm run e2e does both). Screenshots go to the folder in CODE_BOT_SHOTS, if set.
//
//   node scripts/e2e.ts
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import type { Page } from 'playwright-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const userData = mkdtempSync(join(tmpdir(), 'code-bot-e2e-'));
const projectDir = join(userData, 'projects', 'demo');
mkdirSync(projectDir, { recursive: true });
// A git repository, so sub-agents can also get their own worktrees.
const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=e2e@example.com', '-c', 'user.name=code-bot e2e', ...args], { cwd: projectDir, stdio: 'ignore' });
git('init', '-q', '-b', 'main');
writeFileSync(join(projectDir, 'README.md'), '# demo\n');
git('add', '.');
git('commit', '-q', '-m', 'first');
const shots = process.env.CODE_BOT_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });

const app = await electron.launch({
  args: [root],
  cwd: root,
  env: { ...process.env, CODE_BOT_FAKE_MODELS: '1', CODE_BOT_USER_DATA: userData, CODE_BOT_NO_QUIT_PROMPT: '1' },
});
const page = await app.firstWindow();
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});

let step = 0;
async function check(name: string, run: () => Promise<void>) {
  step += 1;
  try {
    await run();
    console.log(`  ok   ${step}. ${name}`);
  } catch (error) {
    console.log(`  FAIL ${step}. ${name}`);
    if (shots) await page.screenshot({ path: join(shots, `failure-${step}.png`) });
    throw error;
  }
}

async function say(target: Page, text: string) {
  const box = target.locator('[data-testid="composer"] textarea');
  await box.fill(text);
  await box.press('Enter');
  await target.locator('.msg.user', { hasText: text }).last().waitFor();
}

async function open(target: Page, testId: string, heading: string) {
  await target.getByTestId(testId).click();
  await target.locator('.conv-title h1', { hasText: heading }).waitFor();
}

const conversation = page.locator('.conversation .log');
const panel = page.locator('.panel');

try {
  await check('the window opens on the main bot with no project bots', async () => {
    await page.getByTestId('bot-main').waitFor();
    await page.getByText('Start by adding a project bot').waitFor();
    assert.equal(await page.locator('.demo-tag').textContent(), 'demo');
  });

  await check('a project bot is created with a folder', async () => {
    await page.getByRole('button', { name: '+ New project bot' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('input[name="name"]').fill('demo');
    await dialog.locator('textarea[name="description"]').fill('A demo project for the end-to-end check');
    await dialog.locator('input[name="folderPath"]').fill(projectDir);
    await dialog.getByRole('button', { name: 'Add folder' }).click();
    await dialog.getByText(projectDir).waitFor();
    await dialog.locator('input[name="subModel"]').fill('dev-model');
    await dialog.locator('select[name="subEffort"]').selectOption('high');
    await dialog.getByRole('button', { name: 'Create bot' }).click();
    await dialog.waitFor({ state: 'detached' });
    await page.getByTestId('bot-demo').waitFor();
    assert.equal(await page.locator('.conv-title h1').textContent(), 'demo');
  });

  await check('the main bot hands work to the project bot; the approval appears in the main conversation', async () => {
    await open(page, 'bot-main', 'Main bot');
    await say(page, '@demo task: needs permission to run tests');
    await conversation.getByText('Asked demo.').waitFor();
    const card = conversation.locator('.request-card');
    await card.getByText('Approval needed').waitFor();
    await card.getByText('Run npm test').waitFor();
    if (shots) await page.screenshot({ path: join(shots, '1-approval-in-main.png') });
    await card.getByRole('button', { name: 'Allow' }).click();
    await card.getByText('You allowed it.').waitFor();
  });

  await check('the project bot reports back, and the main bot relays it', async () => {
    await conversation.getByText(/demo reports: t_[0-9a-f]{10} finished: echo\[dev-model\/high\]/).waitFor();
    await conversation.locator('.msg.report').first().waitFor();
  });

  await check("the project bot's own conversation shows the main bot's request", async () => {
    await open(page, 'bot-demo', 'demo');
    await conversation.getByText('From the main bot').waitFor();
    await conversation.getByText('Reply passed on to the main bot').first().waitFor();
    await conversation.locator('.note.started .chip').first().waitFor();
  });

  await check('talking to the project bot directly: a question it leaves open comes to you there', async () => {
    await say(page, 'task: ask which colour to use');
    const card = conversation.locator('.request-card').last();
    await card.getByText('Which colour?').waitFor();
    assert.equal(await page.getByTestId('bot-demo').locator('.badge.needs').textContent(), '1');
    await card.getByRole('button', { name: /Blue/ }).click();
    await card.getByRole('button', { name: 'Send answer' }).click();
    await card.getByText('You answered.').waitFor();
    await conversation.getByText(/t_[0-9a-f]{10} finished: echo\[dev-model\/high\]: ask which colour/).waitFor();
    if (shots) await page.screenshot({ path: join(shots, '2-project-bot.png') });
  });

  await check('a question the project bot can answer never reaches you', async () => {
    await say(page, 'task: ask lead-answers');
    await conversation.getByText(/Answered t_[0-9a-f]{10}: Red\./).waitFor();
    await conversation.getByText(/finished: echo\[dev-model\/high\]: ask lead-answers/).waitFor();
    assert.equal(await conversation.locator('.request-card').count(), 1);
  });

  await check("a sub-agent's history opens from the panel", async () => {
    await panel.getByTestId('subagent-item').filter({ hasText: 'ask which colour to use' }).click();
    await panel.getByText('You answered: Blue').waitFor();
    await panel.getByText('From demo').waitFor();
    if (shots) await page.screenshot({ path: join(shots, '3-sub-agent.png') });
    await panel.getByRole('button', { name: '← Sub-agents' }).click();
    assert.equal(await panel.getByTestId('subagent-item').count(), 3);
  });

  await check('a sub-agent id in a message opens that sub-agent', async () => {
    await conversation.locator('.note.started .chip').first().click();
    await panel.locator('.detail-head').waitFor();
    await panel.getByRole('button', { name: '← Sub-agents' }).click();
  });

  await check('bot settings can be changed', async () => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('select[name="permissionMode"]').selectOption('plan');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await dialog.waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    assert.equal(await page.getByRole('dialog').locator('select[name="permissionMode"]').inputValue(), 'plan');
    await page.keyboard.press('Escape');
  });

  await check('sub-agents can work in their own git worktree, with limits, and be archived', async () => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('select[name="isolation"]').selectOption('worktree');
    await dialog.locator('textarea[name="worktreeFiles"]').waitFor();
    await dialog.locator('input[name="maxTurns"]').fill('40');
    await dialog.locator('input[name="maxBudgetUsd"]').fill('2.5');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await dialog.waitFor({ state: 'detached' });

    await say(page, 'task: hello from a worktree');
    await conversation.getByText(/finished: echo\[dev-model\/high\]: hello from a worktree/).waitFor();
    await panel.getByTestId('subagent-item').filter({ hasText: 'hello from a worktree' }).click();
    await panel.getByTestId('worktree-info').getByText(/branch code-bot\/t_[0-9a-f]{10}-hello-from-a-worktree/).waitFor();
    await panel.getByText('budget $2.50').waitFor();
    await panel.getByText('max 40 turns per run').waitFor();
    if (shots) await page.screenshot({ path: join(shots, '4-worktree.png') });
    await panel.getByTestId('archive-task').click();
    await panel.getByRole('heading', { name: 'Sub-agents' }).waitFor();
    await panel.getByTestId('subagent-item').filter({ hasText: 'hello from a worktree' }).waitFor({ state: 'detached' });
    await panel.getByLabel('Show archived').check();
    await panel.getByTestId('subagent-item').filter({ hasText: 'hello from a worktree' }).waitFor();
    await panel.getByLabel('Show archived').uncheck();
  });

  await check('an earlier conversation can be read and continued', async () => {
    await page.getByRole('button', { name: 'New conversation' }).click();
    await conversation.locator('.divider', { hasText: 'New conversation' }).waitFor();
    await page.getByRole('button', { name: 'Conversations' }).click();
    const menu = page.getByTestId('conversation-menu');
    await menu.getByTestId('conversation-item').nth(1).waitFor();
    assert.equal(await menu.getByTestId('conversation-item').count(), 2);
    await menu.getByTestId('conversation-item').filter({ hasNotText: 'current' }).click();
    await page.getByTestId('viewing-bar').waitFor();
    await conversation.getByText('From the main bot').waitFor();
    assert.equal(await page.locator('[data-testid="composer"]').count(), 0);
    await page.getByRole('button', { name: 'Continue this conversation' }).click();
    await page.getByTestId('viewing-bar').waitFor({ state: 'detached' });
    await conversation.getByText('From the main bot').waitFor();
    await page.locator('[data-testid="composer"]').waitFor();
  });

  await check('app settings can be changed, and the agents are checked', async () => {
    assert.equal(await page.getByTestId('engine-banner').count(), 0);
    await page.getByTestId('app-settings').click();
    const dialog = page.getByRole('dialog', { name: 'code-bot settings' });
    await dialog.locator('.engine-list li[data-ready="true"]').getByText('Mock agent', { exact: true }).waitFor();
    await dialog.locator('input[name="maxActiveSubagents"]').fill('5');
    await dialog.locator('input[name="archiveAfterDays"]').fill('14');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await dialog.waitFor({ state: 'detached' });
    await page.getByTestId('app-settings').click();
    assert.equal(await page.locator('input[name="maxActiveSubagents"]').inputValue(), '5');
    assert.equal(await page.locator('input[name="archiveAfterDays"]').inputValue(), '14');
    if (shots) await page.screenshot({ path: join(shots, '5-app-settings.png') });
    await page.keyboard.press('Escape');
  });

  await check('the page reported no errors', async () => {
    assert.deepEqual(errors, []);
  });
  console.log('All end-to-end checks passed.');
} finally {
  await app.close();
  rmSync(userData, { recursive: true, force: true });
}
