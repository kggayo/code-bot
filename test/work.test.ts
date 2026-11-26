import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claudeUsageWindows } from '../src/core/engines/claude.ts';
import { codexUsage } from '../src/core/engines/codex.ts';
import { RECENT_HEADER, UPDATE_HEADER } from '../src/core/prompts.ts';
import { cleanSchedule, nextRun } from '../src/core/routines.ts';
import { MAIN_BOT_ID } from '../src/shared/types.ts';
import type { RoutineRunData, Task } from '../src/shared/types.ts';
import { idle, mockSubagents, setup, texts, tick, waitFor } from './helpers.ts';

// ---- one developer per piece of work ------------------------------------------------

test('a QA sub-agent is tied to the developer it checks, and its findings are steered back to that developer', async (t) => {
  const { core, brain, projectBot } = setup(t);
  const alpha = projectBot('alpha');
  const updates: string[] = [];
  let developer = '';
  brain.overrides.set(alpha.id, async (input, tools) => {
    if (input.prompt.startsWith(UPDATE_HEADER)) {
      updates.push(input.prompt);
      return 'Noted.';
    }
    if (input.prompt.startsWith('build')) {
      developer = ((await tools.call('start_subagent', { title: 'Build it', brief: 'build the page' })) as { id: string }).id;
      return `Started ${developer}.`;
    }
    const qa = (await tools.call('start_subagent', {
      title: 'Test it',
      brief: 'test the page',
      role: 'qa',
      for_subagent: developer,
    })) as { id: string; role: string; for_subagent: string };
    assert.equal(qa.role, 'qa');
    assert.equal(qa.for_subagent, developer);
    return `Started ${qa.id}.`;
  });

  core.sendToBot(alpha.id, 'build the page');
  await waitFor(core, () => core.listTasks({ botId: alpha.id })[0]?.state === 'done');
  await idle(core);
  core.sendToBot(alpha.id, 'now test it');
  await waitFor(core, () => updates.some((prompt) => prompt.includes('(QA of')));
  await idle(core);

  const qaTask = core.listTasks({ botId: alpha.id }).find((task) => task.role === 'qa') as Task;
  assert.equal(qaTask.forTaskId, developer);
  assert.equal(core.listTasks({ botId: alpha.id }).find((task) => task.id === developer)?.role, 'developer');
  const qaUpdate = updates.find((prompt) => prompt.includes(qaTask.id)) ?? '';
  assert.match(qaUpdate, new RegExp(`Sub-agent ${qaTask.id} "Test it" \\(QA of ${developer}\\) finished`));
  assert.match(qaUpdate, new RegExp(`send them to developer ${developer} with send_to_subagent`));
});

test('a follow-up for a developer is refused as a new sub-agent, and the lead sees its recent sub-agents', async (t) => {
  const { core, brain, projectBot } = setup(t);
  const alpha = projectBot('alpha');
  const prompts: string[] = [];
  let developer = '';
  let refusal = '';
  brain.overrides.set(alpha.id, async (input, tools) => {
    if (input.prompt.startsWith(UPDATE_HEADER)) return 'Noted.';
    prompts.push(input.prompt);
    if (!developer) {
      developer = ((await tools.call('start_subagent', { title: 'Investigate the bug', brief: 'look into it' })) as { id: string }).id;
      return `Started ${developer}.`;
    }
    try {
      await tools.call('start_subagent', { title: 'Fix it', brief: 'fix it', for_subagent: developer });
    } catch (error) {
      refusal = (error as Error).message;
    }
    await tools.call('send_to_subagent', { id: developer, text: 'The user says: fix it.' });
    return `Continued ${developer}.`;
  });

  core.sendToBot(alpha.id, 'investigate the bug');
  await waitFor(core, () => core.listTasks({ botId: alpha.id })[0]?.state === 'done');
  await idle(core);
  core.sendToBot(alpha.id, 'please fix it');
  await waitFor(core, () => texts(core, alpha.id).includes(`Continued ${developer}.`));
  await idle(core);

  // The first message had no sub-agents to list; the second lists the developer.
  assert.ok(!prompts[0]?.includes(RECENT_HEADER));
  assert.ok(prompts[1]?.startsWith('please fix it\n\n'));
  assert.match(prompts[1] ?? '', new RegExp(`- ${developer} developer "Investigate the bug": finished`));
  assert.match(refusal, /use send_to_subagent/);
  assert.equal(core.listTasks({ botId: alpha.id }).length, 1, 'still one sub-agent for the one piece of work');
});

test('a sub-agent started to investigate in plan mode can be let loose for the fix, up to the project setting', async (t) => {
  const { core, brain, projectBot } = setup(t);
  const alpha = projectBot('alpha', { subagents: mockSubagents({ permissionMode: 'acceptEdits' }) });
  let developer = '';
  let tooLoose = '';
  brain.overrides.set(alpha.id, async (input, tools) => {
    if (input.prompt.startsWith(UPDATE_HEADER)) return 'Noted.';
    if (!developer) {
      developer = ((await tools.call('start_subagent', { title: 'Look', brief: 'look first', permission_mode: 'plan' })) as { id: string })
        .id;
      return 'Started.';
    }
    try {
      await tools.call('send_to_subagent', { id: developer, text: 'go wild', permission_mode: 'bypassPermissions' });
    } catch (error) {
      tooLoose = (error as Error).message;
    }
    await tools.call('send_to_subagent', { id: developer, text: 'now fix it', permission_mode: 'acceptEdits' });
    return 'Continued.';
  });

  core.sendToBot(alpha.id, 'look');
  await waitFor(core, () => core.listTasks({ botId: alpha.id })[0]?.state === 'done');
  await idle(core);
  assert.equal(core.getTask(developer).task.permissionMode, 'plan');
  core.sendToBot(alpha.id, 'fix');
  await waitFor(core, () => texts(core, alpha.id).includes('Continued.'));
  await idle(core);

  assert.match(tooLoose, /at most "acceptEdits"/);
  const { task, events } = core.getTask(developer);
  assert.equal(task.permissionMode, 'acceptEdits');
  assert.deepEqual(
    events.filter((event) => event.type === 'settings').map((event) => event.data),
    [{ permissionMode: 'acceptEdits' }],
  );
});

// ---- usage ----------------------------------------------------------------------

test('bots and sub-agents add up their usage, and the plan limits are read from the engines', async (t) => {
  const { core, projectBot } = setup(t);
  const alpha = projectBot('alpha');
  core.sendToBot(MAIN_BOT_ID, '@alpha task: add a page');
  await waitFor(core, () => texts(core, MAIN_BOT_ID).join('\n').includes('finished:'));
  await idle(core);

  const [main, project] = core.listBots();
  assert.equal(project?.id, alpha.id);
  // The mock sub-agent costs $0.01 a run; each scripted bot turn $0.001 (cumulative per session).
  assert.equal(project?.status.usage.subagentsUsd, 0.01);
  assert.ok((project?.status.usage.botUsd ?? 0) > 0);
  assert.equal(project?.status.usage.projectBotsUsd, 0);
  assert.equal(main?.status.usage.subagentsUsd, 0.01);
  assert.equal(main?.status.usage.projectBotsUsd, project?.status.usage.botUsd);
  assert.ok((main?.status.usage.botUsd ?? 0) > 0);

  const usage = await core.getUsage();
  assert.equal(usage.length, 1);
  assert.equal(usage[0]?.engineId, 'mock');
  assert.equal(usage[0]?.windows[0]?.label, '5-hour session');
  assert.equal(usage[0]?.windows[0]?.usedPercent, 12);
});

test("the engines' limit reports become windows people can read", () => {
  // Claude Code's /usage rows (the shape of Claude Code 2.x on a Max plan).
  const claude = claudeUsageWindows({
    five_hour: { utilization: 5, resets_at: '2026-11-26T07:10:00.288963+00:00' },
    limits: [
      { kind: 'session', group: 'session', percent: 6, severity: 'normal', resets_at: '2026-11-26T07:09:59.96+00:00', scope: null },
      { kind: 'weekly_all', group: 'weekly', percent: 1, severity: 'normal', resets_at: '2026-12-02T21:59:59.96+00:00', scope: null },
      { kind: 'weekly_scoped', group: 'weekly', percent: 0, severity: 'warning', resets_at: null, scope: { model: { display_name: 'Opus' } } },
    ],
  });
  assert.deepEqual(
    claude.map((window) => [window.id, window.label, window.usedPercent, window.severity]),
    [
      ['session', '5-hour session', 6, 'normal'],
      ['weekly_all', 'Week · all models', 1, 'normal'],
      ['weekly_scoped:opus', 'Week · Opus', 0, 'warning'],
    ],
  );
  assert.equal(claude[0]?.resetsAt, '2026-11-26T07:09:59.960Z');
  // Without rows, the named windows.
  assert.deepEqual(
    claudeUsageWindows({ five_hour: { utilization: 5, resets_at: null }, seven_day: null }).map((window) => window.label),
    ['5-hour session'],
  );

  // Codex's account/rateLimits/read (codex-cli 0.160.1).
  const codex = codexUsage({
    rateLimits: {
      primary: { usedPercent: 3, windowDurationMins: 10080, resetsAt: 1795689543 },
      secondary: { usedPercent: 40, windowDurationMins: 300, resetsAt: null },
      planType: 'plus',
    },
  });
  assert.equal(codex.plan, 'plus');
  assert.deepEqual(
    codex.windows.map((window) => [window.label, window.usedPercent]),
    [
      ['Week', 3],
      ['5-hour window', 40],
    ],
  );
  assert.equal(codex.windows[0]?.resetsAt, new Date(1795689543 * 1000).toISOString());
  assert.equal(codexUsage({ ordinaryUsageAllowed: false, rateLimits: {} }).note, 'Codex says the plan limit is reached.');
});

// ---- routines ---------------------------------------------------------------------

test('schedules: daily on chosen weekdays, once, and every so many minutes', () => {
  // Thursday 26 November 2026, 10:30 local time.
  const now = new Date(2026, 10, 26, 10, 30);
  const weekdays = cleanSchedule({ kind: 'daily', time: '09:00', days: [5, 1, 2, 3, 4, 1] });
  assert.deepEqual(weekdays, { kind: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] });
  assert.equal(nextRun(weekdays, now)?.getTime(), new Date(2026, 10, 27, 9, 0).getTime(), 'tomorrow, Friday');
  const later = cleanSchedule({ kind: 'daily', time: '11:00', days: [4] });
  assert.equal(nextRun(later, now)?.getTime(), new Date(2026, 10, 26, 11, 0).getTime(), 'later today');
  const friday = new Date(2026, 10, 27, 9, 30);
  assert.equal(nextRun(weekdays, friday)?.getTime(), new Date(2026, 10, 30, 9, 0).getTime(), 'Monday after the weekend');

  const once = cleanSchedule({ kind: 'once', at: new Date(2026, 10, 26, 12, 0).toISOString() });
  assert.equal(nextRun(once, now)?.getTime(), new Date(2026, 10, 26, 12, 0).getTime());
  assert.equal(nextRun(once, new Date(2026, 10, 26, 13, 0)), null);

  const hourly = cleanSchedule({ kind: 'interval', minutes: 60 });
  const anchor = new Date(2026, 10, 26, 8, 15);
  assert.equal(nextRun(hourly, now, anchor)?.getTime(), new Date(2026, 10, 26, 11, 15).getTime(), 'keeps its rhythm');

  assert.throws(() => cleanSchedule({ kind: 'daily', time: '9am', days: [1] }), /HH:MM/);
  assert.throws(() => cleanSchedule({ kind: 'daily', time: '09:00', days: [] }), /at least one day/);
  assert.throws(() => cleanSchedule({ kind: 'interval', minutes: 5 }), /15 minutes/);
  assert.throws(() => cleanSchedule({ kind: 'weekly' }), /once, daily/);
});

test('a routine that comes due is put to its bot as a message, and plans its next run', async (t) => {
  const { core, brain, projectBot } = setup(t);
  const alpha = projectBot('alpha');
  const prompts: string[] = [];
  brain.overrides.set(alpha.id, async (input) => {
    prompts.push(input.prompt);
    return 'Checked the tickets.';
  });

  const routine = core.createRoutine({
    botId: alpha.id,
    title: 'Morning tickets',
    prompt: 'Check the new tickets and summarise them.',
    schedule: { kind: 'interval', minutes: 60 },
    enabled: true,
  });
  const planned = Date.parse(routine.nextRunAt ?? '');
  assert.ok(planned > Date.now() + 59 * 60_000 && planned <= Date.now() + 60 * 60_000);
  assert.deepEqual(
    core.listRoutines().map((item) => item.id),
    [routine.id],
  );

  // Not due yet: nothing happens.
  core.runDueRoutines(new Date());
  await tick(30);
  assert.equal(prompts.length, 0);

  // Due (and an hour late, as after the computer slept): it runs once and keeps its rhythm.
  const late = new Date(planned + 61 * 60_000);
  core.runDueRoutines(late);
  await waitFor(core, () => texts(core, alpha.id).includes('Checked the tickets.'));
  assert.equal(prompts.length, 1);
  assert.match(prompts[0] ?? '', /^\[routine "Morning tickets" - set up by the user, running on its schedule\]\nCheck the new tickets/);
  const run = core.getThread(alpha.id).events.find((event) => event.type === 'routine.run');
  assert.deepEqual(run?.data, {
    routineId: routine.id,
    title: 'Morning tickets',
    text: 'Check the new tickets and summarise them.',
    manual: false,
  } satisfies RoutineRunData);
  const after = core.listRoutines()[0];
  assert.equal(after?.lastRunAt, late.toISOString());
  assert.equal(after?.nextRunAt, new Date(planned + 2 * 60 * 60_000).toISOString());
});

test('a one-time routine runs once; routines can be run by hand, paused, and refuse a time that passed', async (t) => {
  const { core } = setup(t);
  const soon = new Date(Date.now() + 60_000).toISOString();
  const routine = core.createRoutine({
    botId: MAIN_BOT_ID,
    title: 'Ping',
    prompt: 'hello there',
    schedule: { kind: 'once', at: soon },
    enabled: true,
  });
  assert.equal(routine.nextRunAt, soon);
  assert.throws(
    () =>
      core.createRoutine({ botId: MAIN_BOT_ID, title: 'Late', prompt: 'x', schedule: { kind: 'once', at: new Date(0).toISOString() }, enabled: true }),
    /has passed/,
  );
  assert.throws(() => core.createRoutine({ botId: 'b_nope', title: 'x', prompt: 'x', schedule: { kind: 'interval', minutes: 60 }, enabled: true }), /No bot/);

  core.runDueRoutines(new Date(Date.parse(soon) + 1000));
  await waitFor(core, () => texts(core, MAIN_BOT_ID).includes('echo: [routine "Ping" - set up by the user, running on its schedule]\nhello there'));
  const done = core.listRoutines()[0];
  assert.equal(done?.enabled, false);
  assert.equal(done?.nextRunAt, null);

  // By hand: runs now, the schedule stays.
  core.runRoutine(routine.id);
  const manual = await waitFor(core, () =>
    core.getThread(MAIN_BOT_ID).events.filter((event) => event.type === 'routine.run')[1],
  );
  assert.equal((manual.data as RoutineRunData).manual, true);
  assert.ok(core.listRoutines()[0]?.lastRunAt);

  const paused = core.updateRoutine(routine.id, { schedule: { kind: 'daily', time: '07:30', days: [1, 3] }, enabled: false });
  assert.equal(paused.nextRunAt, null);
  const resumed = core.updateRoutine(routine.id, { enabled: true });
  assert.equal(new Date(resumed.nextRunAt ?? '').getHours(), 7);
  core.deleteRoutine(routine.id);
  assert.deepEqual(core.listRoutines(), []);
  await idle(core);
});
