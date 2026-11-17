// Live check of the OpenCode engine with the real OpenCode CLI (`opencode serve`). It never uses a
// paid model: it asks a free OpenCode model first (opencode/big-pickle, or the one named), and when
// that model cannot answer (the free models share a daily limit, after which OpenCode is told to wait
// until midnight UTC) or with --scripted, it runs the checks against a scripted model this script
// serves on 127.0.0.1. That model is OpenAI-compatible and reaches OpenCode only through
// OPENCODE_CONFIG_CONTENT in the environment of the OpenCode it starts. Either way the real OpenCode
// runs every step: its server, sessions, the permission request, the write tool, resuming, aborting.
//
//   node scripts/opencode-check.ts [provider/model] [--scripted]
//
// It works in a throwaway git repository it creates itself, with a canonical path (a Windows short
// path such as C:\Users\ABCDEF~1 confuses agents), in permission mode "default", and approves every
// request, printing it. Afterwards it deletes the OpenCode sessions it created and the repository.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenCodeEngine } from '../src/core/engines/opencode.ts';
import type { AskUser, EngineEvent, EngineRunOptions, UserRequest } from '../src/core/engines/types.ts';

type Json = Record<string, unknown>;

const RUN_TIMEOUT_MS = 4 * 60_000;
const SCRIPTED = 'codebot-scripted/scripted';
const argv = process.argv.slice(2);
const forceScripted = argv.includes('--scripted');
const freeModel = argv.find((arg) => !arg.startsWith('--')) ?? 'opencode/big-pickle';

const engine = new OpenCodeEngine();
const repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'code-bot-opencode-live-')));
execFileSync('git', ['init', '-q'], { cwd: repo });
const sessions = new Set<string>();
const configDir = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'opencode');
const configFiles = ['opencode.json', 'opencode.jsonc', 'config.json'].map((name) => join(configDir, name));
const readConfig = () => configFiles.map((path) => (existsSync(path) ? readFileSync(path, 'utf8') : '(none)'));
const configBefore = readConfig();

const short = (text: string, limit = 160) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
};

let step = 0;
let failures = 0;
async function check(name: string, run: () => Promise<'skip' | void>): Promise<boolean> {
  step += 1;
  const started = Date.now();
  try {
    const outcome = await run();
    console.log(`  ${outcome === 'skip' ? 'skip' : 'ok  '} ${step}. ${name} (${Math.round((Date.now() - started) / 1000)}s)`);
    return outcome !== 'skip';
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${step}. ${name}`);
    console.log(`       ${error instanceof Error ? error.message : String(error)}`.replace(/\n/g, '\n       '));
    return false;
  }
}

/** Approves every request, printing each. */
function approveAll(requests: UserRequest[]): AskUser {
  return async (request) => {
    requests.push(request);
    if (request.kind === 'question') {
      const questions = (request.input as { questions?: { question: string; options?: { label: string }[] }[] }).questions ?? [];
      const answers = Object.fromEntries(questions.map((question) => [question.question, question.options?.[0]?.label ?? 'yes']));
      console.log(`       question: ${questions.map((question) => question.question).join(' / ')} -> ${Object.values(answers).join(', ')}`);
      return { decision: 'allow', answers };
    }
    console.log(`       approval (${request.tool}): ${short(request.summary ?? '')} ${short(JSON.stringify(request.input), 200)} -> allowed`);
    return { decision: 'allow' };
  };
}

interface Turn {
  sessionId: string | undefined;
  result: Extract<EngineEvent, { type: 'result' }>;
  events: EngineEvent[];
  endedAfterInterruptMs?: number;
}

/** One run; with `interruptAfterText`, it is interrupted once the agent starts writing (or after 20 s). */
async function turn(options: Omit<EngineRunOptions, 'cwd'>, askUser: AskUser, interruptAfterText = false): Promise<Turn & { sent: boolean }> {
  const run = engine.start({ cwd: repo, ...options }, askUser);
  const timer = setTimeout(() => void run.interrupt(), RUN_TIMEOUT_MS);
  const events: EngineEvent[] = [];
  let interruptedAt: number | undefined;
  const interrupt = () => {
    if (interruptedAt !== undefined) return;
    interruptedAt = Date.now();
    console.log('       interrupting');
    void run.interrupt();
  };
  const fallback = interruptAfterText ? setTimeout(interrupt, 20_000) : undefined;
  try {
    for await (const event of run.events) {
      events.push(event);
      if (event.type === 'session') {
        sessions.add(event.sessionId);
        console.log(`       session ${event.sessionId} on ${event.model ?? '(model not reported)'}`);
      }
      if (event.type === 'tool_use') console.log(`       tool: ${event.name} ${short(JSON.stringify(event.input))}`);
      if (interruptAfterText && event.type === 'text_delta') interrupt();
    }
  } finally {
    clearTimeout(timer);
    clearTimeout(fallback);
  }
  const session = events.find((event) => event.type === 'session');
  const result = events.findLast((event) => event.type === 'result');
  assert.ok(result && result.type === 'result', 'the run ended without a result');
  console.log(`       result: ${result.ok ? 'ok' : 'failed'}: ${short(result.ok ? result.text : (result.error ?? ''), 300)}`);
  return {
    sessionId: session?.type === 'session' ? session.sessionId : undefined,
    result,
    events,
    endedAfterInterruptMs: interruptedAt === undefined ? undefined : Date.now() - interruptedAt,
    sent: run.send('anything else?'),
  };
}

// ---- a scripted, OpenAI-compatible model on 127.0.0.1 ----

interface ChatMessage {
  role: string;
  content?: unknown;
  tool_calls?: { function?: { name?: string; arguments?: string } }[];
}

const contentText = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((part) => (typeof part === 'object' && part && 'text' in part ? String((part as { text: unknown }).text) : '')).join('\n')
      : '';

function readBody(req: IncomingMessage): Promise<Json> {
  return new Promise((resolve) => {
    let text = '';
    req.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8');
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(text) as Json);
      } catch {
        resolve({});
      }
    });
  });
}

/** Serves the scripted model; its answers depend only on the conversation OpenCode sends. */
async function serveScriptedModel(): Promise<{ baseURL: string; close: () => void }> {
  const server = createServer((req, res) => {
    void answer(req, res);
  });
  async function answer(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST' || !/\/chat\/completions$/.test(req.url ?? '')) {
      res.writeHead(404).end();
      return;
    }
    const body = await readBody(req);
    const messages = (Array.isArray(body.messages) ? body.messages : []) as ChatMessage[];
    const last = messages[messages.length - 1];
    const lastUser = contentText(messages.filter((message) => message.role === 'user').pop()?.content);
    const tools = (Array.isArray(body.tools) ? body.tools : []) as { function?: { name?: string } }[];
    const hasWrite = tools.some((entry) => entry.function?.name === 'write');
    const created = messages.some((message) => message.role === 'assistant' && (message.tool_calls ?? []).some((call) => /hello\.txt/.test(call.function?.arguments ?? '')));
    const stream = body.stream === true;
    let closed = false;
    res.on('close', () => {
      closed = true;
    });
    const send = (delta: Json, finish: string | null = null) => {
      const chunk = { id: 'chatcmpl-scripted', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'scripted', choices: [{ index: 0, delta, finish_reason: finish }] };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    };
    const end = () => {
      const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };
      res.write(`data: ${JSON.stringify({ id: 'chatcmpl-scripted', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'scripted', choices: [], usage })}\n\n`);
      res.end('data: [DONE]\n\n');
    };
    const reply = async (pieces: string[], delayMs = 0) => {
      if (!stream) {
        const message = { role: 'assistant', content: pieces.join('') };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'chatcmpl-scripted', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: 'scripted', choices: [{ index: 0, message, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      send({ role: 'assistant', content: '' });
      for (const piece of pieces) {
        if (closed) return;
        send({ content: piece });
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      send({}, 'stop');
      end();
    };
    if (last?.role === 'tool') {
      await reply(['Created ', 'hello.txt.']);
    } else if (/create a file named hello\.txt/i.test(lastUser) && hasWrite && stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const args = JSON.stringify({ filePath: join(repo, 'hello.txt'), content: 'hello' });
      send({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: `call_${randomBytes(4).toString('hex')}`, type: 'function', function: { name: 'write', arguments: args } }] });
      send({}, 'tool_calls');
      end();
    } else if (/what file did you create/i.test(lastUser)) {
      await reply([created ? 'hello.txt' : 'I have not created any file.']);
    } else if (/count from 1/i.test(lastUser)) {
      // Slow on purpose: the check interrupts it.
      await reply(Array.from({ length: 300 }, (_, index) => `${index + 1}\n`), 200);
    } else if (/pong/i.test(lastUser)) {
      await reply(['pong']);
    } else {
      await reply(['OK.']);
    }
  }
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { baseURL: `http://127.0.0.1:${port}/v1`, close: () => server.close() };
}

// ---- cleanup: OpenCode's sessions, through a short-lived server of its own ----

async function deleteSessions(): Promise<void> {
  const [first] = sessions;
  const command = first ? engine.resumeCommand(first)?.command : undefined;
  if (!command || /\.(cmd|bat)$/i.test(command)) return;
  const password = randomBytes(18).toString('base64url');
  const child = spawn(command, ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
    cwd: repo,
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: password, OPENCODE_SERVER_USERNAME: 'code-bot' },
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  try {
    const base = await new Promise<string | undefined>((resolve) => {
      let banner = '';
      const timer = setTimeout(() => resolve(undefined), 30_000);
      child.stdout?.on('data', (chunk: Buffer) => {
        banner += chunk.toString('utf8');
        const match = /listening on (https?:\/\/\S+)/.exec(banner);
        if (match?.[1]) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      child.once('exit', () => resolve(undefined));
    });
    if (!base) return;
    const headers = { authorization: `Basic ${Buffer.from(`code-bot:${password}`).toString('base64')}`, 'x-opencode-directory': encodeURIComponent(repo) };
    for (const id of sessions) {
      const response = await fetch(`${base}/session/${id}`, { method: 'DELETE', headers }).catch(() => undefined);
      console.log(response?.ok ? `       deleted OpenCode session ${id}` : `       could not delete OpenCode session ${id}`);
    }
  } finally {
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once('exit', () => resolve());
    });
    try {
      if (process.platform === 'win32' && child.pid !== undefined) execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      else child.kill();
    } catch {
      // Already gone.
    }
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
  }
}

// ---- the checks ----

let model = freeModel;
let scripted: { baseURL: string; close: () => void } | undefined;
let note = '';
try {
  const ready = await check('OpenCode is installed (check)', async () => {
    const status = await engine.check();
    console.log(`       ${status.detail}`);
    assert.ok(status.ready, 'OpenCode is not ready');
  });
  if (ready) await modelChecks();
} finally {
  scripted?.close();
  await deleteSessions().catch((error: unknown) => console.log(`       could not delete the sessions: ${String(error)}`));
  // Windows lets go of a stopped process's working folder a moment after it exits.
  try {
    rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (error) {
    console.log(`       could not remove ${repo}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(
  failures === 0
    ? `All OpenCode checks passed (model ${model}${note ? `; ${note}` : ''}).`
    : `${failures} OpenCode check(s) failed (model ${model}).`,
);
process.exitCode = failures === 0 ? 0 : 1;

async function useScriptedModel(): Promise<void> {
  scripted = await serveScriptedModel();
  let existing: Json = {};
  try {
    existing = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? '{}') as Json;
  } catch {
    existing = {};
  }
  const providers = typeof existing.provider === 'object' && existing.provider ? (existing.provider as Json) : {};
  process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    ...existing,
    provider: {
      ...providers,
      'codebot-scripted': {
        npm: '@ai-sdk/openai-compatible',
        name: 'code-bot live check (scripted)',
        options: { baseURL: scripted.baseURL, apiKey: 'not-needed' },
        models: { scripted: { name: 'Scripted', tool_call: true, limit: { context: 64000, output: 4096 } } },
      },
    },
    small_model: SCRIPTED,
  });
  model = SCRIPTED;
  console.log(`       using the scripted model at ${scripted.baseURL}`);
}

async function modelChecks(): Promise<void> {
  if (forceScripted) {
    await useScriptedModel();
  } else {
    await check(`the free model ${freeModel} answers`, async () => {
      const { result } = await turn({ prompt: 'Reply with the single word: pong', model: freeModel, permissionMode: 'default' }, approveAll([]));
      if (result.ok) return;
      note = `${freeModel} could not answer: ${short(result.error ?? '', 200)}`;
      const limited = /usage limit|rate limit|too many requests|quota/i.test(result.error ?? '');
      await useScriptedModel();
      if (limited) return 'skip';
      throw new Error(result.error ?? 'the turn failed');
    });
  }

  let sessionId: string | undefined;
  await check('a new session creates hello.txt, asking first (permission mode "default")', async () => {
    const requests: UserRequest[] = [];
    const { sessionId: id, result } = await turn(
      { prompt: 'Create a file named hello.txt in the current folder containing exactly the word hello. Do nothing else.', model, permissionMode: 'default' },
      approveAll(requests),
    );
    sessionId = id;
    assert.ok(sessionId, 'no session id');
    assert.ok(result.ok, `the turn failed: ${result.error}`);
    assert.ok(existsSync(join(repo, 'hello.txt')), 'hello.txt was not created');
    assert.match(readFileSync(join(repo, 'hello.txt'), 'utf8'), /^\s*hello\s*$/);
    assert.ok(requests.some((request) => request.kind === 'permission'), 'no approval was asked for in "default" mode');
  });

  await check('resuming the session: it remembers the file it created', async () => {
    assert.ok(sessionId, 'there is no session to resume');
    const { sessionId: id, result } = await turn(
      { prompt: 'What file did you create? Answer with the file name only.', model, permissionMode: 'default', resumeSessionId: sessionId },
      approveAll([]),
    );
    assert.equal(id, sessionId, 'the run did not continue the same session');
    assert.ok(result.ok, `the turn failed: ${result.error}`);
    assert.match(result.text, /hello\.txt/i);
  });

  await check('interrupting a longer turn ends the run cleanly', async () => {
    assert.ok(sessionId, 'there is no session to resume');
    const { result, endedAfterInterruptMs, sent } = await turn(
      { prompt: 'Count from 1 to 300, one number per line, then say done.', model, permissionMode: 'default', resumeSessionId: sessionId },
      approveAll([]),
      true,
    );
    assert.ok(endedAfterInterruptMs !== undefined, 'the run ended before it could be interrupted');
    console.log(`       the run ended ${endedAfterInterruptMs} ms after interrupt()`);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'Interrupted.');
    assert.ok(endedAfterInterruptMs < 15_000, 'the run took too long to end');
    assert.equal(sent, false, 'send() still accepted a message after the run ended');
  });

  await check("the user's OpenCode config files are unchanged", async () => {
    assert.deepEqual(readConfig(), configBefore);
  });
}
