import type { BotView } from '../../../../shared/types.ts';
import { folderLabel } from '../format.ts';
import { useAppState } from '../state.ts';

function initials(name: string): string {
  const words = name.split(/[\s._-]+/).filter(Boolean);
  return ((words[0]?.[0] ?? '') + (words[1]?.[0] ?? '')).toUpperCase() || '?';
}

function BotItem({ bot, subtitle }: { bot: BotView; subtitle: string }) {
  const app = useAppState();
  const selected = app.selectedBotId === bot.id;
  const { needsYou, activeSubagents, busy } = bot.status;
  return (
    <button
      type="button"
      className={`bot-item${selected ? ' selected' : ''}`}
      data-testid={bot.kind === 'main' ? 'bot-main' : `bot-${bot.name}`}
      aria-current={selected ? 'page' : undefined}
      onClick={() => app.select(bot.id)}
    >
      <span className={`avatar${bot.kind === 'main' ? ' main' : ''}`} aria-hidden="true">
        {bot.kind === 'main' ? '★' : initials(bot.name)}
      </span>
      <span className="bot-text">
        <span className="bot-name">{bot.name}</span>
        <span className="bot-sub">{subtitle}</span>
      </span>
      <span className="bot-badges">
        {needsYou > 0 && (
          <span className="badge needs" title={`${needsYou} waiting for you`}>
            {needsYou}
          </span>
        )}
        {activeSubagents > 0 && (
          <span className="badge working" title={`${activeSubagents} sub-agent(s) working`}>
            {activeSubagents}
          </span>
        )}
        {busy && <span className="spinner" title="Replying" />}
        {!selected && app.unread.has(bot.id) && <span className="unread" title="New messages" />}
      </span>
    </button>
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
      <span className="spacer" />
      <button type="button" className="app-settings" data-testid="app-settings" onClick={() => app.openAppSettings(true)}>
        ⚙ Settings
      </button>
    </nav>
  );
}
