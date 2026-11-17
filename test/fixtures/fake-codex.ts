// A stand-in for the `codex` program, for test/codex.test.ts. `app-server` speaks just enough of
// the app-server protocol (JSON-RPC lines on stdio, no "jsonrpc" field) to drive CodexEngine;
// `login status` and `--version` answer like the real CLI (FAKE_CODEX_LOGIN=out: signed out).
// Words in the prompt pick what a turn does:
//   "command"   asks to run "npm test", then says whether it was accepted or declined
//   "question"  asks which colour (Red or Blue), then repeats the answer
//   "async"     asks which colour the way request_user_input_async does, and waits for the answer
//   "later"     asks the same way, then ends its turn
//   "My answer" (a reply to that question) says "Noted: " and the answer
//   "wait"      says "Waiting." and keeps working until it is steered or interrupted
//   "loop"      runs commands, one model call each, until interrupted (at most fifty)
//   "fail"      ends the turn as failed
//   "crash"     writes to stderr and exits with code 3
// Anything else streams "Hello there". Every line received is appended to FAKE_CODEX_LOG.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

type Json = Record<string, unknown>;
type Id = string | number;

const args = process.argv.slice(2);
if (args[0] === '--version') {
  process.stdout.write('codex-cli 0.0.0-fake\n');
  process.exit(0);
}
if (args[0] === 'login' && args[1] === 'status') {
  const signedOut = process.env.FAKE_CODEX_LOGIN === 'out';
  process.stderr.write(signedOut ? 'Not logged in\n' : 'Logged in using ChatGPT\n');
  process.exit(signedOut ? 1 : 0);
}
if (args[0] !== 'app-server') {
  process.stderr.write(`fake codex: unexpected arguments: ${args.join(' ')}\n`);
  process.exit(2);
}

const logFile = process.env.FAKE_CODEX_LOG;
const send = (message: Json) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method: string, params: Json) => send({ method, params });
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let threadId = '';
let cwd = process.cwd();
let turns = 0;
let nextRequestId = 0;
const waiting = new Map<Id, (result: Json) => void>();
/** The turn in progress, which turn/steer and turn/interrupt act on. */
let active: { id: string; steer: (text: string) => void; interrupt: () => void } | undefined;

function ask(method: string, params: Json): Promise<Json> {
  const id = nextRequestId;
  nextRequestId += 1;
  send({ id, method, params });
  return new Promise((resolve) => waiting.set(id, resolve));
}

function say(turnId: string, text: string, stream = false): void {
  const id = `msg-${turnId}-${text.length}`;
  notify('item/started', { threadId, turnId, item: { type: 'agentMessage', id, text: '', phase: 'final_answer' } });
  if (stream) {
    for (const delta of [text.slice(0, 3), text.slice(3)]) notify('item/agentMessage/delta', { threadId, turnId, itemId: id, delta });
  }
  notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', id, text, phase: 'final_answer' } });
}

function modelCall(turnId: string): void {
  const usage = { totalTokens: 10, inputTokens: 8, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 };
  notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { total: usage, last: usage, modelContextWindow: null } });
}

function complete(turnId: string, status: string, error: Json | null = null): void {
  active = undefined;
  notify('turn/completed', { threadId, turn: { id: turnId, items: [], itemsView: 'summary', status, error, durationMs: 7 } });
}

async function command(turnId: string, id: string, text: string, needsApproval: boolean): Promise<string> {
  const item = { type: 'commandExecution', id, command: text, cwd, status: 'inProgress', aggregatedOutput: null, exitCode: null };
  notify('item/started', { threadId, turnId, item });
  let decision = 'accept';
  if (needsApproval) {
    const response = await ask('item/commandExecution/requestApproval', {
      kind: 'command',
      threadId,
      turnId,
      itemId: id,
      startedAtMs: Date.now(),
      environmentId: 'local',
      command: text,
      cwd,
      reason: 'Run the tests',
    });
    decision = String(response.decision);
  }
  const ran = decision === 'accept';
  notify('item/completed', {
    threadId,
    turnId,
    item: { ...item, status: ran ? 'completed' : 'declined', aggregatedOutput: ran ? 'tests passed\n' : null, exitCode: ran ? 0 : null },
  });
  return decision;
}

const lastLine = (text: string) => text.trim().split('\n').pop() ?? '';

async function runTurn(turnId: string, prompt: string): Promise<void> {
  notify('turn/started', { threadId, turn: { id: turnId, items: [], itemsView: 'notLoaded', status: 'inProgress', error: null } });
  if (/^My answer/.test(prompt)) {
    say(turnId, `Noted: ${lastLine(prompt)}`);
    modelCall(turnId);
    complete(turnId, 'completed');
    return;
  }
  if (/\b(async|later)\b/.test(prompt)) {
    // request_user_input_async: the question is an agent message, not a request.
    notify('item/completed', {
      threadId,
      turnId,
      item: {
        type: 'agentMessage',
        id: `call-${turnId}`,
        text: 'Which colour?\n- Red\n- Blue',
        phase: 'final_answer',
        delivery: 'async',
        questions: [{ title: 'Which colour?', options: ['Red', 'Blue'] }],
      },
    });
    modelCall(turnId);
    if (/\blater\b/.test(prompt)) {
      complete(turnId, 'completed');
      return;
    }
    active = {
      id: turnId,
      steer: (text) => {
        say(turnId, `Noted: ${lastLine(text)}`);
        modelCall(turnId);
        complete(turnId, 'completed');
      },
      interrupt: () => complete(turnId, 'interrupted'),
    };
    return;
  }
  if (/\bcrash\b/.test(prompt)) {
    process.stderr.write('boom: the fake codex crashed\n');
    process.exit(3);
  }
  if (/\bfail\b/.test(prompt)) {
    modelCall(turnId);
    complete(turnId, 'failed', { message: 'Model not available', codexErrorInfo: 'other', additionalDetails: null });
    return;
  }
  if (/\bcommand\b/.test(prompt)) {
    const decision = await command(turnId, 'exec-1', 'npm test', true);
    modelCall(turnId);
    say(turnId, decision === 'accept' ? 'Command accepted' : 'Command declined');
    modelCall(turnId);
    complete(turnId, 'completed');
    return;
  }
  if (/\bquestion\b/.test(prompt)) {
    const response = await ask('item/tool/requestUserInput', {
      threadId,
      turnId,
      itemId: 'call-1',
      isBlocking: true,
      autoResolutionMs: null,
      questions: [
        {
          id: 'colour',
          header: 'Colour',
          question: 'Which colour?',
          isOther: true,
          isSecret: false,
          options: [
            { label: 'Red', description: 'Warm' },
            { label: 'Blue', description: 'Cool' },
          ],
        },
      ],
    });
    const answers = (response.answers ?? {}) as Record<string, { answers: string[] } | undefined>;
    say(turnId, `You chose ${answers.colour?.answers[0] ?? '(nothing)'}`);
    modelCall(turnId);
    complete(turnId, 'completed');
    return;
  }
  if (/\bloop\b/.test(prompt)) {
    let stopped = false;
    active = { id: turnId, steer: () => undefined, interrupt: () => (stopped = true) };
    for (let step = 1; step <= 50 && !stopped; step += 1) {
      await command(turnId, `exec-${step}`, `step ${step}`, false);
      modelCall(turnId);
      await pause(20);
    }
    if (stopped) {
      complete(turnId, 'interrupted');
      return;
    }
    say(turnId, 'Looped fifty times');
    complete(turnId, 'completed');
    return;
  }
  if (/\bwait\b/.test(prompt)) {
    say(turnId, 'Waiting.');
    modelCall(turnId);
    active = {
      id: turnId,
      steer: (text) => {
        say(turnId, `Steered: ${text}`);
        modelCall(turnId);
        complete(turnId, 'completed');
      },
      interrupt: () => complete(turnId, 'interrupted'),
    };
    return;
  }
  say(turnId, 'Hello there', true);
  modelCall(turnId);
  complete(turnId, 'completed');
}

function textOf(input: unknown): string {
  return (Array.isArray(input) ? input : []).map((part) => String((part as Json).text ?? '')).join('\n');
}

async function handle(id: Id | undefined, method: string, params: Json): Promise<void> {
  if (typeof params.cwd === 'string') cwd = params.cwd;
  switch (method) {
    case 'initialize':
      send({ id, result: { userAgent: 'fake-codex', codexHome: '', platformFamily: 'unix', platformOs: 'linux' } });
      return;
    case 'initialized':
      return;
    case 'model/list':
      send({
        id,
        result: {
          data: [
            { id: 'fake-large', displayName: 'Fake Large', description: 'Big and thorough.', hidden: false, isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'high', description: '' }] },
            { id: 'fake-hidden', displayName: 'Fake Hidden', description: 'Not offered.', hidden: true, isDefault: false, supportedReasoningEfforts: [] },
            { id: 'fake-mini', displayName: 'Fake Mini', description: 'Fast and affordable.', hidden: false, isDefault: false, supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }] },
          ],
          nextCursor: null,
        },
      });
      return;
    case 'thread/start':
      threadId = 'thread-new';
      send({ id, result: { thread: { id: threadId, model: params.model ?? 'fake-default' }, model: params.model ?? 'fake-default' } });
      return;
    case 'thread/resume': {
      const requested = String(params.threadId);
      if (!requested.startsWith('thread-')) {
        send({ id, error: { code: -32600, message: `no rollout found for thread id ${requested}` } });
        return;
      }
      threadId = requested;
      send({ id, result: { thread: { id: threadId }, model: params.model ?? 'fake-default' } });
      // A resumed thread reports the usage of its earlier turns.
      modelCall('turn-earlier');
      return;
    }
    case 'turn/start': {
      turns += 1;
      const turnId = `turn-${turns}`;
      send({ id, result: { turn: { id: turnId, items: [], itemsView: 'notLoaded', status: 'inProgress', error: null } } });
      await pause(5);
      await runTurn(turnId, textOf(params.input));
      return;
    }
    case 'turn/steer':
      if (!active || active.id !== params.expectedTurnId) {
        send({ id, error: { code: -32600, message: 'no active turn to steer' } });
        return;
      }
      send({ id, result: { turnId: active.id } });
      active.steer(textOf(params.input));
      return;
    case 'turn/interrupt':
      send({ id, result: {} });
      active?.interrupt();
      return;
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: `fake codex does not know ${method}` } });
  }
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  if (logFile) appendFileSync(logFile, `${line}\n`);
  const message = JSON.parse(line) as Json;
  const id = message.id as Id | undefined;
  if (typeof message.method !== 'string') {
    // An answer to one of this server's requests.
    if (id !== undefined) {
      waiting.get(id)?.((message.result ?? {}) as Json);
      waiting.delete(id);
    }
    return;
  }
  void handle(id, message.method, (message.params ?? {}) as Json);
});
lines.on('close', () => process.exit(0));
