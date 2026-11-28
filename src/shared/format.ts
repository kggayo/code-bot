import type { Bot, BotUsage, PendingRequest, PermissionMode, RoutineSchedule, SubagentRole, TaskState } from './types.ts';

/**
 * Words for what code-bot shows: used by the desktop window and the terminal
 * client (src/headless), so both describe things the same way.
 */

export const ROLE_LABEL: Record<SubagentRole, string> = {
  developer: 'Developer',
  qa: 'QA',
  reviewer: 'Reviewer',
  other: 'Sub-agent',
};

/** "$0.042", "$3.10". */
export function money(value: number): string {
  if (value === 0) return '$0';
  return value >= 1 ? `$${value.toFixed(2)}` : `$${value.toFixed(3)}`;
}

/** "12.4k tokens", "1.2M tokens". */
export function tokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M tokens`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k tokens`;
  return `${count} tokens`;
}

/** A bot's usage in one short line, e.g. "$0.42 bot · $3.10 sub-agents". Empty when nothing was used. */
export function usageLine(usage: BotUsage | undefined, main: boolean): string {
  if (!usage) return '';
  const parts: string[] = [];
  if (usage.botUsd > 0) parts.push(`${money(usage.botUsd)} ${main ? 'main bot' : 'bot'}`);
  if (main && usage.projectBotsUsd > 0) parts.push(`${money(usage.projectBotsUsd)} project bots`);
  if (usage.subagentsUsd > 0) parts.push(`${money(usage.subagentsUsd)} sub-agents`);
  if (usage.subagentTokens > 0) parts.push(tokens(usage.subagentTokens));
  return parts.join(' · ');
}

/** "in 2h 10m", "in 3d", "now": how long until a time. */
export function until(iso: string | null): string {
  if (!iso) return '';
  const minutes = Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
  if (minutes <= 0) return 'now';
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`;
  const days = Math.round(hours / 24);
  return `in ${days}d`;
}

/** "Today 09:00", "Tomorrow 09:00", "Mon 1 Dec 09:00". */
export function when(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const today = new Date();
  const days = Math.round(
    (new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() -
      new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) /
      86_400_000,
  );
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  return `${date.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Every weekday at 09:00", "Every 2 hours", "Once, Fri 28 Nov 14:00": a schedule in words. */
export function describeSchedule(schedule: RoutineSchedule): string {
  switch (schedule.kind) {
    case 'once':
      return `Once, ${when(schedule.at)}`;
    case 'daily': {
      const days = schedule.days.join();
      const which =
        schedule.days.length === 7
          ? 'Every day'
          : days === '1,2,3,4,5'
            ? 'Every weekday'
            : days === '0,6'
              ? 'Weekends'
              : `Every ${schedule.days.map((day) => WEEKDAYS[day]).join(', ')}`;
      return `${which} at ${schedule.time}`;
    }
    case 'interval': {
      const { minutes } = schedule;
      if (minutes % 1440 === 0) return minutes === 1440 ? 'Every day' : `Every ${minutes / 1440} days`;
      if (minutes % 60 === 0) return minutes === 60 ? 'Every hour' : `Every ${minutes / 60} hours`;
      return `Every ${minutes} minutes`;
    }
  }
}

export const TASK_ID = /\bt_[0-9a-f]{10}\b/;

export const STATE_LABEL: Record<TaskState, string> = {
  running: 'working',
  waiting: 'needs an answer',
  done: 'done',
  failed: 'failed',
  cancelled: 'stopped',
  interrupted: 'interrupted',
};

export const PERMISSION_LABEL: Record<PermissionMode, string> = {
  plan: 'Plan only: reads and plans, changes nothing',
  default: 'Ask first: asks before edits and commands',
  acceptEdits: 'Edit freely: asks before commands and other risky actions',
  auto: 'Auto: a classifier approves routine actions and asks about the rest',
  bypassPermissions: 'Never ask: runs everything without asking (risky)',
};

export function basename(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function folderLabel(bot: Bot): string {
  const [first, ...rest] = bot.folders;
  if (!first) return '';
  return rest.length ? `${basename(first)} +${rest.length}` : basename(first);
}

export function ago(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

export function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

const str = (value: unknown) => (typeof value === 'string' ? value : '');

/** One line describing a tool a bot used, or null when another line already shows it. */
export function describeTool(name: string, input: unknown): string | null {
  const args = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case 'send_to_project_bot':
      return `Asked ${str(args.bot)}`;
    case 'list_project_bots':
      return 'Checked the project bots';
    case 'project_bot_status':
      return `Checked on ${str(args.bot)}`;
    case 'start_subagent':
      return null;
    case 'get_subagent':
      return `Checked ${str(args.id)}`;
    case 'send_to_subagent':
      return `Wrote to ${str(args.id)}`;
    case 'answer_subagent':
      return args.decline ? `Let ${str(args.id)} decide` : `Answered ${str(args.id)}'s question`;
    case 'cancel_subagent':
      return `Stopped ${str(args.id)}`;
    case 'list_subagents':
      return 'Checked the sub-agents';
    case 'list_routines':
      return 'Checked the routines';
    case 'propose_routine':
      return null;
    case 'git':
      return `git ${Array.isArray(args.args) ? args.args.map(String).join(' ') : ''}`;
    case 'Read':
      return `Read ${basename(str(args.file_path))}`;
    case 'Grep':
      return `Searched for "${clip(str(args.pattern), 60)}"`;
    case 'Glob':
      return `Listed ${clip(str(args.pattern), 60)}`;
    default:
      return name;
  }
}

/** A short line for a sub-agent's tool call. */
export function describeAgentTool(name: string, input: unknown): string {
  const args = (input ?? {}) as Record<string, unknown>;
  const path = str(args.file_path) || str(args.path) || str(args.notebook_path);
  if (path) return `${name} ${basename(path)}`;
  const detail = str(args.command) || str(args.pattern) || str(args.url) || str(args.query) || str(args.description);
  return detail ? `${name} ${clip(detail, 140)}` : name;
}

const records = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];

/** What the agent wants to do, in a few words, by tool. */
export function approvalTitle(request: PendingRequest): string {
  const input = (request.input ?? {}) as Record<string, unknown>;
  switch (request.tool) {
    case 'ExitPlanMode':
      return 'Approve the plan';
    case 'Bash':
    case 'PowerShell':
    case 'shell':
      return 'Run a command';
    case 'Write':
      return `Write ${basename(str(input.file_path)) || 'a file'}`;
    case 'Edit':
    case 'MultiEdit':
      return `Edit ${basename(str(input.file_path)) || 'a file'}`;
    case 'NotebookEdit':
      return `Edit ${basename(str(input.notebook_path)) || 'a notebook'}`;
    case 'apply_patch': {
      const changes = records(input.changes);
      return changes.length === 1 ? `Change ${basename(str(changes[0]?.path))}` : `Change ${changes.length || 'some'} files`;
    }
    case 'WebFetch':
      return 'Open a web page';
    case 'WebSearch':
      return 'Search the web';
    case 'permissions':
      return 'More access than the sandbox allows';
    default:
      return request.tool.startsWith('mcp__') ? `Use ${request.tool.replace(/^mcp__/, '').replace(/__/g, ' · ')}` : `Use ${request.tool}`;
  }
}

