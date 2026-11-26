import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, app, dialog, nativeTheme, session } from 'electron';
import { ClaudeBrain } from '../../core/brain.ts';
import type { Brain } from '../../core/brain.ts';
import { CodeBot } from '../../core/code-bot.ts';
import { ClaudeEngine, bundledClaudeExecutable } from '../../core/engines/claude.ts';
import { CodexEngine } from '../../core/engines/codex.ts';
import { MockEngine } from '../../core/engines/mock.ts';
import type { Engine } from '../../core/engines/types.ts';
import { ScriptedBrain } from '../../core/scripted-brain.ts';
import { Store } from '../../core/store.ts';
import { IPC, MAIN_BOT_ID } from '../../shared/types.ts';
import type { AppInfo, CoreEvent } from '../../shared/types.ts';
import { resetBadge, showWaiting } from './badge.ts';
import { registerIpc } from './ipc.ts';
import { Updater } from './updates.ts';

/**
 * The Electron main process. It hosts the whole orchestrator (bots, sub-agents,
 * database) and opens one window. The window only talks to it over IPC.
 *
 * Environment variables:
 *   CODE_BOT_USER_DATA          data folder instead of the OS default (tests)
 *   CODE_BOT_FAKE_MODELS=1      scripted bots and mock sub-agents: no model usage
 *   CODE_BOT_ENABLE_MOCK_ENGINE=1  offer the mock engine next to Claude Code
 *   CODE_BOT_CLAUDE_EXECUTABLE  Claude Code binary to use instead of the bundled one
 *   CODE_BOT_CODEX_EXECUTABLE   Codex binary to use instead of codex on the PATH
 *   CODE_BOT_NO_QUIT_PROMPT=1   quit without asking even when sub-agents are working
 *   CODE_BOT_NO_UPDATE_CHECK=1  never look for a newer release by itself
 *   CODE_BOT_UPDATE_FEED        a localhost address to ask for the newest release instead of GitHub (update checks)
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const fakeModels = process.env.CODE_BOT_FAKE_MODELS === '1';
const UPDATE_FIRST_CHECK_MS = 15_000;
const UPDATE_CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

if (process.env.CODE_BOT_USER_DATA) app.setPath('userData', resolve(process.env.CODE_BOT_USER_DATA));

let window: BrowserWindow | undefined;
let core: CodeBot | undefined;
let store: Store | undefined;
let allowClose = false;
let shutDown = false;

/**
 * The Claude Code binary. In a packaged app the SDK's copy sits inside
 * app.asar, where it cannot run; electron-builder unpacks it next to it.
 */
function claudeExecutable(): string | undefined {
  const override = process.env.CODE_BOT_CLAUDE_EXECUTABLE?.trim();
  if (override) return override;
  const bundled = bundledClaudeExecutable();
  if (!bundled || !app.isPackaged) return bundled;
  const unpacked = bundled.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
  return existsSync(unpacked) ? unpacked : undefined;
}

/**
 * The window icon. Linux needs it set explicitly. On Windows the .ico with every
 * size is given too, so the taskbar picks the size it draws at (24, 30, 36, 48 px
 * for 100-200 % scaling) instead of shrinking a larger one into a blur.
 */
function windowIcon(): string | undefined {
  const name = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  const icon = app.isPackaged ? join(process.resourcesPath, name) : join(here, '../../build', name);
  return existsSync(icon) ? icon : undefined;
}

/** Questions and approvals waiting for the user, across all bots. */
function waitingCount(): number {
  return core?.listBots().reduce((sum, bot) => sum + bot.status.needsYou, 0) ?? 0;
}

let badgeTimer: ReturnType<typeof setTimeout> | undefined;
function refreshBadge(): void {
  if (badgeTimer) return;
  badgeTimer = setTimeout(() => {
    badgeTimer = undefined;
    showWaiting(window && !window.isDestroyed() ? window : undefined, waitingCount());
  }, 150);
}

function focusWindow(): void {
  if (!window || window.isDestroyed()) {
    window = createWindow();
    return;
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function confirmStop(parent?: BrowserWindow): boolean {
  const active = core?.activeSubagents() ?? 0;
  if (active === 0 || process.env.CODE_BOT_NO_QUIT_PROMPT === '1') return true;
  const options: Electron.MessageBoxSyncOptions = {
    type: 'question',
    buttons: ['Quit', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: `${active} sub-agent${active === 1 ? ' is' : 's are'} still working`,
    detail: 'Quitting stops them. Each one can be resumed later by sending it a message.',
  };
  const choice = parent ? dialog.showMessageBoxSync(parent, options) : dialog.showMessageBoxSync(options);
  return choice === 0;
}

function createWindow(): BrowserWindow {
  const created = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'code-bot',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#15171c' : '#f4f5f7',
    autoHideMenuBar: true,
    icon: process.platform === 'darwin' ? undefined : windowIcon(),
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  created.once('ready-to-show', () => {
    created.show();
    resetBadge();
    refreshBadge();
  });
  // A flashing taskbar button asks for attention; looking at the window stops it.
  created.on('focus', () => created.flashFrame(false));

  // The window never navigates and never opens other windows; web links go to the default browser.
  created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  created.webContents.on('will-navigate', (event, url) => {
    if (url !== created.webContents.getURL()) event.preventDefault();
  });

  // On macOS closing the window keeps the app (and its sub-agents) running.
  created.on('close', (event) => {
    if (process.platform === 'darwin' || allowClose) return;
    if (!confirmStop(created)) {
      event.preventDefault();
      return;
    }
    allowClose = true;
  });

  if (process.env.ELECTRON_RENDERER_URL) void created.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void created.loadFile(join(here, '../renderer/index.html'));
  return created;
}

function start(): void {
  app.setAppUserModelId('com.code-bot.desktop');
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  const userData = app.getPath('userData');
  const dataDir = join(userData, 'data');
  store = new Store(dataDir);
  const executable = claudeExecutable();
  // Sub-agent engines: Claude Code (the default for new projects) and Codex. Codex is offered even when
  // it is not installed; a project that picks it then sees why it cannot run in the banner.
  const engines: Engine[] = fakeModels ? [new MockEngine()] : [new ClaudeEngine({ executable }), new CodexEngine()];
  if (!fakeModels && process.env.CODE_BOT_ENABLE_MOCK_ENGINE === '1') engines.push(new MockEngine());
  const brain: Brain = fakeModels ? new ScriptedBrain() : new ClaudeBrain({ executable });
  core = new CodeBot({
    store,
    engines,
    brain,
    workDir: join(userData, 'main-bot'),
    worktreeDir: join(userData, 'worktrees'),
  });

  const info: AppInfo = {
    version: app.getVersion(),
    dataDir,
    platform: process.platform,
    fakeModels,
    engines: engines.map((engine) => engine.id),
  };
  const send = (event: CoreEvent) => {
    if (window && !window.isDestroyed()) window.webContents.send(IPC.event, event);
  };
  const updater = new Updater({
    changed: (update) => send({ scope: 'app', id: 'app', botId: MAIN_BOT_ID, seq: 0, ts: new Date().toISOString(), type: 'update', data: update }),
    quitToInstall: () => {
      if (!confirmStop(window && !window.isDestroyed() ? window : undefined)) return false;
      allowClose = true;
      setImmediate(() => app.quit());
      return true;
    },
    restart: (execPath) => {
      if (!confirmStop(window && !window.isDestroyed() ? window : undefined)) return false;
      allowClose = true;
      app.relaunch({ execPath, args: process.argv.slice(1) });
      setImmediate(() => app.quit());
      return true;
    },
  });
  registerIpc({
    core,
    info,
    updater,
    homeDir: homedir(),
    window: () => (window && !window.isDestroyed() ? window : undefined),
    focusBot: (botId) => {
      focusWindow();
      window?.webContents.send(IPC.focusBot, botId);
    },
  });
  core.subscribe((event) => {
    send(event);
    if (event.scope === 'bot' && event.type === 'status') refreshBadge();
    // Something needs the user while they look elsewhere: flash the taskbar button.
    if (event.scope === 'thread' && event.type === 'request.surfaced' && window && !window.isDestroyed() && !window.isFocused()) {
      window.flashFrame(true);
    }
  });

  window = createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) window = createWindow();
  });

  // Look for a newer release now and then (not in demo mode or tests: they stay off the network).
  if (!fakeModels && process.env.CODE_BOT_NO_UPDATE_CHECK !== '1') {
    const check = () => void updater.check();
    setTimeout(check, UPDATE_FIRST_CHECK_MS).unref();
    setInterval(check, UPDATE_CHECK_EVERY_MS).unref();
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => focusWindow());

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', (event) => {
    if (shutDown || !core) return;
    if (process.platform === 'darwin' && !allowClose && !confirmStop()) {
      event.preventDefault();
      return;
    }
    // Stop bots and sub-agents cleanly (they stay resumable), then quit for real.
    event.preventDefault();
    allowClose = true;
    void core
      .shutdown()
      .catch((error) => console.error('code-bot: shutdown failed:', error))
      .finally(() => {
        store?.close();
        shutDown = true;
        app.quit();
      });
  });

  app
    .whenReady()
    .then(start)
    .catch((error) => {
      dialog.showErrorBox('code-bot could not start', error instanceof Error ? error.message : String(error));
      app.exit(1);
    });
}
