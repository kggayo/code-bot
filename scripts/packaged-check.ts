// Checks a packaged build: it starts, and it can run Claude Code from its own
// unpacked copy (one short haiku turn of the main bot). Run after
// `npx electron-builder --dir` (or npm run package) on the same platform.
//
//   node scripts/packaged-check.ts
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import type { DesktopBridge } from '../src/shared/types.ts';

// The page-side callback below runs in the window; this file is type-checked without DOM types.
declare const window: { codeBot: DesktopBridge };

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const candidates = [
  join(root, 'release', 'win-unpacked', 'code-bot.exe'),
  join(root, 'release', 'mac', 'code-bot.app', 'Contents', 'MacOS', 'code-bot'),
  join(root, 'release', 'mac-arm64', 'code-bot.app', 'Contents', 'MacOS', 'code-bot'),
  join(root, 'release', 'linux-unpacked', 'code-bot'),
];
const executablePath = candidates.find((path) => existsSync(path));
if (!executablePath) {
  console.error(`No packaged app found. Looked for:\n${candidates.join('\n')}`);
  process.exit(2);
}

const userData = mkdtempSync(join(tmpdir(), 'code-bot-packaged-'));
const app = await electron.launch({
  executablePath,
  env: { ...process.env, CODE_BOT_USER_DATA: userData, CODE_BOT_NO_QUIT_PROMPT: '1' },
});
try {
  const page = await app.firstWindow();
  await page.getByTestId('bot-main').waitFor();
  console.log(`  ok   the packaged app starts (${executablePath})`);

  // The sign-in check runs the unpacked Claude Code (`claude auth status`): any answer proves it runs.
  const engines = (await page.evaluate(() => window.codeBot.call('checkEngines', []))) as { id: string; ready: boolean | null; detail: string }[];
  const claude = engines.find((engine) => engine.id === 'claude');
  assert.ok(claude && claude.ready !== null && !/not found|Could not check/.test(claude.detail), `Claude Code did not run: ${claude?.detail}`);
  console.log(`  ok   the sign-in check runs the unpacked Claude Code: ${claude.detail}`);
  if (!claude.ready) {
    console.log('  SKIPPED the model turn: Claude Code is not signed in for this user (claude auth login).');
    process.exitCode = 3;
  }

  const reply = !claude.ready ? null : await page.evaluate(async () => {
    const call = window.codeBot.call;
    await call('updateBot', ['main', { model: 'haiku', effort: 'low' }]);
    await call('sendToBot', ['main', 'Reply with the single word READY and nothing else.']);
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const thread = (await call('getThread', ['main'])) as { events: { type: string; data: { text?: string; ok?: boolean; error?: string } }[] };
      const end = thread.events.find((event) => event.type === 'turn.end');
      if (end) {
        const text = thread.events.filter((event) => event.type === 'bot.text').map((event) => event.data.text ?? '');
        return { ok: end.data.ok, error: end.data.error, text: text.join('\n') };
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return { ok: false, error: 'No reply within 3 minutes', text: '' };
  });
  if (reply) {
    assert.equal(reply.ok, true, `the main bot's turn failed: ${reply.error}`);
    assert.match(reply.text, /READY/);
    console.log('  ok   the packaged app runs a main-bot turn through its unpacked Claude Code');
    console.log('Packaged build check passed.');
  } else {
    console.log('Packaged build check passed, except the model turn (exit code 3).');
  }
} finally {
  await app.close();
  rmSync(userData, { recursive: true, force: true });
}
