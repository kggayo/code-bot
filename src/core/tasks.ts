import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ACTIVE_STATES, DEFAULT_SETTINGS } from '../shared/types.ts';
import type {
  CoreEvent,
  McpServer,
  PendingRequest,
  Requester,
  SubagentRole,
  Task,
  TaskState,
  TaskWorktree,
  UserResponse,
} from '../shared/types.ts';
import type { AskUser, Engine, EngineEvent, EngineRun } from './engines/types.ts';
import type { Store } from './store.ts';
import { CodeBotError, errorMessage, newId, titleFrom, truncate } from './util.ts';

export interface NewTask {
  /** Preset id, when the caller needed it before the task existed (worktree names). */
  id?: string;
  botId: string;
  prompt: string;
  title?: string;
  requestedBy: Requester;
  /** Default: developer. */
  role?: SubagentRole;
  /** For QA and reviewers: the developer sub-agent whose work this one checks. */
  forTaskId?: string | null;
  cwd: string;
  additionalDirectories: string[];
  engine: string;
  model: string | null;
  effort: string | null;
  permissionMode: string;
  instructions: string;
  maxTurns?: number | null;
  maxBudgetUsd?: number | null;
  worktree?: TaskWorktree | null;
}

/** Who wrote a message to a sub-agent. */
export type MessageSource = 'user' | 'lead';

/** What a turn runs with, decided right before it starts. */
export interface TurnSetup {
  task: Task;
  maxTurns: number | null;
  maxBudgetUsd: number | null;
  /** The project's MCP servers for this turn. */
  mcpServers: McpServer[];
}

export interface TaskManagerOptions {
  store: Store;
  engines: Engine[];
  /** How many sub-agents may work at the same time. Read whenever one starts. */
  maxActive?: () => number;
  /**
   * Runs right before every turn. It may bring back a removed worktree and
   * return the limits that apply now; it throws to refuse the turn.
   */
  prepareTurn?: (task: Task) => TurnSetup;
}

interface ActiveRun {
  run: EngineRun;
  pending: Map<string, { request: PendingRequest; resolve: (response: UserResponse) => void }>;
  /** Messages that arrived after the run stopped taking input; they start the next turn. */
  followUps: string[];
  stopReason?: 'cancelled' | 'interrupted';
  /** Settles once the run's events are consumed and its final state recorded. */
  finished?: Promise<void>;
  /** Exact tool calls the user approved while the sub-agent was stopped: each is allowed once without asking. */
  grants: string[];
}

/** A request that outlived its run: code-bot closed while it was open. */
interface HeldRequest {
  request: PendingRequest;
  inputKey: string | null;
  answer: UserResponse | null;
  by: 'user' | 'bot' | null;
}

/** How long shutdown waits for agents to wind down before giving up on them. */
const SHUTDOWN_WAIT_MS = 10_000;
/**
 * Strings in a request's input are kept up to this long (other events: 2000). People
 * approve what they see, so a plan or a file to write should be shown whole.
 */
const REQUEST_STRING_LIMIT = 30_000;

/** JSON with object keys sorted, so equal values give equal text. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Identifies one exact tool call: the tool and its full input. */
export function callKey(tool: string, input: unknown): string {
  return createHash('sha256').update(`${tool}\n${stableJson(input)}`).digest('hex');
}

const money = (value: number) => `$${value.toFixed(2)}`;

/** Tells a resumed sub-agent what happened to the requests it was waiting on when code-bot closed. */
function heldAnswersPrompt(held: HeldRequest[]): string {
  const lines = held.map(({ request, answer }) => {
    if (!answer) return '';
    if (request.kind === 'question') {
      return answer.decision === 'allow'
        ? `- Your question was answered: ${JSON.stringify(answer.answers ?? {})}`
        : `- Your question was not answered${answer.message ? ` (${answer.message})` : ''}. Decide yourself.`;
    }
    const what = `${request.tool}${request.summary ? ` (${request.summary})` : ''}`;
    return answer.decision === 'allow'
      ? `- Approval to use ${what}: allowed. If you still need it, make exactly the same call again; it will not be asked again.`
      : `- Approval to use ${what}: declined${answer.message ? ` (${answer.message})` : ''}. Carry on without it.`;
  });
  return [
    '[code-bot] code-bot was closed while you were waiting, so the step you were waiting on did not run. The answers:',
    ...lines.filter(Boolean),
    'Carry on with your task.',
  ].join('\n');
}

/**
 * Owns every sub-agent. A task is one sub-agent's work: a conversation with one
 * coding agent in a project's folders. A turn of that conversation is a run of
 * the engine; a task has at most one run at a time, and any number of tasks
 * can run at once (up to the maxActive setting).
 *
 * Open questions and approvals are kept in the database. When code-bot closes
 * while a sub-agent waits, the request stays open ("held"); answering it after
 * the restart resumes the sub-agent's session with the answer, and an approved
 * call is allowed once without asking again.
 */
export class TaskManager {
  private readonly store: Store;
  private readonly engines: Map<string, Engine>;
  private readonly maxActive: () => number;
  private readonly prepareTurn: ((task: Task) => TurnSetup) | undefined;
  private readonly runs = new Map<string, ActiveRun>();
  private readonly held = new Map<string, HeldRequest>();
  private readonly emitter = new EventEmitter();

  constructor(options: TaskManagerOptions) {
    this.store = options.store;
    this.engines = new Map(options.engines.map((engine) => [engine.id, engine]));
    this.maxActive = options.maxActive ?? (() => DEFAULT_SETTINGS.maxActiveSubagents);
    this.prepareTurn = options.prepareTurn;
    this.emitter.setMaxListeners(0);

    // Requests still open when code-bot last stopped are kept for the user to answer.
    for (const record of this.store.listRequests()) {
      if (!this.store.getTask(record.request.taskId)) {
        this.store.deleteRequest(record.request.id);
        continue;
      }
      this.held.set(record.request.id, {
        request: { ...record.request, held: true },
        inputKey: record.inputKey,
        answer: record.answer,
        by: record.answeredBy,
      });
    }
    // Anything still marked active belongs to a previous process that is gone.
    for (const task of this.store.listTasks({ states: ACTIVE_STATES, limit: 10_000 })) {
      this.setState(task.id, 'interrupted', { error: this.interruptedNote(task.id) });
    }
  }

  // ---- queries -----------------------------------------------------------------

  engineIds(): string[] {
    return [...this.engines.keys()];
  }

  engine(id: string): Engine | undefined {
    return this.engines.get(id);
  }

  listTasks(filter: { botId?: string; states?: readonly TaskState[]; archived?: boolean; limit?: number } = {}): Task[] {
    return this.store.listTasks(filter);
  }

  countActive(botId?: string): number {
    return this.store.countTasks({ botId, states: ACTIVE_STATES });
  }

  getTask(taskId: string): Task {
    const task = this.store.getTask(taskId);
    if (!task) throw new CodeBotError('not_found', `No sub-agent with id "${taskId}"`);
    return task;
  }

  events(taskId: string, afterSeq = 0): CoreEvent[] {
    const task = this.getTask(taskId);
    return this.store.listEvents(taskId, afterSeq).map((event) => ({
      scope: 'task' as const,
      id: taskId,
      botId: task.botId,
      ...event,
    }));
  }

  /** Open questions and approvals: of running sub-agents, and held ones from before a restart. */
  pendingRequests(filter: { taskId?: string; botId?: string } = {}): PendingRequest[] {
    const requests: PendingRequest[] = [];
    const wanted = (request: PendingRequest) =>
      (!filter.taskId || request.taskId === filter.taskId) && (!filter.botId || request.botId === filter.botId);
    for (const active of this.runs.values()) {
      for (const { request } of active.pending.values()) if (wanted(request)) requests.push({ ...request });
    }
    for (const held of this.held.values()) {
      if (!held.answer && wanted(held.request)) requests.push({ ...held.request });
    }
    return requests.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  findRequest(requestId: string): PendingRequest | undefined {
    for (const active of this.runs.values()) {
      const entry = active.pending.get(requestId);
      if (entry) return { ...entry.request };
    }
    const held = this.held.get(requestId);
    return held && !held.answer ? { ...held.request } : undefined;
  }

  /** Receives every event of every sub-agent, including live-only text fragments. */
  subscribe(listener: (event: CoreEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }

  isActive(taskId: string): boolean {
    return this.runs.has(taskId);
  }

  /** The sub-agent stopped while waiting and has requests held for the user. */
  hasHeld(taskId: string): boolean {
    return this.heldFor(taskId).length > 0;
  }

  // ---- commands ----------------------------------------------------------------

  createTask(input: NewTask): Task {
    const prompt = input.prompt.trim();
    if (!prompt) throw new CodeBotError('invalid', 'The brief for the sub-agent is empty');
    if (!this.engines.has(input.engine)) {
      throw new CodeBotError(
        'invalid',
        `Unknown engine "${input.engine}". Available: ${[...this.engines.keys()].join(', ')}`,
      );
    }
    this.checkCapacity();

    const now = new Date().toISOString();
    const task: Task = {
      id: input.id ?? newId('t'),
      botId: input.botId,
      title: input.title?.trim() || titleFrom(prompt),
      state: 'running',
      requestedBy: input.requestedBy,
      role: input.role ?? 'developer',
      forTaskId: input.forTaskId ?? null,
      engine: input.engine,
      model: input.model,
      effort: input.effort,
      permissionMode: input.permissionMode,
      cwd: input.cwd,
      additionalDirectories: input.additionalDirectories,
      instructions: input.instructions,
      engineSessionId: null,
      lastResult: null,
      error: null,
      costUsd: 0,
      tokens: 0,
      maxTurns: input.maxTurns ?? null,
      maxBudgetUsd: input.maxBudgetUsd ?? null,
      worktree: input.worktree ?? null,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.insertTask(task);
    this.emit(task.id, task.botId, 'task.created', { task });
    this.emit(task.id, task.botId, 'user.message', { text: prompt, from: 'lead' satisfies MessageSource });
    try {
      this.startTurn(task, prompt);
    } catch (error) {
      this.failToStart(task.id, error);
    }
    return this.getTask(task.id);
  }

  /** Steers a working sub-agent, or continues a stopped one in the same session. */
  sendMessage(taskId: string, text: string, from: MessageSource): Task {
    const task = this.getTask(taskId);
    const message = text.trim();
    if (!message) throw new CodeBotError('invalid', 'The message is empty');

    const active = this.runs.get(taskId);
    if (!active) this.checkCapacity();
    if (task.archivedAt) this.setArchived(taskId, false);
    this.emit(taskId, task.botId, 'user.message', { text: message, from });
    if (active) {
      if (!active.run.send(message)) active.followUps.push(message);
      return task;
    }
    if (this.hasHeld(taskId)) {
      this.resumeHeld(taskId, message);
      return this.getTask(taskId);
    }
    try {
      this.startTurn(task, message);
    } catch (error) {
      this.failToStart(taskId, error);
    }
    return this.getTask(taskId);
  }

  /** Answers a sub-agent's question or approval request. */
  respond(taskId: string, requestId: string, response: UserResponse, by: 'user' | 'bot'): void {
    this.getTask(taskId);
    const active = this.runs.get(taskId);
    const entry = active?.pending.get(requestId);
    if (active && entry) {
      active.pending.delete(requestId);
      this.store.deleteRequest(requestId);
      this.resolved(taskId, entry.request, response, by);
      if (active.pending.size === 0 && !active.stopReason) this.setState(taskId, 'running');
      entry.resolve(response);
      return;
    }
    const held = this.held.get(requestId);
    if (held && !held.answer && held.request.taskId === taskId) {
      const lastOpen = this.heldFor(taskId).filter((candidate) => !candidate.answer).length === 1;
      // Answering the last open request resumes the sub-agent: check there is room first.
      if (lastOpen) this.checkCapacity();
      held.answer = response;
      held.by = by;
      this.store.answerRequest(requestId, response, by);
      this.resolved(taskId, held.request, response, by);
      if (lastOpen) this.resumeHeld(taskId);
      return;
    }
    throw new CodeBotError('not_found', `Sub-agent ${taskId} has no open request "${requestId}" (it may already be answered)`);
  }

  /** Records that a request was put to the user in a conversation. */
  markSurfaced(requestId: string, threadId: string): void {
    for (const active of this.runs.values()) {
      const entry = active.pending.get(requestId);
      if (entry) {
        entry.request.surfacedIn = threadId;
        this.store.updateRequest(entry.request);
      }
    }
    const held = this.held.get(requestId);
    if (held) {
      held.request.surfacedIn = threadId;
      this.store.updateRequest(held.request);
    }
  }

  async cancel(taskId: string): Promise<Task> {
    const task = this.getTask(taskId);
    const active = this.runs.get(taskId);
    if (active && !active.stopReason) {
      active.stopReason = 'cancelled';
      active.followUps.length = 0;
      await active.run.interrupt();
    } else if (!active && this.hasHeld(taskId)) {
      this.dropHeld(taskId);
      this.setState(taskId, 'cancelled', { error: null });
    } else if (!active && task.state === 'interrupted') {
      this.setState(taskId, 'cancelled', { error: null });
    }
    return this.getTask(taskId);
  }

  /** Hides a stopped sub-agent from the lists, or shows it again. */
  setArchived(taskId: string, archived: boolean): Task {
    const task = this.getTask(taskId);
    if (archived && this.runs.has(taskId)) {
      throw new CodeBotError('conflict', `Sub-agent ${taskId} is working; stop it before archiving it`);
    }
    if (archived) this.dropHeld(taskId);
    const archivedAt = archived ? (task.archivedAt ?? new Date().toISOString()) : null;
    const updated = this.store.updateTask(taskId, { archivedAt }, false);
    this.emit(taskId, task.botId, archived ? 'archived' : 'unarchived', { archivedAt });
    return updated;
  }

  /**
   * Changes how much the sub-agent may do without asking, from its next turn on
   * (a working sub-agent keeps its current mode until its turn ends).
   */
  setPermissionMode(taskId: string, permissionMode: string): Task {
    const task = this.getTask(taskId);
    if (task.permissionMode === permissionMode) return task;
    const updated = this.store.updateTask(taskId, { permissionMode }, false);
    this.emit(taskId, task.botId, 'settings', { permissionMode });
    return updated;
  }

  /** Records a change to the sub-agent's worktree (removed or brought back). */
  /** Records something that happened to a sub-agent outside its runs (its branch was merged or pushed). */
  note(taskId: string, type: string, data: unknown): void {
    this.emit(taskId, this.getTask(taskId).botId, type, data);
  }

  setWorktree(taskId: string, worktree: TaskWorktree | null): Task {
    const task = this.getTask(taskId);
    const updated = this.store.updateTask(taskId, { worktree }, false);
    this.emit(taskId, task.botId, 'worktree', { worktree });
    return updated;
  }

  /** Permanently removes a stopped sub-agent and its history. */
  delete(taskId: string): void {
    const task = this.getTask(taskId);
    if (this.runs.has(taskId)) throw new CodeBotError('conflict', `Sub-agent ${taskId} is working`);
    for (const held of this.heldFor(taskId)) this.held.delete(held.request.id);
    this.store.deleteTask(taskId);
    this.emit(taskId, task.botId, 'deleted', {}, true);
  }

  /** Stops every running sub-agent and waits for it to wind down; their sessions and open requests stay resumable. */
  async shutdown(): Promise<void> {
    const runs = [...this.runs.values()];
    const stopping = runs.map((active) => {
      active.stopReason ??= 'interrupted';
      active.followUps.length = 0;
      return active.run.interrupt().catch(() => undefined);
    });
    await Promise.all(stopping);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const giveUp = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SHUTDOWN_WAIT_MS);
    });
    await Promise.race([Promise.all(runs.map((active) => active.finished)), giveUp]);
    clearTimeout(timer);
  }

  // ---- internals ---------------------------------------------------------------

  private checkCapacity(): void {
    const limit = this.maxActive();
    if (this.runs.size >= limit) {
      throw new CodeBotError('busy', `${this.runs.size} sub-agents are already working (the limit is ${limit}); wait for one to finish or stop one`);
    }
  }

  private heldFor(taskId: string): HeldRequest[] {
    return [...this.held.values()].filter((held) => held.request.taskId === taskId);
  }

  private interruptedNote(taskId: string): string {
    return this.heldFor(taskId).some((held) => !held.answer)
      ? 'code-bot closed while this sub-agent waited for an answer. Answering resumes it.'
      : 'code-bot closed while this sub-agent was working. Send it a message to resume.';
  }

  private resolved(taskId: string, request: PendingRequest, response: UserResponse, by: 'user' | 'bot'): void {
    this.emit(taskId, request.botId, 'request.resolved', {
      ...(truncate(response) as object),
      id: request.id,
      by,
      surfacedIn: request.surfacedIn,
    });
  }

  private withdrawn(taskId: string, request: PendingRequest): void {
    this.emit(taskId, request.botId, 'request.resolved', {
      id: request.id,
      decision: 'withdrawn',
      by: 'system',
      surfacedIn: request.surfacedIn,
    });
  }

  /** Withdraws and forgets every held request of a sub-agent. */
  private dropHeld(taskId: string): void {
    for (const held of this.heldFor(taskId)) {
      if (!held.answer) this.withdrawn(taskId, held.request);
      this.held.delete(held.request.id);
      this.store.deleteRequest(held.request.id);
    }
  }

  /** Continues a sub-agent that stopped while waiting, with the answers given since (and a new message, if any). */
  private resumeHeld(taskId: string, message?: string): void {
    const held = this.heldFor(taskId);
    const answered = held.filter((item) => item.answer);
    const grants = answered
      .filter((item) => item.request.kind === 'permission' && item.answer?.decision === 'allow' && item.inputKey)
      .map((item) => item.inputKey as string);
    for (const item of held) {
      if (!item.answer) this.withdrawn(taskId, item.request);
      this.held.delete(item.request.id);
      this.store.deleteRequest(item.request.id);
    }
    const prompt = [answered.length ? heldAnswersPrompt(answered) : '', message ?? ''].filter(Boolean).join('\n\n');
    try {
      this.startTurn(this.getTask(taskId), prompt || 'Carry on with your task.', grants);
    } catch (error) {
      this.failToStart(taskId, error);
    }
  }

  private startTurn(original: Task, prompt: string, grants: string[] = []): void {
    const setup: TurnSetup = this.prepareTurn
      ? this.prepareTurn(original)
      : { task: original, maxTurns: original.maxTurns, maxBudgetUsd: original.maxBudgetUsd, mcpServers: [] };
    const task = setup.task;
    const engine = this.engines.get(task.engine);
    if (!engine) throw new CodeBotError('invalid', `Engine "${task.engine}" is not available`);
    let maxBudgetUsd: number | undefined;
    if (setup.maxBudgetUsd !== null) {
      const remaining = setup.maxBudgetUsd - task.costUsd;
      if (remaining <= 0) {
        throw new CodeBotError(
          'invalid',
          `This sub-agent has used its budget: ${money(task.costUsd)} of ${money(setup.maxBudgetUsd)}. Raise the project's budget per sub-agent to continue it.`,
        );
      }
      maxBudgetUsd = remaining;
    }

    const active: ActiveRun = { run: undefined as unknown as EngineRun, pending: new Map(), followUps: [], grants };

    const askUser: AskUser = (request, signal) => {
      const inputKey = callKey(request.tool, request.input);
      if (request.kind === 'permission') {
        const granted = active.grants.indexOf(inputKey);
        if (granted >= 0) {
          active.grants.splice(granted, 1);
          return Promise.resolve({ decision: 'allow' });
        }
      }
      return new Promise<UserResponse>((resolve, reject) => {
        const pending: PendingRequest = {
          ...request,
          input: truncate(request.input, 0, REQUEST_STRING_LIMIT),
          id: newId('r'),
          taskId: task.id,
          botId: task.botId,
          createdAt: new Date().toISOString(),
          surfacedIn: null,
        };
        active.pending.set(pending.id, { request: pending, resolve });
        this.store.insertRequest(pending, inputKey);
        this.setState(task.id, 'waiting');
        this.emit(task.id, task.botId, 'request', pending);
        signal.addEventListener(
          'abort',
          () => {
            const entry = active.pending.get(pending.id);
            if (!entry) return;
            active.pending.delete(pending.id);
            reject(new Error('The request was withdrawn'));
            if (active.stopReason === 'interrupted') {
              // code-bot is closing: the request stays open (in the database) for after the restart.
              this.held.set(pending.id, { request: { ...entry.request, held: true }, inputKey, answer: null, by: null });
              return;
            }
            this.store.deleteRequest(pending.id);
            this.withdrawn(task.id, entry.request);
            if (active.pending.size === 0 && this.runs.get(task.id) === active && !active.stopReason) {
              this.setState(task.id, 'running');
            }
          },
          { once: true },
        );
      });
    };

    active.run = engine.start(
      {
        cwd: task.cwd,
        additionalDirectories: task.additionalDirectories,
        prompt,
        model: task.model ?? undefined,
        effort: task.effort ?? undefined,
        permissionMode: task.permissionMode,
        resumeSessionId: task.engineSessionId ?? undefined,
        instructions: task.instructions || undefined,
        maxTurns: setup.maxTurns ?? undefined,
        maxBudgetUsd,
        mcpServers: setup.mcpServers.length ? setup.mcpServers : undefined,
      },
      askUser,
    );
    this.runs.set(task.id, active);
    this.setState(task.id, 'running', { error: null });
    active.finished = this.consume(task, active, setup).catch((error) => {
      console.error(`code-bot: sub-agent ${task.id} ended badly:`, error);
    });
  }

  private async consume(task: Task, active: ActiveRun, setup: TurnSetup): Promise<void> {
    const { id: taskId, botId } = task;
    let last: Extract<EngineEvent, { type: 'result' }> | undefined;
    try {
      for await (const event of active.run.events) {
        switch (event.type) {
          case 'session':
            this.store.updateTask(taskId, { engineSessionId: event.sessionId });
            this.emit(taskId, botId, 'session', { sessionId: event.sessionId, model: event.model });
            break;
          case 'text_delta':
            this.emit(taskId, botId, 'text.delta', { text: event.text }, true);
            break;
          case 'text':
            this.emit(taskId, botId, 'text', { text: event.text });
            break;
          case 'tool_use':
            this.emit(taskId, botId, 'tool.use', { id: event.id, name: event.name, input: truncate(event.input) });
            break;
          case 'tool_result':
            this.emit(taskId, botId, 'tool.result', { id: event.id, isError: event.isError, preview: event.preview });
            break;
          case 'result':
            last = event;
            if (event.costUsd !== undefined || event.tokens !== undefined) {
              this.store.updateTask(taskId, {
                ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
                ...(event.tokens !== undefined ? { tokens: event.tokens } : {}),
              });
            }
            this.emit(taskId, botId, 'result', {
              ok: event.ok,
              text: event.text,
              error: event.error,
              limit: event.limit,
              costUsd: event.costUsd,
              tokens: event.tokens,
              durationMs: event.durationMs,
              numTurns: event.numTurns,
            });
            break;
        }
      }
    } catch (error) {
      last = { type: 'result', ok: false, text: '', error: errorMessage(error) };
      this.emit(taskId, botId, 'result', { ok: false, text: '', error: last.error });
    }

    this.runs.delete(taskId);
    const closing = active.stopReason === 'interrupted';
    for (const { request } of active.pending.values()) {
      if (closing) {
        // Kept in the database: after the restart the user can still answer it.
        const kept = this.store.listRequests(taskId).find((record) => record.request.id === request.id);
        this.held.set(request.id, { request: { ...request, held: true }, inputKey: kept?.inputKey ?? null, answer: null, by: null });
        continue;
      }
      this.store.deleteRequest(request.id);
      this.withdrawn(taskId, request);
    }
    active.pending.clear();

    if (active.stopReason) {
      this.setState(taskId, active.stopReason, {
        lastResult: last?.text || null,
        error: active.stopReason === 'interrupted' ? this.interruptedNote(taskId) : null,
      });
      return;
    }
    if (last?.ok) {
      this.setState(taskId, 'done', { lastResult: last.text, error: null });
    } else {
      this.setState(taskId, 'failed', { error: this.failure(last, setup) });
    }
    if (active.followUps.length > 0) {
      try {
        this.startTurn(this.getTask(taskId), active.followUps.join('\n\n'));
      } catch (error) {
        this.failToStart(taskId, error);
      }
    }
  }

  private failure(last: Extract<EngineEvent, { type: 'result' }> | undefined, setup: TurnSetup): string {
    if (last?.limit === 'turns') {
      return `Stopped after ${last.numTurns ?? setup.maxTurns ?? '?'} turns, the project's limit per run. Send it a message to let it continue.`;
    }
    if (last?.limit === 'budget') {
      const spent = last.costUsd !== undefined ? `${money(last.costUsd)} spent` : 'spent';
      return `Stopped at the project's budget per sub-agent (${money(setup.maxBudgetUsd ?? 0)}, ${spent}). Raise the budget to continue it.`;
    }
    return last?.error ?? 'The sub-agent stopped without a result.';
  }

  private failToStart(taskId: string, error: unknown): void {
    const message = errorMessage(error);
    const task = this.getTask(taskId);
    this.runs.delete(taskId);
    this.emit(taskId, task.botId, 'result', { ok: false, text: '', error: message });
    this.setState(taskId, 'failed', { error: message });
  }

  private setState(taskId: string, state: TaskState, patch: Partial<Omit<Task, 'id' | 'state'>> = {}): void {
    const before = this.store.getTask(taskId);
    const task = this.store.updateTask(taskId, { ...patch, state });
    if (before?.state !== state) this.emit(taskId, task.botId, 'state', { state, error: task.error ?? undefined });
  }

  private emit(taskId: string, botId: string, type: string, data: unknown, liveOnly = false): void {
    const stored = liveOnly
      ? { seq: 0, ts: new Date().toISOString(), type, data }
      : this.store.appendEvent(taskId, type, data);
    const event: CoreEvent = { scope: 'task', id: taskId, botId, ...stored };
    this.emitter.emit('event', event);
  }
}
