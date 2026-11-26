code-bot is a desktop app that orchestrates coding agents on your own computer. You talk to a main bot, or to a project bot. Each project bot runs sub-agents (Claude Code or Codex) in your project folders, and reports back with their results, questions and approval requests.

## What is new in 0.5.0

- **MCP servers per project.** Give a project's sub-agents extra MCP servers in its settings, such as a browser to test with (`npx @playwright/mcp@latest`), on top of the ones in your Claude Code or Codex setup. Each tool call asks you first unless you tick "Run its tools without asking". A server reached by address can take its token from an environment variable you name: code-bot stores no tokens.
- **Merge or push a sub-agent's branch.** When sub-agents work in their own git worktrees, a finished one's panel lets you merge its branch into your project folder, or push it and open a pull request (with GitHub's `gh`, or GitHub's own page without it).
- **Routines from a conversation.** Ask a bot "every weekday at 9, …" and it proposes the routine on a card; it exists once you click Create.
- **The AppImage updates itself.** On Linux the update button downloads the new AppImage, checks it, puts it in place and restarts (from this version on). The `.deb` still opens the release page.
- **A tidier window in small sizes.** The conversation keeps its title and its room when the window is narrow, and the settings dialog no longer scrolls sideways.

## Download

| Your computer | File | How |
|---|---|---|
| Windows 10 or 11 (64-bit) | `code-bot-Setup-<version>.exe` | Run it to install code-bot for your user (no admin rights needed). It appears in the Start menu. |
| Windows, without installing | `code-bot-<version>-win-x64.zip` | Unzip it anywhere and run `code-bot.exe`. |
| Ubuntu or Debian (64-bit) | `code-bot_<version>_amd64.deb` | `sudo apt install ./code-bot_<version>_amd64.deb`, then start code-bot from your apps. |
| Other Linux (64-bit) | `code-bot-<version>.AppImage` | `chmod +x code-bot-<version>.AppImage`, then run it. Ubuntu 24.04 needs `sudo apt install libfuse2t64` first. |

macOS is not built yet.

The Windows files are not code-signed yet, so Windows may show "Windows protected your PC" for a downloaded copy: choose **More info**, then **Run anyway**.

## Before you start

- **Sign in to Claude** on your computer: the main bot and the project bots run on it. code-bot shows a **Sign in** button when you are not signed in. See [Signing in](https://github.com/kggayo/code-bot#signing-in).
- **Codex** only if a project uses it for its sub-agents: install the Codex CLI and run `codex login`.
- **git** on the PATH, for projects whose sub-agents work in their own git worktrees.

Then click **+ New project bot**, add a project folder, and talk to it or to the main bot.

Documentation: [README](https://github.com/kggayo/code-bot#readme) · License: MIT
