import type { Bot, PermissionMode, TaskState } from '../../../shared/types.ts';

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
