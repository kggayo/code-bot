import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BotView, ClosedData, CoreEvent, InboundData, SurfacedData, TurnEndData } from '../../../../shared/types.ts';
import { api } from '../api.ts';
import { basename, describeTool } from '../format.ts';
import { useAppState } from '../state.ts';
import { Composer } from './Composer.tsx';
import { ConversationMenu } from './ConversationMenu.tsx';
import { RequestCard } from './RequestCard.tsx';
import { MarkdownText, RichText, TaskChip } from './Text.tsx';

/** Keeps a log scrolled to the bottom while new content arrives, unless the reader scrolled up. */
export function useStickToBottom(dependency: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const onScroll = () => {
      pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    };
    element.addEventListener('scroll', onScroll);
    return () => element.removeEventListener('scroll', onScroll);
  }, []);
  useEffect(() => {
    const element = ref.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [dependency]);
  return ref;
}

const ThreadItem = memo(function ThreadItem({
  event,
  closed,
  openRequests,
}: {
  event: CoreEvent;
  closed: Map<string, ClosedData>;
  /** Open requests: id to whether it is held from before a restart. */
  openRequests: Map<string, boolean>;
}) {
  const data = event.data as Record<string, unknown>;
  switch (event.type) {
    case 'user.message':
      return <div className="msg user">{String(data.text)}</div>;
    case 'inbound': {
      const inbound = data as unknown as InboundData;
      if (inbound.from === 'subagent') {
        return (
          <div className="note">
            <RichText text={inbound.text} />
          </div>
        );
      }
      return (
        <div className={`msg inbound${inbound.from === 'project' ? ' report' : ''}`}>
          <div className="msg-label">{inbound.from === 'main' ? 'From the main bot' : `Report from ${inbound.name ?? 'a project bot'}`}</div>
          <MarkdownText text={inbound.text} />
        </div>
      );
    }
    case 'bot.text':
      return (
        <div className="msg bot">
          <MarkdownText text={String(data.text)} />
        </div>
      );
    case 'bot.tool': {
      const line = describeTool(String(data.name), data.input);
      return line ? (
        <div className="note tool">
          <RichText text={line} />
        </div>
      ) : null;
    }
    case 'subagent.started':
      return (
        <div className="note started">
          Started sub-agent <TaskChip id={String(data.taskId)} /> {String(data.title)}
        </div>
      );
    case 'request.surfaced': {
      const surfaced = data as unknown as SurfacedData;
      return (
        <RequestCard
          request={surfaced.request}
          open={openRequests.has(surfaced.request.id)}
          held={openRequests.get(surfaced.request.id)}
          closed={closed.get(surfaced.request.id)}
          botName={surfaced.botName}
          taskTitle={surfaced.taskTitle}
        />
      );
    }
    case 'turn.end': {
      const end = data as unknown as TurnEndData;
      if (!end.ok && end.error) return <div className="note error">Could not reply: {end.error}</div>;
      if (end.forwardedTo === 'main') return <div className="note">Reply passed on to the main bot</div>;
      return null;
    }
    case 'thread.reset':
      return <div className="divider">New conversation</div>;
    default:
      return null;
  }
});

function EmptyState({ bot }: { bot: BotView }) {
  const app = useAppState();
  if (bot.kind === 'main') {
    const projects = app.bots.filter((candidate) => candidate.kind === 'project');
    return (
      <div className="empty">
        <h2>Talk to your main bot</h2>
        {projects.length === 0 ? (
          <>
            <p>It routes your requests to project bots. Start by adding a project bot for a project folder.</p>
            <button type="button" className="primary" onClick={() => app.openEditor({ mode: 'create' })}>
              New project bot
            </button>
          </>
        ) : (
          <p>
            Say what you need and which project it is for, for example "fix the login bug in {projects[0]?.name}". It hands the work to
            that project's bot and reports back here.
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="empty">
      <h2>{bot.name}</h2>
      <p>
        This bot is the team lead for its project. Describe the work; it plans it, starts sub-agents to do it and reports back here.
        Work the main bot sends it shows up here too.
      </p>
    </div>
  );
}

export function Conversation({ bot }: { bot: BotView }) {
  const app = useAppState();
  const [menu, setMenu] = useState(false);
  const closeMenu = useCallback(() => setMenu(false), []);
  const conversation = app.conversations.get(bot.id);
  const viewing = app.viewing?.botId === bot.id ? app.viewing.view : null;
  const events = viewing ? viewing.events : conversation?.events;
  const log = useStickToBottom(`${viewing?.threadId ?? ''}:${events?.length ?? 0}:${conversation?.live.length ?? 0}:${bot.status.busy}`);

  const closed = useMemo(() => {
    const map = new Map<string, ClosedData>();
    for (const event of events ?? []) {
      if (event.type === 'request.closed') {
        const data = event.data as ClosedData;
        map.set(data.requestId, data);
      }
    }
    return map;
  }, [events]);
  const openRequests = useMemo(
    () => new Map(app.requests.map((request) => [request.id, Boolean(request.held)] as const)),
    [app.requests],
  );

  const subtitle =
    bot.kind === 'main'
      ? 'Your manager: routes requests to project bots and reports back'
      : bot.folders.map((folder) => basename(folder)).join(' · ');

  return (
    <section className="conversation" aria-label={`Conversation with ${bot.name}`}>
      <header className="conv-head">
        <div className="conv-title">
          <h1>{bot.name}</h1>
          <p title={bot.folders.join('\n')}>{subtitle}</p>
        </div>
        <div className="conv-actions">
          {bot.status.busy && (
            <button type="button" onClick={() => void api.stopBot(bot.id)}>
              Stop
            </button>
          )}
          <span className="menu-anchor">
            <button type="button" aria-expanded={menu} onClick={() => setMenu(!menu)} title="Earlier conversations with this bot">
              Conversations
            </button>
            {menu && <ConversationMenu bot={bot} onClose={closeMenu} />}
          </span>
          <button type="button" onClick={() => void app.newConversation(bot.id)} title="Start a fresh conversation; sub-agents keep working">
            New conversation
          </button>
          <button type="button" onClick={() => app.openEditor({ mode: 'edit', botId: bot.id })}>
            Settings
          </button>
        </div>
      </header>
      {viewing && (
        <div className="viewing-bar" data-testid="viewing-bar">
          <span>An earlier conversation, started {new Date(viewing.events[0]?.ts ?? Date.now()).toLocaleString()}. Read only.</span>
          <span className="spacer" />
          <button type="button" className="primary" onClick={() => void app.reopenConversation(bot.id, viewing.threadId)}>
            Continue this conversation
          </button>
          <button type="button" onClick={() => app.closeViewing()}>
            Back to current
          </button>
        </div>
      )}
      <div className="log" ref={log}>
        {!viewing && !conversation ? (
          <p className="muted pad">Loading…</p>
        ) : events && events.length > 0 ? (
          events.map((event) => <ThreadItem key={event.seq} event={event} closed={closed} openRequests={openRequests} />)
        ) : (
          <EmptyState bot={bot} />
        )}
        {!viewing && conversation?.live && (
          <div className="msg bot live">
            <MarkdownText text={conversation.live} />
          </div>
        )}
        {!viewing && bot.status.busy && !conversation?.live && (
          <div className="typing" aria-live="polite">
            <span className="spinner" /> {bot.name} is working…
          </div>
        )}
      </div>
      {!viewing && (
        <Composer
        testId="composer"
        label={`Message to ${bot.name}`}
        placeholder={bot.kind === 'main' ? 'Tell the main bot what you need…' : `Tell ${bot.name} what to do…`}
        onSend={(text) => app.send(bot.id, text)}
        />
      )}
    </section>
  );
}
