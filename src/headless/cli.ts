import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as readline from 'node:readline';
import { defaultUserData } from '../core/boot.ts';
import { defaultSubagents } from '../core/code-bot.ts';
import { ClaudeEngine } from '../core/engines/claude.ts';
import { CodexEngine } from '../core/engines/codex.ts';
import type { Engine } from '../core/engines/types.ts';
import { describeInstance, readInstance } from '../core/instance.ts';
import { Store } from '../core/store.ts';
import { errorMessage } from '../core/util.ts';
import { CODE_BOT_VERSION } from '../core/version.ts';
import type { BotInput, BotView } from '../shared/types.ts';
import { Chat } from './chat.ts';
import { findServer } from './client.ts';
import type { Client } from './client.ts';
import { ensureServer, logTail } from './daemon.ts';
import { openPanes, openTerminal } from './panes.ts';
import { clean, paint } from './render.ts';
import { portFrom, runServer } from './serve.ts';
import { installService, serviceStatus, uninstallService } from './service.ts';
import { exportBots, importBots, parseExport, parseMap } from './transfer.ts';

/**
 * The `code-bot` command: the headless server and its terminal client.
 * Run through bin/code-bot.cjs, which checks the Node version first.
 */

const USAGE = `code-bot ${CODE_BOT_VERSION}: a main bot, project bots and their coding sub-agents, on this machine.

  code-bot [chat] [bot]        talk to the main bot (or a project bot); starts code-bot in the background if needed
  code-bot panes [--rebuild]   one pane per bot: tmux (Linux, WSL, macOS) or Windows Terminal
  code-bot status              is it running, and what each bot is doing
  code-bot stop [--force]      stop it (sub-agents stay resumable)
  code-bot serve [--port N]    run it in this terminal (what the service runs)
  code-bot bots                list the bots
  code-bot bot new             create a project bot (opens its settings in your editor)
  code-bot bot edit <bot>      change a bot's settings
  code-bot login claude|codex  sign in to a coding agent, in this terminal (codex: --device-auth without a browser)
  code-bot export <file>       write your bots and routines to a file
  code-bot import <file> [--map FROM=TO ...] [--check]
                               create them here, mapping folders from the other machine
  code-bot service install [--tz <zone>] | uninstall | status
                               keep code-bot running as you (systemd on Linux, sign-in on Windows)

  --data <folder>   another data folder (default: the desktop app's, or CODE_BOT_USER_DATA)
  --port <n>        the port on 127.0.0.1 (default 7413, or CODE_BOT_PORT)
`;

const BOOLEAN = new Set(['force', 'rebuild', 'detached', 'check', 'help', 'version', 'fake-models', 'device-auth']);

export interface Parsed {
  positional: string[];
  flags: Map<string, string | true>;
  lists: Map<string, string[]>;
}

export function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const lists = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? '';
    if (arg === '--') {
      positional.push(...argv.slice(index + 1));
      break;
    }
    if (arg === '-h') {
      flags.set('help', true);
      continue;
    }
    const match = /^--([a-z][a-z-]*)(?:=(.*))?$/.exec(arg);
    if (!match) {
      positional.push(arg);
      continue;
    }
    const name = match[1] ?? '';
    let value: string | true;
    if (match[2] !== undefined) value = match[2];
    else if (BOOLEAN.has(name)) value = true;
    else {
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`--${name} needs a value`);
      value = next;
      index++;
    }
    flags.set(name, value);
    if (typeof value === 'string') lists.set(name, [...(lists.get(name) ?? []), value]);
  }
  return { positional, flags, lists };
}

function flag(parsed: Parsed, name: string): string | undefined {
  const value = parsed.flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

function interactive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function colour(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
}

function confirm(question: string): Promise<boolean> {
  if (!interactive()) return Promise.resolve(false);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((done) => {
    rl.question(`${question} (y/N) `, (answer) => {
      rl.close();
      done(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

interface Context {
  userData: string;
  /** Given with --data: passed on to panes and services. */
  explicitData: string | undefined;
  port: number | undefined;
  out: (line?: string) => void;
}

async function connect(context: Context): Promise<Client> {
  return ensureServer(context.userData, {
    port: context.port,
    onStart: () => process.stderr.write(`Starting code-bot in the background (data: ${context.userData})…\n`),
  });
}

function findBot(bots: BotView[], ref: string): BotView {
  const wanted = ref.toLowerCase();
  const bot =
    bots.find((candidate) => candidate.id === ref || candidate.name.toLowerCase() === wanted) ??
    (wanted === 'main' ? bots.find((candidate) => candidate.kind === 'main') : undefined);
  if (!bot) throw new Error(`No bot called "${ref}". The bots are: ${bots.map((candidate) => (candidate.kind === 'main' ? 'main' : candidate.name)).join(', ')}`);
  return bot;
}

function botLines(bots: BotView[]): string[] {
  const p = paint(colour());
  return bots.map((bot) => {
    const s = bot.status;
    const state = [s.busy ? 'working' : 'idle', s.activeSubagents ? `${s.activeSubagents} sub-agent${s.activeSubagents === 1 ? '' : 's'}` : '', s.needsYou ? `${s.needsYou} need${s.needsYou === 1 ? 's' : ''} you` : '']
      .filter(Boolean)
      .join(' · ');
    return `  ${p.bold(bot.kind === 'main' ? 'main' : clean(bot.name)).padEnd(20)} ${state}${bot.kind === 'main' ? '' : p.dim(`  ${bot.folders.map(clean).join(', ')}`)}`;
  });
}

/** Opens bot settings as JSON in the user's editor until the core accepts them or the user gives up. */
async function editBot(client: Client, context: Context, existing: BotView | null): Promise<void> {
  const info = await client.api.appInfo();
  const input: BotInput & { _help?: string[] } = existing
    ? {
        name: existing.name,
        description: existing.description,
        folders: existing.folders,
        instructions: existing.instructions,
        model: existing.model,
        effort: existing.effort,
        subagents: existing.subagents,
      }
    : {
        name: '',
        description: '',
        folders: [process.cwd()],
        instructions: '',
        model: null,
        effort: null,
        subagents: defaultSubagents(info.engines.includes('claude') ? 'claude' : (info.engines[0] ?? 'claude')),
      };
  const help = [
    'Save and close the editor to apply; an empty file cancels.',
    'name: what the main bot calls it. description: what the project is, so the main bot routes work to it.',
    'folders: absolute paths, the first is the main one. model / effort: the bot\'s own (null: the default).',
    `subagents.engine: ${info.engines.join(' or ')}. permissionMode: plan, default, acceptEdits, auto or bypassPermissions.`,
    'subagents.isolation: "shared" (the project folders) or "worktree" (a git worktree and branch each).',
  ];
  const editable = existing?.kind === 'main' ? { model: input.model, effort: input.effort, instructions: input.instructions } : input;
  let text = `${JSON.stringify({ _help: help, ...editable }, null, 2)}\n`;
  const dir = mkdtempSync(join(tmpdir(), 'code-bot-edit-'));
  const file = join(dir, `${existing ? existing.name.replace(/[^\w-]+/g, '-') : 'new-bot'}.json`);
  try {
    for (;;) {
      writeFileSync(file, text);
      const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'nano');
      const result = spawnSync(`${editor} "${file}"`, { stdio: 'inherit', shell: true });
      if (result.status !== 0) throw new Error(`The editor (${editor}) exited with code ${result.status}. Set EDITOR to the one you use.`);
      text = readFileSync(file, 'utf8');
      if (!text.trim()) {
        context.out('Cancelled.');
        return;
      }
      try {
        const value = JSON.parse(text) as BotInput & { _help?: unknown };
        delete value._help;
        const saved = existing ? await client.api.updateBot(existing.id, value) : await client.api.createBot(value);
        context.out(`${existing ? 'Saved' : 'Created'} ${saved.kind === 'main' ? 'the main bot' : saved.name}.`);
        return;
      } catch (error) {
        context.out(`Not saved: ${errorMessage(error)}`);
        if (!(await confirm('Edit again?'))) return;
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function stop(context: Context, force: boolean): Promise<number> {
  const found = findServer(context.userData);
  if (found.kind === 'desktop') {
    context.out(describeInstance(found.instance));
    return 1;
  }
  if (found.kind !== 'server') {
    context.out('code-bot is not running.');
    return 0;
  }
  const status = await found.client.status();
  if (status.activeSubagents > 0 && !force) {
    const question = `${status.activeSubagents} sub-agent${status.activeSubagents === 1 ? ' is' : 's are'} working. Stopping pauses them; each can be resumed later by sending it a message. Stop?`;
    if (!(await confirm(question))) {
      context.out(interactive() ? 'Still running.' : `${status.activeSubagents} sub-agents are working; use --force to stop anyway.`);
      return 1;
    }
  }
  await found.client.stop();
  for (let i = 0; i < 300; i++) {
    if (!readInstance(join(context.userData, 'data'))) {
      context.out('code-bot stopped.');
      return 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  context.out('code-bot was asked to stop but is still running.');
  return 1;
}

async function serve(context: Context, parsed: Parsed): Promise<number> {
  const fakeModels = parsed.flags.has('fake-models') || process.env.CODE_BOT_FAKE_MODELS === '1';
  const server = await runServer({
    userData: context.userData,
    port: context.port,
    fakeModels,
    enableMockEngine: process.env.CODE_BOT_ENABLE_MOCK_ENGINE === '1',
    claudeExecutable: process.env.CODE_BOT_CLAUDE_EXECUTABLE?.trim() || undefined,
    log: (line) => console.log(`${new Date().toISOString()} ${line}`),
  });
  console.log(
    `${new Date().toISOString()} code-bot ${CODE_BOT_VERSION} is listening on 127.0.0.1:${server.port}${fakeModels ? ' with scripted models' : ''} (data: ${context.userData}, process ${process.pid})`,
  );
  const quit = (signal: string) => {
    console.log(`${new Date().toISOString()} code-bot: stopping (${signal})`);
    void server.stop();
  };
  process.once('SIGINT', () => quit('SIGINT'));
  process.once('SIGTERM', () => quit('SIGTERM'));
  process.once('SIGHUP', () => quit('SIGHUP'));
  await server.stopped;
  console.log(`${new Date().toISOString()} code-bot stopped`);
  return 0;
}

async function login(rest: string[], parsed: Parsed, context: Context): Promise<number> {
  // The agent's own options: --device-auth (Codex without a browser), or anything after "--".
  const [engineId, ...extra] = rest;
  if (parsed.flags.has('device-auth')) extra.push('--device-auth');
  const engines: Engine[] = [new ClaudeEngine({ executable: process.env.CODE_BOT_CLAUDE_EXECUTABLE?.trim() || undefined }), new CodexEngine()];
  const engine = engines.find((candidate) => candidate.id === engineId);
  if (!engine) {
    context.out(`Sign in to which agent? code-bot login ${engines.map((candidate) => candidate.id).join(' | ')}`);
    return 1;
  }
  const check = engine.check ? await engine.check() : undefined;
  if (check?.ready && !extra.length) {
    context.out(`${engine.label}: ${check.detail}`);
    return 0;
  }
  if (!check?.signIn) {
    context.out(`${engine.label} cannot be signed in from code-bot${check ? `: ${check.detail}` : ''}`);
    return 1;
  }
  const result = spawnSync(check.signIn.command, [...check.signIn.args, ...extra], { stdio: 'inherit' });
  return result.status ?? 1;
}

export async function main(argv: string[]): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    console.error(errorMessage(error));
    return 2;
  }
  const explicitData = flag(parsed, 'data') ? resolve(flag(parsed, 'data') as string) : undefined;
  const context: Context = {
    userData: explicitData ?? defaultUserData(),
    explicitData,
    port: portFrom(flag(parsed, 'port') ?? process.env.CODE_BOT_PORT),
    out: (line = '') => console.log(line),
  };
  if (parsed.flags.has('version')) {
    context.out(`code-bot ${CODE_BOT_VERSION}`);
    return 0;
  }
  const [command = 'chat', ...rest] = parsed.positional;
  if (parsed.flags.has('help') || command === 'help') {
    context.out(USAGE);
    return 0;
  }
  try {
    switch (command) {
      case 'chat': {
        const client = await connect(context);
        await new Chat({
          client,
          bot: rest[0],
          input: process.stdin,
          output: process.stdout,
          interactive: interactive(),
          color: colour(),
          openTerminal,
        }).run();
        return 0;
      }
      case 'serve':
        return await serve(context, parsed);
      case 'status': {
        const found = findServer(context.userData);
        if (found.kind === 'desktop') {
          context.out(describeInstance(found.instance));
          return 0;
        }
        if (found.kind !== 'server') {
          context.out(`code-bot is not running (data: ${context.userData}).`);
          const tail = logTail(context.userData, 5);
          if (tail) context.out(`The end of its log:\n${tail}`);
          return 3;
        }
        const status = await found.client.status();
        context.out(
          `code-bot ${status.version} is running: process ${status.pid}, 127.0.0.1:${status.port}, since ${new Date(status.startedAt).toLocaleString()}${status.fakeModels ? ', scripted models' : ''}`,
        );
        context.out(`Data: ${context.userData}`);
        for (const line of botLines(await found.client.api.listBots())) context.out(line);
        return 0;
      }
      case 'stop':
        return await stop(context, parsed.flags.has('force'));
      case 'bots': {
        const client = await connect(context);
        for (const line of botLines(await client.api.listBots())) context.out(line);
        return 0;
      }
      case 'bot': {
        const [action, ref] = rest;
        const client = await connect(context);
        if (action === 'new') {
          await editBot(client, context, null);
          return 0;
        }
        if (action === 'edit' && ref) {
          await editBot(client, context, findBot(await client.api.listBots(), ref));
          return 0;
        }
        context.out('code-bot bot new | code-bot bot edit <bot>');
        return 2;
      }
      case 'panes': {
        const client = await connect(context);
        const where = await openPanes({
          bots: await client.api.listBots(),
          userData: context.explicitData,
          rebuild: parsed.flags.has('rebuild'),
          detached: parsed.flags.has('detached'),
          session: flag(parsed, 'session'),
        });
        if (parsed.flags.has('detached') || where === 'Windows Terminal') context.out(`Opened the bots in ${where}.`);
        return 0;
      }
      case 'login':
        return await login(rest, parsed, context);
      case 'export': {
        const target = rest[0];
        if (!target) {
          context.out('code-bot export <file>');
          return 2;
        }
        // Read-only: works while the desktop app or the server has the database open.
        const store = new Store(join(context.userData, 'data'), { readOnly: true });
        try {
          const file = exportBots(store);
          writeFileSync(resolve(target), `${JSON.stringify(file, null, 2)}\n`);
          context.out(`Wrote ${file.bots.length} project bot${file.bots.length === 1 ? '' : 's'} and ${file.routines.length} routine${file.routines.length === 1 ? '' : 's'} to ${resolve(target)}.`);
          context.out('No conversations, sub-agents or tokens are in it. MCP servers name the environment variable for their token, not the token.');
        } finally {
          store.close();
        }
        return 0;
      }
      case 'import': {
        const source = rest[0];
        if (!source) {
          context.out('code-bot import <file> [--map FROM=TO ...] [--check]');
          return 2;
        }
        const file = parseExport(readFileSync(resolve(source), 'utf8'));
        const client = await connect(context);
        const maps = (parsed.lists.get('map') ?? []).map(parseMap);
        const check = parsed.flags.has('check');
        const lines = await importBots(client.api, file, { maps, check });
        for (const line of lines) context.out(`  ${line.outcome.padEnd(12)} ${line.kind === 'routine' ? 'routine ' : ''}${line.name}${line.detail ? `: ${line.detail}` : ''}`);
        if (check) context.out('Nothing was changed (--check).');
        return lines.some((line) => line.outcome === 'skipped') ? 1 : 0;
      }
      case 'service': {
        const dataDir = join(context.userData, 'data');
        const action = rest[0];
        if (action === 'install') {
          // The service takes the data folder's lock: a code-bot started in the background has to stop first.
          const found = findServer(context.userData);
          if (found.kind === 'desktop') throw new Error(describeInstance(found.instance));
          if (found.kind === 'server') {
            context.out('Stopping the code-bot that runs in the background, so the service can take over…');
            if ((await stop(context, parsed.flags.has('force'))) !== 0) return 1;
          }
          const result = installService({ userData: context.explicitData, port: context.port, timeZone: flag(parsed, 'tz') }, dataDir);
          for (const line of result.lines) context.out(line);
          return 0;
        }
        if (action === 'uninstall') {
          for (const line of uninstallService(dataDir).lines) context.out(line);
          return 0;
        }
        if (action === 'status') {
          for (const line of serviceStatus(dataDir).lines) context.out(line);
          return 0;
        }
        context.out('code-bot service install [--tz <zone>] | uninstall | status');
        return 2;
      }
      default:
        context.out(`Unknown command "${command}".\n`);
        context.out(USAGE);
        return 2;
    }
  } catch (error) {
    console.error(`code-bot: ${errorMessage(error)}`);
    return 1;
  }
}
