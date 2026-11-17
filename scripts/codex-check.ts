// Live check of the Codex engine with the real Codex CLI. It spends a little model usage: three
// short turns on the cheapest fast model that `model/list` offers, at low effort. Codex must be
// signed in on this machine (`codex login status`).
//
//   node scripts/codex-check.ts
//
// It works in a throwaway git repository it creates itself, with a canonical path (a Windows
// short path such as C:\Users\ABCDEF~1 confuses agents), and allows every request Codex makes
// there. Afterwards it archives the Codex thread it created and removes the repository.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexEngine } from '../src/core/engines/codex.ts';
import type { CodexModel } from '../src/core/engines/codex.ts';
import type { AskUser, EngineEvent, EngineRunOptions, UserRequest } from '../src/core/engines/types.ts';

const RUN_TIMEOUT_MS = 5 * 60_000;
const engine = new CodexEngine();
const repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'code-bot-codex-live-')));
execFileSync('git', ['init', '-q'], { cwd: repo });
const codexConfig = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml');

const short = (text: string, limit = 160) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
};

let step = 0;
let failures = 0;
async function check(name: string, run: () => Promise<void>): Promise<boolean> {
  step += 1;
  const started = Date.now();
  try {
    await run();
    console.log(`  ok   ${step}. ${name} (${Math.round((Date.now() - started) / 1000)}s)`);
    return true;
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${step}. ${name}`);
    console.log(`       ${error instanceof Error ? error.message : String(error)}`.replace(/\n/g, '\n       '));
    return false;
  }
}

/** Allows every approval and answers questions with "Blue" (or the first option), printing each. */
function allowAll(requests: UserRequest[]): AskUser {
  return async (request) => {
    requests.push(request);
    if (request.kind === 'question') {
      const questions = (request.input as { questions?: { question: string; options?: { label: string }[] }[] }).questions ?? [];
      const answers = Object.fromEntries(
        questions.map((question) => {
          const options = question.options ?? [];
          return [question.question, options.find((option) => /blue/i.test(option.label))?.label ?? options[0]?.label ?? 'Blue'];
        }),
      );
      console.log(`       question (${request.tool}): ${questions.map((question) => question.question).join(' / ')} -> ${Object.values(answers).join(', ')}`);
      return { decision: 'allow', answers };
    }
    console.log(`       approval (${request.tool}): ${short(request.summary ?? '')} ${short(JSON.stringify(request.input), 200)} -> allowed`);
    return { decision: 'allow' };
  };
}

async function turn(options: Omit<EngineRunOptions, 'cwd'>, askUser: AskUser) {
  const run = engine.start({ cwd: repo, ...options }, askUser);
  const timer = setTimeout(() => void run.interrupt(), RUN_TIMEOUT_MS);
  const events: EngineEvent[] = [];
  try {
    for await (const event of run.events) {
      events.push(event);
      if (event.type === 'tool_use') console.log(`       tool: ${event.name} ${short(JSON.stringify(event.input))}`);
    }
  } finally {
    clearTimeout(timer);
  }
  const session = events.find((event) => event.type === 'session');
  const result = events.findLast((event) => event.type === 'result');
  assert.ok(result && result.type === 'result', 'the run ended without a result');
  console.log(`       result: ${result.ok ? 'ok' : 'failed'}: ${short(result.ok ? result.text : (result.error ?? ''), 300)}`);
  return { sessionId: session?.type === 'session' ? session.sessionId : undefined, result, events };
}

function cheapestFast(models: CodexModel[]): CodexModel | undefined {
  const usable = models.filter((model) => model.efforts.length === 0 || model.efforts.includes('low'));
  return (
    usable.find((model) => /affordable|cheap|mini|efficient/i.test(`${model.name} ${model.description}`)) ??
    usable.find((model) => /fast/i.test(model.description)) ??
    models.find((model) => model.isDefault)
  );
}

let model: string | undefined;
let threadId: string | undefined;
try {
  const ready = await check('Codex is installed and signed in', async () => {
    const status = await engine.check();
    console.log(`       ${status.detail}`);
    assert.ok(status.ready, 'Codex is not ready; sign in with `codex login`');
  });
  if (ready) await modelChecks();
} finally {
  if (threadId) {
    // Keep the owner's Codex history tidy; `codex unarchive <id>` brings the thread back.
    const command = engine.resumeCommand(threadId)?.command;
    if (command) {
      const archived = /\.(cmd|bat)$/i.test(command)
        ? spawnSync(`"${command}" archive ${threadId}`, { shell: true, encoding: 'utf8', windowsHide: true })
        : spawnSync(command, ['archive', threadId], { encoding: 'utf8', windowsHide: true });
      console.log(archived.status === 0 ? `       archived Codex thread ${threadId}` : `       could not archive Codex thread ${threadId}`);
    }
  }
  rmSync(repo, { recursive: true, force: true });
}

console.log(failures === 0 ? 'All Codex checks passed.' : `${failures} Codex check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;

async function modelChecks(): Promise<void> {
  await check('model/list offers a cheap fast model', async () => {
    const models = await engine.models();
    console.log(`       offered: ${models.map((offered) => offered.id).join(', ')}`);
    model = cheapestFast(models)?.id;
    assert.ok(model, 'no model to use');
    console.log(`       using ${model} at low effort`);
  });

  await check('a new thread creates hello.txt, asking first (permission mode "default")', async () => {
    const requests: UserRequest[] = [];
    const { sessionId, result } = await turn(
      {
        prompt: 'Create a file named hello.txt in the current folder containing exactly the word hello. Do nothing else.',
        model,
        effort: 'low',
        permissionMode: 'default',
      },
      allowAll(requests),
    );
    threadId = sessionId;
    assert.ok(threadId, 'no session id');
    assert.ok(result.ok, `the turn failed: ${result.error}`);
    assert.ok(existsSync(join(repo, 'hello.txt')), 'hello.txt was not created');
    assert.match(readFileSync(join(repo, 'hello.txt'), 'utf8'), /^\s*hello\s*$/);
    assert.ok(requests.some((request) => request.kind === 'permission'), 'no approval was asked for in "default" mode');
  });

  await check('resuming the thread: it remembers the file it created', async () => {
    assert.ok(threadId, 'there is no thread to resume');
    const { sessionId, result } = await turn(
      {
        prompt: 'What file did you create? Answer with the file name only.',
        model,
        effort: 'low',
        permissionMode: 'default',
        resumeSessionId: threadId,
      },
      allowAll([]),
    );
    assert.equal(sessionId, threadId, 'the run did not continue the same thread');
    assert.ok(result.ok, `the turn failed: ${result.error}`);
    assert.match(result.text, /hello\.txt/i);
  });

  await check('a question reaches askUser as AskUserQuestion and the answer gets back', async () => {
    assert.ok(threadId, 'there is no thread to resume');
    const requests: UserRequest[] = [];
    const { result } = await turn(
      {
        prompt:
          'Use your request_user_input tool to ask me one question: which colour I prefer, with the options Red and Blue. After I answer, reply with only the colour I chose.',
        model,
        effort: 'low',
        permissionMode: 'default',
        resumeSessionId: threadId,
      },
      allowAll(requests),
    );
    const question = requests.find((request) => request.kind === 'question');
    assert.ok(question, 'Codex did not ask a question');
    assert.equal(question.tool, 'AskUserQuestion');
    assert.ok(result.ok, `the turn failed: ${result.error}`);
    assert.match(result.text, /blue/i);
  });

  await check("Codex's config.toml has no trust entry for the throwaway folder", async () => {
    const config = existsSync(codexConfig) ? readFileSync(codexConfig, 'utf8').toLowerCase() : '';
    assert.ok(!config.includes(repo.toLowerCase()), `${codexConfig} now mentions ${repo}`);
  });
}
