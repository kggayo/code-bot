import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { defaultUserData } from '../src/core/boot.ts';
import { acquireInstance, readInstance } from '../src/core/instance.ts';
import { callOperation, coreHandlers, DESKTOP_ONLY, parseArgs } from '../src/core/operations.ts';
import { Store } from '../src/core/store.ts';
import { CodeBotError } from '../src/core/util.ts';
import { Client, findServer, parseBlock } from '../src/headless/client.ts';
import { startHttp } from '../src/headless/server.ts';
import { runServer } from '../src/headless/serve.ts';
import { exportBots, importBots, mapFolder, parseExport, parseMap } from '../src/headless/transfer.ts';
import { MAIN_BOT_ID } from '../src/shared/types.ts';
import type { CoreEvent, PendingRequest, SurfacedData } from '../src/shared/types.ts';
import { idle, setup, waitFor } from './helpers.ts';

async function until(check: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function tempDir(t: TestContext): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'code-bot-headless-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function http(t: TestContext) {
  const env = setup(t);
  const info = { version: 'test', dataDir: env.dir, platform: process.platform, fakeModels: true, engines: ['mock'] };
  const server = await startHttp({ core: env.core, info, token: 'x'.repeat(40), port: 0 });
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.port}`;
  return { ...env, server, url, client: new Client({ url, token: 'x'.repeat(40) }) };
}

test('operations: one table checks arguments for every caller, and desktop-only ones need the window', async (t) => {
  const { core } = setup(t);
  const info = { version: 'test', dataDir: '', platform: process.platform, fakeModels: true, engines: ['mock'] };
  const handlers = coreHandlers(core, info);
  assert.deepEqual(parseArgs('getThread', ['main']), ['main']);
  assert.throws(() => parseArgs('getThread', [42]), (error: unknown) => error instanceof CodeBotError && error.code === 'invalid' && /getThread/.test(error.message));
  assert.throws(() => parseArgs('sendToBot', ['main']), /Invalid arguments for sendToBot/);
  assert.equal(await callOperation(handlers, 'appInfo', []), info);
  await assert.rejects(callOperation(handlers, 'nonsense', []), /Unknown operation "nonsense"/);
  for (const method of DESKTOP_ONLY) {
    assert.equal(method in handlers, false, method);
    await assert.rejects(callOperation(handlers, method, []), /only works in the desktop app/);
  }
});

test('HTTP: a token and a local caller are required; operations and errors come back as JSON', async (t) => {
  const { url, client, core } = await http(t);
  assert.equal((await fetch(`${url}/api/listBots`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${url}/api/listBots`, { method: 'POST', headers: { authorization: 'Bearer wrong' } })).status, 401);
  const auth = { authorization: `Bearer ${'x'.repeat(40)}` };
  // A web page always sends Origin; a foreign Host is DNS rebinding.
  assert.equal((await fetch(`${url}/api/listBots`, { method: 'POST', headers: { ...auth, origin: 'https://example.com' } })).status, 403);
  const rebound = await new Promise<number>((resolve, reject) => {
    import('node:http').then(({ request }) => {
      const req = request(`${url}/api/listBots`, { method: 'POST', headers: { ...auth, host: 'evil.example:80' } }, (res) => resolve(res.statusCode ?? 0));
      req.on('error', reject);
      req.end();
    });
  });
  assert.equal(rebound, 403);
  assert.equal((await fetch(`${url}/api/listBots`, { method: 'POST', headers: { ...auth, 'content-type': 'text/plain' }, body: '[]' })).status, 400);

  const bots = await client.api.listBots();
  assert.deepEqual(bots.map((bot) => bot.id), [MAIN_BOT_ID]);
  await assert.rejects(client.api.getTask('t_0000000000'), (error: { code?: string; status?: number }) => error.code === 'not_found' && error.status === 404);
  await assert.rejects(client.api.pickFolders(), /only works in the desktop app/);
  await assert.rejects(client.api.sendToBot('main', 5 as never), (error: { status?: number }) => error.status === 400);
  const status = await client.status();
  assert.equal(status.activeSubagents, core.activeSubagents());
});

test('HTTP: the event stream delivers the bot\'s reply, and an approval is answered over HTTP', async (t) => {
  const { client, core, projectBot } = await http(t);
  const web = projectBot('web');
  const events: CoreEvent[] = [];
  let opened = 0;
  const stop = client.subscribe({ event: (event) => events.push(event), open: () => opened++ });
  t.after(stop);
  for (let i = 0; i < 100 && opened === 0; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(opened, 1);

  await client.api.sendToBot(MAIN_BOT_ID, `@${web.name} task: needs permission to test`);
  const surfaced = await waitFor(core, () =>
    events.find((event): event is CoreEvent => event.type === 'request.surfaced' && event.botId === MAIN_BOT_ID),
  );
  const { request } = surfaced.data as SurfacedData;
  assert.equal((request as PendingRequest).tool, 'Bash');
  await client.api.respond(request.taskId, request.id, { decision: 'allow' });
  // The stream arrives a little after the core's own events: poll it.
  await until(() => events.some((event) => event.type === 'bot.text' && /web reports: t_[0-9a-f]{10} finished/.test((event.data as { text: string }).text)), 'the report');
  await idle(core);
  assert.ok(events.some((event) => event.type === 'request.closed' && (event.data as { by: string }).by === 'user'));
  // What the stream carried is what getThread has, so a client that reconnects can catch up from its last seq.
  const stored = (await client.api.getThread(MAIN_BOT_ID)).events.filter((event) => event.seq > 0);
  const streamed = () => events.filter((event) => event.scope === 'thread' && event.botId === MAIN_BOT_ID && event.seq > 0);
  await until(() => streamed().length >= stored.length, 'the stream to catch up');
  assert.deepEqual(streamed().map((event) => event.seq), stored.map((event) => event.seq));
  const last = stored.at(-1)?.seq ?? 0;
  assert.deepEqual((await client.api.getThread(MAIN_BOT_ID, last - 1)).events.map((event) => event.seq), [last]);
});

test('server-sent event blocks are parsed like a browser would', () => {
  assert.deepEqual(parseBlock('event: ready\ndata: {"a":1}'), { event: 'ready', data: '{"a":1}' });
  assert.deepEqual(parseBlock('data: one\ndata: two'), { event: 'message', data: 'one\ntwo' });
  assert.equal(parseBlock(': ping'), null);
  assert.equal(parseBlock('retry: 2000'), null);
});

test('one core per data folder: the lock names the holder, and a dead holder is taken over', async (t) => {
  const userData = tempDir(t);
  const dataDir = join(userData, 'data');
  const server = await runServer({ userData, port: 0, fakeModels: true, log: () => {} });
  t.after(() => server.stop());
  const held = readInstance(dataDir);
  assert.equal(held?.kind, 'server');
  assert.equal(held?.port, server.port);
  assert.throws(() => acquireInstance(dataDir, 'desktop', 'test'), /running headless in this data folder .*code-bot stop/);
  await assert.rejects(runServer({ userData, port: 0, fakeModels: true, log: () => {} }), /running headless/);

  const found = findServer(userData);
  assert.equal(found.kind, 'server');
  if (found.kind === 'server') {
    assert.equal((await found.client.status()).port, server.port);
    await found.client.stop();
  }
  await server.stopped;
  assert.equal(readInstance(dataDir), null);
  assert.equal(findServer(userData).kind, 'none');

  // A lock left by a process that is gone does not block.
  writeFileSync(join(dataDir, 'instance.json'), JSON.stringify({ pid: 2 ** 22 + 12345, kind: 'desktop', port: null, version: 'old', startedAt: '' }));
  const lock = acquireInstance(dataDir, 'desktop', 'test');
  assert.equal(readInstance(dataDir)?.pid, process.pid);
  lock.release();
  assert.equal(readInstance(dataDir), null);
});

test('the data folder defaults to the desktop app\'s', () => {
  assert.equal(defaultUserData({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'win32', 'C:\\Users\\me'), join('C:\\Users\\me\\AppData\\Roaming', 'code-bot'));
  assert.equal(defaultUserData({}, 'linux', '/home/me'), join('/home/me', '.config', 'code-bot'));
  assert.equal(defaultUserData({ XDG_CONFIG_HOME: '/cfg' }, 'linux', '/home/me'), join('/cfg', 'code-bot'));
  assert.equal(defaultUserData({}, 'darwin', '/Users/me'), join('/Users/me', 'Library', 'Application Support', 'code-bot'));
  assert.match(defaultUserData({ CODE_BOT_USER_DATA: 'here' }, 'linux', '/home/me'), /here$/);
});

test('export and import: bots, the main bot\'s settings and routines move, with folders mapped', async (t) => {
  const from = setup(t);
  const web = from.projectBot('web', { model: 'sonnet', instructions: 'Use pnpm.' });
  from.projectBot('docs');
  from.core.updateBot(MAIN_BOT_ID, { model: 'opus', effort: 'high' });
  from.core.createRoutine({ botId: web.id, title: 'Morning', prompt: 'Check the build', schedule: { kind: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] }, enabled: true });
  from.core.createRoutine({ botId: MAIN_BOT_ID, title: 'Weekly', prompt: 'Sum up', schedule: { kind: 'interval', minutes: 10080 }, enabled: false });
  const file = parseExport(JSON.stringify(exportBots(from.store, 'win32')));
  assert.deepEqual(file.bots.map((bot) => bot.name), ['docs', 'web']);
  assert.equal(file.bots[1]?.instructions, 'Use pnpm.');
  assert.equal(file.routines.length, 2);
  assert.ok(file.routines.some((routine) => routine.bot === 'web' && routine.title === 'Morning'));
  assert.ok(file.routines.some((routine) => routine.bot === 'main' && routine.title === 'Weekly'));

  // The other machine: web's folder exists under another root, docs' does not.
  const to = await http(t);
  const root = join(to.dir, 'elsewhere');
  mkdirSync(join(root, 'web'), { recursive: true });
  const sourceRoot = join(from.dir, 'projects');
  const maps = [parseMap(`${sourceRoot}=${root}`)];
  rmSync(join(sourceRoot, 'docs'), { recursive: true });

  const check = await importBots(to.client.api, file, { maps, check: true });
  assert.deepEqual(
    check.map((line) => [line.kind, line.name, line.outcome]),
    [
      ['main', 'main bot', 'would update'],
      ['bot', 'docs', 'skipped'],
      ['bot', 'web', 'would create'],
      ...file.routines.map((routine) => ['routine', `${routine.title} (${routine.bot})`, 'would create']),
    ],
  );
  assert.equal((await to.client.api.listBots()).length, 1);

  const lines = await importBots(to.client.api, file, { maps });
  assert.match(lines.find((line) => line.name === 'docs')?.detail ?? '', /missing here/);
  const bots = await to.client.api.listBots();
  const imported = bots.find((bot) => bot.name === 'web');
  assert.deepEqual(imported?.folders, [realpathSync.native(join(root, 'web'))]);
  assert.equal(imported?.model, 'sonnet');
  assert.equal(bots.find((bot) => bot.id === MAIN_BOT_ID)?.model, 'opus');
  const routines = await to.client.api.listRoutines();
  assert.deepEqual(routines.map((routine) => [routine.title, routine.botId === imported?.id || routine.botId === MAIN_BOT_ID]).sort(), [['Morning', true], ['Weekly', true]]);

  // Importing again changes nothing: the name is taken.
  const again = await importBots(to.client.api, file, { maps });
  assert.equal(again.find((line) => line.name === 'web')?.outcome, 'skipped');
});

test('folders are mapped by the longest matching root, across Windows and POSIX paths', () => {
  const maps = [parseMap('C:\\src=/home/me/src'), parseMap('C:\\src\\work=/srv/work')];
  assert.equal(mapFolder('C:\\src\\webshop', maps, 'linux'), '/home/me/src/webshop');
  assert.equal(mapFolder('c:\\SRC\\work\\api', maps, 'linux'), '/srv/work/api');
  assert.equal(mapFolder('D:\\other', maps, 'linux'), 'D:/other');
  assert.equal(mapFolder('/home/me/src/app', [parseMap('/home/me/src=C:\\code')], 'win32'), 'C:\\code\\app');
  assert.throws(() => parseMap('nothing'), /FROM=TO/);
});

test('a read-only store can be read while another code-bot has it open', (t) => {
  const { store, dir, projectBot } = setup(t);
  projectBot('web');
  const reader = new Store(join(dir, 'data'), { readOnly: true });
  try {
    assert.deepEqual(exportBots(reader).bots.map((bot) => bot.name), ['web']);
    assert.equal(exportBots(store).bots.length, 1);
  } finally {
    reader.close();
  }
});
