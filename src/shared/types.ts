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

/**
 * What a sub-agent is for. One piece of work (a ticket) has one developer, from
 * investigation to fix; QA and reviewers check that developer's work and their
 * findings go back to it.
 */
export const SUBAGENT_ROLES = ['developer', 'qa', 'reviewer', 'other'] as const;
export type SubagentRole = (typeof SUBAGENT_ROLES)[number];

/**
 * An MCP server that code-bot gives a project's sub-agents, on top of the ones they already
 * load from the user's own Claude Code or Codex setup. code-bot stores no keys or tokens for it:
 * a server that needs one reads it from the environment code-bot runs in.
 */
export type McpServer = McpStdioServer | McpHttpServer;

interface McpServerBase {
  /** What the agents call it; its tools are named mcp__<name>__<tool>. Letters, digits, "_" and "-". */
  name: string;
  /** Its tools run without asking (except for sub-agents in plan mode). Otherwise each call is an approval. */
  allowTools: boolean;
}

/** A program the agent starts on this computer and talks to over stdin and stdout. */
export interface McpStdioServer extends McpServerBase {
  type: 'stdio';
  command: string;
  args: string[];
}

/** A server reached over HTTP (streamable HTTP). */
export interface McpHttpServer extends McpServerBase {
  type: 'http';
  url: string;
}

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
  /** MCP servers for every sub-agent of the project, read again at each of their turns. */
  mcpServers: McpServer[];
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
  /** What the bot and its sub-agents have used so far. */
  usage: BotUsage;
}

/**
 * Model usage so far, as the engines estimate it (US dollars at API prices; on
 * a subscription nothing is billed per call, but it shows what used the most).
 */
export interface BotUsage {
  /** The bot's own conversations. */
  botUsd: number;
  /** For the main bot: every project bot's own conversations. 0 for project bots. */
  projectBotsUsd: number;
  /** Its sub-agents (for the main bot: every project's), archived ones included. */
  subagentsUsd: number;
  /** Tokens of sub-agents whose engine reports tokens instead of money (Codex). */
  subagentTokens: number;
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
  /** What it is for. Sub-agents from before roles existed are developers. */
  role: SubagentRole;
  /** For QA and reviewers: the developer sub-agent whose work this one checks. */
  forTaskId: string | null;
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
  /** Tokens used by the whole session, for engines that report tokens instead of money (Codex). 0 otherwise. */
  tokens: number;
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
  /** For answered questions: each question's text and the answer given. */
  answers?: Record<string, string>;
  /** For declined requests: the note that went with it, if any. */
  message?: string;
}

/** data of a "routine.run" thread event: a routine started a turn in this conversation. */
export interface RoutineRunData {
  routineId: string;
  title: string;
  text: string;
  /** true when it was started by hand ("Run now"), not by its schedule. */
  manual: boolean;
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

/** One limit window of a coding agent's plan, such as the 5-hour session or the week. */
export interface UsageWindow {
  /** Stable key, e.g. "session", "weekly_all", "weekly_opus", "primary". */
  id: string;
  /** For people, e.g. "5-hour session" or "Week · Opus". */
  label: string;
  /** Share of the window used, 0-100. null when the agent did not say. */
  usedPercent: number | null;
  /** When the window resets (ISO time). */
  resetsAt: string | null;
  /** The agent's own reading of it, when it gives one. */
  severity: 'normal' | 'warning' | 'critical' | null;
}

/** How much of a coding agent's plan limits is used, as the agent reports it. Uses no model usage to find out. */
export interface EngineUsage {
  engineId: string;
  label: string;
  /** The plan, e.g. "max" or "plus", when known. */
  plan: string | null;
  windows: UsageWindow[];
  /** Why there are no windows (an API key has no plan limits), or what went wrong. */
  note: string | null;
  checkedAt: string;
}

/**
 * When a routine runs, in the computer's local time.
 * once      at one moment
 * daily     at a time of day, on the chosen weekdays (0 = Sunday … 6 = Saturday)
 * interval  every so many minutes (at least 15) from when it was set up
 */
export type RoutineSchedule =
  | { kind: 'once'; at: string }
  | { kind: 'daily'; time: string; days: number[] }
  | { kind: 'interval'; minutes: number };

/** A message sent to a bot on a schedule, as if the user typed it. */
export interface Routine {
  id: string;
  /** The main bot or a project bot. */
  botId: string;
  title: string;
  /** What the bot is told each time. */
  prompt: string;
  schedule: RoutineSchedule;
  enabled: boolean;
  /** null when it will not run again (a "once" routine that ran, or a disabled one). */
  nextRunAt: string | null;
  lastRunAt: string | null;
  /** Why the last run could not start, if it could not. */
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RoutineInput {
  botId: string;
  title: string;
  prompt: string;
  schedule: RoutineSchedule;
  enabled: boolean;
}

export type RoutinePatch = Partial<RoutineInput>;

/** Whether a newer code-bot has been released, and how it can be installed here. */
export interface UpdateInfo {
  current: string;
  /** The newest released version, once checked. */
  latest: string | null;
  available: boolean;
  /**
   * installer  code-bot can download the new installer and start it (installed Windows app)
   * manual     the release page is opened; download and install by hand (portable zip, Linux, macOS, running from source)
   */
  method: 'installer' | 'manual';
  /** Why it is manual here, for people. */
  methodNote: string | null;
  /** The release page. */
  url: string | null;
  /** Release notes (Markdown). */
  notes: string | null;
  checkedAt: string | null;
  /** Set while the installer downloads: 0-100. */
  downloadPercent: number | null;
  error: string | null;
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
  /** The coding agents' plan limits, as last checked (checks when never checked). */
  getUsage(): Promise<EngineUsage[]>;
  /** Checks the coding agents' plan limits now. */
  checkUsage(): Promise<EngineUsage[]>;
  /** Every routine, soonest first. */
  listRoutines(): Promise<Routine[]>;
  createRoutine(input: RoutineInput): Promise<Routine>;
  updateRoutine(routineId: string, patch: RoutinePatch): Promise<Routine>;
  deleteRoutine(routineId: string): Promise<void>;
  /** Runs a routine now, without changing its schedule. */
  runRoutine(routineId: string): Promise<void>;
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
  /** Desktop only: what the last update check found. */
  getUpdate(): Promise<UpdateInfo>;
  /** Desktop only: asks GitHub for the newest release. */
  checkForUpdate(): Promise<UpdateInfo>;
  /**
   * Desktop only: installs the newest release. With method "installer" it downloads the
   * installer, starts it and quits code-bot; with "manual" it opens the release page.
   */
  installUpdate(): Promise<void>;
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
