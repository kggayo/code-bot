import * as readline from 'node:readline';
import { describeSchedule, money, when } from '../shared/format.ts';
import type {
  BotStatus,
  BotView,
  ClosedData,
  CoreEvent,
  InboundData,
  RoutineProposal,
  RoutineProposalClosed,
  RoutineRunData,
  SurfacedData,
  Task,
  TurnEndData,
} from '../shared/types.ts';
import { MAIN_BOT_ID } from '../shared/types.ts';
import type { Client } from './client.ts';
import {
  answerFor,
  clean,
  inboundLine,
  indent,
  outcome,
  paint,
  parseCommand,
  proposalCard,
  questionsOf,
  requestCard,
  splitFirst,
  taskLine,
  titleSequence,
  toolLine,
} from './render.ts';
import type { Paint, ProposalCard, RequestCard } from './render.ts';

/**
 * A conversation with one bot in a terminal: `code-bot chat [bot]`. The bot's
 * messages, reports and its sub-agents' questions and approvals appear above a
 * prompt; plain lines go to the bot, lines starting with "/" are commands.
 * It is only a client: closing it changes nothing in the core.
 */

export interface TerminalLaunch {
  command: string;
  args: string[];
  cwd: string;
}

export interface ChatOptions {
  client: Client;
  /** A bot's name or id; the main bot when not given. */
  bot?: string;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  /** A person at a terminal: a prompt, the window title, a bell for new requests, pasted lines kept together. */
  interactive: boolean;
  color: boolean;
  /** Events shown when the conversation opens. */
  history?: number;
  /** Continues a sub-agent's session in a new terminal (tmux window, Windows Terminal tab); returns where. */
  openTerminal?: (launch: TerminalLaunch) => Promise<string | null>;
}

type Card = ({ kind: 'request' } & RequestCard) | ({ kind: 'proposal' } & ProposalCard);

const HELP = [
  'Type a message and press Enter to send it to the bot. End a line with \\ to write more lines.',
  '',
  '  /allow N            allow approval N          /deny N [why]   deny it',
  '  /answer N [answer]  answer question N         /skip N         let the sub-agent decide',
  '  /subagents [all]    list sub-agents           /show S         one sub-agent and its last report',
  '  /tell S <text>      write to sub-agent S      /cancel S       stop it',
  '  /merge S            merge its branch          /push S         push it and open a pull request',
  '  /open S             continue it in a terminal',
  '  /routines           list routines             /create N, /dismiss N   a proposed routine',
  '  /usage              plan limits               /bots           every bot',
  '  /switch <bot>       talk to another bot       /new            start a new conversation',
  '  /stop               stop the bot\'s turn       /quit           leave (code-bot keeps running)',
  '',
  'S is a number from /subagents or a sub-agent id (t_…).',
];

const PASTE_MS = 30;

export class Chat {
  private readonly options: ChatOptions;
  private readonly p: Paint;
  private readonly history: number;
  private bot: BotView | undefined;
  private status: BotStatus | undefined;
  private threadId = '';
  private lastSeq = 0;
  private loading = true;
  private opened = false;
  private connected = true;
  private queued: CoreEvent[] = [];
  private cards = new Map<number, Card>();
  private cardIds = new Map<string, number>();
  /** Cards already printed in full. */
  private shown = new Set<number>();
  private nextCard = 1;
  private tasks: Task[] = [];
  private sent: string[] = [];
  private writing = false;
  private flow: ((line: string) => Promise<void>) | undefined;
  private pending: string[] = [];
  private pasteTimer: ReturnType<typeof setTimeout> | undefined;
  private continued: string[] = [];
  private work: Promise<void> = Promise.resolve();
  private rl: readline.Interface | undefined;
  private unsubscribe: (() => void) | undefined;
  private finished: () => void = () => {};

  constructor(options: ChatOptions) {
    this.options = options;
    this.p = paint(options.color);
    this.history = options.history ?? 30;
  }

  private get api() {
    return this.options.client.api;
  }

  /** Runs until /quit or the input ends. */
  async run(): Promise<void> {
    await this.select(this.options.bot);
    const done = new Promise<void>((resolve) => {
      this.finished = resolve;
    });
    this.rl = readline.createInterface({
      input: this.options.input,
      output: this.options.interactive ? this.options.output : undefined,
      terminal: this.options.interactive,
      historySize: 200,
    });
    this.rl.on('line', (line) => this.onLine(line));
    this.rl.on('close', () => this.close());
    this.rl.on('SIGINT', () => this.rl?.close());
    this.unsubscribe = this.options.client.subscribe({
      event: (event) => this.onEvent(event),
      open: () => {
        if (!this.connected) this.print([this.p.dim('  · connected again')]);
        this.connected = true;
        void this.catchUp();
      },
      closed: () => {
        if (this.connected) this.print([this.p.red('  ! lost the connection to code-bot; trying again…')]);
        this.connected = false;
      },
    });
    this.prompt();
    await done;
  }

  private close(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.options.interactive) this.options.output.write(titleSequence('code-bot'));
    this.finished();
  }

  // ---- output ---------------------------------------------------------------

  private print(lines: string[]): void {
    if (lines.length === 0) return;
    const out = this.options.output;
    const text = `${lines.join('\n')}\n`;
    if (this.options.interactive && this.rl) {
      readline.clearLine(out, 0);
      readline.cursorTo(out, 0);
      out.write(text);
      this.rl.prompt(true);
    } else {
      out.write(text);
    }
  }

  private error(error: unknown): void {
    this.print([this.p.red(`  ! ${clean(error instanceof Error ? error.message : String(error))}`)]);
  }

  private prompt(): void {
    if (!this.options.interactive || !this.rl) return;
    const state = this.flow ? this.p.yellow('answer') : this.writing || this.status?.busy ? this.p.dim('working') : '';
    this.rl.setPrompt(`${state ? `${state} ` : ''}${this.p.bold('›')} `);
    this.rl.prompt(true);
  }

  private title(): void {
    if (!this.options.interactive || !this.bot) return;
    const status = this.status;
    const parts = [this.bot.kind === 'main' ? 'main bot' : this.bot.name];
    parts.push(status?.busy ? 'working' : 'idle');
    if (status?.activeSubagents) parts.push(`${status.activeSubagents} sub-agent${status.activeSubagents === 1 ? '' : 's'}`);
    if (status?.needsYou) parts.push(`${status.needsYou} need${status.needsYou === 1 ? 's' : ''} you`);
    this.options.output.write(titleSequence(parts.join(' · ')));
  }

  private name(): string {
    return this.bot?.kind === 'main' ? 'main bot' : clean(this.bot?.name ?? 'bot');
  }

  // ---- the conversation -------------------------------------------------------

  private async select(ref: string | undefined): Promise<void> {
    const bots = await this.api.listBots();
    const wanted = (ref ?? MAIN_BOT_ID).trim().toLowerCase();
    const bot =
      bots.find((candidate) => candidate.id === ref) ??
      bots.find((candidate) => candidate.name.toLowerCase() === wanted) ??
      (wanted === 'main' || wanted === 'main bot' ? bots.find((candidate) => candidate.kind === 'main') : undefined) ??
      bots.find((candidate) => candidate.name.toLowerCase().startsWith(wanted));
    if (!bot) {
      throw new Error(`No bot called "${ref}". The bots are: ${bots.map((candidate) => (candidate.kind === 'main' ? 'main' : candidate.name)).join(', ')}`);
    }
    this.bot = bot;
    this.status = bot.status;
    this.threadId = '';
    this.lastSeq = 0;
    this.cards.clear();
    this.cardIds.clear();
    this.shown.clear();
    this.nextCard = 1;
    this.tasks = [];
    this.writing = false;
    this.title();
    this.print([
      this.p.bold(`code-bot · ${this.name()}`) + this.p.dim(bot.kind === 'main' ? '' : ` · ${bot.folders.map(clean).join(', ')}`),
      this.p.dim('  /help for commands · /quit leaves (code-bot keeps working)'),
    ]);
  }

  /** Loads what this terminal has not seen: the whole conversation the first time, the rest after a reconnect. */
  private async catchUp(): Promise<void> {
    const bot = this.bot;
    if (!bot) return;
    this.loading = true;
    try {
      const fresh = !this.opened || !this.threadId;
      let view = await this.api.getThread(bot.id, fresh ? undefined : this.lastSeq);
      const whole = fresh || view.threadId !== this.threadId;
      // Moved to another conversation while this terminal was away: load that one from the start.
      if (!fresh && whole) view = await this.api.getThread(bot.id);
      if (this.bot !== bot) return;
      const { events } = view;
      if (whole) {
        if (this.opened) this.print([this.p.dim('  — this bot is in another conversation now —')]);
        this.threadId = view.threadId;
        this.lastSeq = 0;
      }
      this.opened = true;
      this.replay(events.filter((event) => event.seq > this.lastSeq), whole);
      this.status = { ...(this.status as BotStatus), busy: view.busy };
    } catch (error) {
      this.error(error);
    } finally {
      this.loading = false;
      const queued = this.queued;
      this.queued = [];
      for (const event of queued) this.apply(event, true);
      this.title();
      this.prompt();
    }
  }

  /** Earlier events: the last ones in full, and every request or proposal still open, so it can be answered. */
  private replay(events: CoreEvent[], whole: boolean): void {
    const from = whole ? Math.max(0, events.length - this.history) : 0;
    if (whole && from > 0) this.print([this.p.dim(`  … ${from} earlier events (the window shows them all)`)]);
    for (const [index, event] of events.entries()) this.apply(event, index >= from);
    const open = [...this.cards.values()].filter(
      (card) => (card.kind === 'request' ? !card.closed : !card.outcome) && !this.shown.has(card.number),
    );
    if (open.length) {
      this.print([this.p.yellow('Still waiting for you:')]);
      for (const card of open) this.showCard(card);
    }
  }

  private showCard(card: Card): void {
    this.shown.add(card.number);
    this.print(card.kind === 'request' ? requestCard(card, this.p) : proposalCard(card, this.p));
  }

  private onEvent(event: CoreEvent): void {
    if (this.loading) {
      this.queued.push(event);
      return;
    }
    this.apply(event, true);
  }

  private apply(event: CoreEvent, show: boolean): void {
    const bot = this.bot;
    if (!bot || event.botId !== bot.id) return;
    if (event.scope === 'bot') {
      if (event.type === 'status') {
        this.status = event.data as BotStatus;
        this.title();
        this.prompt();
      } else if (event.type === 'archived') {
        this.print([this.p.red(`  ! ${this.name()} was removed from code-bot`)]);
      } else if (event.type === 'conversations') {
        const threadId = (event.data as { threadId?: string }).threadId;
        if (threadId && threadId !== this.threadId) void this.catchUp();
      }
      return;
    }
    if (event.scope !== 'thread') return;
    if (event.type === 'thread.reset') {
      if (event.id === this.threadId) return;
      this.threadId = event.id;
      this.lastSeq = 0;
      if (show) this.print([this.p.dim('  — new conversation —')]);
    }
    if (event.id !== this.threadId) return;
    if (event.seq > 0) {
      if (event.seq <= this.lastSeq) return;
      this.lastSeq = event.seq;
    }
    this.render(event, show);
  }

  private render(event: CoreEvent, show: boolean): void {
    const p = this.p;
    const out = (lines: string[]) => {
      if (show) this.print(lines);
    };
    switch (event.type) {
      case 'user.message': {
        const text = (event.data as { text: string }).text;
        const index = this.sent.indexOf(text);
        if (index >= 0 && this.options.interactive) {
          this.sent.splice(index, 1);
          return;
        }
        out([p.bold('you') + p.dim(' ›'), indent(clean(text), '  ')]);
        return;
      }
      case 'inbound':
        out(inboundLine(event.data as InboundData, p));
        return;
      case 'turn.start':
        return;
      case 'bot.delta':
        if (!this.writing) {
          this.writing = true;
          this.prompt();
        }
        return;
      case 'bot.text':
        this.writing = false;
        out([p.cyan(p.bold(this.name())) + p.dim(' ›'), indent(clean((event.data as { text: string }).text), '  ')]);
        this.prompt();
        return;
      case 'bot.tool': {
        const data = event.data as { name: string; input: unknown };
        const line = toolLine(data.name, data.input);
        if (line) out([p.dim(`  · ${line}`)]);
        return;
      }
      case 'subagent.started': {
        const data = event.data as { taskId: string; title: string; branch?: string };
        out([p.dim(`  · started sub-agent ${data.taskId} "${clean(data.title)}"${data.branch ? ` on ${clean(data.branch)}` : ''}`)]);
        return;
      }
      case 'request.surfaced': {
        const data = event.data as SurfacedData;
        const known = this.cardIds.get(data.request.id);
        if (known !== undefined) return;
        const card: Card = { kind: 'request', number: this.nextCard++, request: data.request, taskTitle: data.taskTitle, botName: data.botName };
        this.cards.set(card.number, card);
        this.cardIds.set(data.request.id, card.number);
        if (show) {
          this.showCard(card);
          if (this.options.interactive && this.opened && !this.loading) this.options.output.write('\x07');
        }
        return;
      }
      case 'request.closed': {
        const data = event.data as ClosedData;
        const number = this.cardIds.get(data.requestId);
        const card = number === undefined ? undefined : this.cards.get(number);
        if (!card || card.kind !== 'request') return;
        card.closed = data;
        out([p.dim(`  · [${card.number}] ${outcome(card)}`)]);
        return;
      }
      case 'routine.run': {
        const data = event.data as RoutineRunData;
        out([p.dim(`  · routine "${clean(data.title)}"${data.manual ? ' (run by hand)' : ''}:`), indent(clean(data.text), '  ')]);
        return;
      }
      case 'routine.proposed': {
        const proposal = event.data as RoutineProposal;
        if (this.cardIds.has(proposal.id)) return;
        const card: Card = { kind: 'proposal', number: this.nextCard++, proposal };
        this.cards.set(card.number, card);
        this.cardIds.set(proposal.id, card.number);
        if (show) this.showCard(card);
        return;
      }
      case 'routine.proposal.closed': {
        const data = event.data as RoutineProposalClosed;
        const number = this.cardIds.get(data.id);
        const card = number === undefined ? undefined : this.cards.get(number);
        if (!card || card.kind !== 'proposal') return;
        card.outcome = data.outcome;
        out([p.dim(`  · [${card.number}] routine ${data.outcome}`)]);
        return;
      }
      case 'turn.end': {
        const data = event.data as TurnEndData;
        this.writing = false;
        if (!data.ok) out([p.red(`  ! ${this.name()}'s turn failed: ${clean(data.error ?? 'unknown error')}`)]);
        else if (data.forwardedTo === 'main') out([p.dim('  · passed on to the main bot')]);
        this.prompt();
        return;
      }
      default:
        return;
    }
  }

  // ---- input ----------------------------------------------------------------

  private onLine(line: string): void {
    // A line ending in "\" continues on the next one.
    if (/\\\s*$/.test(line) && !this.flow) {
      this.continued.push(line.replace(/\\\s*$/, ''));
      return;
    }
    const full = [...this.continued, line].join('\n');
    this.continued = [];
    if (!this.options.interactive) {
      this.enqueue(full);
      return;
    }
    // Pasted text arrives as many lines at once: keep it together as one message.
    this.pending.push(full);
    if (this.pasteTimer) clearTimeout(this.pasteTimer);
    this.pasteTimer = setTimeout(() => {
      this.pasteTimer = undefined;
      const text = this.pending.join('\n');
      this.pending = [];
      this.enqueue(text);
    }, PASTE_MS);
  }

  private enqueue(text: string): void {
    this.work = this.work.then(() => this.handle(text)).catch((error: unknown) => this.error(error));
  }

  private async handle(text: string): Promise<void> {
    if (this.flow) {
      const flow = this.flow;
      this.flow = undefined;
      await flow(text);
      this.prompt();
      return;
    }
    const command = text.includes('\n') ? null : parseCommand(text);
    if (command) {
      await this.command(command.name, command.rest);
      this.prompt();
      return;
    }
    if (!text.trim() || !this.bot) {
      this.prompt();
      return;
    }
    this.sent.push(text);
    await this.api.sendToBot(this.bot.id, text);
  }

  private ask(question: string, then: (answer: string) => Promise<void>): void {
    this.print([this.p.yellow(`  ${question}`)]);
    this.flow = then;
  }

  private requestCard(ref: string): { kind: 'request' } & RequestCard {
    const card = this.cards.get(Number(ref));
    if (!card || card.kind !== 'request') throw new Error(`No question or approval [${ref}] in this conversation`);
    if (card.closed) throw new Error(`[${ref}] is already ${outcome(card)}`);
    return card;
  }

  private proposal(ref: string): { kind: 'proposal' } & ProposalCard {
    const card = this.cards.get(Number(ref));
    if (!card || card.kind !== 'proposal') throw new Error(`No proposed routine [${ref}] in this conversation`);
    if (card.outcome) throw new Error(`[${ref}] was already ${card.outcome}`);
    return card;
  }

  private async task(ref: string): Promise<Task> {
    if (!ref) throw new Error('Name a sub-agent: its number from /subagents or its id (t_…)');
    if (/^\d+$/.test(ref)) {
      const task = this.tasks[Number(ref) - 1];
      if (!task) throw new Error(`No sub-agent ${ref} in the last list; run /subagents`);
      return task;
    }
    const all = await this.api.listTasks({ limit: 500 });
    const exact = all.find((task) => task.id === ref);
    if (exact) return exact;
    const matches = all.filter((task) => task.id.startsWith(ref));
    if (matches.length === 1 && matches[0]) return matches[0];
    throw new Error(matches.length ? `"${ref}" matches several sub-agents; give more of the id` : `No sub-agent "${ref}"`);
  }

  private async command(name: string, rest: string): Promise<void> {
    const p = this.p;
    const bot = this.bot as BotView;
    switch (name) {
      case 'help':
      case 'h':
      case '?':
        this.print(HELP.map((line) => p.dim(line)));
        return;
      case 'quit':
      case 'exit':
      case 'q':
        this.rl?.close();
        return;
      case 'allow':
      case 'deny': {
        const [ref, why] = splitFirst(rest);
        const card = this.requestCard(ref);
        if (card.request.kind === 'question') throw new Error(`[${ref}] is a question: /answer ${ref} or /skip ${ref}`);
        await this.api.respond(
          card.request.taskId,
          card.request.id,
          name === 'allow' ? { decision: 'allow' } : { decision: 'deny', ...(why ? { message: why } : {}) },
        );
        return;
      }
      case 'skip': {
        const card = this.requestCard(splitFirst(rest)[0]);
        await this.api.respond(card.request.taskId, card.request.id, {
          decision: 'deny',
          message: 'The user skipped this question; use your own judgement.',
        });
        return;
      }
      case 'answer': {
        const [ref, given] = splitFirst(rest);
        const card = this.requestCard(ref);
        const questions = questionsOf(card.request);
        if (card.request.kind !== 'question' || questions.length === 0) throw new Error(`[${ref}] is an approval: /allow ${ref} or /deny ${ref}`);
        const answers: Record<string, string> = {};
        const next = async (index: number, typed?: string): Promise<void> => {
          const question = questions[index];
          if (!question) {
            await this.api.respond(card.request.taskId, card.request.id, { decision: 'allow', answers });
            return;
          }
          const record = async (value: string) => {
            const answer = answerFor(question, value);
            if (!answer) {
              this.ask(`Type an answer, or an option number, for: ${clean(question.question)}`, record);
              return;
            }
            answers[question.question] = answer;
            await next(index + 1);
          };
          if (typed) await record(typed);
          else this.ask(`${questions.length > 1 ? `${index + 1}/${questions.length} ` : ''}${clean(question.question)} (number or text)`, record);
        };
        await next(0, questions.length === 1 && given ? given : undefined);
        return;
      }
      case 'stop':
        await this.api.stopBot(bot.id);
        this.print([p.dim(`  · stopped ${this.name()}`)]);
        return;
      case 'new':
        await this.api.newConversation(bot.id);
        await this.catchUp();
        return;
      case 'subagents':
      case 'agents': {
        const everyone = bot.kind === 'main' || rest === 'all';
        this.tasks = await this.api.listTasks(everyone ? { limit: 20 } : { botId: bot.id, limit: 20 });
        if (this.tasks.length === 0) {
          this.print([p.dim('  No sub-agents yet.')]);
          return;
        }
        const names = new Map((await this.api.listBots()).map((item) => [item.id, item.name]));
        this.print(
          this.tasks.map((task, index) => `${taskLine(task, index + 1, p)}${everyone && bot.kind === 'main' ? p.dim(` · ${clean(names.get(task.botId) ?? '')}`) : ''}`),
        );
        return;
      }
      case 'show': {
        const task = await this.task(splitFirst(rest)[0]);
        const view = await this.api.getTask(task.id);
        const t = view.task;
        const lines = [
          p.bold(`${t.id} · ${clean(t.title)}`),
          p.dim(`  ${t.state} · ${t.role} · ${t.engine}${t.model ? ` ${t.model}` : ''} · ${t.permissionMode}${t.costUsd ? ` · ${money(t.costUsd)}` : ''}`),
          p.dim(`  folder: ${clean(t.cwd)}${t.worktree ? ` · branch ${clean(t.worktree.branch)}` : ''}`),
        ];
        if (t.error) lines.push(p.red(`  ! ${clean(t.error)}`));
        if (t.lastResult) lines.push(p.dim('  last report:'), indent(clean(t.lastResult)));
        if (view.pendingRequests.length) lines.push(p.yellow(`  waiting for ${view.pendingRequests.length} answer${view.pendingRequests.length === 1 ? '' : 's'}`));
        this.print(lines);
        return;
      }
      case 'tell': {
        const [ref, message] = splitFirst(rest);
        if (!message) throw new Error('Usage: /tell S <message>');
        const task = await this.task(ref);
        await this.api.sendToTask(task.id, message);
        this.print([p.dim(`  · sent to ${task.id}`)]);
        return;
      }
      case 'cancel': {
        const task = await this.task(splitFirst(rest)[0]);
        await this.api.cancelTask(task.id);
        this.print([p.dim(`  · stopped ${task.id}`)]);
        return;
      }
      case 'merge':
      case 'push': {
        const task = await this.task(splitFirst(rest)[0]);
        const status = await this.api.getBranchStatus(task.id);
        const blocked = name === 'merge' ? status.mergeBlocked : status.pushBlocked;
        if (blocked) throw new Error(blocked);
        const what =
          name === 'merge'
            ? `Merge ${status.branch} (${status.ahead} commit${status.ahead === 1 ? '' : 's'}) into ${status.folderBranch ?? 'the current branch'} in ${status.folder}?`
            : `Push ${status.branch} to ${status.remote ?? 'origin'}${status.githubRepo ? ` and open a pull request on ${status.githubRepo}` : ''}?`;
        this.ask(`${clean(what)} (y/N)`, async (answer) => {
          if (!/^y(es)?$/i.test(answer.trim())) {
            this.print([p.dim('  · nothing done')]);
            return;
          }
          const after = name === 'merge' ? await this.api.mergeBranch(task.id) : await this.api.openPullRequest(task.id);
          if (name === 'merge') this.print([p.green(`  · merged into ${clean(after.merged?.into ?? status.folderBranch ?? '')} (${after.merged?.commit.slice(0, 8) ?? ''})`)]);
          else this.print([p.green(`  · pushed${after.pullRequest?.url ? `: ${clean(after.pullRequest.url)}` : ''}`)]);
        });
        return;
      }
      case 'open': {
        const task = await this.task(splitFirst(rest)[0]);
        const launch = await this.options.client.launch(task.id);
        const where = this.options.openTerminal ? await this.options.openTerminal(launch) : null;
        if (where) {
          this.print([p.dim(`  · opened ${task.id} in ${where}`)]);
        } else {
          this.print([p.dim('  Run this to continue it:'), `  cd ${JSON.stringify(launch.cwd)} && ${[launch.command, ...launch.args].map((part) => JSON.stringify(part)).join(' ')}`]);
        }
        return;
      }
      case 'routines': {
        const routines = (await this.api.listRoutines()).filter((routine) => bot.kind === 'main' || routine.botId === bot.id);
        if (routines.length === 0) {
          this.print([p.dim('  No routines. Ask the bot to propose one, e.g. "every weekday at 9, summarise new tickets".')]);
          return;
        }
        this.print(
          routines.map(
            (routine) =>
              `  ${routine.enabled ? p.green('on ') : p.dim('off')} ${p.bold(clean(routine.title))} · ${describeSchedule(routine.schedule)}${routine.nextRunAt ? p.dim(` · next ${when(routine.nextRunAt)}`) : ''}${routine.lastError ? p.red(` · last run failed: ${clean(routine.lastError)}`) : ''}`,
          ),
        );
        return;
      }
      case 'create': {
        const card = this.proposal(splitFirst(rest)[0]);
        const routine = await this.api.acceptRoutineProposal(bot.id, card.proposal.id);
        this.print([p.green(`  · created routine "${clean(routine.title)}"${routine.nextRunAt ? `, first run ${when(routine.nextRunAt)}` : ''}`)]);
        return;
      }
      case 'dismiss': {
        const card = this.proposal(splitFirst(rest)[0]);
        await this.api.dismissRoutineProposal(bot.id, card.proposal.id);
        return;
      }
      case 'usage': {
        const usage = await this.api.getUsage();
        const lines: string[] = [];
        for (const engine of usage) {
          lines.push(`  ${p.bold(clean(engine.label))}${engine.plan ? p.dim(` · ${clean(engine.plan)}`) : ''}${engine.note ? p.dim(` · ${clean(engine.note)}`) : ''}`);
          for (const window of engine.windows) {
            const used = window.usedPercent === null ? '?' : `${Math.round(window.usedPercent)}%`;
            lines.push(`    ${clean(window.label)}: ${used}${window.resetsAt ? p.dim(` · resets ${when(window.resetsAt)}`) : ''}`);
          }
        }
        this.print(lines.length ? lines : [p.dim('  No plan limits read yet.')]);
        return;
      }
      case 'bots': {
        const bots = await this.api.listBots();
        this.print(
          bots.map((item) => {
            const s = item.status;
            const state = [s.busy ? 'working' : 'idle', s.activeSubagents ? `${s.activeSubagents} sub-agents` : '', s.needsYou ? p.yellow(`${s.needsYou} need you`) : '']
              .filter(Boolean)
              .join(' · ');
            return `  ${p.bold(item.kind === 'main' ? 'main' : clean(item.name))}  ${p.dim(state)}${item.kind === 'main' ? '' : p.dim(` · ${item.folders.map(clean).join(', ')}`)}`;
          }),
        );
        return;
      }
      case 'switch': {
        if (!rest) throw new Error('Usage: /switch <bot>');
        await this.select(rest);
        this.opened = false;
        await this.catchUp();
        return;
      }
      default:
        throw new Error(`Unknown command /${name}; /help lists them`);
    }
  }
}
