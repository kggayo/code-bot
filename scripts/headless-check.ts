/**
 * Drives the real `code-bot` command (bin/code-bot.cjs) as separate processes,
 * with scripted models in a temporary data folder: no model usage.
 *
 *   node scripts/headless-check.ts          Windows, Linux, macOS
 *   node scripts/headless-check.ts --tmux   also the tmux layout (needs tmux)
 *
 * Steps: a bot is imported; `code-bot chat` starts the server in the
 * background; the main bot routes to the project bot, whose sub-agent's
 * approval is answered with /allow and whose report comes back; status,
 * export while running, stop. With --tmux: `code-bot panes` builds a session
 * with a pane per bot, a message typed into the main bot's pane is answered.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const launcher = join(root, 'bin', 'code-bot.cjs');
const withTmux = process.argv.includes('--tmux');
const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'code-bot-headless-check-')));
const userData = join(dir, 'data-folder');
const project = join(dir, 'web');
mkdirSync(project, { recursive: true });
const env = { ...process.env, CODE_BOT_FAKE_MODELS: '1', CODE_BOT_PORT: '0', NO_COLOR: '1' };
let step = 0;

function ok(what: string): void {
  step += 1;
  console.log(`ok ${step} - ${what}`);
}

function codeBot(args: string[], input?: string): { status: number | null; out: string } {
  const result = spawnSync(process.execPath, [launcher, ...args, '--data', userData], { env, encoding: 'utf8', input, timeout: 60_000 });
  return { status: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function expect(condition: unknown, message: string, detail = ''): void {
  if (!condition) throw new Error(`${message}${detail ? `\n${detail}` : ''}`);
}

async function until(check: () => boolean, what: string, detail: () => string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}\n${detail()}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function main(): Promise<void> {
  // A bot, as `code-bot export` would write it on another machine.
  const exported = join(dir, 'bots.json');
  writeFileSync(
    exported,
    JSON.stringify({
      codeBot: '0.5.0',
      exportedAt: new Date().toISOString(),
      platform: 'win32',
      mainBot: { model: null, effort: null, instructions: '' },
      bots: [
        {
          name: 'web',
          description: 'The web shop',
          folders: ['C:\\src\\web'],
          instructions: '',
          model: null,
          effort: null,
          subagents: {
            engine: 'mock',
            model: null,
            effort: null,
            permissionMode: 'acceptEdits',
            isolation: 'shared',
            worktreeFiles: [],
            maxTurns: null,
            maxBudgetUsd: null,
            mcpServers: [],
          },
        },
      ],
      routines: [],
    }),
  );

  const notRunning = codeBot(['status']);
  expect(notRunning.status === 3 && /not running/.test(notRunning.out), 'status before start', notRunning.out);
  ok('status says it is not running');

  const imported = codeBot(['import', exported, '--map', `C:\\src=${dir}`]);
  expect(imported.status === 0 && /created\s+web/.test(imported.out), 'import', imported.out);
  expect(/Starting code-bot in the background/.test(imported.out), 'import started the server', imported.out);
  ok('import maps the folder and starts the server in the background');

  const chat = spawn(process.execPath, [launcher, 'chat', '--data', userData], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let transcript = '';
  chat.stdout.on('data', (chunk: Buffer) => (transcript += chunk.toString('utf8')));
  chat.stderr.on('data', (chunk: Buffer) => (transcript += chunk.toString('utf8')));
  const closed = new Promise<number | null>((resolve) => chat.once('exit', resolve));
  const shown = () => transcript;
  await until(() => transcript.includes('code-bot · main bot'), 'the chat to open', shown);
  chat.stdin.write('@web task: needs permission to test\n');
  await until(() => transcript.includes('[1] Approval needed'), 'the approval card', shown);
  expect(/\$ npm test/.test(transcript), 'the card shows the command', transcript);
  ok('a sub-agent\'s approval shows in the main bot\'s chat');
  chat.stdin.write('/allow 1\n');
  await until(() => /web reports: t_[0-9a-f]{10} finished/.test(transcript), 'the report', shown);
  ok('/allow answers it, and the project bot\'s report reaches the main bot');
  chat.stdin.write('/subagents\n');
  await until(() => /t_[0-9a-f]{10} {2}done/.test(transcript), 'the sub-agent list', shown);
  chat.stdin.write('/quit\n');
  const code = await closed;
  expect(code === 0, `chat exit code ${code}`, transcript);
  ok('/subagents lists it; /quit leaves the chat');

  const status = codeBot(['status']);
  expect(status.status === 0 && /is running/.test(status.out) && /web/.test(status.out), 'status while running', status.out);
  ok('code-bot keeps running after the chat closes');

  const out = join(dir, 'export.json');
  const exportRun = codeBot(['export', out]);
  expect(exportRun.status === 0 && existsSync(out), 'export while running', exportRun.out);
  const file = JSON.parse(readFileSync(out, 'utf8')) as { bots: { name: string; folders: string[] }[] };
  expect(file.bots.length === 1 && file.bots[0]?.name === 'web', 'the export has the bot', JSON.stringify(file));
  ok('export reads the database while the server has it open');

  if (withTmux) {
    const session = `code-bot-check-${process.pid}`;
    try {
      const panes = codeBot(['panes', '--detached', '--session', session]);
      expect(panes.status === 0, 'code-bot panes', panes.out);
      const list = () => spawnSync('tmux', ['list-panes', '-s', '-t', `=${session}`, '-F', '#{pane_id} #{pane_title}'], { encoding: 'utf8' }).stdout;
      await until(() => /main bot · idle/.test(list()) && /web · idle/.test(list()), 'pane titles from the chats', list);
      ok('code-bot panes opens a pane per bot, titled by each chat');
      const mainPane = (/^(%\d+) main bot/m.exec(list()) ?? [])[1];
      expect(mainPane, 'the main bot\'s pane', list());
      spawnSync('tmux', ['send-keys', '-t', mainPane as string, 'hello from tmux', 'Enter']);
      const screen = () => spawnSync('tmux', ['capture-pane', '-p', '-t', mainPane as string], { encoding: 'utf8' }).stdout;
      await until(() => screen().includes('echo: hello from tmux'), 'the reply in the pane', screen);
      ok('a message typed into the main bot\'s pane is answered there');
    } finally {
      spawnSync('tmux', ['kill-session', '-t', `=${session}`]);
    }
  }

  const stopped = codeBot(['stop']);
  expect(stopped.status === 0 && /stopped/.test(stopped.out), 'stop', stopped.out);
  expect(!existsSync(join(userData, 'data', 'instance.json')), 'the lock is gone after stop');
  ok('stop ends it and frees the data folder');
}

main()
  .then(() => {
    console.log(`headless check passed (${step} steps)`);
    rmSync(dir, { recursive: true, force: true });
  })
  .catch((error: unknown) => {
    console.error(`not ok ${step + 1} - ${error instanceof Error ? error.message : String(error)}`);
    spawnSync(process.execPath, [launcher, 'stop', '--force', '--data', userData], { env, stdio: 'ignore', timeout: 30_000 });
    console.error(`log: ${join(userData, 'data', 'server.log')}`);
    process.exit(1);
  });
