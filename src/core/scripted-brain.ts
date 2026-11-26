import { randomUUID } from 'node:crypto';
import { MAIN_BOT_ID } from '../shared/types.ts';
import type { Brain, BrainEvent, BrainInput } from './brain.ts';
import { FROM_MAIN_HEADER, UPDATE_HEADER, withoutRecent } from './prompts.ts';
import { errorMessage } from './util.ts';

const TURN_COST_USD = 0.001;

/**
 * A scripted stand-in for the bots' model: deterministic and free, for tests
 * and for trying the app without model usage. Pair it with the mock engine.
 *
 * Main bot:
 *   "@name <text>"   sends <text> to the project bot called name
 *   a report         replies "<name> reports: <first line of the report>"
 * Project bot:
 *   "task: <brief>"  starts a sub-agent with that brief
 *   an update        "<id> finished: <first line of its report>", "<id> failed: …";
 *                    a question is answered "Red" when the sub-agent's brief
 *                    contains "lead-answers", and otherwise left for the user
 * Anything else is echoed back.
 */
export class ScriptedBrain implements Brain {
  /** Made-up cost per session, so usage shows up in demo mode: each turn costs $0.001. */
  private readonly sessionCosts = new Map<string, number>();

  async *run(input: BrainInput): AsyncGenerator<BrainEvent> {
    // Behave like a real model: never answer within the caller's own call.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const sessionId = input.sessionId ?? randomUUID();
    yield { type: 'session', sessionId };
    const reply = input.botId === MAIN_BOT_ID ? yield* this.main(input) : yield* this.project(input);
    const costUsd = (this.sessionCosts.get(sessionId) ?? 0) + TURN_COST_USD;
    this.sessionCosts.set(sessionId, costUsd);
    if (input.signal.aborted) {
      yield { type: 'result', ok: false, text: '', error: 'Stopped.', costUsd };
      return;
    }
    yield { type: 'text_delta', text: reply.slice(0, 6) };
    yield { type: 'text_delta', text: reply.slice(6) };
    yield { type: 'text', text: reply };
    yield { type: 'result', ok: true, text: reply, costUsd };
  }

  private async *main(input: BrainInput): AsyncGenerator<BrainEvent, string> {
    const reports = [...input.prompt.matchAll(/\[report from project bot "([^"]+)"[^\]]*\]\n<<<\n([\s\S]*?)\n>>>/g)];
    if (reports.length > 0) return reports.map((match) => `${match[1]} reports: ${firstLine(match[2])}`).join('\n');

    const delegate = /@([\p{L}\p{N}._-]+)\s+([\s\S]+)/u.exec(input.prompt);
    if (delegate) {
      const args = { bot: delegate[1]!, message: delegate[2]!.trim() };
      yield { type: 'tool', name: 'send_to_project_bot', input: args };
      try {
        await call(input, 'send_to_project_bot', args);
        return `Asked ${args.bot}.`;
      } catch (error) {
        return `Could not reach ${args.bot}: ${errorMessage(error)}`;
      }
    }
    return `echo: ${input.prompt}`;
  }

  private async *project(input: BrainInput): AsyncGenerator<BrainEvent, string> {
    const prompt = withoutRecent(input.prompt);
    if (prompt.startsWith(UPDATE_HEADER)) {
      const lines: string[] = [];
      const updates = prompt.matchAll(
        /Sub-agent (t_[0-9a-f]{10}) .*? (finished\.|failed:|asks a question \(request (r_[0-9a-f]{10})\))/g,
      );
      for (const match of updates) {
        const taskId = match[1]!;
        yield { type: 'tool', name: 'get_subagent', input: { id: taskId } };
        const info = (await call(input, 'get_subagent', { id: taskId })) as {
          brief?: string;
          final_report?: string;
          error?: string;
          open_requests?: { request_id: string; input: unknown }[];
        };
        if (match[2] === 'finished.') {
          lines.push(`${taskId} finished: ${firstLine(info.final_report)}`);
        } else if (match[2] === 'failed:') {
          lines.push(`${taskId} failed: ${firstLine(info.error ?? undefined)}`);
        } else {
          const requestId = match[3]!;
          if (info.brief?.includes('lead-answers')) {
            const request = info.open_requests?.find((candidate) => candidate.request_id === requestId);
            const args = { id: taskId, request_id: requestId, answers: { [firstQuestion(request?.input)]: 'Red' } };
            yield { type: 'tool', name: 'answer_subagent', input: args };
            await call(input, 'answer_subagent', args);
            lines.push(`Answered ${taskId}: Red.`);
          } else {
            lines.push(`Left ${taskId}'s question for the user.`);
          }
        }
      }
      return lines.join('\n') || 'Nothing to do.';
    }

    const body = prompt.startsWith(FROM_MAIN_HEADER) ? prompt.slice(FROM_MAIN_HEADER.length).trim() : prompt;
    const task = /task:\s*([\s\S]+)/i.exec(body);
    if (task) {
      const brief = task[1]!.trim();
      const args = { title: brief.slice(0, 60), brief };
      yield { type: 'tool', name: 'start_subagent', input: args };
      try {
        const started = (await call(input, 'start_subagent', args)) as { id: string };
        return `Started ${started.id}.`;
      } catch (error) {
        return `Could not start a sub-agent: ${errorMessage(error)}`;
      }
    }
    return `echo: ${body}`;
  }
}

async function call(input: BrainInput, name: string, args: Record<string, unknown>): Promise<unknown> {
  const tool = input.tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`No tool named ${name}`);
  return tool.run(args);
}

function firstLine(text: string | undefined): string {
  return (text ?? '').trim().split(/\r?\n/, 1)[0] ?? '';
}

function firstQuestion(input: unknown): string {
  const questions = (input as { questions?: { question?: string }[] } | undefined)?.questions;
  return questions?.[0]?.question ?? 'Which colour?';
}
