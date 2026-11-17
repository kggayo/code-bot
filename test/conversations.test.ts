import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { CodeBot } from '../src/core/code-bot.ts';
import { MockEngine } from '../src/core/engines/mock.ts';
import { DEFAULT_SETTINGS } from '../src/shared/types.ts';
import { TestBrain, idle, setup, taskTexts, waitFor } from './helpers.ts';

const DAY = 24 * 60 * 60 * 1000;

test('earlier conversations can be listed, read, reopened and archived', async (t) => {
  const { core, projectBot } = setup(t);
  const alpha = projectBot('alpha');
  core.sendToBot(alpha.id, 'first conversation');
  await idle(core);
  const first = core.getThread(alpha.id).threadId;
  core.newConversation(alpha.id);
  core.sendToBot(alpha.id, 'second conversation');
  await idle(core);
  const second = core.getThread(alpha.id).threadId;

  assert.deepEqual(
    core.listConversations(alpha.id).map((conversation) => [conversation.title, conversation.current]),
    [
      ['second conversation', true],
      ['first conversation', false],
    ],
  );
  const earlier = core.getConversation(alpha.id, first);
  assert.equal(earlier.current, false);
  assert.ok(earlier.events.some((event) => event.type === 'user.message'));
  assert.throws(() => core.getConversation('main', first), /No conversation/);

  assert.throws(() => core.setConversationArchived(alpha.id, second, true), /current conversation/);
  core.setConversationArchived(alpha.id, first, true);
  assert.equal(core.listConversations(alpha.id).length, 1);
  assert.equal(core.listConversations(alpha.id, { archived: true })[0]?.threadId, first);

  const reopened = core.reopenConversation(alpha.id, first);
  assert.equal(reopened.threadId, first);
  assert.equal(reopened.current, true);
  assert.equal(core.listConversations(alpha.id).length, 2);
  assert.equal(core.listConversations(alpha.id).find((conversation) => conversation.current)?.threadId, first);
});

test('retention archives idle sub-agents and conversations, and deletes archived ones only when set', async (t) => {
  const { core, projectBot } = setup(t);
  const alpha = projectBot('alpha');
  core.sendToBot(alpha.id, 'task: hello');
  await waitFor(core, () => core.listTasks({ botId: alpha.id })[0]?.state === 'done');
  await idle(core);
  const first = core.getThread(alpha.id).threadId;
  core.newConversation(alpha.id);
  const [task] = core.listTasks({ botId: alpha.id });

  const none = { archivedSubagents: 0, archivedConversations: 0, deletedSubagents: 0, deletedConversations: 0 };
  assert.deepEqual(await core.runRetention(), none);
  assert.deepEqual(await core.runRetention(new Date(Date.now() + 31 * DAY)), { ...none, archivedSubagents: 1, archivedConversations: 1 });
  assert.equal(core.listTasks({ botId: alpha.id }).length, 0);
  assert.equal(core.listTasks({ botId: alpha.id, archived: true })[0]?.id, task!.id);
  assert.equal(core.listConversations(alpha.id, { archived: true })[0]?.threadId, first);

  // Deleting is off by default.
  assert.deepEqual(await core.runRetention(new Date(Date.now() + 400 * DAY)), none);
  core.updateSettings({ deleteArchivedAfterDays: 7 });
  assert.deepEqual(await core.runRetention(new Date(Date.now() + 40 * DAY)), { ...none, deletedSubagents: 1, deletedConversations: 1 });
  assert.throws(() => core.tasks.getTask(task!.id), /No sub-agent/);
  assert.deepEqual(core.listConversations(alpha.id, { archived: true }), []);
});

test('settings are validated and limit how many sub-agents work at once', async (t) => {
  const { core, projectBot } = setup(t);
  assert.deepEqual(core.getSettings(), DEFAULT_SETTINGS);
  assert.throws(() => core.updateSettings({ maxActiveSubagents: 0 }), /from 1 to 50/);
  assert.throws(() => core.updateSettings({ archiveAfterDays: 1.5 }), /whole number/);
  assert.equal(core.updateSettings({ maxActiveSubagents: 1 }).maxActiveSubagents, 1);
  assert.equal(core.getSettings().maxActiveSubagents, 1);

  const alpha = projectBot('alpha');
  const start = () =>
    core.tasks.createTask({
      botId: alpha.id,
      prompt: 'hold on',
      requestedBy: 'user',
      cwd: alpha.folders[0]!,
      additionalDirectories: [],
      engine: 'mock',
      model: null,
      effort: null,
      permissionMode: 'acceptEdits',
      instructions: '',
    });
  const holding = start();
  assert.throws(start, /the limit is 1/);
  await core.cancelTask(holding.id);
  await idle(core);
});

test('engine checks report whether each agent is ready, without model usage', async (t) => {
  const { core } = setup(t);
  assert.deepEqual(await core.checkEngines(), [
    { id: 'mock', label: 'Mock agent', ready: true, detail: 'The mock agent needs no sign-in.', canSignIn: false, canResume: false },
  ]);
  await assert.rejects(core.signInCommand('mock'), /already signed in/);
  await assert.rejects(core.signInCommand('nope'), /No engine/);
});

test('an approval left open when code-bot closed is put to the user again and resumes the sub-agent', async (t) => {
  const { core, store, projectBot, dir } = setup(t);
  const alpha = projectBot('alpha');
  core.sendToBot(alpha.id, 'task: needs permission');
  await waitFor(core, () => core.getThread(alpha.id).events.find((event) => event.type === 'request.surfaced'));
  await waitFor(core, () => core.listBots().every((bot) => !bot.status.busy));
  await core.shutdown();

  const again = new CodeBot({
    store,
    engines: [new MockEngine()],
    brain: new TestBrain(),
    workDir: join(dir, 'main-bot'),
    retentionIntervalMs: 0,
  });
  const [request] = again.listRequests();
  assert.equal(request?.held, true);
  assert.equal(again.listBots().find((bot) => bot.id === alpha.id)?.status.needsYou, 1);
  assert.throws(() => again.terminalLaunch(request!.taskId), /cannot be continued in a terminal/);

  again.respond(request!.taskId, request!.id, { decision: 'allow' });
  await waitFor(again, () => again.tasks.getTask(request!.taskId).state === 'done');
  assert.ok(taskTexts(again, request!.taskId).includes('Command approved and run.'));
  assert.ok(again.getThread(alpha.id).events.some((event) => event.type === 'request.closed'));
  assert.equal(again.listRequests().length, 0);
  await idle(again);
  await again.shutdown();
});
