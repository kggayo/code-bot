/**
 * `code-bot service install` for real, in a temporary data folder, then
 * removed again: systemd for this user on Linux (needs systemd, e.g. WSL with
 * systemd=true), the Startup folder on Windows. Refuses to run when a code-bot
 * service is already installed for this user, so it never replaces a real one.
 * No model usage: nothing is sent to a bot.
 *
 *   node scripts/service-check.ts
 *
 * Steps: install starts code-bot; killing its process brings it back (crash
 * restart); `code-bot stop` stops it for good (no restart); uninstall removes it.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startupFolder, unitPath } from '../src/headless/service.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const launcher = join(root, 'bin', 'code-bot.cjs');
const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'code-bot-service-check-')));
const userData = join(dir, 'data-folder');
const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
const installed = process.platform === 'win32' ? join(startupFolder(), 'code-bot.vbs') : unitPath();
let step = 0;

function ok(what: string): void {
  step += 1;
  console.log(`ok ${step} - ${what}`);
}

function codeBot(args: string[]): { status: number | null; out: string } {
  const result = spawnSync(process.execPath, [launcher, ...args, '--data', userData], { env, encoding: 'utf8', timeout: 120_000 });
  return { status: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function expect(condition: unknown, message: string, detail = ''): void {
  if (!condition) throw new Error(`${message}${detail ? `\n${detail}` : ''}`);
}

function serverPid(): number | null {
  try {
    const info = JSON.parse(readFileSync(join(userData, 'data', 'instance.json'), 'utf8')) as { pid: number; kind: string; port: number | null };
    return info.kind === 'server' && info.port ? info.pid : null;
  } catch {
    return null;
  }
}

async function until(check: () => boolean, what: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const running = () => codeBot(['status']).status === 0;

async function main(): Promise<void> {
  expect(!existsSync(installed), `A code-bot service is already installed for this user (${installed}); this check will not replace it.`);
  const install = codeBot(['service', 'install', '--tz', 'Asia/Manila', '--port', '0']);
  expect(install.status === 0, 'service install', install.out);
  console.log(install.out.trim().replace(/^/gm, '    '));
  await until(running, 'the service to start');
  const first = serverPid();
  expect(first, 'the server\'s process');
  if (process.platform === 'win32') {
    const log = join(userData, 'data', 'server.log');
    await until(() => existsSync(log) && /is listening/.test(readFileSync(log, 'utf8')), 'its log in server.log', 10_000);
  }
  ok(`installed; code-bot runs as a service (process ${first})${process.platform === 'win32' ? ', logging to server.log' : ''}`);

  // A crash: the service starts it again.
  if (process.platform === 'win32') spawnSync('taskkill', ['/F', '/PID', String(first)]);
  else process.kill(first as number, 'SIGKILL');
  await until(() => {
    const pid = serverPid();
    return pid !== null && pid !== first && running();
  }, 'a restart after the crash', 90_000);
  ok(`after its process was killed it started again (process ${serverPid()})`);

  const stopped = codeBot(['stop', '--force']);
  expect(stopped.status === 0, 'stop', stopped.out);
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  expect(!running(), 'still stopped 10 seconds after code-bot stop', codeBot(['status']).out);
  if (process.platform === 'linux') {
    const active = spawnSync('systemctl', ['--user', 'is-active', 'code-bot.service'], { encoding: 'utf8' }).stdout.trim();
    expect(active !== 'active', `systemd says ${active}`);
  }
  ok('code-bot stop stops it for good: no restart');
}

main()
  .then(() => console.log(`service check passed (${step} steps)`))
  .catch((error: unknown) => {
    console.error(`not ok ${step + 1} - ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => {
    codeBot(['stop', '--force']);
    const removed = codeBot(['service', 'uninstall']);
    console.log(removed.out.trim().replace(/^/gm, '    '));
    if (existsSync(installed)) {
      console.error(`not removed: ${installed}`);
      process.exitCode = 1;
    } else {
      console.log('    the service is uninstalled again');
    }
    rmSync(dir, { recursive: true, force: true });
  });
