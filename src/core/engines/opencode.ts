/**
 * Runs OpenCode (opencode.ai) as a sub-agent through `opencode serve`: OpenCode's headless HTTP
 * server, with its bus read as server-sent events (GET /event). Shapes follow the server's OpenAPI
 * document (GET /doc) and source for OpenCode 1.1.33.
 *
 * Why serve and not `opencode acp` (Agent Client Protocol over stdio): in 1.1.33 the ACP bridge is
 * itself a client of this same HTTP server, which it starts on 127.0.0.1 without a password; it does
 * not pass on OpenCode's question tool (a question would wait forever) and reports no cost. The
 * server offers everything directly: a model, agent, system prompt and variant per message, stored
 * sessions to continue by id, permission and question requests that wait for an answer, abort, and
 * the cost of every model call. code-bot starts it on 127.0.0.1, on a port the OS picks, with a
 * random password (HTTP basic auth), so nothing else on the machine can use it.
 *
 * One server per run, started in the run's folder: open the session (POST /session, or GET
 * /session/:id to continue one), send the prompt (POST /session/:id/prompt_async) and follow the
 * events until the session is idle. Messages that arrive in between start another turn in the same
 * session; once a turn ends with nothing queued the server is stopped (with what it started: the
 * process tree on Windows, its process group elsewhere). Unlike an agent on stdio, `opencode serve`
 * does not notice when code-bot itself dies, so only a run that ends normally or is interrupted
 * stops it. Sessions are OpenCode's own (shared with the user's OpenCode), so
 * `opencode --session <id>` continues one in a terminal.
 *
 *   our session id (POST /session or GET /session/:id)    → session, sent once the first message
 *                                                           shows which model OpenCode uses
 *   message.part.updated, text part with a delta          → text_delta
 *   message.part.updated, text part that has ended        → text
 *   message.part.updated, tool part running, then completed or failed
 *                                                         → tool_use, tool_result
 *   session.idle                                          → result (text: the turn's last message)
 *   permission.asked (also from sub-sessions of ours)     → askUser permission → POST /permission/:id/reply
 *   question.asked (OpenCode's question tool)             → askUser question (AskUserQuestion)
 *                                                           → POST /question/:id/reply
 *   send()                                                → steers the running turn: a message sent with
 *                                                           noReply, which OpenCode's loop reads before its
 *                                                           next model call; otherwise the next turn
 *   interrupt()                                           → POST /session/:id/abort, then the server stops
 *
 * Settings per run: the model ("provider/model", checked against GET /config/providers), the agent
 * (`plan` in plan mode, else `build`), `instructions` as the message's `system` text (OpenCode appends
 * it to its own system prompt), and `effort` as the model's variant of that name (OpenCode's
 * reasoning-effort presets, e.g. low/medium/high) when the model has one; otherwise effort is ignored,
 * as it is without an explicit model. maxTurns counts model calls in a turn (step-start parts) and
 * aborts the turn when the model starts one more; maxBudgetUsd aborts it once the cost of this run's
 * messages (OpenCode prices them from models.dev) passes the budget. costUsd is the session's total
 * cost, sub-sessions included.
 *
 * OpenCode retries failing model calls forever (rate limits wait as long as the provider says; the
 * free models' daily limit waits until midnight UTC), so a retry that would wait over two minutes, or
 * the eighth retry in a row, ends the turn with OpenCode's reason.
 *
 * Approval inputs hold only what identifies the action (the command and its folder, the file and
 * its diff, the folders outside the project); OpenCode's description goes in the summary. code-bot
 * recognises an approval given after a restart by tool and input. OpenCode starts a tool as soon as
 * the model has written the call, so a permission request can arrive just before the event that
 * shows the call; it waits briefly for that event, which has the command as written. A refusal is
 * sent with a reason (OpenCode stops the whole turn on a refusal without one), so the agent hears
 * it and carries on, as with the other engines.
 *
 * Credentials are whatever OpenCode finds on this machine (`opencode auth login`, provider
 * environment variables); code-bot never sees them. The user's OpenCode config files are never
 * written: the permission mode reaches OpenCode through the server's environment (see
 * permissionRules).
 */
import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { accessSync, constants, existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';
import { clip, errorMessage, titleFrom } from '../util.ts';
import type {
  AskUser,
  Engine,
  EngineCheck,
  EngineEvent,
  EngineRun,
  EngineRunOptions,
  TerminalCommand,
  UserRequest,
  UserResponse,
} from './types.ts';

type Json = Record<string, unknown>;
type ResultEvent = Extract<EngineEvent, { type: 'result' }>;

const PERMISSION_MODES = ['plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions'];
const QUESTION_TOOL = 'AskUserQuestion';
const PREVIEW_LIMIT = 2000;
const STDERR_LIMIT = 4000;
const START_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const CHECK_TIMEOUT_MS = 15_000;
const MODELS_TIMEOUT_MS = 30_000;
const FORCE_KILL_MS = 5000;
/** How long OpenCode may take to turn a prompt into a stored message. */
const ACCEPT_TIMEOUT_MS = 60_000;
/** How long, at the end of a turn, to wait for messages that were just sent to show up. */
const STEER_CONFIRM_MS = 10_000;
/** How long a permission request waits for the tool call it is about to show up. */
const CALL_WAIT_MS = 2000;
const RETRY_WAIT_LIMIT_MS = 2 * 60_000;
const RETRY_ATTEMPT_LIMIT = 8;
/** Basic-auth user name for the server (the password is random per run). */
const SERVER_USER = 'code-bot';
const NOT_INSTALLED =
  'OpenCode is not installed: there is no "opencode" program on PATH. Install it (npm install -g opencode-ai), or set CODE_BOT_OPENCODE_EXECUTABLE to its path.';
const DECLINED = 'The request was declined.';
const UNANSWERED = 'The user did not answer; use your own judgement.';
/** Sent (hidden from OpenCode's own interface) when OpenCode finished without reading a message. */
const NUDGE = 'I sent you a message just as you were finishing. Please address it.';
const SESSION_ID = /^ses_[A-Za-z0-9]+$/;

/** Effort names and the model variants that stand in for them, best first. */
const VARIANTS: Record<string, string[]> = {
  minimal: ['minimal', 'low'],
  low: ['low', 'minimal'],
  medium: ['medium'],
  high: ['high'],
  xhigh: ['xhigh', 'max', 'high'],
  max: ['max', 'xhigh', 'high'],
};

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const records = (value: unknown): Json[] => list(value).filter(isRecord);
const preview = (text: string): string => clip(text, PREVIEW_LIMIT);
const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const textPart = (text: string): Json => ({ type: 'text', text });

/** "provider/model" split at the first slash (model ids may contain slashes). */
function splitModel(model: string): { providerID: string; modelID: string } | undefined {
  const slash = model.indexOf('/');
  if (slash <= 0 || slash === model.length - 1) return undefined;
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

/**
 * code-bot's permission modes (strictest first) as OpenCode permission rules:
 *   plan               the `plan` agent, with edits and commands denied (also its plan files);
 *                      OpenCode then leaves those tools out altogether: it reads, searches and answers
 *   default            edits and commands ask first
 *   acceptEdits, auto  edits run freely, commands ask first (OpenCode has no automatic reviewer)
 *   bypassPermissions  everything OpenCode would ask about is allowed, also files outside the
 *                      project folders, `.env` files and the repeated-call ("doom loop") check
 * In every mode the additionalDirectories are allowed as folders outside the project; other
 * folders ask first, as OpenCode's own default does.
 *
 * The rules go in OPENCODE_PERMISSION in the server's environment, which OpenCode merges into its
 * permission config after reading every config file. They apply to every agent, so sub-agents that
 * OpenCode starts itself follow them too. Where the user's own permission config names the same
 * permission, code-bot's rule replaces it; rules the user gives a single agent (agent.<name>.permission)
 * are applied after these and still hold.
 */
function permissionRules(mode: string, additionalDirectories: string[] | undefined): Json {
  const outside: Json = {};
  for (const dir of additionalDirectories ?? []) {
    outside[dir] = 'allow';
    outside[join(dir, '*')] = 'allow';
  }
  const withFolders = (rules: Json): Json => (Object.keys(outside).length > 0 ? { ...rules, external_directory: outside } : rules);
  switch (mode) {
    case 'plan':
      return withFolders({ edit: 'deny', bash: 'deny' });
    case 'acceptEdits':
    case 'auto':
      return withFolders({ edit: 'allow', bash: 'ask' });
    case 'bypassPermissions':
      return {
        edit: 'allow',
        bash: 'allow',
        read: 'allow',
        external_directory: 'allow',
        doom_loop: 'allow',
        webfetch: 'allow',
        websearch: 'allow',
        codesearch: 'allow',
        task: 'allow',
        skill: 'allow',
        glob: 'allow',
        grep: 'allow',
        list: 'allow',
        lsp: 'allow',
        todowrite: 'allow',
        todoread: 'allow',
      };
    default:
      return withFolders({ edit: 'ask', bash: 'ask' });
  }
}

// ---- finding and starting the opencode program -------------------------------------------------

interface Launcher {
  file: string;
  /** Arguments before OpenCode's own, when OpenCode runs through another program. */
  args: string[];
  /** A .cmd or .bat shim, which only runs through cmd.exe. */
  shell: boolean;
}

function isProgram(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (process.platform !== 'win32') accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The native binary that the opencode-ai npm package installs for this platform, found as the
 * package's own launcher (bin/opencode) finds it: in node_modules folders from the package upwards.
 */
function platformBinary(packageDir: string): string | undefined {
  if (!existsSync(packageDir)) return undefined;
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  const base = `opencode-${platform}-${process.arch}`;
  const binary = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
  let dir = join(packageDir, 'bin');
  for (;;) {
    let entries: string[];
    try {
      entries = readdirSync(join(dir, 'node_modules'));
    } catch {
      entries = [];
    }
    // The plain build first; "-baseline" and "-musl" builds after it.
    const names = entries
      .filter((entry) => entry === base || entry.startsWith(`${base}-`))
      .sort((a, b) => (a === base ? -1 : b === base ? 1 : a.localeCompare(b)));
    for (const name of names) {
      const path = join(dir, 'node_modules', name, 'bin', binary);
      if (isProgram(path)) return path;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** The native binary behind an npm shim or launcher (opencode.cmd, or a link to bin/opencode). */
function nativeBehind(program: string): string | undefined {
  let real = program;
  try {
    real = realpathSync(program);
  } catch {
    // Use the path as given.
  }
  const packages: string[] = [];
  if (basename(dirname(real)) === 'bin' && basename(dirname(dirname(real))) === 'opencode-ai') packages.push(dirname(dirname(real)));
  // npm on Windows: <prefix>\opencode.cmd next to <prefix>\node_modules\opencode-ai.
  packages.push(join(dirname(program), 'node_modules', 'opencode-ai'));
  // npm elsewhere: <prefix>/bin/opencode and <prefix>/lib/node_modules/opencode-ai.
  packages.push(join(dirname(dirname(program)), 'lib', 'node_modules', 'opencode-ai'));
  for (const dir of packages) {
    const binary = platformBinary(dir);
    if (binary) return binary;
  }
  return undefined;
}

function findOpenCode(): string | undefined {
  const windows = process.platform === 'win32';
  // The variable OpenCode's own npm launcher honours.
  const pinned = process.env.OPENCODE_BIN_PATH?.trim();
  if (pinned && isProgram(pinned)) return pinned;
  const dirs = (process.env.PATH ?? '')
    .split(delimiter)
    .map((dir) => dir.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
  // Native binaries first: an npm install puts an opencode.cmd shim on PATH.
  const names = windows ? ['opencode.exe', 'opencode.cmd', 'opencode.bat'] : ['opencode'];
  for (const name of names) {
    for (const dir of dirs) {
      const path = join(dir, name);
      if (isProgram(path)) return nativeBehind(path) ?? path;
    }
  }
  // Where the install script, npm and Homebrew put it, for apps started without the shell's PATH.
  const home = homedir();
  const known = windows
    ? [
        join(home, '.opencode', 'bin', 'opencode.exe'),
        join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'npm', 'opencode.cmd'),
      ]
    : [
        join(home, '.opencode', 'bin', 'opencode'),
        '/opt/homebrew/bin/opencode',
        '/usr/local/bin/opencode',
        join(home, '.local', 'bin', 'opencode'),
      ];
  for (const path of known) {
    if (isProgram(path)) return nativeBehind(path) ?? path;
  }
  return undefined;
}

/** Quotes for cmd.exe; only fixed arguments and paths ever pass through it. */
const quote = (value: string): string => (/[\s&()^|<>]/.test(value) ? `"${value}"` : value);

function launch(launcher: Launcher, args: string[], options: SpawnOptions): ChildProcess {
  const all = [...launcher.args, ...args];
  if (launcher.shell) {
    const commandLine = [launcher.file, ...all].map(quote).join(' ');
    return spawn(commandLine, { ...options, shell: true, windowsHide: true });
  }
  return spawn(launcher.file, all, { ...options, windowsHide: true });
}

/** Stops the process and what it started (a shell's child, language servers, MCP servers, commands). */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    killer.once('error', () => child.kill());
    return;
  }
  try {
    // The server runs in its own process group (detached), so the group goes with it.
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

/** Resolves with the promise's value, or with undefined after `ms`. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), Math.max(0, ms));
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

interface Captured {
  code: number | null;
  output: string;
  error?: string;
}

/** Runs a short opencode command and collects what it prints. */
function capture(launcher: Launcher, args: string[], timeoutMs = CHECK_TIMEOUT_MS): Promise<Captured> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = launch(launcher, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ code: null, output: '', error: errorMessage(error) });
      return;
    }
    let output = '';
    let settled = false;
    const finish = (result: Captured) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      killTree(child, 'SIGKILL');
      finish({ code: null, output, error: `no answer within ${timeoutMs / 1000} s` });
    }, timeoutMs);
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(0, 64 * 1024);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.once('error', (error) => finish({ code: null, output, error: error.message }));
    child.once('close', (code) => finish({ code, output: stripAnsi(output) }));
  });
}

// ---- small async helpers ------------------------------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  settled: () => boolean;
}

function deferred<T>(): Deferred<T> {
  let done = false;
  let resolveIt: (value: T) => void = () => undefined;
  let rejectIt: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolveIt = resolve;
    rejectIt = reject;
  });
  promise.catch(() => undefined);
  return {
    promise,
    resolve: (value) => {
      if (done) return;
      done = true;
      resolveIt(value);
    },
    reject: (error) => {
      if (done) return;
      done = true;
      rejectIt(error);
    },
    settled: () => done,
  };
}

/** Server-sent events as JSON objects; ends when the stream does. */
async function* serverEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<Json> {
  const decoder = new TextDecoder();
  let pending = '';
  for await (const chunk of body) {
    pending += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    let end = pending.indexOf('\n\n');
    while (end >= 0) {
      const block = pending.slice(0, end);
      pending = pending.slice(end + 2);
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n');
      if (data) {
        try {
          const event: unknown = JSON.parse(data);
          if (isRecord(event)) yield event;
        } catch {
          // Not JSON: nothing code-bot can use.
        }
      }
      end = pending.indexOf('\n\n');
    }
  }
}

/** Events for the consumer, buffered until it asks for them. */
class EventQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private waiter: ((result: IteratorResult<T>) => void) | undefined;
  private ended = false;
  private readonly onCancel: () => void;

  constructor(onCancel: () => void) {
    this.onCancel = onCancel;
  }

  push(item: T): void {
    if (this.ended) return;
    const resolve = this.waiter;
    this.waiter = undefined;
    if (resolve) resolve({ value: item, done: false });
    else this.items.push(item);
  }

  end(): void {
    this.ended = true;
    const resolve = this.waiter;
    this.waiter = undefined;
    resolve?.({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length > 0) return Promise.resolve({ value: this.items.shift() as T, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
      return: () => {
        // The consumer stopped listening: nobody will see the rest, so stop the agent.
        this.items.length = 0;
        if (!this.ended) {
          this.ended = true;
          this.onCancel();
        }
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

// ---- questions and approvals --------------------------------------------------------------------

/** Question texts made unique: answers come back keyed by them. */
function uniqueTexts(texts: string[]): string[] {
  const seen = new Map<string, number>();
  return texts.map((text) => {
    const count = (seen.get(text) ?? 0) + 1;
    seen.set(text, count);
    return count === 1 ? text : `${text} (${count})`;
  });
}

/** The answer to one question, whichever way the answerer keyed it. */
function answerFor(response: UserResponse, keys: string[], onlyQuestion: boolean): string | undefined {
  if (response.decision !== 'allow') return undefined;
  const answers = response.answers ?? {};
  for (const key of keys) {
    const answer = answers[key];
    if (key && answer !== undefined) return answer;
  }
  const values = Object.values(answers);
  return onlyQuestion && values.length === 1 ? values[0] : undefined;
}

/** A multiple-choice answer ("A, B") as the option labels, when it is made of them. */
function labelsOf(answer: string, options: string[]): string[] {
  const pieces = answer
    .split(/\s*,\s*/)
    .map((piece) => piece.trim())
    .filter(Boolean);
  const labels = pieces.map((piece) => options.find((option) => option.toLowerCase() === piece.toLowerCase()));
  return pieces.length > 0 && labels.every((label) => label !== undefined) ? (labels as string[]) : [answer];
}

interface ToolCall {
  tool: string;
  input: Json;
  /** The model has finished writing the call: its input is complete. */
  ready: boolean;
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/** What a permission request asks, as code-bot shows it and recognises it again after a restart. */
function approvalFor(request: Json, call: ToolCall | undefined): UserRequest {
  const permission = str(request.permission);
  const patterns = list(request.patterns).map(String);
  const metadata = isRecord(request.metadata) ? request.metadata : {};
  const first = patterns[0] ?? '';
  const ask = (tool: string, input: Json, summary?: string): UserRequest => ({
    kind: 'permission',
    tool,
    input,
    ...(summary ? { summary } : {}),
  });
  switch (permission) {
    case 'bash': {
      const command = str(call?.input.command) || patterns.join(' && ');
      const workdir = str(call?.input.workdir);
      return ask('bash', workdir ? { command, workdir } : { command }, str(call?.input.description) || undefined);
    }
    case 'edit': {
      const tool = call?.tool || 'edit';
      const diff = str(metadata.diff);
      const files = patterns.map((pattern) => basename(pattern)).join(', ');
      const input = patterns.length > 1 || tool === 'apply_patch' ? { paths: patterns, diff } : { path: str(metadata.filepath) || first, diff };
      return ask(tool, input, `${tool === 'write' ? 'Write' : 'Change'} ${files || 'files'}`);
    }
    case 'external_directory':
      return ask(
        'external_directory',
        { paths: patterns },
        `${call?.tool ? `${call.tool}: ` : ''}use ${str(metadata.filepath) || patterns.join(', ')}, outside the project folders`,
      );
    case 'doom_loop': {
      const tool = str(metadata.tool) || first;
      return ask('doom_loop', { tool, input: metadata.input ?? {} }, `${tool} was called three times in a row with the same input. Let it go on?`);
    }
    case 'read':
      return ask('read', { path: first }, `Read ${basename(first)}`);
    case 'webfetch':
      return ask('webfetch', { url: first }, `Fetch ${first}`);
    case 'websearch':
    case 'codesearch':
      return ask(permission, { query: first });
    case 'task':
      return ask('task', { agent: first, prompt: str(call?.input.prompt) }, str(call?.input.description) || undefined);
    default: {
      // Other tools (MCP tools ask under their own name): the call's input identifies it.
      if (call && patterns.every((pattern) => pattern === '*')) {
        const { description, ...input } = call.input;
        return ask(call.tool || permission, input, str(description) || undefined);
      }
      return ask(call?.tool || permission, { patterns });
    }
  }
}

/** OpenCode's error objects ({ name, data: { message } }) as one line. */
function describeError(error: unknown): string {
  if (!isRecord(error)) return typeof error === 'string' && error ? error : 'OpenCode reported an error.';
  const name = str(error.name);
  const data = isRecord(error.data) ? error.data : {};
  const message = str(data.message) || str(error.message);
  switch (name) {
    case 'ProviderAuthError':
      return `${message || 'The provider refused the credentials.'} Sign in with "opencode auth login"${str(data.providerID) ? ` (provider ${str(data.providerID)})` : ''}.`;
    case 'MessageOutputLengthError':
      return 'The answer was cut off at the model’s output limit.';
    case 'MessageAbortedError':
      return 'Interrupted.';
    case 'APIError': {
      const status = num(data.statusCode);
      return status ? `${message || 'The model provider returned an error.'} (HTTP ${status})` : message || 'The model provider returned an error.';
    }
    default:
      return message || name || 'OpenCode reported an error.';
  }
}

function describeWait(ms: number): string {
  if (ms >= 59.5 * 60_000) return `in ${Math.round(ms / 3_600_000)} h`;
  if (ms >= 90_000) return `in ${Math.round(ms / 60_000)} min`;
  return `in ${Math.max(1, Math.round(ms / 1000))} s`;
}

/** Sums of prices stay readable (0.05 + 0.01 is 0.060000000000000005 otherwise). */
const dollars = (amount: number): number => Math.round(amount * 1e9) / 1e9;

// ---- one run ------------------------------------------------------------------------------------

interface TurnState {
  startedAt: number;
  /** When a prompt was sent whose message OpenCode has not stored yet. */
  awaitingSince: number | undefined;
  /** The turn's first message is stored: later messages can steer it. */
  accepted: boolean;
  busy: boolean;
  /** OpenCode went idle: the turn is ending, and new messages wait for the next one. */
  ending: boolean;
  idle: Deferred<void>;
  aborting: boolean;
  modelCalls: number;
  error: string | undefined;
  /** The newest assistant message of the turn. */
  lastAssistant: string | undefined;
  /** Text parts of the turn, in order. */
  textParts: string[];
}

interface TextEntry {
  messageID: string;
  text: string;
  done: boolean;
}

interface Steer {
  text: string;
  /** The stored message, once it shows up. */
  messageId: string | undefined;
  failed: boolean;
}

interface Assistant {
  parentID: string;
  /** Compaction summaries: context for the model, not answers. */
  internal: boolean;
}

class OpenCodeRun implements EngineRun {
  readonly events: AsyncIterable<EngineEvent>;
  private readonly out: EventQueue<EngineEvent>;
  private readonly launcher: Launcher | undefined;
  private readonly problem: string | undefined;
  private readonly options: EngineRunOptions;
  private readonly askUser: AskUser;
  private readonly password = randomBytes(24).toString('base64url');
  private child: ChildProcess | undefined;
  /** Resolves, with what happened, once the server process is gone. */
  private gone: Promise<string> | undefined;
  private exited = false;
  private stderr = '';
  private base = '';
  private readonly stream = new AbortController();
  private readonly streamEnded = deferred<void>();
  private changeWaiters: (() => void)[] = [];
  private sessionId: string | undefined;
  private sessionReported = false;
  /** The model OpenCode said it uses ("provider/model"). */
  private modelName: string | undefined;
  private model: { providerID: string; modelID: string } | undefined;
  private agent: string | undefined;
  private variant: string | undefined;
  private system: string | undefined;
  /** Our session and the sub-sessions OpenCode started from it. */
  private readonly tree = new Set<string>();
  private readonly users = new Set<string>();
  private readonly assistants = new Map<string, Assistant>();
  private readonly texts = new Map<string, TextEntry>();
  /** Tool calls by call id, with their input, for permission requests about them. */
  private readonly calls = new Map<string, ToolCall>();
  private readonly reportedTools = new Set<string>();
  private readonly finishedTools = new Set<string>();
  /** Cost of each assistant message this run, sub-sessions included. */
  private readonly costs = new Map<string, number>();
  /** Cost of the session before this run; undefined when it could not be read. */
  private priorCost: number | undefined = 0;
  /** Requests put to the user, by OpenCode request id. */
  private readonly asking = new Map<string, AbortController>();
  private turn: TurnState | undefined;
  private lastTurn: TurnState | undefined;
  private queued: string[] = [];
  private steers: Steer[] = [];
  private accepting = true;
  private stopping = false;
  private finished = false;
  /** An abort OpenCode did not confirm: the server may still be busy, so no further turns. */
  private unsettled = false;
  private limit: 'turns' | 'budget' | undefined;
  private forceKill: ReturnType<typeof setTimeout> | undefined;

  constructor(launcher: Launcher | string, options: EngineRunOptions, askUser: AskUser) {
    this.launcher = typeof launcher === 'string' ? undefined : launcher;
    this.problem = typeof launcher === 'string' ? launcher : undefined;
    this.options = options;
    this.askUser = askUser;
    this.out = new EventQueue<EngineEvent>(() => {
      this.stopping = true;
      this.accepting = false;
      this.kill('SIGKILL');
    });
    this.events = this.out;
    void this.drive();
  }

  send(text: string): boolean {
    if (!this.accepting || this.stopping || this.finished) return false;
    const turn = this.turn;
    if (turn && turn.accepted && !turn.ending && this.sessionId) this.steer(text);
    else this.queued.push(text);
    return true;
  }

  async interrupt(): Promise<void> {
    if (this.finished || this.stopping) return;
    this.stopping = true;
    this.accepting = false;
    this.queued.length = 0;
    this.armForceKill();
    const turn = this.turn;
    if (!turn) return; // drive() notices `stopping` at its next step.
    await this.abortTurn(turn);
    // OpenCode had not started on the message yet: there is nothing to wait for.
    if (!turn.busy) turn.idle.resolve();
  }

  // ---- the run, start to end ----

  private async drive(): Promise<void> {
    let reported = false;
    try {
      if (!this.launcher) throw new Error(this.problem ?? NOT_INSTALLED);
      await this.startServer(this.launcher);
      await this.connect();
      if (this.stopping) throw new Error('Interrupted.');
      await this.prepare();
      if (this.stopping) throw new Error('Interrupted.');

      let texts = [this.options.prompt, ...this.queued.splice(0)];
      while (!this.stopping) {
        reported = false;
        const result = await this.runTurn(texts);
        this.reportSession();
        this.emit(result);
        reported = true;
        if (this.stopping || this.limit || this.unsettled) break;
        if (this.queued.length === 0) break;
        texts = this.queued.splice(0);
      }
      if (!reported) {
        reported = true;
        this.reportSession();
        this.emit({ type: 'result', ok: false, text: '', error: 'Interrupted.' });
      }
    } catch (error) {
      if (!reported) {
        reported = true;
        this.reportSession();
        this.emit(this.failure(error));
      }
    } finally {
      this.accepting = false;
      this.queued.length = 0;
      this.withdrawAll();
      await this.shutdown();
      this.finished = true;
      this.out.end();
    }
  }

  private async startServer(launcher: Launcher): Promise<void> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      OPENCODE_SERVER_USERNAME: SERVER_USER,
      OPENCODE_SERVER_PASSWORD: this.password,
      OPENCODE_PERMISSION: JSON.stringify(permissionRules(this.options.permissionMode ?? 'default', this.options.additionalDirectories)),
    };
    const child = launch(launcher, ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
      cwd: this.options.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Its own process group on macOS and Linux, so stopping it also stops what it started.
      detached: process.platform !== 'win32',
    });
    this.child = child;
    const listening = deferred<string>();
    let banner = '';
    const keep = (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-2 * STDERR_LIMIT);
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      if (listening.settled()) return keep(chunk);
      banner = (banner + chunk.toString('utf8')).slice(-8192);
      const match = /listening on (https?:\/\/[^\s"']+)/.exec(stripAnsi(banner));
      if (match?.[1]) listening.resolve(match[1].replace(/\/+$/, ''));
    });
    child.stderr?.on('data', keep);
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    this.gone = new Promise<string>((resolve) => {
      let done = false;
      const end = (what: string) => {
        if (done) return;
        done = true;
        // Read what the process wrote last before calling it gone. Programs it started can hold
        // its output open after it exits, so do not wait for that long.
        void within(closed, 500).then(() => {
          this.exited = true;
          clearTimeout(this.forceKill);
          listening.reject(new Error(what));
          resolve(what);
        });
      };
      child.once('error', (error) => end(`Could not start OpenCode (${launcher.file}): ${error.message}`));
      child.once('exit', (code, signal) =>
        end(signal ? `OpenCode stopped (${signal}).` : `OpenCode exited with code ${code ?? 'unknown'}.`),
      );
    });
    const url = await within(listening.promise, START_TIMEOUT_MS);
    if (!url) throw new Error(`OpenCode did not start its server within ${START_TIMEOUT_MS / 1000} s.`);
    this.base = url;
  }

  /** Follows the server's events; resolves once the stream is open. */
  private async connect(): Promise<void> {
    const connected = deferred<void>();
    void (async () => {
      try {
        const response = await fetch(`${this.base}/event`, { headers: this.headers(), signal: this.stream.signal });
        if (!response.ok || !response.body) throw new Error(`OpenCode refused its event stream (HTTP ${response.status}).`);
        for await (const event of serverEvents(response.body)) {
          if (event.type === 'server.connected') connected.resolve();
          this.onEvent(event);
        }
        connected.reject(new Error('OpenCode closed its event stream.'));
      } catch (error) {
        // The server stopped, or the run is closing the stream.
        connected.reject(new Error(`OpenCode's event stream failed: ${errorMessage(error)}`));
      } finally {
        this.streamEnded.resolve();
      }
    })();
    void this.gone?.then((what) => connected.reject(new Error(what)));
    const timer = setTimeout(
      () => connected.reject(new Error(`OpenCode did not open its event stream within ${START_TIMEOUT_MS / 1000} s.`)),
      START_TIMEOUT_MS,
    );
    try {
      await connected.promise;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Opens the session and works out the settings every message carries. */
  private async prepare(): Promise<void> {
    const options = this.options;
    const wanted = options.model?.trim() ? splitModel(options.model.trim()) : undefined;
    const [providers, agents] = await Promise.all([
      wanted ? this.call('GET', '/config/providers') : Promise.resolve(undefined),
      this.call('GET', '/agent'),
    ]);

    if (wanted) {
      const offered = records(isRecord(providers) ? providers.providers : undefined);
      const provider = offered.find((entry) => entry.id === wanted.providerID);
      const model = provider && isRecord(provider.models) ? provider.models[wanted.modelID] : undefined;
      if (!isRecord(model)) {
        const names = offered.flatMap((entry) => Object.keys(isRecord(entry.models) ? entry.models : {}).map((id) => `${str(entry.id)}/${id}`));
        const shown = names.slice(0, 12).join(', ');
        throw new Error(
          `OpenCode has no model "${options.model}". ${names.length > 0 ? `It offers ${shown}${names.length > 12 ? `, and ${names.length - 12} more` : ''} ("opencode models" lists them).` : 'It offers none: sign in to a provider with "opencode auth login".'}`,
        );
      }
      this.model = wanted;
      const variants = Object.keys(isRecord(model.variants) ? model.variants : {});
      const effort = options.effort?.trim();
      if (effort) this.variant = variants.includes(effort) ? effort : (VARIANTS[effort] ?? []).find((name) => variants.includes(name));
    }

    // The plan agent in plan mode (its prompt tells the model it may only read), build otherwise.
    const names = records(agents).map((agent) => str(agent.name));
    const preferred = options.permissionMode === 'plan' ? ['plan', 'build'] : ['build'];
    this.agent = preferred.find((name) => names.includes(name));

    const notes = [options.instructions?.trim() ?? ''];
    const folders = options.additionalDirectories ?? [];
    if (folders.length > 0) notes.push(`Besides ${options.cwd}, you may also work in these folders: ${folders.join(', ')}.`);
    this.system = notes.filter(Boolean).join('\n\n') || undefined;

    if (options.resumeSessionId) {
      const id = options.resumeSessionId;
      let session: unknown;
      try {
        session = await this.call('GET', `/session/${encodeURIComponent(id)}`);
      } catch (error) {
        throw new Error(`Could not continue OpenCode session ${id}: ${errorMessage(error)}`);
      }
      this.sessionId = str(isRecord(session) ? session.id : '') || id;
      this.tree.add(this.sessionId);
      this.priorCost = await this.sessionCost(this.sessionId, 0).catch(() => undefined);
    } else {
      // A title of our own also spares the model call OpenCode would make to write one.
      const session = await this.call('POST', '/session', { title: `code-bot: ${titleFrom(options.prompt)}` });
      const id = str(isRecord(session) ? session.id : '');
      if (!id) throw new Error('OpenCode did not say which session it opened.');
      this.sessionId = id;
      this.tree.add(id);
    }
  }

  /** What the session (and its sub-sessions) cost so far. */
  private async sessionCost(id: string, depth: number): Promise<number> {
    const messages = await this.call('GET', `/session/${encodeURIComponent(id)}/message`, undefined, 60_000);
    let total = 0;
    for (const message of records(messages)) {
      const info = isRecord(message.info) ? message.info : {};
      if (info.role === 'assistant') total += num(info.cost) ?? 0;
    }
    if (depth < 2) {
      const children = await this.call('GET', `/session/${encodeURIComponent(id)}/children`);
      for (const child of records(children)) {
        const childId = str(child.id);
        if (childId) total += await this.sessionCost(childId, depth + 1);
      }
    }
    return total;
  }

  private async runTurn(texts: string[]): Promise<ResultEvent> {
    const turn: TurnState = {
      startedAt: Date.now(),
      awaitingSince: undefined,
      accepted: false,
      busy: false,
      ending: false,
      idle: deferred<void>(),
      aborting: false,
      modelCalls: 0,
      error: undefined,
      lastAssistant: undefined,
      textParts: [],
    };
    this.turn = turn;
    this.lastTurn = turn;
    try {
      await this.postPrompt(turn, texts.map(textPart));
      for (let round = 0; ; round += 1) {
        await this.waitIdle(turn);
        if (this.stopping || this.limit || turn.error || turn.aborting) break;
        const missed = await this.missedSteers(turn);
        if (missed.length === 0 || this.stopping) break;
        if (round >= 2) {
          // OpenCode keeps finishing without reading them: they start the next turn.
          this.queued.push(...missed.map((steer) => steer.text));
          break;
        }
        // OpenCode finished just before a steering message was stored: ask it to answer that.
        turn.idle = deferred<void>();
        turn.busy = false;
        await this.postPrompt(turn, [{ ...textPart(NUDGE), synthetic: true }]);
      }
      return this.resultOf(turn);
    } finally {
      turn.ending = true;
      this.turn = undefined;
      this.flushTexts(turn);
      // Whatever this turn still waited for is moot now.
      this.withdrawAll();
      for (const steer of this.steers) if (!steer.failed && !steer.messageId) this.queued.push(steer.text);
      this.steers = [];
    }
  }

  private promptBody(parts: Json[], noReply: boolean): Json {
    const body: Json = { parts };
    if (this.agent) body.agent = this.agent;
    if (this.model) body.model = this.model;
    if (this.system) body.system = this.system;
    if (this.variant) body.variant = this.variant;
    if (noReply) body.noReply = true;
    return body;
  }

  private async postPrompt(turn: TurnState, parts: Json[]): Promise<void> {
    turn.awaitingSince = Date.now();
    await this.call('POST', `/session/${encodeURIComponent(this.sessionId ?? '')}/prompt_async`, this.promptBody(parts, false));
  }

  /**
   * A message for the running turn. OpenCode stores it (noReply: no loop of its own) and the
   * running loop reads it before its next model call. If the loop ended first, missedSteers sees it.
   */
  private steer(text: string): void {
    const steer: Steer = { text, messageId: undefined, failed: false };
    this.steers.push(steer);
    this.call('POST', `/session/${encodeURIComponent(this.sessionId ?? '')}/prompt_async`, this.promptBody([textPart(text)], true)).catch(() => {
      steer.failed = true;
      if (!this.stopping) this.queued.push(text);
    });
  }

  /** Waits for OpenCode to go idle. Fails when the server or its events go away, or a prompt is never taken up. */
  private async waitIdle(turn: TurnState): Promise<void> {
    const failed = deferred<void>();
    void this.gone?.then((what) => failed.reject(new Error(what)));
    void this.streamEnded.promise.then(async () => {
      // The stream usually ends because the server died: then say that, with what it printed.
      const what = this.gone ? await within(this.gone, 2000) : undefined;
      failed.reject(new Error(what ?? 'OpenCode closed its event stream.'));
    });
    const timer = setInterval(() => {
      if (turn.awaitingSince !== undefined && Date.now() - turn.awaitingSince > ACCEPT_TIMEOUT_MS) {
        failed.reject(new Error(`OpenCode did not take up the message within ${ACCEPT_TIMEOUT_MS / 1000} s.`));
      }
    }, 1000);
    timer.unref?.();
    try {
      await Promise.race([turn.idle.promise, failed.promise]);
    } finally {
      clearInterval(timer);
      failed.resolve();
    }
  }

  /** Steering messages the turn's last model call did not see. */
  private async missedSteers(turn: TurnState): Promise<Steer[]> {
    const deadline = Date.now() + STEER_CONFIRM_MS;
    while (!this.stopping && this.steers.some((steer) => !steer.failed && !steer.messageId) && Date.now() < deadline) {
      await within(this.nextChange(), deadline - Date.now());
    }
    const parent = turn.lastAssistant ? this.assistants.get(turn.lastAssistant)?.parentID : undefined;
    const missed = this.steers.filter((steer) => steer.messageId !== undefined && (!parent || steer.messageId > parent));
    // Messages that never showed up go to the next turn.
    for (const steer of this.steers) if (!steer.failed && !steer.messageId) this.queued.push(steer.text);
    this.steers = [];
    return missed;
  }

  private resultOf(turn: TurnState): ResultEvent {
    const base = {
      type: 'result' as const,
      text: this.finalText(turn),
      durationMs: Date.now() - turn.startedAt,
      numTurns: turn.modelCalls,
      ...(this.cost() !== undefined ? { costUsd: this.cost() } : {}),
    };
    if (this.limit === 'turns') {
      const max = this.options.maxTurns ?? turn.modelCalls;
      return { ...base, ok: false, limit: 'turns', numTurns: max, error: `Stopped after ${max} model turns, the limit for this run.` };
    }
    if (this.limit === 'budget') {
      const spent = this.runCost();
      return {
        ...base,
        ok: false,
        limit: 'budget',
        error: `Stopped after spending $${spent.toFixed(2)}, past this run's budget of $${(this.options.maxBudgetUsd ?? 0).toFixed(2)}.`,
      };
    }
    if (this.stopping) return { ...base, ok: false, error: 'Interrupted.' };
    if (turn.error) return { ...base, ok: false, error: turn.error };
    if (!turn.lastAssistant) return { ...base, ok: false, error: 'OpenCode ended the turn without an answer.' };
    return { ...base, ok: true };
  }

  private failure(error: unknown): ResultEvent {
    const text = this.lastTurn ? this.finalText(this.lastTurn) : '';
    if (this.stopping) return { type: 'result', ok: false, text, error: 'Interrupted.' };
    // When the process died, its output says why.
    const detail = errorMessage(error);
    const output = this.exited ? stripAnsi(this.stderr).trim().slice(-STDERR_LIMIT) : '';
    return { type: 'result', ok: false, text, error: output ? `${detail}\n${output}` : detail };
  }

  /** The turn's answer: the text of its last message that has any. */
  private finalText(turn: TurnState): string {
    const entries = turn.textParts
      .map((id) => this.texts.get(id))
      .filter((entry): entry is TextEntry => entry !== undefined && entry.text.trim() !== '');
    const last = entries[entries.length - 1];
    if (!last) return '';
    return entries
      .filter((entry) => entry.messageID === last.messageID)
      .map((entry) => entry.text.trim())
      .join('\n\n');
  }

  private runCost(): number {
    let total = 0;
    for (const cost of this.costs.values()) total += cost;
    return dollars(total);
  }

  private cost(): number | undefined {
    return this.priorCost === undefined ? undefined : dollars(this.priorCost + this.runCost());
  }

  /** Aborts the turn. If OpenCode does not confirm within a few seconds, the turn ends anyway. */
  private async abortTurn(turn: TurnState): Promise<void> {
    if (turn.aborting) return;
    turn.aborting = true;
    const timer = setTimeout(() => {
      if (turn.idle.settled()) return;
      this.unsettled = true;
      turn.idle.resolve();
    }, FORCE_KILL_MS);
    timer.unref?.();
    void turn.idle.promise.then(() => clearTimeout(timer));
    if (!this.sessionId) return;
    try {
      await this.call('POST', `/session/${encodeURIComponent(this.sessionId)}/abort`);
    } catch {
      // The server is gone or the turn just ended; the timer covers a hung server.
    }
  }

  private stopAtLimit(limit: 'turns' | 'budget'): void {
    if (this.limit) return;
    this.limit = limit;
    this.accepting = false;
    const turn = this.turn;
    if (turn) void this.abortTurn(turn);
  }

  private armForceKill(): void {
    if (this.forceKill || this.exited || !this.child) return;
    this.forceKill = setTimeout(() => this.kill('SIGKILL'), FORCE_KILL_MS);
    this.forceKill.unref?.();
  }

  private kill(signal: NodeJS.Signals): void {
    if (this.child && !this.exited) killTree(this.child, signal);
  }

  private async shutdown(): Promise<void> {
    this.stream.abort();
    if (!this.child || !this.gone) return;
    if (!this.exited) {
      // `opencode serve` runs until it is stopped.
      this.kill('SIGTERM');
      this.armForceKill();
    }
    await within(this.gone, 2 * FORCE_KILL_MS);
    clearTimeout(this.forceKill);
  }

  private emit(event: EngineEvent): void {
    this.out.push(event);
  }

  /** The session event comes first, once OpenCode has said which model it uses. */
  private reportSession(): void {
    if (this.sessionReported || !this.sessionId) return;
    this.sessionReported = true;
    const model = this.modelName ?? (this.options.model?.trim() || undefined);
    this.emit(model ? { type: 'session', sessionId: this.sessionId, model } : { type: 'session', sessionId: this.sessionId });
  }

  // ---- HTTP ----

  private headers(): Record<string, string> {
    return {
      authorization: `Basic ${Buffer.from(`${SERVER_USER}:${this.password}`).toString('base64')}`,
      'x-opencode-directory': encodeURIComponent(this.options.cwd),
    };
  }

  private async call(method: string, path: string, body?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    const headers = this.headers();
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${this.base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      // Keep the text.
    }
    if (!response.ok) {
      const reason = isRecord(data)
        ? str(isRecord(data.data) ? data.data.message : undefined) ||
          str(records(data.errors)[0]?.message) ||
          str(data.message) ||
          str(data.name)
        : str(data);
      throw new Error(`OpenCode refused ${method} ${path.split('?')[0]}: ${reason || `HTTP ${response.status}`}`);
    }
    return data;
  }

  // ---- events ----

  private nextChange(): Promise<void> {
    return new Promise((resolve) => this.changeWaiters.push(resolve));
  }

  private onEvent(event: Json): void {
    try {
      this.handle(str(event.type), isRecord(event.properties) ? event.properties : {});
    } finally {
      const waiters = this.changeWaiters;
      this.changeWaiters = [];
      for (const wake of waiters) wake();
    }
  }

  private handle(type: string, properties: Json): void {
    switch (type) {
      case 'session.created': {
        const info = isRecord(properties.info) ? properties.info : {};
        // Sub-sessions (OpenCode's task tool) ask for permissions too.
        if (this.tree.has(str(info.parentID)) && str(info.id)) this.tree.add(str(info.id));
        return;
      }
      case 'message.updated':
        if (isRecord(properties.info)) this.onMessage(properties.info);
        return;
      case 'message.part.updated':
        if (isRecord(properties.part)) this.onPart(properties.part, properties.delta);
        return;
      case 'permission.asked':
        void this.onPermission(properties);
        return;
      case 'question.asked':
        void this.onQuestion(properties);
        return;
      case 'permission.replied':
      case 'question.replied':
      case 'question.rejected':
        // Answered elsewhere, or dropped by OpenCode: nobody waits for code-bot's answer any more.
        this.asking.get(str(properties.requestID))?.abort();
        return;
      case 'session.status':
        if (str(properties.sessionID) === this.sessionId && isRecord(properties.status)) this.onStatus(properties.status);
        return;
      case 'session.idle':
        if (str(properties.sessionID) === this.sessionId && this.turn) {
          this.turn.ending = true;
          this.turn.idle.resolve();
        }
        return;
      case 'session.error': {
        const turn = this.turn;
        if (!turn || str(properties.sessionID) !== this.sessionId) return;
        if (isRecord(properties.error) && properties.error.name === 'MessageAbortedError' && (turn.aborting || this.stopping)) return;
        turn.error ??= describeError(properties.error);
        return;
      }
    }
  }

  private onStatus(status: Json): void {
    const turn = this.turn;
    if (!turn) return;
    switch (status.type) {
      case 'busy':
        turn.busy = true;
        return;
      case 'retry': {
        turn.busy = true;
        const attempt = num(status.attempt) ?? 1;
        const next = num(status.next);
        const wait = next !== undefined ? next - Date.now() : 0;
        if (wait <= RETRY_WAIT_LIMIT_MS && attempt < RETRY_ATTEMPT_LIMIT) return;
        // OpenCode would keep retrying (until the provider's limit resets, which can be hours).
        const model = this.modelName ?? this.options.model ?? 'the model';
        const when = wait > RETRY_WAIT_LIMIT_MS ? `it would try again ${describeWait(wait)}` : `after ${plural(attempt, 'attempt')}`;
        turn.error ??= `OpenCode could not get an answer from ${model}: ${str(status.message) || 'the provider refused'} (${when}).`;
        void this.abortTurn(turn);
        return;
      }
    }
  }

  private onMessage(info: Json): void {
    const id = str(info.id);
    const sessionID = str(info.sessionID);
    if (!id || !this.tree.has(sessionID)) return;
    const turn = this.turn;
    if (info.role === 'assistant') {
      const cost = num(info.cost);
      if (cost !== undefined) {
        this.costs.set(id, cost);
        const max = this.options.maxBudgetUsd;
        if (max !== undefined && turn && this.runCost() > max) this.stopAtLimit('budget');
      }
      if (sessionID !== this.sessionId) return;
      if (!this.assistants.has(id)) {
        this.assistants.set(id, { parentID: str(info.parentID), internal: info.summary === true || info.agent === 'compaction' });
      }
      if (turn && (!turn.lastAssistant || id > turn.lastAssistant)) turn.lastAssistant = id;
      if (turn && info.error !== undefined && info.error !== null) {
        const aborted = isRecord(info.error) && info.error.name === 'MessageAbortedError';
        if (!aborted || !(turn.aborting || this.stopping)) turn.error ??= describeError(info.error);
      }
      return;
    }
    if (info.role !== 'user' || sessionID !== this.sessionId || this.users.has(id)) return;
    this.users.add(id);
    const model = isRecord(info.model) ? info.model : undefined;
    if (model && str(model.providerID) && str(model.modelID)) this.modelName = `${str(model.providerID)}/${str(model.modelID)}`;
    this.reportSession();
    if (turn && turn.awaitingSince !== undefined) {
      turn.awaitingSince = undefined;
      if (!turn.accepted) {
        turn.accepted = true;
        // Messages that arrived while the turn was starting join it now.
        if (!turn.ending) for (const text of this.queued.splice(0)) this.steer(text);
      }
    }
  }

  private onPart(part: Json, delta: unknown): void {
    const sessionID = str(part.sessionID);
    if (!this.tree.has(sessionID)) return;
    if (part.type === 'tool') {
      const state = isRecord(part.state) ? part.state : {};
      const callID = str(part.callID);
      const ready = state.status !== 'pending';
      if (callID && (ready || !this.calls.has(callID))) {
        this.calls.set(callID, { tool: str(part.tool), input: isRecord(state.input) ? state.input : {}, ready });
      }
    }
    // Only this session's own messages; sub-sessions are the agent's internal helpers.
    if (sessionID !== this.sessionId) return;
    const messageID = str(part.messageID);
    if (this.users.has(messageID)) {
      if (part.type === 'text') {
        const steer = this.steers.find((entry) => !entry.messageId && !entry.failed && entry.text === str(part.text));
        if (steer) steer.messageId = messageID;
      }
      return;
    }
    const message = this.assistants.get(messageID);
    if (!message) return;
    switch (part.type) {
      case 'step-start':
        this.onStep();
        return;
      case 'text':
        if (!message.internal && part.synthetic !== true && part.ignored !== true) this.onText(part, delta);
        return;
      case 'tool':
        this.onTool(part);
        return;
    }
  }

  /** One model call. Past maxTurns, the turn stops. */
  private onStep(): void {
    const turn = this.turn;
    if (!turn) return;
    turn.modelCalls += 1;
    const max = this.options.maxTurns;
    if (max !== undefined && max > 0 && turn.modelCalls > max) {
      turn.modelCalls = max;
      this.stopAtLimit('turns');
    }
  }

  private onText(part: Json, delta: unknown): void {
    const id = str(part.id);
    if (!id) return;
    let entry = this.texts.get(id);
    if (!entry) {
      entry = { messageID: str(part.messageID), text: '', done: false };
      this.texts.set(id, entry);
      this.turn?.textParts.push(id);
    }
    if (entry.done) return;
    entry.text = str(part.text);
    if (typeof delta === 'string' && delta) this.emit({ type: 'text_delta', text: delta });
    const time = isRecord(part.time) ? part.time : {};
    if (time.end !== undefined) this.finishText(entry);
  }

  private finishText(entry: TextEntry): void {
    if (entry.done) return;
    entry.done = true;
    if (entry.text.trim()) this.emit({ type: 'text', text: entry.text });
  }

  /** Text cut off by an interrupt or a limit is still the agent's message. */
  private flushTexts(turn: TurnState): void {
    for (const id of turn.textParts) {
      const entry = this.texts.get(id);
      if (entry) this.finishText(entry);
    }
  }

  private onTool(part: Json): void {
    const callID = str(part.callID);
    const state = isRecord(part.state) ? part.state : {};
    const status = str(state.status);
    // Pending: the model is still writing the call's input.
    if (!callID || status === 'pending') return;
    if (!this.reportedTools.has(callID)) {
      this.reportedTools.add(callID);
      this.emit({ type: 'tool_use', id: callID, name: str(part.tool), input: isRecord(state.input) ? state.input : {} });
    }
    if ((status === 'completed' || status === 'error') && !this.finishedTools.has(callID)) {
      this.finishedTools.add(callID);
      const isError = status === 'error';
      this.emit({ type: 'tool_result', id: callID, isError, preview: preview(isError ? str(state.error) : str(state.output)) });
    }
  }

  // ---- requests from OpenCode ----

  /** Puts a request to the user. Undefined when it was withdrawn: nobody waits for the answer any more. */
  private async ask(id: string, request: UserRequest): Promise<UserResponse | undefined> {
    const controller = new AbortController();
    this.asking.set(id, controller);
    try {
      return await this.askUser(request, controller.signal);
    } catch (error) {
      return controller.signal.aborted ? undefined : { decision: 'deny', message: `code-bot could not ask: ${errorMessage(error)}` };
    } finally {
      this.asking.delete(id);
    }
  }

  private withdrawAll(): void {
    for (const controller of this.asking.values()) controller.abort();
  }

  private async answer(path: string, body: Json): Promise<void> {
    try {
      await this.call('POST', path, body);
    } catch {
      // The request is gone (the turn ended or was aborted).
    }
  }

  /**
   * The tool call a request is about. OpenCode runs a tool as soon as the model has written the
   * call, so its permission request can arrive just before the event that shows the call's input.
   */
  private async toolCall(callID: string): Promise<ToolCall | undefined> {
    const deadline = Date.now() + CALL_WAIT_MS;
    while (!this.calls.get(callID)?.ready && Date.now() < deadline && !this.stopping) {
      await within(this.nextChange(), deadline - Date.now());
    }
    return this.calls.get(callID);
  }

  private async onPermission(properties: Json): Promise<void> {
    const id = str(properties.id);
    if (!id || !this.tree.has(str(properties.sessionID))) return;
    const callID = isRecord(properties.tool) ? str(properties.tool.callID) : '';
    const call = callID ? await this.toolCall(callID) : undefined;
    const response = await this.ask(id, approvalFor(properties, call));
    if (!response) return;
    // A refusal always carries a reason: without one, OpenCode would stop the whole turn.
    await this.answer(
      `/permission/${encodeURIComponent(id)}/reply`,
      response.decision === 'allow' ? { reply: 'once' } : { reply: 'reject', message: response.message || DECLINED },
    );
  }

  private async onQuestion(properties: Json): Promise<void> {
    const id = str(properties.id);
    if (!id || !this.tree.has(str(properties.sessionID))) return;
    const questions = records(properties.questions);
    const texts = uniqueTexts(questions.map((question) => str(question.question) || str(question.header) || 'Question'));
    const response = await this.ask(id, {
      kind: 'question',
      tool: QUESTION_TOOL,
      input: {
        questions: questions.map((question, index) => ({
          question: texts[index],
          header: str(question.header) || undefined,
          multiSelect: question.multiple === true,
          options: records(question.options).map((option) => ({
            label: str(option.label),
            description: str(option.description) || undefined,
          })),
        })),
      },
    });
    if (!response) return;
    // A declined question gets an answer that says so, and the agent carries on.
    const declined = (response.decision === 'deny' && response.message) || UNANSWERED;
    const answers = questions.map((question, index) => {
      if (response.decision !== 'allow') return [declined];
      const answer = answerFor(response, [texts[index] ?? '', str(question.question), str(question.header)], questions.length === 1);
      if (answer === undefined || !answer.trim()) return [];
      const labels = records(question.options).map((option) => str(option.label));
      return question.multiple === true ? labelsOf(answer, labels) : [answer];
    });
    await this.answer(`/question/${encodeURIComponent(id)}/reply`, { answers });
  }
}

// ---- the engine ---------------------------------------------------------------------------------

export class OpenCodeEngine implements Engine {
  readonly id = 'opencode';
  readonly label = 'OpenCode';
  private readonly executable: string | undefined;
  private readonly executableArgs: string[];

  /**
   * `executable` overrides CODE_BOT_OPENCODE_EXECUTABLE and the search on PATH. `executableArgs` go
   * before OpenCode's own arguments, for running OpenCode through another program.
   */
  constructor(options: { executable?: string; executableArgs?: string[] } = {}) {
    this.executable = options.executable;
    this.executableArgs = options.executableArgs ?? [];
  }

  start(options: EngineRunOptions, askUser: AskUser): EngineRun {
    const mode = options.permissionMode ?? 'default';
    if (!PERMISSION_MODES.includes(mode)) {
      throw new Error(`Unknown permission mode "${mode}" for opencode. Use one of: ${PERMISSION_MODES.join(', ')}`);
    }
    const model = options.model?.trim();
    if (model && !splitModel(model)) {
      throw new Error(`OpenCode models are written provider/model, for example opencode/big-pickle (not "${model}").`);
    }
    return new OpenCodeRun(this.locate(), options, askUser);
  }

  async check(): Promise<EngineCheck> {
    const launcher = this.locate();
    if (typeof launcher === 'string') return { ready: false, detail: launcher };
    const [version, auth, models] = await Promise.all([
      capture(launcher, ['--version']),
      capture(launcher, ['auth', 'list']),
      capture(launcher, ['models'], MODELS_TIMEOUT_MS),
    ]);
    if (version.error !== undefined) return { ready: false, detail: `OpenCode could not be run (${launcher.file}): ${version.error}` };
    const lines = (text: string) =>
      text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    if (version.code !== 0) {
      return { ready: false, detail: `"opencode --version" ended with code ${version.code ?? 'unknown'}: ${lines(version.output).pop() ?? ''}` };
    }
    const name = `OpenCode ${lines(version.output)[0] ?? ''}`.trim();
    const offered = models.code === 0 ? lines(models.output).filter((line) => /^[^\s/]+\/\S+$/.test(line)) : [];
    if (models.code === 0 && offered.length === 0) {
      return {
        ready: false,
        detail: `${name} is installed but offers no models: sign in to a provider.`,
        signIn: { command: launcher.file, args: [...launcher.args, 'auth', 'login'] },
      };
    }
    const credentials = Number(/(\d+)\s+credentials?\b/i.exec(auth.output)?.[1] ?? Number.NaN);
    if (credentials > 0) return { ready: true, detail: `${name} is installed, signed in to ${plural(credentials, 'provider')}.` };
    // Without a sign-in OpenCode offers its own free models (opencode/…), so an installed OpenCode is ready.
    const free = offered.filter((model) => model.startsWith('opencode/')).length;
    return {
      ready: true,
      detail: `${name} is installed. No provider is signed in${free > 0 ? `; the ${plural(free, 'free model')} it offers (opencode/…) need none` : ''}. "opencode auth login" adds providers.`,
    };
  }

  resumeCommand(sessionId: string): TerminalCommand | undefined {
    if (!SESSION_ID.test(sessionId)) return undefined;
    const launcher = this.locate();
    return typeof launcher === 'string' ? undefined : { command: launcher.file, args: [...launcher.args, '--session', sessionId] };
  }

  private locate(): Launcher | string {
    const windows = process.platform === 'win32';
    const configured = this.executable ?? (process.env.CODE_BOT_OPENCODE_EXECUTABLE?.trim() || undefined);
    if (configured && (isAbsolute(configured) || /[\\/]/.test(configured)) && !isProgram(configured)) {
      return `OpenCode is not installed at ${configured}.`;
    }
    // An npm shim, given or found, still runs the native binary behind it.
    const shim = configured !== undefined && /[\\/]/.test(configured) && /^opencode(\.cmd|\.bat)?$/i.test(basename(configured));
    const found = configured ? (shim ? (nativeBehind(configured) ?? configured) : configured) : findOpenCode();
    if (!found) return NOT_INSTALLED;
    return { file: found, args: this.executableArgs, shell: windows && /\.(cmd|bat)$/i.test(found) };
  }
}
