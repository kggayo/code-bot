import { statSync } from 'node:fs';
import { BrowserWindow, Notification, dialog, ipcMain, shell } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import type { CodeBot } from '../../core/code-bot.ts';
import { callOperation, coreHandlers } from '../../core/operations.ts';
import type { DesktopMethod, Handlers } from '../../core/operations.ts';
import { IPC } from '../../shared/types.ts';
import type { AppInfo } from '../../shared/types.ts';
import { openTerminal } from './terminal.ts';
import type { Updater } from './updates.ts';

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

/**
 * Wires the renderer's calls to the core. Arguments are checked by the shared
 * operation table (src/core/operations.ts), the same one the headless server uses;
 * this file adds the operations only the desktop app can carry out.
 */
export function registerIpc(deps: IpcDeps): void {
  const { core } = deps;

  const desktop: Handlers<DesktopMethod> = {
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
  const handlers = { ...coreHandlers(core, deps.info), ...desktop };

  const trusted = (event: IpcMainInvokeEvent) => {
    const window = deps.window();
    return Boolean(window && event.sender.id === window.webContents.id && event.senderFrame === event.sender.mainFrame);
  };

  ipcMain.handle(IPC.call, async (event, method: unknown, args: unknown) => {
    if (!trusted(event)) throw new Error('Refused a call from an unknown page');
    return await callOperation(handlers, method, args);
  });
}
