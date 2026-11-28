import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { LOG_FILE, selfCommand } from './daemon.ts';

/**
 * `code-bot service install`: keeps the headless server running as the
 * owner's own OS user, so it uses their checkouts, .env files, git keys and
 * Claude Code / Codex sign-ins as they are (decision 37).
 *
 * Linux: a systemd user unit (restarts after a crash; starts at boot once
 * lingering is on, which needs sudo, so it is printed rather than run).
 * Windows: a hidden start at sign-in from the user's Startup folder, through a
 * small script that restarts code-bot after a crash. A Scheduled Task at
 * sign-in needs administrator rights, and running with nobody signed in needs
 * the Windows password; code-bot never handles either.
 */

export const UNIT_NAME = 'code-bot';

export interface ServiceSetup {
  /** The data folder when it is not the default one. */
  userData?: string;
  port?: number;
  /** The time zone routines run in (an IANA name such as "Asia/Manila"). */
  timeZone?: string;
  path?: string;
}

function serveArgs(setup: ServiceSetup): string[] {
  return ['serve', ...(setup.userData ? ['--data', setup.userData] : []), ...(setup.port === undefined ? [] : ['--port', String(setup.port)])];
}

/** A value for a systemd unit line: quoted when it has spaces, with quotes and backslashes escaped. */
function systemdQuote(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%');
  return /[\s"'\\]/.test(value) ? `"${escaped}"` : escaped;
}

export function systemdUnit(setup: ServiceSetup): string {
  const { command, args } = selfCommand(serveArgs(setup));
  const lines = [
    '[Unit]',
    'Description=code-bot (headless): main bot, project bots and sub-agents',
    'After=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${[command, ...args].map(systemdQuote).join(' ')}`,
    `WorkingDirectory=${systemdQuote(homedir())}`,
    // The agents and the tools they call (git, gh, npx, MCP servers) are found on the PATH of the shell that installed this.
    `Environment=${systemdQuote(`PATH=${setup.path ?? process.env.PATH ?? ''}`)}`,
    ...(setup.timeZone ? [`Environment=${systemdQuote(`TZ=${setup.timeZone}`)}`] : []),
    'Restart=on-failure',
    'RestartSec=5',
    // code-bot stops its bots and sub-agents cleanly (they stay resumable) before it exits.
    'KillMode=mixed',
    'TimeoutStopSec=60',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ];
  return lines.join('\n');
}

export function unitPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user', `${UNIT_NAME}.service`);
}

/**
 * The Windows script that runs code-bot, appending its output to `log`, and
 * starts it again after a crash (not after "code-bot stop").
 */
export function windowsScript(setup: ServiceSetup, log: string): string {
  const { command, args } = selfCommand(serveArgs(setup));
  const quote = (part: string) => `"${part.replace(/"/g, '""')}"`;
  const line = `${[command, ...args].map(quote).join(' ')} >> ${quote(log)} 2>&1`;
  return [
    '@echo off',
    'rem code-bot: started at sign-in by "code-bot service install"; remove with "code-bot service uninstall".',
    ...(setup.timeZone ? [`set "TZ=${setup.timeZone}"`] : []),
    ':start',
    line,
    'if %errorlevel%==0 exit /b 0',
    // Five seconds' pause; "timeout" refuses to run without a console to read from.
    'ping -n 6 127.0.0.1 >nul',
    'goto start',
    '',
  ].join('\r\n');
}

/** Runs a .cmd file without a window (wscript.exe runs this at sign-in). */
export function hiddenStarter(script: string): string {
  return `CreateObject("WScript.Shell").Run """${script.replace(/"/g, '""')}""", 0, False\r\n`;
}

export function startupFolder(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

function run(command: string, args: string[]): { ok: boolean; output: string } {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) return { ok: false, output: result.error.message };
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
}

/** The local time zone, and a warning when it is UTC (an Azure VM's default), since routines run in local time. */
export function timeZoneNote(given: string | undefined): { timeZone: string | undefined; warning: string | null } {
  if (given) return { timeZone: given, warning: null };
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const utc = !zone || /^(Etc\/)?(UTC|UCT|GMT|Universal|Zulu)$/i.test(zone);
  return {
    timeZone: undefined,
    warning: utc
      ? 'This machine runs on UTC, so a routine set for 09:00 runs at 09:00 UTC. Install with --tz <zone> (e.g. --tz Asia/Manila) to use your own time.'
      : null,
  };
}

export interface ServiceResult {
  lines: string[];
}

export function installService(setup: ServiceSetup, dataDir: string): ServiceResult {
  const lines: string[] = [];
  const { timeZone, warning } = timeZoneNote(setup.timeZone);
  if (warning) lines.push(warning);
  if (process.platform === 'win32') {
    mkdirSync(dataDir, { recursive: true });
    const script = join(dataDir, 'code-bot-service.cmd');
    writeFileSync(script, windowsScript({ ...setup, timeZone }, join(dataDir, LOG_FILE)));
    const starter = join(startupFolder(), 'code-bot.vbs');
    writeFileSync(starter, hiddenStarter(script));
    const started = run('wscript.exe', [starter]);
    lines.push(`Starts at sign-in: ${starter}`, `It runs ${script}, which starts code-bot again if it stops with an error.`);
    lines.push(started.ok ? 'Started it now, without a window.' : `Could not start it now: ${started.output}`);
    lines.push(`It runs while you are signed in. Its log: ${join(dataDir, LOG_FILE)}`);
    return { lines };
  }
  if (process.platform !== 'linux') throw new Error('code-bot service install works on Linux (systemd) and Windows. On macOS, run "code-bot serve" in a terminal for now.');
  if (!run('systemctl', ['--user', 'show-environment']).ok) {
    throw new Error('systemd for your user is not available here. In WSL, set "systemd=true" under [boot] in /etc/wsl.conf and restart WSL.');
  }
  const path = unitPath();
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, systemdUnit({ ...setup, timeZone }));
  lines.push(`Wrote ${path}`);
  for (const args of [
    ['--user', 'daemon-reload'],
    ['--user', 'enable', '--now', `${UNIT_NAME}.service`],
  ]) {
    const result = run('systemctl', args);
    if (!result.ok) throw new Error(`systemctl ${args.slice(1).join(' ')} failed: ${result.output}`);
  }
  lines.push('Started it, and it starts again after a crash. Logs: journalctl --user -u code-bot -f');
  const linger = run('loginctl', ['show-user', userInfo().username, '--property=Linger']);
  if (!/Linger=yes/.test(linger.output)) {
    lines.push(
      'It stops when you log out and does not start at boot until lingering is on for your user. Run this once (it needs sudo, so code-bot does not run it):',
      `  sudo loginctl enable-linger ${userInfo().username}`,
    );
  }
  return { lines };
}

export function uninstallService(dataDir: string): ServiceResult {
  const lines: string[] = [];
  if (process.platform === 'win32') {
    const starter = join(startupFolder(), 'code-bot.vbs');
    const script = join(dataDir, 'code-bot-service.cmd');
    for (const file of [starter, script]) {
      if (existsSync(file)) {
        rmSync(file);
        lines.push(`Removed ${file}`);
      }
    }
    lines.push(lines.length ? 'code-bot no longer starts at sign-in. A running code-bot keeps running until "code-bot stop".' : 'code-bot was not set to start at sign-in.');
    return { lines };
  }
  const path = unitPath();
  if (!existsSync(path)) return { lines: ['No code-bot service is installed for your user.'] };
  run('systemctl', ['--user', 'disable', '--now', `${UNIT_NAME}.service`]);
  rmSync(path);
  run('systemctl', ['--user', 'daemon-reload']);
  return { lines: [`Stopped and removed ${path}`] };
}

export function serviceStatus(dataDir: string): ServiceResult {
  if (process.platform === 'win32') {
    const starter = join(startupFolder(), 'code-bot.vbs');
    return {
      lines: [
        existsSync(starter) ? `Starts at sign-in (${starter}).` : 'Not set to start at sign-in.',
        `Script: ${join(dataDir, 'code-bot-service.cmd')}`,
      ],
    };
  }
  const result = run('systemctl', ['--user', 'status', `${UNIT_NAME}.service`, '--no-pager', '--lines=5']);
  return { lines: [result.output || 'No code-bot service is installed for your user.'] };
}
