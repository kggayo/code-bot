/**
 * The contract every coding agent ("engine") implements, so sub-agents can be
 * Claude Code, Codex or anything else without the core knowing.
 */
import type { UserResponse } from '../../shared/types.ts';

export type { UserResponse };

export interface EngineRunOptions {
  /** Directory the agent starts in. */
  cwd: string;
  /** Further folders the agent may work in. */
  additionalDirectories?: string[];
  prompt: string;
  model?: string;
  effort?: string;
  /**
   * How much the agent may do without asking, as one of code-bot's modes
   * (strictest first): plan, default, acceptEdits, auto, bypassPermissions.
   * Engines map these onto their own approval settings.
   */
  permissionMode?: string;
  /** Continue an earlier session of this engine instead of starting fresh. */
  resumeSessionId?: string;
  /** Standing instructions appended to the engine's own system prompt. */
  instructions?: string;
  /** Stop this run after this many agentic turns. Engines that cannot enforce it ignore it. */
  maxTurns?: number;
  /** Stop this run once its estimated cost passes this many US dollars. Engines that cannot enforce it ignore it. */
  maxBudgetUsd?: number;
}

export type EngineEvent =
  /** The engine's own session id, needed to resume later. */
  | { type: 'session'; sessionId: string; model?: string }
  /** A complete assistant message. */
  | { type: 'text'; text: string }
  /** A streamed fragment of the message being written. Live only, never stored. */
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; isError: boolean; preview: string }
  /** A turn ended. The run itself is over when the event stream ends. */
  | {
      type: 'result';
      ok: boolean;
      text: string;
      error?: string;
      /** Set when the run stopped because it reached maxTurns or maxBudgetUsd. */
      limit?: 'turns' | 'budget';
      /** Estimated cost of the whole session so far, when the engine knows it. */
      costUsd?: number;
      durationMs?: number;
      numTurns?: number;
    };

/** Something the agent needs from a person before it can continue. */
export interface UserRequest {
  kind: 'permission' | 'question';
  /**
   * Tool the agent wants to run, or "AskUserQuestion" for questions. Question
   * input has the shape { questions: [{ question, header?, multiSelect?,
   * options: [{ label, description? }] }] } and the answer comes back as
   * `answers`: question text → chosen label or free text.
   */
  tool: string;
  input: unknown;
  /** Short human-readable description, when the engine provides one. */
  summary?: string;
}

/** Supplied by the orchestrator; resolves when someone has answered. */
export type AskUser = (request: UserRequest, signal: AbortSignal) => Promise<UserResponse>;

export interface EngineRun {
  events: AsyncIterable<EngineEvent>;
  /** Send a message to the agent while it is still working. False if the run already ended. */
  send(text: string): boolean;
  /** Stop the current turn. The events stream ends shortly after. */
  interrupt(): Promise<void>;
}

/** A program for the user to run in a terminal window. */
export interface TerminalCommand {
  command: string;
  args: string[];
}

/** Whether an engine can run on this machine. */
export interface EngineCheck {
  /** Installed and signed in: runs can start. */
  ready: boolean;
  /** One line for the user: what was found, or what is wrong. */
  detail: string;
  /** Run this in a terminal to sign in, when signing in is what is missing. */
  signIn?: TerminalCommand;
}

export interface Engine {
  readonly id: string;
  /** Name shown to people, for example "Claude Code". */
  readonly label: string;
  start(options: EngineRunOptions, askUser: AskUser): EngineRun;
  /** Checks that the agent is installed and signed in. Must not use model usage. */
  check?(): Promise<EngineCheck>;
  /** The command that continues a session interactively; it is run in the session's working folder. */
  resumeCommand?(sessionId: string): TerminalCommand | undefined;
}
