import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

/**
 * Opens a terminal window that runs one program in a folder, for the user to
 * use interactively (signing in to an agent, continuing a sub-agent's
 * session). Arguments are passed as a list, never through a shell string,
 * except on macOS where Terminal.app only runs scripts.
 */
export interface TerminalLaunch {
  command: string;
  args: string[];
  cwd: string;
}

function onPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function detached(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/** Single-quotes a value for a POSIX shell. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Linux terminal emulators and how each is told to run a program. */
const LINUX_TERMINALS: { name: string; args: (program: string[]) => string[] }[] = [
  { name: 'x-terminal-emulator', args: (program) => ['-e', ...program] },
  { name: 'gnome-terminal', args: (program) => ['--', ...program] },
  { name: 'konsole', args: (program) => ['-e', ...program] },
  { name: 'xfce4-terminal', args: (program) => ['-x', ...program] },
  { name: 'kitty', args: (program) => program },
  { name: 'alacritty', args: (program) => ['-e', ...program] },
  { name: 'wezterm', args: (program) => ['start', '--', ...program] },
  { name: 'xterm', args: (program) => ['-e', ...program] },
];

export async function openTerminal(launch: TerminalLaunch): Promise<void> {
  const { command, args, cwd } = launch;
  if (process.platform === 'win32') {
    // A detached console program gets its own console window (Windows Terminal when that is the default).
    await detached(command, args, cwd);
    return;
  }
  if (process.platform === 'darwin') {
    const dir = mkdtempSync(join(tmpdir(), 'code-bot-terminal-'));
    const script = join(dir, 'continue.command');
    writeFileSync(script, `#!/bin/sh\ncd ${shellQuote(cwd)} || exit 1\nexec ${[command, ...args].map(shellQuote).join(' ')}\n`);
    chmodSync(script, 0o700);
    await detached('open', ['-a', 'Terminal', script], cwd);
    return;
  }
  const preferred = process.env.TERMINAL?.trim();
  const candidates = preferred ? [{ name: preferred, args: (program: string[]) => ['-e', ...program] }, ...LINUX_TERMINALS] : LINUX_TERMINALS;
  for (const terminal of candidates) {
    const path = terminal.name.includes('/') ? terminal.name : onPath(terminal.name);
    if (!path || !existsSync(path)) continue;
    await detached(path, terminal.args([command, ...args]), cwd);
    return;
  }
  throw new Error(
    `No terminal program was found. Run this in a terminal yourself, in ${cwd}:\n${[command, ...args].map(shellQuote).join(' ')}`,
  );
}
