import { z } from 'zod';
import { EFFORTS, ISOLATIONS, PERMISSION_MODES } from '../shared/types.ts';
import type { AppInfo, CodeBotApi, CodeBotMethod } from '../shared/types.ts';
import type { CodeBot } from './code-bot.ts';
import { CodeBotError } from './util.ts';

/**
 * The operations of `CodeBotApi`, checked the same way for every caller: the
 * desktop window over IPC (`src/desktop/main/ipc.ts`) and terminals or other
 * clients over the headless server's HTTP API (`src/headless/server.ts`).
 * Arguments from a caller are untrusted until they pass these schemas; the
 * core then checks meaning (names, folders, commands).
 */

const text = z.string();
const id = z.string().min(1).max(100);
const after = z.number().int().min(0).optional();
// The shape only; the core checks names, commands and addresses (src/core/mcp.ts).
const mcpServer = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('stdio'),
    name: z.string().max(40),
    command: z.string().max(1000),
    args: z.array(z.string().max(2000)).max(50),
    allowTools: z.boolean(),
  }),
  z.object({
    type: z.literal('http'),
    name: z.string().max(40),
    url: z.string().max(2000),
    tokenEnvVar: z.string().max(100).nullable().optional(),
    allowTools: z.boolean(),
  }),
]);
const subagents = z.object({
  engine: z.string().min(1),
  model: z.string().nullable(),
  effort: z.enum(EFFORTS).nullable(),
  permissionMode: z.enum(PERMISSION_MODES),
  isolation: z.enum(ISOLATIONS),
  worktreeFiles: z.array(z.string().max(200)).max(30),
  maxTurns: z.number().int().min(1).max(10_000).nullable(),
  maxBudgetUsd: z.number().positive().max(100_000).nullable(),
  mcpServers: z.array(mcpServer).max(20),
});
const settings = z.object({
  maxActiveSubagents: z.number().int().min(1).max(50),
  archiveAfterDays: z.number().int().min(0).max(3650),
  deleteArchivedAfterDays: z.number().int().min(0).max(3650),
});
export const botInputSchema = z.object({
  name: text,
  description: text,
  folders: z.array(text).max(20),
  instructions: text,
  model: z.string().nullable(),
  effort: z.enum(EFFORTS).nullable(),
  subagents,
});
const userResponse = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('allow'), answers: z.record(z.string(), z.string()).optional() }),
  z.object({ decision: z.literal('deny'), message: z.string().optional() }),
]);
const routineSchedule = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once'), at: z.string().max(40) }),
  z.object({ kind: z.literal('daily'), time: z.string().max(5), days: z.array(z.number().int().min(0).max(6)).max(7) }),
  z.object({ kind: z.literal('interval'), minutes: z.number().int().min(1).max(100_000) }),
]);
export const routineInputSchema = z.object({
  botId: id,
  title: text.max(200),
  prompt: text.max(20_000),
  schedule: routineSchedule,
  enabled: z.boolean(),
});

/** Argument schemas for every operation, as tuples. */
export const ARGS: { [M in CodeBotMethod]: z.ZodType<Parameters<CodeBotApi[M]>> } = {
  appInfo: z.tuple([]),
  getSettings: z.tuple([]),
  updateSettings: z.tuple([settings.partial()]),
  checkEngines: z.tuple([]),
  listBots: z.tuple([]),
  createBot: z.tuple([botInputSchema]),
  updateBot: z.tuple([id, botInputSchema.partial().extend({ subagents: subagents.partial().optional() })]) as never,
  archiveBot: z.tuple([id]),
  getThread: z.tuple([id, after]),
  sendToBot: z.tuple([id, text]),
  newConversation: z.tuple([id]),
  listConversations: z.tuple([id, z.object({ archived: z.boolean().optional() }).optional()]),
  getConversation: z.tuple([id, id, after]),
  reopenConversation: z.tuple([id, id]),
  setConversationArchived: z.tuple([id, id, z.boolean()]),
  stopBot: z.tuple([id]),
  listTasks: z.tuple([
    z
      .object({ botId: id.optional(), limit: z.number().int().min(1).max(500).optional(), archived: z.boolean().optional() })
      .optional(),
  ]),
  getTask: z.tuple([id, after]),
  sendToTask: z.tuple([id, text]),
  cancelTask: z.tuple([id]),
  setTaskArchived: z.tuple([id, z.boolean(), z.object({ discardChanges: z.boolean().optional() }).optional()]),
  getBranchStatus: z.tuple([id]),
  mergeBranch: z.tuple([id]),
  openPullRequest: z.tuple([id]),
  listRequests: z.tuple([]),
  respond: z.tuple([id, id, userResponse]),
  getUsage: z.tuple([]),
  checkUsage: z.tuple([]),
  listRoutines: z.tuple([]),
  createRoutine: z.tuple([routineInputSchema]),
  updateRoutine: z.tuple([id, routineInputSchema.partial()]),
  deleteRoutine: z.tuple([id]),
  runRoutine: z.tuple([id]),
  acceptRoutineProposal: z.tuple([id, id]),
  dismissRoutineProposal: z.tuple([id, id]),
  checkFolders: z.tuple([z.array(text).max(20)]),
  pickFolders: z.tuple([]),
  openExternal: z.tuple([text]),
  openPath: z.tuple([text]),
  notify: z.tuple([z.object({ title: text.max(200), body: text.max(2000), botId: id.optional() })]),
  signIn: z.tuple([id]),
  openInTerminal: z.tuple([id]),
  getUpdate: z.tuple([]),
  checkForUpdate: z.tuple([]),
  installUpdate: z.tuple([]),
};

/** Operations only the desktop app can carry out: they open windows, dialogs or terminals, or update the app. */
export const DESKTOP_ONLY = [
  'pickFolders',
  'openExternal',
  'openPath',
  'notify',
  'signIn',
  'openInTerminal',
  'getUpdate',
  'checkForUpdate',
  'installUpdate',
] as const satisfies readonly CodeBotMethod[];

export type DesktopMethod = (typeof DESKTOP_ONLY)[number];
export type CoreMethod = Exclude<CodeBotMethod, DesktopMethod>;
export type Handlers<M extends CodeBotMethod> = { [K in M]: (...args: Parameters<CodeBotApi[K]>) => unknown };

export function isMethod(name: unknown): name is CodeBotMethod {
  return typeof name === 'string' && Object.hasOwn(ARGS, name);
}

export function isDesktopOnly(method: CodeBotMethod): method is DesktopMethod {
  return (DESKTOP_ONLY as readonly string[]).includes(method);
}

/** Checks a caller's arguments for an operation; a problem is a CodeBotError naming the fields. */
export function parseArgs(method: CodeBotMethod, args: unknown): unknown[] {
  const parsed = ARGS[method].safeParse(args ?? []);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`);
    throw new CodeBotError('invalid', `Invalid arguments for ${method}: ${problems.join('; ')}`);
  }
  return parsed.data as unknown[];
}

/** The operations the core answers by itself, for any front end. */
export function coreHandlers(core: CodeBot, info: AppInfo): Handlers<CoreMethod> {
  return {
    appInfo: () => info,
    getSettings: () => core.getSettings(),
    updateSettings: (patch) => core.updateSettings(patch),
    checkEngines: () => core.checkEngines(),
    listBots: () => core.listBots(),
    createBot: (input) => core.createBot(input),
    updateBot: (botId, patch) => core.updateBot(botId, patch),
    archiveBot: (botId) => core.archiveBot(botId),
    getThread: (botId, from) => core.getThread(botId, from),
    sendToBot: (botId, message) => core.sendToBot(botId, message),
    newConversation: (botId) => core.newConversation(botId),
    listConversations: (botId, options) => core.listConversations(botId, options),
    getConversation: (botId, threadId, from) => core.getConversation(botId, threadId, from),
    reopenConversation: (botId, threadId) => core.reopenConversation(botId, threadId),
    setConversationArchived: (botId, threadId, archived) => core.setConversationArchived(botId, threadId, archived),
    stopBot: (botId) => core.stopBot(botId),
    listTasks: (filter) => core.listTasks(filter),
    getTask: (taskId, from) => core.getTask(taskId, from),
    sendToTask: (taskId, message) => core.sendToTask(taskId, message),
    cancelTask: (taskId) => core.cancelTask(taskId),
    setTaskArchived: (taskId, archived, options) => core.setTaskArchived(taskId, archived, options),
    getBranchStatus: (taskId) => core.getBranchStatus(taskId),
    mergeBranch: (taskId) => core.mergeBranch(taskId),
    openPullRequest: (taskId) => core.openPullRequest(taskId),
    listRequests: () => core.listRequests(),
    respond: (taskId, requestId, response) => core.respond(taskId, requestId, response),
    getUsage: () => core.getUsage(),
    checkUsage: () => core.checkUsage(),
    listRoutines: () => core.listRoutines(),
    createRoutine: (input) => core.createRoutine(input),
    updateRoutine: (routineId, patch) => core.updateRoutine(routineId, patch),
    deleteRoutine: (routineId) => core.deleteRoutine(routineId),
    runRoutine: (routineId) => core.runRoutine(routineId),
    acceptRoutineProposal: (botId, proposalId) => core.acceptRoutineProposal(botId, proposalId),
    dismissRoutineProposal: (botId, proposalId) => core.dismissRoutineProposal(botId, proposalId),
    checkFolders: (paths) => core.checkFolders(paths),
  };
}

/** Validates and runs one operation with the given handlers. */
export async function callOperation(handlers: Partial<Handlers<CodeBotMethod>>, method: unknown, args: unknown): Promise<unknown> {
  if (!isMethod(method)) throw new CodeBotError('not_found', `Unknown operation "${String(method)}"`);
  const handler = handlers[method] as ((...values: unknown[]) => unknown) | undefined;
  if (!handler) {
    throw new CodeBotError('not_found', isDesktopOnly(method) ? `${method} only works in the desktop app` : `Unknown operation "${method}"`);
  }
  return await handler(...parseArgs(method, args));
}
