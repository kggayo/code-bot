/**
 * The `code-bot` command with real models: Claude haiku at low effort for the
 * bots and the sub-agent, in a temporary data folder. Uses model usage on the
 * Claude login of this user; needs Claude Code signed in (`code-bot login claude`).
 *
 *   node scripts/headless-live-check.ts
 *
 * Steps: the sign-in is checked; a project bot is imported; through
 * `code-bot chat`, the main bot asks the project bot something only its
 * CLAUDE.md says; then a sub-agent runs a command after an approval answered
 * with /allow in the main bot's chat, and its output comes back as the report.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const launcher = join(root, 'bin', 'code-bot.cjs');
const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'code-bot-headless-live-')));
const userData = join(dir, 'data-folder');
const project = join(dir, 'shop');
mkdirSync(project, { recursive: true });
writeFileSync(join(project, 'CLAUDE.md'), '# shop\n\nThe code word for this project is PELICAN-42.\n');
const env: NodeJS.ProcessEnv = { ...process.env, CODE_BOT_PORT: '0', NO_COLOR: '1' };
delete env.CODE_BOT_FAKE_MODELS;
const MINUTES = 60_000;
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

async function until(check: () => boolean, what: string, detail: () => string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}\n${detail()}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function main(): Promise<void> {
  const login = codeBot(['login', 'claude']);
  expect(login.status === 0 && /signed in/i.test(login.out), 'Claude Code is not signed in for this user: run code-bot login claude', login.out);
  ok('Claude Code is signed in');

  const exported = join(dir, 'bots.json');
  const cheap = { model: 'haiku', effort: 'low' };
  writeFileSync(
    exported,
    JSON.stringify({
      codeBot: '0.5.0',
      exportedAt: new Date().toISOString(),
      platform: process.platform,
      mainBot: { ...cheap, instructions: '' },
      bots: [
        {
          name: 'shop',
          description: 'A small test project (the shop)',
          folders: [project],
          instructions: '',
          ...cheap,
          subagents: {
            engine: 'claude',
            ...cheap,
            permissionMode: 'acceptEdits',
            isolation: 'shared',
            worktreeFiles: [],
            maxTurns: 10,
            maxBudgetUsd: 1,
            mcpServers: [],
          },
        },
      ],
      routines: [],
    }),
  );
  const imported = codeBot(['import', exported]);
  expect(imported.status === 0 && /created\s+shop/.test(imported.out), 'import', imported.out);
  ok('the project bot is imported and code-bot runs in the background');

  const chat = spawn(process.execPath, [launcher, 'chat', '--data', userData], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let transcript = '';
  chat.stdout.on('data', (chunk: Buffer) => (transcript += chunk.toString('utf8')));
  chat.stderr.on('data', (chunk: Buffer) => (transcript += chunk.toString('utf8')));
  const closed = new Promise<number | null>((resolve) => chat.once('exit', resolve));
  const shown = () => transcript.slice(-4000);
  // What the main bot itself wrote: each "main bot ›" block up to the next heading.
  const mainSaid = () =>
    transcript
      .split('\nmain bot ›\n')
      .slice(1)
      .map((block) => block.split(/\n(?=\S)/)[0] ?? '')
      .join('\n');
  await until(() => transcript.includes('code-bot · main bot'), 'the chat to open', shown, MINUTES);

  chat.stdin.write('Ask the shop project bot what the code word in its CLAUDE.md is, and tell me.\n');
  await until(() => /PELICAN-42/.test(mainSaid()), 'the code word from the main bot', shown, 5 * MINUTES);
  ok('the main bot asked the project bot and relays what its CLAUDE.md says');

  // node -e is not a read-only command, so Claude Code asks before running it (node --version it runs without asking).
  chat.stdin.write(
    'Ask shop to have a sub-agent with normal permissions (not plan mode) run the shell command `node -e "console.log(6*7)"` and report exactly what it printed.\n',
  );
  // Allow that command; decline anything else the sub-agent might try.
  const answered = new Set<string>();
  const deadline = Date.now() + 8 * MINUTES;
  const relayed = () => {
    // From the message sent (the bots' replies repeat the command, so not its last mention).
    const after = transcript.slice(transcript.indexOf('with normal permissions (not plan mode)'));
    return after
      .split('\nmain bot ›\n')
      .slice(1)
      .some((block) => /\b42\b/.test(block.split(/\n(?=\S)/)[0] ?? ''));
  };
  while (!relayed()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for the report\n${shown()}`);
    for (const match of transcript.matchAll(/\[(\d+)\] Approval needed[^\n]*\n([\s\S]*?)\/allow \1/g)) {
      const [, number, body] = match;
      if (!number || answered.has(number)) continue;
      answered.add(number);
      chat.stdin.write(/node\s+-e/.test(body ?? '') ? `/allow ${number}\n` : `/deny ${number} only run the node -e command\n`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  expect(answered.size > 0, 'an approval was asked for in the main bot\'s chat', shown());
  ok('the sub-agent\'s approval came to the main bot\'s chat, /allow answered it, and the output came back');

  chat.stdin.write('/subagents\n');
  await until(() => /t_[0-9a-f]{10} {2}done/.test(transcript), 'the sub-agent list', shown, MINUTES);
  chat.stdin.write('/quit\n');
  expect((await closed) === 0, 'the chat closes', shown());
  const stopped = codeBot(['stop', '--force']);
  expect(stopped.status === 0, 'stop', stopped.out);
  ok('/subagents shows it done; stop ends code-bot');
}

main()
  .then(() => {
    console.log(`headless live check passed (${step} steps)`);
    rmSync(dir, { recursive: true, force: true });
  })
  .catch((error: unknown) => {
    console.error(`not ok ${step + 1} - ${error instanceof Error ? error.message : String(error)}`);
    spawnSync(process.execPath, [launcher, 'stop', '--force', '--data', userData], { env, stdio: 'ignore', timeout: 60_000 });
    console.error(`log: ${join(userData, 'data', 'server.log')}`);
    process.exit(1);
  });
