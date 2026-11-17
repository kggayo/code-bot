import { useEffect } from 'react';
import { AppSettingsDialog } from './components/AppSettings.tsx';
import { BotEditor } from './components/BotEditor.tsx';
import { Conversation } from './components/Conversation.tsx';
import { EngineBanner } from './components/EngineBanner.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { SubagentList, TaskDetail } from './components/Subagents.tsx';
import { useAppState } from './state.ts';

export function App() {
  const app = useAppState();
  useEffect(() => {
    void app.init();
  }, [app]);

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
      <div className="app">
        <Sidebar />
        {bot ? <Conversation key={bot.id} bot={bot} /> : <section className="conversation" />}
        <aside className="panel" aria-label="Sub-agents">
          {app.openTaskId ? (
            <TaskDetail key={app.openTaskId} taskId={app.openTaskId} />
          ) : (
            bot && <SubagentList bot={bot} />
          )}
        </aside>
      </div>
      {app.editor && <BotEditor key={app.editor.mode === 'edit' ? app.editor.botId : 'new'} editor={app.editor} />}
      {app.appSettingsOpen && <AppSettingsDialog />}
    </div>
  );
}
