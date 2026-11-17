# Roadmap

What is left, in the order recommended on 2026-11-17. Each item says what done
looks like and what is already known, so it can be started without repeating
the research. Background is in `docs/decisions.md`.

## Milestone 1: the desktop app (done on Windows and Linux, 2026-11-17)

Everything planned for the desktop app is built. What was verified, and how, is
in the status table in `AGENTS.md`; the reasoning is in `docs/decisions.md`
(19-27). Summary of what was open and how it ended:

| Item | Outcome |
|---|---|
| 1.1 Verify macOS and Linux | Linux verified in WSL2 Ubuntu 24.04 (tests, end-to-end, AppImage and deb, packaged app). macOS skipped by the owner (no Mac). CI workflow for Windows and Linux in `.github/workflows/build.yml`, not run yet (nothing pushed). |
| 1.2 Installers people can trust | App icon (`build/`). Signing deferred until the app is shared (decision 26). Package trimming measured and dropped (decision 23). |
| 1.3 One git worktree per sub-agent | Built (decision 20). |
| 1.4 Sign-in check | Built: banner with Sign in, and the engines in Settings. |
| 1.4 Try `auto` permissions | Works on the owner's plan; `acceptEdits` stays the default (decision 25). |
| 1.4 Open in a terminal | Built for Claude Code, Codex and OpenCode. |
| 1.4 Requests that survive a restart | Built, engine-independent (decision 19). |
| 1.4 Limits | Built: turns per run, budget per sub-agent, sub-agents at once (decision 21). |
| 1.4 Retention | Built: archive by hand or after 30 days; deletion opt-in (decision 22). |
| 1.4 Earlier conversations | Built: list, read, reopen, archive. |
| 1.5 More engines | Codex built and verified through the app with real Codex (decision 24). OpenCode built and verified against the real OpenCode server with a scripted model (decision 27). |

### Still open after Milestone 1

- **macOS.** Build and run on a Mac: `npm test`, `npm run e2e`, `npm run live`,
  `npm run package`, `node scripts/packaged-check.ts`; or add `macos-latest` to
  the CI matrix. Signing and notarization need the Apple Developer Program.
  `openTerminal` on macOS (a `.command` file opened in Terminal) is untested.
- **Run the CI workflow.** It runs on the first push to `main` of
  https://github.com/kggayo/code-bot.
- **Signing** when the app is shared (decision 26 lists the options and the
  `claude.exe` signature catch).
- **OpenCode with a real model.** Run `node scripts/opencode-check.ts` when the
  free models' daily limit has reset (it tries `opencode/big-pickle` first), or
  with a provider signed in (`opencode auth login`), and once through the app.
- **Orphaned OpenCode servers.** If code-bot crashes, a running sub-agent's
  `opencode serve` stays up; code-bot could stop leftovers on its next start.
- **Shared process helpers.** `codex.ts` and `opencode.ts` each carry a copy of
  the helpers that find and spawn a program; they could move to one module.
- **Merging from the app.** Today a sub-agent's branch is handed over or merged
  by another sub-agent; a "merge into the project folder" button for the user
  is a possible addition.

## Milestone 2: the main bot on the Azure VM, reachable over an API or MCP

The owner's next milestone: run code-bot on the Azure VM so the PC can be off,
and talk to the main bot from other assistants (Claude, ChatGPT/Codex, Grok)
through API endpoints or MCP.

### 2.1 Headless core on the VM

`src/core` already has no Electron imports. Add a headless entry point that
creates `Store`, the engines, `ClaudeBrain` and `CodeBot`, plus a way to define
project bots without the window (an import of bot definitions, or the API
below). Run it as a service (systemd on Linux, a Windows service otherwise)
under its own OS user, with Claude Code signed in for that user
(`claude auth login`, or `claude setup-token` for `CLAUDE_CODE_OAUTH_TOKEN` on
a machine without a browser; not yet tried). The VM needs Node 24, git, the
project checkouts with their `.env` files, and their tooling.

### 2.2 HTTP API

Mirror `CodeBotApi` and the event stream. The first version (2026-11-16) did
this and it worked; its design, worth reusing:

- Bearer token on every route; the server listens on `127.0.0.1` and is reached
  through a VPN or an authenticating HTTPS proxy, never an open port.
- `POST` endpoints for the operations; `GET` with `?after=<seq>` for history.
- Server-sent events for live updates, resuming from `Last-Event-ID` / `after`,
  with a heartbeat every 15 seconds.
- A long-poll variant (`?after=<seq>&wait=<seconds>`, at most 50) for callers
  that cannot hold a stream.

### 2.3 MCP for assistants

Expose the main bot as MCP tools, start-then-poll, within the limits in
decisions 9:

- `ask_main_bot(text)` returns at once; `main_bot_updates(after, max_wait ≤ 45 s)`
  returns new messages from the main bot.
- Optionally direct tools: `list_project_bots`, `ask_project_bot(bot, text)`,
  `answer_request(task, request, answer)`.
- Mark read-only tools with `readOnlyHint` so clients do not ask before polling.
- Codex can use a private address with a bearer token. Claude's apps, ChatGPT
  and Grok need public HTTPS with OAuth 2.1 (PKCE, dynamic registration or
  client ID metadata documents). Do not hand-roll OAuth; options found: the
  `mcp-auth-proxy` binary in front, an OAuth proxy over one GitHub, Google or
  Entra app, or Cloudflare Tunnel with Access managed OAuth. None was tested.
- None of these clients can be told when work finishes; they see it on their
  next call. Push notices only reach code-bot's own app.

### 2.4 The desktop app as a remote window

The renderer only uses `CodeBotApi` and `CoreEvent`s (`src/desktop/renderer/src/api.ts`
and `state.ts`). An HTTP implementation of the same interface would let the
desktop app show a code-bot running on the VM.

## Later

- Mobile access (dropped for now by the owner on 2026-11-17).
- Project bots that coordinate with each other directly (today the main bot
  coordinates across projects).
