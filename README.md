# code-bot

A desktop code orchestrator for Windows and Linux (macOS builds, untested). You talk to one
**main bot**, or to a **project bot**, and never have to manage the coding
agents that do the work:

- **Main bot**: your software manager. Tell it what you need ("fix the login
  bug in webshop"); it hands the work to the right project bot and tells you
  what came of it.
- **Project bots**: one per project, connected to that project's folders, with
  their own models, permissions and instructions. Each is the team lead: it
  reads the code, starts **sub-agents** (developers and QA) to do the work,
  answers their questions when it can, reviews their reports and reports back.
- **Sub-agents**: full coding agents (Claude Code, Codex or OpenCode; others can be
  plugged in) working in the project folders on your machine, with your `.env`
  files, databases and tools. Each project bot can run several at once, each
  with its own model and effort, optionally each in its own git worktree and
  branch so they never collide.

Questions a project bot cannot answer, and approvals for risky actions, appear
as cards in the conversation you are already in. They survive closing the app:
answer them later and the sub-agent picks up where it stopped.

Also in the window: limits per sub-agent (turns, budget), how many sub-agents
work at once, earlier conversations to read or continue, archiving (by hand or
after 30 days), "Open in terminal" to continue a sub-agent's session yourself,
and a banner with a Sign in button when a coding agent is not signed in.

## Run it

Needs Node 24 or newer for development, and Claude Code signed in on the machine
(the app checks and offers to sign in; `claude auth login` does the same). For
Codex sub-agents, the Codex CLI installed and signed in (`codex login`); for
OpenCode sub-agents, OpenCode installed (`npm install -g opencode-ai`).

```bash
npm install
npm run dev
```

In the window: **+ New project bot**, give it a name and a one-line description
(the main bot routes by them), add the project's folder(s), choose models,
effort and permissions, then talk to it or to the main bot.

To try the app without using any model, start it in demo mode with scripted
bots and mock sub-agents:

```bash
CODE_BOT_FAKE_MODELS=1 npm run dev
```

(PowerShell: `$env:CODE_BOT_FAKE_MODELS = "1"; npm run dev`.) In demo mode,
`@name task: …` to the main bot delegates, and in a project bot's conversation
`task: …` starts a sub-agent; see `src/core/scripted-brain.ts` for the
keywords.

## Build an installer

```bash
npm run package
```

builds for the platform you run it on (NSIS installer on Windows, DMG on
macOS, AppImage and deb on Linux) into `release/`. Builds are unsigned for
now: fine on your own machines; see decision 26 in `docs/decisions.md` before
sharing them. On Windows, the Linux build can be made in WSL:
`wsl -d Ubuntu --exec bash scripts/wsl-sync.sh`, then `npm ci` and
`npm run package:linux` in `~/code-bot-linux`.

## Develop

```bash
npm run typecheck   # both TypeScript projects
npm test            # core tests, no model usage
npm run e2e         # drives the built app with scripted models
npm run live        # drives the built app with real Claude (haiku), in a throwaway folder
node scripts/codex-check.ts        # the Codex engine against real Codex
node scripts/opencode-check.ts     # the OpenCode engine against real OpenCode
node scripts/auto-mode-check.ts    # Claude Code's "auto" permissions on your login
npx electron scripts/make-icons.mjs  # icons in build/ from build/icon.svg
```

## Documentation

| Document | For |
|---|---|
| [AGENTS.md](AGENTS.md) | Anyone, human or coding agent, about to change the code. Start here. |
| [docs/architecture.md](docs/architecture.md) | How it works inside. |
| [docs/api.md](docs/api.md) | Operations and events between the window and the orchestrator. |
| [docs/decisions.md](docs/decisions.md) | Why it is built this way. |
| [docs/roadmap.md](docs/roadmap.md) | What comes next, including the Azure VM milestone. |

## License

MIT: see [LICENSE](LICENSE). Source: https://github.com/kggayo/code-bot
