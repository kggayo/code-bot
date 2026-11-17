import { useEffect, useState } from 'react';
import { DEFAULT_SETTINGS } from '../../../../shared/types.ts';
import type { AppSettings } from '../../../../shared/types.ts';
import { useAppState } from '../state.ts';

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
