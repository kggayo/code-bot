import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AppInfo } from '../shared/types.ts';
import { ClaudeBrain } from './brain.ts';
import type { Brain } from './brain.ts';
import { CodeBot } from './code-bot.ts';
import { ClaudeEngine } from './engines/claude.ts';
import { CodexEngine } from './engines/codex.ts';
import { MockEngine } from './engines/mock.ts';
import type { Engine } from './engines/types.ts';
import { ScriptedBrain } from './scripted-brain.ts';
import { Store } from './store.ts';
import { CODE_BOT_VERSION } from './version.ts';

/**
 * Starting the orchestrator, shared by the desktop app (src/desktop/main) and
 * the headless server (src/headless). Both keep their data in the same folder
 * by default, so on one machine they see the same bots (never at the same
 * time: see instance.ts).
 */

export interface CoreSetup {
  /** The data folder: data/code-bot.db, main-bot/ and worktrees/ live in it. */
  userData: string;
  /** Scripted bots and mock sub-agents: no model usage (tests and demos). */
  fakeModels?: boolean;
  /** Offer the mock engine next to the real ones. */
  enableMockEngine?: boolean;
  /** The Claude Code binary; default: the one bundled with the Agent SDK. */
  claudeExecutable?: string;
  version?: string;
}

export interface StartedCore {
  core: CodeBot;
  store: Store;
  engines: Engine[];
  info: AppInfo;
}

export function createCore(setup: CoreSetup): StartedCore {
  const fakeModels = setup.fakeModels ?? false;
  const dataDir = join(setup.userData, 'data');
  const store = new Store(dataDir);
  const executable = setup.claudeExecutable;
  // Sub-agent engines: Claude Code (the default for new projects) and Codex. Codex is offered even when
  // it is not installed; a project that picks it then sees why it cannot run.
  const engines: Engine[] = fakeModels ? [new MockEngine()] : [new ClaudeEngine({ executable }), new CodexEngine()];
  if (!fakeModels && setup.enableMockEngine) engines.push(new MockEngine());
  const brain: Brain = fakeModels ? new ScriptedBrain() : new ClaudeBrain({ executable });
  const core = new CodeBot({
    store,
    engines,
    brain,
    workDir: join(setup.userData, 'main-bot'),
    worktreeDir: join(setup.userData, 'worktrees'),
  });
  const info: AppInfo = {
    version: setup.version ?? CODE_BOT_VERSION,
    dataDir,
    platform: process.platform,
    fakeModels,
    engines: engines.map((engine) => engine.id),
  };
  return { core, store, engines, info };
}

/**
 * The folder the desktop app uses (Electron's userData for "code-bot"), unless
 * CODE_BOT_USER_DATA names another.
 */
export function defaultUserData(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform, home: string = homedir()): string {
  const override = env.CODE_BOT_USER_DATA?.trim();
  if (override) return resolve(override);
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'code-bot');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'code-bot');
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'code-bot');
}
