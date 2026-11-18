# Architecture

code-bot is an Electron desktop app. The main process hosts the whole
orchestrator (bots, sub-agents, database); the window is a React interface that
talks to it only over IPC. The orchestrator itself (`src/core`) knows nothing
about Electron, so the same code can later run headless on a server.

```
 ┌────────── window (renderer, sandboxed) ───────────┐
 │ React UI: sidebar · conversation · sub-agent panel │
 └──────────────┬─────────────────────▲───────────────┘
   window.codeBot.call(method, args)  │ 'code-bot:event' (every CoreEvent)
                │ preload bridge      │
 ┌──────────────▼─────────────────────┴───────────────┐
 │ Electron main process                               │
 │  ipc.ts: validates every call (zod) ──► CodeBot     │
 │                                                      │
 │  CodeBot (src/core)                                  │
 │   ├─ BotRuntime "main"      ─┐ Brain (ClaudeBrain):  │
 │   ├─ BotRuntime per project ─┘ one Claude session    │
 │   ├─ TaskManager ─► Engine (ClaudeEngine): one       │
 │   │                 Claude Code process per turn     │
 │   └─ Store (node:sqlite)                             │
 └──────────────────────────────────────────────────────┘
```

## The three levels

| Level | What it is | Runs as | Can |
|---|---|---|---|
| Main bot | The user's software manager. One per app, id `main`. | A Claude session with only its own tools; no file access (`ClaudeBrain`, access `none`). | List project bots, send them messages, check their status. |
| Project bot | The team lead / architect for one project. Created by the user with a name, a description and one or more folders. | A Claude session in the primary folder with read-only access to all its folders and the folders' Claude Code settings and `CLAUDE.md` (`ClaudeBrain`, access `read`). | Read code (Read, Grep, Glob), read-only git, start / message / answer / stop its own sub-agents. Never edits files. |
| Sub-agent | A developer or QA engineer doing one task. Started by a project bot. | A full coding agent (`Engine`, today Claude Code) in one of the project's folders, with the others as additional directories. | Whatever its permission mode allows. Reports back when its turn ends. |

The user talks to the main bot or to a project bot, never has to talk to a
sub-agent (but can open one and write to it).

## Vocabulary

| Term | Meaning |
|---|---|
| Bot | The main bot or a project bot. Stored in `bots`. Has a current thread. |
| Thread | One conversation with a bot (`c_…`). "New conversation" starts a new thread; earlier ones stay, can be read, reopened and archived. |
| Turn | One run of a bot's model over one inbound message or a batch of updates. |
| Task | One sub-agent's work (`t_…`): its brief, settings, state and history. Outlives the agent process. |
| Run | One live engine process working on a task. A task has at most one run at a time. |
| Request | A sub-agent waiting for an answer (`r_…`): a question (`AskUserQuestion`) or approval for a tool call. Kept in the database. |
| Held request | A request whose sub-agent stopped because code-bot closed. Still answerable; answering resumes the sub-agent. |
| Worktree | A sub-agent's own git worktree and branch (`code-bot/<task id>-<title>`), when its project bot isolates sub-agents. |
| Archived | Hidden from the lists (sub-agents, conversations). Archiving a sub-agent removes its worktree folder. |
| Requester | Who asked a project bot for a piece of work: `user` (typed in the project bot's conversation) or `main` (sent by the main bot). Stored on every task as `requestedBy`. |
| Engine | An adapter for one kind of coding agent (`src/core/engines`). |
| Brain | The model behind a bot (`src/core/brain.ts`). |

## Files

| File | Responsibility |
|---|---|
| `src/shared/types.ts` | Types and constants shared by every part: bots, tasks, requests, events, the `CodeBotApi` interface, the preload bridge, IPC channel names. No runtime imports. |
| `src/core/code-bot.ts` | `CodeBot`: the orchestrator facade. Bot CRUD and validation, routing between levels, surfacing requests, bot status, events. |
| `src/core/runtime.ts` | `BotRuntime`: one bot's inbound queue and turn loop. Batches updates, runs the brain, reports the outcome to its host. |
| `src/core/tools.ts` | The tools each kind of bot gets (`mainBotTools`, `projectBotTools`) and the `ToolHost` interface they use. |
| `src/core/prompts.ts` | Every system prompt and how inbound messages are framed for a bot. |
| `src/core/tasks.ts` | `TaskManager`: sub-agent lifecycle, request relay and held requests, limits, follow-ups, cancel, archive, shutdown. |
| `src/core/worktrees.ts` | Creating, removing and restoring sub-agents' git worktrees; copying untracked files into them. |
| `src/core/version.ts` | The version agents see (kept equal to `package.json` by a test). |
| `src/core/brain.ts` | `Brain` interface, `BotTool`, and `ClaudeBrain`. |
| `src/core/scripted-brain.ts` | `ScriptedBrain`: deterministic bots for tests and demo mode. |
| `src/core/engines/types.ts` | The `Engine` contract. |
| `src/core/engines/claude.ts` | Claude Code through the Claude Agent SDK. |
| `src/core/engines/claude-input.ts` | `InputQueue`: streaming input to a Claude Code process. |
| `src/core/engines/codex.ts` | OpenAI Codex through `codex app-server`. |
| `src/core/engines/mock.ts` | `MockEngine`: scripted sub-agent for tests and demo mode. |
| `src/core/git.ts` | Read-only git runner for project bots. |
| `src/core/store.ts` | SQLite persistence (`node:sqlite`, synchronous). Tables `bots`, `threads`, `tasks`, `events`, `requests`, `settings`. Schema version in `PRAGMA user_version`, upgraded by the `MIGRATIONS` list. |
| `src/core/util.ts` | `CodeBotError`, ids, truncation helpers. |
| `src/desktop/main/index.ts` | Electron main process: data folder, engines and brain selection, window, quit handling, single instance. |
| `src/desktop/main/ipc.ts` | The IPC handler: sender check, argument validation for every method, desktop-only methods (folder picker, notifications, open link/folder, terminals). |
| `src/desktop/main/terminal.ts` | Opens a terminal window running one program (sign-in, continuing a session) on Windows, macOS and Linux. |
| `src/desktop/preload/index.ts` | Exposes `window.codeBot` (the `DesktopBridge`). Built as one CommonJS file. |
| `src/desktop/renderer/` | The interface. `src/state.ts` holds all window state; `src/components/` the views. |
| `electron.vite.config.ts` | Build of main, preload and renderer, and the production Content-Security-Policy. |
| `electron-builder.yml` | Packaging per platform. Icons in `build/`, made from `build/icon.svg` by `scripts/make-icons.mjs`. |

## How work flows

### The user asks the main bot

```
user ──"fix the login bug in webshop"──► main bot
main bot ──send_to_project_bot("webshop", brief)──► webshop bot   (inbound "main", replyTo = main)
webshop bot ──start_subagent──► sub-agent t_1        (task.requestedBy = main)
webshop bot's reply ("started t_1 …") ──forwarded──► main bot ──► user
sub-agent t_1 finishes ──update──► webshop bot       (replyTo = t_1.requestedBy = main)
webshop bot reviews, maybe continues or starts QA, then replies ──forwarded──► main bot ──► user
```

### The user asks a project bot directly

Same, except the project bot's turns have `replyTo = user`: its replies stay in
its own conversation and nothing goes to the main bot.

### Rules that make this work

- Every inbound item has a reply target. `user` messages and sub-agent updates
  for user-requested tasks reply to the user (in that thread). Messages from the
  main bot and updates for main-requested tasks reply to `main`.
- When a project bot finishes a turn whose reply target is `main`, its final
  message is delivered to the main bot as a report (`CodeBot.finished` →
  `deliverReport`), and appears in the main conversation as an `inbound` event.
- Tools read `BotRuntime.replyTo` while the turn runs, so a sub-agent started
  during a turn for the main bot is tagged `requestedBy: main`, and a follow-up
  QA sub-agent started while reviewing that work inherits it.
- Each bot runs one turn at a time (`BotRuntime` queue). Different bots run in
  parallel, and so do sub-agents (up to the `maxActiveSubagents` setting,
  default 12; more is refused with `busy`).
- Batching: consecutive sub-agent updates with the same reply target share a
  turn; questions share a turn with other questions; reports to the main bot
  share a turn. Messages from people and from the main bot always get their own.
- Out-of-date updates are dropped when the turn is prepared (`CodeBot.prepare`):
  a question already answered or already with the user, or a "finished" for a
  task that has been continued since.

### Questions and approvals

| Request | First goes to | If not answered there |
|---|---|---|
| Question (`AskUserQuestion`) | The owning project bot, as an update in a turn of its own. It may answer with `answer_subagent` when the answer is clear. | After that turn, or after `questionTimeoutMs` (2 minutes) if the bot is busy, it is put to the user. |
| Approval (any other tool call) | The user, immediately. Bots cannot approve actions. | Stays open until the user answers or the sub-agent stops. |

"Put to the user" (`CodeBot.surface`) means a `request.surfaced` event in the
conversation of whoever asked for the work: the main bot's conversation if
`requestedBy` is `main`, otherwise the project bot's. That is where the user is
already talking, so they never have to open the sub-agent. When the request is
answered or withdrawn, a `request.closed` event follows in the same
conversation. "New conversation" (and reopening an earlier one) moves open
requests into the conversation that is now current.

`BotStatus.needsYou` counts open requests surfaced in a bot's current thread;
the sidebar shows it as a badge.

## Sub-agent lifecycle

States (`TaskState` in `src/shared/types.ts`):

| State | Meaning | Leaves it when |
|---|---|---|
| `running` | A run is working. | It asks something, finishes, fails or is stopped. |
| `waiting` | The run is blocked on at least one open request. | Every request is answered (back to `running`) or the run ends. |
| `done` | The last turn finished. | A follow-up message starts a new run in the same session. |
| `failed` | The last turn ended with an error. | A follow-up message retries in the same session. |
| `cancelled` | Stopped. | A follow-up message resumes it. |
| `interrupted` | The app quit while it was working. | A follow-up message resumes it. |

Each turn after the first is a new engine process that resumes the stored
engine session id. Messages sent while a run is closing are kept and start the
next turn.

### Requests that survive a restart

Every request is written to the `requests` table when it is made and deleted
when it is answered or withdrawn. When code-bot closes while a sub-agent waits,
its process ends but the request stays: after the restart it is "held"
(`PendingRequest.held`), still shown as an open card in the conversation it was
put to (or put to the user then, if it never was), and the task is
`interrupted`. Answering it does not reach a waiting process; instead, once the
sub-agent's last held request is answered, the task resumes its session with a
note listing the answers (`heldAnswersPrompt` in `src/core/tasks.ts`). An
approved call is remembered as a grant: the hash of the tool name and its full
input (`callKey`). When the resumed agent makes exactly that call again, it is
allowed once without asking. Sending the sub-agent a message instead withdraws
its unanswered held requests and resumes it with the message.

This works the same for every engine. Claude Code's own way to pause a tool call
(a `PreToolUse` hook returning `defer`) was not used: see decision 19.

### Limits

A project's sub-agent settings may set `maxTurns` (per run) and `maxBudgetUsd`
(per sub-agent). They are read from the project bot before every run
(`CodeBot.prepareTurn`), so raising them lets a stopped sub-agent continue. The
budget is checked against the task's `costUsd` (the engine's estimate for the
whole session): a run gets the remaining amount as its `maxBudgetUsd`, and none
starts once it is used up. A run stopped by a limit ends `failed` with a message
saying which limit, and its project bot hears about it like any failure.

### Worktrees

With `subagents.isolation: "worktree"` on a project bot (or `worktree: true` on
one `start_subagent` call), `CodeBot.startSubagent` first runs
`createWorktree` (`src/core/worktrees.ts`):

1. `git worktree add -b code-bot/<task id>-<title words> <worktrees>/<task id> <HEAD>`
   from the folder's repository, where `<worktrees>` is `<userData>/worktrees`.
2. The sub-agent starts in the worktree (or its subfolder matching the project
   folder, when the folder is inside a larger repository).
3. Files matching the project's `worktreeFiles` patterns (default `.env`,
   `.env.*`) are copied from the project folder when the checkout lacks them.
   Patterns are relative paths with `*`, `?` and `**`; `node_modules` and
   `.git` are never searched.

The sub-agent is told its branch and to commit there. The project bot can read
the worktrees of its recent sub-agents and run its read-only `git` in them; it
brings work in by reporting the branch or by starting a sub-agent with
`worktree: false` to merge it. Archiving a sub-agent removes its worktree
(refused with uncommitted changes unless they are discarded on purpose) and
deletes the branch only if it is merged into the project folder's current
branch. A message to a sub-agent whose worktree was removed brings it back from
the branch at the same path, so its session can continue. A folder that is not
in a git repository, or has no commits, cannot have worktrees: the tool call
fails with that reason.

### Archive and retention

Stopped sub-agents and earlier conversations can be archived by hand, and are
archived automatically after `archiveAfterDays` without activity (default 30;
sub-agents with uncommitted worktree changes or held requests are skipped).
Archived items are deleted, with their history, `deleteArchivedAfterDays` after
archiving (default 0: never). `CodeBot.runRetention` runs a minute after start
and every six hours.

## Engine contract

`src/core/engines/types.ts`:

```ts
interface Engine {
  readonly id: string;
  readonly label: string;                       // "Claude Code"
  start(options: EngineRunOptions, askUser: AskUser): EngineRun;
  check?(): Promise<EngineCheck>;              // installed and signed in? no model usage
  resumeCommand?(sessionId: string): TerminalCommand | undefined;  // continue in a terminal
}
interface EngineRun {
  events: AsyncIterable<EngineEvent>; // ends when the run is over
  send(text: string): boolean;        // steer mid-run; false if already ended
  interrupt(): Promise<void>;
}
```

`EngineRunOptions` carries `cwd`, `additionalDirectories`, `prompt`, `model`,
`effort`, `permissionMode` (code-bot's names; engines map them), `resumeSessionId`,
`instructions` (appended to the engine's own system prompt; code-bot uses it to
tell the sub-agent who its team lead is and how to report), and `maxTurns` /
`maxBudgetUsd` (engines that cannot enforce them ignore them). A `result` event
sets `limit` when a limit stopped the run.

`check()` is what the window's sign-in banner and settings show
(`CodeBot.checkEngines`); when it returns a `signIn` command, the window offers
a button that opens a terminal running it. `resumeCommand` backs "Open in
terminal" on a stopped sub-agent: the command runs in the sub-agent's folder.

To add an engine: implement the contract in `src/core/engines/<name>.ts` (with a
`label`, and `check()` and `resumeCommand()` when the agent supports them) and
add it to the `engines` array in `src/desktop/main/index.ts`. It then appears in
the bot settings' "Coding agent" choice, in the sign-in banner and in Settings.
Nothing else changes. Give it a test against a fake of the agent (no model
usage, like `test/codex.test.ts`) and a live check script (like
`scripts/codex-check.ts`).

Approval requests should carry only what identifies the action (the command and
folder, the file and its change) in `input`, and put the agent's reasoning in
`summary`: an approval given after a restart is matched by tool and exact input.

### Claude engine specifics

- One `query()` per run: one Claude Code process with `cwd` set to the folder.
- `settingSources` is left unset, so the sub-agent loads user, project and local
  settings: the project's `CLAUDE.md`, skills, MCP servers and permission rules.
- The prompt is an `InputQueue` (streaming input), so messages can be sent
  mid-run and `interrupt()` works. The queue closes after a `result` with
  nothing queued, which lets the process exit.
- `systemPrompt` is the `claude_code` preset with code-bot's instructions
  appended; `tools` is the `claude_code` preset.
- `bypassPermissions` also sets `allowDangerouslySkipPermissions`.
- Credentials are whatever Claude Code finds on the machine. code-bot never
  handles them. `check()` runs `claude auth status` (JSON) with the same
  binary; signing in is `claude auth login` in a terminal.
- `resumeCommand` is `claude --resume <session id>` with the same binary.
- `maxTurns` and `maxBudgetUsd` are passed to the SDK; its
  `error_max_turns` and `error_max_budget_usd` results set `limit`.
- Claude Code keeps every session's transcript in its own history for that
  folder (`~/.claude/projects/…`). code-bot relies on that to resume, and it
  means project bot and sub-agent sessions also show up in `claude --resume`
  in those folders.
- The SDK ships Claude Code as a per-platform npm package
  (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>`). In a packaged app the
  main process passes the unpacked path explicitly (`claudeExecutable` in
  `src/desktop/main/index.ts`), because a binary inside `app.asar` cannot run.
  `CODE_BOT_CLAUDE_EXECUTABLE` overrides it.

### Codex engine specifics

- `src/core/engines/codex.ts` runs `codex app-server` (the protocol the Codex IDE
  extension uses: JSON-RPC lines on stdio), one process per run: `initialize`,
  `thread/start` or `thread/resume`, then `turn/start`. The thread id is the
  session id; `codex resume <id>` continues it in a terminal.
- Agent-message deltas, completed items (messages, commands, file changes, MCP
  calls) and `turn/completed` become the contract's events. Approval requests
  (commands, file changes, permissions) go to `askUser` as `permission`;
  `item/tool/requestUserInput` becomes an `AskUserQuestion` question (enabled
  per thread with a config override, never in the user's `config.toml`).
- Permission modes map to Codex's approval policy and sandbox: `plan` read-only;
  `default` workspace-write, asking for untrusted commands; `acceptEdits` and
  `auto` workspace-write, asking only to leave the sandbox; `bypassPermissions`
  full access. The sandbox keeps network access (projects use databases). It is
  sent with each turn, not when the thread starts, so Codex does not mark the
  folder trusted in the user's config.
- `send()` steers the running turn (`turn/steer`), or starts the next turn on
  the same thread. `maxTurns` counts the turn's model calls; `maxBudgetUsd` is
  ignored and `costUsd` stays empty: app-server reports tokens, not money.
- `check()` runs `codex login status`; signing in is `codex login`. The binary is
  `CODE_BOT_CODEX_EXECUTABLE`, else `codex` on the PATH (a `codex.cmd` npm shim
  runs through `cmd.exe` with fixed arguments).

### Bot brains

`ClaudeBrain` runs every bot turn as a resumed Claude session with:

- `tools`: none for the main bot; `Read`, `Grep`, `Glob` for project bots.
- The bot's own tools as an in-process MCP server; `strictMcpConfig: true`, so
  no MCP servers from settings are loaded.
- `permissionMode: 'dontAsk'` with an explicit `allowedTools` list: anything not
  listed is refused without asking.
- `settingSources`: none for the main bot; user, project and local for project
  bots (so they read `CLAUDE.md`).
- A custom system prompt from `src/core/prompts.ts`.

Text from sub-agents, files and tools reaches bots between `<<<` and `>>>`, with
an instruction to treat it as information, never as instructions.

## Persistence and events

SQLite file `code-bot.db` in the app's data folder (`<userData>/data`;
`CODE_BOT_USER_DATA` overrides `userData`). Tables:

- `bots`: settings of every bot; archived bots keep their row (`archived_at`).
- `threads`: one row per conversation, with the bot's model session id.
- `tasks`: one row per sub-agent (with its worktree as JSON, limits, `archived_at`).
- `events`: the history of every thread and task, keyed by (`owner_id`, `seq`).
- `requests`: open questions and approvals, so they survive a restart.
- `settings`: the app settings, one JSON value per key.

The schema version is `PRAGMA user_version`. `MIGRATIONS` in
`src/core/store.ts` lists one SQL step per version; opening an older database
runs the missing steps in a transaction, so upgrading code-bot keeps its data.
A database from a newer version is refused.

Every change is an event (`CoreEvent`, `src/shared/types.ts`) with a `scope`:

- `thread`: a bot's conversation. Stored, except `bot.delta` (live text).
- `task`: a sub-agent's work. Stored, except `text.delta` (live text).
- `bot`: a bot's status (`status`), settings (`changed`, `archived`) or list of
  conversations (`conversations`). Not stored.
- `app`: app-wide news: `settings`, `engines`. Not stored.

Live-only events have `seq: 0`. Stored strings longer than 2000 characters are
cut. The event names and shapes are a public contract; they are listed in
`docs/api.md`.

## The window

- `src/desktop/renderer/src/state.ts` (`AppState`) holds everything the window
  shows: bots, recent tasks, open requests, loaded conversations and sub-agent
  logs. It applies every `CoreEvent` it receives and re-renders at most about
  once a frame; clicks (navigation) re-render immediately.
- A conversation or a task log is fetched when first opened; events arriving
  during the fetch are buffered and applied after it, deduplicated by `seq`.
- Notifications: when something happens in a conversation the user is not
  looking at (a question or approval, or a reply to the user), the window asks
  the main process for a system notification; clicking it opens that bot.
  A project bot's reply to the main bot does not notify (the main bot's report
  does).
- A banner at the top appears when a coding agent the app needs (Claude Code
  for the bots, plus any agent a project uses) is not installed or not signed
  in, with a Sign in button where the agent supports it. It checks again when
  the window regains focus.
- "Conversations" lists a bot's conversations; an earlier one opens read-only
  with "Continue this conversation". The sub-agent panel can show archived
  sub-agents; a stopped sub-agent has Archive and, where its engine supports
  it, Open in terminal.
- Agent output is rendered with `react-markdown` and `remark-gfm`, with raw
  HTML skipped, remote images replaced by their alt text, web links opened in
  the default browser, and sub-agent ids (`t_…`) turned into buttons.

## Security model

- The window is sandboxed (`sandbox`, `contextIsolation`, no `nodeIntegration`),
  cannot navigate or open windows, and all browser permissions are refused.
- The built page has a strict Content-Security-Policy (no inline script or
  style, no network). The dev server has none, for hot reload.
- `ipc.ts` accepts calls only from the app window's main frame and validates
  every argument with zod.
- `openPath` only opens folders that belong to a bot or are a sub-agent's
  worktree (opening a file could run it); `openExternal` only opens http(s)
  links. Terminals run only an engine's own sign-in or resume command, with
  arguments passed as a list (no shell), in a folder code-bot chose.
- Worktrees are created and removed by code-bot itself when a project is set to
  isolate sub-agents, never on a bot's request; the bots' `git` stays read-only.
- Bots cannot change files or run commands; project bots read only their own
  folders, and git is limited to read-only subcommands with arguments that write
  or run programs refused (`src/core/git.ts`).
- A project bot can only see and control its own sub-agents, can only answer
  questions (never approve actions), and can only start sub-agents with the
  project's permission mode or a stricter one.
- What a sub-agent may do without asking is set by the project's permission
  mode and the project's own Claude Code permission rules. It runs as the
  user, with the user's access to everything on the machine.
