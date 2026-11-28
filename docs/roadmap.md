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
| 1.1 Verify macOS and Linux | Linux verified in WSL2 Ubuntu 24.04 (tests, end-to-end, AppImage and deb, packaged app). macOS skipped by the owner (no Mac). CI workflow for Windows and Linux in `.github/workflows/build.yml`: passes on GitHub's runners (tests, end-to-end, installers). |
| 1.2 Installers people can trust | App icon (`build/`). Signing deferred until the app is shared (decision 26). Package trimming measured and dropped (decision 23). |
| 1.3 One git worktree per sub-agent | Built (decision 20). |
| 1.4 Sign-in check | Built: banner with Sign in, and the engines in Settings. |
| 1.4 Try `auto` permissions | Works on the owner's plan; `acceptEdits` stays the default (decision 25). |
| 1.4 Open in a terminal | Built for Claude Code and Codex. |
| 1.4 Requests that survive a restart | Built, engine-independent (decision 19). |
| 1.4 Limits | Built: turns per run, budget per sub-agent, sub-agents at once (decision 21). |
| 1.4 Retention | Built: archive by hand or after 30 days; deletion opt-in (decision 22). |
| 1.4 Earlier conversations | Built: list, read, reopen, archive. |
| 1.5 More engines | Codex built and verified through the app with real Codex (decision 24). |

### Finished after Milestone 1 (2026-11-26)

macOS and code signing moved to Milestone 3 (the owner, 2026-11-26). The rest
of what was open was built:

| Item | Outcome |
|---|---|
| Merging from the app | Built: a stopped sub-agent's branch is merged into the project folder, or pushed with a pull request opened, from its panel (decision 33). |
| Routines from a conversation | Built: bots propose a routine on a card; the user creates it (decision 34). |
| Updating in place on Linux | Built for the AppImage (decision 35). The `.deb` still opens the release page: replacing it needs `sudo apt`. |
| Keys for MCP servers by name | Built: an HTTP MCP server names the environment variable that holds its token; the agents read it (decision 32). |

### Still open

- **claude.ai connectors for Claude Code sub-agents.** The connectors of the
  owner's Claude account (ClickUp, Gmail, …) do not load in Agent SDK sessions
  (decision 32). Re-test after an SDK upgrade; if a supported switch appears, a
  per-project "use my claude.ai connectors" setting is a small addition. Codex
  sub-agents already get the ChatGPT apps of the owner's Codex login.

## Milestone 2: the main bot on the Azure VM, reachable over an API or MCP

The owner's next milestone: run code-bot on the Azure VM so the PC can be off,
and talk to the main bot from other assistants (Claude, ChatGPT/Codex, Grok)
through API endpoints or MCP.

### 2.1 Headless core and the terminal (built 2026-11-27)

Built (decisions 36-38). The details are in `docs/architecture.md`, "Headless
and the terminal":
- `code-bot serve`, and the `code-bot` command that starts it in the background;
- `code-bot chat`, and `code-bot panes` for tmux or Windows Terminal;
- `export` and `import` with mapped folders;
- `service install`: a systemd user unit, or a start at sign-in on Windows;
- the HTTP API on 127.0.0.1 (`docs/api.md`, "HTTP").

It runs from a git checkout on Node 24 (`npm ci`, then `npm link` for the
command). It runs as the owner's user, with Claude Code signed in for that user:
`code-bot login claude` runs `claude auth login`, which works over SSH. Not yet
tried: `claude setup-token` for `CLAUDE_CODE_OAUTH_TOKEN`. The VM needs Node
24, git, the project checkouts with their `.env` files, and their tooling.

Still open here:
- **An install without a checkout.** Node does not strip types under
  `node_modules`, so an `npm install -g` package needs the headless code built
  to JavaScript first. The Electron app could also serve as the Node that runs
  it (`ELECTRON_RUN_AS_NODE`), as VS Code's `code` command does.
- **Updating the headless install.** Today: `git pull`, `npm ci`, then restart
  the service.

### 2.2 HTTP API

The local part is built (2.1): bearer token, 127.0.0.1 only, `POST` per
operation, server-sent events with a 15-second heartbeat, and catching up with
`getThread(…, after)`. Still to add for remote callers:
- **Access from outside the machine.** Reach it through a VPN or an
  authenticating HTTPS proxy, never an open port.
- **A long-poll variant** (`?after=<seq>&wait=<seconds>`, at most 50) for
  callers that cannot hold a stream; the MCP adapter needs it.

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

## Milestone 3: macOS and code signing

Moved here from Milestone 1 by the owner (2026-11-26): there is no Mac to test
on, and signing only matters once the app is shared beyond the owner.

### 3.1 macOS

Build and run on a Mac: `npm test`, `npm run e2e`, `npm run live`,
`npm run package`, `node scripts/packaged-check.ts`; or add `macos-latest` to the
CI matrix and the release workflow. Signing and notarization need the Apple
Developer Program. Untested so far: `openTerminal` on macOS (a `.command` file
opened in Terminal), the dock badge (`app.dock.setBadge`), and the update button
(it opens the release page on macOS, decision 31).

### 3.2 Code signing

Sign the Windows installer and app when the app is shared (decision 26 lists
the options and the catch with the bundled `claude.exe`'s own signature), and
notarize the macOS build. Signed installers would also let the update button
install without the "Windows protected your PC" step.

## Later

- Mobile access (dropped for now by the owner on 2026-11-17).
- Project bots that coordinate with each other directly (today the main bot
  coordinates across projects).
