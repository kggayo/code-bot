code-bot is a desktop app that orchestrates coding agents on your own computer. You talk to a main bot, or to a project bot. Each project bot runs sub-agents (Claude Code or Codex) in your project folders, and reports back with their results, questions and approval requests.

## What is new in 0.4.0

- **One developer per piece of work.** A ticket stays with the same sub-agent from investigation to fix, so it keeps its context and its branch. QA and code reviewers are separate sub-agents, and their findings go back to that developer.
- **Plan limits and costs.** See how much of your Claude Code (and Codex) 5-hour and weekly limits is used and when they reset, and what each bot and sub-agent used.
- **Routines.** Send a bot a message on a schedule: on chosen days at a time, every few hours, or once. The next ones are listed in the sidebar.
- **Who is working.** Spinners on busy bots and running sub-agents, a strip above the message box, and the main bot's side panel shows the project bots at work.
- **Readable approvals.** Plans, commands, file edits and patches are shown as such instead of JSON, and answered questions keep their answer.
- **Taskbar badge.** The icon shows how many questions and approvals wait, and flashes when one arrives.
- **Update button.** code-bot tells you when a new version is out; an installed Windows copy downloads and starts the installer for you (from this version on).
- **Resizable panes** and a **sharper icon** on the taskbar.

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
