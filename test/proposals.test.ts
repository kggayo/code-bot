import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAIN_BOT_ID } from '../src/shared/types.ts';
import type { RoutineProposal, RoutineProposalClosed } from '../src/shared/types.ts';
import { idle, setup, texts, waitFor } from './helpers.ts';

const proposals = (core: ReturnType<typeof setup>['core'], botId: string) =>
  core
    .getThread(botId)
    .events.filter((event) => event.type === 'routine.proposed')
    .map((event) => event.data as RoutineProposal);
const closings = (core: ReturnType<typeof setup>['core'], botId: string) =>
  core
    .getThread(botId)
    .events.filter((event) => event.type === 'routine.proposal.closed')
    .map((event) => event.data as RoutineProposalClosed);

test('a bot only proposes a routine; the user creates it from the card, once', async (t) => {
  const { core } = setup(t);
  const before = Date.now();
  core.sendToBot(MAIN_BOT_ID, 'every 30 minutes: check the open pull requests');
  await waitFor(core, () => texts(core, MAIN_BOT_ID).find((text) => text.startsWith('Proposed the routine')));
  await idle(core);

  const [proposal] = proposals(core, MAIN_BOT_ID);
  assert.ok(proposal);
  assert.equal(proposal.botId, MAIN_BOT_ID);
  assert.equal(proposal.botName, 'Main bot');
  assert.deepEqual(proposal.schedule, { kind: 'interval', minutes: 30 });
  assert.equal(proposal.prompt, 'check the open pull requests');
  const first = Date.parse(proposal.nextRunAt) - before;
  assert.ok(first > 29 * 60_000 && first < 31 * 60_000, `first run in ${first} ms`);
  // Nothing exists until the user says so.
  assert.deepEqual(core.listRoutines(), []);

  const routine = core.acceptRoutineProposal(MAIN_BOT_ID, proposal.id);
  assert.deepEqual(
    core.listRoutines().map((item) => [item.id, item.title, item.prompt, item.enabled]),
    [[routine.id, 'check the open pull requests', 'check the open pull requests', true]],
  );
  assert.deepEqual(closings(core, MAIN_BOT_ID), [{ id: proposal.id, outcome: 'created', routineId: routine.id }]);
  assert.throws(() => core.acceptRoutineProposal(MAIN_BOT_ID, proposal.id), /already created/);
  assert.throws(() => core.dismissRoutineProposal(MAIN_BOT_ID, proposal.id), /already created/);
});

test('the main bot can propose a routine for a project bot; a dismissed one is never created', async (t) => {
  const { core, brain, projectBot } = setup(t);
  const alpha = projectBot('alpha');
  const results: unknown[] = [];
  brain.overrides.set(MAIN_BOT_ID, async (_input, tools) => {
    results.push(
      await tools.call('propose_routine', {
        bot: 'alpha',
        title: 'Weekday stand-up notes',
        message: 'Summarise what your sub-agents did yesterday.',
        kind: 'daily',
        time: '09:00',
        days: ['mon', 'tue', 'wed', 'thu', 'fri'],
      }),
    );
    for (const bad of [
      { kind: 'interval', minutes: 5 },
      { kind: 'once', at: '2020-01-01T09:00' },
      { kind: 'daily', time: '9am', days: ['mon'] },
    ]) {
      await assert.rejects(Promise.resolve().then(() => tools.call('propose_routine', { title: 'x', message: 'y', ...bad })));
    }
    return 'Proposed.';
  });
  core.sendToBot(MAIN_BOT_ID, 'every weekday at 9 ask alpha for notes');
  await waitFor(core, () => texts(core, MAIN_BOT_ID).includes('Proposed.'));
  await idle(core);

  const [proposal, ...others] = proposals(core, MAIN_BOT_ID);
  assert.equal(others.length, 0, 'refused proposals leave no card');
  assert.equal(proposal?.botId, alpha.id);
  assert.deepEqual(proposal?.schedule, { kind: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] });
  assert.equal(new Date(proposal!.nextRunAt).getHours(), 9);
  assert.match(String((results[0] as { schedule: string }).schedule), /^at 09:00 on mon, tue, wed, thu, fri$/);

  core.dismissRoutineProposal(MAIN_BOT_ID, proposal!.id);
  assert.deepEqual(core.listRoutines(), []);
  assert.throws(() => core.acceptRoutineProposal(MAIN_BOT_ID, proposal!.id), /was dismissed/);
});

test("a project bot sees only its own routines, and an earlier conversation's proposal cannot be created", async (t) => {
  const { core, brain, projectBot } = setup(t);
  const alpha = projectBot('alpha');
  const beta = projectBot('beta');
  core.createRoutine({ botId: beta.id, title: 'Beta check', prompt: 'check beta', schedule: { kind: 'interval', minutes: 60 }, enabled: true });
  let listed: { routines: { title: string }[]; now: string } | undefined;
  brain.overrides.set(alpha.id, async (_input, tools) => {
    listed = (await tools.call('list_routines')) as typeof listed;
    return 'Listed.';
  });
  core.sendToBot(alpha.id, 'what is scheduled?');
  await waitFor(core, () => texts(core, alpha.id).includes('Listed.'));
  assert.deepEqual(listed?.routines, []);
  assert.ok(listed?.now);
  brain.overrides.delete(alpha.id);
  await idle(core);

  core.sendToBot(alpha.id, 'every 60 minutes: run the smoke tests');
  await waitFor(core, () => texts(core, alpha.id).find((text) => text.startsWith('Proposed the routine')));
  await idle(core);
  const [proposal] = proposals(core, alpha.id);
  assert.equal(proposal?.botId, alpha.id);
  core.newConversation(alpha.id);
  assert.throws(() => core.acceptRoutineProposal(alpha.id, proposal!.id), /No routine proposal .* in alpha's current conversation/);
  assert.equal(core.listRoutines().length, 1);
});
