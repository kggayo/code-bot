import { useEffect, useRef, useState } from 'react';
import { joinCommandLine, splitCommandLine } from '../../../../shared/command-line.ts';
import { DEFAULT_WORKTREE_FILES, EFFORTS, PERMISSION_MODES } from '../../../../shared/types.ts';
import type { BotInput, BotView, Effort, Isolation, McpServer, PermissionMode } from '../../../../shared/types.ts';
import { api } from '../api.ts';
import { PERMISSION_LABEL } from '../format.ts';
import { useAppState } from '../state.ts';
import type { Editor } from '../state.ts';

const MODEL_SUGGESTIONS = ['opus', 'sonnet', 'haiku'];

function blank(engine: string): BotInput {
  return {
    name: '',
    description: '',
    folders: [],
    instructions: '',
    model: null,
    effort: null,
    subagents: {
      engine,
      model: null,
      effort: null,
      permissionMode: 'acceptEdits',
      isolation: 'shared',
      worktreeFiles: [...DEFAULT_WORKTREE_FILES],
      maxTurns: null,
      maxBudgetUsd: null,
      mcpServers: [],
    },
  };
}

/** A number input's value, or null when it is empty. */
function optionalNumber(value: string): number | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : Number(trimmed);
}

function fromBot(bot: BotView): BotInput {
  return {
    name: bot.name,
    description: bot.description,
    folders: [...bot.folders],
    instructions: bot.instructions,
    model: bot.model,
    effort: bot.effort,
    subagents: { ...bot.subagents, worktreeFiles: [...bot.subagents.worktreeFiles] },
  };
}

/** An MCP server as edited: a command line or an address in one field. */
interface ServerRow {
  key: number;
  name: string;
  line: string;
  /** For an address: the environment variable holding its token (the name only). */
  tokenEnvVar: string;
  allowTools: boolean;
}

const isAddress = (line: string) => /^https?:\/\//i.test(line.trim());

function toRows(servers: McpServer[]): ServerRow[] {
  return servers.map((server, index) => ({
    key: index,
    name: server.name,
    line: server.type === 'http' ? server.url : joinCommandLine([server.command, ...server.args]),
    tokenEnvVar: server.type === 'http' ? (server.tokenEnvVar ?? '') : '',
    allowTools: server.allowTools,
  }));
}

/** The rows as servers: a line starting with http:// or https:// is an address, anything else a command. Empty rows are left out. */
function fromRows(rows: ServerRow[]): McpServer[] {
  return rows
    .filter((row) => row.name.trim() || row.line.trim())
    .map((row): McpServer => {
      const name = row.name.trim();
      const line = row.line.trim();
      if (isAddress(line)) return { type: 'http', name, url: line, tokenEnvVar: row.tokenEnvVar.trim() || null, allowTools: row.allowTools };
      const [command = '', ...args] = splitCommandLine(line);
      return { type: 'stdio', name, command, args, allowTools: row.allowTools };
    });
}

function McpServersField({ rows, onChange }: { rows: ServerRow[]; onChange: (rows: ServerRow[]) => void }) {
  const nextKey = useRef(rows.length);
  const update = (key: number, patch: Partial<ServerRow>) =>
    onChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  return (
    <fieldset className="mcp-servers">
      <legend>MCP servers for sub-agents</legend>
      <p className="muted">
        Sub-agents already have the MCP servers of your Claude Code or Codex setup. Add more for this project only, for example a
        browser to test with: <code>npx @playwright/mcp@latest</code>
      </p>
      {rows.map((row) => (
        <div className="mcp-row" key={row.key} data-testid="mcp-server">
          <input
            name="mcpName"
            aria-label="MCP server name"
            placeholder="playwright"
            maxLength={40}
            value={row.name}
            onChange={(event) => update(row.key, { name: event.target.value })}
          />
          <input
            name="mcpCommand"
            aria-label="Command or address"
            placeholder="npx @playwright/mcp@latest, or https://…"
            value={row.line}
            onChange={(event) => update(row.key, { line: event.target.value })}
          />
          <button type="button" className="link" onClick={() => onChange(rows.filter((item) => item.key !== row.key))}>
            Remove
          </button>
          {isAddress(row.line) && (
            <input
              name="mcpTokenEnv"
              aria-label="Token from environment variable"
              placeholder="Token from environment variable (optional), for example DOCS_MCP_TOKEN"
              maxLength={100}
              value={row.tokenEnvVar}
              onChange={(event) => update(row.key, { tokenEnvVar: event.target.value })}
            />
          )}
          <label className="check">
            <input
              type="checkbox"
              name="mcpAllowTools"
              checked={row.allowTools}
              onChange={(event) => update(row.key, { allowTools: event.target.checked })}
            />{' '}
            Run its tools without asking (otherwise each call asks you first; sub-agents in plan mode always ask)
          </label>
        </div>
      ))}
      <div>
        <button
          type="button"
          onClick={() => onChange([...rows, { key: nextKey.current++, name: '', line: '', tokenEnvVar: '', allowTools: false }])}
        >
          + Add MCP server
        </button>
      </div>
      <small>
        No keys or tokens here. A command reads what it needs from the environment code-bot runs in; for an address, name the
        environment variable that holds its token and the agent reads it from there. Changes apply from each sub-agent's next turn.
      </small>
    </fieldset>
  );
}

function ModelFields({
  idPrefix,
  model,
  effort,
  onChange,
}: {
  idPrefix: string;
  model: string | null;
  effort: Effort | null;
  onChange(model: string | null, effort: Effort | null): void;
}) {
  return (
    <div className="field-row">
      <label>
        Model
        <input
          name={`${idPrefix}Model`}
          list="model-suggestions"
          placeholder="Default"
          value={model ?? ''}
          onChange={(event) => onChange(event.target.value.trim() || null, effort)}
        />
      </label>
      <label>
        Effort
        <select
          name={`${idPrefix}Effort`}
          value={effort ?? ''}
          onChange={(event) => onChange(model, (event.target.value || null) as Effort | null)}
        >
          <option value="">Default</option>
          {EFFORTS.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

/** Create or change a project bot, or the main bot's model settings. */
export function BotEditor({ editor }: { editor: Editor }) {
  const app = useAppState();
  const existing = editor.mode === 'edit' ? app.bot(editor.botId) : undefined;
  const isMain = existing?.kind === 'main';
  const engines = app.info?.engines ?? ['claude'];
  const [form, setForm] = useState<BotInput>(() => (existing ? fromBot(existing) : blank(engines[0] ?? 'claude')));
  const [folderPath, setFolderPath] = useState('');
  const [filesText, setFilesText] = useState(() => form.subagents.worktreeFiles.join('\n'));
  const [servers, setServers] = useState<ServerRow[]>(() => toRows(form.subagents.mcpServers));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => {
    first.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') app.openEditor(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [app]);

  const set = (patch: Partial<BotInput>) => setForm((current) => ({ ...current, ...patch }));
  const setSub = (patch: Partial<BotInput['subagents']>) =>
    setForm((current) => ({ ...current, subagents: { ...current.subagents, ...patch } }));
  const addFolders = (paths: string[]) =>
    set({ folders: [...form.folders, ...paths.filter((path) => !form.folders.includes(path))] });

  const browse = async () => {
    try {
      addFolders(await api.pickFolders());
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  const addTyped = async () => {
    const path = folderPath.trim();
    if (!path) return;
    const [check] = await api.checkFolders([path]);
    if (!check?.exists) {
      setError(`Folder not found: ${path}. Use the full path of an existing folder.`);
      return;
    }
    setError(null);
    addFolders([path]);
    setFolderPath('');
  };

  /** The form with the fields edited as text (worktree files, MCP servers) turned into lists. */
  const withLists = (input: BotInput): BotInput => ({
    ...input,
    subagents: {
      ...input.subagents,
      worktreeFiles: filesText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
      mcpServers: fromRows(servers),
    },
  });

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      if (!existing) {
        const bot = await app.createBot(withLists(form));
        app.openEditor(null);
        app.select(bot.id);
      } else if (isMain) {
        await app.updateBot(existing.id, { model: form.model, effort: form.effort, instructions: form.instructions });
        app.openEditor(null);
      } else {
        await app.updateBot(existing.id, withLists(form));
        app.openEditor(null);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!existing) return;
    if (!confirmRemove) {
      setConfirmRemove(true);
      return;
    }
    try {
      await app.archiveBot(existing.id);
      app.openEditor(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setConfirmRemove(false);
    }
  };

  const title = !existing ? 'New project bot' : isMain ? 'Main bot settings' : `${existing.name} settings`;

  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && app.openEditor(null)}>
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <h2>{title}</h2>
        <datalist id="model-suggestions">
          {MODEL_SUGGESTIONS.map((model) => (
            <option key={model} value={model} />
          ))}
        </datalist>

        {!isMain && (
          <>
            <label>
              Name
              <input
                ref={first}
                name="name"
                required
                maxLength={40}
                placeholder="webshop"
                value={form.name}
                onChange={(event) => set({ name: event.target.value })}
              />
              <small>The main bot finds this bot by name, so use the name you call the project.</small>
            </label>
            <label>
              What is this project?
              <textarea
                name="description"
                rows={2}
                placeholder="Online shop: REST API and React front end"
                value={form.description}
                onChange={(event) => set({ description: event.target.value })}
              />
              <small>The main bot reads this to decide which bot a request is for.</small>
            </label>

            <fieldset className="folders">
              <legend>Project folders</legend>
              {form.folders.length === 0 && <p className="muted">Add at least one. The first is where sub-agents start.</p>}
              <ul>
                {form.folders.map((folder, index) => (
                  <li key={folder}>
                    <span className="folder-path" title={folder}>
                      {folder}
                      {index === 0 && <span className="muted"> · primary</span>}
                    </span>
                    <button type="button" className="link" onClick={() => set({ folders: form.folders.filter((item) => item !== folder) })}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
              <div className="folder-add">
                <button type="button" onClick={() => void browse()}>
                  Browse…
                </button>
                <input
                  name="folderPath"
                  placeholder="or paste a full path"
                  value={folderPath}
                  onChange={(event) => setFolderPath(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void addTyped();
                    }
                  }}
                />
                <button type="button" onClick={() => void addTyped()} disabled={!folderPath.trim()}>
                  Add folder
                </button>
              </div>
            </fieldset>
          </>
        )}

        <fieldset>
          <legend>{isMain ? 'Main bot model' : 'Project bot model (the team lead)'}</legend>
          <ModelFields idPrefix="bot" model={form.model} effort={form.effort} onChange={(model, effort) => set({ model, effort })} />
        </fieldset>

        {!isMain && (
          <fieldset>
            <legend>Sub-agents (developers and QA)</legend>
            <ModelFields
              idPrefix="sub"
              model={form.subagents.model}
              effort={form.subagents.effort}
              onChange={(model, effort) => setSub({ model, effort })}
            />
            <div className="field-row">
              {engines.length > 1 && (
                <label>
                  Coding agent
                  <select name="engine" value={form.subagents.engine} onChange={(event) => setSub({ engine: event.target.value })}>
                    {engines.map((engine) => (
                      <option key={engine} value={engine}>
                        {app.engines.find((candidate) => candidate.id === engine)?.label ?? engine}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="grow">
                Permissions
                <select
                  name="permissionMode"
                  value={form.subagents.permissionMode}
                  onChange={(event) => setSub({ permissionMode: event.target.value as PermissionMode })}
                >
                  {PERMISSION_MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {PERMISSION_LABEL[mode]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <small>The project bot can pick a different model or effort for one task, or stricter permissions, but never looser ones.</small>
            <label>
              Where sub-agents work
              <select
                name="isolation"
                value={form.subagents.isolation}
                onChange={(event) => setSub({ isolation: event.target.value as Isolation })}
              >
                <option value="shared">In the project folders, together</option>
                <option value="worktree">Each in its own git worktree and branch</option>
              </select>
              <small>
                {form.subagents.isolation === 'worktree'
                  ? 'Sub-agents cannot collide. Each commits to a branch code-bot/<id>; the project bot reviews it and hands it over or merges it.'
                  : 'Simple, but two sub-agents editing the same files can collide.'}
              </small>
            </label>
            {form.subagents.isolation === 'worktree' && (
              <label>
                Files to copy into each worktree
                <textarea
                  name="worktreeFiles"
                  rows={2}
                  placeholder={DEFAULT_WORKTREE_FILES.join('\n')}
                  value={filesText}
                  onChange={(event) => setFilesText(event.target.value)}
                />
                <small>Untracked files a fresh checkout lacks, such as .env: one path or pattern per line, relative to the project folder.</small>
              </label>
            )}
            <div className="field-row">
              <label>
                Turns per run
                <input
                  name="maxTurns"
                  type="number"
                  min={1}
                  step={1}
                  placeholder="No limit"
                  value={form.subagents.maxTurns ?? ''}
                  onChange={(event) => setSub({ maxTurns: optionalNumber(event.target.value) })}
                />
              </label>
              <label>
                Budget per sub-agent (USD)
                <input
                  name="maxBudgetUsd"
                  type="number"
                  min={0.01}
                  step={0.01}
                  placeholder="No limit"
                  value={form.subagents.maxBudgetUsd ?? ''}
                  onChange={(event) => setSub({ maxBudgetUsd: optionalNumber(event.target.value) })}
                />
              </label>
            </div>
            <small>Limits stop a sub-agent that runs too long; a message lets it continue. The budget uses the agent's own cost estimate.</small>
          </fieldset>
        )}

        {!isMain && <McpServersField rows={servers} onChange={setServers} />}

        <label>
          Standing instructions <span className="muted">(optional)</span>
          <textarea
            name="instructions"
            rows={3}
            placeholder={isMain ? 'How you want the main bot to work with you' : 'Conventions, what to always check, who to ask…'}
            value={form.instructions}
            onChange={(event) => set({ instructions: event.target.value })}
          />
          {!isMain && <small>The project's own CLAUDE.md is read anyway; use this for what only this bot needs.</small>}
        </label>

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          {existing && !isMain && (
            <button type="button" className="danger" onClick={() => void remove()}>
              {confirmRemove ? 'Click again to remove' : 'Remove bot'}
            </button>
          )}
          <span className="spacer" />
          <button type="button" onClick={() => app.openEditor(null)}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={saving}>
            {existing ? 'Save' : 'Create bot'}
          </button>
        </div>
      </form>
    </div>
  );
}
