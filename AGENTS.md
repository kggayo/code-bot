# code-bot: guide for coding agents

Read this file first. It is the handoff document for any coding agent (Claude
Code, Codex, OpenCode, or a person) picking up this project. `CLAUDE.md`
imports it, so there is one source of truth.

## What this is

code-bot is a desktop app (Electron; Windows, macOS, Linux) that orchestrates
coding agents on the owner's own machine, in three levels:

- **Main bot**: the software manager. The owner tells it what they need; it
  routes the work to the right project bot and reports back.
- **Project bot**: one per project, connected to that project's folder(s), with
  its own models, permissions and instructions. The team lead / architect: it
  reads the code, starts sub-agents, answers their questions when it can,
  reviews their work and reports to whoever asked.
- **Sub-agent**: a coding agent (Claude Code, Codex or OpenCode) doing one task in the
  project's folders (or its own git worktree), reporting to its project bot.

The owner talks only to the main bot or a project bot.

The name is **code-bot**. Use `code-bot` in file names and prose and `CODE_BOT_`
for environment variables. Do not write `codebot`.

The source is public and MIT-licensed: https://github.com/kggayo/code-bot
(default branch `main`). It belongs to the owner's personal GitHub account
`kggayo`, not their company account. This checkout has its own git identity and
a credential helper in `.git/config` that pushes as `kggayo`; keep them. The
`gh` CLI on this PC has both accounts signed in with the company one active, so
run `gh` for this repository as `kggayo` without switching accounts:
`GH_TOKEN="$(gh auth token --user kggayo)" gh <command>`.

## Requirements that must keep holding

These come from the owner and are the reason the project exists. Do not trade
them away for convenience.

1. Agents run on the owner's own machine, not a vendor sandbox, so they use that
   machine's checkouts, `.env` files, database access and tooling.
2. Three levels as above. The main bot routes and never codes; project bots
   lead and delegate; sub-agents do the work. A sub-agent reports to its project
   bot; the project bot reports to the main bot if the main bot asked,
   otherwise in its own conversation.
3. The owner never has to talk to a sub-agent. Their questions and approval
   requests reach the owner in the main bot's or project bot's conversation.
4. Model and effort are configurable for the main bot, each project bot, and
   each project's sub-agents (and per sub-agent by the project bot).
5. A project bot can run several sub-agents at once. New work never waits for
   other work to finish.
6. Desktop first: an Electron app for Windows, macOS and Linux. Mobile is
   dropped for now. Milestone 1 (the desktop app) is done; the next milestone
   exposes the main bot over an API or MCP so it can run on the owner's Azure VM
   (`docs/roadmap.md`). The owner has no Mac: macOS stays unverified.
7. Coding agents are pluggable. Claude Code is the first engine; others must be
   addable without touching the orchestrator core.
8. Model usage is paid through the owner's Claude subscription login on the
   machine. code-bot never handles credentials.

## Status (as of 2026-11-17)

Milestone 1 is complete on Windows 11 and Linux (Ubuntu 24.04 in WSL2). Built
and verified:

| Piece | How it was verified |
|---|---|
| Core: bot hierarchy and routing, report-back to whoever asked, question relay through the project bot, approvals to the user, sub-agent lifecycle, restart recovery, requests held across a restart, limits, settings, worktrees, archive and retention, earlier conversations, engine checks, validation, canonical folders, read-only git; the Codex and OpenCode engines against fakes | `npm test`: 63 tests with scripted bots, mock sub-agents and fake Codex and OpenCode servers, no model usage. Windows: 63 pass. Linux: 61 pass, 2 Windows-only tests skipped |
| Desktop app with scripted models | `npm run e2e`: 14 checks on Windows and on Linux (WSLg): bots, routing, approvals and questions in the right conversation, sub-agent panel, settings, worktree sub-agent with limits and archiving, reading and continuing an earlier conversation, app settings and engine check, no page errors |
| Desktop app with real models (Claude haiku and a cheap Codex model, low effort) | `npm run live` on Windows, with `CODE_BOT_LIVE_CODEX=1`, 10 steps: sign-in check; main bot → project bot → report (answer from the project's `CLAUDE.md`); a sub-agent writes a file after an approval; a sub-agent in its own worktree commits on its branch while the project folder stays untouched, and the project bot names the branch; the sub-agent ran on the configured model; a project bot with Codex sub-agents: a Codex sub-agent creates a file after an approval, and a follow-up from the project bot continues the same Codex session |
| `auto` permission mode | `scripts/auto-mode-check.ts` (haiku, on the owner's Claude subscription): a file write and two commands ran without approval requests (decision 25) |
| OpenCode engine | `scripts/opencode-check.ts` against the real OpenCode 1.1.33 server with a scripted local model (the free models had reached their daily limit): a file created after an approval, the session resumed, an interrupt ending the run in under a second, the user's config untouched; `test/opencode.test.ts` (15 tests) against a fake server. Wired into the app; no real model turn yet (decision 27) |
| Codex engine | Through the app (above), and `scripts/codex-check.ts` against real Codex 0.160.1 (ChatGPT login, cheap model): a file created after an approval, a resumed thread that remembers it, a question relayed through `askUser` and answered; `test/codex.test.ts` (12 tests) against a fake app-server |
| Open in terminal | The launcher (`src/desktop/main/terminal.ts`) starts a detached program in the given folder on Windows; the interactive Claude/Codex session it opens was not driven by a test |
| Packaged Windows app | `electron-builder --win` + `scripts/packaged-check.ts`: starts, the sign-in check runs its unpacked Claude Code, a real main-bot turn runs. App icon. Unsigned. |
| Linux AppImage and deb | Built in WSL with `npm run package:linux`; `scripts/packaged-check.ts` against `release/linux-unpacked`: starts and its sign-in check runs the unpacked Claude Code. The model turn was skipped: Claude Code in WSL was not signed in (its April login had expired) |

Not verified: macOS (no Mac), `npm run live` on Linux (needs `claude auth login`
in WSL), installing the NSIS installer, the CI workflow (nothing pushed yet), code
signing, the quit prompt and system notifications (native dialogs). Next: see
`docs/roadmap.md`.

## Run, test, check

Requires **Node 24 or newer** for development (electron-vite, the tests). The
app itself runs on Electron 45's bundled Node 24.

```bash
npm install
npm run dev          # the app with hot reload
npm run typecheck    # tsconfig.json (core, main, preload, tests) + tsconfig.web.json (renderer)
npm test             # core tests: no Electron, no model usage
npm run e2e          # builds, then drives the app with scripted models (Playwright)
npm run live         # builds, then drives the app with real Claude (haiku); uses model usage
npm run package      # installer for the current platform into release/
npx electron-builder --dir --publish never && node scripts/packaged-check.ts   # quick check of a packaged build
node scripts/codex-check.ts          # the Codex engine against real Codex (uses Codex usage)
node scripts/opencode-check.ts       # the OpenCode engine against real OpenCode (free model, or a scripted one)
node scripts/auto-mode-check.ts      # Claude Code "auto" permissions on this login (uses model usage)
npx electron scripts/make-icons.mjs  # regenerate build/ icons from build/icon.svg
```

`packaged-check.ts` exits with code 3 when everything worked except the model
turn because Claude Code is not signed in for that user.

The Linux build is made on Linux. On the owner's PC that is WSL2 Ubuntu (WSLg
shows the window): `wsl -d Ubuntu --exec bash scripts/wsl-sync.sh` copies the
checkout to `~/code-bot-linux` (without `node_modules`), then `npm ci`,
`npm test`, `npm run e2e` and `npm run package:linux` there, with Node 24 from
nvm on the PATH (`export PATH=$HOME/.nvm/versions/node/v24.14.0/bin:$PATH`).
Electron needs `libnss3 libasound2t64 libxss1 libnotify4`, already installed
there.

`package-lock.json` must be written by npm 11.9 or newer: older npm (the
owner's Windows Node 24.11 has npm 11.6) drops two optional `@emnapi` packages,
and `npm ci` on Linux and in CI then refuses the lock file. If you change
dependencies on Windows, regenerate the lock in WSL (`npm install` in the copy)
and copy it back.

Set `CODE_BOT_SHOTS` to a folder to have `e2e.ts` and `live-check.ts` save
screenshots there (also on failure). Set `CODE_BOT_LIVE_CODEX=1` to add a
project bot with Codex sub-agents to `npm run live` (needs `codex login`; uses
Codex usage on the cheapest fast model).

On the owner's Windows PC the default `node` is v12. Do not run `nvm use`; that
changes it for every terminal. Prefix the PATH for one command instead:

```powershell
$env:PATH = "$env:APPDATA\nvm\v24.11.1;$env:PATH"; npm test
```

Environment variables (read by `src/desktop/main/index.ts` and the engines):

| Variable | Purpose |
|---|---|
| `CODE_BOT_FAKE_MODELS=1` | Demo / test mode: `ScriptedBrain` for bots and `MockEngine` for sub-agents. No model usage. |
| `CODE_BOT_USER_DATA` | Use this folder instead of the OS app-data folder (tests use a temporary one). |
| `CODE_BOT_ENABLE_MOCK_ENGINE=1` | Offer the mock engine next to Claude Code. |
| `CODE_BOT_CLAUDE_EXECUTABLE` | Use this Claude Code binary instead of the one bundled with the Agent SDK. |
| `CODE_BOT_CODEX_EXECUTABLE` | Use this Codex binary instead of `codex` on the PATH. |
| `CODE_BOT_OPENCODE_EXECUTABLE` | Use this OpenCode binary instead of `opencode` on the PATH. |
| `CODE_BOT_NO_QUIT_PROMPT=1` | Quit without asking even while sub-agents work (tests). |

Claude Code must be signed in on the machine for real use. The app checks on
start-up and shows a banner with a Sign in button (it opens a terminal running
`claude auth login`); `claude auth status` shows the state. Codex sub-agents
need the Codex CLI signed in (`codex login`); OpenCode sub-agents need OpenCode
installed (its free models need no sign-in; others: `opencode auth login`).

The app keeps its data in the OS app-data folder (`%APPDATA%\code-bot` on
Windows, `~/Library/Application Support/code-bot` on macOS, `~/.config/code-bot`
on Linux): `data/code-bot.db`, `main-bot/` (the main bot's empty working
folder) and `worktrees/` (sub-agents' git worktrees).

## Where things are

| Path | What |
|---|---|
| `src/core/` | The orchestrator. No Electron imports: it must stay runnable headless. Start with `code-bot.ts`; `tasks.ts` runs sub-agents, `worktrees.ts` their git worktrees, `engines/` the coding agents (`claude.ts`, `codex.ts`, `opencode.ts`, `mock.ts`). |
| `src/shared/types.ts` | Every type shared by core, main, preload and renderer, including `CodeBotApi` and the event shapes. |
| `src/desktop/main/` | Electron main process: window, IPC (`ipc.ts`), terminals (`terminal.ts`), quit handling. |
| `src/desktop/preload/` | The `window.codeBot` bridge. |
| `src/desktop/renderer/` | The React interface. `src/state.ts` is the window's state; `src/components/` the views. |
| `test/` | `node:test` suites for the core. `helpers.ts` has `setup`, `TestBrain` (scripted, with per-bot overrides) and waiters. |
| `scripts/e2e.ts`, `scripts/live-check.ts` | Playwright drives the built app: scripted models, then real Claude. |
| `scripts/packaged-check.ts` | Starts the packaged app from `release/` and runs one real model turn, proving it finds its unpacked Claude Code. |
| `scripts/codex-check.ts`, `scripts/opencode-check.ts`, `scripts/auto-mode-check.ts` | Live checks of the Codex and OpenCode engines and of Claude Code's `auto` mode. |
| `scripts/make-icons.mjs`, `build/` | The app icon: `build/icon.svg` and the PNG/ICO files made from it. |
| `scripts/wsl-sync.sh` | Copies the checkout into WSL for Linux builds and checks. |
| `.github/workflows/build.yml` | CI for Windows and Linux: typecheck, tests, end-to-end, installers. Not run yet. |
| `docs/architecture.md` | Components, the three levels, routing rules, lifecycle, security model. |
| `docs/api.md` | Operations, events and bot tools: the contract between window and core. |
| `docs/decisions.md` | Why things are the way they are, including what was rejected and replaced. |
| `docs/roadmap.md` | What to build next, with the constraints already researched. |

## Rules for changing this code

- **Keep `src/core` free of Electron and the DOM.** The next milestone runs it
  headless on a server. Desktop-only behaviour belongs in `src/desktop`.
- **Core TypeScript must be erasable.** The tests run `src/core` directly in
  Node 24, which strips types and does not compile. No `enum`, no `namespace`,
  no constructor parameter properties; `import type` for types; relative imports
  with the `.ts` extension. `npm run typecheck` enforces it
  (`erasableSyntaxOnly`). The renderer is compiled by Vite and may use JSX.
- **Few dependencies.** Runtime (shipped) dependencies are the Claude Agent SDK
  and zod. Renderer libraries are bundled by Vite and are dev dependencies. Add
  one only when the alternative is clearly worse.
- **Every IPC method is validated.** A new `CodeBotApi` method needs its type in
  `src/shared/types.ts`, an argument schema and a handler in
  `src/desktop/main/ipc.ts`, and a line in `docs/api.md`.
- **Agent output is untrusted.** In the renderer it is rendered only as React
  text or through `MarkdownText` (raw HTML skipped). Never use
  `dangerouslySetInnerHTML`. The built page's Content-Security-Policy allows no
  inline script or style and no network.
- **Bots never get tools that change things.** The main bot has only its routing
  tools; project bots add Read, Grep, Glob and read-only git. Changes go through
  sub-agents. Text from sub-agents, files and tools reaches bots between `<<<`
  and `>>>`.
- **Bots cannot approve actions.** A project bot may answer a sub-agent's
  question, never an approval; it may start sub-agents only with the project's
  permission mode or a stricter one.
- **Engines stay behind the contract.** Engine-specific logic belongs in
  `src/core/engines/<name>.ts`.
- **Events are a public contract.** The window, and later remote clients, depend
  on the event names and shapes in `docs/api.md`. Add fields freely; rename or
  remove only on purpose, and update the docs and the renderer together.
- **Tests do not call models.** Use `MockEngine` and `ScriptedBrain` /
  `TestBrain`. Anything that needs a real model goes in `scripts/live-check.ts`.
- **Keep the documentation true.** A change to behaviour, operations, events,
  settings or environment variables updates the matching doc in the same change.
  Update the Status table above when something is built or verified.
- Do not commit `out/`, `release/`, `data/` or `.env` (already ignored).

## Things that are easy to get wrong

- **A task is not a run.** A task is a sub-agent's whole conversation and
  outlives its agent process. Each turn after the first starts a new process
  that resumes the stored engine session.
- **Who hears about the work is decided by `requestedBy`.** It is set from the
  project bot's current turn (`BotRuntime.replyTo`): work started while handling
  a main-bot message reports to the main bot, also for follow-up sub-agents
  started while reviewing that work.
- **Questions and approvals take different routes.** Questions go to the project
  bot first; approvals go straight to the user. Both are shown to the user in
  the conversation of whoever asked (`CodeBot.surface`), never only in the
  sub-agent.
- **Open requests survive a restart, but their agent does not.** After a
  restart a request is `held`: answering it resumes the sub-agent's session
  with the answer, and an approved call is allowed once more without asking
  (matched by tool and full input). See `TaskManager` in `src/core/tasks.ts`.
- **Worktrees are made by code-bot, not by bots.** `startSubagent` creates one
  when the project isolates sub-agents; archiving removes it; a message brings
  it back from its branch. Bots' `git` stays read-only.
- **Limits are read at every run** from the project bot (`prepareTurn`), not
  frozen when the sub-agent started.
- **Schema changes are migrations.** Add an entry to `MIGRATIONS` in
  `src/core/store.ts`; never edit a shipped one. Owners have data in it.
- **Node's `fs.globSync` misses dotfiles under `**`** (`**/.env` finds
  nothing in Node 24), so `worktrees.ts` has its own small matcher.
- **`bot.delta` and `text.delta` are never stored** and have `seq: 0`. Use
  `bot.text` / `text` for history.
- **Bot turns run one at a time per bot**, sub-agents in parallel. Updates that
  are out of date by the time a bot gets to them are dropped, not reported.
- **Sub-agents of one project share its folders** unless the project uses
  worktrees (bot settings, "Where sub-agents work").
- **Project folders must be canonical paths.** Claude Code treats a file under
  a short-name path (`C:\Users\ABCDEF~1\…`, which `os.tmpdir()` can return)
  as outside a working folder given in long form, and asks permission even to
  read it. `CodeBot.validate` stores `realpath`s; tests use canonical temp
  folders.
- **The packaged app needs the unpacked Claude Code binary.** See
  `claudeExecutable` in `src/desktop/main/index.ts` and `asarUnpack` in
  `electron-builder.yml`. Build each platform's installer on that platform.
- **The sandboxed preload must be CommonJS** (`out/preload/index.cjs`), although
  the project is ESM.
- **The window's state re-renders in batches** (`AppState.changed`); navigation
  re-renders at once. Tests must wait for what they expect to see.
- **The Agent SDK's option and message names change between versions.** Read
  `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` before changing
  `src/core/engines/claude.ts` or `src/core/brain.ts`.
- **`costUsd` is the engine's estimate** for the whole session, not a bill.
- **The version agents see** is `src/core/version.ts`; a test keeps it equal to
  `package.json`.
- **`getByRole('button', { name: 'Settings' })` is ambiguous** in the window
  (bot settings and app settings); the scripts use `exact: true` or test ids.
