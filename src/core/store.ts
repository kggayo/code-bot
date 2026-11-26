import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  AppSettings,
  Bot,
  Effort,
  Isolation,
  PendingRequest,
  PermissionMode,
  Routine,
  RoutineSchedule,
  StoredEvent,
  Task,
  TaskState,
  UserResponse,
} from '../shared/types.ts';

export interface ThreadRecord {
  id: string;
  botId: string;
  /** The model session that holds this conversation, once it has started. */
  engineSessionId: string | null;
  createdAt: string;
  archivedAt: string | null;
}

/** A thread with what the list of conversations shows about it. */
export interface ThreadStats extends ThreadRecord {
  firstMessage: string | null;
  lastActivity: string;
  messages: number;
}

/** A sub-agent's question or approval request, kept so it survives a restart. */
export interface RequestRecord {
  request: PendingRequest;
  /** Identifies the exact tool call (tool and full input), for approvals given after a restart. */
  inputKey: string | null;
  /** The answer, once given while the sub-agent was not running. */
  answer: UserResponse | null;
  answeredBy: 'user' | 'bot' | null;
}

type Row = Record<string, unknown>;
type SqlValue = string | number | null;

/**
 * Each entry upgrades the database by one version; entry i takes it from
 * version i to i + 1. A new database runs all of them. Never edit an entry
 * that has shipped: add a new one.
 */
const MIGRATIONS: string[] = [
  // 1: the first desktop version.
  `
  CREATE TABLE bots (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    folders TEXT NOT NULL DEFAULT '[]',
    instructions TEXT NOT NULL DEFAULT '',
    model TEXT,
    effort TEXT,
    sub_engine TEXT NOT NULL,
    sub_model TEXT,
    sub_effort TEXT,
    sub_permission_mode TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    archived_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL,
    engine_session_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL,
    title TEXT NOT NULL,
    state TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    engine TEXT NOT NULL,
    model TEXT,
    effort TEXT,
    permission_mode TEXT NOT NULL,
    cwd TEXT NOT NULL,
    additional_dirs TEXT NOT NULL DEFAULT '[]',
    instructions TEXT NOT NULL DEFAULT '',
    engine_session_id TEXT,
    last_result TEXT,
    error TEXT,
    cost_usd REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX tasks_by_bot ON tasks (bot_id, created_at);
  CREATE TABLE events (
    owner_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    ts TEXT NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (owner_id, seq)
  );
  `,
  // 2: worktrees, limits, archiving, durable requests, settings.
  `
  ALTER TABLE bots ADD COLUMN sub_isolation TEXT NOT NULL DEFAULT 'shared';
  ALTER TABLE bots ADD COLUMN sub_worktree_files TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE bots ADD COLUMN sub_max_turns INTEGER;
  ALTER TABLE bots ADD COLUMN sub_max_budget_usd REAL;
  ALTER TABLE threads ADD COLUMN archived_at TEXT;
  ALTER TABLE tasks ADD COLUMN max_turns INTEGER;
  ALTER TABLE tasks ADD COLUMN max_budget_usd REAL;
  ALTER TABLE tasks ADD COLUMN worktree TEXT;
  ALTER TABLE tasks ADD COLUMN archived_at TEXT;
  CREATE INDEX threads_by_bot ON threads (bot_id, created_at);
  CREATE TABLE requests (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    data TEXT NOT NULL,
    input_key TEXT,
    answer TEXT,
    answered_by TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // 3: sub-agent roles, usage of bots and Codex sub-agents, routines.
  `
  ALTER TABLE tasks ADD COLUMN role TEXT NOT NULL DEFAULT 'developer';
  ALTER TABLE tasks ADD COLUMN for_task_id TEXT;
  ALTER TABLE tasks ADD COLUMN tokens INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE threads ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;
  CREATE TABLE routines (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL,
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    schedule TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    next_run_at TEXT,
    last_run_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
];

/** The version this code writes. */
export const SCHEMA_VERSION = MIGRATIONS.length;

const TASK_COLUMNS = {
  id: 'id',
  botId: 'bot_id',
  title: 'title',
  state: 'state',
  requestedBy: 'requested_by',
  role: 'role',
  forTaskId: 'for_task_id',
  engine: 'engine',
  model: 'model',
  effort: 'effort',
  permissionMode: 'permission_mode',
  cwd: 'cwd',
  additionalDirectories: 'additional_dirs',
  instructions: 'instructions',
  engineSessionId: 'engine_session_id',
  lastResult: 'last_result',
  error: 'error',
  costUsd: 'cost_usd',
  tokens: 'tokens',
  maxTurns: 'max_turns',
  maxBudgetUsd: 'max_budget_usd',
  worktree: 'worktree',
  archivedAt: 'archived_at',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
} as const satisfies Record<keyof Task, string>;

/** Task fields kept as JSON text. */
const JSON_TASK_FIELDS = new Set<keyof Task>(['additionalDirectories', 'worktree']);

function taskValue(key: keyof Task, value: unknown): SqlValue {
  if (key === 'additionalDirectories') return JSON.stringify(value ?? []);
  if (key === 'worktree') return value ? JSON.stringify(value) : null;
  return (value ?? null) as SqlValue;
}

function toTask(row: Row): Task {
  const task: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(TASK_COLUMNS)) {
    const raw = row[column] ?? null;
    if (key === 'additionalDirectories') task[key] = JSON.parse(String(raw ?? '[]'));
    else if (JSON_TASK_FIELDS.has(key as keyof Task)) task[key] = raw === null ? null : JSON.parse(String(raw));
    else task[key] = raw;
  }
  return task as unknown as Task;
}

function toBot(row: Row): Bot {
  return {
    id: row.id as string,
    kind: row.kind as Bot['kind'],
    name: row.name as string,
    description: row.description as string,
    folders: JSON.parse(String(row.folders ?? '[]')) as string[],
    instructions: row.instructions as string,
    model: (row.model as string | null) ?? null,
    effort: (row.effort as Effort | null) ?? null,
    subagents: {
      engine: row.sub_engine as string,
      model: (row.sub_model as string | null) ?? null,
      effort: (row.sub_effort as Effort | null) ?? null,
      permissionMode: row.sub_permission_mode as PermissionMode,
      isolation: ((row.sub_isolation as string | null) ?? 'shared') as Isolation,
      worktreeFiles: JSON.parse(String(row.sub_worktree_files ?? '[]')) as string[],
      maxTurns: (row.sub_max_turns as number | null) ?? null,
      maxBudgetUsd: (row.sub_max_budget_usd as number | null) ?? null,
    },
    threadId: row.thread_id as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function botValues(bot: Bot): Record<string, SqlValue> {
  return {
    id: bot.id,
    kind: bot.kind,
    name: bot.name,
    description: bot.description,
    folders: JSON.stringify(bot.folders),
    instructions: bot.instructions,
    model: bot.model,
    effort: bot.effort,
    sub_engine: bot.subagents.engine,
    sub_model: bot.subagents.model,
    sub_effort: bot.subagents.effort,
    sub_permission_mode: bot.subagents.permissionMode,
    sub_isolation: bot.subagents.isolation,
    sub_worktree_files: JSON.stringify(bot.subagents.worktreeFiles),
    sub_max_turns: bot.subagents.maxTurns,
    sub_max_budget_usd: bot.subagents.maxBudgetUsd,
    thread_id: bot.threadId,
    created_at: bot.createdAt,
    updated_at: bot.updatedAt,
  };
}

function toThread(row: Row): ThreadRecord {
  return {
    id: row.id as string,
    botId: row.bot_id as string,
    engineSessionId: (row.engine_session_id as string | null) ?? null,
    createdAt: row.created_at as string,
    archivedAt: (row.archived_at as string | null) ?? null,
  };
}

function toRoutine(row: Row): Routine {
  return {
    id: row.id as string,
    botId: row.bot_id as string,
    title: row.title as string,
    prompt: row.prompt as string,
    schedule: JSON.parse(String(row.schedule)) as RoutineSchedule,
    enabled: Number(row.enabled) === 1,
    nextRunAt: (row.next_run_at as string | null) ?? null,
    lastRunAt: (row.last_run_at as string | null) ?? null,
    lastError: (row.last_error as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function routineValues(routine: Routine): Record<string, SqlValue> {
  return {
    id: routine.id,
    bot_id: routine.botId,
    title: routine.title,
    prompt: routine.prompt,
    schedule: JSON.stringify(routine.schedule),
    enabled: routine.enabled ? 1 : 0,
    next_run_at: routine.nextRunAt,
    last_run_at: routine.lastRunAt,
    last_error: routine.lastError,
    created_at: routine.createdAt,
    updated_at: routine.updatedAt,
  };
}

/** SQLite persistence through Node's built-in `node:sqlite`. Every call is synchronous. */
export class Store {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'code-bot.db'));
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.migrate();
  }

  private migrate(): void {
    const { user_version: version } = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version > SCHEMA_VERSION) {
      throw new Error('This database was written by a newer version of code-bot. Update the app.');
    }
    if (version === 0) {
      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Row[];
      if (tables.length > 0) {
        throw new Error('This data folder holds a database from an older code-bot version. Use an empty data folder.');
      }
    }
    for (let next = version; next < SCHEMA_VERSION; next++) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(MIGRATIONS[next] as string);
        this.db.exec(`PRAGMA user_version = ${next + 1}`);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
  }

  // ---- settings ---------------------------------------------------------------

  getSettings(): Partial<AppSettings> {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    return Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value)])) as Partial<AppSettings>;
  }

  saveSettings(settings: AppSettings): void {
    const upsert = this.db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    for (const [key, value] of Object.entries(settings)) upsert.run(key, JSON.stringify(value));
  }

  // ---- bots -------------------------------------------------------------------

  insertBot(bot: Bot): void {
    const values = botValues(bot);
    const columns = Object.keys(values);
    this.db
      .prepare(`INSERT INTO bots (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
      .run(...Object.values(values));
  }

  saveBot(bot: Bot): void {
    const values = botValues(bot);
    const columns = Object.keys(values).filter((column) => column !== 'id');
    this.db
      .prepare(`UPDATE bots SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE id = ?`)
      .run(...columns.map((column) => values[column] ?? null), bot.id);
  }

  getBot(id: string): Bot | undefined {
    const row = this.db.prepare('SELECT * FROM bots WHERE id = ? AND archived_at IS NULL').get(id) as Row | undefined;
    return row ? toBot(row) : undefined;
  }

  listBots(): Bot[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM bots WHERE archived_at IS NULL
         ORDER BY CASE kind WHEN 'main' THEN 0 ELSE 1 END, name COLLATE NOCASE`,
      )
      .all() as Row[];
    return rows.map(toBot);
  }

  archiveBot(id: string): void {
    this.db.prepare('UPDATE bots SET archived_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  }

  // ---- threads ----------------------------------------------------------------

  insertThread(thread: Omit<ThreadRecord, 'archivedAt'>): void {
    this.db
      .prepare('INSERT INTO threads (id, bot_id, engine_session_id, created_at) VALUES (?, ?, ?, ?)')
      .run(thread.id, thread.botId, thread.engineSessionId, thread.createdAt);
  }

  getThread(id: string): ThreadRecord | undefined {
    const row = this.db.prepare('SELECT * FROM threads WHERE id = ?').get(id) as Row | undefined;
    return row ? toThread(row) : undefined;
  }

  setThreadSession(id: string, engineSessionId: string): void {
    this.db.prepare('UPDATE threads SET engine_session_id = ? WHERE id = ?').run(engineSessionId, id);
  }

  setThreadArchived(id: string, archivedAt: string | null): void {
    this.db.prepare('UPDATE threads SET archived_at = ? WHERE id = ?').run(archivedAt, id);
  }

  /** The bot session's cost so far (the engine reports it for the whole session). */
  setThreadCost(id: string, costUsd: number): void {
    this.db.prepare('UPDATE threads SET cost_usd = ? WHERE id = ?').run(costUsd, id);
  }

  /** What bots' own conversations cost: one bot's, or (without botId) every project bot's. */
  botCost(botId?: string): number {
    const row = (
      botId
        ? this.db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM threads WHERE bot_id = ?').get(botId)
        : this.db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM threads WHERE bot_id <> 'main'").get()
    ) as { usd: number };
    return row.usd;
  }

  /** What sub-agents cost: one project's, or every project's. Archived ones count too. */
  taskUsage(botId?: string): { usd: number; tokens: number } {
    const row = (
      botId
        ? this.db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS usd, COALESCE(SUM(tokens), 0) AS tokens FROM tasks WHERE bot_id = ?').get(botId)
        : this.db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS usd, COALESCE(SUM(tokens), 0) AS tokens FROM tasks').get()
    ) as { usd: number; tokens: number };
    return { usd: row.usd, tokens: row.tokens };
  }

  /** A bot's threads, newest first, with their first message and latest activity. */
  listThreads(botId: string, filter: { archived: boolean; limit?: number }): ThreadStats[] {
    const rows = this.db
      .prepare(
        `SELECT t.*,
           (SELECT data FROM events e WHERE e.owner_id = t.id AND e.type IN ('user.message', 'inbound') ORDER BY e.seq LIMIT 1) AS first_message,
           COALESCE((SELECT MAX(ts) FROM events e WHERE e.owner_id = t.id), t.created_at) AS last_activity,
           (SELECT COUNT(*) FROM events e WHERE e.owner_id = t.id AND e.type IN ('user.message', 'inbound', 'bot.text')) AS messages
         FROM threads t
         WHERE t.bot_id = ? AND (t.archived_at IS NOT NULL) = ?
         ORDER BY last_activity DESC
         LIMIT ?`,
      )
      .all(botId, filter.archived ? 1 : 0, filter.limit ?? 200) as Row[];
    return rows.map((row) => {
      let firstMessage: string | null = null;
      try {
        const data = JSON.parse(String(row.first_message ?? 'null')) as { text?: unknown } | null;
        firstMessage = typeof data?.text === 'string' ? data.text : null;
      } catch {
        firstMessage = null;
      }
      return {
        ...toThread(row),
        firstMessage,
        lastActivity: row.last_activity as string,
        messages: Number(row.messages ?? 0),
      };
    });
  }

  /** Threads that are not any bot's current one, last active before the given time and not archived. */
  idleThreads(before: string): ThreadRecord[] {
    const rows = this.db
      .prepare(
        `SELECT t.* FROM threads t
         WHERE t.archived_at IS NULL
           AND t.id NOT IN (SELECT thread_id FROM bots)
           AND COALESCE((SELECT MAX(ts) FROM events e WHERE e.owner_id = t.id), t.created_at) < ?`,
      )
      .all(before) as Row[];
    return rows.map(toThread);
  }

  archivedThreadsBefore(before: string): ThreadRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM threads WHERE archived_at IS NOT NULL AND archived_at < ? AND id NOT IN (SELECT thread_id FROM bots)')
      .all(before) as Row[];
    return rows.map(toThread);
  }

  /** Permanently removes a thread and its history. */
  deleteThread(id: string): void {
    this.db.prepare('DELETE FROM events WHERE owner_id = ?').run(id);
    this.db.prepare('DELETE FROM threads WHERE id = ?').run(id);
  }

  // ---- tasks ------------------------------------------------------------------

  insertTask(task: Task): void {
    const keys = Object.keys(TASK_COLUMNS) as (keyof Task)[];
    this.db
      .prepare(
        `INSERT INTO tasks (${keys.map((k) => TASK_COLUMNS[k]).join(', ')})
         VALUES (${keys.map(() => '?').join(', ')})`,
      )
      .run(...keys.map((k) => taskValue(k, task[k])));
  }

  updateTask(id: string, patch: Partial<Omit<Task, 'id'>>, touch = true): Task {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    const sets = keys.map((k) => `${TASK_COLUMNS[k]} = ?`);
    const params = keys.map((k) => taskValue(k, patch[k]));
    if (touch) {
      sets.push('updated_at = ?');
      params.push(new Date().toISOString());
    }
    if (sets.length > 0) this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    const task = this.getTask(id);
    if (!task) throw new Error(`Task ${id} not found`);
    return task;
  }

  getTask(id: string): Task | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined;
    return row ? toTask(row) : undefined;
  }

  listTasks(
    filter: { botId?: string; states?: readonly TaskState[]; archived?: boolean; limit?: number } = {},
  ): Task[] {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (filter.botId) {
      where.push('bot_id = ?');
      params.push(filter.botId);
    }
    if (filter.states?.length) {
      where.push(`state IN (${filter.states.map(() => '?').join(', ')})`);
      params.push(...filter.states);
    }
    if (filter.archived !== undefined) where.push(filter.archived ? 'archived_at IS NOT NULL' : 'archived_at IS NULL');
    params.push(filter.limit ?? 100);
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(...params) as Row[];
    return rows.map(toTask);
  }

  countTasks(filter: { botId?: string; states: readonly TaskState[] }): number {
    const where = [`state IN (${filter.states.map(() => '?').join(', ')})`];
    const params: SqlValue[] = [...filter.states];
    if (filter.botId) {
      where.push('bot_id = ?');
      params.push(filter.botId);
    }
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE ${where.join(' AND ')}`).get(...params) as {
      n: number;
    };
    return row.n;
  }

  /** Finished, unarchived sub-agents last updated before the given time. */
  idleTasks(before: string, states: readonly TaskState[]): Task[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks WHERE archived_at IS NULL AND updated_at < ?
         AND state IN (${states.map(() => '?').join(', ')})`,
      )
      .all(before, ...states) as Row[];
    return rows.map(toTask);
  }

  archivedTasksBefore(before: string): Task[] {
    const rows = this.db.prepare('SELECT * FROM tasks WHERE archived_at IS NOT NULL AND archived_at < ?').all(before) as Row[];
    return rows.map(toTask);
  }

  /** Permanently removes a sub-agent, its history and its requests. */
  deleteTask(id: string): void {
    this.db.prepare('DELETE FROM events WHERE owner_id = ?').run(id);
    this.db.prepare('DELETE FROM requests WHERE task_id = ?').run(id);
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  }

  // ---- requests ---------------------------------------------------------------

  insertRequest(request: PendingRequest, inputKey: string | null): void {
    this.db
      .prepare('INSERT INTO requests (id, task_id, data, input_key, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(request.id, request.taskId, JSON.stringify(request), inputKey, request.createdAt);
  }

  updateRequest(request: PendingRequest): void {
    this.db.prepare('UPDATE requests SET data = ? WHERE id = ?').run(JSON.stringify(request), request.id);
  }

  answerRequest(id: string, answer: UserResponse, by: 'user' | 'bot'): void {
    this.db.prepare('UPDATE requests SET answer = ?, answered_by = ? WHERE id = ?').run(JSON.stringify(answer), by, id);
  }

  deleteRequest(id: string): void {
    this.db.prepare('DELETE FROM requests WHERE id = ?').run(id);
  }

  listRequests(taskId?: string): RequestRecord[] {
    const rows = (
      taskId
        ? this.db.prepare('SELECT * FROM requests WHERE task_id = ? ORDER BY created_at').all(taskId)
        : this.db.prepare('SELECT * FROM requests ORDER BY created_at').all()
    ) as Row[];
    return rows.map((row) => ({
      request: JSON.parse(String(row.data)) as PendingRequest,
      inputKey: (row.input_key as string | null) ?? null,
      answer: row.answer ? (JSON.parse(String(row.answer)) as UserResponse) : null,
      answeredBy: (row.answered_by as 'user' | 'bot' | null) ?? null,
    }));
  }

  // ---- routines ---------------------------------------------------------------

  insertRoutine(routine: Routine): void {
    const values = routineValues(routine);
    const columns = Object.keys(values);
    this.db
      .prepare(`INSERT INTO routines (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
      .run(...Object.values(values));
  }

  saveRoutine(routine: Routine): void {
    const values = routineValues(routine);
    const columns = Object.keys(values).filter((column) => column !== 'id');
    this.db
      .prepare(`UPDATE routines SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE id = ?`)
      .run(...columns.map((column) => values[column] ?? null), routine.id);
  }

  getRoutine(id: string): Routine | undefined {
    const row = this.db.prepare('SELECT * FROM routines WHERE id = ?').get(id) as Row | undefined;
    return row ? toRoutine(row) : undefined;
  }

  /** Routines of bots that still exist: the next to run first, then the ones that will not run again. */
  listRoutines(): Routine[] {
    const rows = this.db
      .prepare(
        `SELECT r.* FROM routines r JOIN bots b ON b.id = r.bot_id AND b.archived_at IS NULL
         ORDER BY r.next_run_at IS NULL, r.next_run_at, r.title COLLATE NOCASE`,
      )
      .all() as Row[];
    return rows.map(toRoutine);
  }

  deleteRoutine(id: string): void {
    this.db.prepare('DELETE FROM routines WHERE id = ?').run(id);
  }

  // ---- events -----------------------------------------------------------------

  /** Appends to the history of a thread or a task. */
  appendEvent(ownerId: string, type: string, data: unknown): StoredEvent {
    const ts = new Date().toISOString();
    const row = this.db
      .prepare(
        `INSERT INTO events (owner_id, seq, ts, type, data)
         VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM events WHERE owner_id = ?), ?, ?, ?)
         RETURNING seq`,
      )
      .get(ownerId, ownerId, ts, type, JSON.stringify(data ?? null)) as { seq: number };
    return { seq: row.seq, ts, type, data };
  }

  listEvents(ownerId: string, afterSeq = 0, limit = 2000): StoredEvent[] {
    const rows = this.db
      .prepare('SELECT seq, ts, type, data FROM events WHERE owner_id = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(ownerId, afterSeq, limit) as { seq: number; ts: string; type: string; data: string }[];
    return rows.map((r) => ({ seq: r.seq, ts: r.ts, type: r.type, data: JSON.parse(r.data) }));
  }

  close(): void {
    this.db.close();
  }
}
