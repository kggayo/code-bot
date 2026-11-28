import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { BotView } from '../shared/types.ts';
import type { TerminalLaunch } from './chat.ts';
import { selfCommand } from './daemon.ts';

/**
 * `code-bot panes`: one terminal pane per bot, the main bot first. tmux where
 * it exists (Linux, WSL, macOS), Windows Terminal on Windows. Every pane runs
 * `code-bot chat <bot>`, a client of the one server, so closing panes or
 * detaching changes nothing in code-bot.
 */

export const SESSION = 'code-bot';
/** Project bots beside the main bot in the first window, and per window after that. */
const FIRST_WINDOW = 3;
const PER_WINDOW = 4;

export function onPath(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const extensions = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = join(dir, `${name}${extension.toLowerCase()}`);
      if (existsSync(candidate)) return candidate;
      const upper = join(dir, `${name}${extension}`);
      if (existsSync(upper)) return upper;
    }
  }
  return undefined;
}

/** Single-quotes a value for a POSIX shell (tmux runs pane commands through one). */
export function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function chatCommand(bot: BotView, userData: string | undefined): string[] {
  const { command, args } = selfCommand(['chat', bot.id, ...(userData ? ['--data', userData] : [])]);
  return [command, ...args];
}

function label(bot: BotView): string {
  return bot.kind === 'main' ? 'main bot' : bot.name;
}

/** The bots in pane order: the main bot, then project bots by name, grouped into windows. */
export function groupBots(bots: BotView[]): BotView[][] {
  const main = bots.filter((bot) => bot.kind === 'main');
  const projects = bots.filter((bot) => bot.kind !== 'main');
  const windows: BotView[][] = [[...main, ...projects.slice(0, FIRST_WINDOW)]];
  for (let start = FIRST_WINDOW; start < projects.length; start += PER_WINDOW) windows.push(projects.slice(start, start + PER_WINDOW));
  return windows;
}

function tmux(args: string[]): string {
  const result = spawnSync('tmux', args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`tmux ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout;
}

function hasSession(session: string): boolean {
  return spawnSync('tmux', ['has-session', '-t', `=${session}`], { stdio: 'ignore' }).status === 0;
}

export interface PanesOptions {
  bots: BotView[];
  /** Passed to every pane when code-bot runs on another data folder than the default. */
  userData?: string;
  rebuild?: boolean;
  /** Build the layout but do not attach (scripts). */
  detached?: boolean;
  session?: string;
}

/** Builds (or reuses) the tmux session and attaches to it. Resolves when the user detaches. */
export async function tmuxPanes(options: PanesOptions): Promise<string> {
  const session = options.session ?? SESSION;
  if (options.rebuild && hasSession(session)) tmux(['kill-session', '-t', `=${session}`]);
  if (!hasSession(session)) {
    const windows = groupBots(options.bots);
    for (const [index, group] of windows.entries()) {
      const name = index === 0 ? 'bots' : `bots-${index + 1}`;
      const [first, ...rest] = group;
      if (!first) continue;
      const command = chatCommand(first, options.userData).map(shellQuote).join(' ');
      const pane =
        index === 0
          ? tmux(['new-session', '-d', '-P', '-F', '#{pane_id}', '-s', session, '-n', name, '-x', '200', '-y', '50', command]).trim()
          : tmux(['new-window', '-d', '-P', '-F', '#{pane_id}', '-t', `=${session}:`, '-n', name, command]).trim();
      tmux(['select-pane', '-t', pane, '-T', label(first)]);
      for (const bot of rest) {
        const split = tmux(['split-window', '-d', '-P', '-F', '#{pane_id}', '-t', pane, chatCommand(bot, options.userData).map(shellQuote).join(' ')]).trim();
        tmux(['select-pane', '-t', split, '-T', label(bot)]);
      }
      // The main bot takes the left half; its project bots stack on the right. Later windows are tiled.
      tmux(['select-layout', '-t', pane, index === 0 ? 'main-vertical' : 'tiled']);
      if (index === 0 && rest.length) tmux(['resize-pane', '-t', pane, '-x', '50%']);
    }
    tmux(['set-option', '-t', session, 'pane-border-status', 'top']);
    tmux(['set-option', '-t', session, 'pane-border-format', ' #{pane_title} ']);
    tmux(['set-option', '-t', session, 'mouse', 'on']);
    tmux(['select-window', '-t', `=${session}:bots`]);
  }
  if (options.detached) return `tmux session "${session}"`;
  const inside = Boolean(process.env.TMUX);
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tmux', inside ? ['switch-client', '-t', `=${session}`] : ['attach-session', '-t', `=${session}`], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', () => resolve());
  });
  return `tmux session "${session}"`;
}

/** One Windows Terminal window: the main bot and up to three project bots split beside it, more bots in further tabs. */
export async function windowsTerminalPanes(options: PanesOptions): Promise<string> {
  const wt = onPath('wt');
  if (!wt) throw new Error('Windows Terminal (wt.exe) was not found. Open a terminal per bot with "code-bot chat <bot>".');
  const args: string[] = ['-w', 'code-bot'];
  for (const [index, group] of groupBots(options.bots).entries()) {
    for (const [position, bot] of group.entries()) {
      if (args.length > 2) args.push(';');
      if (position === 0) args.push('new-tab', '--title', label(bot));
      else args.push('split-pane', position === 1 ? '-V' : '-H', '--title', label(bot));
      args.push(...chatCommand(bot, options.userData));
    }
    if (index === 0) args.push(';', 'focus-pane', '-t', '0');
  }
  const child = spawn(wt, args, { detached: true, stdio: 'ignore' });
  child.unref();
  return 'Windows Terminal';
}

export async function openPanes(options: PanesOptions & { tool?: 'tmux' | 'wt' }): Promise<string> {
  const tool = options.tool ?? (onPath('tmux') ? 'tmux' : process.platform === 'win32' && onPath('wt') ? 'wt' : undefined);
  if (tool === 'tmux') return tmuxPanes(options);
  if (tool === 'wt') return windowsTerminalPanes(options);
  const lines = options.bots.map((bot) => `  ${chatCommand(bot, options.userData).map(shellQuote).join(' ')}`);
  throw new Error(`Neither tmux nor Windows Terminal is installed. Open one terminal per bot:\n${lines.join('\n')}`);
}

/**
 * Continues a sub-agent's session where the user is: a new tmux window when
 * this terminal is inside tmux, a new Windows Terminal tab on Windows. Null
 * when there is neither; the caller prints the command instead.
 */
export async function openTerminal(launch: TerminalLaunch): Promise<string | null> {
  if (process.env.TMUX) {
    tmux(['new-window', '-c', launch.cwd, [launch.command, ...launch.args].map(shellQuote).join(' ')]);
    return 'a new tmux window';
  }
  if (process.platform === 'win32' && process.env.WT_SESSION) {
    const wt = onPath('wt');
    if (wt) {
      spawn(wt, ['-w', '0', 'new-tab', '-d', launch.cwd, launch.command, ...launch.args], { detached: true, stdio: 'ignore' }).unref();
      return 'a new Windows Terminal tab';
    }
  }
  return null;
}
