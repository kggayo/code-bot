/**
 * Types and constants shared by the core, the Electron main process, the
 * preload script and the renderer. Nothing here may import Node, Electron or
 * browser APIs, so every part of the app can use it.
 */

/** The main bot always has this id. */
export const MAIN_BOT_ID = 'main';

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

/**
 * How much a sub-agent may do without asking (Claude Code permission modes),
 * from strictest to most permissive.
 */
export const PERMISSION_MODES = ['plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export type BotKind = 'main' | 'project';

/** Who asked a project bot for a piece of work, and therefore who hears back about it. */
export type Requester = 'user' | 'main';

/**
 * Where a project's sub-agents work.
 * shared    in the project folders themselves (sub-agents can collide)
 * worktree  each in its own git worktree and branch, made from the folder's current commit
 */
export const ISOLATIONS = ['shared', 'worktree'] as const;
export type Isolation = (typeof ISOLATIONS)[number];

/** Files copied into new worktrees unless the project says otherwise: local settings git does not track. */
export const DEFAULT_WORKTREE_FILES: readonly string[] = ['.env', '.env.*'];

/** Defaults for the sub-agents a project bot starts. */
export interface SubagentDefaults {
  engine: string;
  /** null: the engine's default model. */
  model: string | null;
  /** null: the engine's default effort. */
  effort: Effort | null;
  permissionMode: PermissionMode;
  isolation: Isolation;
  /**
   * Untracked files to copy into each new worktree, as paths or glob patterns
   * relative to the project folder (for example ".env" or "config/*.local.json").
   */
  worktreeFiles: string[];
  /** Stop a sub-agent's run after this many agentic turns. null: no limit. */
  maxTurns: number | null;
  /** Stop a sub-agent once its estimated cost passes this many US dollars. null: no limit. */
  maxBudgetUsd: number | null;
}

export interface Bot {
  id: string;
  kind: BotKind;
  name: string;
  /** What the project is. The main bot routes requests by it. */
  description: string;
  /** Project folders. The first is where sub-agents start unless told otherwise. Empty for the main bot. */
  folders: string[];
  /** Standing instructions from the user for this bot. */
  instructions: string;
  /** The bot's own model and effort. null: the engine's default. */
  model: string | null;
  effort: Effort | null;
  /** Defaults for its sub-agents (project bots only). */
  subagents: SubagentDefaults;
  /** The current conversation. */
  threadId: string;
  createdAt: string;
  updatedAt: string;
}

export interface BotStatus {
  /** The bot is replying or has messages waiting. */
  busy: boolean;
  /** Sub-agents running or waiting. For the main bot: across all projects. */
  activeSubagents: number;
  /** Questions and approvals waiting for the user in this bot's conversation. */
  needsYou: number;
}

export interface BotView extends Bot {
  status: BotStatus;
}

export interface BotInput {
  name: string;
  description: string;
  folders: string[];
  instructions: string;
  model: string | null;
  effort: Effort | null;
  subagents: SubagentDefaults;
}

export type BotPatch = Partial<BotInput>;

/**
 * running     the sub-agent is working
 * waiting     blocked on a question or an approval
 * done        finished; a follow-up message continues the same session
 * failed      ended with an error
 * cancelled   stopped
 * interrupted the app closed while it was active; a follow-up message resumes it
 */
export type TaskState = 'running' | 'waiting' | 'done' | 'failed' | 'cancelled' | 'interrupted';
export const ACTIVE_STATES: readonly TaskState[] = ['running', 'waiting'];

/** A sub-agent's own git worktree. */
export interface TaskWorktree {
  /** The worktree folder; the sub-agent works in it (or in the matching subfolder). */
  path: string;
  /** The branch the sub-agent commits to, e.g. "code-bot/t_ab12cd34ef-fix-login". */
  branch: string;
  /** The branch (or "HEAD" when detached) the project folder was on when the worktree was made. */
  base: string;
  /** The commit the branch started from. */
  baseCommit: string;
  /** The project folder it was made from. */
  folder: string;
  /** The worktree folder was removed (the branch may remain). */
  removed: boolean;
}

/** One sub-agent's work: a conversation with one coding agent in a project's folders. */
export interface Task {
  id: string;
  /** The project bot that owns it. */
  botId: string;
  title: string;
  state: TaskState;
  /** Who asked the project bot for this work; reports go back to them. */
  requestedBy: Requester;
  engine: string;
  model: string | null;
  effort: string | null;
  permissionMode: string;
  cwd: string;
  additionalDirectories: string[];
  /** Standing instructions appended to the engine's own system prompt. */
  instructions: string;
  engineSessionId: string | null;
  /** Final message of the most recent turn: the sub-agent's report. */
  lastResult: string | null;
  error: string | null;
  /** The engine's estimate for the whole session, in US dollars. */
  costUsd: number;
  /** Turn limit per run, from the project's settings when it started. */
  maxTurns: number | null;
  /** Budget for the whole sub-agent, from the project's settings when it started. */
  maxBudgetUsd: number | null;
  /** Set when it works in its own git worktree. */
  worktree: TaskWorktree | null;
  /** Hidden from the lists since then. */
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A sub-agent waiting for an answer: a question, or approval for an action. */
export interface PendingRequest {
  id: string;
  taskId: string;
  botId: string;
  kind: 'permission' | 'question';
  /** The tool the sub-agent wants to use; "AskUserQuestion" for questions. */
  tool: string;
  input: unknown;
  summary?: string;
  createdAt: string;
  /** The conversation where it was put to the user, once it was. */
  surfacedIn: string | null;
  /**
   * The sub-agent is no longer running (code-bot was closed while it waited).
   * Answering resumes it with the answer.
   */
  held?: boolean;
}

export type UserResponse =
  | { decision: 'allow'; answers?: Record<string, string> }
  | { decision: 'deny'; message?: string };

export interface StoredEvent {
  seq: number;
  ts: string;
  type: string;
  data: unknown;
}

export interface CoreEvent {
  /**
   * thread: a bot's conversation (id is the thread id).
   * task: a sub-agent's work (id is the task id).
   * bot: a bot's settings or status changed (id is the bot id).
   * app: app-wide news such as changed settings or engine checks (id is "app").
   */
  scope: 'thread' | 'task' | 'bot' | 'app';
  id: string;
  /** The bot the event belongs to. */
  botId: string;
  /** Position in the stored history of the thread or task. 0 for live-only events. */
  seq: number;
  ts: string;
  type: string;
  data: unknown;
}

/** data of an "inbound" thread event: something another party sent this bot. */
export interface InboundData {
  from: 'main' | 'project' | 'subagent';
  /** For reports: the project bot that sent it. */
  botId?: string;
  name?: string;
  /** For sub-agent updates: the task. */
  taskId?: string;
  text: string;
}

/** data of a "request.surfaced" thread event: a question or approval put to the user. */
export interface SurfacedData {
  request: PendingRequest;
  taskTitle: string;
  botName: string;
}

/** data of a "request.closed" thread event. */
export interface ClosedData {
  requestId: string;
  decision: 'allow' | 'deny' | 'withdrawn';
  /** user: answered by the user. bot: answered by the project bot. system: the sub-agent stopped first. */
  by: 'user' | 'bot' | 'system';
}

/** data of a "turn.end" thread event. */
export interface TurnEndData {
  ok: boolean;
  error?: string;
  /** Set when the reply was passed on to the main bot. */
  forwardedTo?: 'main';
}

export interface ThreadView {
  botId: string;
  threadId: string;
  /** This is the bot's current conversation (earlier ones are read-only until reopened). */
  current: boolean;
  busy: boolean;
  events: CoreEvent[];
}

/** One conversation with a bot, for the list of earlier conversations. */
export interface ConversationSummary {
  threadId: string;
  botId: string;
  /** The first message, shortened. */
  title: string;
  createdAt: string;
  /** Time of the latest message. */
  lastActivity: string;
  messages: number;
  current: boolean;
  archivedAt: string | null;
}

/** App-wide settings. */
export interface AppSettings {
  /** At most this many sub-agents work at the same time, across all projects (1-50). */
  maxActiveSubagents: number;
  /** Archive finished sub-agents and earlier conversations after this many days without activity. 0: never. */
  archiveAfterDays: number;
  /** Delete archived sub-agents and conversations this many days after they were archived. 0: never. */
  deleteArchivedAfterDays: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  maxActiveSubagents: 12,
  archiveAfterDays: 30,
  deleteArchivedAfterDays: 0,
};

/** Whether a coding agent can run on this machine. */
export interface EngineInfo {
  id: string;
  label: string;
  /** null while it has not been checked. */
  ready: boolean | null;
  detail: string;
  /** code-bot can open a terminal that signs in to this agent. */
  canSignIn: boolean;
  /** Its sessions can be continued in a terminal. */
  canResume: boolean;
}

export interface TaskView {
  task: Task;
  pendingRequests: PendingRequest[];
  events: CoreEvent[];
}

export interface AppInfo {
  version: string;
  dataDir: string;
  platform: string;
  /** Scripted models instead of real ones (tests and demos). */
  fakeModels: boolean;
  engines: string[];
}

export interface FolderCheck {
  path: string;
  exists: boolean;
}

/**
 * Everything the interface can ask of the app. In the desktop app the
 * renderer calls these over IPC; a future remote client would call the same
 * operations over HTTP.
 */
export interface CodeBotApi {
  appInfo(): Promise<AppInfo>;
  getSettings(): Promise<AppSettings>;
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  /** Checks that each coding agent is installed and signed in. */
  checkEngines(): Promise<EngineInfo[]>;
  listBots(): Promise<BotView[]>;
  createBot(input: BotInput): Promise<BotView>;
  updateBot(botId: string, patch: BotPatch): Promise<BotView>;
  archiveBot(botId: string): Promise<void>;
  getThread(botId: string, after?: number): Promise<ThreadView>;
  sendToBot(botId: string, text: string): Promise<void>;
  newConversation(botId: string): Promise<ThreadView>;
  /** The bot's conversations, newest first. */
  listConversations(botId: string, options?: { archived?: boolean }): Promise<ConversationSummary[]>;
  /** One conversation, current or earlier. */
  getConversation(botId: string, threadId: string, after?: number): Promise<ThreadView>;
  /** Makes an earlier conversation the current one again. */
  reopenConversation(botId: string, threadId: string): Promise<ThreadView>;
  /** Hides an earlier conversation (or shows it again). The current one cannot be archived. */
  setConversationArchived(botId: string, threadId: string, archived: boolean): Promise<void>;
  stopBot(botId: string): Promise<void>;
  listTasks(filter?: { botId?: string; limit?: number; archived?: boolean }): Promise<Task[]>;
  getTask(taskId: string, after?: number): Promise<TaskView>;
  sendToTask(taskId: string, text: string): Promise<void>;
  cancelTask(taskId: string): Promise<void>;
  /**
   * Hides a finished sub-agent (or shows it again). Archiving removes its git
   * worktree; with uncommitted changes there it refuses unless discardChanges.
   */
  setTaskArchived(taskId: string, archived: boolean, options?: { discardChanges?: boolean }): Promise<void>;
  listRequests(): Promise<PendingRequest[]>;
  respond(taskId: string, requestId: string, response: UserResponse): Promise<void>;
  checkFolders(paths: string[]): Promise<FolderCheck[]>;
  /** Desktop only: native folder picker. Empty when cancelled. */
  pickFolders(): Promise<string[]>;
  /** Desktop only: open an http(s) link in the default browser. */
  openExternal(url: string): Promise<void>;
  /** Desktop only: show a project folder or a sub-agent's worktree in the file manager. */
  openPath(path: string): Promise<void>;
  /** Desktop only: a system notification; clicking it opens the bot. */
  notify(notice: { title: string; body: string; botId?: string }): Promise<void>;
  /** Desktop only: opens a terminal that signs in to a coding agent. */
  signIn(engineId: string): Promise<void>;
  /** Desktop only: opens a terminal that continues a stopped sub-agent's session interactively. */
  openInTerminal(taskId: string): Promise<void>;
}

export type CodeBotMethod = keyof CodeBotApi;

/** What the preload script exposes to the renderer as `window.codeBot`. */
export interface DesktopBridge {
  call(method: CodeBotMethod, args: unknown[]): Promise<unknown>;
  onEvent(listener: (event: CoreEvent) => void): () => void;
  /** A system notification was clicked: open this bot. */
  onFocusBot(listener: (botId: string) => void): () => void;
  platform: string;
}

/** IPC channel names between the main process and the renderer. */
export const IPC = {
  call: 'code-bot:call',
  event: 'code-bot:event',
  focusBot: 'code-bot:focus-bot',
} as const;
