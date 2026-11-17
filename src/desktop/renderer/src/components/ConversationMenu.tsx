import { useEffect, useRef, useState } from 'react';
import type { BotView, ConversationSummary } from '../../../../shared/types.ts';
import { api } from '../api.ts';
import { ago } from '../format.ts';
import { useAppState } from '../state.ts';

/** A bot's conversations: open an earlier one to read it, archive old ones. */
export function ConversationMenu({ bot, onClose }: { bot: BotView; onClose(): void }) {
  const app = useAppState();
  const [archived, setArchived] = useState(false);
  const [items, setItems] = useState<ConversationSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const version = app.conversationsVersion;

  useEffect(() => {
    let live = true;
    api
      .listConversations(bot.id, { archived })
      .then((list) => live && setItems(list))
      .catch((failure) => live && setError(failure instanceof Error ? failure.message : String(failure)));
    return () => {
      live = false;
    };
  }, [bot.id, archived, version]);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const toggleArchived = async (conversation: ConversationSummary) => {
    setError(null);
    try {
      await api.setConversationArchived(bot.id, conversation.threadId, !archived);
      setItems((current) => current?.filter((item) => item.threadId !== conversation.threadId) ?? null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  return (
    <div className="popover" ref={ref} role="dialog" aria-label={`Conversations with ${bot.name}`} data-testid="conversation-menu">
      <div className="popover-head">
        <strong>Conversations</strong>
        <label className="check">
          <input type="checkbox" checked={archived} onChange={(event) => setArchived(event.target.checked)} /> Archived
        </label>
      </div>
      {error && <p className="form-error">{error}</p>}
      {!items ? (
        <p className="muted pad">Loading…</p>
      ) : items.length === 0 ? (
        <p className="muted pad">{archived ? 'No archived conversations.' : 'No conversations yet.'}</p>
      ) : (
        <ul className="conversation-list">
          {items.map((conversation) => (
            <li key={conversation.threadId}>
              <button
                type="button"
                className="conversation-item"
                data-testid="conversation-item"
                onClick={() => {
                  onClose();
                  void app.viewConversation(bot.id, conversation.threadId);
                }}
              >
                <span className="conversation-title">{conversation.title}</span>
                <span className="task-meta">
                  {conversation.current && <span className="current-tag">current</span>}
                  <span>{ago(conversation.lastActivity)}</span>
                  <span>{conversation.messages} messages</span>
                </span>
              </button>
              {!conversation.current && (
                <button type="button" className="link" onClick={() => void toggleArchived(conversation)}>
                  {archived ? 'Unarchive' : 'Archive'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
