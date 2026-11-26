import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { DEFAULT_SETTINGS, DEFAULT_WORKTREE_FILES, EFFORTS, ISOLATIONS, MAIN_BOT_ID, PERMISSION_MODES } from '../shared/types.ts';
import type {
  AppSettings,
  Bot,
  BotInput,
  BotPatch,
  BotStatus,
  BotUsage,
  BotView,
  ClosedData,
  ConversationSummary,
  CoreEvent,
  Effort,
  EngineInfo,
  EngineUsage,
  FolderCheck,
  InboundData,
  Isolation,
  PendingRequest,
  PermissionMode,
  Requester,
  Routine,
  RoutineInput,
  RoutinePatch,
  RoutineRunData,
  SubagentDefaults,
  SurfacedData,
  Task,
  TaskState,
  TaskView,
  TaskWorktree,
  ThreadView,
  UserResponse,
} from '../shared/types.ts';
import type { Brain } from './brain.ts';
import type { Engine, EngineCheck, EngineUsageReport, TerminalCommand } from './engines/types.ts';
import * as prompts from './prompts.ts';
import { cleanSchedule, nextRun } from './routines.ts';
import { BotRuntime } from './runtime.ts';
import { cleanMcpServers } from './mcp.ts';
import type { BrainOptions, Inbound, PreparedTurn, RuntimeHost, TurnOutcome } from './runtime.ts';
import type { Store } from './store.ts';
import { TaskManager } from './tasks.ts';
import type { TurnSetup } from './tasks.ts';
import { mainBotTools, projectBotTools } from './tools.ts';
import type { SubagentArgs, ToolHost } from './tools.ts';
import { CodeBotError, clip, errorMessage, newId, titleFrom } from './util.ts';
import { cleanWorktreeFiles, createWorktree, removeWorktree, restoreWorktree, worktreeStatus } from './worktrees.ts';

export interface CodeBotOptions {
  store: Store;
  engines: Engine[];
  brain: Brain;
  /** Working folder for the main bot, which holds no project files. */
  workDir: string;
  /** Where sub-agents' git worktrees go. Default: a "worktrees" folder next to workDir. */
  worktreeDir?: string;
  /** Engine that new project bots use for their sub-agents. Default: the first engine. */
  defaultEngine?: string;
  /** How long a sub-agent's question waits for its project bot before it goes to the user anyway. */
  questionTimeoutMs?: number;
  /** How often old sub-agents and conversations are archived (and deleted, if set). 0: never automatically. */
  retentionIntervalMs?: number;
  /** How often the coding agents' plan limits are read. 0: only when asked (checkUsage). */
  usageIntervalMs?: number;
  /** How often due routines are looked for. 0: only when asked (runDueRoutines). */
  routineTickMs?: number;
}

/** What a terminal needs to continue a sub-agent's session. */
export interface TerminalLaunch extends TerminalCommand {
  cwd: string;
}

export interface RetentionResult {
  archivedSubagents: number;
  archivedConversations: number;
  deletedSubagents: number;
  deletedConversations: number;
}

const DEFAULT_QUESTION_TIMEOUT_MS = 120_000;
const DEFAULT_RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FIRST_RETENTION_DELAY_MS = 60_000;
const DEFAULT_USAGE_INTERVAL_MS = 10 * 60 * 1000;
const FIRST_USAGE_DELAY_MS = 3000;
/** After work ends the limits are read again, but at most this often. */
const USAGE_MIN_GAP_MS = 2 * 60 * 1000;
const DEFAULT_ROUTINE_TICK_MS = 30_000;
const FIRST_ROUTINE_DELAY_MS = 5000;
const MAX_ROUTINE_PROMPT = 20_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u;
const RESERVED_NAMES = new Set(['main', 'main bot']);
const MAX_FOLDERS = 10;
/** Worktrees of this many recent sub-agents are readable by their project bot. */
const READABLE_WORKTREES = 10;
const FINISHED_STATES: readonly TaskState[] = ['done', 'failed', 'cancelled', 'interrupted'];

const permissionRank = (mode: PermissionMode) => PERMISSION_MODES.indexOf(mode);
const folderKey = (folder: string) => (process.platform === 'win32' ? folder.toLowerCase() : folder);

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function wholeNumber(value: unknown, min: number, max: number, what: string): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new CodeBotError('invalid', `${what} must be a whole number from ${min} to ${max}`);
  }
  return number;
}

function defaultSubagents(engine: string): SubagentDefaults {
  return {
    engine,
    model: null,
    effort: null,
    permissionMode: 'acceptEdits',
    isolation: 'shared',
    worktreeFiles: [...DEFAULT_WORKTREE_FILES],
    maxTurns: null,
    maxBudgetUsd: null,
    mcpServers: [],
  };
}

/**
 * The orchestrator. Three levels:
 *   main bot      the user's manager; routes requests to project bots
 *   project bot   one per project; the team lead who runs sub-agents
 *   sub-agent     a coding agent doing one task in the project's folders
 * Work flows down, reports flow back up to whoever asked. Nothing here knows
 * about Electron, so the same core can run headless later.
 */
export class CodeBot {
  readonly tasks: TaskManager;
  private readonly store: Store;
  private readonly brain: Brain;
  private readonly workDir: string;
  private readonly worktreeDir: string;
  private readonly defaultEngine: string;
  private readonly questionTimeoutMs: number;
  private readonly runtimes = new Map<string, BotRuntime>();
  private readonly emitter = new EventEmitter();
  private readonly questionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Retention, usage and routine timers, cleared at shutdown. */
  private readonly timers: ReturnType<typeof setTimeout>[] = [];
  private readonly host: RuntimeHost;
  private readonly toolHost: ToolHost;
  private readonly usageIntervalMs: number;
  /** The plan limits as last read, per engine. */
  private usage: EngineUsage[] = [];
  private usageCheck: Promise<EngineUsage[]> | undefined;
  private lastUsageCheck = 0;
  private usageSoonTimer: ReturnType<typeof setTimeout> | undefined;
  private closing = false;

  constructor(options: CodeBotOptions) {
    this.store = options.store;
    this.brain = options.brain;
    this.workDir = options.workDir;
    this.worktreeDir = options.worktreeDir ?? join(dirname(resolve(this.workDir)), 'worktrees');
    mkdirSync(this.workDir, { recursive: true });
    this.tasks = new TaskManager({
      store: options.store,
      engines: options.engines,
      maxActive: () => this.getSettings().maxActiveSubagents,
      prepareTurn: (task) => this.prepareTurn(task),
    });
    this.defaultEngine = options.defaultEngine ?? this.tasks.engineIds()[0] ?? 'claude';
    this.questionTimeoutMs = options.questionTimeoutMs ?? DEFAULT_QUESTION_TIMEOUT_MS;
    this.emitter.setMaxListeners(0);

    this.host = {
      prepare: (botId, items) => this.prepare(botId, items),
      brainOptions: (botId) => this.brainOptions(botId),
      conversation: (botId) => {
        const bot = this.bot(botId);
        return { threadId: bot.threadId, sessionId: this.store.getThread(bot.threadId)?.engineSessionId ?? null };
      },
      saveSession: (threadId, sessionId) => this.store.setThreadSession(threadId, sessionId),
      saveCost: (threadId, costUsd) => this.saveCost(threadId, costUsd),
      emit: (threadId, botId, type, data, liveOnly) => this.emitThread(threadId, botId, type, data, liveOnly),
      finished: (botId, turn, outcome) => {
        this.usageSoon();
        return this.finished(botId, turn, outcome);
      },
      statusChanged: (botId) => this.statusChanged(botId),
    };
    this.toolHost = {
      tasks: this.tasks,
      projectBots: () => this.listBots().filter((bot) => bot.kind === 'project'),
      findProjectBot: (nameOrId) => this.findProjectBot(nameOrId),
      messageProjectBot: (bot, text) => this.messageProjectBot(bot, text),
      startSubagent: (bot, args, requestedBy) => this.startSubagent(bot, args, requestedBy),
      setSubagentPermission: (bot, taskId, mode) => this.setSubagentPermission(bot, taskId, mode),
      respondAsBot: (taskId, requestId, response) => this.tasks.respond(taskId, requestId, response, 'bot'),
      matchFolder: (bot, folder) => this.matchFolder(bot, folder),
      matchGitFolder: (bot, folder) => this.matchGitFolder(bot, folder),
    };

    this.ensureMainBot();
    this.tasks.subscribe((event) => {
      this.emitter.emit('event', event);
      try {
        this.onTaskEvent(event);
      } catch (error) {
        console.error('code-bot: could not route a sub-agent event:', error);
      }
    });
    // Questions and approvals still open from before a restart go to the user.
    for (const request of this.tasks.pendingRequests()) {
      if (request.held && !request.surfacedIn) this.surface(request);
    }

    const every = options.retentionIntervalMs ?? DEFAULT_RETENTION_INTERVAL_MS;
    if (every > 0) {
      this.repeat(every, Math.min(FIRST_RETENTION_DELAY_MS, every), () => {
        this.runRetention().catch((error) => console.error('code-bot: retention failed:', error));
      });
    }
    this.usageIntervalMs = options.usageIntervalMs ?? DEFAULT_USAGE_INTERVAL_MS;
    if (this.usageIntervalMs > 0) {
      this.repeat(this.usageIntervalMs, FIRST_USAGE_DELAY_MS, () => void this.checkUsage());
    }
    const tick = options.routineTickMs ?? DEFAULT_ROUTINE_TICK_MS;
    if (tick > 0) {
      // The first look also runs routines that came due while code-bot was closed, once each.
      this.repeat(tick, Math.min(FIRST_ROUTINE_DELAY_MS, tick), () => this.runDueRoutines());
    }
  }

  /** Runs `job` after `first` ms and then every `every` ms, without keeping the process alive. */
  private repeat(every: number, first: number, job: () => void): void {
    const once = setTimeout(job, first);
    const later = setInterval(job, every);
    once.unref?.();
    later.unref?.();
    this.timers.push(once, later);
  }

  // ---- settings and engines ----------------------------------------------------

  getSettings(): AppSettings {
    const stored = this.store.getSettings();
    const settings = { ...DEFAULT_SETTINGS };
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[]) {
      if (typeof stored[key] === 'number') settings[key] = stored[key] as number;
    }
    return settings;
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    const next = this.getSettings();
    if (patch.maxActiveSubagents !== undefined) {
      next.maxActiveSubagents = wholeNumber(patch.maxActiveSubagents, 1, 50, 'The number of sub-agents working at once');
    }
    if (patch.archiveAfterDays !== undefined) {
      next.archiveAfterDays = wholeNumber(patch.archiveAfterDays, 0, 3650, 'Days before archiving');
    }
    if (patch.deleteArchivedAfterDays !== undefined) {
      next.deleteArchivedAfterDays = wholeNumber(patch.deleteArchivedAfterDays, 0, 3650, 'Days before deleting');
    }
    this.store.saveSettings(next);
    this.emitApp('settings', next);
    return next;
  }

  /** Checks each coding agent: installed and signed in. Uses no model usage. */
  async checkEngines(): Promise<EngineInfo[]> {
    const infos = await Promise.all(
      this.tasks.engineIds().map(async (id): Promise<EngineInfo> => {
        const engine = this.tasks.engine(id) as Engine;
        let check: EngineCheck | undefined;
        if (engine.check) {
          try {
            check = await engine.check();
          } catch (error) {
            check = { ready: false, detail: errorMessage(error) };
          }
        }
        return {
          id,
          label: engine.label,
          ready: check ? check.ready : null,
          detail: check?.detail ?? 'Not checked.',
          canSignIn: Boolean(check?.signIn),
          canResume: typeof engine.resumeCommand === 'function',
        };
      }),
    );
    this.emitApp('engines', infos);
    return infos;
  }

  /** The coding agents' plan limits as last read; reads them when they never were. */
  async getUsage(): Promise<EngineUsage[]> {
    return this.lastUsageCheck === 0 ? this.checkUsage() : this.usage;
  }

  /**
   * Reads the plan limits of the agents in use: the bots' (Claude Code) and
   * every project's sub-agent engine. Uses no model usage. Concurrent calls
   * share one check.
   */
  checkUsage(): Promise<EngineUsage[]> {
    if (this.usageCheck) return this.usageCheck;
    this.usageCheck = (async () => {
      const used = new Set<string>([this.defaultEngine, ...this.tasks.engineIds().filter((id) => id === 'claude')]);
      for (const bot of this.store.listBots()) if (bot.kind === 'project') used.add(bot.subagents.engine);
      const engines = [...used].flatMap((id) => this.tasks.engine(id) ?? []).filter((engine) => engine.usage);
      const results = await Promise.all(
        engines.map(async (engine): Promise<EngineUsage> => {
          let report: EngineUsageReport;
          try {
            report = await engine.usage!();
          } catch (error) {
            report = { plan: null, windows: [], note: errorMessage(error) };
          }
          return { engineId: engine.id, label: engine.label, ...report, checkedAt: new Date().toISOString() };
        }),
      );
      this.usage = results;
      if (!this.closing) this.emitApp('usage', results);
      return results;
    })().finally(() => {
      this.usageCheck = undefined;
      this.lastUsageCheck = Date.now();
    });
    return this.usageCheck;
  }

  /** Reads the limits again soon after work ended, but not more often than every two minutes. */
  private usageSoon(): void {
    if (this.usageIntervalMs <= 0 || this.usageSoonTimer || this.closing) return;
    const wait = Math.max(5000, this.lastUsageCheck + USAGE_MIN_GAP_MS - Date.now());
    this.usageSoonTimer = setTimeout(() => {
      this.usageSoonTimer = undefined;
      void this.checkUsage();
    }, wait);
    this.usageSoonTimer.unref?.();
  }

  /** The command that signs in to an engine, for a terminal. */
  async signInCommand(engineId: string): Promise<TerminalCommand> {
    const engine = this.tasks.engine(engineId);
    if (!engine) throw new CodeBotError('not_found', `No engine "${engineId}"`);
    const check = engine.check ? await engine.check() : undefined;
    if (check?.ready) throw new CodeBotError('conflict', `${engine.label} is already signed in`);
    if (!check?.signIn) {
      throw new CodeBotError('invalid', `${engine.label} cannot be signed in from code-bot${check ? `: ${check.detail}` : ''}`);
    }
    return check.signIn;
  }

  /** The command and folder that continue a stopped sub-agent's session interactively. */
  terminalLaunch(taskId: string): TerminalLaunch {
    let task = this.tasks.getTask(taskId);
    if (this.tasks.isActive(taskId)) {
      throw new CodeBotError('conflict', `Sub-agent ${taskId} is working. Stop it, or wait until it finishes, before continuing it in a terminal.`);
    }
    if (!task.engineSessionId) throw new CodeBotError('invalid', `Sub-agent ${taskId} has no session to continue yet`);
    const engine = this.tasks.engine(task.engine);
    const command = engine?.resumeCommand?.(task.engineSessionId);
    if (!engine || !command) {
      throw new CodeBotError('invalid', `${engine?.label ?? task.engine} sessions cannot be continued in a terminal`);
    }
    if (task.worktree && (task.worktree.removed || !existsSync(task.worktree.path))) {
      task = this.tasks.setWorktree(taskId, restoreWorktree(task.worktree));
    }
    if (!isDirectory(task.cwd)) throw new CodeBotError('invalid', `The folder ${task.cwd} no longer exists`);
    return { ...command, cwd: task.cwd };
  }

  // ---- bots --------------------------------------------------------------------

  listBots(): BotView[] {
    return this.store.listBots().map((bot) => ({ ...bot, status: this.status(bot) }));
  }

  bot(botId: string): Bot {
    const bot = this.store.getBot(botId);
    if (!bot) throw new CodeBotError('not_found', `No bot with id "${botId}"`);
    return bot;
  }

  createBot(input: BotInput): BotView {
    const clean = this.validate(input);
    const now = new Date().toISOString();
    const id = newId('b');
    const threadId = this.createThread(id);
    const bot: Bot = { id, kind: 'project', ...clean, threadId, createdAt: now, updatedAt: now };
    this.store.insertBot(bot);
    this.emitBot(id, 'changed', {});
    return this.view(bot);
  }

  updateBot(botId: string, patch: BotPatch): BotView {
    const bot = this.bot(botId);
    let next: Bot;
    if (bot.kind === 'main') {
      next = {
        ...bot,
        instructions: patch.instructions !== undefined ? String(patch.instructions).trim() : bot.instructions,
        model: patch.model !== undefined ? this.cleanModel(patch.model) : bot.model,
        effort: patch.effort !== undefined ? this.cleanEffort(patch.effort) : bot.effort,
      };
    } else {
      const merged: BotInput = {
        name: patch.name ?? bot.name,
        description: patch.description ?? bot.description,
        folders: patch.folders ?? bot.folders,
        instructions: patch.instructions ?? bot.instructions,
        model: patch.model !== undefined ? patch.model : bot.model,
        effort: patch.effort !== undefined ? patch.effort : bot.effort,
        subagents: { ...bot.subagents, ...patch.subagents },
      };
      next = { ...bot, ...this.validate(merged, bot.id) };
    }
    next.updatedAt = new Date().toISOString();
    this.store.saveBot(next);
    this.emitBot(botId, 'changed', {});
    return this.view(next);
  }

  /** Removes a project bot from the app. Its history stays in the database. */
  archiveBot(botId: string): void {
    const bot = this.bot(botId);
    if (bot.kind === 'main') throw new CodeBotError('invalid', 'The main bot cannot be removed');
    const active = this.tasks.countActive(botId);
    if (active > 0) {
      throw new CodeBotError('conflict', `${bot.name} still has ${active} sub-agent(s) working. Stop them first.`);
    }
    for (const task of this.tasks.listTasks({ botId, states: ['interrupted'], limit: 10_000 })) {
      if (this.tasks.hasHeld(task.id)) void this.tasks.cancel(task.id);
    }
    this.runtimes.get(botId)?.stop();
    this.runtimes.delete(botId);
    this.store.archiveBot(botId);
    this.emitBot(botId, 'archived', {});
  }

  checkFolders(paths: string[]): FolderCheck[] {
    return paths.map((path) => ({ path, exists: isAbsolute(path) && isDirectory(path) }));
  }

  // ---- conversations -----------------------------------------------------------

  getThread(botId: string, after = 0): ThreadView {
    const bot = this.bot(botId);
    return {
      botId,
      threadId: bot.threadId,
      current: true,
      busy: this.runtimes.get(botId)?.isBusy() ?? false,
      events: this.threadEvents(bot.threadId, botId, after),
    };
  }

  /** A message from the user to a bot. The reply arrives as thread events. */
  sendToBot(botId: string, text: string): void {
    const bot = this.bot(botId);
    const message = text.trim();
    if (!message) throw new CodeBotError('invalid', 'The message is empty');
    this.emitThread(bot.threadId, botId, 'user.message', { text: message });
    this.runtime(botId).enqueue({ kind: 'user', text: message });
  }

  /** Starts a fresh conversation with a bot. Its sub-agents keep working and report into the new one. */
  newConversation(botId: string): ThreadView {
    const bot = this.bot(botId);
    const threadId = this.createThread(botId);
    this.emitThread(threadId, botId, 'thread.reset', {});
    this.switchConversation(bot, threadId);
    return this.getThread(botId);
  }

  listConversations(botId: string, options: { archived?: boolean } = {}): ConversationSummary[] {
    const bot = this.bot(botId);
    return this.store.listThreads(botId, { archived: options.archived ?? false }).map((thread) => ({
      threadId: thread.id,
      botId,
      title: thread.firstMessage ? clip(thread.firstMessage.trim().split(/\r?\n/, 1)[0], 80) : 'New conversation',
      createdAt: thread.createdAt,
      lastActivity: thread.lastActivity,
      messages: thread.messages,
      current: thread.id === bot.threadId,
      archivedAt: thread.archivedAt,
    }));
  }

  getConversation(botId: string, threadId: string, after = 0): ThreadView {
    const bot = this.bot(botId);
    this.ownThread(botId, threadId);
    const current = threadId === bot.threadId;
    return {
      botId,
      threadId,
      current,
      busy: current ? (this.runtimes.get(botId)?.isBusy() ?? false) : false,
      events: this.threadEvents(threadId, botId, after),
    };
  }

  /** Makes an earlier conversation the current one: the bot continues it with its memory of it. */
  reopenConversation(botId: string, threadId: string): ThreadView {
    const bot = this.bot(botId);
    const thread = this.ownThread(botId, threadId);
    if (thread.id !== bot.threadId) {
      if (thread.archivedAt) this.store.setThreadArchived(thread.id, null);
      this.switchConversation(bot, thread.id);
    }
    return this.getThread(botId);
  }

  setConversationArchived(botId: string, threadId: string, archived: boolean): void {
    const bot = this.bot(botId);
    this.ownThread(botId, threadId);
    if (archived && threadId === bot.threadId) {
      throw new CodeBotError('invalid', 'This is the current conversation. Start a new one before archiving it.');
    }
    this.store.setThreadArchived(threadId, archived ? new Date().toISOString() : null);
    this.emitBot(botId, 'conversations', {});
  }

  /** Stops the bot's current turn and drops messages it has not started on. */
  stopBot(botId: string): void {
    this.bot(botId);
    this.runtimes.get(botId)?.stop();
  }

  // ---- sub-agents --------------------------------------------------------------

  listTasks(filter: { botId?: string; limit?: number; archived?: boolean } = {}): Task[] {
    return this.tasks.listTasks({
      botId: filter.botId,
      archived: filter.archived ?? false,
      limit: Math.min(filter.limit ?? 100, 500),
    });
  }

  getTask(taskId: string, after = 0): TaskView {
    return {
      task: this.tasks.getTask(taskId),
      pendingRequests: this.tasks.pendingRequests({ taskId }),
      events: this.tasks.events(taskId, after),
    };
  }

  /** The user writes to a sub-agent directly. */
  sendToTask(taskId: string, text: string): void {
    this.tasks.sendMessage(taskId, text, 'user');
  }

  async cancelTask(taskId: string): Promise<void> {
    await this.tasks.cancel(taskId);
  }

  /**
   * Hides a stopped sub-agent from the lists, or shows it again. Archiving
   * removes its worktree folder (its branch stays unless merged); with
   * uncommitted changes there it refuses unless told to discard them.
   */
  async setTaskArchived(taskId: string, archived: boolean, options: { discardChanges?: boolean } = {}): Promise<void> {
    const task = this.tasks.getTask(taskId);
    if (archived) {
      if (this.tasks.isActive(taskId)) {
        throw new CodeBotError('conflict', `Sub-agent ${taskId} is working; stop it before archiving it`);
      }
      if (task.worktree && !task.worktree.removed) {
        const status = await worktreeStatus(task.worktree);
        if (status === 'dirty' && !options.discardChanges) {
          throw new CodeBotError(
            'conflict',
            `Sub-agent ${taskId} has uncommitted changes in its worktree (${task.worktree.path}). Have it commit them, or archive it and discard them.`,
          );
        }
        await removeWorktree(task.worktree, status === 'dirty');
        this.tasks.setWorktree(taskId, { ...task.worktree, removed: true });
      }
    }
    this.tasks.setArchived(taskId, archived);
  }

  listRequests(): PendingRequest[] {
    return this.tasks.pendingRequests();
  }

  /** The user answers a sub-agent's question or approval request. */
  respond(taskId: string, requestId: string, response: UserResponse): void {
    this.tasks.respond(taskId, requestId, response, 'user');
  }

  // ---- routines ----------------------------------------------------------------

  /** Every routine of a bot that still exists, the next to run first. */
  listRoutines(): Routine[] {
    return this.store.listRoutines();
  }

  createRoutine(input: RoutineInput): Routine {
    const clean = this.validateRoutine(input);
    const now = new Date();
    const routine: Routine = {
      id: newId('rt'),
      ...clean,
      nextRunAt: null,
      lastRunAt: null,
      lastError: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    routine.nextRunAt = this.plannedRun(routine, now);
    this.store.insertRoutine(routine);
    this.routinesChanged();
    return routine;
  }

  updateRoutine(routineId: string, patch: RoutinePatch): Routine {
    const current = this.routine(routineId);
    const clean = this.validateRoutine({
      botId: patch.botId ?? current.botId,
      title: patch.title ?? current.title,
      prompt: patch.prompt ?? current.prompt,
      schedule: patch.schedule ?? current.schedule,
      enabled: patch.enabled ?? current.enabled,
    });
    const now = new Date();
    const next: Routine = { ...current, ...clean, updatedAt: now.toISOString() };
    if (patch.schedule !== undefined || patch.enabled !== undefined) next.nextRunAt = this.plannedRun(next, now);
    this.store.saveRoutine(next);
    this.routinesChanged();
    return next;
  }

  deleteRoutine(routineId: string): void {
    this.routine(routineId);
    this.store.deleteRoutine(routineId);
    this.routinesChanged();
  }

  /** Runs a routine now ("Run now"); its schedule stays as it is. */
  runRoutine(routineId: string): void {
    const routine = this.routine(routineId);
    this.startRoutine(routine, true);
    this.store.saveRoutine({ ...routine, lastRunAt: new Date().toISOString(), lastError: null });
    this.routinesChanged();
  }

  /**
   * Starts every enabled routine whose time has come, once each (also when
   * several runs were missed while code-bot was closed), and plans its next run.
   */
  runDueRoutines(now: Date = new Date()): void {
    let changed = false;
    for (const routine of this.store.listRoutines()) {
      if (!routine.enabled || !routine.nextRunAt || Date.parse(routine.nextRunAt) > now.getTime()) continue;
      let lastError: string | null = null;
      try {
        this.startRoutine(routine, false);
      } catch (error) {
        lastError = errorMessage(error);
      }
      const once = routine.schedule.kind === 'once';
      this.store.saveRoutine({
        ...routine,
        enabled: once ? false : routine.enabled,
        nextRunAt: once ? null : (nextRun(routine.schedule, now, new Date(routine.nextRunAt))?.toISOString() ?? null),
        lastRunAt: now.toISOString(),
        lastError,
        updatedAt: now.toISOString(),
      });
      changed = true;
    }
    if (changed) this.routinesChanged();
  }

  // ---- retention ---------------------------------------------------------------

  /**
   * Archives sub-agents and earlier conversations idle for longer than the
   * archive setting, and deletes archived ones older than the delete setting.
   * Sub-agents with uncommitted changes in their worktree are left alone.
   */
  async runRetention(now: Date = new Date()): Promise<RetentionResult> {
    const settings = this.getSettings();
    const result: RetentionResult = { archivedSubagents: 0, archivedConversations: 0, deletedSubagents: 0, deletedConversations: 0 };
    if (settings.archiveAfterDays > 0) {
      const before = new Date(now.getTime() - settings.archiveAfterDays * DAY_MS).toISOString();
      for (const task of this.store.idleTasks(before, FINISHED_STATES)) {
        if (this.tasks.isActive(task.id) || this.tasks.hasHeld(task.id)) continue;
        try {
          await this.setTaskArchived(task.id, true);
          result.archivedSubagents += 1;
        } catch {
          // Uncommitted work in its worktree, or git failed: leave it for the user.
        }
      }
      const touched = new Set<string>();
      for (const thread of this.store.idleThreads(before)) {
        this.store.setThreadArchived(thread.id, now.toISOString());
        touched.add(thread.botId);
        result.archivedConversations += 1;
      }
      for (const botId of touched) this.emitBot(botId, 'conversations', {});
    }
    if (settings.deleteArchivedAfterDays > 0) {
      const before = new Date(now.getTime() - settings.deleteArchivedAfterDays * DAY_MS).toISOString();
      for (const task of this.store.archivedTasksBefore(before)) {
        if (this.tasks.isActive(task.id)) continue;
        // Never lose a worktree that is still on disk.
        if (task.worktree && !task.worktree.removed && existsSync(task.worktree.path)) continue;
        this.tasks.delete(task.id);
        result.deletedSubagents += 1;
      }
      const touched = new Set<string>();
      for (const thread of this.store.archivedThreadsBefore(before)) {
        this.store.deleteThread(thread.id);
        touched.add(thread.botId);
        result.deletedConversations += 1;
      }
      for (const botId of touched) this.emitBot(botId, 'conversations', {});
    }
    return result;
  }

  // ---- lifecycle ---------------------------------------------------------------

  /** Every event: conversations, sub-agents, bot status and app news. */
  subscribe(listener: (event: CoreEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }

  activeSubagents(): number {
    return this.tasks.countActive();
  }

  /** Stops every bot turn and sub-agent and waits for them to wind down. Sub-agent sessions and open requests stay resumable. */
  async shutdown(): Promise<void> {
    this.closing = true;
    for (const timer of this.questionTimers.values()) clearTimeout(timer);
    this.questionTimers.clear();
    for (const timer of this.timers) clearTimeout(timer);
    clearTimeout(this.usageSoonTimer);
    const bots = [...this.runtimes.values()].map((runtime) => runtime.close());
    await this.tasks.shutdown();
    await Promise.all(bots);
  }

  // ---- routing -----------------------------------------------------------------

  private runtime(botId: string): BotRuntime {
    let runtime = this.runtimes.get(botId);
    if (!runtime) {
      this.bot(botId);
      runtime = new BotRuntime(botId, this.host, this.brain);
      this.runtimes.set(botId, runtime);
    }
    return runtime;
  }

  private onTaskEvent(event: CoreEvent): void {
    if (event.scope !== 'task') return;
    switch (event.type) {
      case 'request': {
        const request = event.data as PendingRequest;
        if (request.kind === 'permission') {
          // Approvals are the user's to give: straight to them.
          this.surface(request);
          return;
        }
        // Questions go to the team lead first; whatever it leaves open goes to the user.
        const task = this.tasks.getTask(request.taskId);
        if (!this.store.getBot(task.botId)) {
          this.surface(request);
          return;
        }
        this.runtime(task.botId).enqueue({
          kind: 'task',
          taskId: task.id,
          event: 'question',
          requestId: request.id,
          requester: task.requestedBy,
        });
        const timer = setTimeout(() => {
          this.questionTimers.delete(request.id);
          this.surfaceById(request.id);
        }, this.questionTimeoutMs);
        timer.unref?.();
        this.questionTimers.set(request.id, timer);
        return;
      }
      case 'request.resolved': {
        const data = event.data as {
          id: string;
          decision: ClosedData['decision'];
          by: ClosedData['by'];
          surfacedIn: string | null;
          answers?: Record<string, string>;
          message?: string;
        };
        const timer = this.questionTimers.get(data.id);
        if (timer) {
          clearTimeout(timer);
          this.questionTimers.delete(data.id);
        }
        if (data.surfacedIn) {
          const thread = this.store.getThread(data.surfacedIn);
          if (thread) {
            const closed: ClosedData = { requestId: data.id, decision: data.decision, by: data.by };
            if (data.answers) closed.answers = data.answers;
            if (data.message) closed.message = data.message;
            this.emitThread(thread.id, thread.botId, 'request.closed', closed);
            this.statusChanged(thread.botId);
          }
        }
        return;
      }
      case 'state': {
        const { state } = event.data as { state: TaskState };
        if ((state === 'done' || state === 'failed') && this.store.getBot(event.botId)) {
          const task = this.tasks.getTask(event.id);
          this.runtime(task.botId).enqueue({ kind: 'task', taskId: task.id, event: state, requester: task.requestedBy });
        }
        if (FINISHED_STATES.includes(state)) this.usageSoon();
        this.statusChanged(event.botId);
        this.statusChanged(MAIN_BOT_ID);
        return;
      }
      case 'result':
        // Its cost changed.
        this.statusChanged(event.botId);
        this.statusChanged(MAIN_BOT_ID);
        return;
    }
  }

  private prepare(botId: string, items: Inbound[]): PreparedTurn | undefined {
    const bot = this.bot(botId);
    const first = items[0];
    if (!first) return undefined;
    // Project bots see their recent sub-agents after each message, so follow-ups go to the one that has the work.
    const recent = (text: string) =>
      bot.kind === 'project'
        ? prompts.withRecent(text, prompts.recentSubagents(this.tasks.listTasks({ botId: bot.id, archived: false, limit: 20 })))
        : text;
    switch (first.kind) {
      case 'user':
        return { prompt: recent(first.text), replyTo: 'user', questionRequestIds: [] };
      case 'main':
        return { prompt: recent(prompts.fromMain(first.text)), replyTo: 'main', questionRequestIds: [] };
      case 'routine':
        return { prompt: recent(prompts.fromRoutine(first.title, first.text)), replyTo: 'user', questionRequestIds: [] };
      case 'report': {
        const reports = items.flatMap((item) =>
          item.kind === 'report' ? [{ name: this.store.getBot(item.fromBotId)?.name ?? item.fromBotId, text: item.text }] : [],
        );
        return { prompt: prompts.reportsForMain(reports), replyTo: 'user', questionRequestIds: [] };
      }
      case 'task': {
        const parts: string[] = [];
        const questionIds: string[] = [];
        for (const item of items) {
          if (item.kind !== 'task') continue;
          const task = this.store.getTask(item.taskId);
          if (!task) continue;
          let note: string;
          if (item.event === 'question') {
            const request = item.requestId ? this.tasks.findRequest(item.requestId) : undefined;
            // Already answered, or already with the user: nothing for the lead to do.
            if (!request || request.surfacedIn) continue;
            parts.push(prompts.describeQuestion(task, request));
            questionIds.push(request.id);
            note = `${prompts.taskLabel(task)} asks a question.`;
          } else {
            // Continued since: the update is out of date.
            if (task.state !== item.event) continue;
            parts.push(item.event === 'done' ? prompts.describeFinished(task) : prompts.describeFailed(task));
            note = `${prompts.taskLabel(task)} ${item.event === 'done' ? 'finished' : 'failed'}.`;
          }
          const inbound: InboundData = { from: 'subagent', taskId: task.id, text: note };
          this.emitThread(bot.threadId, botId, 'inbound', inbound);
        }
        if (parts.length === 0) return undefined;
        return {
          prompt: `${prompts.UPDATE_HEADER}\n\n${parts.join('\n\n')}`,
          replyTo: first.requester,
          questionRequestIds: questionIds,
        };
      }
    }
  }

  private brainOptions(botId: string): BrainOptions {
    const bot = this.bot(botId);
    if (bot.kind === 'main') {
      return {
        systemPrompt: prompts.mainBotPrompt(bot, this.store.listBots().filter((candidate) => candidate.kind === 'project')),
        tools: mainBotTools(this.toolHost),
        model: bot.model ?? undefined,
        effort: bot.effort ?? undefined,
        cwd: this.workDir,
        additionalDirectories: [],
        access: 'none',
      };
    }
    const runtime = this.runtime(botId);
    const [primary, ...others] = bot.folders;
    if (!primary) throw new CodeBotError('invalid', `${bot.name} has no project folder`);
    // The lead can read its sub-agents' worktrees to review their work.
    const worktrees = this.liveWorktrees(bot).slice(0, READABLE_WORKTREES).map((worktree) => worktree.path);
    return {
      systemPrompt: prompts.projectBotPrompt(bot),
      tools: projectBotTools(this.toolHost, bot, () => runtime.replyTo),
      model: bot.model ?? undefined,
      effort: bot.effort ?? undefined,
      cwd: primary,
      additionalDirectories: [...others, ...worktrees],
      access: 'read',
    };
  }

  private finished(botId: string, turn: PreparedTurn, outcome: TurnOutcome): { forwardedTo?: 'main' } {
    const bot = this.store.getBot(botId);
    if (!bot || bot.kind !== 'project') return {};
    if (turn.questionRequestIds.length > 0) {
      // Whatever the lead left unanswered is a decision for the user.
      for (const requestId of turn.questionRequestIds) this.surfaceById(requestId);
      return {};
    }
    if (turn.replyTo !== 'main' || outcome.stopped) return {};
    const text = outcome.ok
      ? outcome.text.trim() || '(The project bot finished its turn without a reply.)'
      : `(The project bot could not reply: ${outcome.error ?? 'unknown error'})`;
    this.deliverReport(bot, text);
    return { forwardedTo: 'main' };
  }

  /** Puts a sub-agent's question or approval request to the user, in the conversation of whoever asked for the work. */
  private surface(request: PendingRequest, force = false): void {
    if (request.surfacedIn && !force) return;
    const task = this.store.getTask(request.taskId);
    if (!task) return;
    const owner = this.store.getBot(task.botId);
    const target = task.requestedBy === 'main' || !owner ? this.bot(MAIN_BOT_ID) : owner;
    this.tasks.markSurfaced(request.id, target.threadId);
    const data: SurfacedData = {
      request: { ...request, surfacedIn: target.threadId },
      taskTitle: task.title,
      botName: owner?.name ?? task.botId,
    };
    this.emitThread(target.threadId, target.id, 'request.surfaced', data);
    this.statusChanged(target.id);
  }

  private surfaceById(requestId: string): void {
    const request = this.tasks.findRequest(requestId);
    if (request && !request.surfacedIn) this.surface(request);
  }

  private deliverReport(from: Bot, text: string): void {
    const main = this.bot(MAIN_BOT_ID);
    const inbound: InboundData = { from: 'project', botId: from.id, name: from.name, text };
    this.emitThread(main.threadId, MAIN_BOT_ID, 'inbound', inbound);
    this.runtime(MAIN_BOT_ID).enqueue({ kind: 'report', fromBotId: from.id, text });
  }

  private messageProjectBot(bot: Bot, text: string): void {
    const inbound: InboundData = { from: 'main', text };
    this.emitThread(bot.threadId, bot.id, 'inbound', inbound);
    this.runtime(bot.id).enqueue({ kind: 'main', text });
  }

  private findProjectBot(nameOrId: string): Bot {
    const wanted = nameOrId.trim().replace(/ bot$/i, '').toLowerCase();
    const bots = this.store.listBots().filter((bot) => bot.kind === 'project');
    const bot = bots.find((candidate) => candidate.id === nameOrId || candidate.name.toLowerCase() === wanted);
    if (!bot) {
      const names = bots.map((candidate) => candidate.name).join(', ') || '(none)';
      throw new CodeBotError('not_found', `No project bot named "${nameOrId}". Project bots: ${names}`);
    }
    return bot;
  }

  private async startSubagent(bot: Bot, args: SubagentArgs, requestedBy: Requester): Promise<Task> {
    const current = this.bot(bot.id);
    const folder = args.folder ? this.matchFolder(current, args.folder) : current.folders[0];
    if (!folder) throw new CodeBotError('invalid', `${current.name} has no project folder`);
    const defaults = current.subagents;
    const permissionMode = args.permissionMode ?? defaults.permissionMode;
    if (permissionRank(permissionMode) > permissionRank(defaults.permissionMode)) {
      throw new CodeBotError(
        'invalid',
        `This project allows sub-agents at most "${defaults.permissionMode}" permissions; "${permissionMode}" is looser`,
      );
    }
    const role = args.role ?? 'developer';
    if (args.forTaskId && role === 'developer') {
      throw new CodeBotError(
        'invalid',
        `for_subagent is for QA and reviewers. To continue developer ${args.forTaskId}, use send_to_subagent instead of starting a new sub-agent.`,
      );
    }
    const isolation: Isolation = args.worktree === undefined ? defaults.isolation : args.worktree ? 'worktree' : 'shared';
    const id = newId('t');
    const title = args.title?.trim() || titleFrom(args.brief);

    let cwd = folder;
    let worktree: TaskWorktree | null = null;
    if (isolation === 'worktree') {
      const created = await createWorktree({ folder, root: this.worktreeDir, taskId: id, title, files: defaults.worktreeFiles });
      cwd = created.cwd;
      worktree = created.worktree;
    }
    let task: Task;
    try {
      task = this.tasks.createTask({
        id,
        botId: current.id,
        prompt: args.brief,
        title,
        requestedBy,
        role,
        forTaskId: args.forTaskId ?? null,
        cwd,
        additionalDirectories: current.folders.filter((candidate) => candidate !== folder),
        engine: args.engine ?? defaults.engine,
        model: args.model ?? defaults.model,
        effort: args.effort ?? defaults.effort,
        permissionMode,
        instructions: prompts.subagentInstructions(current, folder, worktree ? { cwd, worktree } : undefined, role),
        maxTurns: defaults.maxTurns,
        maxBudgetUsd: defaults.maxBudgetUsd,
        worktree,
      });
    } catch (error) {
      if (worktree) await removeWorktree(worktree, true).catch(() => undefined);
      throw error;
    }
    this.emitThread(current.threadId, current.id, 'subagent.started', {
      taskId: task.id,
      title: task.title,
      branch: worktree?.branch,
    });
    return task;
  }

  /** A project bot changes one of its sub-agents' permission mode, within what the project allows. */
  private setSubagentPermission(bot: Bot, taskId: string, mode: PermissionMode): Task {
    const current = this.bot(bot.id);
    if (!PERMISSION_MODES.includes(mode)) throw new CodeBotError('invalid', `Unknown permission mode "${mode}"`);
    if (permissionRank(mode) > permissionRank(current.subagents.permissionMode)) {
      throw new CodeBotError(
        'invalid',
        `This project allows sub-agents at most "${current.subagents.permissionMode}" permissions; "${mode}" is looser`,
      );
    }
    return this.tasks.setPermissionMode(taskId, mode);
  }

  /**
   * Right before a sub-agent's turn: bring back its worktree if it was removed, and apply the
   * project's current limits and MCP servers.
   */
  private prepareTurn(task: Task): TurnSetup {
    let current = task;
    if (task.worktree && (task.worktree.removed || !existsSync(task.worktree.path))) {
      current = this.tasks.setWorktree(task.id, restoreWorktree(task.worktree));
    }
    const bot = this.store.getBot(task.botId);
    const maxTurns = bot ? bot.subagents.maxTurns : task.maxTurns;
    const maxBudgetUsd = bot ? bot.subagents.maxBudgetUsd : task.maxBudgetUsd;
    if (maxTurns !== current.maxTurns || maxBudgetUsd !== current.maxBudgetUsd) {
      current = this.store.updateTask(task.id, { maxTurns, maxBudgetUsd }, false);
    }
    return { task: current, maxTurns, maxBudgetUsd, mcpServers: bot ? bot.subagents.mcpServers : [] };
  }

  /** Worktrees of this project's sub-agents that are on disk, newest first. */
  private liveWorktrees(bot: Bot): TaskWorktree[] {
    return this.tasks
      .listTasks({ botId: bot.id, archived: false, limit: 50 })
      .flatMap((task) => (task.worktree && !task.worktree.removed && existsSync(task.worktree.path) ? [task.worktree] : []));
  }

  private matchFolder(bot: Bot, folder: string): string {
    let canonical = resolve(folder);
    try {
      canonical = realpathSync.native(canonical);
    } catch {
      // Not on disk: compare as given.
    }
    const key = folderKey(canonical);
    const match = bot.folders.find((candidate) => folderKey(candidate) === key);
    if (!match) throw new CodeBotError('invalid', `"${folder}" is not one of this project's folders: ${bot.folders.join(', ')}`);
    return match;
  }

  /** A project folder, or one of the project's sub-agent worktrees (for the read-only git tool). */
  private matchGitFolder(bot: Bot, folder: string): string {
    try {
      return this.matchFolder(bot, folder);
    } catch (error) {
      let canonical = resolve(folder);
      try {
        canonical = realpathSync.native(canonical);
      } catch {
        // Compare as given.
      }
      const key = folderKey(canonical);
      const match = this.liveWorktrees(bot).find((worktree) => folderKey(worktree.path) === key);
      if (match) return match.path;
      throw error;
    }
  }

  private ownThread(botId: string, threadId: string) {
    const thread = this.store.getThread(threadId);
    if (!thread || thread.botId !== botId) throw new CodeBotError('not_found', `No conversation "${threadId}" with this bot`);
    return thread;
  }

  private switchConversation(bot: Bot, threadId: string): void {
    this.runtimes.get(bot.id)?.stop();
    const oldThreadId = bot.threadId;
    this.store.saveBot({ ...bot, threadId, updatedAt: new Date().toISOString() });
    // Open questions and approvals follow the user into the conversation they are now in.
    for (const request of this.tasks.pendingRequests()) {
      if (request.surfacedIn === oldThreadId) this.surface(request, true);
    }
    this.emitBot(bot.id, 'conversations', { threadId });
    this.statusChanged(bot.id);
  }

  // ---- bots: storage and checks ------------------------------------------------

  private ensureMainBot(): void {
    if (this.store.getBot(MAIN_BOT_ID)) return;
    const now = new Date().toISOString();
    this.store.insertBot({
      id: MAIN_BOT_ID,
      kind: 'main',
      name: 'Main bot',
      description: 'Routes your requests to the project bots and reports back.',
      folders: [],
      instructions: '',
      model: null,
      effort: null,
      subagents: defaultSubagents(this.defaultEngine),
      threadId: this.createThread(MAIN_BOT_ID),
      createdAt: now,
      updatedAt: now,
    });
  }

  private createThread(botId: string): string {
    const id = newId('c');
    this.store.insertThread({ id, botId, engineSessionId: null, createdAt: new Date().toISOString() });
    return id;
  }

  private validate(input: BotInput, existingId?: string): BotInput {
    const name = String(input.name ?? '').trim();
    if (!name) throw new CodeBotError('invalid', 'Give the bot a name');
    if (name.length > 40) throw new CodeBotError('invalid', 'Keep the name to 40 characters or fewer');
    if (!NAME_PATTERN.test(name)) {
      throw new CodeBotError('invalid', 'Use letters, digits, spaces, ".", "-" and "_" in the name, starting with a letter or digit');
    }
    if (RESERVED_NAMES.has(name.toLowerCase())) throw new CodeBotError('invalid', `"${name}" is reserved for the main bot`);
    const clash = this.store
      .listBots()
      .find((bot) => bot.id !== existingId && bot.name.toLowerCase() === name.toLowerCase());
    if (clash) throw new CodeBotError('conflict', `There is already a bot named "${clash.name}"`);

    const folders: string[] = [];
    for (const raw of input.folders ?? []) {
      const folder = String(raw ?? '').trim();
      if (!folder) continue;
      if (!isAbsolute(folder)) throw new CodeBotError('invalid', `Use a full path for "${folder}"`);
      if (!isDirectory(resolve(folder))) throw new CodeBotError('invalid', `Folder not found: ${resolve(folder)}`);
      // The canonical path: Windows short names (ABCDEF~1) and symlinks would make
      // agents treat files in the project as outside it.
      const normal = realpathSync.native(resolve(folder));
      if (!folders.some((known) => folderKey(known) === folderKey(normal))) folders.push(normal);
    }
    if (folders.length === 0) throw new CodeBotError('invalid', 'Add at least one project folder');
    if (folders.length > MAX_FOLDERS) throw new CodeBotError('invalid', `A bot can have at most ${MAX_FOLDERS} folders`);

    const description = String(input.description ?? '').trim();
    if (description.length > 2000) throw new CodeBotError('invalid', 'Keep the description under 2000 characters');
    const instructions = String(input.instructions ?? '').trim();
    if (instructions.length > 20_000) throw new CodeBotError('invalid', 'Keep the instructions under 20000 characters');

    const subagents: Partial<SubagentDefaults> = input.subagents ?? {};
    const engine = String(subagents.engine || this.defaultEngine);
    if (!this.tasks.engineIds().includes(engine)) {
      throw new CodeBotError('invalid', `Unknown engine "${engine}". Available: ${this.tasks.engineIds().join(', ')}`);
    }
    const permissionMode = subagents.permissionMode ?? 'acceptEdits';
    if (!PERMISSION_MODES.includes(permissionMode)) {
      throw new CodeBotError('invalid', `Unknown permission mode "${permissionMode}"`);
    }
    const isolation = subagents.isolation ?? 'shared';
    if (!ISOLATIONS.includes(isolation)) throw new CodeBotError('invalid', `Unknown isolation "${isolation}"`);
    const maxTurns =
      subagents.maxTurns === null || subagents.maxTurns === undefined
        ? null
        : wholeNumber(subagents.maxTurns, 1, 10_000, 'The turn limit');
    let maxBudgetUsd: number | null = null;
    if (subagents.maxBudgetUsd !== null && subagents.maxBudgetUsd !== undefined) {
      const budget = Number(subagents.maxBudgetUsd);
      if (!Number.isFinite(budget) || budget <= 0 || budget > 100_000) {
        throw new CodeBotError('invalid', 'The budget must be more than $0 and at most $100000');
      }
      maxBudgetUsd = Math.round(budget * 100) / 100;
    }

    return {
      name,
      description,
      folders,
      instructions,
      model: this.cleanModel(input.model),
      effort: this.cleanEffort(input.effort),
      subagents: {
        engine,
        model: this.cleanModel(subagents.model),
        effort: this.cleanEffort(subagents.effort),
        permissionMode,
        isolation,
        worktreeFiles:
          subagents.worktreeFiles === undefined ? [...DEFAULT_WORKTREE_FILES] : cleanWorktreeFiles(subagents.worktreeFiles),
        maxTurns,
        maxBudgetUsd,
        mcpServers: cleanMcpServers(subagents.mcpServers),
      },
    };
  }

  private cleanModel(model: unknown): string | null {
    const value = typeof model === 'string' ? model.trim() : '';
    if (!value) return null;
    if (value.length > 100 || /\s/.test(value)) throw new CodeBotError('invalid', `"${value}" is not a model name`);
    return value;
  }

  private cleanEffort(effort: unknown): Effort | null {
    if (effort === null || effort === undefined || effort === '') return null;
    if (!EFFORTS.includes(effort as Effort)) {
      throw new CodeBotError('invalid', `Effort must be one of: ${EFFORTS.join(', ')}`);
    }
    return effort as Effort;
  }

  // ---- views and events --------------------------------------------------------

  private view(bot: Bot): BotView {
    return { ...bot, status: this.status(bot) };
  }

  private status(bot: Bot): BotStatus {
    return {
      busy: this.runtimes.get(bot.id)?.isBusy() ?? false,
      activeSubagents: this.tasks.countActive(bot.kind === 'main' ? undefined : bot.id),
      needsYou: this.tasks.pendingRequests().filter((request) => request.surfacedIn === bot.threadId).length,
      usage: this.usageOf(bot),
    };
  }

  private usageOf(bot: Bot): BotUsage {
    const main = bot.kind === 'main';
    const subagents = this.store.taskUsage(main ? undefined : bot.id);
    return {
      botUsd: this.store.botCost(bot.id),
      projectBotsUsd: main ? this.store.botCost() : 0,
      subagentsUsd: subagents.usd,
      subagentTokens: subagents.tokens,
    };
  }

  private saveCost(threadId: string, costUsd: number): void {
    this.store.setThreadCost(threadId, costUsd);
    const thread = this.store.getThread(threadId);
    if (!thread) return;
    this.statusChanged(thread.botId);
    if (thread.botId !== MAIN_BOT_ID) this.statusChanged(MAIN_BOT_ID);
  }

  // ---- routines: checks and runs ------------------------------------------------

  private routine(routineId: string): Routine {
    const routine = this.store.getRoutine(routineId);
    if (!routine || !this.store.getBot(routine.botId)) throw new CodeBotError('not_found', `No routine with id "${routineId}"`);
    return routine;
  }

  private validateRoutine(input: RoutineInput): RoutineInput {
    const bot = this.bot(String(input.botId ?? ''));
    const title = String(input.title ?? '').trim();
    if (!title) throw new CodeBotError('invalid', 'Give the routine a name');
    if (title.length > 80) throw new CodeBotError('invalid', 'Keep the name to 80 characters or fewer');
    const prompt = String(input.prompt ?? '').trim();
    if (!prompt) throw new CodeBotError('invalid', `Write what ${bot.name} should do each time`);
    if (prompt.length > MAX_ROUTINE_PROMPT) throw new CodeBotError('invalid', `Keep the message under ${MAX_ROUTINE_PROMPT} characters`);
    const schedule = cleanSchedule(input.schedule);
    const enabled = input.enabled !== false;
    if (enabled && schedule.kind === 'once' && Date.parse(schedule.at) <= Date.now()) {
      throw new CodeBotError('invalid', 'That time has passed: pick a time in the future');
    }
    return { botId: bot.id, title, prompt, schedule, enabled };
  }

  /** The next time a routine runs from now, or null when it will not. */
  private plannedRun(routine: Routine, now: Date): string | null {
    if (!routine.enabled) return null;
    return nextRun(routine.schedule, now)?.toISOString() ?? null;
  }

  /** Puts a routine's message to its bot, as if the user typed it. */
  private startRoutine(routine: Routine, manual: boolean): void {
    const bot = this.bot(routine.botId);
    const data: RoutineRunData = { routineId: routine.id, title: routine.title, text: routine.prompt, manual };
    this.emitThread(bot.threadId, bot.id, 'routine.run', data);
    this.runtime(bot.id).enqueue({ kind: 'routine', routineId: routine.id, title: routine.title, text: routine.prompt });
  }

  private routinesChanged(): void {
    this.emitApp('routines', this.listRoutines());
  }

  private statusChanged(botId: string): void {
    const bot = this.store.getBot(botId);
    if (bot) this.emitBot(botId, 'status', this.status(bot));
  }

  private threadEvents(threadId: string, botId: string, after: number): CoreEvent[] {
    return this.store.listEvents(threadId, after).map((event) => ({ scope: 'thread' as const, id: threadId, botId, ...event }));
  }

  private emitThread(threadId: string, botId: string, type: string, data: unknown, liveOnly = false): void {
    const stored = liveOnly
      ? { seq: 0, ts: new Date().toISOString(), type, data }
      : this.store.appendEvent(threadId, type, data);
    const event: CoreEvent = { scope: 'thread', id: threadId, botId, ...stored };
    this.emitter.emit('event', event);
  }

  private emitBot(botId: string, type: string, data: unknown): void {
    const event: CoreEvent = { scope: 'bot', id: botId, botId, seq: 0, ts: new Date().toISOString(), type, data };
    this.emitter.emit('event', event);
  }

  private emitApp(type: string, data: unknown): void {
    const event: CoreEvent = { scope: 'app', id: 'app', botId: MAIN_BOT_ID, seq: 0, ts: new Date().toISOString(), type, data };
    this.emitter.emit('event', event);
  }
}
