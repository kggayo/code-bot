import { approvalTitle, describeSchedule, describeTool, when } from '../shared/format.ts';
import type { ClosedData, InboundData, PendingRequest, RoutineProposal, Task } from '../shared/types.ts';

/**
 * How the terminal client shows things. Everything that came from a model, a
 * tool or a file is untrusted: it passes through `clean` before it reaches the
 * terminal, so it cannot move the cursor, retitle the window, write the
 * clipboard (OSC 52), hide text or show a link that goes somewhere else.
 */

/* eslint-disable no-control-regex */
const ESCAPE_SEQUENCE =
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[PX^_][^\x1b]*(?:\x1b\\)?|\x1b[ -/]*[0-~]?/g;
/** C0 controls but tab and newline, DEL, C1 controls, and the bidirectional overrides that reorder text on screen. */
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f‪-‮⁦-⁩]/g;

/** Text from an agent, safe to print. */
export function clean(text: unknown): string {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(ESCAPE_SEQUENCE, '')
    .replace(CONTROL, '');
}

export interface Paint {
  bold(text: string): string;
  dim(text: string): string;
  red(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  cyan(text: string): string;
  magenta(text: string): string;
}

export function paint(color: boolean): Paint {
  const wrap = (open: number, close: number) => (text: string) => (color ? `\x1b[${open}m${text}\x1b[${close}m` : text);
  return {
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    cyan: wrap(36, 39),
    magenta: wrap(35, 39),
  };
}

/** Indents every line of a block. */
export function indent(text: string, prefix = '    '): string {
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

export interface Question {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: { label: string; description?: string }[];
}

export function questionsOf(request: PendingRequest): Question[] {
  const input = request.input as { questions?: unknown } | null;
  if (request.kind !== 'question' || !input || !Array.isArray(input.questions)) return [];
  return input.questions.filter((item): item is Question => Boolean(item) && typeof (item as Question).question === 'string');
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** An approval's details as text, by tool (the terminal version of RequestDetails in the window). */
export function approvalDetails(request: PendingRequest, p: Paint): string[] {
  const input = (request.input && typeof request.input === 'object' ? request.input : { value: request.input }) as Record<string, unknown>;
  const lines: string[] = [];
  const diff = (oldText: string, newText: string) => {
    for (const line of oldText ? oldText.split('\n') : []) lines.push(p.red(`    - ${clean(line)}`));
    for (const line of newText ? newText.split('\n') : []) lines.push(p.green(`    + ${clean(line)}`));
  };
  const fields = (skip: string[]) => {
    for (const [key, value] of Object.entries(input)) {
      if (skip.includes(key) || value === undefined || value === null || value === '') continue;
      const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      if (text.includes('\n') || text.length > 90) lines.push(`  ${key}:`, indent(clean(text)));
      else lines.push(`  ${key}: ${clean(text)}`);
    }
  };
  switch (request.tool) {
    case 'ExitPlanMode':
      lines.push(indent(clean(str(input.plan) || '(no plan text)'), '  '));
      break;
    case 'Bash':
    case 'PowerShell':
    case 'shell':
      // The summary line above usually is this description already.
      if (str(input.description) && str(input.description) !== request.summary) lines.push(`  ${clean(str(input.description))}`);
      lines.push(indent(clean(str(input.command)), p.yellow('  $ ')));
      fields(['command', 'description']);
      break;
    case 'Write':
      lines.push(`  file: ${clean(str(input.file_path))}`, indent(clean(str(input.content))));
      break;
    case 'Edit':
      lines.push(`  file: ${clean(str(input.file_path))}`);
      diff(str(input.old_string), str(input.new_string));
      if (input.replace_all === true) lines.push('  (every occurrence)');
      break;
    case 'MultiEdit':
      lines.push(`  file: ${clean(str(input.file_path))}`);
      for (const edit of Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : []) {
        diff(str(edit?.old_string), str(edit?.new_string));
      }
      break;
    default:
      fields([]);
  }
  return lines;
}

export interface RequestCard {
  number: number;
  request: PendingRequest;
  taskTitle: string;
  botName: string;
  closed?: ClosedData;
}

/** A question or approval, numbered so it can be answered with /allow N, /answer N and so on. */
export function requestCard(card: RequestCard, p: Paint): string[] {
  const { request } = card;
  const from = `${clean(card.botName)} · ${request.taskId} ${clean(card.taskTitle)}`;
  const questions = questionsOf(request);
  const heading = request.kind === 'question' ? 'Question' : request.tool === 'ExitPlanMode' ? 'Plan to approve' : 'Approval needed';
  const lines = [p.yellow(p.bold(`[${card.number}] ${heading}`)) + p.dim(`  ${from}`)];
  if (questions.length) {
    for (const [index, question] of questions.entries()) {
      lines.push(`  ${questions.length > 1 ? `${index + 1}. ` : ''}${clean(question.question)}${question.multiSelect ? p.dim(' (one or more)') : ''}`);
      for (const [option, choice] of (question.options ?? []).entries()) {
        lines.push(`     ${p.cyan(String(option + 1))}) ${clean(choice.label)}${choice.description ? p.dim(` · ${clean(choice.description)}`) : ''}`);
      }
    }
    lines.push(p.dim(`  /answer ${card.number} to answer · /skip ${card.number} to let it decide`));
  } else {
    lines.push(`  ${p.bold(clean(approvalTitle(request)))}${request.summary ? p.dim(` · ${clean(request.summary)}`) : ''}`);
    lines.push(...approvalDetails(request, p));
    lines.push(p.dim(`  /allow ${card.number} · /deny ${card.number} [why]`));
  }
  if (request.held) lines.push(p.dim('  code-bot was stopped while this waited; answering resumes the sub-agent.'));
  return lines;
}

/** How a request ended, in a few words. */
export function outcome(card: RequestCard): string {
  const { closed, request } = card;
  if (!closed) return 'no longer waiting';
  if (closed.by === 'bot') return `answered by ${clean(card.botName)}`;
  if (closed.by === 'system' || closed.decision === 'withdrawn') return 'no longer needed: the sub-agent stopped';
  if (request.kind === 'permission') return closed.decision === 'allow' ? 'allowed' : `denied${closed.message ? ` (${clean(closed.message)})` : ''}`;
  if (closed.decision !== 'allow') return 'skipped';
  const answers = Object.values(closed.answers ?? {});
  return answers.length ? `answered: ${clean(answers.join(' / '))}` : 'answered';
}

/**
 * The answer to one question from what was typed: option numbers ("2", or
 * "1,3" where several may be picked) become their labels; anything else is the
 * answer itself.
 */
export function answerFor(question: Question, typed: string): string {
  const text = typed.trim();
  const options = question.options ?? [];
  if (options.length && /^\d+(\s*,\s*\d+)*$/.test(text)) {
    const picks = text.split(',').map((part) => Number(part.trim()));
    if (picks.every((pick) => pick >= 1 && pick <= options.length) && (question.multiSelect || picks.length === 1)) {
      return picks.map((pick) => options[pick - 1]?.label ?? '').join(', ');
    }
  }
  return text;
}

export interface ProposalCard {
  number: number;
  proposal: RoutineProposal;
  outcome?: 'created' | 'dismissed';
}

export function proposalCard(card: ProposalCard, p: Paint): string[] {
  const { proposal } = card;
  return [
    p.magenta(p.bold(`[${card.number}] Routine proposed`)) + p.dim(`  for ${clean(proposal.botName)}`),
    `  ${p.bold(clean(proposal.title))} · ${describeSchedule(proposal.schedule)}${proposal.nextRunAt ? p.dim(` · first ${when(proposal.nextRunAt)}`) : ''}`,
    indent(clean(proposal.prompt)),
    p.dim(`  /create ${card.number} · /dismiss ${card.number}`),
  ];
}

/** One line about a tool a bot used, or null when another line shows it. */
export function toolLine(name: string, input: unknown): string | null {
  const line = describeTool(name, input);
  return line === null ? null : clean(line);
}

export function inboundLine(data: InboundData, p: Paint): string[] {
  const text = clean(data.text);
  switch (data.from) {
    case 'main':
      return [p.cyan(p.bold('main bot')) + p.dim(' asks'), indent(text, '  ')];
    case 'project':
      return [p.cyan(p.bold(clean(data.name ?? 'project bot'))) + p.dim(' reports'), indent(text, '  ')];
    case 'subagent': {
      const flat = text.replace(/\s+/g, ' ').trim();
      return [p.dim(`  · ${data.taskId ?? 'sub-agent'}: ${flat.length > 300 ? `${flat.slice(0, 299)}…` : flat}`)];
    }
  }
}

const STATE: Record<string, string> = {
  running: 'working',
  waiting: 'needs an answer',
  done: 'done',
  failed: 'failed',
  cancelled: 'stopped',
  interrupted: 'interrupted',
};

export function taskLine(task: Task, number: number, p: Paint): string {
  const state = STATE[task.state] ?? task.state;
  const coloured = task.state === 'running' ? p.green(state) : task.state === 'waiting' ? p.yellow(state) : task.state === 'failed' ? p.red(state) : p.dim(state);
  const branch = task.worktree ? p.dim(` · ${clean(task.worktree.branch)}`) : '';
  return `  ${p.cyan(String(number).padStart(2))}  ${task.id}  ${coloured}  ${task.role !== 'developer' ? `${task.role} · ` : ''}${clean(task.title)}${branch}`;
}

export interface Command {
  name: string;
  rest: string;
}

/** "/deny 2 not now" → { name: "deny", rest: "2 not now" }; null for an ordinary message. */
export function parseCommand(line: string): Command | null {
  const match = /^\/([a-z][a-z-]*)(?:\s+([\s\S]*))?$/i.exec(line.trim());
  if (!match) return null;
  return { name: (match[1] ?? '').toLowerCase(), rest: (match[2] ?? '').trim() };
}

/** The first word and the rest: "t_12 do this" → ["t_12", "do this"]. */
export function splitFirst(text: string): [string, string] {
  const match = /^(\S+)\s*([\s\S]*)$/.exec(text.trim());
  return match ? [match[1] ?? '', match[2] ?? ''] : ['', ''];
}

/** The terminal's title: OSC 2, which tmux shows as the pane title. Only for a terminal. */
export function titleSequence(title: string): string {
  return `\x1b]2;${clean(title).replace(/\n/g, ' ')}\x07`;
}
