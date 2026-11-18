# Operations and events

The window and the orchestrator talk through one interface, `CodeBotApi` in
`src/shared/types.ts`, and one event stream of `CoreEvent`s. In the desktop app
the window calls the operations over IPC (`window.codeBot.call(method, args)`,
validated in `src/desktop/main/ipc.ts`) and receives every event on the
`code-bot:event` channel. A future remote client (HTTP or MCP, see
`docs/roadmap.md`) should expose the same operations and events.

Errors are thrown as `Error` with a message meant for the user. In the core they
are `CodeBotError` with a `code`: `invalid`, `not_found`, `conflict` or `busy`.

## Objects

```jsonc
// Bot (BotView adds `status`)
{
  "id": "b_12a27fb811",            // "main" for the main bot
  "kind": "project",               // or "main"
  "name": "webshop",              // unique, case-insensitive; the main bot routes by it
  "description": "Online shop: REST API and web front end …",
  "folders": ["C:\\src\\webshop", "C:\\src\\webshop-web"],  // first = primary; [] for the main bot
  "instructions": "",              // standing instructions from the user
  "model": "opus",                 // the bot's own model; null = engine default
  "effort": "high",                // low | medium | high | xhigh | max | null
  "subagents": {
    "engine": "claude",            // "claude" or "codex" (or "mock" in demo mode)
    "model": "sonnet", "effort": "medium",
    "permissionMode": "acceptEdits", // plan | default | acceptEdits | auto | bypassPermissions
    "isolation": "worktree",       // "shared" (the project folders) or "worktree" (own git worktree and branch)
    "worktreeFiles": [".env", ".env.*"], // untracked files copied into each new worktree
    "maxTurns": 50,                // per run; null = no limit
    "maxBudgetUsd": 5              // per sub-agent, the engine's estimate; null = no limit
  },
  "threadId": "c_9f…",             // current conversation
  "createdAt": "…", "updatedAt": "…",
  "status": { "busy": false, "activeSubagents": 2, "needsYou": 1 }
}

// Task: one sub-agent's work
{
  "id": "t_921b524ccc",
  "botId": "b_12a27fb811",         // the project bot that owns it
  "title": "Fix null check in OrderService",
  "state": "running",              // running | waiting | done | failed | cancelled | interrupted
  "requestedBy": "main",           // "user" or "main": who hears about it
  "engine": "claude", "model": "sonnet", "effort": "medium", "permissionMode": "acceptEdits",
  "cwd": "C:\\Users\\me\\AppData\\Roaming\\code-bot\\worktrees\\t_921b524ccc",
  "additionalDirectories": ["C:\\src\\webshop-web"],
  "instructions": "You are a sub-agent in code-bot …",
  "engineSessionId": "f36be433-…", // null until it starts
  "lastResult": "Changed OrderService.cs …",  // its last report
  "error": null,
  "costUsd": 0.0087,               // the engine's estimate for the session, not a bill
  "maxTurns": 50, "maxBudgetUsd": 5,   // the limits that applied to its last run
  "worktree": {                    // null when it works in the shared folder
    "path": "C:\\Users\\me\\AppData\\Roaming\\code-bot\\worktrees\\t_921b524ccc",
    "branch": "code-bot/t_921b524ccc-fix-null-check-in-orderservice",
    "base": "main", "baseCommit": "4be1…", "folder": "C:\\src\\webshop",
    "removed": false               // true once archived (the branch may remain)
  },
  "archivedAt": null,
  "createdAt": "…", "updatedAt": "…"
}

// PendingRequest: a sub-agent waiting for an answer
{
  "id": "r_1f0c2ab9d3", "taskId": "t_921b524ccc", "botId": "b_12a27fb811",
  "kind": "permission",            // or "question"
  "tool": "Bash",                  // "AskUserQuestion" for questions
  "input": { "command": "npm test" },
  "summary": "Run npm test",
  "createdAt": "…",
  "surfacedIn": "c_9f…",           // the conversation it was put to the user in; null until then
  "held": true                     // code-bot closed while it waited; answering resumes the sub-agent
}

// ConversationSummary (listConversations)
{ "threadId": "c_9f…", "botId": "b_…", "title": "fix the login bug", "createdAt": "…",
  "lastActivity": "…", "messages": 12, "current": false, "archivedAt": null }

// AppSettings
{ "maxActiveSubagents": 12, "archiveAfterDays": 30, "deleteArchivedAfterDays": 0 }

// EngineInfo (checkEngines)
{ "id": "claude", "label": "Claude Code", "ready": true,
  "detail": "Claude Code is signed in (claude.ai).", "canSignIn": false, "canResume": true }

// CoreEvent
{ "scope": "thread", "id": "c_9f…", "botId": "main", "seq": 4, "ts": "…", "type": "bot.text", "data": { "text": "…" } }
```

`seq` starts at 1 per thread or task and only grows. Live-only events have
`seq: 0`. `id` is the thread id (`scope: thread`), task id (`scope: task`), bot
id (`scope: bot`) or `"app"` (`scope: app`).

## Operations

| Operation | Does |
|---|---|
| `appInfo()` | `{ version, dataDir, platform, fakeModels, engines }`. |
| `getSettings()` | The app settings (`AppSettings`). |
| `updateSettings(patch)` | Changes them: `maxActiveSubagents` 1-50, `archiveAfterDays` and `deleteArchivedAfterDays` 0-3650 (0: never). |
| `checkEngines()` | `EngineInfo[]`: whether each coding agent is installed and signed in. Runs `claude auth status` and `codex login status`; no model usage. |
| `listBots()` | Every bot with its status: the main bot first, then project bots by name. |
| `createBot(input)` | Creates a project bot. Validates name, folders (absolute, existing, at most 10), engine, effort, permission mode, isolation, files to copy (relative, inside the folder, at most 30), turn limit (1-10000) and budget (> 0). Folders are stored as canonical paths (`realpath`), so Windows short names (`C:\Users\ABCDEF~1\…`) and symlinks become the real path. |
| `updateBot(botId, patch)` | Changes a bot. For the main bot only `model`, `effort` and `instructions` apply. |
| `archiveBot(botId)` | Removes a project bot from the app (history stays). Refused while it has working sub-agents. |
| `getThread(botId, after?)` | The bot's current conversation: `{ botId, threadId, current: true, busy, events }`. |
| `sendToBot(botId, text)` | A message from the user. The reply arrives as thread events. |
| `newConversation(botId)` | Starts a new thread for the bot; its sub-agents keep working and open requests move to the new thread. |
| `listConversations(botId, { archived? })` | The bot's conversations, most recently active first; archived ones only with `archived: true`. |
| `getConversation(botId, threadId, after?)` | One conversation, current or earlier (`current` says which). |
| `reopenConversation(botId, threadId)` | Makes an earlier conversation the current one again; the bot resumes its own session for it, and open requests move into it. |
| `setConversationArchived(botId, threadId, archived)` | Hides an earlier conversation from the list, or shows it again. The current one cannot be archived. |
| `stopBot(botId)` | Stops the bot's current turn and drops messages it has not started on. |
| `listTasks({ botId?, limit?, archived? })` | Sub-agents, newest first (default 100, at most 500); archived ones only with `archived: true`. |
| `getTask(taskId, after?)` | `{ task, pendingRequests, events }`. |
| `sendToTask(taskId, text)` | The user writes to a sub-agent directly: steers it, or continues its session. Unarchives it. Answers its held requests' place: they are withdrawn and it resumes with the message. |
| `cancelTask(taskId)` | Stops a sub-agent (also one with held requests). |
| `setTaskArchived(taskId, archived, { discardChanges? })` | Hides a stopped sub-agent (or shows it again). Archiving removes its worktree folder; the branch is deleted only if it is merged. Refused (`conflict`) while it works, or when its worktree has uncommitted changes unless `discardChanges`. |
| `listRequests()` | Every open question and approval, including held ones from before a restart. |
| `respond(taskId, requestId, response)` | Answers a request. `response` is `{ "decision": "allow", "answers"?: { "<question text>": "<answer>" } }` or `{ "decision": "deny", "message"?: "…" }`. Answering the last held request of a sub-agent resumes it. |
| `checkFolders(paths)` | `[{ path, exists }]` for absolute paths of existing folders. |
| `pickFolders()` | Desktop only: the native folder picker; `[]` if cancelled. |
| `openExternal(url)` | Desktop only: opens an http(s) link in the default browser. |
| `openPath(path)` | Desktop only: shows a bot's folder or a sub-agent's worktree in the file manager. |
| `notify({ title, body, botId? })` | Desktop only: a system notification; clicking it opens the bot. |
| `signIn(engineId)` | Desktop only: opens a terminal running the agent's sign-in (`claude auth login`, `codex login`). |
| `openInTerminal(taskId)` | Desktop only: opens a terminal in the sub-agent's folder that continues its session interactively (`claude --resume <id>`, `codex resume <id>`). Refused while it is working. |

For questions, `answers` maps each question's exact text to the chosen option
label or free text; several labels for a multi-select question are joined with
`, `.

## Thread events (`scope: "thread"`)

| Type | `data` | Notes |
|---|---|---|
| `user.message` | `{ text }` | Typed by the user in this conversation. |
| `inbound` | `InboundData`: `{ from, text, botId?, name?, taskId? }` | Something another party delivered: `from: "main"` (a project bot's conversation; the main bot's message), `from: "project"` (the main bot's conversation; a project bot's report, with its `botId` and `name`), `from: "subagent"` (a project bot's conversation; a sub-agent finished, failed or asks, with `taskId`). |
| `turn.start` | `{ replyTo }` | The bot started a turn; `replyTo` is `user` or `main`. |
| `bot.delta` | `{ text }` | Live fragment of the bot's message. `seq: 0`, never stored. |
| `bot.text` | `{ text }` | A complete message from the bot (Markdown). |
| `bot.tool` | `{ name, input }` | The bot used a tool (see the tools in `src/core/tools.ts`). |
| `subagent.started` | `{ taskId, title, branch? }` | The project bot started a sub-agent; `branch` when it has its own worktree. |
| `request.surfaced` | `SurfacedData`: `{ request, taskTitle, botName }` | A question or approval put to the user here. |
| `request.closed` | `ClosedData`: `{ requestId, decision, by }` | It was answered. `decision`: `allow`, `deny` or `withdrawn`; `by`: `user`, `bot` (the project bot answered) or `system` (the sub-agent stopped). |
| `turn.end` | `TurnEndData`: `{ ok, error?, forwardedTo? }` | The turn ended. `forwardedTo: "main"` when the reply was passed on to the main bot. |
| `thread.reset` | `{}` | First event of a new conversation (the event's `id` is the new thread). |

## Task events (`scope: "task"`)

| Type | `data` | Notes |
|---|---|---|
| `task.created` | `{ task }` | First event of every sub-agent. |
| `user.message` | `{ text, from }` | The brief and every later message; `from` is `lead` (the project bot) or `user`. |
| `session` | `{ sessionId, model }` | The agent process started; `model` is what actually runs. |
| `text.delta` | `{ text }` | Live fragment. `seq: 0`, never stored. |
| `text` | `{ text }` | A complete message from the sub-agent. |
| `tool.use` | `{ id, name, input }` | A tool call; long strings in `input` are cut. |
| `tool.result` | `{ id, isError, preview }` | Its outcome, cut. |
| `request` | `PendingRequest` | The sub-agent is waiting for an answer. |
| `request.resolved` | `{ id, decision, by, surfacedIn, … }` | `by`: `user`, `bot` or `system`; `decision`: `allow`, `deny` or `withdrawn`. |
| `result` | `{ ok, text, error?, limit?, costUsd?, durationMs?, numTurns? }` | A turn ended; `limit` is `turns` or `budget` when a limit stopped it. |
| `state` | `{ state, error? }` | The task changed state. |
| `archived` / `unarchived` | `{ archivedAt }` | It was archived, or shown again. |
| `worktree` | `{ worktree }` | Its worktree was removed or brought back. |
| `deleted` | `{}` | Live only (`seq: 0`): retention deleted it and its history. |

## Bot events (`scope: "bot"`, never stored)

| Type | `data` | Notes |
|---|---|---|
| `status` | `BotStatus`: `{ busy, activeSubagents, needsYou }` | Sent whenever any of the three may have changed. |
| `changed` | `{}` | The bot was created or its settings changed; fetch `listBots()`. |
| `archived` | `{}` | The bot was removed. |
| `conversations` | `{ threadId? }` | Its conversations changed (archived, deleted, a new current one). With `threadId`: that is now the current conversation. |

## App events (`scope: "app"`, `id: "app"`, never stored)

| Type | `data` | Notes |
|---|---|---|
| `settings` | `AppSettings` | The settings changed. |
| `engines` | `EngineInfo[]` | The coding agents were checked. |

## Tools the bots have

Defined in `src/core/tools.ts`.

Main bot: `list_project_bots`, `send_to_project_bot { bot, message }`,
`project_bot_status { bot }`.

Project bot: `list_subagents { active_only? }`,
`start_subagent { title, brief, folder?, model?, effort?, permission_mode?, worktree? }`
(`worktree: true` gives it its own worktree and branch, `false` the shared
folder; default: the project's setting), `get_subagent { id }` (includes its
`worktree`), `send_to_subagent { id, text }`,
`answer_subagent { id, request_id, answers? | decline? }`,
`cancel_subagent { id }`, `git { args, folder? }` (read-only: status, diff,
log, show, branch, ls-files; `folder` may also be one of its sub-agents'
worktrees). Sub-agent summaries include their `branch`.
