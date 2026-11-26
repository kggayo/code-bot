import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { DEFAULT_SETTINGS } from '../../../../shared/types.ts';
import type { AppSettings } from '../../../../shared/types.ts';
import { api } from '../api.ts';
import { useAppState } from '../state.ts';
import { MarkdownText } from './Text.tsx';
import { UsageMeter } from './Usage.tsx';

function NumberField({
  name,
  label,
  hint,
  value,
  min,
  max,
  onChange,
}: {
  name: keyof AppSettings;
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  onChange(value: number): void;
}) {
  return (
    <label>
      {label}
      <input
        name={name}
        type="number"
        min={min}
        max={max}
        step={1}
        value={Number.isFinite(value) ? value : ''}
        onChange={(event) => onChange(event.target.value === '' ? Number.NaN : Number(event.target.value))}
      />
      <small>{hint}</small>
    </label>
  );
}

/** The installed version, the newest release, and the button that installs it. */
function Updates() {
  const app = useAppState();
  const update = app.update;
  const [busy, setBusy] = useState<'check' | 'install' | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const working = app.bots.find((bot) => bot.kind === 'main')?.status.activeSubagents ?? 0;

  const act = async (what: 'check' | 'install') => {
    setBusy(what);
    setError(null);
    try {
      if (what === 'check') await api.checkForUpdate();
      else await api.installUpdate();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(null);
      setConfirm(false);
    }
  };

  const downloading = update?.downloadPercent !== null && update?.downloadPercent !== undefined;
  return (
    <fieldset data-testid="updates">
      <legend>Updates</legend>
      <p className="small-print">
        {!update
          ? 'Not checked yet.'
          : update.available
            ? `code-bot ${update.latest} is out. You have ${update.current}.`
            : update.checkedAt
              ? `code-bot ${update.current} is the newest version (checked ${new Date(update.checkedAt).toLocaleString()}).`
              : `You have code-bot ${update.current}.`}
      </p>
      {update?.available && update.notes && (
        <details className="release-notes">
          <summary>What is new in {update.latest}</summary>
          <MarkdownText text={update.notes} />
        </details>
      )}
      {update?.available && update.methodNote && <small>{update.methodNote}</small>}
      {downloading && (
        <div className="usage-bar" role="progressbar" aria-label="Downloading the update" aria-valuenow={update?.downloadPercent ?? 0}>
          <span style={{ '--used': `${update?.downloadPercent ?? 0}%` } as CSSProperties} />
        </div>
      )}
      {(error || update?.error) && (
        <p className="form-error small-print" role="alert">
          {error ?? update?.error}
        </p>
      )}
      {confirm && (
        <p className="held-note">
          {update?.method === 'appimage'
            ? `Updating downloads the new AppImage, puts it in place of this one and restarts code-bot${working ? `; the ${working} sub-agent(s) working now stop and can be resumed afterwards` : ''}.`
            : `Installing closes code-bot${working ? `; the ${working} sub-agent(s) working now stop and can be resumed afterwards` : ''}. The installer then opens; finish it to start the new version.`}
        </p>
      )}
      <div className="inline-actions">
        <button type="button" onClick={() => void act('check')} disabled={busy !== null}>
          {busy === 'check' ? 'Checking…' : 'Check for updates'}
        </button>
        {update?.available &&
          (update.method === 'installer' || update.method === 'appimage' ? (
            update.installed === update.latest ? (
              <button type="button" className="primary" data-testid="install-update" onClick={() => void act('install')} disabled={busy !== null}>
                Restart into {update.latest}
              </button>
            ) : confirm ? (
              <button type="button" className="primary" data-testid="install-update" onClick={() => void act('install')} disabled={busy !== null}>
                {busy === 'install' ? (downloading ? `Downloading… ${update.downloadPercent}%` : 'Starting…') : `Install ${update.latest} now`}
              </button>
            ) : (
              <button type="button" className="primary" data-testid="install-update" onClick={() => setConfirm(true)}>
                Update to {update.latest}
              </button>
            )
          ) : (
            <button type="button" className="primary" data-testid="install-update" onClick={() => void act('install')}>
              Open the release page
            </button>
          ))}
      </div>
    </fieldset>
  );
}

/** App-wide settings, and whether each coding agent can run on this computer. */
export function AppSettingsDialog() {
  const app = useAppState();
  const [form, setForm] = useState<AppSettings>(() => ({ ...(app.settings ?? DEFAULT_SETTINGS) }));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') app.openAppSettings(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [app]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await app.updateSettings(form);
      app.openAppSettings(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && app.openAppSettings(false)}>
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label="code-bot settings"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <h2>code-bot settings</h2>
        <fieldset>
          <legend>Sub-agents</legend>
          <NumberField
            name="maxActiveSubagents"
            label="Sub-agents working at the same time"
            hint="Across all projects (1 to 50). Work beyond this waits until one finishes or is stopped."
            value={form.maxActiveSubagents}
            min={1}
            max={50}
            onChange={(value) => setForm({ ...form, maxActiveSubagents: value })}
          />
        </fieldset>
        <fieldset>
          <legend>Keeping history</legend>
          <div className="field-row top">
            <NumberField
              name="archiveAfterDays"
              label="Archive after (days)"
              hint="Finished sub-agents and earlier conversations without activity. 0: never."
              value={form.archiveAfterDays}
              min={0}
              max={3650}
              onChange={(value) => setForm({ ...form, archiveAfterDays: value })}
            />
            <NumberField
              name="deleteArchivedAfterDays"
              label="Delete archived after (days)"
              hint="Permanently, with their history. 0: never."
              value={form.deleteArchivedAfterDays}
              min={0}
              max={3650}
              onChange={(value) => setForm({ ...form, deleteArchivedAfterDays: value })}
            />
          </div>
          <small>Archiving removes a sub-agent's git worktree; its branch stays unless it was merged. Sub-agents with uncommitted changes are never archived automatically.</small>
        </fieldset>
        <fieldset>
          <legend>Coding agents on this computer</legend>
          <ul className="engine-list">
            {app.engines.length === 0 && <li className="muted">{app.checkingEngines ? 'Checking…' : 'Not checked yet.'}</li>}
            {app.engines.map((engine) => (
              <li key={engine.id} data-ready={String(engine.ready)}>
                <strong>{engine.label}</strong> <span className="muted">{engine.detail}</span>
              </li>
            ))}
          </ul>
          <button type="button" onClick={() => void app.checkEngines()} disabled={app.checkingEngines}>
            {app.checkingEngines ? 'Checking…' : 'Check again'}
          </button>
        </fieldset>
        <fieldset>
          <legend>Plan limits</legend>
          <UsageMeter />
          <small>
            Read from Claude Code and Codex without using any model usage. Costs shown next to bots and sub-agents are the agents' own
            estimates at API prices; a subscription is not billed per call.
          </small>
        </fieldset>
        <Updates />
        {app.info && (
          <p className="muted small-print">
            code-bot {app.info.version} · data in {app.info.dataDir}
          </p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <span className="spacer" />
          <button type="button" onClick={() => app.openAppSettings(false)}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={saving}>
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
