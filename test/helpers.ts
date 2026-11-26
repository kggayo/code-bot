import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { Brain, BrainEvent, BrainInput, BotTool } from '../src/core/brain.ts';
import { CodeBot } from '../src/core/code-bot.ts';
import { MockEngine } from '../src/core/engines/mock.ts';
import { ScriptedBrain } from '../src/core/scripted-brain.ts';
import { Store } from '../src/core/store.ts';
import type { BotInput, BotView, CoreEvent, SubagentDefaults } from '../src/shared/types.ts';

export const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

/** Sub-agent settings for test bots: the mock engine, shared folders, no limits. */
export function mockSubagents(extra: Partial<SubagentDefaults> = {}): SubagentDefaults {
  return {
    engine: 'mock',
    model: null,
    effort: null,
    permissionMode: 'acceptEdits',
    isolation: 'shared',
    worktreeFiles: ['.env', '.env.*'],
    maxTurns: null,
    maxBudgetUsd: null,
    mcpServers: [],
    ...extra,
  };
}

/** Runs bots with ScriptedBrain unless a test overrides one bot's turns. */
export class TestBrain implements Brain {
  private readonly scripted = new ScriptedBrain();
  readonly overrides = new Map<string, (input: BrainInput, tools: ToolCaller) => Promise<string>>();

  async *run(input: BrainInput): AsyncGenerator<BrainEvent> {
    const override = this.overrides.get(input.botId);
    if (!override) {
      yield* this.scripted.run(input);
      return;
    }
    await tick(1);
    yield { type: 'session', sessionId: input.sessionId ?? `session-${input.botId}` };
    const text = await override(input, new ToolCaller(input.tools));
    yield { type: 'text', text };
    yield { type: 'result', ok: true, text };
  }
}

export class ToolCaller {
  private readonly tools: BotTool[];

  constructor(tools: BotTool[]) {
    this.tools = tools;
  }

  names(): string[] {
    return this.tools.map((tool) => tool.name);
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const tool = this.tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`No tool named ${name}`);
    return tool.run(args);
  }
}

export function setup(t: TestContext, options: { questionTimeoutMs?: number } = {}) {
  // Canonical path, as code-bot stores folders (Windows temp paths can be short names).
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'code-bot-test-')));
  const store = new Store(join(dir, 'data'));
  const brain = new TestBrain();
  const core = new CodeBot({
    store,
    engines: [new MockEngine()],
    brain,
    workDir: join(dir, 'main-bot'),
    worktreeDir: join(dir, 'worktrees'),
    questionTimeoutMs: options.questionTimeoutMs,
    retentionIntervalMs: 0,
    usageIntervalMs: 0,
    routineTickMs: 0,
  });
  const events: CoreEvent[] = [];
  core.subscribe((event) => events.push(event));
  t.after(async () => {
    await core.shutdown();
    await tick(30);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const folder = (name: string) => {
    const path = join(dir, 'projects', name);
    mkdirSync(path, { recursive: true });
    return path;
  };
  const projectBot = (name: string, extra: Partial<BotInput> = {}): BotView =>
    core.createBot({
      name,
      description: `The ${name} project`,
      folders: [folder(name)],
      instructions: '',
      model: null,
      effort: null,
      subagents: mockSubagents(),
      ...extra,
    });

  return { dir, store, core, brain, events, folder, projectBot };
}

/** Resolves with the first non-undefined value of `check`, re-checked after every event. */
export function waitFor<T>(core: CodeBot, check: () => T | undefined | false, timeoutMs = 10_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      unsubscribe();
      clearTimeout(timer);
    };
    const attempt = () => {
      let value: T | undefined | false;
      try {
        value = check();
      } catch (error) {
        cleanup();
        reject(error);
        return;
      }
      if (value !== undefined && value !== false) {
        cleanup();
        resolve(value);
      }
    };
    const unsubscribe = core.subscribe(() => attempt());
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for the condition'));
    }, timeoutMs);
    attempt();
  });
}

/** Waits until no bot is busy and no sub-agent is working. */
export async function idle(core: CodeBot): Promise<void> {
  for (let i = 0; i < 1000; i += 1) {
    await tick(10);
    if (core.activeSubagents() === 0 && core.listBots().every((bot) => !bot.status.busy)) return;
  }
  throw new Error('code-bot did not settle');
}

export function texts(core: CodeBot, botId: string): string[] {
  return core
    .getThread(botId)
    .events.filter((event) => event.type === 'bot.text')
    .map((event) => (event.data as { text: string }).text);
}

export function threadTypes(core: CodeBot, botId: string): string[] {
  return core.getThread(botId).events.map((event) => event.type);
}

export function taskTexts(core: CodeBot, taskId: string): string[] {
  return core
    .getTask(taskId)
    .events.filter((event) => event.type === 'text')
    .map((event) => (event.data as { text: string }).text);
}
