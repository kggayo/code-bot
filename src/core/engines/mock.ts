import { randomUUID } from 'node:crypto';
import type { AskUser, Engine, EngineCheck, EngineEvent, EngineRun, EngineRunOptions } from './types.ts';

/** What one mock run costs, so budget limits can be tested. */
const RUN_COST_USD = 0.01;
/** Turns a "long" task needs, so turn limits can be tested. */
const LONG_TASK_TURNS = 3;

/**
 * A scripted stand-in for a coding agent, for tests and for trying the app
 * without spending model usage. Keywords in the prompt pick the behaviour:
 *   "ask"         asks a question ("Which colour?", Red or Blue) and repeats the answer
 *   "permission"  requests approval to run "npm test" and reports the decision
 *   "approval"    the same, so a note about an approval given after a restart repeats the call
 *   "hold"        keeps working until a message arrives or it is interrupted
 *   "slow"        takes about a second before finishing
 *   "long"        needs 3 turns, so a lower maxTurns stops it
 *   "fail"        ends the turn with an error
 * Anything else is echoed back as "echo[model/effort]: prompt". Each run
 * costs $0.01 (cumulative per session), so maxBudgetUsd below that stops it.
 */
export class MockEngine implements Engine {
  readonly id = 'mock';
  readonly label = 'Mock agent';
  private readonly sessionCosts = new Map<string, number>();

  async check(): Promise<EngineCheck> {
    return { ready: true, detail: 'The mock agent needs no sign-in.' };
  }

  start(options: EngineRunOptions, askUser: AskUser): EngineRun {
    const abort = new AbortController();
    const inbox: string[] = [];
    let notify: (() => void) | undefined;
    let ended = false;
    const sessionCosts = this.sessionCosts;

    const nextMessage = () =>
      new Promise<string | undefined>((resolve) => {
        const deliver = () => {
          notify = undefined;
          abort.signal.removeEventListener('abort', deliver);
          resolve(inbox.shift());
        };
        if (inbox.length > 0 || abort.signal.aborted) return deliver();
        notify = deliver;
        abort.signal.addEventListener('abort', deliver);
      });

    const pause = (ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        abort.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        });
      });

    async function* events(): AsyncGenerator<EngineEvent> {
      const prompt = options.prompt;
      const sessionId = options.resumeSessionId ?? randomUUID();
      const costSoFar = sessionCosts.get(sessionId) ?? 0;
      try {
        yield { type: 'session', sessionId, model: options.model ?? 'mock-1' };
        if (options.resumeSessionId) yield { type: 'text', text: '(continuing the earlier session)' };

        if (options.maxBudgetUsd !== undefined && options.maxBudgetUsd < RUN_COST_USD) {
          yield { type: 'result', ok: false, text: '', error: 'error_max_budget_usd', limit: 'budget', costUsd: costSoFar };
          return;
        }
        const costUsd = costSoFar + RUN_COST_USD;
        sessionCosts.set(sessionId, costUsd);

        if (/\bfail\b/i.test(prompt)) {
          yield { type: 'result', ok: false, text: '', error: 'The mock agent was told to fail.', costUsd };
          return;
        }
        if (/\blong\b/i.test(prompt) && options.maxTurns !== undefined && options.maxTurns < LONG_TASK_TURNS) {
          yield { type: 'text', text: 'Working on the long task…' };
          yield { type: 'result', ok: false, text: '', error: 'error_max_turns', limit: 'turns', costUsd, numTurns: options.maxTurns };
          return;
        }
        if (/\bslow\b/i.test(prompt)) {
          await pause(1200);
          if (abort.signal.aborted) {
            yield { type: 'result', ok: false, text: '', error: 'Interrupted.', costUsd };
            return;
          }
        }
        if (/\bask\b/i.test(prompt)) {
          const question = 'Which colour?';
          const response = await askUser(
            {
              kind: 'question',
              tool: 'AskUserQuestion',
              input: {
                questions: [
                  {
                    question,
                    header: 'Colour',
                    multiSelect: false,
                    options: [
                      { label: 'Red', description: 'Warm' },
                      { label: 'Blue', description: 'Cool' },
                    ],
                  },
                ],
              },
            },
            abort.signal,
          );
          const answer =
            response.decision === 'allow'
              ? (response.answers?.[question] ?? '(no answer)')
              : `declined: ${response.message ?? ''}`;
          yield { type: 'text', text: `You answered: ${answer}` };
        }
        if (/\b(permission|approval)\b/i.test(prompt)) {
          yield { type: 'tool_use', id: 'tool_1', name: 'Bash', input: { command: 'npm test' } };
          const response = await askUser(
            { kind: 'permission', tool: 'Bash', input: { command: 'npm test' }, summary: 'Run npm test' },
            abort.signal,
          );
          yield {
            type: 'tool_result',
            id: 'tool_1',
            isError: response.decision === 'deny',
            preview: response.decision === 'allow' ? 'tests passed' : 'not allowed',
          };
          yield { type: 'text', text: response.decision === 'allow' ? 'Command approved and run.' : 'Command was denied.' };
        }
        if (/\bhold\b/i.test(prompt)) {
          const message = await nextMessage();
          if (message === undefined) {
            yield { type: 'result', ok: false, text: '', error: 'Interrupted.', costUsd };
            return;
          }
          yield { type: 'text', text: `Steered with: ${message}` };
        }

        const where = options.additionalDirectories?.length ? ` +${options.additionalDirectories.length} folder(s)` : '';
        const reply = `echo[${options.model ?? 'default'}/${options.effort ?? 'default'}${where}]: ${prompt}`;
        yield { type: 'text_delta', text: reply.slice(0, 8) };
        yield { type: 'text_delta', text: reply.slice(8) };
        yield { type: 'text', text: reply };
        yield { type: 'result', ok: true, text: reply, costUsd, durationMs: 1, numTurns: 1 };
      } catch (error) {
        yield { type: 'result', ok: false, text: '', error: error instanceof Error ? error.message : String(error) };
      } finally {
        ended = true;
      }
    }

    return {
      events: events(),
      send: (text) => {
        if (ended) return false;
        inbox.push(text);
        notify?.();
        return true;
      },
      interrupt: async () => {
        abort.abort();
      },
    };
  }
}
