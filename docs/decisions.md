# Decisions

Why code-bot is built the way it is. Each entry says what was decided, why, and
what would have to be true to revisit it. Entries are dated. Superseded entries
stay, marked as such, so the reasoning is not lost.

"Researched" means read from vendor documentation or project pages on that date
and not independently tested. "Verified" means it was run here.

## 1. Build a small orchestrator instead of adopting an existing one (2026-11-16)

**Decided:** write a thin custom app.

**Why:** a survey of existing tools (researched 2026-11-16) found none that met
the owner's requirements (see `AGENTS.md`):

| Tool | Closest to | Where it falls short |
|---|---|---|
| OpenClaw | Per-project agents with a coordinator, chat channels | Cannot force a model on an external harness such as Claude Code; does not relay Claude Code's permission prompts (they fail or are auto-approved). Long list of security advisories. |
| Hermes Agent | Native approvals and per-profile model settings | Its workers are Hermes itself, not Claude Code sessions. |
| Claude Code Remote Control (`claude remote-control`) | Per-project sessions driven from the Claude apps, per-session model and effort | No main bot that routes work, no project bot that delegates, Claude only, one server per project folder. |
| OpenCode (`opencode serve`) | Per-agent model config | Stays inside one project. |
| Agent Orchestrator, Paseo, Happy, cc-connect | Agents on your own machine with a remote client | No cross-project router bot; effort settings undocumented. |

What the owner disliked about Grok Bot is exactly what this design fixes: there
is no model picker, and a bot cannot take a new task while busy. The Claude
Agent SDK already provides the hard parts (per-session model and effort,
resumable sessions, interceptable questions and approvals), so the custom layer
is small.

**Revisit if:** an existing tool gains per-agent model and effort control,
relays harness permission prompts, and supports a manager / lead / worker
hierarchy.

Sources: https://docs.openclaw.ai/tools/acp-agents/ ,
https://docs.openclaw.ai/tools/acp-agents-setup ,
https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban ,
https://code.claude.com/docs/en/remote-control , https://opencode.ai/docs/server/ ,
https://docs.x.ai/grok-bot/faq

## 2. Interface: private web page plus HTTP API (2026-11-16) — superseded by 13

The first version was a Node server with an HTTP API (server-sent events for
streaming) and a private web page, meant to run on the Azure VM and be used from
phone and desktop. It worked (tested live), but the owner chose a desktop app
first (entry 13). That code was replaced and never committed; its API design is
summarised in `docs/roadmap.md`, milestone 2, because the next milestone brings
an API back.

## 3. Stack: TypeScript on Node, SQLite (2026-11-16, updated 2026-11-17)

**Decided:** TypeScript throughout. Storage is Node's built-in `node:sqlite`.
The core (`src/core`, `src/shared`) uses only erasable TypeScript, so it runs
directly in Node 24 for the tests. The desktop app is built with electron-vite
(entry 18).

**Why:** the Claude Agent SDK is first-class in TypeScript, and the likely next
engines (Codex, OpenCode) have TypeScript SDKs. `node:sqlite` means no native
modules: verified on 2026-11-17 that Electron 45.3.3 ships Node 24.22.3 with
`node:sqlite` working, so the same storage code runs in the tests and in the
app, with nothing to rebuild per Electron version.

**Cost:** Node 24 for development; `node:sqlite` prints an experimental warning
in plain Node (suppressed in the test script).

## 4. Claude Code through the Agent SDK, behind an engine contract (2026-11-16)

**Decided:** `src/core/engines/types.ts` defines the contract;
`src/core/engines/claude.ts` implements it with `@anthropic-ai/claude-agent-sdk`.

**Why the SDK rather than spawning `claude -p`:** the SDK already implements the
control protocol (`canUseTool` for approvals and questions, `resume`,
`interrupt()`, streaming input).

**Why not Remote Control or Managed Agents:** Remote Control has no programmatic
router. Managed Agents runs the model loop on Anthropic's side and sends
conversation history there, which is not "my own machine".

**Why a contract:** the owner wants any agent to be pluggable. Nothing outside
`src/core/engines/` knows about Claude Code.

## 5. One agent process per turn, resumed by session id (2026-11-16)

**Decided:** each turn of a sub-agent is its own process. When the turn ends the
process exits; a follow-up starts a new one with `resume`.

**Why:** an idle Claude Code process costs a few hundred megabytes, and finished
sub-agents can sit for a long time before a follow-up. While a turn runs,
streaming input still allows steering and interruption.

**Cost:** a follow-up pays a few seconds of start-up.

## 6. Who loads which Claude Code settings (2026-11-16, updated 2026-11-17)

**Decided:**

| | Built-in tools | `settingSources` | MCP servers |
|---|---|---|---|
| Sub-agent | Claude Code preset | default (user, project, local) | from settings |
| Project bot | Read, Grep, Glob only | user, project, local | only code-bot's own (`strictMcpConfig`) |
| Main bot | none | none | only code-bot's own |

**Why:** "a bot that knows the project" means the project's `CLAUDE.md`, skills
and rules apply, so project bots and sub-agents load the project's settings. The
main bot is a pure router and needs none of them. Bots run with
`permissionMode: 'dontAsk'` and an explicit allow list, so a settings file can
give them a tool to read with, but never one that changes anything.

## 7. Reports flow back to whoever asked (2026-11-16, updated 2026-11-17)

**Decided:** every task records who asked for it (`requestedBy`: `user` or
`main`). When a sub-agent finishes, its project bot gets an update turn; if the
work came from the main bot, the project bot's reply is passed to the main bot,
which tells the user. If the user asked the project bot directly, the reply
stays in the project bot's conversation.

**Why:** the owner's model: a developer reports to the team lead, the team lead
reports to the manager if the manager assigned the work, otherwise to the person
who asked. Running reports as turns also keeps each bot's own context current,
so "now also do X" makes sense to it.

**Cost:** one model call per report at each level. Out-of-date updates are
dropped instead of reported late.

## 8. Events are stored with a sequence number; text fragments are not (2026-11-16)

**Decided:** every thread and task event is a SQLite row with a per-owner `seq`.
Streaming text fragments are sent live with `seq: 0` and not stored. Long
strings in stored events are cut to 2000 characters.

**Why:** the window (and later remote clients) can load history and continue
from `seq` without gaps or duplicates. Full file contents and command output
already live in the engine's own session transcript.

## 9. Security (2026-11-16, updated 2026-11-17)

**Desktop app (current):** no network listener at all. The window is sandboxed
and talks to the main process over IPC; every call is validated and only the app
window may call. Details in `docs/architecture.md`, "Security model".

**Constraints for the next milestone (researched 2026-11-16).** Whatever exposes
the main bot from the Azure VM must fit these clients:

| Client | Calls come from | What the endpoint must offer | Limits |
|---|---|---|---|
| Claude custom connectors (web, desktop, mobile) | Anthropic's cloud | Public HTTPS on 443; OAuth with PKCE (client ID metadata documents, dynamic registration, or your own client) or no auth. Private and VPN-only addresses are rejected. | 240 s per tool call, about 150,000 characters per result |
| ChatGPT custom MCP servers | OpenAI's cloud | Public HTTPS; OAuth or no auth; no custom API keys | A staff forum post gives 60 s per tool call. OpenAI's own docs conflict on whether personal plans may use tools that take actions. |
| Codex (CLI, IDE, desktop app) | The user's device | Streamable HTTP or stdio; bearer token, headers or OAuth. Private addresses work. | `tool_timeout_sec`, default 60 |
| Grok custom connectors | xAI's cloud | Public internet; OAuth with dynamic registration. Little else is documented. | Undocumented |

None of them can receive an unsolicited message from a server: an MCP layer must
be start-then-poll, and every call must finish well inside 60 seconds.

Sources: https://claude.com/docs/connectors/building/authentication.md ,
https://claude.com/docs/connectors/building/index.md ,
https://developers.openai.com/api/docs/guides/developer-mode.md ,
https://learn.chatgpt.com/docs/extend/mcp?surface=cli ,
https://docs.x.ai/grok/connectors

## 10. Model usage through the Claude subscription login (2026-11-16)

**Decided (owner's choice):** bots and sub-agents use the Claude Code login on
the machine (`claude auth login`), not an API key.

**Caveat the owner has been told about:** Anthropic's documentation (researched
2026-11-16) says "Unless previously approved, Anthropic does not allow third
party developers to offer claude.ai login or rate limits for their products,
including agents built on the Claude Agent SDK", and that developers building
products on the Agent SDK "should use API key authentication". A personal,
single-user tool on one's own machine is not addressed either way. This is the
owner's call, not something to settle in code.

**How to switch:** set `ANTHROPIC_API_KEY` in the environment code-bot starts
in. Claude Code prefers it over a stored login. No code change is needed.

Sources: https://code.claude.com/docs/en/agent-sdk/overview.md ,
https://code.claude.com/docs/en/legal-and-compliance.md ,
https://code.claude.com/docs/en/authentication.md

## 11. Default sub-agent permission mode is `acceptEdits` (2026-11-16)

**Decided:** new project bots let sub-agents edit files without asking and ask
for other risky actions (commands, network). Configurable per project bot.

**Why:** with `default`, every edit and command asks, which makes delegation
useless. `bypassPermissions` on a machine holding database credentials is too
much for a default. `auto` (a classifier approves routine actions) is offered
as a choice; it was tested on the owner's plan on 2026-11-17 and works, and
`acceptEdits` stayed the default (decision 25).

## 12. The name is code-bot (2026-11-16)

**Decided (owner):** "code bot" or "code-bot". Files use `code-bot`, environment
variables `CODE_BOT_`. Never `codebot`.

## 13. Desktop app first (2026-11-17)

**Decided (owner):** drop mobile for now and build an Electron desktop app for
Windows, macOS and Linux, like the Grok Bot desktop app or VS Code. The next
milestone exposes the main bot over an API or MCP so it can run on the Azure VM.

**Why (owner's words, paraphrased):** a web app cannot start local Claude Code
or Codex processes. (Strictly, the first version's Node server did start them;
the browser page was only the window onto it. The desktop app removes the
separate server, the token and the browser, and gives native folder pickers and
notifications.)

**Consequence:** the orchestrator lives in `src/core` with no Electron imports,
so it can later run headless on the VM behind an API, and the desktop window
could connect to it.

## 14. Three levels: main bot, project bots, sub-agents (2026-11-17)

**Decided (owner):** the main bot is the software manager; a project bot is the
team lead / staff engineer / architect of one project, connected to that
project's folders, with its own settings and context; sub-agents are the
developers and QA that do one task each and report to their project bot. The
user talks only to the main bot or a project bot.

**Why:** the owner does not want to switch between sub-agents for every task.
The project bot keeps the project context and the overview; sub-agents keep
their own detailed context and stay out of the way.

## 15. Project bots read and delegate, but never change files (2026-11-17)

**Decided:** a project bot can read its folders (Read, Grep, Glob, read-only
git) and run sub-agents; it has no tool that edits files or runs commands.

**Why:** it matches the team-lead role, keeps every change inside a sub-agent
whose history the user can open, and keeps the lead's context for overview
rather than implementation detail.

**Revisit if:** the owner wants leads to make trivial changes themselves; the
switch is in `ClaudeBrain` (`READ_TOOLS`) and the project bot prompt.

## 16. Questions go to the team lead first; approvals only to the user (2026-11-17)

**Decided:** a sub-agent's question goes to its project bot, which answers it
when the answer is clear and otherwise leaves it; unanswered questions, and
every approval for an action, are put to the user as a card in the conversation
where the work was asked for (main or project bot). If the project bot is busy,
a question goes to the user after 2 minutes anyway.

**Why:** most questions a developer asks can be answered by the lead, which
saves the user interruptions; letting a bot approve another bot's risky actions
would defeat the approval. Showing the card where the user is already talking
means they never need to open a sub-agent.

## 17. Bots are created in the app, not in a config file (2026-11-17)

**Decided:** project bots are created and edited in the app (name, description,
folders, models, permissions, instructions) and stored in SQLite in the app's
data folder. The YAML config of the first version is gone.

**Why:** like Grok Bot, a bot is something you create in the app. A file can come
back later as an import or export for the VM.

## 18. Electron 45, electron-vite, React, electron-builder (2026-11-17)

**Decided:** Electron 45.3.3 (Node 24.22.3); electron-vite 6 (on Vite 8) builds
the main process, the preload and the renderer; React 19 with `react-markdown`
and `remark-gfm` for the interface; electron-builder 26 for installers; Playwright
(`playwright-core`) drives the built app in the end-to-end and live checks.

**Why:** electron-vite gives one config and hot reload for all three parts;
React keeps a growing interface manageable; electron-builder covers NSIS, DMG,
AppImage and deb. The renderer libraries are bundled, so they are dev
dependencies; only the Claude SDK and zod ship as runtime dependencies.

**Things that follow from it:**

- The preload must be CommonJS because the window is sandboxed; it is built to
  `out/preload/index.cjs`.
- The Claude Code binary must be unpacked from `app.asar` (`asarUnpack`) and
  passed to the SDK explicitly in a packaged app.
- Each platform's installer must be built on that platform, because npm installs
  only the current platform's Claude Code binary package.
- The built renderer is not minified (electron-vite's default). It loads from
  disk, so size matters little.

## 19. Requests survive a restart by resuming with the answer, not by deferring the call (2026-11-17)

**Decided:** every open question and approval is stored (`requests` table).
When code-bot closes while a sub-agent waits, the request stays open ("held");
answering it after the restart resumes the sub-agent's session with a note of
the answers, and an approved call is allowed once more without asking when the
agent repeats exactly that call (same tool, same full input, compared by hash).
The same mechanism serves every engine.

**Rejected:** Claude Code's `PreToolUse` hook decision `defer` (the roadmap's
first idea). Researched in the hooks reference on this date: it works only in
non-interactive mode and only when the model makes a single tool call in the
turn (with several it is ignored and the call goes through the normal permission
flow), a `PreToolUse` hook runs before Claude Code decides whether a call needs
permission (so it would pause calls nobody would have been asked about), the
resume must send no prompt, and whether a deferred `AskUserQuestion` can take
its answer is not documented. It is also Claude-only.

**Revisit if:** agents often fail to repeat the approved call after resuming
(each one then asks again, which is safe but annoying).

## 20. Worktrees: made by code-bot, under the app data folder, cleaned up on archive (2026-11-17)

**Decided:** isolation is a project bot setting (`shared` or `worktree`, default
`shared`), overridable per `start_subagent` call. Worktrees live in
`<userData>/worktrees/<task id>`, on branch `code-bot/<task id>-<title words>`
from the folder's current commit. Untracked files listed in the project
(default `.env`, `.env.*`) are copied in. Archiving removes the folder; the
branch is deleted only when merged; uncommitted changes block archiving unless
the user discards them. A later message brings a removed worktree back from its
branch at the same path.

**Why:** outside the project folder, worktrees cannot clutter `git status` or be
picked up by the project's own tooling, and the project bot reads them through
`additionalDirectories`. The same path on restore keeps the agent's session
(tied to its folder) resumable. Bots still never run git commands that write;
merging goes through a sub-agent (with the user's approvals) or the user.

**Known costs:** a fresh worktree has no `node_modules` or build output, so the
sub-agent installs or builds first. Relative paths between several project
folders (`../other-repo`) do not hold inside a worktree.

## 21. Limits are per run (turns) and per sub-agent (budget), read at each run (2026-11-17)

**Decided:** `maxTurns` caps each run; `maxBudgetUsd` caps a sub-agent's whole
session, using the engine's own cost estimate. Both come from the project bot's
current settings when a run starts, so raising them lets a stopped sub-agent
continue. The number of sub-agents working at once is an app setting (1-50,
default 12).

**Why:** the SDK's `maxBudgetUsd` counts only the spend since that `query()`
started, while a task spans many runs; giving each run the remaining amount
makes the budget hold across runs. On a subscription the estimate is not a bill
but still a fair measure of usage.

## 22. Retention: archive after 30 days, never delete unless asked (2026-11-17)

**Decided:** finished sub-agents and earlier conversations are archived (hidden,
worktree removed) after 30 days without activity; archived items are deleted
only if the user sets "delete archived after" (default 0, never). Sub-agents
with uncommitted worktree changes or unanswered requests are never archived
automatically. Archiving is also available by hand.

**Why:** the owner should not lose history silently; archiving keeps lists
short, and deletion is an explicit choice.

## 23. The package is not trimmed further (2026-11-17)

**Measured:** in the Windows build (`release/win-unpacked`, 724 MB) the app
archive is 11 MB; the unpacked Claude Code binary is 355 MB and Electron most of
the rest. Excluding the Agent SDK's peer dependencies would save a few MB at
most, and the SDK's `core.mjs` entry does import `@modelcontextprotocol/sdk`
(its main entry `sdk.mjs` bundles its own copy). Not worth the risk of a missing
module at run time. The roadmap's earlier note claimed more; it was wrong.

## 24. Codex runs through `codex app-server` (2026-11-17)

**Decided:** the Codex engine (`src/core/engines/codex.ts`) speaks the
app-server protocol (JSON-RPC lines on stdio, what the Codex IDE extension
uses), one process per run, with the message shapes generated by
`codex app-server generate-ts` for codex-cli 0.160.1.

**Why not `codex exec --json` or the Codex SDK:** they cannot ask for approval
mid-run (approvals are a fixed policy), so code-bot could not relay approvals
to the owner. app-server sends approval requests and `request_user_input`
questions to the client and supports steering a running turn.

**Verified** (`scripts/codex-check.ts`, real Codex signed in with ChatGPT, a
cheap model at low effort): a new thread created a file after an approval in
permission mode `default`; resuming the thread remembered the file; a question
reached `askUser` as `AskUserQuestion` and the answer got back; nothing was
written to Codex's `config.toml`. Through the app
(`CODE_BOT_LIVE_CODEX=1 npm run live`): a project bot's Codex sub-agent created
a file after an approval card, and the project bot's follow-up continued the
same Codex session. The engine's tests run it against a fake app-server
(`test/fixtures/fake-codex.ts`).

**Known limits and catches:**

- Questions outside Codex's Plan mode need the under-development feature
  `default_mode_request_user_input`, switched on per thread by code-bot. The
  model sometimes uses `request_user_input_async` instead; its answer goes back
  as a message.
- The sandbox is set per turn, never at `thread/start`: a writable sandbox there
  makes app-server write a trust entry for the folder into `~/.codex/config.toml`.
- The sandbox keeps network access. Without it, Codex's Windows sandbox runs as
  a separate offline user whose setup needs elevation (a UAC prompt) and clashed
  with the setup the Codex desktop app had made.
- `maxTurns` counts model calls in a turn; `maxBudgetUsd` is ignored and no cost
  is reported (app-server reports tokens; a ChatGPT login has no per-token price).

## 25. `auto` permissions work on the owner's plan; `acceptEdits` stays the default (2026-11-17)

**Verified:** `scripts/auto-mode-check.ts` ran a Claude Code sub-agent (haiku,
low effort, the owner's Claude subscription login) with `permissionMode: 'auto'`: it wrote a file and
ran `git --version` and `node --version` with no approval requests.

**Decided:** keep `acceptEdits` ("Edit freely": asks before commands) as the
default for new project bots, and offer `auto` per project (decision 11). In
`auto` a classifier, not the owner, approves commands on a machine that holds
database credentials; that should be the owner's explicit choice per project.

## 26. Installers are unsigned for now (2026-11-17)

**Decided:** no code signing until the app is shared beyond the owner.

**Researched** (vendor pages, this date): an unsigned Windows installer works;
SmartScreen warns only for downloaded files (Mark of the Web), and Smart App
Control, where switched on, blocks unsigned apps. Azure Artifact Signing (the
renamed Trusted Signing, about $10 a month) is open to individuals only in the
US and Canada; in the EU only to organisations. A standard (OV) certificate for
an individual costs roughly $150-300 a year (Certum's open-source certificate
less) and must live on a hardware token or the CA's cloud HSM; EV certificates
no longer bypass SmartScreen reputation. Linux AppImage and deb need no
signature. macOS needs the Apple Developer Program ($99 a year) for signing and
notarization.

**When signing comes:** electron-builder signs every `.exe` in
`app.asar.unpacked` by default, which would replace Anthropic's signature on the
bundled `claude.exe`; exclude it (`win.signExts`) and check that the signature
is still Anthropic's.

## 27. OpenCode runs through `opencode serve` (2026-11-17)

**Decided:** the OpenCode engine (`src/core/engines/opencode.ts`) starts
`opencode serve` per run on 127.0.0.1 with a random password and drives it over
HTTP and server-sent events, following the server's OpenAPI document for
OpenCode 1.1.33. Permission modes go into `OPENCODE_PERMISSION` in that
process's environment; the user's OpenCode config files are never written.

**Why not `opencode acp`:** in 1.1.33 the ACP bridge is itself a client of the
same HTTP server (started without a password), does not pass on OpenCode's
question tool (a question would wait forever) and reports no cost.

**Verified** (`scripts/opencode-check.ts`): against the real OpenCode server, a
new session created a file after an approval in permission mode `default`,
resuming the session remembered it, and an interrupt ended the run in under a
second; the user's config files were unchanged. The model was a scripted one
served locally to OpenCode: every free OpenCode model on the owner's PC
answered "Free usage limit reached" (a daily limit, reset at midnight UTC), so
no real model completed a turn. Questions, plan mode, steering and `maxTurns`
were also tried against the real server. The engine's tests use a fake server
(`test/fixtures/fake-opencode.ts`).

**Known catches:** OpenCode rewrites `~/.config/opencode/package.json` and
`bun.lock` itself when it starts; a crash of code-bot leaves a running
`opencode serve` behind.

## 28. Open source on the owner's personal GitHub, MIT (2026-11-17)

**Decided:** the code lives at https://github.com/kggayo/code-bot, public, under
the MIT license (GitHub's template, `LICENSE`), on the owner's personal account
rather than their company account. The repository-local git config sets the
commit identity and a credential helper that takes the personal account's token
from `gh` at push time (`gh auth token --user kggayo`), so pushing works
without switching `gh`'s active account, which other projects on the PC use.

**Why not `gh`'s own git helper:** in gh 2.92 it only serves the active account,
whatever user name git asks for.
