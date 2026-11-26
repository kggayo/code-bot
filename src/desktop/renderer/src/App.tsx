import { useCallback, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { AppSettingsDialog } from './components/AppSettings.tsx';
import { BotEditor } from './components/BotEditor.tsx';
import { Conversation } from './components/Conversation.tsx';
import { EngineBanner } from './components/EngineBanner.tsx';
import { Resizer } from './components/Resizer.tsx';
import { RoutinesDialog } from './components/Routines.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { SubagentList, TaskDetail } from './components/Subagents.tsx';
import { TeamPanel } from './components/Team.tsx';
import { useAppState } from './state.ts';

/** Pane widths in pixels: [smallest, largest, default]. The conversation keeps at least CENTER_MIN. */
const PANES = { left: [180, 480, 250], right: [260, 760, 340] } as const;
const CENTER_MIN = 380;
type Pane = keyof typeof PANES;

/** A remembered pane width (per window, in this browser profile), or the default. */
function stored(pane: Pane): number {
  const [min, max, fallback] = PANES[pane];
  try {
    const value = Number(localStorage.getItem(`code-bot.pane.${pane}`));
    return value >= min && value <= max ? value : fallback;
  } catch {
    return fallback;
  }
}

function remember(pane: Pane, value: number): void {
  try {
    localStorage.setItem(`code-bot.pane.${pane}`, String(Math.round(value)));
  } catch {
    // Not kept; the width still applies until the window closes.
  }
}

export function App() {
  const app = useAppState();
  const [left, setLeft] = useState(() => stored('left'));
  const [right, setRight] = useState(() => stored('right'));
  useEffect(() => {
    void app.init();
  }, [app]);

  /** Keeps the pane within its limits and leaves the conversation its room. */
  const resize = useCallback(
    (pane: Pane, wanted: number) => {
      const [min, max] = PANES[pane];
      const other = pane === 'left' ? right : left;
      const room = window.innerWidth - other - CENTER_MIN;
      const value = Math.round(Math.max(min, Math.min(max, room, wanted)));
      (pane === 'left' ? setLeft : setRight)(value);
      remember(pane, value);
    },
    [left, right],
  );

  if (app.fatal) {
    return (
      <div className="fatal" role="alert">
        <h1>code-bot could not start</h1>
        <p>{app.fatal}</p>
      </div>
    );
  }
  if (!app.ready) return <div className="starting">Starting code-bot…</div>;

  const bot = app.bot(app.selectedBotId) ?? app.bots[0];
  return (
    <div className="shell">
      <EngineBanner />
      <div className="app" style={{ '--left': `${left}px`, '--right': `${right}px` } as CSSProperties}>
        <Sidebar />
        <Resizer
          label="Resize the bot list"
          value={left}
          grows="right"
          onChange={(value) => resize('left', value)}
          onReset={() => resize('left', PANES.left[2])}
        />
        {bot ? <Conversation key={bot.id} bot={bot} /> : <section className="conversation" />}
        <Resizer
          label="Resize the side panel"
          value={right}
          grows="left"
          onChange={(value) => resize('right', value)}
          onReset={() => resize('right', PANES.right[2])}
        />
        <aside className="panel" aria-label={bot?.kind === 'main' ? 'Project bots' : 'Sub-agents'}>
          {app.openTaskId ? (
            <TaskDetail key={app.openTaskId} taskId={app.openTaskId} />
          ) : bot?.kind === 'main' ? (
            <TeamPanel />
          ) : (
            bot && <SubagentList bot={bot} />
          )}
        </aside>
      </div>
      {app.editor && <BotEditor key={app.editor.mode === 'edit' ? app.editor.botId : 'new'} editor={app.editor} />}
      {app.appSettingsOpen && <AppSettingsDialog />}
      {app.routinesOpen && <RoutinesDialog botId={app.routinesOpen.botId} />}
    </div>
  );
}
