import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import type { EffortLevel, Options } from '@anthropic-ai/claude-agent-sdk';
import type { z } from 'zod';
import { InputQueue } from './engines/claude-input.ts';
import { CLIENT_APP, CODE_BOT_VERSION } from './version.ts';

/** A tool a bot can call. `run` returns JSON-serialisable data or throws. */
export interface BotTool {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  /** True for tools that only read; the rest change something. */
  readOnly?: boolean;
  run(args: Record<string, unknown>): unknown | Promise<unknown>;
}

export interface BrainInput {
  botId: string;
  prompt: string;
  /** Continue this earlier conversation. */
  sessionId?: string;
  systemPrompt: string;
  tools: BotTool[];
  model?: string;
  effort?: string;
  cwd: string;
  additionalDirectories?: string[];
  /**
   * none: only the bot's own tools (the main bot).
   * read: also read-only access to the folders (Read, Grep, Glob), with the
   *       folders' Claude Code settings and CLAUDE.md loaded (project bots).
   */
  access: 'none' | 'read';
  signal: AbortSignal;
}

export type BrainEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'text_delta'; text: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; input: unknown }
  /** text: the final message of the turn. */
  | { type: 'result'; ok: boolean; text: string; error?: string };

/** The model behind a bot. One call is one turn of the conversation. */
export interface Brain {
  run(input: BrainInput): AsyncIterable<BrainEvent>;
}

const SERVER = 'code-bot';
const TOOL_PREFIX = `mcp__${SERVER}__`;
const READ_TOOLS = ['Read', 'Grep', 'Glob'];

/**
 * Claude as the main bot or a project bot. The bot never gets tools that
 * change files or run commands: its own tools, plus read-only file access for
 * project bots. Anything not explicitly allowed is refused without asking.
 */
export class ClaudeBrain implements Brain {
  private readonly executable: string | undefined;

  constructor(options: { executable?: string } = {}) {
    this.executable = options.executable;
  }

  async *run(input: BrainInput): AsyncGenerator<BrainEvent> {
    const server = createSdkMcpServer({
      name: SERVER,
      version: CODE_BOT_VERSION,
      alwaysLoad: true,
      tools: input.tools.map((definition) =>
        tool(
          definition.name,
          definition.description,
          definition.schema,
          async (args) => {
            try {
              const output = await definition.run(args as Record<string, unknown>);
              const text = typeof output === 'string' ? output : JSON.stringify(output);
              return { content: [{ type: 'text' as const, text }] };
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
            }
          },
          definition.readOnly ? { annotations: { readOnlyHint: true } } : undefined,
        ),
      ),
    });

    const queue = new InputQueue();
    queue.push(input.prompt);
    const abortController = new AbortController();
    if (input.signal.aborted) abortController.abort();
    input.signal.addEventListener('abort', () => abortController.abort(), { once: true });

    const readAccess = input.access === 'read';
    const options: Options = {
      cwd: input.cwd,
      additionalDirectories: input.additionalDirectories?.length ? input.additionalDirectories : undefined,
      model: input.model,
      effort: input.effort as EffortLevel | undefined,
      resume: input.sessionId,
      systemPrompt: input.systemPrompt,
      tools: readAccess ? READ_TOOLS : [],
      mcpServers: { [SERVER]: server },
      strictMcpConfig: true,
      allowedTools: [...(readAccess ? READ_TOOLS : []), ...input.tools.map((definition) => TOOL_PREFIX + definition.name)],
      permissionMode: 'dontAsk',
      settingSources: readAccess ? ['user', 'project', 'local'] : [],
      includePartialMessages: true,
      pathToClaudeCodeExecutable: this.executable,
      abortController,
      env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP },
    };

    let sawResult = false;
    let lastText = '';
    try {
      for await (const message of query({ prompt: queue, options })) {
        if (message.type === 'system' && message.subtype === 'init') {
          yield { type: 'session', sessionId: message.session_id };
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
          if (message.parent_tool_use_id !== null) continue;
          for (const block of message.message.content) {
            if (block.type === 'text' && block.text.trim()) {
              lastText = block.text;
              yield { type: 'text', text: block.text };
            } else if (block.type === 'tool_use') {
              const name = block.name.startsWith(TOOL_PREFIX) ? block.name.slice(TOOL_PREFIX.length) : block.name;
              yield { type: 'tool', name, input: block.input };
            }
          }
        } else if (message.type === 'result') {
          sawResult = true;
          const ok = message.subtype === 'success' && !message.is_error;
          yield {
            type: 'result',
            ok,
            text: ok ? message.result || lastText : '',
            error: ok
              ? undefined
              : message.subtype === 'success'
                ? message.result
                : message.errors.join('\n') || message.subtype,
          };
          if (!message.queued_turn_count && queue.pending === 0) queue.close();
        }
      }
    } catch (error) {
      if (!sawResult) {
        sawResult = true;
        yield { type: 'result', ok: false, text: '', error: error instanceof Error ? error.message : String(error) };
      }
    } finally {
      queue.close();
    }
    if (!sawResult) yield { type: 'result', ok: false, text: '', error: 'The bot stopped without replying.' };
  }
}
