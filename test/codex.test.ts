import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CodexEngine } from '../src/core/engines/codex.ts';
import type { AskUser, EngineEvent, EngineRun, UserRequest } from '../src/core/engines/types.ts';

// CodexEngine against a fake `codex app-server` (test/fixtures/fake-codex.ts): no model usage.
const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-codex.ts');
const nodeArgs = ['--disable-warning=ExperimentalWarning', fixture];

interface Received {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
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
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'code-bot-codex-')));
  const log = join(dir, 'received.jsonl');
  withEnv(t, { FAKE_CODEX_LOG: log, FAKE_CODEX_LOGIN: undefined });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const engine = new CodexEngine({ executable: process.execPath, executableArgs: nodeArgs });
  const received = (): Received[] => {
    try {
      return readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Received);
    } catch {
      return [];
    }
  };
  const params = (method: string) => received().filter((message) => message.method === method).map((message) => message.params ?? {});
  return { dir, engine, received, params };
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

test('a turn streams text, ends with one result, and the settings reach app-server', async (t) => {
  const { dir, engine, params } = setup(t);
  const extra = join(dir, 'shared');
  const asked = recorder({ decision: 'allow' });
  const run = engine.start(
    {
      cwd: dir,
      additionalDirectories: [extra],
      prompt: 'hello',
      model: 'gpt-test',
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
  assert.deepEqual(events[0], { type: 'session', sessionId: 'thread-new', model: 'gpt-test' });
  assert.equal(events.filter((event) => event.type === 'text_delta').map((event) => (event as { text: string }).text).join(''), 'Hello there');
  const result = resultOf(events);
  assert.equal(result.ok, true);
  assert.equal(result.text, 'Hello there');
  assert.equal(result.numTurns, 1);
  assert.equal(asked.requests.length, 0);
  assert.equal(run.send('too late'), false, 'the run is over once the stream ends');

  const [start] = params('thread/start');
  assert.equal(start?.cwd, dir);
  assert.equal(start?.model, 'gpt-test');
  assert.equal(start?.developerInstructions, 'Report to code-bot.');
  assert.equal(start?.sandbox, undefined, 'a writable sandbox on thread/start would mark the folder trusted');
  assert.deepEqual(start?.config, {
    sandbox_mode: 'read-only',
    'features.default_mode_request_user_input': true,
    suppress_unstable_features_warning: true,
  });
  const [turn] = params('turn/start');
  assert.deepEqual(turn?.input, [{ type: 'text', text: 'hello', text_elements: [] }]);
  assert.equal(turn?.effort, 'low');
  assert.equal(turn?.approvalPolicy, 'untrusted');
  assert.equal(turn?.approvalsReviewer, 'user');
  assert.deepEqual(turn?.sandboxPolicy, {
    type: 'workspaceWrite',
    writableRoots: [extra],
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  });
});

test('approval requests go to askUser and the decision goes back to Codex', async (t) => {
  const { dir, engine, received, params } = setup(t);

  const allow = recorder({ decision: 'allow' });
  const allowed = await collect(engine.start({ cwd: dir, prompt: 'command', permissionMode: 'acceptEdits' }, allow.askUser));
  assert.equal(allow.requests.length, 1);
  assert.equal(allow.requests[0]?.kind, 'permission');
  assert.equal(allow.requests[0]?.tool, 'shell');
  // Only what identifies the call: code-bot matches an approval given after a restart by it.
  assert.deepEqual(allow.requests[0]?.input, { command: 'npm test', cwd: dir });
  assert.equal(allow.requests[0]?.summary, 'Run the tests');
  assert.deepEqual(
    allowed.filter((event) => event.type === 'tool_use' || event.type === 'tool_result'),
    [
      { type: 'tool_use', id: 'exec-1', name: 'shell', input: { command: 'npm test', cwd: dir } },
      { type: 'tool_result', id: 'exec-1', isError: false, preview: 'tests passed' },
    ],
  );
  assert.equal(resultOf(allowed).text, 'Command accepted');
  assert.equal(resultOf(allowed).numTurns, 2);
  assert.equal(params('turn/start')[0]?.approvalPolicy, 'on-request');
  const answer = received().find((message) => message.method === undefined && message.result?.decision !== undefined);
  assert.deepEqual(answer, { id: 0, result: { decision: 'accept' } });

  const deny = recorder({ decision: 'deny' });
  const denied = await collect(engine.start({ cwd: dir, prompt: 'command' }, deny.askUser));
  assert.equal(deny.requests.length, 1);
  assert.equal(resultOf(denied).text, 'Command declined');
  const result = denied.find((event) => event.type === 'tool_result');
  assert.deepEqual(result, { type: 'tool_result', id: 'exec-1', isError: true, preview: 'Declined.' });
});

test('questions become AskUserQuestion requests and the answers go back by question id', async (t) => {
  const { dir, engine, received } = setup(t);
  const asked = recorder({ decision: 'allow', answers: { 'Which colour?': 'Blue' } });
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
        ],
      },
    },
  ]);
  assert.equal(resultOf(events).text, 'You chose Blue');
  const answer = received().find((message) => message.method === undefined && message.result?.answers !== undefined);
  assert.deepEqual(answer?.result, { answers: { colour: { answers: ['Blue'] } } });

  const skip = recorder({ decision: 'deny', message: 'Pick yourself.' });
  const skipped = await collect(engine.start({ cwd: dir, prompt: 'question' }, skip.askUser));
  assert.equal(resultOf(skipped).text, 'You chose Pick yourself.');
});

test('async questions (request_user_input_async) reach askUser and the answer goes back as a message', async (t) => {
  const { dir, engine, params } = setup(t);
  const question = {
    kind: 'question',
    tool: 'AskUserQuestion',
    input: { questions: [{ question: 'Which colour?', multiSelect: false, options: [{ label: 'Red' }, { label: 'Blue' }] }] },
  };

  // Codex waits within its turn: the answer is steered in.
  const waiting = recorder({ decision: 'allow', answers: { 'Which colour?': 'Blue' } });
  const steered = await collect(engine.start({ cwd: dir, prompt: 'async' }, waiting.askUser));
  assert.deepEqual(waiting.requests, [question]);
  assert.equal(resultOf(steered).text, 'Noted: Which colour? Blue');
  assert.deepEqual(params('turn/steer')[0]?.input, [
    { type: 'text', text: 'My answer to your question:\nWhich colour? Blue', text_elements: [] },
  ]);

  // Codex ends its turn after asking: the run stays open, and the answer starts the next turn.
  let answer: (response: { decision: 'allow'; answers: Record<string, string> }) => void = () => undefined;
  const asked: UserRequest[] = [];
  const run = engine.start({ cwd: dir, prompt: 'later' }, (request) => {
    asked.push(request);
    return new Promise((resolve) => {
      answer = resolve;
    });
  });
  const events = await collect(run, (event) => {
    if (event.type === 'result' && event.text.startsWith('Which colour?')) answer({ decision: 'allow', answers: { 'Which colour?': 'Red' } });
  });
  assert.deepEqual(asked, [question]);
  assert.deepEqual(
    events.filter((event) => event.type === 'result').map((event) => (event as { text: string }).text),
    ['Which colour?\n- Red\n- Blue', 'Noted: Which colour? Red'],
  );

  // Interrupting while the run waits for the answer withdraws the question and ends the run.
  let withdrawn = false;
  const idle = engine.start(
    { cwd: dir, prompt: 'later' },
    (_request, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          withdrawn = true;
          reject(new Error('withdrawn'));
        });
      }),
  );
  const idleEvents = await collect(idle, (event) => {
    if (event.type === 'result') void idle.interrupt();
  });
  assert.equal(withdrawn, true);
  assert.equal(idleEvents.filter((event) => event.type === 'result').length, 1);
});

test('resuming continues the stored thread', async (t) => {
  const { dir, engine, params } = setup(t);
  const asked = recorder({ decision: 'allow' });
  const events = await collect(
    engine.start({ cwd: dir, prompt: 'hello', resumeSessionId: 'thread-earlier', permissionMode: 'bypassPermissions' }, asked.askUser),
  );
  assert.deepEqual(events[0], { type: 'session', sessionId: 'thread-earlier', model: 'fake-default' });
  const result = resultOf(events);
  assert.equal(result.ok, true);
  assert.equal(result.numTurns, 1, 'usage reported for earlier turns is not counted');
  assert.equal(params('thread/start').length, 0);
  const [resume] = params('thread/resume');
  assert.equal(resume?.threadId, 'thread-earlier');
  assert.equal(resume?.excludeTurns, true);
  assert.equal(resume?.cwd, dir);
  const [turn] = params('turn/start');
  assert.equal(turn?.threadId, 'thread-earlier');
  assert.equal(turn?.approvalPolicy, 'never');
  assert.deepEqual(turn?.sandboxPolicy, { type: 'dangerFullAccess' });

  const unknown = resultOf(await collect(engine.start({ cwd: dir, prompt: 'hello', resumeSessionId: 'gone' }, asked.askUser)));
  assert.equal(unknown.ok, false);
  assert.match(unknown.error ?? '', /no rollout found for thread id gone/);
});

test('send steers the running turn; interrupt stops it and ends the run', async (t) => {
  const { dir, engine, params } = setup(t);
  const asked = recorder({ decision: 'allow' });

  const steered = engine.start({ cwd: dir, prompt: 'wait' }, asked.askUser);
  const steeredEvents = await collect(steered, (event) => {
    if (event.type === 'text' && event.text === 'Waiting.') assert.equal(steered.send('go left'), true);
  });
  assert.equal(resultOf(steeredEvents).ok, true);
  assert.equal(resultOf(steeredEvents).text, 'Steered: go left');
  const [steer] = params('turn/steer');
  assert.equal(steer?.expectedTurnId, 'turn-1');
  assert.deepEqual(steer?.input, [{ type: 'text', text: 'go left', text_elements: [] }]);

  const stopped = engine.start({ cwd: dir, prompt: 'wait' }, asked.askUser);
  let interrupting: Promise<void> | undefined;
  const stoppedEvents = await collect(stopped, (event) => {
    if (event.type === 'text' && event.text === 'Waiting.') interrupting = stopped.interrupt();
  });
  await interrupting;
  const result = resultOf(stoppedEvents);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Interrupted.');
  assert.equal(params('turn/interrupt').length, 1);
  assert.equal(stopped.send('anything'), false);
});

test('a message sent between turns starts the next turn on the same thread', async (t) => {
  const { dir, engine, params } = setup(t);
  const asked = recorder({ decision: 'allow', answers: { 'Which colour?': 'Blue' } });
  const run = engine.start({ cwd: dir, prompt: 'question' }, async (request) => {
    // While the turn waits for this answer, a message arrives that cannot be steered in.
    assert.equal(run.send('hello again'), true);
    return asked.askUser(request, new AbortController().signal);
  });
  const events = await collect(run);
  const results = events.filter((event) => event.type === 'result');
  assert.deepEqual(
    results.map((result) => result.text),
    ['You chose Blue', 'Hello there'],
  );
  assert.equal(params('turn/steer').length, 1, 'it tries to steer first');
  const turns = params('turn/start');
  assert.equal(turns.length, 2);
  assert.deepEqual(turns[1]?.input, [{ type: 'text', text: 'hello again', text_elements: [] }]);
  assert.deepEqual(
    events.filter((event) => event.type === 'session'),
    [{ type: 'session', sessionId: 'thread-new', model: 'fake-default' }],
  );
});

test('maxTurns stops the run when the model goes past it', async (t) => {
  const { dir, engine, params } = setup(t);
  const asked = recorder({ decision: 'allow' });
  const result = resultOf(await collect(engine.start({ cwd: dir, prompt: 'loop', permissionMode: 'auto', maxTurns: 2 }, asked.askUser)));
  assert.equal(result.ok, false);
  assert.equal(result.limit, 'turns');
  assert.equal(result.numTurns, 2);
  assert.match(result.error ?? '', /limit/);
  assert.equal(params('turn/interrupt').length, 1);
});

test('a failed turn, a crash or a missing program ends with a failed result', async (t) => {
  const { dir, engine } = setup(t);
  const asked = recorder({ decision: 'allow' });

  const failed = resultOf(await collect(engine.start({ cwd: dir, prompt: 'fail' }, asked.askUser)));
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'Model not available');

  const crashed = resultOf(await collect(engine.start({ cwd: dir, prompt: 'crash' }, asked.askUser)));
  assert.equal(crashed.ok, false);
  assert.match(crashed.error ?? '', /exited with code 3/);
  assert.match(crashed.error ?? '', /boom: the fake codex crashed/);

  const missing = new CodexEngine({ executable: join(dir, 'nowhere', 'codex.exe') });
  const events = await collect(missing.start({ cwd: dir, prompt: 'hello' }, asked.askUser));
  assert.equal(events.length, 1);
  assert.match(resultOf(events).error ?? '', /Codex is not installed/);
  assert.deepEqual(await missing.check(), { ready: false, detail: `Codex is not installed at ${join(dir, 'nowhere', 'codex.exe')}.` });
  assert.equal(missing.resumeCommand('thread-1'), undefined);

  assert.throws(() => engine.start({ cwd: dir, prompt: 'hello', permissionMode: 'dontAsk' }, asked.askUser), /Unknown permission mode/);
});

test('without codex on PATH the engine reports it is not installed', async (t) => {
  const { dir } = setup(t);
  const empty = join(dir, 'empty');
  mkdirSync(empty);
  withEnv(t, { PATH: empty, HOME: empty, USERPROFILE: empty, CODE_BOT_CODEX_EXECUTABLE: undefined });
  const engine = new CodexEngine();
  const check = await engine.check();
  assert.equal(check.ready, false);
  assert.match(check.detail, /Codex is not installed/);
  assert.equal(check.signIn, undefined);
  const events = await collect(engine.start({ cwd: dir, prompt: 'hello' }, recorder({ decision: 'allow' }).askUser));
  assert.match(resultOf(events).error ?? '', /no "codex" program on PATH/);
});

test('check reports the sign-in state; resumeCommand and models use the same program', async (t) => {
  const { engine } = setup(t);
  const ready = await engine.check();
  assert.deepEqual(ready, { ready: true, detail: 'codex-cli 0.0.0-fake: Logged in using ChatGPT' });

  process.env.FAKE_CODEX_LOGIN = 'out';
  const signedOut = await engine.check();
  assert.equal(signedOut.ready, false);
  assert.match(signedOut.detail, /not signed in/);
  assert.deepEqual(signedOut.signIn, { command: process.execPath, args: [...nodeArgs, 'login'] });

  assert.deepEqual(engine.resumeCommand('thread-1'), { command: process.execPath, args: [...nodeArgs, 'resume', 'thread-1'] });
  const models = await engine.models();
  assert.deepEqual(
    models.map((model) => [model.id, model.isDefault]),
    [
      ['fake-large', true],
      ['fake-mini', false],
    ],
  );
});

test('a codex.cmd shim found on PATH runs through cmd.exe', { skip: process.platform !== 'win32' }, async (t) => {
  const { dir } = setup(t);
  const bin = join(dir, 'npm global');
  mkdirSync(bin);
  const shim = join(bin, 'codex.cmd');
  writeFileSync(shim, `@"${process.execPath}" ${nodeArgs.map((arg) => `"${arg}"`).join(' ')} %*\r\n`);
  withEnv(t, { PATH: bin, CODE_BOT_CODEX_EXECUTABLE: undefined });
  const engine = new CodexEngine();
  assert.deepEqual(await engine.check(), { ready: true, detail: 'codex-cli 0.0.0-fake: Logged in using ChatGPT' });
  assert.deepEqual(engine.resumeCommand('thread-1'), { command: shim, args: ['resume', 'thread-1'] });
  const result = resultOf(await collect(engine.start({ cwd: dir, prompt: 'hello' }, recorder({ decision: 'allow' }).askUser)));
  assert.equal(result.ok, true);
  assert.equal(result.text, 'Hello there');
});
