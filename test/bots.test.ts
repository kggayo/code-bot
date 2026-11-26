import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CodeBot } from '../src/core/code-bot.ts';
import { MockEngine } from '../src/core/engines/mock.ts';
import { UPDATE_HEADER } from '../src/core/prompts.ts';
import { CodeBotError } from '../src/core/util.ts';
import { MAIN_BOT_ID } from '../src/shared/types.ts';
import type { ClosedData, InboundData, SurfacedData, TurnEndData } from '../src/shared/types.ts';
import { TestBrain, idle, mockSubagents, setup, taskTexts, texts, threadTypes, tick, waitFor } from './helpers.ts';

test('a project bot runs a sub-agent for the user and reports in its own conversation', async (t) => {
  const { core, projectBot } = setup(t);
  const alpha = projectBot('alpha', {
    subagents: mockSubagents({ model: 'dev-model', effort: 'high' }),
  });

  core.sendToBot(alpha.id, 'task: add a health endpoint');
  const report = await waitFor(core, () => texts(core, alpha.id).find((text) => text.includes('finished:')));
  assert.match(report, /^t_[0-9a-f]{10} finished: echo\[dev-model\/high\]: add a health endpoint$/);

  const [task] = core.listTasks({ botId: alpha.id });
  assert.equal(task?.requestedBy, 'user');
  assert.equal(task?.state, 'done');
  assert.equal(texts(core, alpha.id)[0], `Started ${task?.id}.`);

  await idle(core);
  // The main bot was not involved, and nothing was passed on.
  assert.deepEqual(core.getThread(MAIN_BOT_ID).events, []);
  const ends = core.getThread(alpha.id).events.filter((event) => event.type === 'turn.end');
  assert.ok(ends.every((event) => (event.data as TurnEndData).forwardedTo === undefined));
  assert.deepEqual(
    threadTypes(core, alpha.id).filter((type) => ['subagent.started', 'inbound'].includes(type)),
    ['subagent.started', 'inbound'],
  );
});

test('the main bot delegates to a project bot, and the project bot reports back to it', async (t) => {
  const { core, projectBot } = setup(t);
  const alpha = projectBot('alpha');

  core.sendToBot(MAIN_BOT_ID, '@alpha task: fix the login bug');
  await waitFor(core, () => texts(core, MAIN_BOT_ID).join('\n').includes('finished:'));
  await idle(core);

  const [task] = core.listTasks({ botId: alpha.id });
  assert.ok(task);
  assert.equal(task.requestedBy, 'main');
  const mainSays = texts(core, MAIN_BOT_ID).join('\n');
  assert.match(mainSays, /^Asked alpha\.\nalpha reports: Started t_[0-9a-f]{10}\.\n/);
  assert.match(mainSays, new RegExp(`alpha reports: ${task.id} finished: echo\\[default/default\\]: fix the login bug$`));

  // The project bot saw the main bot's message in its own conversation, and its replies were passed on.
  const projectEvents = core.getThread(alpha.id).events;
  assert.deepEqual(projectEvents.find((event) => event.type === 'inbound')?.data, {
    from: 'main',
    text: 'task: fix the login bug',
  } satisfies InboundData);
  const ends = projectEvents.filter((event) => event.type === 'turn.end').map((event) => event.data as TurnEndData);
  assert.equal(ends.length, 2);
  assert.ok(ends.every((end) => end.forwardedTo === 'main'));

  // The main conversation shows the reports it received.
  const reports = core
    .getThread(MAIN_BOT_ID)
    .events.filter((event) => event.type === 'inbound')
    .map((event) => event.data as InboundData);
  assert.equal(reports.length, 2);
  assert.ok(reports.every((report) => report.from === 'project' && report.name === 'alpha'));
});

test("a project bot answers its sub-agent's question when the answer is clear", async (t) => {
  const { core, projectBot } = setup(t);
  const alpha = projectBot('alpha');

  core.sendToBot(alpha.id, 'task: ask lead-answers');
  await waitFor(core, () => texts(core, alpha.id).find((text) => text.includes('finished:')));
  const [task] = core.listTasks({ botId: alpha.id });
  assert.ok(task);

  assert.ok(taskTexts(core, task.id).includes('You answered: Red'));
  assert.ok(texts(core, alpha.id).includes(`Answered ${task.id}: Red.`));
  const resolved = core.getTask(task.id).events.find((event) => event.type === 'request.resolved');
  assert.equal((resolved?.data as { by: string }).by, 'bot');
  // Nothing was put to the user.
  assert.ok(!threadTypes(core, alpha.id).includes('request.surfaced'));
  assert.ok(!threadTypes(core, MAIN_BOT_ID).includes('request.surfaced'));
});

test('a question the project bot leaves open goes to the user where the work was asked for', async (t) => {
  const { core, projectBot } = setup(t);
  const alpha = projectBot('alpha');
  const mainNeeds = () => core.listBots().find((bot) => bot.id === MAIN_BOT_ID)?.status.needsYou;

  // Asked for through the main bot: the card appears in the main conversation.
  core.sendToBot(MAIN_BOT_ID, '@alpha task: ask the user');
  const surfaced = await waitFor(core, () =>
    core.getThread(MAIN_BOT_ID).events.find((event) => event.type === 'request.surfaced'),
  );
  const { request, botName, taskTitle } = surfaced.data as SurfacedData;
  assert.equal(botName, 'alpha');
  assert.equal(taskTitle, 'ask the user');
  assert.equal(request.kind, 'question');
  assert.equal(mainNeeds(), 1);
  assert.ok(texts(core, alpha.id).includes(`Left ${request.taskId}'s question for the user.`));

  core.respond(request.taskId, request.id, { decision: 'allow', answers: { 'Which colour?': 'Blue' } });
  // The closed card keeps what was answered, so the conversation shows it.
  assert.deepEqual(core.getThread(MAIN_BOT_ID).events.find((event) => event.type === 'request.closed')?.data, {
    requestId: request.id,
    decision: 'allow',
    by: 'user',
    answers: { 'Which colour?': 'Blue' },
  } satisfies ClosedData);
  await waitFor(core, () => texts(core, MAIN_BOT_ID).join('\n').includes('finished:'));
  assert.ok(taskTexts(core, request.taskId).includes('You answered: Blue'));
  assert.equal(mainNeeds(), 0);

  // Asked for directly: the card appears in the project bot's conversation.
  core.sendToBot(alpha.id, 'task: ask me too');
  const direct = await waitFor(core, () => core.getThread(alpha.id).events.find((event) => event.type === 'request.surfaced'));
  assert.equal((direct.data as SurfacedData).request.surfacedIn, alpha.threadId);
  assert.equal(core.listBots().find((bot) => bot.id === alpha.id)?.status.needsYou, 1);
});

test('approvals go straight to the user, never through the project bot', async (t) => {
  const { core, projectBot } = setup(t);
  const alpha = projectBot('alpha');

  core.sendToBot(MAIN_BOT_ID, '@alpha task: needs permission');
  const surfaced = await waitFor(core, () =>
    core.getThread(MAIN_BOT_ID).events.find((event) => event.type === 'request.surfaced'),
  );
  const { request } = surfaced.data as SurfacedData;
  assert.equal(request.kind, 'permission');
  assert.equal(request.summary, 'Run npm test');
  const askedLead = core
    .getThread(alpha.id)
    .events.some((event) => event.type === 'inbound' && /asks a question/.test((event.data as InboundData).text));
  assert.equal(askedLead, false);

  core.respond(request.taskId, request.id, { decision: 'allow' });
  await waitFor(core, () => texts(core, MAIN_BOT_ID).join('\n').includes('finished:'));
  assert.ok(taskTexts(core, request.taskId).includes('Command approved and run.'));
});

test('a question waits for a busy project bot only so long before it goes to the user', async (t) => {
  const { core, brain, projectBot } = setup(t, { questionTimeoutMs: 80 });
  const alpha = projectBot('alpha');
  let release!: () => void;
  const stuck = new Promise<void>((resolve) => {
    release = resolve;
  });
  brain.overrides.set(alpha.id, async (input, tools) => {
    if (input.prompt.startsWith(UPDATE_HEADER)) {
      await stuck;
      return 'Back.';
    }
    const started = (await tools.call('start_subagent', { title: 'Pick', brief: 'ask which colour' })) as { id: string };
    return `Started ${started.id}.`;
  });

  core.sendToBot(alpha.id, 'go');
  const surfaced = await waitFor(core, () => core.getThread(alpha.id).events.find((event) => event.type === 'request.surfaced'));
  assert.equal((surfaced.data as SurfacedData).request.kind, 'question');
  release();
});

test("a project bot can only reach its own sub-agents, and cannot approve actions or loosen permissions", async (t) => {
  const { core, brain, projectBot } = setup(t);
  const alpha = projectBot('alpha');
  const beta = projectBot('beta');

  core.sendToBot(alpha.id, 'task: hold until told');
  const [alphaTask] = await waitFor(core, () => {
    const tasks = core.listTasks({ botId: alpha.id });
    return tasks.length ? tasks : undefined;
  });
  assert.ok(alphaTask);

  const outcomes: Record<string, string> = {};
  const attempt = async (label: string, run: () => Promise<unknown>) => {
    try {
      await run();
      outcomes[label] = 'ok';
    } catch (error) {
      outcomes[label] = (error as Error).message;
    }
  };
  brain.overrides.set(beta.id, async (_input, tools) => {
    assert.deepEqual(tools.names(), [
      'list_subagents',
      'start_subagent',
      'get_subagent',
      'send_to_subagent',
      'answer_subagent',
      'cancel_subagent',
      'git',
    ]);
    await attempt('read other', () => tools.call('get_subagent', { id: alphaTask.id }));
    await attempt('stop other', () => tools.call('cancel_subagent', { id: alphaTask.id }));
    await attempt('loosen', () =>
      tools.call('start_subagent', { title: 'x', brief: 'echo', permission_mode: 'bypassPermissions' }),
    );
    const own = (await tools.call('start_subagent', { title: 'Tests', brief: 'needs permission' })) as { id: string };
    await waitFor(core, () => core.listRequests().find((request) => request.taskId === own.id));
    const [request] = core.listRequests().filter((candidate) => candidate.taskId === own.id);
    await attempt('approve', () => tools.call('answer_subagent', { id: own.id, request_id: request?.id, answers: { a: 'b' } }));
    return 'done';
  });

  core.sendToBot(beta.id, 'probe');
  await waitFor(core, () => texts(core, beta.id).includes('done'));
  assert.equal(outcomes['read other'], `No sub-agent "${alphaTask.id}" in this project`);
  assert.equal(outcomes['stop other'], `No sub-agent "${alphaTask.id}" in this project`);
  assert.match(outcomes.loosen ?? '', /at most "acceptEdits"/);
  assert.equal(outcomes.approve, 'Approvals for actions are for the user to decide, not the project bot');
  assert.equal(core.tasks.getTask(alphaTask.id).state, 'running');
});

test("sub-agents work in the project bot's folders", async (t) => {
  const { core, brain, folder, projectBot } = setup(t);
  const api = folder('api');
  const web = folder('web');
  const shop = projectBot('shop', { folders: [api, web] });

  brain.overrides.set(shop.id, async (_input, tools) => {
    const started = (await tools.call('start_subagent', { title: 'Web', brief: 'build the page', folder: web })) as {
      id: string;
    };
    return `Started ${started.id}.`;
  });
  core.sendToBot(shop.id, 'go');
  const [task] = await waitFor(core, () => {
    const tasks = core.listTasks({ botId: shop.id });
    return tasks[0]?.state === 'done' ? tasks : undefined;
  });
  assert.equal(task?.cwd, web);
  assert.deepEqual(task?.additionalDirectories, [api]);
  assert.match(task?.lastResult ?? '', /^echo\[default\/default \+1 folder\(s\)\]: build the page$/);
  assert.match(task?.instructions ?? '', /The project also includes: /);
});

test('project bots are validated, renamed and removed safely', async (t) => {
  const { core, folder, projectBot } = setup(t);
  const alpha = projectBot('alpha');
  const code = (run: () => unknown) => {
    try {
      run();
      return 'ok';
    } catch (error) {
      return error instanceof CodeBotError ? `${error.code}: ${error.message}` : String(error);
    }
  };
  const base = {
    description: '',
    instructions: '',
    model: null,
    effort: null,
    subagents: mockSubagents(),
  };

  assert.match(code(() => core.createBot({ ...base, name: 'ALPHA', folders: [folder('x')] })), /^conflict: /);
  assert.match(code(() => core.createBot({ ...base, name: 'Main', folders: [folder('x')] })), /reserved/);
  assert.match(code(() => core.createBot({ ...base, name: 'gamma', folders: [] })), /at least one project folder/);
  assert.match(code(() => core.createBot({ ...base, name: 'gamma', folders: ['relative/path'] })), /full path/);
  assert.match(code(() => core.createBot({ ...base, name: 'gamma', folders: [`${folder('x')}-missing`] })), /Folder not found/);
  assert.match(code(() => core.createBot({ ...base, name: 'gamma', folders: [folder('x')], effort: 'huge' as never })), /Effort/);
  assert.match(
    code(() => core.createBot({ ...base, name: 'gamma', folders: [folder('x')], subagents: { ...base.subagents, engine: 'nope' } })),
    /Unknown engine/,
  );

  const renamed = core.updateBot(alpha.id, { name: 'alpha-2', model: 'opus', effort: 'high' });
  assert.equal(renamed.id, alpha.id);
  assert.equal(renamed.name, 'alpha-2');
  assert.deepEqual([renamed.model, renamed.effort], ['opus', 'high']);
  const main = core.updateBot(MAIN_BOT_ID, { name: 'ignored', model: 'sonnet', effort: 'low' });
  assert.deepEqual([main.name, main.model, main.effort], ['Main bot', 'sonnet', 'low']);

  core.sendToBot(alpha.id, 'task: hold on');
  await waitFor(core, () => core.activeSubagents() === 1);
  assert.match(code(() => core.archiveBot(alpha.id)), /^conflict: .*still has 1 sub-agent/);
  const [task] = core.listTasks({ botId: alpha.id });
  await core.cancelTask(task!.id);
  await idle(core);
  core.archiveBot(alpha.id);
  assert.deepEqual(
    core.listBots().map((bot) => bot.name),
    ['Main bot'],
  );
  assert.match(code(() => core.archiveBot(MAIN_BOT_ID)), /cannot be removed/);
});

test('project folders are stored as canonical paths', async (t) => {
  const { core } = setup(t);
  // os.tmpdir() can be a Windows short name (C:\Users\ABCDEF~1\...); agents would then
  // treat files in the project as outside it.
  const given = mkdtempSync(join(tmpdir(), 'code-bot-canonical-'));
  t.after(() => rmSync(given, { recursive: true, force: true }));
  const bot = core.createBot({
    name: 'canonical',
    description: '',
    folders: [given],
    instructions: '',
    model: null,
    effort: null,
    subagents: mockSubagents(),
  });
  assert.deepEqual(bot.folders, [realpathSync.native(given)]);
});

test('a new conversation keeps waiting questions and approvals in view', async (t) => {
  const { core, projectBot } = setup(t);
  projectBot('alpha');

  core.sendToBot(MAIN_BOT_ID, '@alpha task: needs permission');
  const surfaced = await waitFor(core, () =>
    core.getThread(MAIN_BOT_ID).events.find((event) => event.type === 'request.surfaced'),
  );
  const before = core.getThread(MAIN_BOT_ID).threadId;

  const fresh = core.newConversation(MAIN_BOT_ID);
  assert.notEqual(fresh.threadId, before);
  assert.deepEqual(
    fresh.events.map((event) => event.type),
    ['thread.reset', 'request.surfaced'],
  );
  assert.equal(
    (fresh.events[1]?.data as SurfacedData).request.id,
    (surfaced.data as SurfacedData).request.id,
  );
  assert.equal(core.listBots().find((bot) => bot.id === MAIN_BOT_ID)?.status.needsYou, 1);
});

test('bots and history survive a restart; working sub-agents become interrupted', async (t) => {
  const { core, store, projectBot } = setup(t);
  const alpha = projectBot('alpha');
  core.sendToBot(alpha.id, 'task: hold forever');
  await waitFor(core, () => core.activeSubagents() === 1);
  const [task] = core.listTasks({ botId: alpha.id });

  const again = new CodeBot({
    store,
    engines: [new MockEngine()],
    brain: new TestBrain(),
    workDir: `${alpha.folders[0]}-main`,
    retentionIntervalMs: 0,
    usageIntervalMs: 0,
    routineTickMs: 0,
  });
  assert.equal(again.tasks.getTask(task!.id).state, 'interrupted');
  assert.deepEqual(
    again.listBots().map((bot) => bot.name),
    ['Main bot', 'alpha'],
  );
  assert.ok(again.getThread(alpha.id).events.length > 0);
  await tick();
});
