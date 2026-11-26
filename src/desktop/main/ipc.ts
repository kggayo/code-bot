import { statSync } from 'node:fs';
import { BrowserWindow, Notification, dialog, ipcMain, shell } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import type { CodeBot } from '../../core/code-bot.ts';
import { EFFORTS, IPC, ISOLATIONS, PERMISSION_MODES } from '../../shared/types.ts';
import type { AppInfo, CodeBotApi, CodeBotMethod } from '../../shared/types.ts';
import { openTerminal } from './terminal.ts';
import type { Updater } from './updates.ts';

const text = z.string();
const id = z.string().min(1).max(100);
const after = z.number().int().min(0).optional();
const subagents = z.object({
  engine: z.string().min(1),
  model: z.string().nullable(),
  effort: z.enum(EFFORTS).nullable(),
  permissionMode: z.enum(PERMISSION_MODES),
  isolation: z.enum(ISOLATIONS),
  worktreeFiles: z.array(z.string().max(200)).max(30),
  maxTurns: z.number().int().min(1).max(10_000).nullable(),
  maxBudgetUsd: z.number().positive().max(100_000).nullable(),
});
const settings = z.object({
  maxActiveSubagents: z.number().int().min(1).max(50),
  archiveAfterDays: z.number().int().min(0).max(3650),
  deleteArchivedAfterDays: z.number().int().min(0).max(3650),
});
const botInput = z.object({
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
const routineInput = z.object({
  botId: id,
  title: text.max(200),
  prompt: text.max(20_000),
  schedule: routineSchedule,
  enabled: z.boolean(),
});

/** Argument schemas for every method the renderer may call, as tuples. */
const ARGS: { [M in CodeBotMethod]: z.ZodType<Parameters<CodeBotApi[M]>> } = {
  appInfo: z.tuple([]),
  getSettings: z.tuple([]),
  updateSettings: z.tuple([settings.partial()]),
  checkEngines: z.tuple([]),
  listBots: z.tuple([]),
  createBot: z.tuple([botInput]),
  updateBot: z.tuple([id, botInput.partial().extend({ subagents: subagents.partial().optional() })]) as never,
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
  listRequests: z.tuple([]),
  respond: z.tuple([id, id, userResponse]),
  getUsage: z.tuple([]),
  checkUsage: z.tuple([]),
  listRoutines: z.tuple([]),
  createRoutine: z.tuple([routineInput]),
  updateRoutine: z.tuple([id, routineInput.partial()]),
  deleteRoutine: z.tuple([id]),
  runRoutine: z.tuple([id]),
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

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export interface IpcDeps {
  core: CodeBot;
  info: AppInfo;
  updater: Updater;
  /** Folder a sign-in terminal starts in. */
  homeDir: string;
  window(): BrowserWindow | undefined;
  focusBot(botId: string): void;
}

/** Wires the renderer's calls to the core, validating every argument on the way in. */
export function registerIpc(deps: IpcDeps): void {
  const { core } = deps;

  const handlers: { [M in CodeBotMethod]: (...args: Parameters<CodeBotApi[M]>) => unknown } = {
    appInfo: () => deps.info,
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
    listRequests: () => core.listRequests(),
    respond: (taskId, requestId, response) => core.respond(taskId, requestId, response),
    getUsage: () => core.getUsage(),
    checkUsage: () => core.checkUsage(),
    listRoutines: () => core.listRoutines(),
    createRoutine: (input) => core.createRoutine(input),
    updateRoutine: (routineId, patch) => core.updateRoutine(routineId, patch),
    deleteRoutine: (routineId) => core.deleteRoutine(routineId),
    runRoutine: (routineId) => core.runRoutine(routineId),
    checkFolders: (paths) => core.checkFolders(paths),
    pickFolders: async () => {
      const window = deps.window();
      const options: Electron.OpenDialogOptions = {
        title: 'Choose project folders',
        properties: ['openDirectory', 'multiSelections', 'createDirectory'],
      };
      const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
      return result.canceled ? [] : result.filePaths;
    },
    openExternal: async (url) => {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('Only web links can be opened');
      await shell.openExternal(parsed.toString());
    },
    openPath: async (path) => {
      // Only project folders and sub-agent worktrees: opening an arbitrary file could run it.
      const known =
        core.listBots().some((bot) => bot.folders.includes(path)) ||
        core.listTasks({ limit: 500 }).some((task) => task.worktree?.path === path || task.cwd === path);
      if (!known || !isDirectory(path)) throw new Error('Only project folders can be opened');
      const failure = await shell.openPath(path);
      if (failure) throw new Error(failure);
    },
    notify: (notice) => {
      if (!Notification.isSupported()) return;
      const notification = new Notification({ title: notice.title, body: notice.body.slice(0, 300) });
      notification.on('click', () => {
        if (notice.botId) deps.focusBot(notice.botId);
      });
      notification.show();
    },
    signIn: async (engineId) => {
      const command = await core.signInCommand(engineId);
      await openTerminal({ ...command, cwd: deps.homeDir });
    },
    openInTerminal: async (taskId) => {
      await openTerminal(core.terminalLaunch(taskId));
    },
    getUpdate: () => deps.updater.get(),
    checkForUpdate: () => deps.updater.check(),
    installUpdate: () => deps.updater.install(),
  };

  const trusted = (event: IpcMainInvokeEvent) => {
    const window = deps.window();
    return Boolean(window && event.sender.id === window.webContents.id && event.senderFrame === event.sender.mainFrame);
  };

  ipcMain.handle(IPC.call, async (event, method: unknown, args: unknown) => {
    if (!trusted(event)) throw new Error('Refused a call from an unknown page');
    if (typeof method !== 'string' || !(method in handlers)) throw new Error(`Unknown method "${String(method)}"`);
    const name = method as CodeBotMethod;
    const parsed = ARGS[name].safeParse(args ?? []);
    if (!parsed.success) {
      const problems = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`);
      throw new Error(`Invalid arguments for ${name}: ${problems.join('; ')}`);
    }
    const handler = handlers[name] as (...args: unknown[]) => unknown;
    return await handler(...(parsed.data as unknown[]));
  });
}
