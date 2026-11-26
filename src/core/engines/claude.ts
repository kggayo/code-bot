import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { CanUseTool, EffortLevel, Options, PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import { InputQueue } from './claude-input.ts';
import { CLIENT_APP } from '../version.ts';
import type {
  AskUser,
  Engine,
  EngineCheck,
  EngineEvent,
  EngineRun,
  EngineRunOptions,
  EngineUsageReport,
  TerminalCommand,
  UsageWindow,
} from './types.ts';

const PERMISSION_MODES: readonly PermissionMode[] = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
];
const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const QUESTION_TOOL = 'AskUserQuestion';
const PREVIEW_LIMIT = 2000;

function preview(content: unknown): string {
  let text: string;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((part) =>
        part && typeof part === 'object' && 'text' in part && typeof part.text === 'string'
          ? part.text
          : `[${(part as { type?: string })?.type ?? 'content'}]`,
      )
      .join('\n');
  } else {
    text = content == null ? '' : JSON.stringify(content);
  }
  return text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}… (${text.length} chars)` : text;
}

/**
 * The Claude Code binary that ships with the Agent SDK (a per-platform
 * package), or undefined when it is not installed. Inside a packaged Electron
 * app this is a path into app.asar, which the caller must map to the unpacked
 * copy before running it.
 */
export function bundledClaudeExecutable(): string | undefined {
  const require = createRequire(import.meta.url);
  const binary = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const packages = [`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`];
  if (process.platform === 'linux') packages.push(`@anthropic-ai/claude-agent-sdk-linux-${process.arch}-musl`);
  for (const name of packages) {
    try {
      const path = require.resolve(`${name}/${binary}`);
      if (existsSync(path)) return path;
    } catch {
      // Not installed for this platform; try the next.
    }
  }
  return undefined;
}

/** Runs a command and returns its output, without a shell. Never rejects. */
function run(command: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string; error?: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : error ? null : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr), error: error && code === null ? error.message : undefined });
    });
  });
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USAGE_TIMEOUT_MS = 30_000;

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const percent = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const isoTime = (value: unknown): string | null => {
  if (typeof value !== 'string' || !value) return null;
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? null : time.toISOString();
};
const severityOf = (value: unknown): UsageWindow['severity'] =>
  value === 'normal' || value === 'warning' || value === 'critical' ? value : null;

/** What a scoped usage row is for: a model or a surface, by its display name. */
function scopeName(row: Json): string {
  const scope = isRecord(row.scope) ? row.scope : undefined;
  for (const part of [scope?.model, scope?.surface]) {
    if (isRecord(part) && typeof part.display_name === 'string' && part.display_name) return part.display_name;
  }
  return '';
}

/** A label for one of the plan's usage rows. Rows are classified by their kind, never by the server's labels. */
function limitLabel(row: Json): string {
  const scoped = scopeName(row);
  switch (row.kind) {
    case 'session':
      return '5-hour session';
    case 'weekly_all':
      return 'Week · all models';
    case 'weekly_scoped':
      return scoped ? `Week · ${scoped}` : 'Week · some models';
    default: {
      const words = String(row.kind ?? row.group ?? 'limit').replace(/_/g, ' ');
      return scoped ? `${words} · ${scoped}` : words;
    }
  }
}

/** The plan's limit windows from Claude Code's /usage data, newest format first. */
export function claudeUsageWindows(rateLimits: unknown): UsageWindow[] {
  if (!isRecord(rateLimits)) return [];
  if (Array.isArray(rateLimits.limits) && rateLimits.limits.length > 0) {
    return rateLimits.limits.filter(isRecord).map((row) => {
      return {
        id: [String(row.kind ?? 'limit'), scopeName(row).toLowerCase()].filter(Boolean).join(':'),
        label: limitLabel(row),
        usedPercent: percent(row.percent),
        resetsAt: isoTime(row.resets_at),
        severity: severityOf(row.severity),
      };
    });
  }
  const named: [string, string][] = [
    ['five_hour', '5-hour session'],
    ['seven_day', 'Week · all models'],
    ['seven_day_opus', 'Week · Opus'],
    ['seven_day_sonnet', 'Week · Sonnet'],
  ];
  return named.flatMap(([key, label]) => {
    const window = rateLimits[key];
    if (!isRecord(window)) return [];
    return [{ id: key, label, usedPercent: percent(window.utilization), resetsAt: isoTime(window.resets_at), severity: null }];
  });
}

/**
 * Runs Claude Code through the Claude Agent SDK. Each run is its own Claude Code
 * process in the project folder, loading that project's CLAUDE.md, skills, MCP
 * servers and permission rules as an interactive session would. Credentials are
 * whatever Claude Code finds on this machine (login, token or API key).
 */
export class ClaudeEngine implements Engine {
  readonly id = 'claude';
  readonly label = 'Claude Code';
  private readonly executable: string | undefined;

  constructor(options: { executable?: string } = {}) {
    this.executable = options.executable;
  }

  /** The binary runs use: the one given, else the SDK's bundled one. */
  private binary(): string | undefined {
    return this.executable ?? bundledClaudeExecutable();
  }

  async check(): Promise<EngineCheck> {
    const binary = this.binary();
    if (!binary) return { ready: false, detail: 'Claude Code was not found: reinstall code-bot.' };
    const signIn: TerminalCommand = { command: binary, args: ['auth', 'login'] };
    const result = await run(binary, ['auth', 'status'], 30_000);
    let status: { loggedIn?: unknown; authMethod?: unknown; subscriptionType?: unknown; apiProvider?: unknown } | undefined;
    try {
      status = JSON.parse(result.stdout) as typeof status;
    } catch {
      status = undefined;
    }
    if (!status) {
      const reason = result.error ?? (result.stderr.trim().split(/\r?\n/).pop() || `exit code ${result.code}`);
      return { ready: false, detail: `Could not check the Claude Code sign-in: ${reason}`, signIn };
    }
    if (status.loggedIn !== true) {
      return { ready: false, detail: 'Claude Code is not signed in on this computer.', signIn };
    }
    const how = [
      typeof status.authMethod === 'string' ? status.authMethod : '',
      typeof status.subscriptionType === 'string' ? `${status.subscriptionType} plan` : '',
    ].filter(Boolean);
    return { ready: true, detail: `Claude Code is signed in${how.length ? ` (${how.join(', ')})` : ''}.` };
  }

  resumeCommand(sessionId: string): TerminalCommand | undefined {
    const binary = this.binary();
    if (!binary || !SESSION_ID.test(sessionId)) return undefined;
    return { command: binary, args: ['--resume', sessionId] };
  }

  /**
   * The plan's limits, as Claude Code's /usage shows them. Starts a Claude Code
   * process without a prompt and asks it; no model usage. The SDK marks this
   * call experimental, so any failure becomes a note instead of an error.
   */
  async usage(): Promise<EngineUsageReport> {
    const input = new InputQueue();
    const abortController = new AbortController();
    const stream = query({
      prompt: input,
      options: {
        cwd: homedir(),
        settingSources: [],
        tools: [],
        strictMcpConfig: true,
        permissionMode: 'dontAsk',
        persistSession: false,
        pathToClaudeCodeExecutable: this.executable,
        abortController,
        env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP },
      },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const answer = await Promise.race([
        stream.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Claude Code did not answer in time')), USAGE_TIMEOUT_MS);
        }),
      ]);
      const plan = typeof answer.subscription_type === 'string' ? answer.subscription_type : null;
      if (!answer.rate_limits_available || !answer.rate_limits) {
        return { plan, windows: [], note: 'No plan limits: Claude Code is signed in with an API key or a cloud provider.' };
      }
      const windows = claudeUsageWindows(answer.rate_limits);
      return { plan, windows, note: windows.length ? null : 'Claude Code reported no limits for this plan.' };
    } catch (error) {
      return { plan: null, windows: [], note: `Could not read the plan limits: ${error instanceof Error ? error.message : String(error)}` };
    } finally {
      clearTimeout(timer);
      input.close();
      abortController.abort();
    }
  }

  start(options: EngineRunOptions, askUser: AskUser): EngineRun {
    const permissionMode = options.permissionMode as PermissionMode | undefined;
    if (permissionMode && !PERMISSION_MODES.includes(permissionMode)) {
      throw new Error(
        `Unknown permission mode "${permissionMode}" for claude. Use one of: ${PERMISSION_MODES.join(', ')}`,
      );
    }
    const effort = options.effort as EffortLevel | undefined;
    if (effort && !EFFORT_LEVELS.includes(effort)) {
      throw new Error(`Unknown effort "${effort}" for claude. Use one of: ${EFFORT_LEVELS.join(', ')}`);
    }

    const input = new InputQueue();
    input.push(options.prompt);
    const abortController = new AbortController();
    const stderrTail: string[] = [];

    const canUseTool: CanUseTool = async (toolName, toolInput, context) => {
      const isQuestion = toolName === QUESTION_TOOL;
      const response = await askUser(
        {
          kind: isQuestion ? 'question' : 'permission',
          tool: toolName,
          input: toolInput,
          summary: context.title ?? context.description ?? context.decisionReason,
        },
        context.signal,
      );
      if (response.decision === 'deny') {
        return { behavior: 'deny', message: response.message || 'The request was declined.' };
      }
      return {
        behavior: 'allow',
        updatedInput: isQuestion ? { ...toolInput, answers: response.answers ?? {} } : toolInput,
      };
    };

    const sdkOptions: Options = {
      cwd: options.cwd,
      additionalDirectories: options.additionalDirectories?.length ? options.additionalDirectories : undefined,
      model: options.model,
      effort,
      permissionMode,
      allowDangerouslySkipPermissions: permissionMode === 'bypassPermissions' ? true : undefined,
      resume: options.resumeSessionId,
      maxTurns: options.maxTurns,
      maxBudgetUsd: options.maxBudgetUsd,
      canUseTool,
      includePartialMessages: true,
      systemPrompt: options.instructions
        ? { type: 'preset', preset: 'claude_code', append: options.instructions }
        : { type: 'preset', preset: 'claude_code' },
      tools: { type: 'preset', preset: 'claude_code' },
      pathToClaudeCodeExecutable: this.executable,
      abortController,
      env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP },
      stderr: (data) => {
        stderrTail.push(data);
        if (stderrTail.length > 20) stderrTail.shift();
      },
    };

    const stream = query({ prompt: input, options: sdkOptions });

    async function* events(): AsyncGenerator<EngineEvent> {
      let sawResult = false;
      try {
        for await (const message of stream) {
          if (message.type === 'system' && message.subtype === 'init') {
            yield { type: 'session', sessionId: message.session_id, model: message.model };
          } else if (message.type === 'stream_event') {
            const event = message.event;
            if (
              message.parent_tool_use_id === null &&
              event.type === 'content_block_delta' &&
              event.delta.type === 'text_delta'
            ) {
              yield { type: 'text_delta', text: event.delta.text };
            }
          } else if (message.type === 'assistant') {
            // Only the agent's own messages; its internal helpers stay internal.
            if (message.parent_tool_use_id !== null) continue;
            for (const block of message.message.content) {
              if (block.type === 'text' && block.text.trim()) {
                yield { type: 'text', text: block.text };
              } else if (block.type === 'tool_use') {
                yield { type: 'tool_use', id: block.id, name: block.name, input: block.input };
              }
            }
          } else if (message.type === 'user') {
            if (message.parent_tool_use_id !== null) continue;
            const content = message.message.content;
            if (!Array.isArray(content)) continue;
            for (const block of content) {
              if (block.type === 'tool_result') {
                yield {
                  type: 'tool_result',
                  id: block.tool_use_id,
                  isError: block.is_error === true,
                  preview: preview(block.content),
                };
              }
            }
          } else if (message.type === 'result') {
            sawResult = true;
            const ok = message.subtype === 'success' && !message.is_error;
            const limit =
              message.subtype === 'error_max_turns' ? 'turns' : message.subtype === 'error_max_budget_usd' ? 'budget' : undefined;
            yield {
              type: 'result',
              ok,
              text: message.subtype === 'success' ? message.result : '',
              error: ok
                ? undefined
                : message.subtype === 'success'
                  ? message.result
                  : message.errors.join('\n') || message.subtype,
              limit,
              costUsd: message.total_cost_usd,
              durationMs: message.duration_ms,
              numTurns: message.num_turns,
            };
            // Nothing else queued: let the process exit. A follow-up resumes the session.
            if (!message.queued_turn_count && input.pending === 0) input.close();
          }
        }
      } catch (error) {
        if (!sawResult) {
          const detail = error instanceof Error ? error.message : String(error);
          const stderr = stderrTail.join('').trim();
          yield {
            type: 'result',
            ok: false,
            text: '',
            error: stderr ? `${detail}\n${stderr.slice(-PREVIEW_LIMIT)}` : detail,
          };
          sawResult = true;
        }
      } finally {
        input.close();
      }
      if (!sawResult) {
        yield { type: 'result', ok: false, text: '', error: 'The agent stopped without reporting a result.' };
      }
    }

    return {
      events: events(),
      send: (text) => input.push(text),
      interrupt: async () => {
        // Ask politely first so the session transcript stays resumable, then force it.
        const force = setTimeout(() => abortController.abort(), 5000);
        force.unref();
        try {
          await stream.interrupt();
        } catch {
          abortController.abort();
        } finally {
          input.close();
        }
      },
    };
  }
}
