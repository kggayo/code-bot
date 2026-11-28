# Architecture

code-bot is an Electron desktop app and a headless command. In the app, the
main process hosts the whole orchestrator (bots, sub-agents, database) and the
window is a React interface that talks to it only over IPC. Headless,
`code-bot serve` hosts the same orchestrator without a window, and terminals
talk to it over HTTP on 127.0.0.1 (see "Headless and the terminal" below). The
orchestrator itself (`src/core`) knows nothing about Electron.

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
| `src/core/tasks.ts` | `TaskManager`: sub-agent lifecycle, request relay and held requests, limits, follow-ups, permission changes, cancel, archive, shutdown. |
| `src/core/routines.ts` | Routine schedules: checking them (`cleanSchedule`) and the next run (`nextRun`). Running them is in `CodeBot`. |
| `src/core/mcp.ts` | MCP servers a project gives its sub-agents: checking them (`cleanMcpServers`), how a command starts (`launchCommand`, `cmd /c` on Windows), whose tools may run without asking (`allowedServers`). |
| `src/shared/command-line.ts` | Splits a typed command line into words and joins them back (the window's MCP server field). |
| `src/core/worktrees.ts` | Creating, removing and restoring sub-agents' git worktrees; copying untracked files into them. |
| `src/core/branches.ts` | Handing over a sub-agent's branch on the user's click: what can be done (`branchFacts`), merging it into the project folder, pushing it and opening a pull request with gh. |
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
| `src/core/boot.ts` | `createCore`: the store, engines, brain and `CodeBot` for a data folder, shared by the desktop app and the headless server; `defaultUserData` (the desktop app's folder). |
| `src/core/operations.ts` | The operation table: a zod schema for every `CodeBotApi` method's arguments, the handlers the core answers itself (`coreHandlers`), which ones are desktop-only, and `callOperation`. Used by `ipc.ts` and the HTTP server. |
| `src/core/instance.ts` | The data folder's lock (`data/instance.json`): one core per data folder, desktop or headless. It also tells terminals the server's port. |
| `src/shared/format.ts` | Words for what code-bot shows (states, schedules, tools, approvals, money), used by the window and the terminal. |
| `src/headless/server.ts` | The HTTP API: `POST /api/<method>`, `GET /api/events` (server-sent events), `/server/status`, `/server/stop`, `/server/launch`; the token and local-caller checks. |
| `src/headless/serve.ts` | `runServer`: takes the lock, makes the token, starts the core and the HTTP server, and stops them cleanly. |
| `src/headless/client.ts` | `Client`: `CodeBotApi` over HTTP, and the event stream with reconnects. `findServer` reads the lock. |
| `src/headless/daemon.ts` | Starts `code-bot serve` in the background when a command needs it (detached, logging to `data/server.log`). |
| `src/headless/chat.ts`, `render.ts` | The terminal conversation (`code-bot chat`): cards for requests and routine proposals, commands, the title and the bell. `render.ts` strips control characters from everything an agent wrote. |
| `src/headless/panes.ts` | `code-bot panes`: a tmux session or a Windows Terminal window with a pane per bot; `/open` in a new tmux window or tab. |
| `src/headless/transfer.ts` | `code-bot export` and `import`: bots, the main bot's settings and routines, with folders mapped. |
| `src/headless/service.ts` | `code-bot service install`: a systemd user unit on Linux, a hidden start at sign-in on Windows. |
| `src/headless/cli.ts`, `bin/code-bot.cjs` | The `code-bot` command and its launcher (checks for Node 24, hides node:sqlite's experimental warning). |
| `src/desktop/main/index.ts` | Electron main process: the data folder's lock, `createCore`, the window, quit handling, single instance. |
| `src/desktop/main/ipc.ts` | The IPC handler: the sender check, the shared operation table, and the desktop-only methods (folder picker, notifications, open link or folder, terminals, updates). |
| `src/desktop/main/badge.ts` | The waiting count on the taskbar or dock icon: an overlay badge drawn pixel by pixel on Windows, the dock badge on macOS, the launcher count on Linux. |
| `src/desktop/main/updates.ts` | `Updater`: asks GitHub for the newest release, downloads and checks the Windows installer and starts it, or replaces a Linux AppImage and restarts. |
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

### One developer per piece of work

A piece of work (a ticket, a bug, a feature) belongs to one developer
sub-agent from investigation to fix: the user's answers and decisions, "now
fix it", and QA or review findings all go to it with `send_to_subagent`, so it
keeps its context and its branch, and no second worktree appears. New
sub-agents are for another role or independent work: QA (`role: "qa"`) and
reviewers (`role: "reviewer"`) name the developer they check
(`for_subagent`, stored as `Task.forTaskId`), and when one of them finishes
the update to the lead says to send findings to that developer and then ask
the checker again. What makes the lead do this:

- The project bot's system prompt (`prompts.projectBotPrompt`) and the tool
  descriptions say so.
- Every message from the user, the main bot or a routine ends with the
  project's recent sub-agents (`prompts.recentSubagents`), so the lead sees
  which one a follow-up is about. `ScriptedBrain` strips the list
  (`prompts.withoutRecent`).
- `start_subagent` with `for_subagent` and the developer role is refused with a
  pointer to `send_to_subagent`.
- An investigation started read-only (`permission_mode: "plan"`) can be let
  loose for the fix with `send_to_subagent { permission_mode }` (never beyond
  the project's mode; `TaskManager.setPermissionMode`, from the next turn). A
  sub-agent's folder and worktree cannot change: Claude Code keeps sessions per
  folder, so the lead is told to start the developer the way the fix needs.
- The main bot is told to pass the user's answers to the same project bot with
  the work and sub-agent ids they are about.

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

### MCP servers for sub-agents

Sub-agents already load the MCP servers of the user's own setup: Claude Code
sub-agents those in the user's Claude Code settings and the project's
`.mcp.json` (`settingSources` is left unset), Codex sub-agents those in
`~/.codex/config.toml` and Codex's plugins. A project bot's settings add more
for that project's sub-agents only (`subagents.mcpServers`, decision 32): a
command started on this computer (stdio) or an HTTP address, each with "Run its
tools without asking".

- They are read from the project bot before every run (`prepareTurn`), like the
  limits, so a change reaches existing sub-agents at their next turn.
- `src/core/mcp.ts` checks them (names of letters, digits, `_` and `-`, unique;
  an `http(s)` address without a sign-in in it) and holds the rules both
  engines share: on Windows, a command that is not an `.exe` or `.com` starts
  through `cmd.exe /d /c` (`npx` is a batch file there), and in plan mode no
  server's tools run without asking.
- Claude Code gets them as the SDK's `mcpServers` option, on top of its own. An
  allowed server adds the rule `mcp__<name>` to `allowedTools`, so `canUseTool`
  is not asked for its tools (the SDK prints a warning saying so).
- Codex gets one dotted config override per server (`mcp_servers.<name>`) on
  `thread/start` and `thread/resume`, which adds to its own servers instead of
  replacing them, with `default_tools_approval_mode` `approve` (allowed) or
  `prompt`.
- No keys or tokens are stored (requirement 8). A command reads what it needs
  from the environment code-bot runs in, which the agents pass on. An HTTP
  server can name the environment variable holding its bearer token
  (`tokenEnvVar`): Claude Code gets the header `Authorization: Bearer ${NAME}`
  and fills in the value from its own environment; Codex gets
  `bearer_token_env_var = NAME`. code-bot never reads the value.
- The project bot's prompt names them, so it can mention them in briefs; it
  does not get them itself.
- Seen with Agent SDK 0.3.325: the account's claude.ai connectors do not load in
  SDK sessions, but did in sessions given a stdio server whose tools are
  allowed (not with an allowed HTTP server). Their tools ask like any other;
  code-bot relies on this neither way.

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

### Handing over a sub-agent's branch

When a sub-agent that worked in its own worktree has stopped, its panel shows
what its branch holds (`getBranchStatus`) and two buttons, each with a confirm
step (`src/core/branches.ts`). Like worktrees, these git commands change the
repository, so code-bot runs them on the user's click, never on a bot's.

- **Merge into <branch>** (`mergeBranch`): `git merge --no-edit <branch>` in the
  project folder, into the branch it is on now, with the user's own git
  settings and identity. It waits for a clean folder (no uncommitted changes to
  tracked files) and a branch to merge into; a conflicting merge is aborted, so
  the folder is left as it was, and the error names the files and suggests the
  sub-agent merges the other way first.
- **Push and open pull request** (`openPullRequest`): `git push --set-upstream`
  to the remote of the branch the worktree came from (else `origin`), then
  `gh pr create` into that branch, titled after the task with its last report
  as the body. It uses the user's own git credentials and gh sign-in, with
  prompts switched off (`GIT_TERMINAL_PROMPT=0`, `GH_PROMPT_DISABLED=1`).
  Without gh the window opens GitHub's page to create the pull request; a remote
  that is not on GitHub is only pushed. A branch that already has a pull
  request gets its address back.

Both are refused while the sub-agent works. What was done is kept on the
task's worktree (`merged`, `pullRequest`), recorded as task events
(`branch.merged`, `branch.pushed`), and shown to the project bot in its list
of recent sub-agents. A merged branch is deleted when the sub-agent is
archived. Tests pass `ghExecutable: null` so the machine's gh is never used.

### Routines

A routine (`routines` table) sends a bot (main or project) a message on a
schedule: daily at a time on chosen weekdays, every N minutes (15 to a week),
or once. Times are the computer's local time. `CodeBot.runDueRoutines` runs
every 30 seconds (`routineTickMs`) and starts each due routine once: a
`routine.run` event in the bot's conversation, then a turn like a typed message
(`Inbound.kind = "routine"`, framed by `prompts.fromRoutine`, replies to the
user). Its next run is then planned: interval routines keep their rhythm from
the planned time, daily ones take the next chosen day, once routines are
switched off. Runs missed while code-bot was closed happen once at start-up.
The window lists the next routines in the sidebar and manages them in the
Routines dialog.

Bots cannot create routines, but they can propose one (decision 34). When the
user asks for something on a schedule, a bot's `propose_routine` checks the
routine (the same rules as the dialog, and that it will run at all) and records
a `routine.proposed` event in its own conversation; the window shows it as a
card with the schedule, the first run and the message. Only the user's Create
(`acceptRoutineProposal`) makes the routine; Dismiss closes the card. Either
records `routine.proposal.closed`. A proposal is found by its id among the
events of the bot's current conversation, so one left in an earlier
conversation can no longer be created. The main bot may propose routines for
itself or a project bot; a project bot only for itself. `list_routines` shows
them their routines and the local time.

### Usage

- **Plan limits.** `Engine.usage()` reads the signed-in plan's windows without
  model usage: Claude Code through the Agent SDK's experimental `/usage`
  control request (a Claude Code process started without a prompt; about 2
  seconds), Codex through `account/rateLimits/read` on `codex app-server`.
  `CodeBot.checkUsage` asks every engine in use (Claude Code for the bots, and
  each project's sub-agent engine), keeps the answer and sends an `app`
  `usage` event: 3 seconds after start, every 10 minutes, and after work ends
  (at most every 2 minutes). Failures become a `note`, never an error.
- **What bots and sub-agents used.** Claude Code reports a cost estimate for
  the whole session with every result, also after a resume (checked
  2026-11-26), so a bot's cost is the latest value per conversation
  (`threads.cost_usd`) summed over its conversations, and a sub-agent's is
  `tasks.cost_usd`. Codex reports tokens, not money: `tasks.tokens`.
  `BotStatus.usage` adds them up.

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
tell the sub-agent who its team lead is and how to report), `maxTurns` /
`maxBudgetUsd` (engines that cannot enforce them ignore them), and
`mcpServers` (the project's MCP servers, added to the agent's own; see "MCP
servers for sub-agents"). A `result` event sets `limit` when a limit stopped
the run.

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

- `bots`: settings of every bot (a project's MCP servers as JSON in `sub_mcp_servers`); archived bots keep their row (`archived_at`).
- `threads`: one row per conversation, with the bot's model session id and its cost so far.
- `tasks`: one row per sub-agent (with its worktree as JSON, limits, role, the developer it checks, tokens, `archived_at`).
- `routines`: scheduled messages to bots, with their next and last run.
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
- The three panes are resizable: drag the handles between them (or focus one
  and use the arrow keys; double-click resets). Widths are kept in the
  window's `localStorage`; the conversation keeps at least 380 px. In a
  narrower window the side panel, then the bot list, give way (down to their
  smallest widths) and get their chosen widths back when it widens again; the
  conversation's buttons wrap below its title instead of hiding it.
- Who is working: a spinning ring and a working badge on bots in the sidebar,
  a strip above the message box (in the main bot's conversation the project
  bots at work, in a project bot's its working sub-agents), a "thinking"
  line while a bot replies, and spinners on running sub-agents. The main bot's
  side panel lists the project bots and what each is doing (`Team.tsx`), not
  their sub-agents.
- Approvals are laid out per tool (`RequestDetails.tsx`): a plan as Markdown,
  a command as code, an edit as a diff, a file to write with its content,
  Codex patches as diffs, anything else as labelled fields. A card shows
  "Sending…" and then what was sent at once, and an answered question keeps its
  answer (`ClosedData.answers`). Coming back to the window re-reads open
  requests, bots and routines in case an event was missed.
- The sidebar shows the plan limits (`Usage.tsx`), the next routines, and an
  "Update to …" button when a newer release is out; Settings has the full
  limits and an Updates section. An installed Windows copy runs the new
  installer; an AppImage downloads the new AppImage next to itself, checks it,
  renames it over the running file (which stays mounted until code-bot quits)
  and restarts into it, or starts it next time (decision 35).
- The taskbar (Windows), dock (macOS) or launcher (Linux) icon shows how many
  questions and approvals wait (`badge.ts`), and the taskbar button flashes
  when one arrives while the window is not focused.

## Headless and the terminal

`code-bot serve` runs the orchestrator without a window: `createCore` as in the
desktop app, plus an HTTP server on 127.0.0.1 (`src/headless`). Everything else
is a client of it:

```
 code-bot chat · code-bot chat web · code-bot panes (tmux / Windows Terminal)
        │ POST /api/<method>            ▲ GET /api/events (server-sent events)
        ▼                               │
 ┌──────────────────────────────────────┴──────┐
 │ code-bot serve: server.ts ─► operations.ts   │
 │   ─► CodeBot (src/core), Store, engines       │
 └──────────────────────────────────────────────┘
```

- **One core per data folder.** The desktop app and `serve` both take
  `data/instance.json` first, and the second one is refused with the name of
  who holds it. The headless default data folder is the desktop app's, so on
  one machine both see the same bots, never at the same time.
- **Started on demand.** A command that needs the core (`code-bot`, `chat`,
  `bots`, `import` …) starts `serve` in the background when none runs, the way
  tmux starts its server, and waits for `/server/status`. Terminals, panes and
  SSH sessions come and go; the server and its sub-agents keep working.
- **The chat** loads the conversation (`getThread`), then follows the stream.
  After a reconnect it reads `getThread(botId, lastSeq)`, like the window.
  Requests and routine proposals are numbered cards, answered with `/allow`,
  `/deny`, `/answer` and `/create`; open ones are shown again when a chat opens.
  The terminal title shows the bot's state (tmux shows it as the pane title),
  and a bell rings for a new request.
- **Panes.** `code-bot panes` opens tmux (or Windows Terminal) with the main bot
  on the left and up to three project bots on the right, and more in further
  windows. Each pane is `code-bot chat <bot>`.
- **Services.** `code-bot service install` keeps `serve` running as the user:
  a systemd user unit on Linux (with `PATH` and `TZ` from the install), or a
  hidden start at sign-in on Windows (decision 37).
- **Moving bots.** `code-bot export` reads the database read-only, so it works
  while code-bot runs. `import` creates the bots and routines through the
  running core, with folders mapped (`--map FROM=TO`).

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
- Updates come only from the GitHub releases of kggayo/code-bot over HTTPS. The
  installer or AppImage is checked against the size and SHA-256 digest GitHub
  lists for the asset before it is used, and only when the user asked for the
  update. `CODE_BOT_UPDATE_FEED` (for update checks) is honoured only for a
  localhost address.
- A sub-agent's branch is merged or pushed only on the user's click in the
  window, never by a bot, with the user's own git credentials and gh sign-in;
  a merge never starts with uncommitted changes in the project folder and is
  undone on a conflict.
- Bots can only propose routines; a routine exists once the user creates it
  from the card.
- Bots cannot change files or run commands; project bots read only their own
  folders, and git is limited to read-only subcommands with arguments that write
  or run programs refused (`src/core/git.ts`).
- A project bot can only see and control its own sub-agents, can only answer
  questions (never approve actions), and can only start sub-agents with the
  project's permission mode or a stricter one.
- What a sub-agent may do without asking is set by the project's permission
  mode and the project's own Claude Code permission rules. It runs as the
  user, with the user's access to everything on the machine.
- MCP servers in a project's settings run as the user too. Their tools ask for
  approval unless the user ticked "Run its tools without asking" for that
  server, and always in plan mode. code-bot stores no keys or tokens for them.
- The headless server listens on 127.0.0.1 only. Every request needs the token
  in `data/api-token` (made at first start, readable only by the user), and the
  comparison takes the same time whatever the token. Refused: a request with an
  `Origin` header (any web page), and a `Host` other than 127.0.0.1 or localhost
  with the server's port (DNS rebinding). Bodies are JSON, at most 1 MB, and
  there are no CORS headers. The same operation table checks the arguments as
  for the window, and desktop-only operations are refused.
- In a terminal, every string from a bot, a sub-agent, a tool or a file has its
  control characters and escape sequences removed before it is printed
  (`clean` in `src/headless/render.ts`), so agent output cannot move the
  cursor, retitle the terminal, write the clipboard or hide a link
  (decision 38).
