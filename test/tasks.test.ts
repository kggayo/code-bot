import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { MockEngine } from '../src/core/engines/mock.ts';
import { Store } from '../src/core/store.ts';
import { TaskManager } from '../src/core/tasks.ts';
import type { NewTask } from '../src/core/tasks.ts';
import { CodeBotError } from '../src/core/util.ts';
import type { Task, TaskState } from '../src/shared/types.ts';

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

function setup(t: TestContext, options: { maxActive?: () => number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'code-bot-tasks-'));
  const store = new Store(dir);
  const manager = new TaskManager({ store, engines: [new MockEngine()], maxActive: options.maxActive });
  t.after(async () => {
    await manager.shutdown();
    await tick();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const start = (prompt: string, extra: Partial<NewTask> = {}) =>
    manager.createTask({
      botId: 'b_test',
      prompt,
      requestedBy: 'user',
      cwd: dir,
      additionalDirectories: [],
      engine: 'mock',
      model: 'base-model',
      effort: 'medium',
      permissionMode: 'default',
      instructions: '',
      ...extra,
    });
  return { dir, store, manager, start };
}

function until(manager: TaskManager, taskId: string, states: TaskState[], timeoutMs = 2000): Promise<Task> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      unsubscribe();
      clearTimeout(timer);
    };
    const check = () => {
      const task = manager.getTask(taskId);
      if (!states.includes(task.state)) return;
      cleanup();
      resolve(task);
    };
    const unsubscribe = manager.subscribe((event) => {
      if (event.id === taskId) check();
    });
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Task ${taskId} is "${manager.getTask(taskId).state}", expected ${states.join(' or ')}`));
    }, timeoutMs);
    check();
  });
}

function texts(manager: TaskManager, taskId: string): string[] {
  return manager
    .events(taskId)
    .filter((event) => event.type === 'text')
    .map((event) => (event.data as { text: string }).text);
}

test('a sub-agent runs with the model, effort and folders it was given', async (t) => {
  const { manager, start } = setup(t);
  const task = start('hello', { model: 'big-model', effort: 'max', additionalDirectories: ['/elsewhere'] });
  const done = await until(manager, task.id, ['done']);
  assert.equal(done.lastResult, 'echo[big-model/max +1 folder(s)]: hello');
  assert.equal(done.requestedBy, 'user');
  assert.deepEqual(done.additionalDirectories, ['/elsewhere']);
});

test('several sub-agents work at the same time', async (t) => {
  const { manager, start } = setup(t);
  const first = start('hold one');
  const second = start('hold two');
  await tick();
  assert.equal(manager.countActive('b_test'), 2);

  manager.sendMessage(second.id, 'go', 'lead');
  await until(manager, second.id, ['done']);
  assert.equal(manager.getTask(first.id).state, 'running');
  assert.ok(texts(manager, second.id).includes('Steered with: go'));

  manager.sendMessage(first.id, 'finish', 'user');
  await until(manager, first.id, ['done']);
  const sources = manager
    .events(first.id)
    .filter((event) => event.type === 'user.message')
    .map((event) => (event.data as { from: string }).from);
  assert.deepEqual(sources, ['lead', 'user']);
});

test('a question waits for an answer, and the answer reaches the sub-agent', async (t) => {
  const { manager, start } = setup(t);
  const task = start('ask me something');
  await until(manager, task.id, ['waiting']);
  const [request] = manager.pendingRequests({ taskId: task.id });
  assert.equal(request?.kind, 'question');
  assert.equal(request?.botId, 'b_test');
  assert.equal(request?.surfacedIn, null);

  manager.markSurfaced(request!.id, 'c_somewhere');
  assert.equal(manager.findRequest(request!.id)?.surfacedIn, 'c_somewhere');

  manager.respond(task.id, request!.id, { decision: 'allow', answers: { 'Which colour?': 'Blue' } }, 'user');
  await until(manager, task.id, ['done']);
  assert.ok(texts(manager, task.id).includes('You answered: Blue'));
  const resolved = manager.events(task.id).find((event) => event.type === 'request.resolved');
  assert.deepEqual(
    { by: (resolved?.data as { by: string }).by, surfacedIn: (resolved?.data as { surfacedIn: string }).surfacedIn },
    { by: 'user', surfacedIn: 'c_somewhere' },
  );
  assert.throws(
    () => manager.respond(task.id, request!.id, { decision: 'allow' }, 'user'),
    (error) => error instanceof CodeBotError && error.code === 'not_found',
  );
});

test('an approval can be denied', async (t) => {
  const { manager, start } = setup(t);
  const task = start('needs permission');
  await until(manager, task.id, ['waiting']);
  const [request] = manager.pendingRequests({ taskId: task.id });
  assert.equal(request?.kind, 'permission');
  manager.respond(task.id, request!.id, { decision: 'deny', message: 'not now' }, 'user');
  await until(manager, task.id, ['done']);
  assert.ok(texts(manager, task.id).includes('Command was denied.'));
});

test('a follow-up message continues the same session', async (t) => {
  const { manager, start } = setup(t);
  const task = start('first');
  const finished = await until(manager, task.id, ['done']);
  manager.sendMessage(task.id, 'second', 'lead');
  const continued = await until(manager, task.id, ['done']);
  assert.equal(continued.engineSessionId, finished.engineSessionId);
  assert.equal(continued.lastResult, 'echo[base-model/medium]: second');
  assert.ok(texts(manager, task.id).includes('(continuing the earlier session)'));
});

test('cancel stops a sub-agent and withdraws its open requests', async (t) => {
  const { manager, start } = setup(t);
  const holding = start('hold on');
  const asking = start('ask me');
  await until(manager, asking.id, ['waiting']);
  await manager.cancel(holding.id);
  await manager.cancel(asking.id);
  assert.equal((await until(manager, holding.id, ['cancelled'])).state, 'cancelled');
  assert.equal((await until(manager, asking.id, ['cancelled'])).state, 'cancelled');
  assert.equal(manager.pendingRequests().length, 0);
  const withdrawn = manager.events(asking.id).find((event) => event.type === 'request.resolved');
  assert.equal((withdrawn?.data as { decision: string }).decision, 'withdrawn');
});

test('a failing turn is reported, and bad input is refused', async (t) => {
  const { manager, start } = setup(t);
  const task = start('please fail');
  assert.equal((await until(manager, task.id, ['failed'])).error, 'The mock agent was told to fail.');
  assert.throws(() => start('   '), (error) => error instanceof CodeBotError && error.code === 'invalid');
  assert.throws(() => start('x', { engine: 'nope' }), (error) => error instanceof CodeBotError && error.code === 'invalid');
});

test('sub-agents left working by a previous process are marked interrupted', async (t) => {
  const { manager, store, start } = setup(t);
  const task = start('hold forever');
  await tick();
  assert.equal(store.getTask(task.id)?.state, 'running');
  new TaskManager({ store, engines: [new MockEngine()] });
  assert.equal(store.getTask(task.id)?.state, 'interrupted');
  void manager;
});

test('an open question survives a restart, and answering it resumes the sub-agent', async (t) => {
  const { manager, store, start } = setup(t);
  const task = start('ask me something');
  await until(manager, task.id, ['waiting']);
  const [asked] = manager.pendingRequests({ taskId: task.id });
  manager.markSurfaced(asked!.id, 'c_main');
  await manager.shutdown();
  assert.equal(store.getTask(task.id)?.state, 'interrupted');
  assert.match(store.getTask(task.id)?.error ?? '', /Answering resumes it/);

  const after = new TaskManager({ store, engines: [new MockEngine()] });
  const [held] = after.pendingRequests({ taskId: task.id });
  assert.equal(held?.id, asked!.id);
  assert.equal(held?.held, true);
  assert.equal(held?.surfacedIn, 'c_main');

  after.respond(task.id, held!.id, { decision: 'allow', answers: { 'Which colour?': 'Red' } }, 'user');
  const done = await until(after, task.id, ['done']);
  assert.ok(done.lastResult?.includes('Your question was answered: {"Which colour?":"Red"}'));
  assert.equal(after.pendingRequests().length, 0);
  assert.equal(store.listRequests().length, 0);
  await after.shutdown();
});

test('an approval given after a restart lets the same call run once without asking again', async (t) => {
  const { manager, store, start } = setup(t);
  const task = start('needs permission');
  await until(manager, task.id, ['waiting']);
  await manager.shutdown();

  const after = new TaskManager({ store, engines: [new MockEngine()] });
  const [held] = after.pendingRequests({ taskId: task.id });
  assert.equal(held?.kind, 'permission');
  after.respond(task.id, held!.id, { decision: 'allow' }, 'user');
  await until(after, task.id, ['done']);
  // The resume note tells the mock about the approval; it repeats the same call, which runs without a new request.
  assert.ok(texts(after, task.id).includes('Command approved and run.'));
  assert.equal(after.events(task.id).filter((event) => event.type === 'request').length, 1);
  await after.shutdown();
});

test('a message to a sub-agent with held requests withdraws them and resumes it', async (t) => {
  const { manager, store, start } = setup(t);
  const task = start('ask me something');
  await until(manager, task.id, ['waiting']);
  await manager.shutdown();

  const after = new TaskManager({ store, engines: [new MockEngine()] });
  after.sendMessage(task.id, 'never mind, pick one yourself', 'user');
  const done = await until(after, task.id, ['done']);
  assert.equal(done.lastResult, 'echo[base-model/medium]: never mind, pick one yourself');
  const resolved = after.events(task.id).filter((event) => event.type === 'request.resolved');
  assert.equal((resolved.at(-1)?.data as { decision: string }).decision, 'withdrawn');
  assert.equal(after.pendingRequests().length, 0);
  await after.shutdown();
});

test('turn and budget limits stop a sub-agent', async (t) => {
  const { manager, start } = setup(t);
  const long = start('a long task', { maxTurns: 2 });
  assert.match((await until(manager, long.id, ['failed'])).error ?? '', /Stopped after 2 turns/);

  const cheap = start('first', { maxBudgetUsd: 0.01 });
  assert.equal((await until(manager, cheap.id, ['done'])).costUsd, 0.01);
  manager.sendMessage(cheap.id, 'second', 'lead');
  assert.match((await until(manager, cheap.id, ['failed'])).error ?? '', /used its budget: \$0\.01 of \$0\.01/);

  const tiny = start('hello', { maxBudgetUsd: 0.005 });
  assert.match((await until(manager, tiny.id, ['failed'])).error ?? '', /budget per sub-agent/);
});

test('the number of sub-agents working at once follows the setting', async (t) => {
  let limit = 1;
  const { manager, start } = setup(t, { maxActive: () => limit });
  start('hold one');
  assert.throws(() => start('hold two'), (error) => error instanceof CodeBotError && error.code === 'busy');
  limit = 2;
  start('hold two');
  assert.equal(manager.countActive(), 2);
});

test('a stopped sub-agent can be archived and shown again', async (t) => {
  const { manager, start } = setup(t);
  const working = start('hold on');
  assert.throws(() => manager.setArchived(working.id, true), (error) => error instanceof CodeBotError && error.code === 'conflict');
  const task = start('hello');
  await until(manager, task.id, ['done']);
  manager.setArchived(task.id, true);
  assert.deepEqual(
    manager.listTasks({ archived: true }).map((candidate) => candidate.id),
    [task.id],
  );
  assert.ok(!manager.listTasks({ archived: false }).some((candidate) => candidate.id === task.id));
  manager.setArchived(task.id, false);
  assert.equal(manager.getTask(task.id).archivedAt, null);
});
