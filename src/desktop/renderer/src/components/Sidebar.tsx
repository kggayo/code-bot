import type { BotView } from '../../../../shared/types.ts';
import { describeSchedule, folderLabel, until, when } from '../format.ts';
import { useAppState } from '../state.ts';
import { UsageMeter } from './Usage.tsx';

const UPCOMING = 4;

function initials(name: string): string {
  const words = name.split(/[\s._-]+/).filter(Boolean);
  return ((words[0]?.[0] ?? '') + (words[1]?.[0] ?? '')).toUpperCase() || '?';
}

function BotItem({ bot, subtitle }: { bot: BotView; subtitle: string }) {
  const app = useAppState();
  const selected = app.selectedBotId === bot.id;
  const { needsYou, busy } = bot.status;
  const main = bot.kind === 'main';
  // The main bot counts the project bots at work for it, not their sub-agents.
  const team = main ? app.bots.filter((other) => other.kind === 'project' && (other.status.busy || other.status.activeSubagents > 0)).length : 0;
  const activeSubagents = main ? team : bot.status.activeSubagents;
  const what = main ? 'project bot(s) working' : 'sub-agent(s) working';
  const working = busy || (!main && activeSubagents > 0);
  const status = busy ? 'Thinking' : activeSubagents > 0 ? `${activeSubagents} ${what}` : '';
  return (
    <button
      type="button"
      className={`bot-item${selected ? ' selected' : ''}${working ? ' working' : ''}`}
      data-testid={bot.kind === 'main' ? 'bot-main' : `bot-${bot.name}`}
      aria-current={selected ? 'page' : undefined}
      onClick={() => app.select(bot.id)}
      title={status || undefined}
    >
      <span className={`avatar${bot.kind === 'main' ? ' main' : ''}`} aria-hidden="true">
        {bot.kind === 'main' ? '★' : initials(bot.name)}
        {working && <span className="avatar-ring" />}
      </span>
      <span className="bot-text">
        <span className="bot-name">{bot.name}</span>
        <span className="bot-sub">{busy ? 'Thinking…' : subtitle}</span>
      </span>
      <span className="bot-badges">
        {needsYou > 0 && (
          <span className="badge needs" title={`${needsYou} waiting for you`}>
            {needsYou}
          </span>
        )}
        {activeSubagents > 0 && (
          <span className="badge working" title={`${activeSubagents} ${what}`} data-testid="working-badge">
            <span className="spinner tiny" aria-hidden="true" />
            {activeSubagents}
          </span>
        )}
        {busy && activeSubagents === 0 && <span className="spinner" title="Thinking" />}
        {!selected && app.unread.has(bot.id) && <span className="unread" title="New messages" />}
      </span>
    </button>
  );
}

/** The next routines to run, soonest first. */
function Upcoming() {
  const app = useAppState();
  const next = app.routines.filter((routine) => routine.enabled && routine.nextRunAt).slice(0, UPCOMING);
  return (
    <>
      <div className="section-label with-action">
        <span>Routines</span>
        <button type="button" className="link small" data-testid="open-routines" onClick={() => app.openRoutines({ botId: null })}>
          {app.routines.length ? 'All' : '+ New'}
        </button>
      </div>
      {next.length === 0 ? (
        <p className="sidebar-empty">{app.routines.length ? 'Nothing scheduled.' : 'Schedule messages to your bots.'}</p>
      ) : (
        <ul className="upcoming" data-testid="upcoming-routines">
          {next.map((routine) => (
            <li key={routine.id}>
              <button
                type="button"
                className="upcoming-item"
                onClick={() => app.openRoutines({ botId: null })}
                title={`${describeSchedule(routine.schedule)} · ${app.bot(routine.botId)?.name ?? ''}`}
              >
                <span className="upcoming-title">{routine.title}</span>
                <span className="upcoming-when">
                  {when(routine.nextRunAt)} <span className="muted">({until(routine.nextRunAt)})</span>
                </span>
                <span className="upcoming-bot">{app.bot(routine.botId)?.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function Sidebar() {
  const app = useAppState();
  const main = app.bots.find((bot) => bot.kind === 'main');
  const projects = app.bots.filter((bot) => bot.kind === 'project');
  return (
    <nav className="sidebar" aria-label="Bots">
      <div className="brand">
        <span>code-bot</span>
        {app.info?.fakeModels && (
          <span className="demo-tag" title="Scripted bots and mock sub-agents: no model usage">
            demo
          </span>
        )}
      </div>
      {main && <BotItem bot={main} subtitle="Your manager" />}
      <div className="section-label">Project bots</div>
      {projects.length === 0 && <p className="sidebar-empty">None yet. Add one for each project you work on.</p>}
      {projects.map((bot) => (
        <BotItem key={bot.id} bot={bot} subtitle={folderLabel(bot)} />
      ))}
      <button type="button" className="new-bot" onClick={() => app.openEditor({ mode: 'create' })}>
        + New project bot
      </button>
      <Upcoming />
      <span className="spacer" />
      <UsageMeter compact />
      {app.update?.available && (
        <button
          type="button"
          className="update-pill"
          data-testid="update-pill"
          onClick={() => app.openAppSettings(true)}
          title={`code-bot ${app.update.latest} is out; you have ${app.update.current}`}
        >
          ⬆ Update to {app.update.latest}
        </button>
      )}
      <button type="button" className="app-settings" data-testid="app-settings" onClick={() => app.openAppSettings(true)}>
        ⚙ Settings
      </button>
    </nav>
  );
}
