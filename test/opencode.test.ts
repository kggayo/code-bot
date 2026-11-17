import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { OpenCodeEngine } from '../src/core/engines/opencode.ts';
import type { AskUser, EngineEvent, EngineRun, UserRequest } from '../src/core/engines/types.ts';

// OpenCodeEngine against a fake `opencode serve` (test/fixtures/fake-opencode.ts): no model usage.
const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-opencode.ts');
const nodeArgs = ['--disable-warning=ExperimentalWarning', fixture];

interface Logged {
  start?: { args: string[]; cwd: string; permission: string | null; user: string | null };
  method?: string;
  path?: string;
  directory?: string;
  authorized?: boolean;
  body?: Record<string, unknown> | null;
}

/** Sets environment variables for one test. */
function withEnv(t: TestContext, values: Record<string, string | undefined>): void {
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  const apply = (entries: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(entries)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(values);
  t.after(() => apply(before));
}

function setup(t: TestContext) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'code-bot-opencode-')));
  const log = join(dir, 'received.jsonl');
  withEnv(t, { FAKE_OPENCODE_LOG: log, FAKE_OPENCODE_CREDENTIALS: undefined, FAKE_OPENCODE_MODELS: undefined });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const engine = new OpenCodeEngine({ executable: process.execPath, executableArgs: nodeArgs });
  const received = (): Logged[] => {
    try {
      return readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Logged);
    } catch {
      return [];
    }
  };
  const requests = (method: string, path: RegExp) =>
    received().filter((entry) => entry.method === method && path.test(entry.path ?? ''));
  const starts = () => received().flatMap((entry) => (entry.start ? [entry.start] : []));
  return { dir, engine, received, requests, starts };
}

async function collect(run: EngineRun, onEvent?: (event: EngineEvent) => void): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of run.events) {
    events.push(event);
    onEvent?.(event);
  }
  return events;
}

function resultOf(events: EngineEvent[]): Extract<EngineEvent, { type: 'result' }> {
  const last = events[events.length - 1];
  assert.equal(last?.type, 'result', `the last event is ${JSON.stringify(last)}`);
  return last as Extract<EngineEvent, { type: 'result' }>;
}

/** Answers every request with `answer` and keeps them. */
function recorder(answer: Awaited<ReturnType<AskUser>>) {
  const requests: UserRequest[] = [];
  const askUser: AskUser = async (request) => {
    requests.push(request);
    return answer;
  };
  return { requests, askUser };
}

test('a turn streams text, ends with one result, and the settings reach OpenCode', async (t) => {
  const { dir, engine, received, requests, starts } = setup(t);
  const extra = join(dir, 'shared');
  const asked = recorder({ decision: 'allow' });
  const run = engine.start(
    {
      cwd: dir,
      additionalDirectories: [extra],
      prompt: 'hello',
      model: 'opencode/big-pickle',
      effort: 'low',
      permissionMode: 'default',
      instructions: 'Report to code-bot.',
    },
    asked.askUser,
  );
  const events = await collect(run);

  assert.deepEqual(
    events.map((event) => event.type),
    ['session', 'text_delta', 'text_delta', 'text', 'result'],
  );
  const [session] = events;
  assert.equal(session?.type, 'session');
  assert.match((session as { sessionId: string }).sessionId, /^ses_/);
  assert.equal((session as { model?: string }).model, 'opencode/big-pickle');
  assert.equal(events.filter((event) => event.type === 'text_delta').map((event) => (event as { text: string }).text).join(''), 'Hello there');
  const result = resultOf(events);
  assert.equal(result.ok, true);
  assert.equal(result.text, 'Hello there');
  assert.equal(result.numTurns, 1);
  assert.equal(result.costUsd, 0.01);
  assert.equal(asked.requests.length, 0);
  assert.equal(run.send('too late'), false, 'the run is over once the stream ends');

  // The server: localhost, a password, the permission mode in its environment, the run's folder.
  const [start] = starts();
  assert.deepEqual(start?.args, ['serve', '--hostname', '127.0.0.1', '--port', '0']);
  assert.equal(start?.cwd, dir);
  assert.equal(start?.user, 'code-bot');
  assert.deepEqual(JSON.parse(start?.permission ?? '{}'), {
    edit: 'ask',
    bash: 'ask',
    external_directory: { [extra]: 'allow', [join(extra, '*')]: 'allow' },
  });
  const calls = received().filter((entry) => entry.method);
  assert.ok(calls.length > 0);
  assert.ok(calls.every((entry) => entry.authorized && entry.directory === dir), 'every request is authorised and names the folder');

  const [created] = requests('POST', /^\/session$/);
  assert.deepEqual(created?.body, { title: 'code-bot: hello' });
  const [prompt] = requests('POST', /\/prompt_async$/);
  assert.deepEqual(prompt?.body, {
    parts: [{ type: 'text', text: 'hello' }],
    agent: 'build',
    model: { providerID: 'opencode', modelID: 'big-pickle' },
    system: `Report to code-bot.\n\nBesides ${dir}, you may also work in these folders: ${extra}.`,
    variant: 'low',
  });
});

test('each permission mode becomes OpenCode permission rules, and plan mode uses the plan agent', async (t) => {
  const { dir, engine, requests, starts } = setup(t);
  const asked = recorder({ decision: 'allow' });
  for (const permissionMode of ['plan', 'acceptEdits', 'auto', 'bypassPermissions']) {
    // A model without variants: the effort is ignored.
    const result = resultOf(await collect(engine.start({ cwd: dir, prompt: 'hello', permissionMode, model: 'opencode/plain-free', effort: 'high' }, asked.askUser)));
    assert.equal(result.ok, true, permissionMode);
  }
  const rules = starts().map((start) => JSON.parse(start.permission ?? '{}') as Record<string, unknown>);
  assert.deepEqual(rules[0], { edit: 'deny', bash: 'deny' });
  assert.deepEqual(rules[1], { edit: 'allow', bash: 'ask' });
  assert.deepEqual(rules[2], { edit: 'allow', bash: 'ask' });
  assert.equal(rules[3]?.edit, 'allow');
  assert.equal(rules[3]?.bash, 'allow');
  assert.equal(rules[3]?.external_directory, 'allow');
  assert.equal(rules[3]?.doom_loop, 'allow');
  const prompts = requests('POST', /\/prompt_async$/).map((entry) => entry.body ?? {});
  assert.deepEqual(
    prompts.map((body) => body.agent),
    ['plan', 'build', 'build', 'build'],
  );
  assert.ok(prompts.every((body) => body.variant === undefined && body.system === undefined));

  assert.throws(() => engine.start({ cwd: dir, prompt: 'hello', permissionMode: 'dontAsk' }, asked.askUser), /Unknown permission mode/);
  assert.throws(() => engine.start({ cwd: dir, prompt: 'hello', model: 'big-pickle' }, asked.askUser), /provider\/model/);
});

test('permission requests go to askUser and the decision goes back to OpenCode', async (t) => {
  const { dir, engine, requests } = setup(t);

  const allow = recorder({ decision: 'allow' });
  const allowed = await collect(engine.start({ cwd: dir, prompt: 'edit', permissionMode: 'default' }, allow.askUser));
  assert.equal(allow.requests.length, 1);
  const path = join(dir, 'hello.txt');
  // Only what identifies the change: code-bot matches an approval given after a restart by it.
  assert.deepEqual(allow.requests[0], {
    kind: 'permission',
    tool: 'write',
    input: {
      path,
      diff: `Index: ${path}\n===================================================================\n--- ${path}\n+++ ${path}\n@@ -0,0 +1 @@\n+hello\n`,
    },
    summary: 'Write hello.txt',
  });
  const tools = allowed.filter((event) => event.type === 'tool_use' || event.type === 'tool_result');
  assert.equal(tools.length, 2);
  assert.deepEqual(tools[0], { type: 'tool_use', id: (tools[0] as { id: string }).id, name: 'write', input: { filePath: path, content: 'hello' } });
  assert.deepEqual(tools[1], { type: 'tool_result', id: (tools[0] as { id: string }).id, isError: false, preview: 'Wrote file successfully.' });
  const result = resultOf(allowed);
  assert.equal(result.ok, true);
  assert.equal(result.text, 'Created hello.txt');
  assert.equal(result.numTurns, 2);
  assert.deepEqual(requests('POST', /^\/permission\/.+\/reply$/)[0]?.body, { reply: 'once' });

  // A refusal carries a reason, so OpenCode tells the agent instead of stopping the turn. The
  // request arrives before the call does: the command comes from the call, not the request's patterns.
  const deny = recorder({ decision: 'deny', message: 'Not now.' });
  const denied = await collect(engine.start({ cwd: dir, prompt: 'command' }, deny.askUser));
  assert.deepEqual(deny.requests, [{ kind: 'permission', tool: 'bash', input: { command: 'npm test --silent' }, summary: 'Run the tests' }]);
  assert.equal(resultOf(denied).text, 'Declined (Not now.)');
  assert.deepEqual(requests('POST', /^\/permission\/.+\/reply$/)[1]?.body, { reply: 'reject', message: 'Not now.' });
  const failedTool = denied.find((event) => event.type === 'tool_result');
  assert.equal((failedTool as { isError: boolean }).isError, true);

  const silent = recorder({ decision: 'deny' });
  await collect(engine.start({ cwd: dir, prompt: 'command' }, silent.askUser));
  assert.deepEqual(requests('POST', /^\/permission\/.+\/reply$/)[2]?.body, { reply: 'reject', message: 'The request was declined.' });
});

test("a sub-session's permission request reaches askUser, but not its text", async (t) => {
  const { dir, engine } = setup(t);
  const asked = recorder({ decision: 'allow' });
  const events = await collect(engine.start({ cwd: dir, prompt: 'subagent' }, asked.askUser));
  assert.deepEqual(asked.requests, [{ kind: 'permission', tool: 'bash', input: { command: 'npm test' }, summary: 'Run the tests' }]);
  assert.deepEqual(
    events.filter((event) => event.type === 'text').map((event) => (event as { text: string }).text),
    ['Sub-agent done'],
  );
  assert.deepEqual(
    events.filter((event) => event.type === 'tool_use').map((event) => (event as { name: string }).name),
    ['task'],
  );
  const result = resultOf(events);
  assert.equal(result.ok, true);
  assert.equal(result.costUsd, 0.06, 'the sub-session costs count');
});

test('questions become AskUserQuestion requests and the answers go back in order', async (t) => {
  const { dir, engine, requests } = setup(t);
  const asked = recorder({ decision: 'allow', answers: { 'Which colour?': 'Blue', 'Which sizes?': 'Small, Large' } });
  const events = await collect(engine.start({ cwd: dir, prompt: 'question' }, asked.askUser));
  assert.deepEqual(asked.requests, [
    {
      kind: 'question',
      tool: 'AskUserQuestion',
      input: {
        questions: [
          {
            question: 'Which colour?',
            header: 'Colour',
            multiSelect: false,
            options: [
              { label: 'Red', description: 'Warm' },
              { label: 'Blue', description: 'Cool' },
            ],
          },
          {
            question: 'Which sizes?',
            header: 'Sizes',
            multiSelect: true,
            options: [
              { label: 'Small', description: undefined },
              { label: 'Large', description: undefined },
            ],
          },
        ],
      },
    },
  ]);
  assert.deepEqual(requests('POST', /^\/question\/.+\/reply$/)[0]?.body, { answers: [['Blue'], ['Small', 'Large']] });
  assert.equal(resultOf(events).text, 'You chose Blue / Small+Large');

  // A declined question still gets an answer, so the agent carries on.
  const skip = recorder({ decision: 'deny', message: 'Pick yourself.' });
  const skipped = await collect(engine.start({ cwd: dir, prompt: 'question' }, skip.askUser));
  assert.equal(resultOf(skipped).text, 'You chose Pick yourself. / Pick yourself.');
});

test('resuming continues the stored session', async (t) => {
  const { dir, engine, requests } = setup(t);
  const asked = recorder({ decision: 'allow' });
  const events = await collect(engine.start({ cwd: dir, prompt: 'hello', resumeSessionId: 'ses_earlier' }, asked.askUser));
  assert.deepEqual(events[0], { type: 'session', sessionId: 'ses_earlier', model: 'opencode/big-pickle' });
  const result = resultOf(events);
  assert.equal(result.ok, true);
  assert.equal(result.text, 'Hello there');
  assert.equal(result.costUsd, 0.26, 'the earlier cost of the session counts');
  assert.equal(requests('POST', /^\/session$/).length, 0, 'no new session');
  assert.equal(requests('GET', /^\/session\/ses_earlier$/).length, 1);
  assert.equal(requests('POST', /^\/session\/ses_earlier\/prompt_async$/).length, 1);

  const unknown = await collect(engine.start({ cwd: dir, prompt: 'hello', resumeSessionId: 'gone' }, asked.askUser));
  assert.equal(unknown.length, 1);
  assert.equal(resultOf(unknown).ok, false);
  assert.match(resultOf(unknown).error ?? '', /Could not continue OpenCode session gone: .*Resource not found/);
});

test('send steers the running turn; interrupt stops it and ends the run', async (t) => {
  const { dir, engine, requests } = setup(t);
  const asked = recorder({ decision: 'allow' });

  const steered = engine.start({ cwd: dir, prompt: 'wait', instructions: 'Be brief.' }, asked.askUser);
  const steeredEvents = await collect(steered, (event) => {
    if (event.type === 'text' && event.text === 'Waiting.') assert.equal(steered.send('go left'), true);
  });
  const steeredResult = resultOf(steeredEvents);
  assert.equal(steeredResult.ok, true);
  assert.equal(steeredResult.text, 'Steered: go left');
  assert.equal(steeredEvents.filter((event) => event.type === 'result').length, 1, 'one turn');
  const [, steer] = requests('POST', /\/prompt_async$/);
  // The same settings as the turn's own message, which OpenCode's loop reads them from.
  assert.deepEqual(steer?.body, { parts: [{ type: 'text', text: 'go left' }], agent: 'build', system: 'Be brief.', noReply: true });

  const stopped = engine.start({ cwd: dir, prompt: 'wait' }, asked.askUser);
  let interrupting: Promise<void> | undefined;
  const started = Date.now();
  const stoppedEvents = await collect(stopped, (event) => {
    if (event.type === 'text' && event.text === 'Waiting.') interrupting = stopped.interrupt();
  });
  await interrupting;
  assert.ok(Date.now() - started < 4000, 'the run ends without waiting for the force-kill');
  const result = resultOf(stoppedEvents);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Interrupted.');
  assert.equal(result.text, 'Waiting.');
  assert.equal(requests('POST', /\/abort$/).length, 1);
  assert.equal(stopped.send('anything'), false);
});

test('a message OpenCode finished without reading gets answered in the same turn', async (t) => {
  const { dir, engine, requests } = setup(t);
  const run = engine.start({ cwd: dir, prompt: 'racy' }, recorder({ decision: 'allow' }).askUser);
  const events = await collect(run, (event) => {
    if (event.type === 'text' && event.text === 'Working.') run.send('go left');
  });
  const results = events.filter((event) => event.type === 'result');
  assert.equal(results.length, 1);
  assert.equal(resultOf(events).text, 'Handled: go left');
  const prompts = requests('POST', /\/prompt_async$/).map((entry) => entry.body ?? {});
  assert.equal(prompts.length, 3);
  assert.equal(prompts[1]?.noReply, true);
  assert.deepEqual(prompts[2]?.parts, [{ type: 'text', text: 'I sent you a message just as you were finishing. Please address it.', synthetic: true }]);
});

test('a message sent while the turn starts joins it; one sent after it ends starts the next turn', async (t) => {
  const { dir, engine, requests } = setup(t);
  const run = engine.start({ cwd: dir, prompt: 'hello' }, recorder({ decision: 'allow' }).askUser);
  assert.equal(run.send('and more'), true, 'queued before the server is up');
  const events = await collect(run);
  assert.deepEqual(requests('POST', /\/prompt_async$/)[0]?.body?.parts, [
    { type: 'text', text: 'hello' },
    { type: 'text', text: 'and more' },
  ]);
  assert.equal(events.filter((event) => event.type === 'result').length, 1);

  const asked = recorder({ decision: 'allow' });
  const twice = engine.start({ cwd: dir, prompt: 'command' }, async (request, signal) => {
    // While the turn waits for this answer, a message arrives that steers it.
    assert.equal(twice.send('hello again'), true);
    return asked.askUser(request, signal);
  });
  const twiceEvents = await collect(twice);
  assert.deepEqual(
    twiceEvents.filter((event) => event.type === 'result').map((event) => (event as { text: string }).text),
    ['Steered: hello again'],
  );
  assert.deepEqual(
    twiceEvents.filter((event) => event.type === 'session').length,
    1,
  );
});

test('maxTurns and maxBudgetUsd stop the turn', async (t) => {
  const { dir, engine, requests } = setup(t);
  const asked = recorder({ decision: 'allow' });
  const turns = resultOf(await collect(engine.start({ cwd: dir, prompt: 'loop', permissionMode: 'auto', maxTurns: 2 }, asked.askUser)));
  assert.equal(turns.ok, false);
  assert.equal(turns.limit, 'turns');
  assert.equal(turns.numTurns, 2);
  assert.match(turns.error ?? '', /limit/);

  const budget = resultOf(await collect(engine.start({ cwd: dir, prompt: 'spend', permissionMode: 'auto', maxBudgetUsd: 0.5 }, asked.askUser)));
  assert.equal(budget.ok, false);
  assert.equal(budget.limit, 'budget');
  assert.equal(budget.costUsd, 0.6);
  assert.match(budget.error ?? '', /budget/);
  assert.equal(requests('POST', /\/abort$/).length, 2);
});

test('a retry far in the future ends the turn with the reason', async (t) => {
  const { dir, engine, requests } = setup(t);
  const result = resultOf(await collect(engine.start({ cwd: dir, prompt: 'ratelimit', model: 'opencode/big-pickle' }, recorder({ decision: 'allow' }).askUser)));
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /OpenCode could not get an answer from opencode\/big-pickle: Free usage limit reached\. \(it would try again in 1 h\)/);
  assert.equal(requests('POST', /\/abort$/).length, 1);
});

test('a failed turn, a crash, an unknown model or a missing program ends with a failed result', async (t) => {
  const { dir, engine } = setup(t);
  const asked = recorder({ decision: 'allow' });

  const failed = resultOf(await collect(engine.start({ cwd: dir, prompt: 'fail' }, asked.askUser)));
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'Model not available (HTTP 404)');

  const crashed = resultOf(await collect(engine.start({ cwd: dir, prompt: 'crash' }, asked.askUser)));
  assert.equal(crashed.ok, false);
  assert.match(crashed.error ?? '', /exited with code 3/);
  assert.match(crashed.error ?? '', /boom: the fake opencode crashed/);

  const unknown = await collect(engine.start({ cwd: dir, prompt: 'hello', model: 'opencode/nope' }, asked.askUser));
  assert.equal(unknown.length, 1);
  assert.match(resultOf(unknown).error ?? '', /OpenCode has no model "opencode\/nope"\. It offers opencode\/big-pickle, opencode\/plain-free/);

  const missing = new OpenCodeEngine({ executable: join(dir, 'nowhere', 'opencode.exe') });
  const events = await collect(missing.start({ cwd: dir, prompt: 'hello' }, asked.askUser));
  assert.equal(events.length, 1);
  assert.match(resultOf(events).error ?? '', /OpenCode is not installed/);
  assert.deepEqual(await missing.check(), { ready: false, detail: `OpenCode is not installed at ${join(dir, 'nowhere', 'opencode.exe')}.` });
  assert.equal(missing.resumeCommand('ses_1'), undefined);
});

test('without opencode on PATH the engine reports it is not installed', async (t) => {
  const { dir } = setup(t);
  const empty = join(dir, 'empty');
  mkdirSync(empty);
  withEnv(t, { PATH: empty, HOME: empty, USERPROFILE: empty, APPDATA: empty, CODE_BOT_OPENCODE_EXECUTABLE: undefined, OPENCODE_BIN_PATH: undefined });
  const engine = new OpenCodeEngine();
  const check = await engine.check();
  assert.equal(check.ready, false);
  assert.match(check.detail, /OpenCode is not installed/);
  assert.equal(check.signIn, undefined);
  const events = await collect(engine.start({ cwd: dir, prompt: 'hello' }, recorder({ decision: 'allow' }).askUser));
  assert.match(resultOf(events).error ?? '', /no "opencode" program on PATH/);
});

test('check reports what OpenCode offers; resumeCommand continues a session', async (t) => {
  const { engine } = setup(t);
  assert.deepEqual(await engine.check(), {
    ready: true,
    detail: 'OpenCode 1.1.33-fake is installed. No provider is signed in; the 2 free models it offers (opencode/…) need none. "opencode auth login" adds providers.',
  });
  process.env.FAKE_OPENCODE_CREDENTIALS = '2';
  assert.deepEqual(await engine.check(), { ready: true, detail: 'OpenCode 1.1.33-fake is installed, signed in to 2 providers.' });
  process.env.FAKE_OPENCODE_CREDENTIALS = '0';
  process.env.FAKE_OPENCODE_MODELS = 'none';
  const nothing = await engine.check();
  assert.equal(nothing.ready, false);
  assert.deepEqual(nothing.signIn, { command: process.execPath, args: [...nodeArgs, 'auth', 'login'] });

  assert.deepEqual(engine.resumeCommand('ses_abc123'), { command: process.execPath, args: [...nodeArgs, '--session', 'ses_abc123'] });
  assert.equal(engine.resumeCommand('not a session; rm -rf'), undefined);
});

test('an npm opencode.cmd shim on PATH runs the native binary behind it', { skip: process.platform !== 'win32' }, async (t) => {
  const { dir } = setup(t);
  // The layout `npm install -g opencode-ai` leaves on Windows.
  const prefix = join(dir, 'npm global');
  const native = join(prefix, 'node_modules', 'opencode-ai', 'node_modules', `opencode-windows-${process.arch}`, 'bin');
  mkdirSync(native, { recursive: true });
  mkdirSync(join(prefix, 'node_modules', 'opencode-ai', 'bin'), { recursive: true });
  writeFileSync(join(native, 'opencode.exe'), '');
  writeFileSync(join(prefix, 'opencode.cmd'), '@echo off\r\n');
  withEnv(t, { PATH: prefix, CODE_BOT_OPENCODE_EXECUTABLE: undefined, OPENCODE_BIN_PATH: undefined });
  assert.deepEqual(new OpenCodeEngine().resumeCommand('ses_1'), { command: join(native, 'opencode.exe'), args: ['--session', 'ses_1'] });
});
