// Checks that a Linux AppImage updates itself in place, without publishing a release. Run on Linux
// (WSL works) after `npm run package:linux`:
//
//   node scripts/appimage-update-check.ts [release/code-bot-<version>.AppImage]
//
// It copies the AppImage into a temporary folder (the "installed" copy) and serves a made-up newer
// release, 99.0.0, from localhost (CODE_BOT_UPDATE_FEED), whose AppImage is the same file with the
// size and SHA-256 a GitHub release lists. In the window it checks for updates, installs, and then
// checks that the copy was replaced and that code-bot restarted from it. Demo mode: no model usage.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source =
  process.argv[2] ??
  readdirSync(join(root, 'release'))
    .filter((name) => name.endsWith('.AppImage'))
    .map((name) => join(root, 'release', name))[0];
if (!source || process.platform !== 'linux') {
  console.error('Run this on Linux with an AppImage built by npm run package:linux (or give its path).');
  process.exit(2);
}

const folder = mkdtempSync(join(tmpdir(), 'code-bot-appimage-'));
const installed = join(folder, 'code-bot.AppImage');
copyFileSync(source, installed);
execFileSync('chmod', ['+x', installed]);
const before = statSync(installed).ino;
const bytes = readFileSync(source);
const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

let downloads = 0;
const server = createServer((request, response) => {
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  if (request.url === '/latest') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        tag_name: 'v99.0.0',
        html_url: `${base}/release`,
        body: '## What is new in 99.0.0\n\n- A made-up release for the update check.',
        assets: [{ name: 'code-bot-99.0.0.AppImage', browser_download_url: `${base}/asset`, size: bytes.length, digest }],
      }),
    );
  } else if (request.url === '/asset') {
    downloads += 1;
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length) });
    createReadStream(source).pipe(response);
  } else {
    response.writeHead(404).end();
  }
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const feed = `http://127.0.0.1:${(server.address() as AddressInfo).port}/latest`;

const pids = () =>
  execFileSync('pgrep', ['-f', installed], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .map(Number);

const userData = join(folder, 'data');
const app = await electron.launch({
  executablePath: installed,
  args: ['--no-sandbox'],
  env: {
    ...process.env,
    CODE_BOT_USER_DATA: userData,
    CODE_BOT_FAKE_MODELS: '1',
    CODE_BOT_NO_QUIT_PROMPT: '1',
    CODE_BOT_UPDATE_FEED: feed,
    // Without FUSE (WSL, containers) the AppImage runs extracted; it still sets APPIMAGE.
    APPIMAGE_EXTRACT_AND_RUN: process.env.APPIMAGE_EXTRACT_AND_RUN ?? '1',
  },
});
let closed = false;
app.on('close', () => {
  closed = true;
});
try {
  const page = await app.firstWindow();
  await page.getByTestId('bot-main').waitFor();
  console.log(`  ok   the AppImage starts (${source})`);
  await page.getByTestId('app-settings').click();
  const updates = page.getByTestId('updates');
  await updates.getByRole('button', { name: 'Check for updates' }).click();
  await updates.getByText(/code-bot 99\.0\.0 is out/).waitFor();
  await updates.getByRole('button', { name: 'Update to 99.0.0' }).click();
  await updates.getByText(/puts it in place of this one and restarts code-bot/).waitFor();
  console.log('  ok   it finds the newer release and offers to update in place');
  await updates.getByRole('button', { name: 'Install 99.0.0 now' }).click();
  const deadline = Date.now() + 120_000;
  while (!closed && Date.now() < deadline) await new Promise((done) => setTimeout(done, 250));
  assert.ok(closed, 'code-bot did not quit to restart');
  assert.equal(downloads, 1, 'the AppImage was not downloaded once');
  assert.notEqual(statSync(installed).ino, before, 'the AppImage was not replaced');
  assert.ok((statSync(installed).mode & 0o111) !== 0, 'the new AppImage is not executable');
  assert.equal(createHash('sha256').update(readFileSync(installed)).digest('hex'), digest.slice('sha256:'.length));
  console.log('  ok   it downloads the AppImage, checks it and puts it in place of the running one');
  let restarted: number[] = [];
  for (let i = 0; i < 40 && restarted.length === 0; i += 1) {
    await new Promise((done) => setTimeout(done, 500));
    try {
      restarted = pids();
    } catch {
      restarted = [];
    }
  }
  assert.ok(restarted.length > 0, 'code-bot did not start again from the AppImage');
  console.log('  ok   it restarts from the new AppImage');
  console.log('AppImage update check passed.');
} finally {
  try {
    execFileSync('pkill', ['-f', installed]);
  } catch {
    // Not running.
  }
  if (!closed) await app.close().catch(() => undefined);
  server.close();
  await new Promise((done) => setTimeout(done, 1000));
  rmSync(folder, { recursive: true, force: true });
}
