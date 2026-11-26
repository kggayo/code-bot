import type { Requester, TurnEndData } from '../shared/types.ts';
import type { BotTool, Brain } from './brain.ts';
import { errorMessage } from './util.ts';

/** Something delivered to a bot, waiting for its turn. */
export type Inbound =
  /** Typed by the user in this bot's conversation. */
  | { kind: 'user'; text: string }
  /** From the main bot to a project bot. */
  | { kind: 'main'; text: string }
  /** From a project bot to the main bot. */
  | { kind: 'report'; fromBotId: string; text: string }
  /** A routine the user set up, due now (or run by hand). */
  | { kind: 'routine'; routineId: string; title: string; text: string }
  /** About one of a project bot's sub-agents. */
  | { kind: 'task'; taskId: string; event: 'question' | 'done' | 'failed'; requestId?: string; requester: Requester };

export interface PreparedTurn {
  prompt: string;
  /** Who the turn's reply is for. */
  replyTo: Requester;
  /** Set for turns about sub-agent questions: the reply is not passed on, and unanswered questions go to the user. */
  questionRequestIds: string[];
}

export interface TurnOutcome {
  ok: boolean;
  /** The final message of the turn. */
  text: string;
  error?: string;
  stopped: boolean;
}

export interface BrainOptions {
  systemPrompt: string;
  tools: BotTool[];
  model?: string;
  effort?: string;
  cwd: string;
  additionalDirectories: string[];
  access: 'none' | 'read';
}

/** What a runtime needs from the rest of code-bot. */
export interface RuntimeHost {
  /** Turns queued items into a prompt, or undefined when all of them are out of date. */
  prepare(botId: string, items: Inbound[]): PreparedTurn | undefined;
  brainOptions(botId: string): BrainOptions;
  conversation(botId: string): { threadId: string; sessionId: string | null };
  saveSession(threadId: string, sessionId: string): void;
  /** The bot session's cost so far, as the engine estimates it. */
  saveCost(threadId: string, costUsd: number): void;
  emit(threadId: string, botId: string, type: string, data: unknown, liveOnly?: boolean): void;
  /** Called after every turn. Returns where the reply was passed on to, if anywhere. */
  finished(botId: string, turn: PreparedTurn, outcome: TurnOutcome): { forwardedTo?: 'main' };
  statusChanged(botId: string): void;
}

/** Updates about sub-agents can share a turn; messages from people and the main bot cannot. */
function sameTurn(first: Inbound, next: Inbound): boolean {
  if (first.kind === 'report' && next.kind === 'report') return true;
  if (first.kind === 'task' && next.kind === 'task') {
    const firstIsQuestion = first.event === 'question';
    if (firstIsQuestion !== (next.event === 'question')) return false;
    return firstIsQuestion || first.requester === next.requester;
  }
  return false;
}

/**
 * Runs one bot's conversation: a queue of inbound messages handled one turn at
 * a time. Different bots run their turns in parallel.
 */
export class BotRuntime {
  readonly botId: string;
  private readonly host: RuntimeHost;
  private readonly brain: Brain;
  private readonly queue: Inbound[] = [];
  private pumping = false;
  private running: Promise<void> | undefined;
  private closed = false;
  private abort: AbortController | undefined;
  /** Who the current turn answers. Tools read it to tag the work they start. */
  replyTo: Requester = 'user';

  constructor(botId: string, host: RuntimeHost, brain: Brain) {
    this.botId = botId;
    this.host = host;
    this.brain = brain;
  }

  enqueue(item: Inbound): void {
    if (this.closed) return;
    this.queue.push(item);
    this.host.statusChanged(this.botId);
    // Start after the current call chain, so whatever delivered the item finishes first.
    queueMicrotask(() => this.kick());
  }

  /** True while the bot is replying or has messages waiting. */
  isBusy(): boolean {
    return this.pumping || this.queue.length > 0;
  }

  /** Drops waiting messages and stops the current turn. */
  stop(): void {
    this.queue.length = 0;
    this.abort?.abort();
    this.host.statusChanged(this.botId);
  }

  /** Stops for good. Resolves once the current turn has wound down. */
  close(): Promise<void> {
    this.closed = true;
    this.stop();
    return this.running ?? Promise.resolve();
  }

  private kick(): void {
    if (this.running || this.closed) return;
    this.running = this.pump().finally(() => {
      this.running = undefined;
      if (this.queue.length > 0) this.kick();
    });
  }

  private takeBatch(): Inbound[] {
    const first = this.queue.shift();
    if (!first) return [];
    const batch = [first];
    while (this.queue.length > 0 && sameTurn(first, this.queue[0]!)) batch.push(this.queue.shift()!);
    return batch;
  }

  private async pump(): Promise<void> {
    this.pumping = true;
    try {
      for (let batch = this.takeBatch(); batch.length > 0 && !this.closed; batch = this.takeBatch()) {
        let turn: PreparedTurn | undefined;
        try {
          turn = this.host.prepare(this.botId, batch);
        } catch (error) {
          console.error(`code-bot: could not prepare a turn for ${this.botId}:`, error);
          continue;
        }
        if (turn) await this.runTurn(turn);
      }
    } finally {
      this.pumping = false;
      this.host.statusChanged(this.botId);
    }
  }

  private async runTurn(turn: PreparedTurn): Promise<void> {
    const botId = this.botId;
    const abort = new AbortController();
    this.abort = abort;
    this.replyTo = turn.replyTo;
    const { threadId, sessionId } = this.host.conversation(botId);
    this.host.emit(threadId, botId, 'turn.start', { replyTo: turn.replyTo });

    let ok = false;
    let text = '';
    let lastText = '';
    let error: string | undefined;
    try {
      const events = this.brain.run({
        botId,
        prompt: turn.prompt,
        sessionId: sessionId ?? undefined,
        ...this.host.brainOptions(botId),
        signal: abort.signal,
      });
      for await (const event of events) {
        switch (event.type) {
          case 'session':
            if (event.sessionId !== sessionId) this.host.saveSession(threadId, event.sessionId);
            break;
          case 'text_delta':
            this.host.emit(threadId, botId, 'bot.delta', { text: event.text }, true);
            break;
          case 'text':
            lastText = event.text;
            this.host.emit(threadId, botId, 'bot.text', { text: event.text });
            break;
          case 'tool':
            this.host.emit(threadId, botId, 'bot.tool', { name: event.name, input: event.input });
            break;
          case 'result':
            ok = event.ok;
            text = event.text || lastText;
            error = event.error;
            if (event.costUsd !== undefined) this.host.saveCost(threadId, event.costUsd);
            break;
        }
      }
    } catch (failure) {
      ok = false;
      error = errorMessage(failure);
    }
    if (this.abort === abort) this.abort = undefined;

    const stopped = abort.signal.aborted;
    const outcome: TurnOutcome = {
      ok: ok && !stopped,
      text,
      error: stopped ? 'Stopped.' : ok ? undefined : (error ?? 'The bot stopped without replying.'),
      stopped,
    };
    let forwardedTo: 'main' | undefined;
    try {
      forwardedTo = this.host.finished(botId, turn, outcome).forwardedTo;
    } catch (failure) {
      console.error(`code-bot: could not finish a turn for ${botId}:`, failure);
    }
    const end: TurnEndData = { ok: outcome.ok, error: outcome.error, forwardedTo };
    this.host.emit(threadId, botId, 'turn.end', end);
  }
}
