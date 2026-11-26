import { useEffect, useState } from 'react';
import type { Routine, RoutineInput, RoutineSchedule } from '../../../../shared/types.ts';
import { api } from '../api.ts';
import { ago, describeSchedule, until, when } from '../format.ts';
import { useAppState } from '../state.ts';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS = [1, 2, 3, 4, 5];

interface Draft {
  botId: string;
  title: string;
  prompt: string;
  kind: RoutineSchedule['kind'];
  time: string;
  days: number[];
  every: number;
  unit: 'minutes' | 'hours';
  /** datetime-local value, e.g. "2026-11-27T09:00". */
  at: string;
  enabled: boolean;
}

/** A local date and time as a datetime-local input wants it. */
function localInput(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function blank(botId: string): Draft {
  const inAnHour = new Date(Date.now() + 60 * 60 * 1000);
  inAnHour.setMinutes(0, 0, 0);
  return { botId, title: '', prompt: '', kind: 'daily', time: '09:00', days: [...WEEKDAYS], every: 2, unit: 'hours', at: localInput(inAnHour), enabled: true };
}

function fromRoutine(routine: Routine): Draft {
  const draft = { ...blank(routine.botId), title: routine.title, prompt: routine.prompt, enabled: routine.enabled };
  const { schedule } = routine;
  if (schedule.kind === 'daily') return { ...draft, kind: 'daily', time: schedule.time, days: [...schedule.days] };
  if (schedule.kind === 'interval') {
    const hours = schedule.minutes % 60 === 0;
    return { ...draft, kind: 'interval', every: hours ? schedule.minutes / 60 : schedule.minutes, unit: hours ? 'hours' : 'minutes' };
  }
  return { ...draft, kind: 'once', at: localInput(new Date(schedule.at)) };
}

function toInput(draft: Draft): RoutineInput {
  const schedule: RoutineSchedule =
    draft.kind === 'daily'
      ? { kind: 'daily', time: draft.time, days: draft.days }
      : draft.kind === 'interval'
        ? { kind: 'interval', minutes: Math.round(draft.every * (draft.unit === 'hours' ? 60 : 1)) }
        : { kind: 'once', at: new Date(draft.at).toISOString() };
  return { botId: draft.botId, title: draft.title, prompt: draft.prompt, schedule, enabled: draft.enabled };
}

function Editor({ draft, onChange }: { draft: Draft; onChange(draft: Draft): void }) {
  const app = useAppState();
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  return (
    <>
      <div className="field-row">
        <label className="grow">
          Name
          <input name="routineTitle" value={draft.title} placeholder="Morning ticket check" onChange={(event) => set({ title: event.target.value })} />
        </label>
        <label>
          Bot
          <select name="routineBot" value={draft.botId} onChange={(event) => set({ botId: event.target.value })}>
            {app.bots.map((bot) => (
              <option key={bot.id} value={bot.id}>
                {bot.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label>
        Message
        <textarea
          name="routinePrompt"
          rows={4}
          value={draft.prompt}
          placeholder="What the bot is told each time, as if you typed it. For example: check ClickUp for new bugs assigned to me and summarise them."
          onChange={(event) => set({ prompt: event.target.value })}
        />
      </label>
      <div className="field-row top">
        <label>
          When
          <select name="routineKind" value={draft.kind} onChange={(event) => set({ kind: event.target.value as Draft['kind'] })}>
            <option value="daily">On chosen days</option>
            <option value="interval">Repeatedly</option>
            <option value="once">Once</option>
          </select>
        </label>
        {draft.kind === 'daily' && (
          <label>
            At
            <input name="routineTime" type="time" value={draft.time} onChange={(event) => set({ time: event.target.value })} />
          </label>
        )}
        {draft.kind === 'interval' && (
          <>
            <label>
              Every
              <input
                name="routineEvery"
                type="number"
                min={1}
                value={Number.isFinite(draft.every) ? draft.every : ''}
                onChange={(event) => set({ every: Number(event.target.value) })}
              />
            </label>
            <label>
              Unit
              <select name="routineUnit" value={draft.unit} onChange={(event) => set({ unit: event.target.value as Draft['unit'] })}>
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
              </select>
            </label>
          </>
        )}
        {draft.kind === 'once' && (
          <label className="grow">
            On
            <input name="routineAt" type="datetime-local" value={draft.at} onChange={(event) => set({ at: event.target.value })} />
          </label>
        )}
      </div>
      {draft.kind === 'daily' && (
        <div className="day-picker" role="group" aria-label="Days">
          {DAYS.map((name, day) => (
            <button
              key={name}
              type="button"
              className="option"
              aria-pressed={draft.days.includes(day)}
              onClick={() => set({ days: draft.days.includes(day) ? draft.days.filter((item) => item !== day) : [...draft.days, day].sort() })}
            >
              {name}
            </button>
          ))}
        </div>
      )}
      <label className="check">
        <input type="checkbox" checked={draft.enabled} onChange={(event) => set({ enabled: event.target.checked })} /> Enabled
      </label>
      <small>Routines run while code-bot is open, in this computer's time. One that came due while code-bot was closed runs once when it starts.</small>
    </>
  );
}

/** Messages sent to a bot on a schedule: the list, and a form to add or change one. */
export function RoutinesDialog({ botId }: { botId: string | null }) {
  const app = useAppState();
  const [filter, setFilter] = useState<string | null>(botId);
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') app.openRoutines(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [app]);

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      return false;
    }
  };

  const save = async () => {
    if (!editing) return;
    setSaving(true);
    const input = toInput(editing.draft);
    const ok = await run(() => (editing.id ? app.updateRoutine(editing.id, input) : app.createRoutine(input)));
    setSaving(false);
    if (ok) setEditing(null);
  };

  const shown = app.routines.filter((routine) => !filter || routine.botId === filter);
  const filterBot = filter ? app.bot(filter) : undefined;

  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && app.openRoutines(null)}>
      <div className="dialog wide" role="dialog" aria-modal="true" aria-label="Routines">
        <div className="dialog-title">
          <h2>Routines{filterBot ? ` · ${filterBot.name}` : ''}</h2>
          {filter && (
            <button type="button" className="link" onClick={() => setFilter(null)}>
              Show all
            </button>
          )}
        </div>
        <p className="muted small-print">
          A routine sends a bot a message on a schedule, as if you typed it: the bot replies in its conversation and starts work as
          usual.
        </p>

        {editing ? (
          <form
            className="routine-form"
            data-testid="routine-form"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <fieldset>
              <legend>{editing.id ? 'Change routine' : 'New routine'}</legend>
              <Editor draft={editing.draft} onChange={(draft) => setEditing({ ...editing, draft })} />
            </fieldset>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <div className="dialog-actions">
              <span className="spacer" />
              <button type="button" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button type="submit" className="primary" disabled={saving}>
                {editing.id ? 'Save' : 'Add routine'}
              </button>
            </div>
          </form>
        ) : (
          <>
            {shown.length === 0 ? (
              <p className="muted">No routines{filterBot ? ` for ${filterBot.name}` : ''} yet.</p>
            ) : (
              <ul className="routine-list" data-testid="routine-list">
                {shown.map((routine) => (
                  <li key={routine.id} className={routine.enabled ? '' : 'paused'} data-testid="routine-item">
                    <div className="routine-main">
                      <div className="routine-top">
                        <strong>{routine.title}</strong>
                        <span className="muted"> · {app.bot(routine.botId)?.name}</span>
                      </div>
                      <div className="routine-meta">
                        <span>{describeSchedule(routine.schedule)}</span>
                        {routine.enabled && routine.nextRunAt ? (
                          <span>
                            next {when(routine.nextRunAt)} ({until(routine.nextRunAt)})
                          </span>
                        ) : (
                          <span>{routine.enabled ? 'will not run again' : 'paused'}</span>
                        )}
                        {routine.lastRunAt && <span>last ran {ago(routine.lastRunAt)}</span>}
                      </div>
                      {routine.lastError && <div className="form-error small-print">Last run failed: {routine.lastError}</div>}
                      <div className="routine-prompt">{routine.prompt}</div>
                    </div>
                    <div className="routine-actions">
                      <button type="button" onClick={() => void run(() => api.runRoutine(routine.id))} title="Send it now; the schedule stays">
                        Run now
                      </button>
                      <button type="button" onClick={() => void run(() => app.updateRoutine(routine.id, { enabled: !routine.enabled }))}>
                        {routine.enabled ? 'Pause' : 'Resume'}
                      </button>
                      <button type="button" onClick={() => setEditing({ id: routine.id, draft: fromRoutine(routine) })}>
                        Edit
                      </button>
                      <button type="button" className="danger" onClick={() => void run(() => app.deleteRoutine(routine.id))}>
                        Delete
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                className="primary"
                data-testid="new-routine"
                onClick={() => setEditing({ id: null, draft: blank(filter ?? app.selectedBotId) })}
              >
                + New routine
              </button>
              <span className="spacer" />
              <button type="button" onClick={() => app.openRoutines(null)}>
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
