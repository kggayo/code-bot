import { z } from 'zod';
import { EFFORTS, PERMISSION_MODES } from '../shared/types.ts';
import type { Bot, BotView, Effort, PermissionMode, Requester, Task, UserResponse } from '../shared/types.ts';
import type { BotTool } from './brain.ts';
import { GIT_SUBCOMMANDS, runGit } from './git.ts';
import type { TaskManager } from './tasks.ts';
import { clip } from './util.ts';

export interface SubagentArgs {
  title?: string;
  brief: string;
  folder?: string;
  model?: string;
  effort?: Effort;
  engine?: string;
  permissionMode?: PermissionMode;
  /** true: its own git worktree and branch; false: the shared folder; undefined: the project's setting. */
  worktree?: boolean;
}

/** What the bots' tools need from code-bot. */
export interface ToolHost {
  readonly tasks: TaskManager;
  projectBots(): BotView[];
  findProjectBot(nameOrId: string): Bot;
  messageProjectBot(bot: Bot, text: string): void;
  startSubagent(bot: Bot, args: SubagentArgs, requestedBy: Requester): Promise<Task>;
  respondAsBot(taskId: string, requestId: string, response: UserResponse): void;
  matchFolder(bot: Bot, folder: string): string;
  /** A project folder or one of the project's sub-agent worktrees. */
  matchGitFolder(bot: Bot, folder: string): string;
}

const optionalText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

function summary(task: Task, tasks: TaskManager) {
  return {
    id: task.id,
    title: task.title,
    state: task.state,
    requested_by: task.requestedBy,
    engine: task.engine,
    model: task.model,
    effort: task.effort,
    updated_at: task.updatedAt,
    branch: task.worktree?.branch ?? null,
    open_requests: tasks.pendingRequests({ taskId: task.id }).length,
  };
}

/** The main bot's tools: it routes work to project bots and never touches sub-agents directly. */
export function mainBotTools(host: ToolHost): BotTool[] {
  return [
    {
      name: 'list_project_bots',
      description: 'List the project bots: what each project is and what it is busy with.',
      schema: {},
      readOnly: true,
      run: () =>
        host.projectBots().map((bot) => ({
          name: bot.name,
          description: bot.description,
          folders: bot.folders,
          busy: bot.status.busy,
          active_subagents: bot.status.activeSubagents,
          waiting_on_user: bot.status.needsYou,
        })),
    },
    {
      name: 'send_to_project_bot',
      description:
        "Send a message to a project bot: new work, a follow-up, or the user's answer to its question. Returns at once; the project bot's reply arrives later as a report.",
      schema: {
        bot: z.string().describe('Project bot name'),
        message: z.string().describe('A complete, self-contained message; the project bot cannot see this conversation'),
      },
      run: (args) => {
        const bot = host.findProjectBot(String(args.bot));
        const message = String(args.message ?? '').trim();
        if (!message) throw new Error('The message is empty');
        host.messageProjectBot(bot, message);
        return { delivered_to: bot.name, note: 'Its reply will arrive as a report.' };
      },
    },
    {
      name: 'project_bot_status',
      description: "What one project bot and its sub-agents are doing.",
      schema: { bot: z.string().describe('Project bot name') },
      readOnly: true,
      run: (args) => {
        const bot = host.findProjectBot(String(args.bot));
        const view = host.projectBots().find((candidate) => candidate.id === bot.id);
        return {
          name: bot.name,
          busy: view?.status.busy ?? false,
          waiting_on_user: view?.status.needsYou ?? 0,
          subagents: host.tasks.listTasks({ botId: bot.id, limit: 15 }).map((task) => summary(task, host.tasks)),
        };
      },
    },
  ];
}

/** A project bot's tools: it runs its own sub-agents and can read, but not change, its folders. */
export function projectBotTools(host: ToolHost, bot: Bot, requester: () => Requester): BotTool[] {
  const own = (taskId: unknown): Task => {
    const id = String(taskId ?? '');
    const task = host.tasks.listTasks({ botId: bot.id, limit: 10_000 }).find((candidate) => candidate.id === id);
    if (!task) throw new Error(`No sub-agent "${id}" in this project`);
    return task;
  };
  const folderNames = bot.folders.join(', ');

  return [
    {
      name: 'list_subagents',
      description: "List this project's sub-agents, newest first.",
      schema: { active_only: z.boolean().optional().describe('Only sub-agents that are working or waiting') },
      readOnly: true,
      run: (args) =>
        host.tasks
          .listTasks({ botId: bot.id, states: args.active_only ? ['running', 'waiting'] : undefined, archived: false, limit: 25 })
          .map((task) => summary(task, host.tasks)),
    },
    {
      name: 'start_subagent',
      description:
        'Start a sub-agent (developer or QA) on one task in this project. Returns at once with its id; it works in the background and you get an update when it finishes, fails or has a question.',
      schema: {
        title: z.string().describe('Short title for the task'),
        brief: z.string().describe('Complete, self-contained brief: goal, relevant files, constraints, how to verify'),
        folder: z.string().optional().describe(`Project folder to work in (default: the primary one). One of: ${folderNames}`),
        model: z.string().optional().describe("Model for this sub-agent, if it should differ from the project's default"),
        effort: z.enum(EFFORTS).optional().describe("Effort for this sub-agent, if it should differ from the project's default"),
        permission_mode: z
          .enum(PERMISSION_MODES)
          .optional()
          .describe('Stricter permissions for this sub-agent, e.g. "plan" for read-only analysis. Cannot be looser than the project allows.'),
        worktree: z
          .boolean()
          .optional()
          .describe(
            `true: work in its own git worktree on its own branch; false: work in the shared project folder (needed to merge a branch there). Default for this project: ${bot.subagents.isolation === 'worktree' ? 'true' : 'false'}.`,
          ),
      },
      run: async (args) =>
        summary(
          await host.startSubagent(
            bot,
            {
              title: optionalText(args.title),
              brief: String(args.brief ?? ''),
              folder: optionalText(args.folder),
              model: optionalText(args.model),
              effort: args.effort as Effort | undefined,
              permissionMode: args.permission_mode as PermissionMode | undefined,
              worktree: typeof args.worktree === 'boolean' ? args.worktree : undefined,
            },
            requester(),
          ),
          host.tasks,
        ),
    },
    {
      name: 'get_subagent',
      description: "One sub-agent's brief, state, final report, recent messages and open questions.",
      schema: { id: z.string().describe('Sub-agent id') },
      readOnly: true,
      run: (args) => {
        const task = own(args.id);
        const events = host.tasks.events(task.id);
        const brief = events.find((event) => event.type === 'user.message')?.data as { text?: string } | undefined;
        const recent = events
          .filter((event) => event.type === 'text')
          .slice(-5)
          .map((event) => clip((event.data as { text: string }).text, 1500));
        return {
          ...summary(task, host.tasks),
          folder: task.cwd,
          worktree: task.worktree
            ? { path: task.worktree.path, branch: task.worktree.branch, base: task.worktree.base, removed: task.worktree.removed }
            : null,
          brief: clip(brief?.text, 4000),
          final_report: clip(task.lastResult, 6000),
          error: task.error,
          recent_messages: recent,
          open_requests: host.tasks.pendingRequests({ taskId: task.id }).map((request) => ({
            request_id: request.id,
            kind: request.kind,
            tool: request.tool,
            summary: request.summary,
            input: request.input,
            with_user: request.surfacedIn !== null,
          })),
        };
      },
    },
    {
      name: 'send_to_subagent',
      description: 'Send a message to a sub-agent: redirect it while it works, or continue its session after it finished.',
      schema: { id: z.string().describe('Sub-agent id'), text: z.string().describe('The message') },
      run: (args) => summary(host.tasks.sendMessage(own(args.id).id, String(args.text ?? ''), 'lead'), host.tasks),
    },
    {
      name: 'answer_subagent',
      description:
        "Answer a sub-agent's question. Only for questions whose answer is clear; real decisions for the user should be left unanswered. Approvals for actions are the user's to give.",
      schema: {
        id: z.string().describe('Sub-agent id'),
        request_id: z.string().describe('The request id from the update'),
        answers: z
          .record(z.string(), z.string())
          .optional()
          .describe('Each question text mapped to the chosen option label, or a short free-text answer'),
        decline: z.string().optional().describe('Instead of answering: tell the sub-agent to decide itself, with this note'),
      },
      run: (args) => {
        const task = own(args.id);
        const requestId = String(args.request_id ?? '');
        const request = host.tasks.pendingRequests({ taskId: task.id }).find((candidate) => candidate.id === requestId);
        if (!request) throw new Error(`Sub-agent ${task.id} has no open request "${requestId}"`);
        if (request.kind !== 'question') throw new Error('Approvals for actions are for the user to decide, not the project bot');
        const decline = optionalText(args.decline);
        const answers = args.answers as Record<string, string> | undefined;
        if (decline) {
          host.respondAsBot(task.id, request.id, { decision: 'deny', message: decline });
        } else {
          if (!answers || Object.keys(answers).length === 0) throw new Error('Give answers, or decline with a note');
          host.respondAsBot(task.id, request.id, { decision: 'allow', answers });
        }
        return summary(host.tasks.getTask(task.id), host.tasks);
      },
    },
    {
      name: 'cancel_subagent',
      description: 'Stop a sub-agent that is working.',
      schema: { id: z.string().describe('Sub-agent id') },
      run: async (args) => summary(await host.tasks.cancel(own(args.id).id), host.tasks),
    },
    {
      name: 'git',
      description: `Run a read-only git command in a project folder or a sub-agent's worktree. Allowed: ${GIT_SUBCOMMANDS.join(', ')}. Example: {"args": ["diff", "--stat"]}.`,
      schema: {
        args: z.array(z.string()).min(1).describe('git arguments, starting with the subcommand'),
        folder: z
          .string()
          .optional()
          .describe(`Project folder (default: the primary one), one of: ${folderNames}; or a sub-agent's worktree path`),
      },
      readOnly: true,
      run: (args) => {
        const folder = optionalText(args.folder);
        const cwd = folder ? host.matchGitFolder(bot, folder) : bot.folders[0];
        if (!cwd) throw new Error('This project has no folders');
        return runGit(cwd, (args.args as string[]).map(String));
      },
    },
  ];
}
