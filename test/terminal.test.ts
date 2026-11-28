import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { parseArgs } from '../src/headless/cli.ts';
import { Chat } from '../src/headless/chat.ts';
import { Client } from '../src/headless/client.ts';
import { groupBots, shellQuote } from '../src/headless/panes.ts';
import { answerFor, clean, paint, parseCommand, requestCard, splitFirst } from '../src/headless/render.ts';
import { startHttp } from '../src/headless/server.ts';
import { hiddenStarter, systemdUnit, timeZoneNote, windowsScript } from '../src/headless/service.ts';
import { MAIN_BOT_ID } from '../src/shared/types.ts';
import type { BotView, PendingRequest } from '../src/shared/types.ts';
import { idle, setup, waitFor } from './helpers.ts';

const plain = paint(false);

test('agent text cannot steer the terminal: escape sequences and control characters are removed', () => {
  const nasty = [
    'ok \x1b[2J\x1b[H cleared',
    '\x1b]52;c;ZWNobyBoaQ==\x07clipboard',
    '\x1b]8;;https://evil.example\x1b\\click\x1b]8;;\x1b\\',
    '\x1b]2;fake title\x07title',
    'over\rwrite',
    'bell\x07 and \x9b31m C1',
    'bidi \u202ereversed\u202c',
    'tab\tand\nnewline stay',
  ].join(' | ');
  const safe = clean(nasty);
  assert.doesNotMatch(safe, /[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
  assert.doesNotMatch(safe, /[\u202a-\u202e\u2066-\u2069]/);
  assert.ok(!safe.includes('\x1b'));
  assert.ok(!safe.includes('evil.example'), 'a hidden link target is dropped');
  assert.ok(!safe.includes('ZWNobyBoaQ'), 'the clipboard payload is dropped');
  assert.match(safe, /cleared/);
  assert.match(safe, /click/);
  assert.match(safe, /tab\tand\nnewline stay/);
  assert.equal(clean(undefined), '');
});

test('commands, answers and sub-agent references are parsed from what was typed', () => {
  assert.deepEqual(parseCommand('/deny 2 not now'), { name: 'deny', rest: '2 not now' });
  assert.deepEqual(parseCommand('  /ALLOW 1 '), { name: 'allow', rest: '1' });
  assert.equal(parseCommand('hello /allow 1'), null);
  assert.equal(parseCommand('/'), null);
  assert.deepEqual(splitFirst('t_12 do this now'), ['t_12', 'do this now']);
  const question = { question: 'Which colour?', options: [{ label: 'Red' }, { label: 'Blue' }] };
  assert.equal(answerFor(question, '2'), 'Blue');
  assert.equal(answerFor(question, '1,2'), '1,2', 'one pick only unless multiSelect');
  assert.equal(answerFor({ ...question, multiSelect: true }, '1, 2'), 'Red, Blue');
  assert.equal(answerFor(question, '9'), '9');
  assert.equal(answerFor(question, 'Green please'), 'Green please');
});

test('cards show what an approval is for, cleaned, with the commands that answer it', () => {
  const request: PendingRequest = {
    id: 'r_1',
    taskId: 't_0123456789',
    botId: 'b_1',
    kind: 'permission',
    tool: 'Bash',
    input: { command: 'npm test\x1b[2J', description: 'Run the tests' },
    summary: 'Run npm test',
    createdAt: '',
    surfacedIn: null,
  };
  const lines = requestCard({ number: 3, request, taskTitle: 'Fix \x1b]0;x\x07it', botName: 'web' }, plain).join('\n');
  assert.match(lines, /\[3\] Approval needed {2}web · t_0123456789 Fix it/);
  assert.match(lines, /Run a command · Run npm test/);
  assert.match(lines, /\$ npm test$/m);
  assert.match(lines, /\/allow 3 · \/deny 3/);
  assert.ok(!lines.includes('\x1b'));
  const question = requestCard(
    {
      number: 4,
      request: { ...request, kind: 'question', tool: 'AskUserQuestion', input: { questions: [{ question: 'Which colour?', options: [{ label: 'Red' }, { label: 'Blue' }] }] } },
      taskTitle: 'Paint',
      botName: 'web',
    },
    plain,
  ).join('\n');
  assert.match(question, /\[4\] Question/);
  assert.match(question, /1\) Red/);
  assert.match(question, /\/answer 4/);
});

test('the command line parser keeps repeated maps and knows which flags take no value', () => {
  const parsed = parseArgs(['import', 'bots.json', '--map', 'C:\\a=/a', '--map=C:\\b=/b', '--check', '--data', 'x']);
  assert.deepEqual(parsed.positional, ['import', 'bots.json']);
  assert.deepEqual(parsed.lists.get('map'), ['C:\\a=/a', 'C:\\b=/b']);
  assert.equal(parsed.flags.get('check'), true);
  assert.equal(parsed.flags.get('data'), 'x');
  assert.throws(() => parseArgs(['--port']), /needs a value/);
});

test('panes: the main bot first with three project bots, then four per window', () => {
  const bot = (name: string, kind: 'main' | 'project' = 'project') => ({ id: name, name, kind }) as BotView;
  const groups = groupBots([bot('a'), bot('Main bot', 'main'), bot('b'), bot('c'), bot('d'), bot('e'), bot('f'), bot('g'), bot('h'), bot('i')]);
  assert.deepEqual(
    groups.map((group) => group.map((item) => item.name)),
    [['Main bot', 'a', 'b', 'c'], ['d', 'e', 'f', 'g'], ['h', 'i']],
  );
  assert.equal(shellQuote('/usr/bin/node'), '/usr/bin/node');
  assert.equal(shellQuote("it's here"), `'it'\\''s here'`);
});

test('services: the unit and the Windows script run code-bot serve as this user, in the given time zone', () => {
  const unit = systemdUnit({ userData: '/home/me/code bot', port: 7500, timeZone: 'Asia/Manila', path: '/usr/bin:/bin' });
  assert.match(unit, /^ExecStart=.*serve --data "\/home\/me\/code bot" --port 7500$/m);
  assert.match(unit, /^Environment=TZ=Asia\/Manila$/m);
  assert.match(unit, /^Environment=PATH=\/usr\/bin:\/bin$/m);
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^WantedBy=default.target$/m);
  const script = windowsScript({ timeZone: 'Asia/Manila' }, 'C:\\data\\server.log');
  assert.match(script, /set "TZ=Asia\/Manila"/);
  assert.match(script, /"serve" >> "C:\\data\\server\.log" 2>&1\r\nif %errorlevel%==0 exit \/b 0/);
  assert.equal(hiddenStarter('C:\\x\\code-bot-service.cmd'), 'CreateObject("WScript.Shell").Run """C:\\x\\code-bot-service.cmd""", 0, False\r\n');
  assert.equal(timeZoneNote('Europe/Amsterdam').warning, null);
});

async function chatWith(t: TestContext) {
  const env = setup(t);
  const server = await startHttp({ core: env.core, info: { version: 't', dataDir: env.dir, platform: process.platform, fakeModels: true, engines: ['mock'] }, token: 't'.repeat(40), port: 0 });
  t.after(() => server.close());
  const client = new Client({ url: `http://127.0.0.1:${server.port}`, token: 't'.repeat(40) });
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (chunk: Buffer) => {
    text += chunk.toString('utf8');
  });
  return { ...env, client, input, output, transcript: () => text };
}

async function until(check: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('chat: a request from a sub-agent shows as a card in the main bot\'s conversation and /allow answers it', async (t) => {
  const { core, client, input, output, transcript, projectBot } = await chatWith(t);
  projectBot('web');
  const chat = new Chat({ client, input, output, interactive: false, color: false });
  const done = chat.run();
  await until(() => transcript().includes('code-bot · main bot'), 'the heading');
  input.write('@web task: needs permission to test\n');
  await until(() => transcript().includes('[1] Approval needed'), 'the approval card');
  assert.match(transcript(), /you ›\n {2}@web task: needs permission to test/);
  assert.match(transcript(), /\$ npm test/);
  input.write('/allow 1\n');
  await until(() => /web reports: t_[0-9a-f]{10} finished/.test(transcript()), 'the report');
  assert.match(transcript(), /\[1\] allowed/);
  await idle(core);

  input.write('/subagents\n');
  await until(() => /1 {2}t_[0-9a-f]{10} {2}done/.test(transcript()), 'the sub-agent list');
  input.write('/show 1\n');
  await until(() => transcript().includes('last report:'), 'the sub-agent');
  input.write('/nonsense\n');
  await until(() => transcript().includes('Unknown command /nonsense'), 'the error');
  input.write('/quit\n');
  await done;
});

test('chat: questions are answered by option number, routine proposals created from their card, and history is replayed', async (t) => {
  const { core, client, input, output, transcript, projectBot } = await chatWith(t);
  const web = projectBot('web');
  core.sendToBot(web.id, 'task: ask which colour');
  // The sub-agent keeps waiting for the user; only the bot has to finish its turns.
  const botIdle = () => core.listBots().find((bot) => bot.id === web.id)?.status.busy === false || undefined;
  await waitFor(core, () => core.listRequests().find((request) => request.kind === 'question'));
  await waitFor(core, () => core.getThread(web.id).events.some((event) => event.type === 'request.surfaced') && botIdle());
  core.sendToBot(web.id, 'every 30 minutes: check the build');
  await waitFor(core, () => core.getThread(web.id).events.find((event) => event.type === 'routine.proposed'));
  await waitFor(core, botIdle);

  // Opening the conversation later shows what is still open, numbered.
  const chat = new Chat({ client, bot: 'web', input, output, interactive: false, color: false });
  const done = chat.run();
  await until(() => transcript().includes('[2] Routine proposed'), 'the replayed proposal');
  assert.match(transcript(), /\[1\] Question/);
  input.write('/answer 1 2\n');
  await until(() => /\[1\] answered: Blue/.test(transcript()), 'the answer');
  input.write('/create 2\n');
  await until(() => transcript().includes('created routine "check the build"'), 'the routine');
  assert.equal(core.listRoutines().length, 1);
  input.write('/switch main\n');
  await until(() => transcript().includes('code-bot · main bot'), 'the switch');
  input.end();
  await done;
  assert.equal(core.getThread(MAIN_BOT_ID).events.filter((event) => event.type === 'user.message').length, 0);
});
