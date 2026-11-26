import type { CSSProperties } from 'react';
import type { UsageWindow } from '../../../../shared/types.ts';
import { ago, until, when } from '../format.ts';
import { useAppState } from '../state.ts';

/** normal, warning or critical: the agent's own reading, else by how full the window is. */
function level(window: UsageWindow): 'normal' | 'warning' | 'critical' {
  if (window.severity) return window.severity;
  const used = window.usedPercent ?? 0;
  return used >= 90 ? 'critical' : used >= 75 ? 'warning' : 'normal';
}

function Bar({ window }: { window: UsageWindow }) {
  const used = window.usedPercent;
  return (
    <div className="usage-window" data-level={level(window)} data-testid="usage-window">
      <div className="usage-line">
        <span>{window.label}</span>
        <span className="usage-percent">{used === null ? '?' : `${Math.round(used)}%`}</span>
      </div>
      <div
        className="usage-bar"
        role="meter"
        aria-label={window.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={used ?? undefined}
      >
        <span style={{ '--used': `${Math.max(0, Math.min(100, used ?? 0))}%` } as CSSProperties} />
      </div>
      {window.resetsAt && (
        <div className="usage-reset" title={new Date(window.resetsAt).toLocaleString()}>
          resets {until(window.resetsAt)} · {when(window.resetsAt)}
        </div>
      )}
    </div>
  );
}

/**
 * How much of each coding agent's plan is used: the 5-hour session and the
 * week for Claude Code, Codex's windows. Read from the agents, which costs no
 * model usage; refreshed every ten minutes and after work ends.
 */
export function UsageMeter({ compact = false }: { compact?: boolean }) {
  const app = useAppState();
  if (app.usage.length === 0) {
    return compact ? null : (
      <div className="usage">
        <p className="muted small-print">{app.checkingUsage ? 'Reading the plan limits…' : 'Not read yet.'}</p>
        <button type="button" onClick={() => void app.checkUsage()} disabled={app.checkingUsage}>
          Check now
        </button>
      </div>
    );
  }
  const checked = app.usage.map((usage) => usage.checkedAt).sort()[0];
  return (
    <section className={`usage${compact ? ' compact' : ''}`} aria-label="Plan limits" data-testid="usage-meter">
      {app.usage.map((usage) => (
        <div key={usage.engineId} className="usage-engine">
          <div className="usage-head">
            <strong>{usage.label}</strong>
            {usage.plan && <span className="muted"> · {usage.plan}</span>}
          </div>
          {usage.windows.map((window) => (
            <Bar key={window.id} window={window} />
          ))}
          {usage.note && <p className="usage-note">{usage.note}</p>}
        </div>
      ))}
      <div className="usage-foot">
        <span className="muted">{checked ? `checked ${ago(checked)}` : ''}</span>
        <button
          type="button"
          className="link small"
          onClick={() => void app.checkUsage()}
          disabled={app.checkingUsage}
          title="Read the limits again (uses no model usage)"
        >
          {app.checkingUsage ? 'checking…' : 'refresh'}
        </button>
      </div>
    </section>
  );
}
