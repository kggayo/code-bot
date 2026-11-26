import type { BotView } from '../../../../shared/types.ts';
import { folderLabel, usageLine } from '../format.ts';
import { useAppState } from '../state.ts';

/** What a project bot is doing, in a few words. */
export function activity(bot: BotView): { working: boolean; text: string } {
  const { busy, activeSubagents } = bot.status;
  const agents = activeSubagents === 1 ? '1 sub-agent working' : `${activeSubagents} sub-agents working`;
  if (busy && activeSubagents > 0) return { working: true, text: `Thinking · ${agents}` };
  if (busy) return { working: true, text: 'Thinking…' };
  if (activeSubagents > 0) return { working: true, text: agents };
  return { working: false, text: 'Idle' };
}

/**
 * The main bot's side panel: the project bots and what each is doing. The main
 * bot hands work to project bots, so their sub-agents stay in their own panels.
 */
export function TeamPanel() {
  const app = useAppState();
  const main = app.bots.find((bot) => bot.kind === 'main');
  const projects = app.bots.filter((bot) => bot.kind === 'project');
  const working = projects.filter((bot) => activity(bot).working);
  const ordered = [...working, ...projects.filter((bot) => !activity(bot).working)];
  const total = usageLine(main?.status.usage, true);

  return (
    <div className="panel-body" data-testid="team-panel">
      <div className="panel-head">
        <h2>Project bots</h2>
        <span className="muted">{working.length ? `${working.length} working` : 'all idle'}</span>
      </div>
      {projects.length === 0 ? (
        <p className="muted pad">Project bots appear here with what they are working on.</p>
      ) : (
        <ul className="team-list">
          {ordered.map((bot) => {
            const now = activity(bot);
            const used = usageLine(bot.status.usage, false);
            return (
              <li key={bot.id}>
                <button
                  type="button"
                  className={`team-item${now.working ? ' working' : ''}`}
                  data-testid="team-item"
                  onClick={() => app.select(bot.id)}
                  title={`Open ${bot.name}`}
                >
                  <span className="team-top">
                    <span className="team-name">{bot.name}</span>
                    {bot.status.needsYou > 0 && (
                      <span className="badge needs" title={`${bot.status.needsYou} waiting for you`}>
                        {bot.status.needsYou}
                      </span>
                    )}
                  </span>
                  <span className={`team-activity${now.working ? ' working' : ''}`}>
                    {now.working && <span className="spinner" aria-hidden="true" />}
                    {now.text}
                  </span>
                  <span className="task-meta">
                    <span>{folderLabel(bot)}</span>
                    {used && <span title="The agents' own estimate at API prices">{used}</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {total && (
        <p className="panel-foot muted" title="The agents' own estimate at API prices; a subscription is not billed per call">
          Used so far: {total}
        </p>
      )}
    </div>
  );
}
