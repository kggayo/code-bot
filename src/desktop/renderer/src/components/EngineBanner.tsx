import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { useAppState } from '../state.ts';

/**
 * Shown when a coding agent the app needs cannot run here: not installed or
 * not signed in. Bots always run on Claude Code; other agents count when a
 * project uses them for its sub-agents.
 */
export function EngineBanner() {
  const app = useAppState();
  const [error, setError] = useState<string | null>(null);
  const used = new Set<string>(['claude']);
  for (const bot of app.bots) if (bot.kind === 'project') used.add(bot.subagents.engine);
  const problems = app.info?.fakeModels ? [] : app.engines.filter((engine) => engine.ready === false && used.has(engine.id));

  // After signing in in a terminal, coming back to the window checks again.
  useEffect(() => {
    if (problems.length === 0) return;
    const onFocus = () => {
      if (!app.checkingEngines) void app.checkEngines();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [app, problems.length]);

  if (problems.length === 0) return null;
  const signIn = async (engineId: string) => {
    setError(null);
    try {
      await api.signIn(engineId);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  return (
    <div className="banner" role="alert" data-testid="engine-banner">
      <div className="banner-lines">
        {problems.map((engine) => (
          <div key={engine.id} className="banner-line">
            <span>
              <strong>{engine.label}:</strong> {engine.detail}
              {engine.canSignIn && ' Sign in once in the terminal that opens, then come back here.'}
            </span>
            {engine.canSignIn && (
              <button type="button" className="primary" onClick={() => void signIn(engine.id)}>
                Sign in
              </button>
            )}
          </div>
        ))}
        {error && <div className="banner-error">{error}</div>}
      </div>
      <button type="button" onClick={() => void app.checkEngines()} disabled={app.checkingEngines}>
        {app.checkingEngines ? 'Checking…' : 'Check again'}
      </button>
    </div>
  );
}
