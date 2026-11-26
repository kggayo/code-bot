/**
 * Runs OpenAI's Codex CLI as a sub-agent through `codex app-server`, the protocol the Codex IDE
 * extension uses: JSON-RPC 2.0 messages without the "jsonrpc" field, one per line on stdio. Message
 * shapes follow `codex app-server generate-ts` for codex-cli 0.160.1.
 *
 * One app-server process per run: initialize, thread/start (or thread/resume), turn/start. Messages
 * that cannot be steered into the running turn start another turn on the same thread afterwards.
 * Once a turn completes with nothing queued, stdin is closed and the process exits; a later message
 * resumes the thread in a new process. Threads are Codex's own sessions (~/.codex/sessions), so
 * `codex resume <id>` continues one in a terminal.
 *
 *   thread id from thread/start or thread/resume   → session
 *   item/agentMessage/delta                        → text_delta
 *   item/completed with an agentMessage            → text
 *   item/started, item/completed for commands, file changes, MCP and other tool calls
 *                                                  → tool_use, tool_result
 *   turn/completed                                 → result (text: the turn's final answer)
 *   item/commandExecution/requestApproval, item/fileChange/requestApproval,
 *   item/permissions/requestApproval, MCP elicitations without form fields
 *                                                  → askUser permission
 *   item/tool/requestUserInput, MCP elicitation forms → askUser question (AskUserQuestion)
 *   an agentMessage with delivery "async" (request_user_input_async)
 *                                                  → askUser question; the answer goes back as a
 *                                                    message, and the run stays open until then
 *   send()                                         → turn/steer, or a new turn when it cannot steer
 *   interrupt()                                    → turn/interrupt, then the process ends
 *
 * maxTurns counts a turn's model calls (one thread/tokenUsage/updated each), as Claude Code's turn
 * limit counts round-trips: once a turn has made that many, it is interrupted as soon as the model
 * starts another, and the run ends with limit: 'turns'. maxBudgetUsd is ignored and costUsd never
 * set: app-server reports tokens, not money (a ChatGPT sign-in has no per-token price).
 *
 * Approval inputs hold only what identifies the action (command and folder, or the exact changes);
 * Codex's reason goes in the summary. code-bot recognises an approval given after a restart by
 * tool and input, and the model words its reason differently each time.
 *
 * Credentials are whatever Codex finds on this machine (`codex login`); code-bot never sees them.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess, StdioOptions } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { allowedServers, launchCommand } from '../mcp.ts';
import { clip, errorMessage } from '../util.ts';
import { CODE_BOT_VERSION } from '../version.ts';
import type {
  AskUser,
  Engine,
  EngineCheck,
  EngineEvent,
  EngineRun,
  EngineRunOptions,
  EngineUsageReport,
  McpServer,
  TerminalCommand,
  UsageWindow,
  UserRequest,
  UserResponse,
} from './types.ts';

type Json = Record<string, unknown>;
type ResultEvent = Extract<EngineEvent, { type: 'result' }>;
type ApprovalPolicy = 'untrusted' | 'on-request' | 'never';
type SandboxPolicy =
  | { type: 'readOnly'; networkAccess: boolean }
  | {
      type: 'workspaceWrite';
      writableRoots: string[];
      networkAccess: boolean;
      excludeTmpdirEnvVar: boolean;
      excludeSlashTmp: boolean;
    }
  | { type: 'dangerFullAccess' };

const PERMISSION_MODES = ['plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions'];
const QUESTION_TOOL = 'AskUserQuestion';
const PREVIEW_LIMIT = 2000;
const STDERR_LIMIT = 4000;
const FORCE_KILL_MS = 5000;
const CHECK_TIMEOUT_MS = 15_000;
const CLIENT_INFO = { name: 'code_bot', title: 'code-bot', version: CODE_BOT_VERSION };
const NOT_INSTALLED =
  'Codex is not installed: there is no "codex" program on PATH. Install the Codex CLI, or set CODE_BOT_CODEX_EXECUTABLE to its path.';
const SECRET_ANSWER =
  'code-bot does not pass on secrets. Continue without it, or ask the user to set it up outside code-bot.';

/** Config overrides for every thread this engine starts or resumes. */
const THREAD_CONFIG = {
  // Read-only until a turn sets the real sandbox; see permissionsFor.
  sandbox_mode: 'read-only',
  // Lets Codex ask questions (request_user_input) outside its Plan mode. Under development in
  // 0.160.1; without it Codex can only end its turn with a question in its answer.
  'features.default_mode_request_user_input': true,
  suppress_unstable_features_warning: true,
};

/** Notifications code-bot has no use for; app-server leaves them out. */
const UNUSED_NOTIFICATIONS = [
  'item/commandExecution/outputDelta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded',
  'item/reasoning/textDelta',
  'item/plan/delta',
  'turn/diff/updated',
  'account/rateLimits/updated',
  'mcpServer/startupStatus/updated',
];

/** Tool items whose input is only known once they complete. */
const REPORTED_ON_COMPLETION = new Set(['webSearch', 'imageGeneration']);

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const records = (value: unknown): Json[] => list(value).filter(isRecord);
const preview = (text: string): string => clip(text, PREVIEW_LIMIT);
const textInput = (text: string) => ({ type: 'text', text, text_elements: [] });
const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/**
 * code-bot's permission modes (strictest first) as Codex approval policy and sandbox:
 *   plan               read-only sandbox, "on-request" (Codex's Read Only preset): reads and runs
 *                      read-only commands; anything more needs the user's approval
 *   default            workspace-write sandbox, "untrusted": every edit and every command that is
 *                      not known to be read-only asks first
 *   acceptEdits, auto  workspace-write sandbox, "on-request" (Codex's Auto preset): edits and
 *                      commands inside the project folders run freely; leaving the sandbox asks first
 *   bypassPermissions  no sandbox ("danger-full-access"), "never" asks
 * additionalDirectories become extra writable roots. Approvals always go to the user
 * (approvalsReviewer "user"), never to Codex's own auto-reviewer.
 *
 * The sandbox allows network access: sub-agents use the machine's databases and tooling, and on
 * Windows a sandbox without network runs as a separate offline user whose firewall setup needs
 * elevation (and clashes with the setup the Codex desktop app made).
 *
 * The sandbox is sent with every turn/start, never with thread/start: a writable sandbox on
 * thread/start makes app-server mark the folder trusted in ~/.codex/config.toml.
 */
function permissionsFor(
  mode: string,
  additionalDirectories: string[] | undefined,
): { approvalPolicy: ApprovalPolicy; sandboxPolicy: SandboxPolicy } {
  const workspace: SandboxPolicy = {
    type: 'workspaceWrite',
    writableRoots: additionalDirectories ?? [],
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
  switch (mode) {
    case 'plan':
      return { approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly', networkAccess: true } };
    case 'acceptEdits':
    case 'auto':
      return { approvalPolicy: 'on-request', sandboxPolicy: workspace };
    case 'bypassPermissions':
      return { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } };
    default:
      return { approvalPolicy: 'untrusted', sandboxPolicy: workspace };
  }
}

/**
 * The project's MCP servers as config overrides for thread/start and thread/resume. A dotted key
 * per server ("mcp_servers.<name>") adds it to the servers Codex loads from ~/.codex/config.toml
 * and its plugins instead of replacing them. default_tools_approval_mode "approve" runs the
 * server's tools without asking; "prompt" asks for each call.
 */
export function codexMcpConfig(
  servers: readonly McpServer[] | undefined,
  permissionMode: string | undefined,
  platform: NodeJS.Platform = process.platform,
): Json {
  const config: Json = {};
  const allowed = new Set(allowedServers(servers ?? [], permissionMode));
  for (const server of servers ?? []) {
    const reach = server.type === 'http' ? { url: server.url } : launchCommand(server.command, server.args, platform);
    config[`mcp_servers.${server.name}`] = { ...reach, default_tools_approval_mode: allowed.has(server) ? 'approve' : 'prompt' };
  }
  return config;
}

// ---- finding and starting the codex program ---------------------------------------------------

interface Launcher {
  file: string;
  /** Arguments before Codex's own, when Codex runs through another program. */
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

function findCodex(): string | undefined {
  const windows = process.platform === 'win32';
  const dirs = (process.env.PATH ?? '')
    .split(delimiter)
    .map((dir) => dir.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
  // Native binaries first: an npm install puts a codex.cmd shim on PATH.
  const names = windows ? ['codex.exe', 'codex.cmd', 'codex.bat'] : ['codex'];
  for (const name of names) {
    for (const dir of dirs) {
      const path = join(dir, name);
      if (isProgram(path)) return path;
    }
  }
  // Where the standalone installer and Homebrew put it, for apps started without the shell's PATH.
  const known = [join(homedir(), '.codex', 'packages', 'standalone', 'current', 'bin', windows ? 'codex.exe' : 'codex')];
  if (!windows) known.push('/opt/homebrew/bin/codex', '/usr/local/bin/codex', join(homedir(), '.local', 'bin', 'codex'));
  return known.find(isProgram);
}

/** Quotes for cmd.exe; only fixed arguments and paths ever pass through it. */
const quote = (value: string): string => (/[\s&()^|<>]/.test(value) ? `"${value}"` : value);

function launch(launcher: Launcher, args: string[], stdio: StdioOptions): ChildProcess {
  const all = [...launcher.args, ...args];
  if (launcher.shell) {
    const commandLine = [launcher.file, ...all].map(quote).join(' ');
    return spawn(commandLine, { shell: true, stdio, windowsHide: true });
  }
  return spawn(launcher.file, all, { stdio, windowsHide: true });
}

function killTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    // child.kill() would stop only the top process: Codex's MCP servers, or Codex itself behind a
    // cmd.exe shim, would keep running.
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    killer.once('error', () => child.kill());
    return;
  }
  child.kill('SIGKILL');
}

/** Resolves with the promise's value, or with undefined after `ms`. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

interface Captured {
  code: number | null;
  output: string;
  error?: string;
}

/** Runs a short codex command and collects what it prints. */
function capture(launcher: Launcher, args: string[]): Promise<Captured> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = launch(launcher, args, ['ignore', 'pipe', 'pipe']);
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
      killTree(child);
      finish({ code: null, output, error: `no answer within ${CHECK_TIMEOUT_MS / 1000} s` });
    }, CHECK_TIMEOUT_MS);
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(0, 64 * 1024);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.once('error', (error) => finish({ code: null, output, error: error.message }));
    child.once('close', (code) => finish({ code, output: stripAnsi(output) }));
  });
}

// ---- JSON-RPC over the app-server's stdio -----------------------------------------------------

class RpcConnection {
  onNotification: (method: string, params: Json) => void = () => undefined;
  onRequest: (id: string | number, method: string, params: Json) => void = () => undefined;
  private readonly child: ChildProcess;
  private nextId = 1;
  private readonly waiting = new Map<number, { method: string; resolve: (value: Json) => void; reject: (error: Error) => void }>();
  private closed: Error | undefined;

  constructor(child: ChildProcess) {
    this.child = child;
    child.stdin?.on('error', () => undefined);
  }

  request(method: string, params: unknown): Promise<Json> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<Json>((resolve, reject) => {
      this.waiting.set(id, { method, resolve, reject });
      this.write({ id, method, params });
    });
  }

  notify(method: string): void {
    this.write({ method });
  }

  respond(id: string | number, result: unknown): void {
    this.write({ id, result });
  }

  fail(id: string | number, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  handle(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(message)) return;
    const { id, method } = message;
    const params = isRecord(message.params) ? message.params : {};
    if (typeof method === 'string') {
      if (id === undefined || id === null) this.onNotification(method, params);
      else if (typeof id === 'string' || typeof id === 'number') this.onRequest(id, method, params);
      return;
    }
    if (typeof id !== 'number') return;
    const entry = this.waiting.get(id);
    if (!entry) return;
    this.waiting.delete(id);
    if (message.error !== undefined) {
      const error = isRecord(message.error) ? message.error : {};
      entry.reject(new Error(`Codex refused ${entry.method}: ${str(error.message) || JSON.stringify(message.error)}`));
    } else {
      entry.resolve(isRecord(message.result) ? message.result : {});
    }
  }

  /** The process is gone: every open request fails with this error. */
  close(error: Error): void {
    this.closed ??= error;
    for (const entry of this.waiting.values()) entry.reject(error);
    this.waiting.clear();
  }

  private write(message: unknown): void {
    const stdin = this.child.stdin;
    if (this.closed || !stdin || stdin.destroyed || stdin.writableEnded) return;
    stdin.write(`${JSON.stringify(message)}\n`);
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

// ---- turning Codex items into tool events -----------------------------------------------------

interface FileChange {
  path: string;
  kind: string;
  diff: string;
}

function fileChanges(value: unknown): FileChange[] {
  return records(value).map((change) => ({
    path: str(change.path),
    kind: isRecord(change.kind) ? str(change.kind.type) : str(change.kind),
    diff: str(change.diff),
  }));
}

function contentText(content: unknown): string {
  return records(content)
    .map((part) => (typeof part.text === 'string' ? part.text : `[${str(part.type) || 'content'}]`))
    .join('\n');
}

const snakeCase = (name: string): string => name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

function toolCall(item: Json): { name: string; input: unknown } | undefined {
  switch (item.type) {
    case 'commandExecution':
      return { name: 'shell', input: { command: str(item.command), cwd: str(item.cwd) || undefined } };
    case 'fileChange': {
      const changes = fileChanges(item.changes);
      const [only] = changes;
      return { name: 'apply_patch', input: changes.length === 1 && only ? { path: only.path, changes } : { changes } };
    }
    case 'mcpToolCall':
      return { name: `mcp__${str(item.server)}__${str(item.tool)}`, input: item.arguments ?? {} };
    case 'dynamicToolCall':
      return { name: str(item.tool) || 'tool', input: item.arguments ?? {} };
    case 'collabAgentToolCall':
      return { name: snakeCase(str(item.tool)) || 'agent', input: { description: str(item.prompt), model: str(item.model) || undefined } };
    case 'webSearch':
      return { name: 'web_search', input: { query: str(item.query) } };
    case 'imageView':
      return { name: 'view_image', input: { path: str(item.path) } };
    case 'imageGeneration':
      return { name: 'image_generation', input: { description: str(item.revisedPrompt) } };
    default:
      return undefined;
  }
}

function toolOutcome(item: Json): { isError: boolean; preview: string } {
  const status = str(item.status);
  switch (item.type) {
    case 'commandExecution': {
      const exitCode = typeof item.exitCode === 'number' ? item.exitCode : undefined;
      const output = str(item.aggregatedOutput).trim();
      const fallback = status === 'declined' ? 'Declined.' : exitCode !== undefined ? `Exit code ${exitCode}` : status;
      return {
        isError: status !== 'completed' || (exitCode !== undefined && exitCode !== 0),
        preview: preview(output || fallback),
      };
    }
    case 'fileChange': {
      const paths = fileChanges(item.changes).map((change) => change.path).join(', ');
      return {
        isError: status !== 'completed',
        preview: status === 'completed' ? `Changed ${paths}` : `${status === 'declined' ? 'Declined' : 'Failed'}: ${paths}`,
      };
    }
    case 'mcpToolCall': {
      const error = isRecord(item.error) ? str(item.error.message) : '';
      const result = isRecord(item.result) ? contentText(item.result.content) : '';
      return { isError: status === 'failed' || Boolean(error), preview: preview(error || result) };
    }
    case 'dynamicToolCall':
      return { isError: item.success === false || status === 'failed', preview: preview(contentText(item.contentItems)) };
    case 'webSearch':
      return { isError: false, preview: preview(str(item.query)) };
    default:
      return { isError: status === 'failed', preview: preview(status) };
  }
}

// ---- questions --------------------------------------------------------------------------------

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

const declinedAnswer = (response: UserResponse): string =>
  (response.decision === 'deny' && response.message) || 'The user did not answer; use your own judgement.';

interface FormField {
  key: string;
  label: string;
  type: string;
  options: { label: string; value: string }[];
}

function choices(schema: unknown): { label: string; value: string }[] {
  if (!isRecord(schema)) return [];
  const titled = records(schema.oneOf).length > 0 ? records(schema.oneOf) : records(schema.anyOf);
  if (titled.length > 0) return titled.map((option) => ({ label: str(option.title) || String(option.const), value: String(option.const) }));
  const names = list(schema.enumNames);
  return list(schema.enum).map((value, index) => ({ label: str(names[index]) || String(value), value: String(value) }));
}

/** The fields of an MCP elicitation form (flat: strings, numbers, booleans and choices). */
function formFields(schema: unknown): FormField[] {
  const properties = isRecord(schema) && isRecord(schema.properties) ? schema.properties : {};
  return Object.entries(properties).map(([key, field]) => {
    const spec = isRecord(field) ? field : {};
    const type = str(spec.type);
    const options =
      type === 'boolean'
        ? [
            { label: 'Yes', value: 'true' },
            { label: 'No', value: 'false' },
          ]
        : choices(type === 'array' ? spec.items : spec);
    return { key, label: str(spec.title) || str(spec.description) || key, type, options };
  });
}

function formValue(field: FormField, answer: string): unknown {
  const pick = (text: string) => field.options.find((option) => option.label === text || option.value === text)?.value ?? text;
  switch (field.type) {
    case 'boolean':
      return /^(true|yes|y|1)$/i.test(pick(answer.trim()));
    case 'number':
    case 'integer': {
      const number = Number(answer);
      return answer.trim() && Number.isFinite(number) ? number : answer;
    }
    case 'array':
      return answer
        .split(/\s*,\s*/)
        .filter(Boolean)
        .map(pick);
    default:
      return pick(answer);
  }
}

// ---- one run ----------------------------------------------------------------------------------

interface TurnState {
  id: string | undefined;
  startedAt: number;
  /** turn/completed arrived; new messages wait for the next turn. */
  over: boolean;
  interrupting: boolean;
  modelCalls: number;
  /** maxTurns model calls happened: starting another one ends the run. */
  atLimit: boolean;
  lastText: string;
  finalText: string;
  error: string | undefined;
  finish: (turn: Json) => void;
  finished: Promise<Json>;
}

class CodexRun implements EngineRun {
  readonly events: AsyncIterable<EngineEvent>;
  private readonly out: EventQueue<EngineEvent>;
  private readonly launcher: Launcher | undefined;
  private readonly problem: string | undefined;
  private readonly options: EngineRunOptions;
  private readonly askUser: AskUser;
  private child: ChildProcess | undefined;
  private rpc: RpcConnection | undefined;
  /** Resolves, with what happened, once the process is gone. */
  private gone: Promise<string> | undefined;
  private exited = false;
  private stderr = '';
  private threadId: string | undefined;
  /** The turn in progress. */
  private turn: TurnState | undefined;
  /** The latest turn, also after it ended: a failure reports what it had said. */
  private lastTurn: TurnState | undefined;
  private readonly queued: string[] = [];
  private readonly steering = new Set<Promise<void>>();
  /** Tool items already reported with tool_use. */
  private readonly reported = new Set<string>();
  /** File changes of items in progress, for their approval requests. */
  private readonly changes = new Map<string, FileChange[]>();
  /** Requests put to the user, by app-server request id. They end with their turn. */
  private readonly asking = new Map<string | number, AbortController>();
  /** Async questions put to the user, by item id. They outlive their turn; the run waits for them. */
  private readonly asyncAsking = new Map<string | number, AbortController>();
  private readonly openQuestions = new Set<Promise<void>>();
  private accepting = true;
  private stopping = false;
  private finished = false;
  private limit: 'turns' | undefined;
  /** Tokens the thread has used so far (thread/tokenUsage/updated reports the running total). */
  private tokens: number | undefined;
  private forceKill: ReturnType<typeof setTimeout> | undefined;

  constructor(launcher: Launcher | string, options: EngineRunOptions, askUser: AskUser) {
    this.launcher = typeof launcher === 'string' ? undefined : launcher;
    this.problem = typeof launcher === 'string' ? launcher : undefined;
    this.options = options;
    this.askUser = askUser;
    this.out = new EventQueue<EngineEvent>(() => {
      this.stopping = true;
      this.accepting = false;
      this.kill();
    });
    this.events = this.out;
    void this.drive();
  }

  send(text: string): boolean {
    if (!this.accepting || this.stopping) return false;
    const turn = this.turn;
    if (this.rpc && turn?.id && !turn.over) this.steer(this.rpc, turn.id, text);
    else this.queued.push(text);
    return true;
  }

  async interrupt(): Promise<void> {
    if (this.finished || this.stopping) return;
    this.stopping = true;
    this.accepting = false;
    this.queued.length = 0;
    this.armForceKill();
    this.withdrawAll(this.asyncAsking);
    // Without a turn id, drive() notices `stopping` as soon as the turn has started.
    await this.interruptTurn();
  }

  // ---- the run, start to end ----

  private async drive(): Promise<void> {
    let reported = false;
    try {
      if (!this.launcher) throw new Error(this.problem ?? NOT_INSTALLED);
      const rpc = this.connect(this.launcher);
      await rpc.request('initialize', {
        clientInfo: CLIENT_INFO,
        capabilities: { experimentalApi: false, requestAttestation: false, optOutNotificationMethods: UNUSED_NOTIFICATIONS },
      });
      rpc.notify('initialized');
      const thread = await this.openThread(rpc);
      this.threadId = thread.id;
      this.emit({ type: 'session', sessionId: thread.id, model: thread.model });

      let input = [this.options.prompt, ...this.queued.splice(0)];
      while (!this.stopping) {
        reported = false;
        this.emit(await this.runTurn(rpc, input));
        reported = true;
        if (this.stopping || this.limit) break;
        // A message steered just as the turn ended comes back here when Codex refused it.
        await Promise.allSettled([...this.steering]);
        // An async question keeps the run open: its answer starts the next turn.
        while (this.queued.length === 0 && this.openQuestions.size > 0 && !this.stopping) {
          await Promise.race([...this.openQuestions]);
        }
        if (this.queued.length === 0 || this.stopping) break;
        input = this.queued.splice(0);
      }
      if (!reported) {
        reported = true;
        this.emit({ type: 'result', ok: false, text: '', error: 'Interrupted.' });
      }
    } catch (error) {
      if (!reported) {
        reported = true;
        this.emit(this.failure(error));
      }
    } finally {
      this.accepting = false;
      this.queued.length = 0;
      this.withdrawAll(this.asking);
      this.withdrawAll(this.asyncAsking);
      await this.shutdown();
      this.finished = true;
      this.out.end();
    }
  }

  private connect(launcher: Launcher): RpcConnection {
    const child = launch(launcher, ['app-server'], ['pipe', 'pipe', 'pipe']);
    this.child = child;
    const rpc = new RpcConnection(child);
    this.rpc = rpc;
    rpc.onNotification = (method, params) => this.onNotification(method, params);
    rpc.onRequest = (id, method, params) => void this.onRequest(rpc, id, method, params);

    const lines = createInterface({ input: child.stdout! });
    lines.on('line', (line) => rpc.handle(line));
    const stdoutClosed = new Promise<void>((resolve) => lines.once('close', () => resolve()));
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-2 * STDERR_LIMIT);
    });

    this.gone = new Promise<string>((resolve) => {
      let done = false;
      const end = (what: string) => {
        if (done) return;
        done = true;
        // Read what the process wrote last before calling it gone. Its MCP servers can hold
        // stdout open after it exits, so do not wait for that long.
        void within(stdoutClosed, 500).then(() => {
          this.exited = true;
          clearTimeout(this.forceKill);
          rpc.close(new Error(what));
          resolve(what);
        });
      };
      child.once('error', (error) => end(`Could not start Codex (${launcher.file}): ${error.message}`));
      child.once('exit', (code, signal) =>
        end(signal ? `Codex stopped (${signal}).` : `Codex exited with code ${code ?? 'unknown'}.`),
      );
    });
    return rpc;
  }

  private async openThread(rpc: RpcConnection): Promise<{ id: string; model: string | undefined }> {
    const settings = {
      cwd: this.options.cwd,
      model: this.options.model || undefined,
      developerInstructions: this.options.instructions || undefined,
      config: { ...THREAD_CONFIG, ...codexMcpConfig(this.options.mcpServers, this.options.permissionMode) },
    };
    const response = this.options.resumeSessionId
      ? await rpc.request('thread/resume', { ...settings, threadId: this.options.resumeSessionId, excludeTurns: true })
      : await rpc.request('thread/start', settings);
    const thread = isRecord(response.thread) ? response.thread : {};
    const id = str(thread.id);
    if (!id) throw new Error('Codex did not say which thread it opened.');
    return { id, model: str(response.model) || str(thread.model) || undefined };
  }

  private async runTurn(rpc: RpcConnection, input: string[]): Promise<ResultEvent> {
    let finish: (turn: Json) => void = () => undefined;
    const finished = new Promise<Json>((resolve) => {
      finish = resolve;
    });
    const turn: TurnState = {
      id: undefined,
      startedAt: Date.now(),
      over: false,
      interrupting: false,
      modelCalls: 0,
      atLimit: false,
      lastText: '',
      finalText: '',
      error: undefined,
      finish,
      finished,
    };
    this.turn = turn;
    this.lastTurn = turn;
    try {
      const { approvalPolicy, sandboxPolicy } = permissionsFor(
        this.options.permissionMode ?? 'default',
        this.options.additionalDirectories,
      );
      const response = await rpc.request('turn/start', {
        threadId: this.threadId,
        input: input.map(textInput),
        cwd: this.options.cwd,
        approvalPolicy,
        approvalsReviewer: 'user',
        sandboxPolicy,
        effort: this.options.effort || undefined,
      });
      const started = isRecord(response.turn) ? response.turn : {};
      turn.id ??= str(started.id) || undefined;
      // Messages that arrived while the turn was starting join it now.
      if (turn.id && !turn.over) for (const text of this.queued.splice(0)) this.steer(rpc, turn.id, text);
      if (this.stopping) void this.interruptTurn();
      const gone = this.gone?.then((what) => Promise.reject(new Error(what)));
      const completed = await (gone ? Promise.race([turn.finished, gone]) : turn.finished);
      return this.resultOf(turn, completed);
    } finally {
      turn.over = true;
      this.turn = undefined;
      // Whatever this turn still waited for is moot now.
      this.withdrawAll(this.asking);
    }
  }

  private resultOf(turn: TurnState, completed: Json): ResultEvent {
    const status = str(completed.status);
    const summary = records(completed.items).filter((item) => item.type === 'agentMessage');
    const text = turn.finalText || turn.lastText || str(summary[summary.length - 1]?.text);
    const durationMs = typeof completed.durationMs === 'number' ? completed.durationMs : Date.now() - turn.startedAt;
    const result = { type: 'result' as const, text, durationMs, numTurns: turn.modelCalls, tokens: this.tokens };
    if (status === 'completed') return { ...result, ok: true };
    if (status === 'interrupted') {
      return this.limit
        ? {
            ...result,
            ok: false,
            limit: this.limit,
            numTurns: this.options.maxTurns,
            error: `Stopped after ${this.options.maxTurns} model turns, the limit for this run.`,
          }
        : { ...result, ok: false, error: 'Interrupted.' };
    }
    const error = isRecord(completed.error) ? completed.error : {};
    const message =
      [str(error.message), str(error.additionalDetails)].filter(Boolean).join('\n') ||
      turn.error ||
      `The turn ended as "${status || 'unknown'}".`;
    return { ...result, ok: false, error: message };
  }

  private failure(error: unknown): ResultEvent {
    if (this.stopping) return { type: 'result', ok: false, text: '', error: 'Interrupted.' };
    // When the process died, its stderr says why. (Requests fail on exit only once it is read.)
    const detail = errorMessage(error);
    const stderr = this.exited ? stripAnsi(this.stderr).trim().slice(-STDERR_LIMIT) : '';
    return {
      type: 'result',
      ok: false,
      text: this.lastTurn?.finalText || this.lastTurn?.lastText || '',
      error: stderr ? `${detail}\n${stderr}` : detail,
    };
  }

  private steer(rpc: RpcConnection, turnId: string, text: string): void {
    const attempt = rpc
      .request('turn/steer', { threadId: this.threadId, expectedTurnId: turnId, input: [textInput(text)] })
      .then(
        () => undefined,
        () => {
          // The turn ended or cannot be steered: the message starts the next turn instead.
          if (!this.stopping) this.queued.push(text);
        },
      );
    this.steering.add(attempt);
    void attempt.finally(() => this.steering.delete(attempt));
  }

  private async interruptTurn(): Promise<void> {
    const turn = this.turn;
    const rpc = this.rpc;
    if (!rpc || !this.threadId || !turn?.id || turn.over || turn.interrupting) return;
    turn.interrupting = true;
    try {
      await rpc.request('turn/interrupt', { threadId: this.threadId, turnId: turn.id });
    } catch {
      // The turn just ended, or the process is gone; the force-kill timer covers a hung process.
    }
  }

  private armForceKill(): void {
    if (this.forceKill || this.exited) return;
    this.forceKill = setTimeout(() => this.kill(), FORCE_KILL_MS);
    this.forceKill.unref?.();
  }

  private kill(): void {
    if (this.child && !this.exited) killTree(this.child);
  }

  private async shutdown(): Promise<void> {
    if (!this.child || !this.gone) return;
    if (!this.exited) {
      // With stdin closed, app-server finishes up and exits.
      this.child.stdin?.end();
      this.armForceKill();
    }
    await within(this.gone, 2 * FORCE_KILL_MS);
    clearTimeout(this.forceKill);
  }

  private emit(event: EngineEvent): void {
    this.out.push(event);
  }

  // ---- notifications ----

  private onNotification(method: string, params: Json): void {
    if (method === 'serverRequest/resolved') {
      // Codex no longer needs an answer (the turn ended, for one).
      if (typeof params.requestId === 'string' || typeof params.requestId === 'number') {
        this.asking.get(params.requestId)?.abort();
      }
      return;
    }
    // Only this thread: sub-agents that Codex starts itself have their own.
    if (!this.threadId || params.threadId !== this.threadId) return;
    const turn = this.turn;
    switch (method) {
      case 'item/agentMessage/delta': {
        const delta = str(params.delta);
        if (!delta) return;
        if (turn?.atLimit) this.stopAtLimit();
        this.emit({ type: 'text_delta', text: delta });
        return;
      }
      case 'item/started':
        if (isRecord(params.item)) this.itemStarted(params.item);
        return;
      case 'item/completed':
        if (isRecord(params.item)) this.itemCompleted(params.item);
        return;
      case 'item/fileChange/patchUpdated':
        if (typeof params.itemId === 'string') this.changes.set(params.itemId, fileChanges(params.changes));
        return;
      case 'turn/started':
        if (turn && !turn.id && isRecord(params.turn)) turn.id = str(params.turn.id) || undefined;
        return;
      case 'turn/completed':
        if (turn && isRecord(params.turn)) {
          turn.over = true;
          turn.finish(params.turn);
        }
        return;
      case 'thread/tokenUsage/updated':
        // One per model call. A resumed thread also reports its earlier usage, outside any turn.
        if (isRecord(params.tokenUsage) && isRecord(params.tokenUsage.total) && typeof params.tokenUsage.total.totalTokens === 'number') {
          this.tokens = params.tokenUsage.total.totalTokens;
        }
        if (turn?.id && params.turnId === turn.id) this.countModelCall(turn);
        return;
      case 'error':
        if (turn && params.willRetry !== true && isRecord(params.error)) turn.error = str(params.error.message) || turn.error;
        return;
    }
  }

  private countModelCall(turn: TurnState): void {
    turn.modelCalls += 1;
    const max = this.options.maxTurns;
    if (max !== undefined && max > 0 && turn.modelCalls >= max) turn.atLimit = true;
  }

  /** The model starts a call past maxTurns: stop the run. */
  private stopAtLimit(): void {
    if (this.limit) return;
    this.limit = 'turns';
    this.accepting = false;
    void this.interruptTurn();
  }

  private itemStarted(item: Json): void {
    const id = str(item.id);
    if (this.turn?.atLimit && item.type !== 'userMessage') this.stopAtLimit();
    if (item.type === 'fileChange') this.changes.set(id, fileChanges(item.changes));
    if (REPORTED_ON_COMPLETION.has(str(item.type))) return;
    const tool = toolCall(item);
    if (!tool || !id) return;
    this.reported.add(id);
    this.emit({ type: 'tool_use', id, name: tool.name, input: tool.input });
  }

  private itemCompleted(item: Json): void {
    const id = str(item.id);
    if (item.type === 'agentMessage') {
      const text = str(item.text);
      if (text.trim()) {
        this.emit({ type: 'text', text });
        if (this.turn) {
          this.turn.lastText = text;
          if (item.phase === 'final_answer') this.turn.finalText = text;
        }
      }
      if (item.delivery === 'async' && records(item.questions).length > 0) this.askAsync(item);
      return;
    }
    const tool = toolCall(item);
    if (!tool || !id) return;
    if (!this.reported.delete(id)) this.emit({ type: 'tool_use', id, name: tool.name, input: tool.input });
    this.changes.delete(id);
    const outcome = toolOutcome(item);
    this.emit({ type: 'tool_result', id, isError: outcome.isError, preview: outcome.preview });
  }

  // ---- requests from Codex ----

  private async onRequest(rpc: RpcConnection, id: string | number, method: string, params: Json): Promise<void> {
    try {
      switch (method) {
        case 'item/commandExecution/requestApproval':
          return await this.approveCommand(rpc, id, params);
        case 'item/fileChange/requestApproval':
          return await this.approveFileChange(rpc, id, params);
        case 'item/permissions/requestApproval':
          return await this.approvePermissions(rpc, id, params);
        case 'item/tool/requestUserInput':
          return await this.answerQuestions(rpc, id, params);
        case 'mcpServer/elicitation/request':
          return await this.answerElicitation(rpc, id, params);
        case 'execCommandApproval':
        case 'applyPatchApproval':
          return await this.approveLegacy(rpc, id, method, params);
        case 'item/tool/call':
          // Tools a client registers itself; code-bot registers none.
          rpc.respond(id, { contentItems: [{ type: 'inputText', text: 'code-bot does not provide this tool.' }], success: false });
          return;
        default:
          // Includes account/chatgptAuthTokens/refresh: code-bot never handles credentials.
          rpc.fail(id, -32601, `code-bot does not handle "${method}"`);
      }
    } catch (error) {
      rpc.fail(id, -32603, errorMessage(error));
    }
  }

  /** Puts a request to the user. Undefined when it was withdrawn: nobody waits for the answer any more. */
  private async ask(
    id: string | number,
    request: UserRequest,
    registry: Map<string | number, AbortController> = this.asking,
  ): Promise<UserResponse | undefined> {
    const controller = new AbortController();
    registry.set(id, controller);
    try {
      return await this.askUser(request, controller.signal);
    } catch (error) {
      return controller.signal.aborted ? undefined : { decision: 'deny', message: `code-bot could not ask: ${errorMessage(error)}` };
    } finally {
      registry.delete(id);
    }
  }

  private withdrawAll(registry: Map<string | number, AbortController>): void {
    for (const controller of registry.values()) controller.abort();
  }

  /**
   * Codex's request_user_input_async posts its questions as an agent message and carries on; the
   * answer is an ordinary message from the user, steered into the turn or starting the next one.
   */
  private askAsync(item: Json): void {
    const questions = records(item.questions);
    const texts = uniqueTexts(questions.map((question) => str(question.title) || 'Question'));
    const asked = (async () => {
      const response = await this.ask(
        str(item.id),
        {
          kind: 'question',
          tool: QUESTION_TOOL,
          input: {
            questions: questions.map((question, index) => ({
              question: texts[index],
              multiSelect: false,
              options: list(question.options).map((option) => ({ label: String(option) })),
            })),
          },
        },
        this.asyncAsking,
      );
      if (!response) return;
      const answers = texts.map(
        (text) => `${text} ${answerFor(response, [text], texts.length === 1) ?? declinedAnswer(response)}`,
      );
      this.send(`${texts.length === 1 ? 'My answer to your question' : 'My answers to your questions'}:\n${answers.join('\n')}`);
    })();
    this.openQuestions.add(asked);
    void asked.finally(() => this.openQuestions.delete(asked));
  }

  /** A reason given with a refusal reaches the agent as a message. */
  private passOnRefusal(response: UserResponse): void {
    if (response.decision === 'deny' && response.message) this.send(`I declined that request: ${response.message}`);
  }

  private async approveCommand(rpc: RpcConnection, id: string | number, params: Json): Promise<void> {
    const reason = str(params.reason);
    const network = isRecord(params.networkApprovalContext) ? params.networkApprovalContext : undefined;
    const actions = records(params.commandActions).map((action) => str(action.command)).filter(Boolean);
    const input: Json = { command: str(params.command), cwd: str(params.cwd) || undefined };
    if (params.kind === 'writeStdin') input.kind = 'writeStdin';
    if (network) input.network = { host: str(network.host), protocol: str(network.protocol) };
    const summary =
      reason || (network ? `Network access to ${str(network.host)}` : actions.length > 0 ? clip(actions.join(' && '), 200) : undefined);
    const response = await this.ask(id, { kind: 'permission', tool: 'shell', input, summary });
    if (!response) return;
    rpc.respond(id, { decision: response.decision === 'allow' ? 'accept' : 'decline' });
    this.passOnRefusal(response);
  }

  private async approveFileChange(rpc: RpcConnection, id: string | number, params: Json): Promise<void> {
    const changes = this.changes.get(str(params.itemId)) ?? [];
    const [only] = changes;
    const reason = str(params.reason);
    const input: Json = changes.length === 1 && only ? { path: only.path, changes } : { changes };
    if (str(params.grantRoot)) input.grantRoot = str(params.grantRoot);
    const names = changes.map((change) => basename(change.path)).join(', ');
    const response = await this.ask(id, {
      kind: 'permission',
      tool: 'apply_patch',
      input,
      summary: reason || (names ? `Change ${names}` : 'Change files'),
    });
    if (!response) return;
    rpc.respond(id, { decision: response.decision === 'allow' ? 'accept' : 'decline' });
    this.passOnRefusal(response);
  }

  private async approvePermissions(rpc: RpcConnection, id: string | number, params: Json): Promise<void> {
    const requested = isRecord(params.permissions) ? params.permissions : {};
    const reason = str(params.reason);
    const response = await this.ask(id, {
      kind: 'permission',
      tool: 'permissions',
      input: { permissions: requested, cwd: str(params.cwd) || undefined },
      summary: reason || 'More access than the sandbox allows',
    });
    if (!response) return;
    const granted: Json = {};
    if (response.decision === 'allow') {
      if (isRecord(requested.network)) granted.network = requested.network;
      if (isRecord(requested.fileSystem)) granted.fileSystem = requested.fileSystem;
    }
    rpc.respond(id, { permissions: granted, scope: 'turn' });
    this.passOnRefusal(response);
  }

  /** Older approval requests, kept in the protocol for the v1 conversation API. */
  private async approveLegacy(rpc: RpcConnection, id: string | number, method: string, params: Json): Promise<void> {
    const reason = str(params.reason);
    const command = method === 'execCommandApproval';
    const input: Json = command
      ? { command: list(params.command).map(String).join(' '), cwd: str(params.cwd) || undefined }
      : { changes: Object.keys(isRecord(params.fileChanges) ? params.fileChanges : {}) };
    const response = await this.ask(id, { kind: 'permission', tool: command ? 'shell' : 'apply_patch', input, summary: reason || undefined });
    if (!response) return;
    rpc.respond(id, {
      decision:
        response.decision === 'allow' ? 'approved' : { denied: { rejection: response.message || 'The user declined.' } },
    });
  }

  private async answerQuestions(rpc: RpcConnection, id: string | number, params: Json): Promise<void> {
    const questions = records(params.questions);
    const answers: Record<string, { answers: string[] }> = {};
    // Secrets would be stored with the request; code-bot never handles credentials.
    for (const question of questions.filter((q) => q.isSecret === true)) answers[str(question.id)] = { answers: [SECRET_ANSWER] };
    const asked = questions.filter((q) => q.isSecret !== true);
    if (asked.length > 0) {
      const texts = uniqueTexts(asked.map((q) => str(q.question) || str(q.header) || str(q.id)));
      const response = await this.ask(id, {
        kind: 'question',
        tool: QUESTION_TOOL,
        input: {
          questions: asked.map((q, index) => ({
            question: texts[index],
            header: str(q.header) || undefined,
            multiSelect: false,
            options: records(q.options).map((option) => ({
              label: str(option.label),
              description: str(option.description) || undefined,
            })),
          })),
        },
      });
      if (!response) return;
      asked.forEach((q, index) => {
        const keys = [texts[index] ?? '', str(q.question), str(q.header), str(q.id)];
        const answer = answerFor(response, keys, asked.length === 1) ?? (response.decision === 'deny' ? declinedAnswer(response) : undefined);
        answers[str(q.id)] = { answers: answer ? [answer] : [] };
      });
    }
    rpc.respond(id, { answers });
  }

  private async answerElicitation(rpc: RpcConnection, id: string | number, params: Json): Promise<void> {
    const server = str(params.serverName);
    const message = str(params.message);
    const mode = str(params.mode);
    const fields = mode === 'form' ? formFields(params.requestedSchema) : [];
    if (fields.length > 0) {
      // A form to fill in: one question per field.
      const texts = uniqueTexts(fields.map((field) => (message ? `${message} (${field.label})` : field.label)));
      const response = await this.ask(id, {
        kind: 'question',
        tool: QUESTION_TOOL,
        input: {
          questions: fields.map((field, index) => ({
            question: texts[index],
            header: field.label,
            multiSelect: field.type === 'array',
            options: field.options.map((option) => ({ label: option.label })),
          })),
        },
        summary: `${server}: ${message}`,
      });
      if (!response) return;
      if (response.decision !== 'allow') {
        rpc.respond(id, { action: 'decline', content: null, _meta: null });
        return;
      }
      const content: Json = {};
      fields.forEach((field, index) => {
        const answer = answerFor(response, [texts[index] ?? '', field.label, field.key], fields.length === 1);
        if (answer !== undefined && answer !== '') content[field.key] = formValue(field, answer);
      });
      rpc.respond(id, { action: 'accept', content, _meta: null });
      return;
    }
    if (mode !== 'form' && mode !== 'url') {
      // Form kinds code-bot does not announce support for (openai/form): nothing to show.
      rpc.respond(id, { action: 'decline', content: null, _meta: null });
      return;
    }
    // A confirmation (Codex asks this way before some MCP tool calls) or a link to open: the user
    // allows or declines it.
    const input: Json = { server, message };
    if (str(params.url)) input.url = str(params.url);
    if (params._meta !== undefined && params._meta !== null) input.details = params._meta;
    const response = await this.ask(id, { kind: 'permission', tool: `mcp__${server}`, input, summary: message || undefined });
    if (!response) return;
    const accept = response.decision === 'allow';
    rpc.respond(id, { action: accept ? 'accept' : 'decline', content: accept && mode === 'form' ? {} : null, _meta: null });
  }
}

// ---- the engine -------------------------------------------------------------------------------

export interface CodexModel {
  id: string;
  name: string;
  description: string;
  isDefault: boolean;
  efforts: string[];
}

/** "5-hour window", "Week", "30-day window": a limit window by its length. */
function windowLabel(minutes: number | null, fallback: string): string {
  if (!minutes || minutes <= 0) return fallback;
  if (minutes === 10_080) return 'Week';
  if (minutes % 1440 === 0) return `${minutes / 1440}-day window`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour window`;
  return `${minutes}-minute window`;
}

/** The limit windows of an account/rateLimits/read answer. */
export function codexUsage(answer: Json): EngineUsageReport {
  const snapshot = isRecord(answer.rateLimits) ? answer.rateLimits : {};
  const windows: UsageWindow[] = [];
  for (const [key, fallback] of [
    ['primary', 'Main window'],
    ['secondary', 'Second window'],
  ] as const) {
    const window = snapshot[key];
    if (!isRecord(window)) continue;
    const minutes = typeof window.windowDurationMins === 'number' ? window.windowDurationMins : null;
    windows.push({
      id: key,
      label: windowLabel(minutes, fallback),
      usedPercent: typeof window.usedPercent === 'number' ? window.usedPercent : null,
      resetsAt: typeof window.resetsAt === 'number' ? new Date(window.resetsAt * 1000).toISOString() : null,
      severity: null,
    });
  }
  const plan = str(snapshot.planType) || null;
  const blocked = answer.ordinaryUsageAllowed === false;
  return {
    plan,
    windows,
    note: blocked ? 'Codex says the plan limit is reached.' : windows.length ? null : 'Codex reported no limits for this account.',
  };
}

export class CodexEngine implements Engine {
  readonly id = 'codex';
  readonly label = 'Codex';
  private readonly executable: string | undefined;
  private readonly executableArgs: string[];

  /**
   * `executable` overrides CODE_BOT_CODEX_EXECUTABLE and the search on PATH. `executableArgs` go
   * before Codex's own arguments, for running Codex through another program.
   */
  constructor(options: { executable?: string; executableArgs?: string[] } = {}) {
    this.executable = options.executable;
    this.executableArgs = options.executableArgs ?? [];
  }

  start(options: EngineRunOptions, askUser: AskUser): EngineRun {
    const mode = options.permissionMode ?? 'default';
    if (!PERMISSION_MODES.includes(mode)) {
      throw new Error(`Unknown permission mode "${mode}" for codex. Use one of: ${PERMISSION_MODES.join(', ')}`);
    }
    return new CodexRun(this.locate(), options, askUser);
  }

  async check(): Promise<EngineCheck> {
    const launcher = this.locate();
    if (typeof launcher === 'string') return { ready: false, detail: launcher };
    const status = await capture(launcher, ['login', 'status']);
    if (status.error !== undefined) return { ready: false, detail: `Codex could not be run (${launcher.file}): ${status.error}` };
    const version = await capture(launcher, ['--version']);
    const lines = status.output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    // An API-key login prints part of the key; it stays out of code-bot.
    const said = (lines.find((line) => /logged in/i.test(line)) ?? lines[0] ?? '').replace(/(API key).*$/i, '$1');
    const name = version.code === 0 ? (version.output.trim().split(/\r?\n/)[0] ?? '') : '';
    if (/not logged in/i.test(said)) {
      return {
        ready: false,
        detail: `Codex${name ? ` (${name})` : ''} is installed but not signed in.`,
        signIn: { command: launcher.file, args: [...launcher.args, 'login'] },
      };
    }
    if (status.code === 0 && /logged in/i.test(said)) return { ready: true, detail: name ? `${name}: ${said}` : said };
    return { ready: false, detail: said || `"codex login status" ended with code ${status.code ?? 'unknown'}` };
  }

  resumeCommand(sessionId: string): TerminalCommand | undefined {
    const launcher = this.locate();
    return typeof launcher === 'string' ? undefined : { command: launcher.file, args: [...launcher.args, 'resume', sessionId] };
  }

  /** The models this Codex offers (model/list). Uses no model usage. */
  async models(): Promise<CodexModel[]> {
    return this.ask('listing its models', async (rpc) => {
      const models: CodexModel[] = [];
      let cursor: string | undefined;
      do {
        const page = await rpc.request('model/list', { cursor });
        for (const model of records(page.data)) {
          if (model.hidden === true) continue;
          models.push({
            id: str(model.id),
            name: str(model.displayName) || str(model.id),
            description: str(model.description),
            isDefault: model.isDefault === true,
            efforts: records(model.supportedReasoningEfforts).map((effort) => str(effort.reasoningEffort)),
          });
        }
        cursor = str(page.nextCursor) || undefined;
      } while (cursor);
      return models;
    });
  }

  /** The ChatGPT plan's limit windows (account/rateLimits/read). Uses no model usage. */
  async usage(): Promise<EngineUsageReport> {
    try {
      const answer = await this.ask('reading its limits', (rpc) =>
        rpc.request('account/rateLimits/read', { excludeResetCreditDetails: true }),
      );
      return codexUsage(answer);
    } catch (error) {
      return { plan: null, windows: [], note: `Could not read the plan limits: ${errorMessage(error)}` };
    }
  }

  /** Starts `codex app-server`, initializes it, runs one exchange and stops it. */
  private async ask<T>(what: string, exchange: (rpc: RpcConnection) => Promise<T>): Promise<T> {
    const launcher = this.locate();
    if (typeof launcher === 'string') throw new Error(launcher);
    const child = launch(launcher, ['app-server'], ['pipe', 'pipe', 'ignore']);
    const rpc = new RpcConnection(child);
    const lines = createInterface({ input: child.stdout! });
    lines.on('line', (line) => rpc.handle(line));
    const exited = new Promise<void>((resolve) => {
      child.once('error', (error) => {
        rpc.close(error);
        resolve();
      });
      child.once('exit', () => {
        rpc.close(new Error(`Codex exited before ${what}.`));
        resolve();
      });
    });
    const timer = setTimeout(() => killTree(child), CHECK_TIMEOUT_MS);
    try {
      await rpc.request('initialize', { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: false, requestAttestation: false } });
      rpc.notify('initialized');
      return await exchange(rpc);
    } finally {
      clearTimeout(timer);
      child.stdin?.end();
      await within(exited, FORCE_KILL_MS);
      if (child.exitCode === null && child.signalCode === null) killTree(child);
    }
  }

  private locate(): Launcher | string {
    const configured = this.executable ?? (process.env.CODE_BOT_CODEX_EXECUTABLE?.trim() || undefined);
    if (configured && (isAbsolute(configured) || /[\\/]/.test(configured)) && !isProgram(configured)) {
      return `Codex is not installed at ${configured}.`;
    }
    const file = configured ?? findCodex();
    if (!file) return NOT_INSTALLED;
    return { file, args: this.executableArgs, shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(file) };
  }
}
