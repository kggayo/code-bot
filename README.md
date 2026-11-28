# code-bot

A code orchestrator for Windows and Linux, as a desktop app or a terminal command (macOS builds, untested). You talk to one
**main bot**, or to a **project bot**, and never have to manage the coding
agents that do the work:

- **Main bot**: your software manager. Tell it what you need ("fix the login
  bug in webshop"); it hands the work to the right project bot and tells you
  what came of it.
- **Project bots**: one per project, connected to that project's folders, with
  their own models, permissions and instructions. Each is the team lead: it
  reads the code, starts **sub-agents** (developers and QA) to do the work,
  answers their questions when it can, reviews their reports and reports back.
- **Sub-agents**: full coding agents (Claude Code or Codex; others can be
  plugged in) working in the project folders on your machine, with your `.env`
  files, databases and tools. Each project bot can run several at once, each
  with its own model and effort, optionally each in its own git worktree and
  branch so they never collide.

Questions a project bot cannot answer, and approvals for risky actions, appear
as cards in the conversation you are already in. They survive closing the app:
answer them later and the sub-agent picks up where it stopped.

One piece of work stays with one developer sub-agent from investigation to
fix, so it keeps its context and its branch; QA and code reviewers are separate
sub-agents whose findings go back to that developer.

Also in the window: limits per sub-agent (turns, budget), how many sub-agents
work at once, earlier conversations to read or continue, archiving (by hand or
after 30 days), "Open in terminal" to continue a sub-agent's session yourself,
and a banner with a Sign in button when a coding agent is not signed in. And:

- **Who is working**: spinners on busy bots and running sub-agents, a strip
  above the message box with the project bots (or sub-agents) at work, and in
  the main bot's side panel each project bot and what it is doing.
- **Plan limits and costs**: how much of your Claude Code (and Codex) plan's
  5-hour and weekly limits is used and when they reset, and what each bot and
  sub-agent used (the agents' own estimates).
- **Routines**: messages sent to a bot on a schedule (on chosen days at a time,
  every few hours, or once), with the next ones in the sidebar. Ask a bot for
  one ("every weekday at 9, check …") and it proposes it on a card you create
  with one click.
- **Readable approvals**: plans, commands, file edits and patches shown as
  such, and the answer kept on a card once given.
- **The taskbar icon** shows how many questions and approvals wait, and
  flashes when a new one arrives.
- **Updates**: code-bot tells you when a new version is out; on an installed
  Windows copy one click downloads and starts the installer, and an AppImage
  replaces itself and restarts.
- **A sub-agent's branch**: when sub-agents work in their own git worktrees,
  a finished one's branch can be merged into your project folder, or pushed
  with a pull request opened, from its panel.
- **Resizable panes**: drag the edges between the bot list, the conversation
  and the side panel.
- **MCP servers per project**: sub-agents already use the MCP servers of your
  Claude Code or Codex setup; a project's settings can add more for its
  sub-agents only (a command such as `npx @playwright/mcp@latest`, or an
  address with its token taken from an environment variable you name), each
  asking before every tool call or, if you tick it, not.

## Install

Download the latest release from
[Releases](https://github.com/kggayo/code-bot/releases/latest):

- **Windows 10 or 11 (64-bit):** run `code-bot-Setup-<version>.exe`. It installs
  code-bot for your user (no admin rights needed) and adds it to the Start
  menu. Or unzip `code-bot-<version>-win-x64.zip` anywhere and run
  `code-bot.exe`, without installing. The files are not code-signed yet, so
  Windows may say "Windows protected your PC": choose **More info**, then
  **Run anyway**.
- **Ubuntu or Debian (64-bit):** `sudo apt install ./code-bot_<version>_amd64.deb`.
- **Other Linux (64-bit):** make `code-bot-<version>.AppImage` executable
  (`chmod +x`) and run it. Ubuntu 24.04 needs `sudo apt install libfuse2t64`
  first.
- **macOS:** not built yet.

Then sign in to Claude (see [Signing in](#signing-in)), click
**+ New project bot**, give it a name and a one-line description (the main bot
routes by them), add the project's folder(s), choose models, effort and
permissions, and talk to it or to the main bot. Projects whose sub-agents use
their own git worktrees need git on the PATH.

## Headless, in a terminal

The same bots without a window, for a server or a VM you reach over SSH (also
from a phone): the `code-bot` command, on Windows and Linux. It runs from a git
checkout with Node 24 or newer:

```bash
git clone https://github.com/kggayo/code-bot.git && cd code-bot
npm ci
npm link              # puts the code-bot command on your PATH
code-bot login claude # once, if Claude Code is not signed in for this user
code-bot              # talk to the main bot
```

- `code-bot` starts code-bot in the background the first time and opens a chat
  with the main bot. `code-bot chat <bot>` opens a chat with a project bot.
  Closing the terminal leaves the bots and sub-agents working.
- `code-bot panes` opens a pane per bot: the main bot on the left, the project
  bots on the right. It uses tmux on Linux and Windows Terminal on Windows.
- In a chat, plain lines go to the bot. Questions and approvals from
  sub-agents appear as numbered cards, answered with `/allow 1`, `/deny 1` or
  `/answer 2`. `/help` lists the rest (`/subagents`, `/show`, `/merge`,
  `/push`, `/routines` …).
- `code-bot bot new` creates a project bot: its settings open in your editor.
  To bring your bots from another machine:
  - there: `code-bot export bots.json`;
  - here: `code-bot import bots.json --map "C:\src=/home/me/src"`.
- `code-bot service install` keeps it running as you:
  - on Linux, a systemd user service (add `--tz Asia/Manila` on a server that
    runs on UTC, so routines run at your times);
  - on Windows, a hidden start at sign-in.
- `code-bot status` and `code-bot stop` check on it and stop it. `code-bot help`
  lists every command.

The desktop app and the command use the same data folder by default, so they
see the same bots, but only one of them can run at a time.

## Run from source

For working on code-bot itself. Needs Node 24 or newer, and Claude signed in on
the machine.

```bash
npm install
npm run code-bot
```

`npm run code-bot` builds code-bot from the source code and starts it, as the
installed app would run. While changing the code, use `npm run dev` instead: it
starts code-bot with live reload as you edit. (`npm run <name>` runs a script
defined in `package.json`.)

To try the app without using any model, start it in demo mode with scripted
bots and mock sub-agents:

```bash
CODE_BOT_FAKE_MODELS=1 npm run dev
```

(PowerShell: `$env:CODE_BOT_FAKE_MODELS = "1"; npm run dev`.) In demo mode,
`@name task: …` to the main bot delegates, and in a project bot's conversation
`task: …` starts a sub-agent; see `src/core/scripted-brain.ts` for the
keywords.

## Signing in

code-bot has no account or login of its own. Each coding agent keeps its own
sign-in on your computer and code-bot uses it; it never sees your password or
token. Sign in once per agent and per computer (WSL counts as a separate one).

**Claude** is always needed: the main bot and the project bots run on it.

- In the app: when Claude is not signed in, a banner at the top says so. Click
  **Sign in**: a terminal opens with `claude auth login`, which opens your
  browser to sign in with your Claude account (a paid plan such as Pro or Max).
  Come back to the window; it checks again by itself, or click **Check again**.
- Or in a terminal: `claude auth login`, then `claude auth status` to check.
- You do not need to install Claude Code: code-bot ships its own copy, which
  shares the sign-in with any `claude` you already have.
- An `ANTHROPIC_API_KEY` environment variable works too; usage is then billed
  per token instead of coming from your subscription.

**Codex**, only for projects whose sub-agents use it (bot settings, "Coding
agent"):

- Install the Codex CLI: `npm install -g @openai/codex`, or the Codex desktop
  app, which brings it.
- Sign in with `codex login` (your ChatGPT account, in the browser) and check
  with `codex login status`. Once a project uses Codex, the banner offers
  **Sign in** for it too.

**⚙ Settings → Coding agents on this computer** shows whether each agent is
ready.

## Build an installer

```bash
npm run package
```

builds for the platform you run it on (installer and zip on Windows, DMG on
macOS, AppImage and deb on Linux) into `release/`. Builds are unsigned for
now: fine on your own machines; see decision 26 in `docs/decisions.md` before
sharing them. Published releases are built by GitHub Actions when a version tag
is pushed (see "Releasing" in [AGENTS.md](AGENTS.md)). On Windows, the Linux build can be made in WSL:
`wsl -d Ubuntu --exec bash scripts/wsl-sync.sh`, then `npm ci` and
`npm run package:linux` in `~/code-bot-linux`.

## Develop

```bash
npm run typecheck   # both TypeScript projects
npm test            # core tests, no model usage
npm run e2e         # drives the built app with scripted models
npm run live        # drives the built app with real Claude (haiku), in a throwaway folder
node scripts/codex-check.ts        # the Codex engine against real Codex
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
