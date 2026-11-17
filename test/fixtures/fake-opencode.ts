// A stand-in for the `opencode` program, for test/opencode.test.ts. `serve` speaks just enough of
// OpenCode 1.1's HTTP API (basic auth, GET /event as server-sent events, sessions, prompt_async,
// abort, permission and question replies) to drive OpenCodeEngine; `--version`, `auth list` and
// `models` answer like the real CLI. Its loop works like OpenCode's: one assistant message per model
// call, going on while the last one ended in tool calls or a newer user message is waiting.
// Words in a prompt pick what the turn does:
//   "edit"       writes hello.txt after asking for the "edit" permission
//   "command"    runs "npm test --silent" after asking for the "bash" permission (the request
//                arrives before the event that shows the call)
//   "subagent"   starts a sub-session whose command asks for the "bash" permission
//   "question"   asks which colour (Red or Blue), then repeats the answer
//   "wait"       says "Waiting." and works on until a message steers it or it is aborted
//   "racy"       says "Working." and, when a message arrives, finishes without reading it (as
//                OpenCode does when a message lands just as its loop ends)
//   "loop"       runs a command per model call until aborted (at most fifty)
//   "spend"      the same, each model call costing $0.30
//   "ratelimit"  reports a retry an hour away and waits to be aborted
//   "fail"       ends the turn with a provider error
//   "crash"      writes to stderr and exits with code 3
// Anything else streams "Hello there". A message steered into a turn is answered "Steered: <text>";
// a synthetic message (code-bot's nudge) "Handled: <the message before it>". The session
// ses_earlier exists from the start, with $0.25 spent. Every request is appended to
// FAKE_OPENCODE_LOG, after a line with the environment the server started with.
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

type Json = Record<string, unknown>;

const args = process.argv.slice(2);
const logFile = process.env.FAKE_OPENCODE_LOG;
const log = (entry: Json) => {
  if (logFile) appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
};

if (args[0] === '--version') {
  process.stdout.write('1.1.33-fake\n');
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'list') {
  const count = Number(process.env.FAKE_OPENCODE_CREDENTIALS ?? '0');
  process.stdout.write(`\n┌  Credentials ~/.local/share/opencode/auth.json\n│\n└  ${count} credentials\n\n`);
  process.exit(0);
}
if (args[0] === 'models') {
  if (process.env.FAKE_OPENCODE_MODELS !== 'none') process.stdout.write('opencode/big-pickle\nopencode/plain-free\n');
  process.exit(0);
}
if (args[0] !== 'serve') {
  process.stderr.write(`fake opencode: unexpected arguments: ${args.join(' ')}\n`);
  process.exit(2);
}

log({ start: { args, cwd: process.cwd(), permission: process.env.OPENCODE_PERMISSION ?? null, user: process.env.OPENCODE_SERVER_USERNAME ?? null } });

// ---- state ----

interface Message {
  info: Json;
  parts: Json[];
}
interface Session {
  id: string;
  title: string;
  directory: string;
  parentID?: string;
  messages: Message[];
  /** What the last tool call of a scenario came to, for the step after it. */
  note: string;
}
interface Loop {
  controller: AbortController;
  /** Finish without reading newer messages ("racy"). */
  exitNow: boolean;
  current: Message | undefined;
}

class Aborted extends Error {}

let counter = 0;
const nextId = (prefix: string) => {
  counter += 1;
  return `${prefix}_${String(counter).padStart(10, '0')}`;
};
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const tokens = { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } };

const sessions = new Map<string, Session>();
const loops = new Map<string, Loop>();
const steered = new Set<string>();
const userWaiters = new Map<string, Set<() => void>>();
const permissions = new Map<string, (reply: Json) => void>();
const questions = new Map<string, (answers: string[][] | undefined) => void>();
const clients = new Set<ServerResponse>();

// A session from an earlier run, to continue.
sessions.set('ses_earlier', {
  id: 'ses_earlier',
  title: 'earlier',
  directory: process.cwd(),
  note: '',
  messages: [
    {
      info: { id: 'msg_0000000000a', sessionID: 'ses_earlier', role: 'user', time: { created: 1 }, agent: 'build', model: { providerID: 'opencode', modelID: 'big-pickle' } },
      parts: [{ id: 'prt_0000000000a', sessionID: 'ses_earlier', messageID: 'msg_0000000000a', type: 'text', text: 'earlier question' }],
    },
    {
      info: { id: 'msg_0000000000b', sessionID: 'ses_earlier', role: 'assistant', parentID: 'msg_0000000000a', cost: 0.25, finish: 'stop', time: { created: 2, completed: 3 } },
      parts: [{ id: 'prt_0000000000b', sessionID: 'ses_earlier', messageID: 'msg_0000000000b', type: 'text', text: 'earlier answer', time: { start: 2, end: 3 } }],
    },
  ],
});

function publish(type: string, properties: Json): void {
  const data = `data: ${JSON.stringify({ type, properties })}\n\n`;
  for (const client of clients) client.write(data);
}

function setStatus(sessionID: string, status: Json): void {
  publish('session.status', { sessionID, status });
  if (status.type === 'idle') publish('session.idle', { sessionID });
}

// ---- building messages ----

function guard<T>(loop: Loop, promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const signal = loop.controller.signal;
    if (signal.aborted) return reject(new Aborted());
    const onAbort = () => reject(new Aborted());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => reject(error instanceof Error ? error : new Error(String(error))),
    );
  });
}

const sleep = (loop: Loop, ms: number) => guard(loop, pause(ms));

function textOf(message: Message | undefined): string {
  return (message?.parts ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => String(part.text ?? ''))
    .join('\n');
}

/** The next user message after `after`, once there is one. */
function nextUser(loop: Loop, session: Session, after: string): Promise<Message> {
  const find = () => session.messages.find((message) => message.info.role === 'user' && String(message.info.id) > after);
  return guard(
    loop,
    new Promise<Message>((resolve) => {
      const check = () => {
        const found = find();
        if (!found) return;
        userWaiters.get(session.id)?.delete(check);
        resolve(found);
      };
      if (!userWaiters.has(session.id)) userWaiters.set(session.id, new Set());
      userWaiters.get(session.id)?.add(check);
      check();
    }),
  );
}

function addPart(message: Message, part: Json): Json {
  const full: Json = { id: nextId('prt'), sessionID: message.info.sessionID, messageID: message.info.id, ...part };
  message.parts.push(full);
  publish('message.part.updated', { part: full });
  return full;
}

function assistant(session: Session, parentID: string): Message {
  const info: Json = {
    id: nextId('msg'),
    sessionID: session.id,
    role: 'assistant',
    parentID,
    modelID: 'big-pickle',
    providerID: 'opencode',
    mode: 'build',
    agent: 'build',
    path: { cwd: session.directory, root: session.directory },
    cost: 0,
    tokens,
    time: { created: Date.now() },
  };
  const message: Message = { info, parts: [] };
  session.messages.push(message);
  publish('message.updated', { info });
  return message;
}

function addUser(session: Session, parts: Json[], extra: Json = {}): Message {
  const info: Json = {
    id: nextId('msg'),
    sessionID: session.id,
    role: 'user',
    time: { created: Date.now() },
    agent: 'build',
    model: { providerID: 'opencode', modelID: 'big-pickle' },
    ...extra,
  };
  const message: Message = { info, parts: [] };
  session.messages.push(message);
  publish('message.updated', { info });
  for (const part of parts) addPart(message, part);
  for (const wake of [...(userWaiters.get(session.id) ?? [])]) wake();
  return message;
}

async function say(loop: Loop, message: Message, text: string): Promise<void> {
  const part = addPart(message, { type: 'text', text: '', time: { start: Date.now() } });
  for (const piece of [text.slice(0, 3), text.slice(3)]) {
    if (!piece) continue;
    await sleep(loop, 2);
    part.text = `${String(part.text)}${piece}`;
    publish('message.part.updated', { part, delta: piece });
  }
  part.time = { start: (part.time as Json).start, end: Date.now() };
  publish('message.part.updated', { part });
}

function finish(message: Message, reason: string, cost = 0): void {
  addPart(message, { type: 'step-finish', reason, cost, tokens });
  message.info.finish = reason;
  message.info.cost = Number(message.info.cost ?? 0) + cost;
  message.info.time = { created: (message.info.time as Json).created, completed: Date.now() };
  publish('message.updated', { info: message.info });
}

function tool(message: Message, name: string, input: Json, running = true): Json {
  const part = addPart(message, { type: 'tool', callID: nextId('call'), tool: name, state: { status: 'pending', input: {}, raw: '' } });
  if (running) run(part, input);
  return part;
}

function run(part: Json, input: Json): void {
  part.state = { status: 'running', input, time: { start: Date.now() } };
  publish('message.part.updated', { part });
}

function toolDone(part: Json, output: string): void {
  const state = part.state as Json;
  part.state = { status: 'completed', input: state.input, output, title: '', metadata: {}, time: { start: Date.now(), end: Date.now() } };
  publish('message.part.updated', { part });
}

function toolFailed(part: Json, error: string): void {
  const state = part.state as Json;
  part.state = { status: 'error', input: state.input, error, time: { start: Date.now(), end: Date.now() } };
  publish('message.part.updated', { part });
}

function askPermission(loop: Loop, message: Message, part: Json, permission: string, patterns: string[], metadata: Json): Promise<Json> {
  const id = nextId('per');
  const answer = new Promise<Json>((resolve) => permissions.set(id, resolve));
  publish('permission.asked', {
    id,
    sessionID: message.info.sessionID,
    permission,
    patterns,
    metadata,
    always: ['*'],
    tool: { messageID: message.info.id, callID: part.callID },
  });
  return guard(loop, answer);
}

/**
 * Runs a tool call that needs a permission; returns the session note for the next step. With
 * `early`, the permission request comes before the event that shows the call running, as it can
 * in OpenCode (the tool starts while the stream is still being processed).
 */
async function guardedTool(loop: Loop, message: Message, name: string, input: Json, permission: string, patterns: string[], metadata: Json, output: string, early = false): Promise<string> {
  const part = tool(message, name, input, !early);
  const asked = askPermission(loop, message, part, permission, patterns, metadata);
  if (early) {
    await sleep(loop, 20);
    run(part, input);
  }
  const reply = await asked;
  if (reply.reply === 'reject') {
    const feedback = typeof reply.message === 'string' ? reply.message : '';
    toolFailed(part, feedback ? `The user rejected permission to use this specific tool call with the following feedback: ${feedback}` : 'The user rejected permission to use this specific tool call.');
    return `declined: ${feedback}`;
  }
  toolDone(part, output);
  return 'done';
}

// ---- the loop ----

async function runStep(session: Session, loop: Loop, message: Message, lastUser: Message, step: number): Promise<void> {
  const text = textOf(lastUser);
  if (lastUser.parts.some((part) => part.synthetic === true)) {
    const before = session.messages.filter((entry) => entry.info.role === 'user' && entry !== lastUser).pop();
    await say(loop, message, `Handled: ${textOf(before)}`);
    finish(message, 'stop');
    return;
  }
  if (steered.has(String(lastUser.info.id))) {
    await say(loop, message, `Steered: ${text}`);
    finish(message, 'stop');
    return;
  }
  if (/\bcrash\b/.test(text)) {
    process.stderr.write('boom: the fake opencode crashed\n');
    process.exit(3);
  }
  if (/\bfail\b/.test(text)) {
    message.info.error = { name: 'APIError', data: { message: 'Model not available', statusCode: 404, isRetryable: false } };
    publish('message.updated', { info: message.info });
    publish('session.error', { sessionID: session.id, error: message.info.error });
    return;
  }
  if (/\bratelimit\b/.test(text)) {
    setStatus(session.id, { type: 'retry', attempt: 1, message: 'Free usage limit reached.', next: Date.now() + 3_600_000 });
    await guard(loop, new Promise<never>(() => undefined));
    return;
  }
  if (/\b(edit|command|question|subagent)\b/.test(text) && step > 1) {
    const what = /\bedit\b/.test(text) ? 'Created hello.txt' : /\bcommand\b/.test(text) ? 'Ran the tests' : /\bsubagent\b/.test(text) ? 'Sub-agent done' : 'You chose';
    await say(loop, message, session.note.startsWith('declined') ? `Declined (${session.note.slice('declined: '.length)})` : /\bquestion\b/.test(text) ? `${what} ${session.note}` : what);
    finish(message, 'stop', 0.01);
    return;
  }
  if (/\bedit\b/.test(text)) {
    const path = join(session.directory, 'hello.txt');
    const diff = `Index: ${path}\n===================================================================\n--- ${path}\n+++ ${path}\n@@ -0,0 +1 @@\n+hello\n`;
    session.note = await guardedTool(loop, message, 'write', { filePath: path, content: 'hello' }, 'edit', ['hello.txt'], { filepath: path, diff }, 'Wrote file successfully.');
    finish(message, 'tool-calls', 0.01);
    return;
  }
  if (/\bcommand\b/.test(text)) {
    // OpenCode's patterns for a command are its parsed parts; the call's input has the command as written.
    session.note = await guardedTool(loop, message, 'bash', { command: 'npm test --silent', description: 'Run the tests' }, 'bash', ['npm test'], {}, 'tests passed', true);
    finish(message, 'tool-calls', 0.01);
    return;
  }
  if (/\bsubagent\b/.test(text)) {
    const task = tool(message, 'task', { description: 'Run the tests', prompt: 'Run npm test', subagent_type: 'general' });
    const child: Session = { id: nextId('ses'), title: 'Run the tests', directory: session.directory, parentID: session.id, messages: [], note: '' };
    sessions.set(child.id, child);
    publish('session.created', { info: { id: child.id, parentID: session.id, title: child.title, directory: child.directory } });
    const childUser = addUser(child, [{ type: 'text', text: 'Run npm test' }], { agent: 'general' });
    const childAssistant = assistant(child, String(childUser.info.id));
    addPart(childAssistant, { type: 'step-start' });
    const outcome = await guardedTool(loop, childAssistant, 'bash', { command: 'npm test', description: 'Run the tests' }, 'bash', ['npm test'], {}, 'tests passed');
    await say(loop, childAssistant, `tests ${outcome}`);
    finish(childAssistant, 'stop', 0.05);
    toolDone(task, `Sub-agent: tests ${outcome}`);
    session.note = outcome;
    finish(message, 'tool-calls');
    return;
  }
  if (/\bquestion\b/.test(text)) {
    const asked = [
      { question: 'Which colour?', header: 'Colour', options: [{ label: 'Red', description: 'Warm' }, { label: 'Blue', description: 'Cool' }] },
      { question: 'Which sizes?', header: 'Sizes', multiple: true, options: [{ label: 'Small', description: '' }, { label: 'Large', description: '' }] },
    ];
    const part = tool(message, 'question', { questions: asked });
    const id = nextId('que');
    const answered = new Promise<string[][] | undefined>((resolve) => questions.set(id, resolve));
    publish('question.asked', { id, sessionID: session.id, questions: asked, tool: { messageID: message.info.id, callID: part.callID } });
    const answers = await guard(loop, answered);
    session.note = answers ? answers.map((answer) => answer.join('+') || '(none)').join(' / ') : '(dismissed)';
    toolDone(part, session.note);
    finish(message, 'tool-calls');
    return;
  }
  if (/\bwait\b/.test(text)) {
    await say(loop, message, 'Waiting.');
    await nextUser(loop, session, String(lastUser.info.id));
    finish(message, 'stop');
    return;
  }
  if (/\bracy\b/.test(text)) {
    await say(loop, message, 'Working.');
    await nextUser(loop, session, String(lastUser.info.id));
    loop.exitNow = true;
    finish(message, 'stop');
    return;
  }
  if (/\b(loop|spend)\b/.test(text)) {
    if (step > 50) {
      await say(loop, message, 'Looped fifty times');
      finish(message, 'stop');
      return;
    }
    const part = tool(message, 'bash', { command: `echo step ${step}`, description: `Step ${step}` });
    await sleep(loop, 10);
    toolDone(part, `step ${step}`);
    finish(message, 'tool-calls', /\bspend\b/.test(text) ? 0.3 : 0);
    return;
  }
  await say(loop, message, 'Hello there');
  finish(message, 'stop', 0.01);
}

async function runLoop(session: Session): Promise<void> {
  if (loops.has(session.id)) return; // The running loop reads the new message.
  const loop: Loop = { controller: new AbortController(), exitNow: false, current: undefined };
  loops.set(session.id, loop);
  setStatus(session.id, { type: 'busy' });
  try {
    for (let step = 1; step <= 60; step += 1) {
      if (loop.controller.signal.aborted || loop.exitNow) break;
      const lastUser = session.messages.filter((message) => message.info.role === 'user').pop();
      const lastAssistant = session.messages.filter((message) => message.info.role === 'assistant').pop();
      if (!lastUser || lastAssistant?.info.error) break;
      const finished = lastAssistant?.info.finish;
      if (lastAssistant && finished && finished !== 'tool-calls' && String(lastUser.info.id) < String(lastAssistant.info.id)) break;
      const message = assistant(session, String(lastUser.info.id));
      loop.current = message;
      addPart(message, { type: 'step-start' });
      await runStep(session, loop, message, lastUser, step);
    }
  } catch (error) {
    if (error instanceof Aborted) {
      if (loop.current) {
        loop.current.info.error = { name: 'MessageAbortedError', data: { message: 'The operation was aborted.' } };
        publish('message.updated', { info: loop.current.info });
        publish('session.error', { sessionID: session.id, error: loop.current.info.error });
      }
    } else {
      log({ loopError: String(error) });
    }
  } finally {
    loops.delete(session.id);
    setStatus(session.id, { type: 'idle' });
  }
}

// ---- HTTP ----

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const notFound = (res: ServerResponse, what: string) => json(res, 404, { name: 'NotFoundError', data: { message: `Resource not found: ${what}` } });

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let text = '';
    req.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8');
    });
    req.on('end', () => {
      try {
        resolve(text ? (JSON.parse(text) as unknown) : undefined);
      } catch {
        resolve(text);
      }
    });
  });
}

const expected = `Basic ${Buffer.from(`${process.env.OPENCODE_SERVER_USERNAME ?? 'opencode'}:${process.env.OPENCODE_SERVER_PASSWORD ?? ''}`).toString('base64')}`;

const providers = {
  providers: [
    {
      id: 'opencode',
      name: 'OpenCode',
      models: {
        'big-pickle': { id: 'big-pickle', providerID: 'opencode', variants: { low: {}, medium: {}, high: {} } },
        'plain-free': { id: 'plain-free', providerID: 'opencode', variants: {} },
      },
    },
  ],
  default: { opencode: 'big-pickle' },
};

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const body = await readBody(req);
    const authorized = req.headers.authorization === expected;
    const directory = decodeURIComponent(String(req.headers['x-opencode-directory'] ?? ''));
    log({ method: req.method, path: url.pathname, directory, authorized, body: body ?? null });
    if (!authorized || !process.env.OPENCODE_SERVER_PASSWORD) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="Secure Area"' });
      res.end('Unauthorized');
      return;
    }
    const parts = url.pathname.split('/').filter(Boolean);
    const route = `${req.method} /${parts.map((part, index) => (index > 0 && /^(ses|per|que)_/.test(part) ? ':id' : part)).join('/')}`;
    const id = parts.find((part) => /^(ses|per|que)_/.test(part)) ?? '';
    const input = typeof body === 'object' && body !== null ? (body as Json) : {};
    switch (route) {
      case 'GET /event':
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write(`data: ${JSON.stringify({ type: 'server.connected', properties: {} })}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      case 'GET /agent':
        return json(res, 200, [
          { name: 'build', mode: 'primary', native: true },
          { name: 'plan', mode: 'primary', native: true },
          { name: 'general', mode: 'subagent', native: true },
        ]);
      case 'GET /config/providers':
        return json(res, 200, providers);
      case 'POST /session': {
        const session: Session = { id: nextId('ses'), title: String(input.title ?? 'New session'), directory: directory || process.cwd(), messages: [], note: '' };
        sessions.set(session.id, session);
        const info = { id: session.id, title: session.title, directory: session.directory };
        publish('session.created', { info });
        return json(res, 200, info);
      }
      case 'GET /session/:id': {
        const session = sessions.get(id);
        return session ? json(res, 200, { id: session.id, title: session.title, directory: session.directory }) : notFound(res, id);
      }
      case 'GET /session/:id/message': {
        const session = sessions.get(id);
        return session ? json(res, 200, session.messages) : notFound(res, id);
      }
      case 'GET /session/:id/children':
        return json(res, 200, [...sessions.values()].filter((session) => session.parentID === id).map((session) => ({ id: session.id, parentID: id })));
      case 'POST /session/:id/prompt_async': {
        // Like OpenCode: accepted at once, the message is stored and the loop started afterwards.
        res.writeHead(204);
        res.end();
        const session = sessions.get(id);
        if (!session) return;
        await pause(3);
        const extra: Json = { agent: input.agent ?? 'build', model: input.model ?? { providerID: 'opencode', modelID: 'big-pickle' } };
        if (input.system !== undefined) extra.system = input.system;
        if (input.variant !== undefined) extra.variant = input.variant;
        const sent = Array.isArray(input.parts) ? (input.parts as Json[]) : [];
        const message = addUser(
          session,
          sent.map((part) => ({ type: 'text', text: String(part.text ?? ''), ...(part.synthetic === true ? { synthetic: true } : {}) })),
          extra,
        );
        if (input.noReply === true) {
          steered.add(String(message.info.id));
          return;
        }
        void runLoop(session);
        return;
      }
      case 'POST /session/:id/abort':
        loops.get(id)?.controller.abort();
        return json(res, 200, true);
      case 'DELETE /session/:id':
        return json(res, 200, sessions.delete(id));
      case 'POST /permission/:id/reply': {
        const resolve = permissions.get(id);
        permissions.delete(id);
        if (resolve) {
          publish('permission.replied', { sessionID: '', requestID: id, reply: input.reply });
          resolve(input);
        }
        return json(res, 200, true);
      }
      case 'POST /question/:id/reply': {
        const resolve = questions.get(id);
        questions.delete(id);
        if (resolve) {
          publish('question.replied', { sessionID: '', requestID: id, answers: input.answers });
          resolve(Array.isArray(input.answers) ? (input.answers as string[][]) : []);
        }
        return json(res, 200, true);
      }
      case 'POST /question/:id/reject': {
        const resolve = questions.get(id);
        questions.delete(id);
        if (resolve) {
          publish('question.rejected', { sessionID: '', requestID: id });
          resolve(undefined);
        }
        return json(res, 200, true);
      }
      default:
        return notFound(res, url.pathname);
    }
  })();
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address() as AddressInfo;
  process.stdout.write(`opencode server listening on http://127.0.0.1:${port}\n`);
});
