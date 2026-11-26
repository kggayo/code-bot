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
    "maxBudgetUsd": 5,             // per sub-agent, the engine's estimate; null = no limit
    "mcpServers": [                // McpServer[]: added to the agents' own MCP servers, read at every turn (max 20)
      { "type": "stdio", "name": "playwright", "command": "npx", "args": ["@playwright/mcp@latest"], "allowTools": true },
      { "type": "http", "name": "docs", "url": "https://docs.example.com/mcp", "tokenEnvVar": "DOCS_MCP_TOKEN", "allowTools": false }
    ]                              // name: letters, digits, "_", "-" (tools are mcp__<name>__<tool>); allowTools: run its
                                   // tools without asking (never in plan mode); tokenEnvVar: the NAME of the environment
                                   // variable holding an HTTP server's bearer token (the agent reads it); no tokens are stored
  },
  "threadId": "c_9f…",             // current conversation
  "createdAt": "…", "updatedAt": "…",
  "status": {
    "busy": false, "activeSubagents": 2, "needsYou": 1,
    "usage": {                     // BotUsage: the engines' own estimates so far (US dollars at API prices)
      "botUsd": 0.42,              // the bot's own conversations
      "projectBotsUsd": 0,         // main bot only: every project bot's own conversations
      "subagentsUsd": 3.1,         // its sub-agents (main bot: all), archived ones included
      "subagentTokens": 182000     // sub-agents whose engine reports tokens, not money (Codex)
    }
  }
}

// Task: one sub-agent's work
{
  "id": "t_921b524ccc",
  "botId": "b_12a27fb811",         // the project bot that owns it
  "title": "Fix null check in OrderService",
  "state": "running",              // running | waiting | done | failed | cancelled | interrupted
  "requestedBy": "main",           // "user" or "main": who hears about it
  "role": "developer",             // developer | qa | reviewer | other (older sub-agents: developer)
  "forTaskId": null,               // qa and reviewer: the developer sub-agent whose work it checks
  "engine": "claude", "model": "sonnet", "effort": "medium", "permissionMode": "acceptEdits",
  "cwd": "C:\\Users\\me\\AppData\\Roaming\\code-bot\\worktrees\\t_921b524ccc",
  "additionalDirectories": ["C:\\src\\webshop-web"],
  "instructions": "You are a sub-agent in code-bot …",
  "engineSessionId": "f36be433-…", // null until it starts
  "lastResult": "Changed OrderService.cs …",  // its last report
  "error": null,
  "costUsd": 0.0087,               // the engine's estimate for the session, not a bill
  "tokens": 0,                     // the session's tokens, for engines that report tokens instead (Codex)
  "maxTurns": 50, "maxBudgetUsd": 5,   // the limits that applied to its last run
  "worktree": {                    // null when it works in the shared folder
    "path": "C:\\Users\\me\\AppData\\Roaming\\code-bot\\worktrees\\t_921b524ccc",
    "branch": "code-bot/t_921b524ccc-fix-null-check-in-orderservice",
    "base": "main", "baseCommit": "4be1…", "folder": "C:\\src\\webshop",
    "removed": false,              // true once archived (the branch may remain)
    "merged": { "into": "main", "commit": "b85395b…", "at": "…" },        // set by mergeBranch
    "pullRequest": { "remote": "origin", "url": "https://github.com/…/pull/12", "created": true, "at": "…" }  // set by openPullRequest
  },
  "archivedAt": null,
  "createdAt": "…", "updatedAt": "…"
}

// PendingRequest: a sub-agent waiting for an answer
{
  "id": "r_1f0c2ab9d3", "taskId": "t_921b524ccc", "botId": "b_12a27fb811",
  "kind": "permission",            // or "question"
  "tool": "Bash",                  // "AskUserQuestion" for questions
  "input": { "command": "npm test" }, // strings kept up to 30000 characters (a plan, a file to write); other events cut at 2000
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

// EngineUsage (getUsage, checkUsage): a coding agent's plan limits
{ "engineId": "claude", "label": "Claude Code", "plan": "max",
  "windows": [                     // UsageWindow
    { "id": "session", "label": "5-hour session", "usedPercent": 6, "resetsAt": "…", "severity": "normal" },
    { "id": "weekly_all", "label": "Week · all models", "usedPercent": 1, "resetsAt": "…", "severity": "normal" },
    { "id": "weekly_scoped:opus", "label": "Week · Opus", "usedPercent": 0, "resetsAt": "…", "severity": null }
  ],
  "note": null,                    // why there are no windows (API key: no plan limits), or what went wrong
  "checkedAt": "…" }

// Routine: a message sent to a bot on a schedule, as if the user typed it
{ "id": "rt_…", "botId": "b_…",    // or "main"
  "title": "Morning tickets", "prompt": "Check ClickUp for new bugs and summarise them.",
  "schedule": { "kind": "daily", "time": "09:00", "days": [1, 2, 3, 4, 5] },
  // or { "kind": "interval", "minutes": 120 } (15 to 10080), or { "kind": "once", "at": "<ISO time>" }
  "enabled": true,
  "nextRunAt": "…",                // null: will not run again (a "once" that ran) or paused
  "lastRunAt": "…", "lastError": null,
  "createdAt": "…", "updatedAt": "…" }

// BranchStatus (getBranchStatus, mergeBranch, openPullRequest)
{ "taskId": "t_921b524ccc", "branch": "code-bot/t_921b524ccc-fix-null-check-in-orderservice",
  "folder": "C:\src\webshop", "folderBranch": "main",
  "ahead": 2,                      // commits on the branch that the folder's branch lacks
  "folderDirty": false, "worktreeDirty": false,
  "remote": "origin", "githubRepo": "acme/webshop", "gh": true,
  "mergeBlocked": null,            // or why not: "The project folder has uncommitted changes on main; …"
  "pushBlocked": null,
  "merged": null, "pullRequest": null }

// RoutineProposal (thread event routine.proposed)
{ "id": "rp_…", "botId": "b_…", "botName": "webshop", "title": "Weekday stand-up notes",
  "prompt": "Summarise what your sub-agents did yesterday.",
  "schedule": { "kind": "daily", "time": "09:00", "days": [1, 2, 3, 4, 5] }, "nextRunAt": "…" }

// UpdateInfo (getUpdate, checkForUpdate; desktop only)
{ "current": "0.3.1", "latest": "0.4.0", "available": true,
  "method": "installer",           // installer: the Windows installer; appimage: replaces the running AppImage; manual: opens the release page
  "methodNote": null,              // why it is manual here (portable zip, .deb, running from source)
  "installed": null,               // appimage: the version already put in place, starting at the next restart
  "url": "https://github.com/kggayo/code-bot/releases/tag/v0.4.0", "notes": "…",
  "checkedAt": "…", "downloadPercent": null, "error": null }

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
| `getBranchStatus(taskId)` | `BranchStatus` of a sub-agent that worked on its own worktree branch: the project folder's current branch, commits on the sub-agent's branch it lacks (`ahead`), uncommitted changes in the folder or the worktree, the remote and whether it is GitHub, whether `gh` is installed, why merging or pushing is not possible now (`mergeBlocked`, `pushBlocked`), and what was done already (`merged`, `pullRequest`). `invalid` for a sub-agent without a branch. |
| `mergeBranch(taskId)` | The user's "Merge into <branch>": runs `git merge` of the sub-agent's branch into the branch the project folder is on, with the user's git settings and identity. Refused (`conflict`) while the sub-agent works, when the folder has uncommitted changes to tracked files, is detached, or already has every commit. A conflicting merge is aborted (the folder is left as it was) and the error names the files. Records `worktree.merged` and a `branch.merged` task event; returns the new `BranchStatus`. |
| `openPullRequest(taskId)` | The user's "Push and open pull request": `git push --set-upstream <remote> <branch>` (the remote of the branch the worktree came from, else `origin`), then on GitHub `gh pr create --repo <owner/repo> --head <branch> --base <base>` with the task's title and last report. Uses the user's own git credentials and gh sign-in; no prompts. Without gh, `pullRequest.url` is GitHub's page to create the pull request (the window opens it); a remote that is not GitHub is only pushed. An existing pull request for the branch is returned instead of failing. Records `worktree.pullRequest` and a `branch.pushed` task event. |
| `listRequests()` | Every open question and approval, including held ones from before a restart. |
| `respond(taskId, requestId, response)` | Answers a request. `response` is `{ "decision": "allow", "answers"?: { "<question text>": "<answer>" } }` or `{ "decision": "deny", "message"?: "…" }`. Answering the last held request of a sub-agent resumes it. |
| `getUsage()` | `EngineUsage[]`: the plan limits as last read (reads them the first time). |
| `checkUsage()` | Reads the plan limits now, for Claude Code (the bots) and every engine a project uses. No model usage: Claude Code's `/usage` data and Codex's `account/rateLimits/read`. The core also reads them 3 seconds after start, every 10 minutes, and (at most every 2 minutes) after a sub-agent run or bot turn ends. |
| `listRoutines()` | `Routine[]` of bots that still exist, the next to run first, then the ones that will not run again. |
| `createRoutine(input)` | `{ botId, title, prompt, schedule, enabled }`. Title 1-80 characters, prompt up to 20000; daily needs `HH:MM` and at least one weekday; interval 15 to 10080 minutes; a "once" time must be in the future. |
| `updateRoutine(routineId, patch)` | Changes it; a new schedule or `enabled` plans the next run again from now. |
| `deleteRoutine(routineId)` | Removes it. |
| `runRoutine(routineId)` | Sends its message now ("Run now"); the schedule stays. |
| `acceptRoutineProposal(botId, proposalId)` | The card's Create: creates the routine a bot proposed (`routine.proposed`) in its current conversation, enabled, and records `routine.proposal.closed` (`outcome: "created"`). `not_found` for a proposal in an earlier conversation; `conflict` when it was already created or dismissed. Returns the `Routine`. |
| `dismissRoutineProposal(botId, proposalId)` | The card's Dismiss: records `routine.proposal.closed` (`outcome: "dismissed"`); nothing is created. |
| `checkFolders(paths)` | `[{ path, exists }]` for absolute paths of existing folders. |
| `pickFolders()` | Desktop only: the native folder picker; `[]` if cancelled. |
| `openExternal(url)` | Desktop only: opens an http(s) link in the default browser. |
| `openPath(path)` | Desktop only: shows a bot's folder or a sub-agent's worktree in the file manager. |
| `notify({ title, body, botId? })` | Desktop only: a system notification; clicking it opens the bot. |
| `signIn(engineId)` | Desktop only: opens a terminal running the agent's sign-in (`claude auth login`, `codex login`). |
| `openInTerminal(taskId)` | Desktop only: opens a terminal in the sub-agent's folder that continues its session interactively (`claude --resume <id>`, `codex resume <id>`). Refused while it is working. |
| `getUpdate()` | Desktop only: `UpdateInfo` as last checked. |
| `checkForUpdate()` | Desktop only: asks GitHub for the newest release of kggayo/code-bot. Never fails; a problem is in `error`. The app also checks 15 seconds after start and every 6 hours (not in demo mode, nor with `CODE_BOT_NO_UPDATE_CHECK=1`). |
| `installUpdate()` | Desktop only: `method: "installer"` downloads `code-bot-Setup-<version>.exe`, checks its size and the SHA-256 GitHub lists, asks to quit if sub-agents work, starts the installer and quits. `appimage` downloads `code-bot-<version>.AppImage` next to the running one (`$APPIMAGE`), checks it the same way, renames it over the running file and restarts into it after asking; declined, `installed` says the new version starts next time, and calling it again restarts. `manual` opens the release page. |

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
| `request.closed` | `ClosedData`: `{ requestId, decision, by, answers?, message? }` | It was answered. `decision`: `allow`, `deny` or `withdrawn`; `by`: `user`, `bot` (the project bot answered) or `system` (the sub-agent stopped). `answers`: what was answered (questions); `message`: the note with a decline. |
| `routine.run` | `RoutineRunData`: `{ routineId, title, text, manual }` | A routine sent its message to this bot; a turn follows. `manual` when it was "Run now". |
| `routine.proposed` | `RoutineProposal` | The bot proposed a routine (`propose_routine`); the window shows a card with Create and Dismiss. Nothing exists yet. |
| `routine.proposal.closed` | `RoutineProposalClosed`: `{ id, outcome, routineId }` | The user created it (`outcome: "created"`, with the routine's id) or dismissed it. |
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
| `result` | `{ ok, text, error?, limit?, costUsd?, tokens?, durationMs?, numTurns? }` | A turn ended; `limit` is `turns` or `budget` when a limit stopped it. `tokens`: the session's total, for engines that report tokens (Codex). |
| `state` | `{ state, error? }` | The task changed state. |
| `settings` | `{ permissionMode }` | Its project bot changed its permission mode; it applies from its next turn. |
| `archived` / `unarchived` | `{ archivedAt }` | It was archived, or shown again. |
| `worktree` | `{ worktree }` | Its worktree was removed or brought back, or its branch was merged or pushed. |
| `branch.merged` | `{ into, commit, fastForward }` | The user merged its branch into the project folder's branch. |
| `branch.pushed` | `{ branch, remote, url, created }` | The user pushed its branch; `url` is the pull request (`created: true`) or GitHub's page to create one, null for other remotes. |
| `deleted` | `{}` | Live only (`seq: 0`): retention deleted it and its history. |

## Bot events (`scope: "bot"`, never stored)

| Type | `data` | Notes |
|---|---|---|
| `status` | `BotStatus`: `{ busy, activeSubagents, needsYou, usage }` | Sent whenever any of them may have changed (also when a bot turn or sub-agent run reports its cost). |
| `changed` | `{}` | The bot was created or its settings changed; fetch `listBots()`. |
| `archived` | `{}` | The bot was removed. |
| `conversations` | `{ threadId? }` | Its conversations changed (archived, deleted, a new current one). With `threadId`: that is now the current conversation. |

## App events (`scope: "app"`, `id: "app"`, never stored)

| Type | `data` | Notes |
|---|---|---|
| `settings` | `AppSettings` | The settings changed. |
| `engines` | `EngineInfo[]` | The coding agents were checked. |
| `usage` | `EngineUsage[]` | The plan limits were read. |
| `routines` | `Routine[]` | A routine was added, changed, removed or ran. |
| `update` | `UpdateInfo` | Desktop only, sent by the main process: an update check finished, or the installer download moved on. |

## Tools the bots have

Defined in `src/core/tools.ts`.

Main bot: `list_project_bots`, `send_to_project_bot { bot, message }`,
`project_bot_status { bot }`, and the routine tools below (its routines may
message itself or a project bot: `propose_routine`'s `bot`).

Project bot: `list_subagents { active_only? }`,
`start_subagent { title, brief, role?, for_subagent?, folder?, model?, effort?, permission_mode?, worktree? }`
(`role`: `developer` by default, `qa`, `reviewer` or `other`; `for_subagent`:
for QA and reviewers, the developer whose work they check, refused for a
developer with a pointer to `send_to_subagent`; `worktree: true` gives it its
own worktree and branch, `false` the shared folder; default: the project's
setting), `get_subagent { id }` (includes its `worktree`),
`send_to_subagent { id, text, permission_mode? }` (`permission_mode` changes
its permissions from its next turn, up to the project's setting),
`answer_subagent { id, request_id, answers? | decline? }`,
`cancel_subagent { id }`, `git { args, folder? }` (read-only: status, diff,
log, show, branch, ls-files; `folder` may also be one of its sub-agents'
worktrees). Sub-agent summaries include their `branch`, `role`,
`for_subagent` and `permission_mode`.

Both kinds of bot: `list_routines` (read-only: their routines, all of them for
the main bot, with the computer's local time now) and
`propose_routine { bot?, title, message, kind, time?, days?, minutes?, at? }`
(`kind`: `daily` with `time` HH:MM and `days` like `["mon","fri"]`, `interval`
with `minutes` 15-10080, `once` with a local `at` like `2026-11-27T15:00`). It
creates nothing: it checks the routine and shows it as a card
(`routine.proposed`) that the user creates or dismisses.

Messages to a project bot from the user, the main bot or a routine end with a
list of its recent sub-agents (`prompts.recentSubagents`: up to 8 unarchived
ones active in the last 14 days, with role, state and branch, and whether the
user merged or pushed that branch), so a follow-up
goes to the sub-agent that has the work.
