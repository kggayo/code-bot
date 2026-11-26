import { useSyncExternalStore } from 'react';
import { MAIN_BOT_ID } from '../../../shared/types.ts';
import type {
  AppInfo,
  AppSettings,
  BotInput,
  BotPatch,
  BotStatus,
  BotView,
  CoreEvent,
  EngineInfo,
  EngineUsage,
  PendingRequest,
  Routine,
  RoutineInput,
  RoutinePatch,
  SurfacedData,
  Task,
  TaskState,
  TaskWorktree,
  ThreadView,
  UpdateInfo,
  UserResponse,
} from '../../../shared/types.ts';
import { api } from './api.ts';
import { clip } from './format.ts';

/** One bot's current conversation, as far as the window has seen it. */
export interface Conversation {
  threadId: string;
  events: CoreEvent[];
  lastSeq: number;
  /** Text the bot is writing right now. */
  live: string;
}

/** One sub-agent's history, loaded when it is opened. */
export interface TaskLog {
  task: Task;
  events: CoreEvent[];
  lastSeq: number;
  live: string;
}

export type Editor = { mode: 'create' } | { mode: 'edit'; botId: string };

const MAX_TASKS = 300;

/**
 * Everything the window shows, kept in sync with the main process through
 * its event stream. Components read it directly and re-render on change.
 */
class AppState {
  info: AppInfo | null = null;
  settings: AppSettings | null = null;
  /** Whether each coding agent is installed and signed in; empty until checked. */
  engines: EngineInfo[] = [];
  checkingEngines = false;
  appSettingsOpen = false;
  /** The coding agents' plan limits; empty until read. */
  usage: EngineUsage[] = [];
  checkingUsage = false;
  /** Every routine, soonest first. */
  routines: Routine[] = [];
  /** The routines dialog, opened on one bot's routines or on all of them. */
  routinesOpen: { botId: string | null } | null = null;
  /** Whether a newer code-bot is out. */
  update: UpdateInfo | null = null;
  /** An earlier conversation the user is reading (read-only until reopened). */
  viewing: { botId: string; view: ThreadView } | null = null;
  /** Bumped when a bot's list of conversations changes. */
  conversationsVersion = 0;
  ready = false;
  fatal: string | null = null;
  bots: BotView[] = [];
  tasks: Task[] = [];
  requests: PendingRequest[] = [];
  selectedBotId = MAIN_BOT_ID;
  openTaskId: string | null = null;
  editor: Editor | null = null;
  readonly unread = new Set<string>();
  readonly conversations = new Map<string, Conversation>();
  readonly taskLogs = new Map<string, TaskLog>();

  /** Events that arrive while a conversation or task log is loading, keyed by bot or task id. */
  private readonly buffers = new Map<string, CoreEvent[]>();
  private readonly replyTo = new Map<string, string>();
  private readonly lastText = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private version = 0;
  private flushing: ReturnType<typeof setTimeout> | undefined;

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getVersion = () => this.version;

  private started = false;

  async init(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      window.codeBot.onEvent((event) => this.apply(event));
      window.codeBot.onFocusBot((botId) => this.select(botId));
      const [info, settings, bots, tasks, requests, routines, update] = await Promise.all([
        api.appInfo(),
        api.getSettings(),
        api.listBots(),
        api.listTasks({ limit: MAX_TASKS }),
        api.listRequests(),
        api.listRoutines(),
        api.getUpdate(),
      ]);
      Object.assign(this, { info, settings, bots, tasks, requests, routines, update, ready: true });
      void this.checkEngines();
      void api
        .getUsage()
        .then((usage) => {
          this.usage = usage;
          this.changed();
        })
        .catch(() => undefined);
      // Coming back to the window re-reads what may have been missed meanwhile.
      window.addEventListener('focus', () => this.later('resync', this.resync, 50));
      await this.loadConversation(this.selectedBotId);
    } catch (error) {
      this.fatal = error instanceof Error ? error.message : String(error);
    }
    this.changed();
  }

  // ---- navigation ----------------------------------------------------------------

  select(botId: string): void {
    this.selectedBotId = botId;
    this.openTaskId = null;
    this.viewing = null;
    this.unread.delete(botId);
    this.changed(true);
    void this.loadConversation(botId);
  }

  openTask(taskId: string): void {
    this.openTaskId = taskId;
    this.changed(true);
    void this.loadTask(taskId);
  }

  closeTask(): void {
    this.openTaskId = null;
    this.changed(true);
  }

  openEditor(editor: Editor | null): void {
    this.editor = editor;
    this.changed(true);
  }

  openAppSettings(open: boolean): void {
    this.appSettingsOpen = open;
    this.changed(true);
  }

  openRoutines(open: { botId: string | null } | null): void {
    this.routinesOpen = open;
    this.changed(true);
  }

  /** Shows an earlier conversation, or the current one again. */
  async viewConversation(botId: string, threadId: string): Promise<void> {
    const view = await api.getConversation(botId, threadId);
    this.viewing = view.current ? null : { botId, view };
    this.changed(true);
  }

  closeViewing(): void {
    this.viewing = null;
    this.changed(true);
  }

  bot(botId: string): BotView | undefined {
    return this.bots.find((bot) => bot.id === botId);
  }

  // ---- actions -------------------------------------------------------------------

  async send(botId: string, text: string): Promise<void> {
    await api.sendToBot(botId, text);
  }

  async respond(taskId: string, requestId: string, response: UserResponse): Promise<void> {
    await api.respond(taskId, requestId, response);
  }

  async newConversation(botId: string): Promise<void> {
    const view = await api.newConversation(botId);
    this.conversations.set(botId, { threadId: view.threadId, events: view.events, lastSeq: lastSeq(view.events), live: '' });
    this.viewing = null;
    this.changed();
  }

  /** Makes an earlier conversation the current one again. */
  async reopenConversation(botId: string, threadId: string): Promise<void> {
    const view = await api.reopenConversation(botId, threadId);
    this.conversations.set(botId, { threadId: view.threadId, events: view.events, lastSeq: lastSeq(view.events), live: '' });
    this.viewing = null;
    this.changed(true);
  }

  async updateSettings(patch: Partial<AppSettings>): Promise<void> {
    this.settings = await api.updateSettings(patch);
    this.changed();
  }

  async checkEngines(): Promise<void> {
    this.checkingEngines = true;
    this.changed();
    try {
      this.engines = await api.checkEngines();
    } catch {
      // Keep the last result; the banner offers to check again.
    } finally {
      this.checkingEngines = false;
      this.changed();
    }
  }

  async checkUsage(): Promise<void> {
    this.checkingUsage = true;
    this.changed();
    try {
      this.usage = await api.checkUsage();
    } catch {
      // Keep the last reading.
    } finally {
      this.checkingUsage = false;
      this.changed();
    }
  }

  async createRoutine(input: RoutineInput): Promise<void> {
    await api.createRoutine(input);
    this.routines = await api.listRoutines();
    this.changed();
  }

  async updateRoutine(routineId: string, patch: RoutinePatch): Promise<void> {
    await api.updateRoutine(routineId, patch);
    this.routines = await api.listRoutines();
    this.changed();
  }

  async deleteRoutine(routineId: string): Promise<void> {
    await api.deleteRoutine(routineId);
    this.routines = await api.listRoutines();
    this.changed();
  }

  async setTaskArchived(taskId: string, archived: boolean, discardChanges = false): Promise<void> {
    await api.setTaskArchived(taskId, archived, { discardChanges });
    await this.refreshTasks();
    if (archived && this.openTaskId === taskId) this.closeTask();
  }

  async createBot(input: BotInput): Promise<BotView> {
    const bot = await api.createBot(input);
    await this.refreshBots();
    return bot;
  }

  async updateBot(botId: string, patch: BotPatch): Promise<void> {
    await api.updateBot(botId, patch);
    await this.refreshBots();
  }

  async archiveBot(botId: string): Promise<void> {
    await api.archiveBot(botId);
    if (this.selectedBotId === botId) this.select(MAIN_BOT_ID);
    await this.refreshBots();
  }

  // ---- loading -------------------------------------------------------------------

  private async loadConversation(botId: string): Promise<void> {
    if (this.conversations.has(botId) || this.buffers.has(botId)) return;
    this.buffers.set(botId, []);
    try {
      const view = await api.getThread(botId);
      const conversation: Conversation = { threadId: view.threadId, events: view.events, lastSeq: lastSeq(view.events), live: '' };
      this.conversations.set(botId, conversation);
      for (const event of this.buffers.get(botId) ?? []) this.applyThread(event);
    } finally {
      this.buffers.delete(botId);
      this.changed();
    }
  }

  private async loadTask(taskId: string): Promise<void> {
    if (this.taskLogs.has(taskId) || this.buffers.has(taskId)) return;
    this.buffers.set(taskId, []);
    try {
      const view = await api.getTask(taskId);
      this.taskLogs.set(taskId, { task: view.task, events: view.events, lastSeq: lastSeq(view.events), live: '' });
      for (const event of this.buffers.get(taskId) ?? []) this.applyTask(event);
    } finally {
      this.buffers.delete(taskId);
      this.changed();
    }
  }

  private refreshBots = () =>
    api.listBots().then((bots) => {
      this.bots = bots;
      this.changed();
    });

  private refreshTasks = () =>
    api.listTasks({ limit: MAX_TASKS }).then((tasks) => {
      this.tasks = tasks;
      for (const task of tasks) {
        const log = this.taskLogs.get(task.id);
        if (log) log.task = task;
      }
      this.changed();
    });

  /** Re-reads open requests and bot statuses, in case an event was missed. */
  private resync = () =>
    Promise.all([api.listRequests(), api.listBots(), api.listRoutines()]).then(([requests, bots, routines]) => {
      Object.assign(this, { requests, bots, routines });
      this.updateTitle();
      this.changed();
    });

  private later(key: string, run: () => Promise<unknown>, ms = 120): void {
    if (this.timers.has(key)) return;
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        run().catch(() => undefined);
      }, ms),
    );
  }

  // ---- live events ---------------------------------------------------------------

  private apply(event: CoreEvent): void {
    if (event.scope === 'app') {
      if (event.type === 'settings') this.settings = event.data as AppSettings;
      if (event.type === 'engines') this.engines = event.data as EngineInfo[];
      if (event.type === 'usage') this.usage = event.data as EngineUsage[];
      if (event.type === 'routines') this.routines = event.data as Routine[];
      if (event.type === 'update') this.update = event.data as UpdateInfo;
      this.changed();
      return;
    }
    if (event.scope === 'bot') {
      if (event.type === 'status') {
        const bot = this.bot(event.botId);
        if (bot) bot.status = event.data as BotStatus;
        this.updateTitle();
      } else if (event.type === 'conversations') {
        this.conversationsVersion += 1;
        // Another conversation became the current one: load it.
        const { threadId } = (event.data ?? {}) as { threadId?: string };
        const conversation = this.conversations.get(event.botId);
        if (threadId && conversation && conversation.threadId !== threadId) {
          this.conversations.delete(event.botId);
          if (this.selectedBotId === event.botId) void this.loadConversation(event.botId);
        }
      } else {
        this.later('bots', this.refreshBots);
      }
      this.changed();
      return;
    }
    if (event.scope === 'thread') {
      this.attend(event);
      const buffer = this.buffers.get(event.botId);
      if (buffer) buffer.push(event);
      else this.applyThread(event);
      return;
    }
    this.trackTask(event);
    const buffer = this.buffers.get(event.id);
    if (buffer) buffer.push(event);
    else this.applyTask(event);
  }

  private applyThread(event: CoreEvent): void {
    const conversation = this.conversations.get(event.botId);
    if (!conversation) return;
    if (event.type === 'thread.reset' && event.id !== conversation.threadId) {
      Object.assign(conversation, { threadId: event.id, events: [], lastSeq: 0, live: '' });
    }
    if (event.id !== conversation.threadId) return;
    if (event.seq > 0) {
      if (event.seq <= conversation.lastSeq) return;
      conversation.lastSeq = event.seq;
      conversation.events = [...conversation.events, event];
    }
    if (event.type === 'bot.delta') conversation.live += (event.data as { text: string }).text;
    if (event.type === 'bot.text' || event.type === 'turn.end') conversation.live = '';
    this.changed();
  }

  private applyTask(event: CoreEvent): void {
    const log = this.taskLogs.get(event.id);
    if (!log) return;
    if (event.seq > 0) {
      if (event.seq <= log.lastSeq) return;
      log.lastSeq = event.seq;
      log.events = [...log.events, event];
    }
    if (event.type === 'text.delta') log.live += (event.data as { text: string }).text;
    if (event.type === 'text' || event.type === 'result') log.live = '';
    if (event.type === 'state') log.task = { ...log.task, state: (event.data as { state: TaskState }).state };
    if (event.type === 'worktree') log.task = { ...log.task, worktree: (event.data as { worktree: TaskWorktree | null }).worktree };
    if (event.type === 'settings') log.task = { ...log.task, ...(event.data as Partial<Task>) };
    if (event.type === 'result') {
      const { costUsd, tokens } = event.data as { costUsd?: number; tokens?: number };
      log.task = { ...log.task, costUsd: costUsd ?? log.task.costUsd, tokens: tokens ?? log.task.tokens };
    }
    if (event.type === 'archived' || event.type === 'unarchived') {
      log.task = { ...log.task, archivedAt: (event.data as { archivedAt: string | null }).archivedAt };
    }
    this.changed();
  }

  /** Keeps the sub-agent list and the open requests current. */
  private trackTask(event: CoreEvent): void {
    switch (event.type) {
      case 'task.created': {
        const task = (event.data as { task: Task }).task;
        this.tasks = [task, ...this.tasks.filter((known) => known.id !== task.id)].slice(0, MAX_TASKS);
        break;
      }
      case 'state': {
        const state = (event.data as { state: TaskState }).state;
        this.tasks = this.tasks.map((task) => (task.id === event.id ? { ...task, state, updatedAt: event.ts } : task));
        this.later('tasks', this.refreshTasks, 400);
        break;
      }
      case 'request': {
        const request = event.data as PendingRequest;
        this.requests = [...this.requests.filter((known) => known.id !== request.id), request];
        break;
      }
      case 'request.resolved': {
        const { id } = event.data as { id: string };
        this.requests = this.requests.filter((request) => request.id !== id);
        break;
      }
      case 'archived':
      case 'unarchived':
      case 'worktree':
      case 'settings':
      case 'result':
        this.later('tasks', this.refreshTasks, 200);
        break;
      case 'deleted':
        this.tasks = this.tasks.filter((task) => task.id !== event.id);
        this.taskLogs.delete(event.id);
        if (this.openTaskId === event.id) this.openTaskId = null;
        break;
      default:
        return;
    }
    this.changed();
  }

  /** Unread marks and system notifications for things the user is not looking at. */
  private attend(event: CoreEvent): void {
    const looking = document.hasFocus() && this.selectedBotId === event.botId;
    const bot = this.bot(event.botId);
    const name = bot?.name ?? 'code-bot';
    switch (event.type) {
      case 'turn.start':
        this.replyTo.set(event.botId, (event.data as { replyTo: string }).replyTo);
        break;
      case 'bot.text':
        this.lastText.set(event.botId, (event.data as { text: string }).text);
        if (!looking) this.unread.add(event.botId);
        break;
      case 'turn.end': {
        const { ok } = event.data as { ok: boolean };
        // A project bot's reply to the main bot is reported by the main bot; notify once.
        if (ok && !looking && this.replyTo.get(event.botId) === 'user') {
          void api.notify({ title: name, body: clip(this.lastText.get(event.botId) ?? '', 240), botId: event.botId }).catch(() => undefined);
        }
        break;
      }
      case 'request.surfaced': {
        const { request, botName } = event.data as SurfacedData;
        if (!looking) {
          this.unread.add(event.botId);
          void api
            .notify({
              title: `${botName}: ${request.kind === 'question' ? 'a question for you' : 'approval needed'}`,
              body: request.summary ?? request.tool,
              botId: event.botId,
            })
            .catch(() => undefined);
        }
        break;
      }
      default:
        return;
    }
    this.changed();
  }

  private updateTitle(): void {
    const waiting = this.bots.reduce((sum, bot) => sum + bot.status.needsYou, 0);
    document.title = waiting > 0 ? `(${waiting}) code-bot` : 'code-bot';
  }

  /**
   * Re-renders. Live events are batched to about once a frame, however many
   * arrive; navigation renders at once so the screen never lags a click.
   */
  private changed(immediate = false): void {
    if (immediate) {
      if (this.flushing) clearTimeout(this.flushing);
      this.flush();
      return;
    }
    if (this.flushing) return;
    this.flushing = setTimeout(() => this.flush(), 16);
  }

  private flush(): void {
    this.flushing = undefined;
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
}

function lastSeq(events: CoreEvent[]): number {
  return events.reduce((max, event) => Math.max(max, event.seq), 0);
}

export const state = new AppState();

/** Re-renders the calling component whenever the app state changes. */
export function useAppState(): AppState {
  useSyncExternalStore(state.subscribe, state.getVersion);
  return state;
}
