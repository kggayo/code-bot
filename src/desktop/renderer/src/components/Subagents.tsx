import { memo, useEffect, useMemo, useState } from 'react';
import { ACTIVE_STATES } from '../../../../shared/types.ts';
import type { BotView, ClosedData, CoreEvent, PendingRequest, Task } from '../../../../shared/types.ts';
import { api } from '../api.ts';
import { STATE_LABEL, ago, basename, describeAgentTool } from '../format.ts';
import { useAppState } from '../state.ts';
import { Composer } from './Composer.tsx';
import { useStickToBottom } from './Conversation.tsx';
import { RequestCard } from './RequestCard.tsx';
import { MarkdownText } from './Text.tsx';

function StatePill({ task }: { task: Task }) {
  return (
    <span className="state" data-state={task.state}>
      {STATE_LABEL[task.state]}
    </span>
  );
}

function settings(task: Task): string {
  return [task.model ?? 'default model', task.effort ? `${task.effort} effort` : null].filter(Boolean).join(' · ');
}

function money(value: number): string {
  return value >= 1 ? `$${value.toFixed(2)}` : `$${value.toFixed(3)}`;
}

function TaskList({ tasks, showBot }: { tasks: Task[]; showBot: boolean }) {
  const app = useAppState();
  return (
    <ul className="task-list">
      {tasks.map((task) => (
        <li key={task.id}>
          <button type="button" className="task-item" data-testid="subagent-item" onClick={() => app.openTask(task.id)}>
            <span className="task-top">
              <StatePill task={task} />
              <span className="task-when">{ago(task.updatedAt)}</span>
            </span>
            <span className="task-title">{task.title}</span>
            <span className="task-meta">
              {showBot && <span>{app.bot(task.botId)?.name ?? 'removed bot'}</span>}
              <span>{task.requestedBy === 'main' ? 'via main bot' : 'from you'}</span>
              <span>{settings(task)}</span>
              {task.worktree && <span title={task.worktree.branch}>own branch</span>}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The selected bot's sub-agents (for the main bot: everyone's), or its archived ones. */
export function SubagentList({ bot }: { bot: BotView }) {
  const app = useAppState();
  const [showArchived, setShowArchived] = useState(false);
  const [archived, setArchived] = useState<Task[] | null>(null);
  const tasks = bot.kind === 'main' ? app.tasks : app.tasks.filter((task) => task.botId === bot.id);
  const working = tasks.filter((task) => ACTIVE_STATES.includes(task.state)).length;
  const ordered = [...tasks].sort((a, b) => {
    const rank = (task: Task) => (task.state === 'waiting' ? 0 : task.state === 'running' ? 1 : 2);
    return rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt);
  });

  useEffect(() => {
    if (!showArchived) return;
    let live = true;
    setArchived(null);
    api
      .listTasks({ botId: bot.kind === 'main' ? undefined : bot.id, archived: true, limit: 200 })
      .then((list) => live && setArchived(list))
      .catch(() => live && setArchived([]));
    return () => {
      live = false;
    };
  }, [showArchived, bot.id, bot.kind, app.tasks]);

  return (
    <div className="panel-body">
      <div className="panel-head">
        <h2>{showArchived ? 'Archived sub-agents' : 'Sub-agents'}</h2>
        <span className="muted">{showArchived ? '' : working ? `${working} working` : 'none working'}</span>
      </div>
      <div className="panel-tools">
        <label className="check">
          <input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} /> Show archived
        </label>
      </div>
      {showArchived ? (
        !archived ? (
          <p className="muted pad">Loading…</p>
        ) : archived.length === 0 ? (
          <p className="muted pad">Nothing archived.</p>
        ) : (
          <TaskList tasks={archived} showBot={bot.kind === 'main'} />
        )
      ) : ordered.length === 0 ? (
        <p className="muted pad">
          {bot.kind === 'main'
            ? 'Sub-agents from every project appear here.'
            : `${bot.name} starts sub-agents when you give it work. You do not need to talk to them; ${bot.name} reports for them.`}
        </p>
      ) : (
        <TaskList tasks={ordered} showBot={bot.kind === 'main'} />
      )}
    </div>
  );
}

const TaskItem = memo(function TaskItem({
  event,
  open,
  closed,
  botName,
}: {
  event: CoreEvent;
  open: Map<string, boolean>;
  closed: Map<string, ClosedData>;
  botName: string;
}) {
  const data = event.data as Record<string, unknown>;
  switch (event.type) {
    case 'user.message':
      return (
        <div className={`msg ${data.from === 'user' ? 'user' : 'inbound'}`}>
          {data.from !== 'user' && <div className="msg-label">From {botName}</div>}
          {data.from === 'user' ? String(data.text) : <MarkdownText text={String(data.text)} />}
        </div>
      );
    case 'session':
      return <div className="note">Session started · {String(data.model ?? 'default model')}</div>;
    case 'text':
      return (
        <div className="msg bot">
          <MarkdownText text={String(data.text)} />
        </div>
      );
    case 'tool.use':
      return <div className="note tool">{describeAgentTool(String(data.name), data.input)}</div>;
    case 'tool.result':
      return data.isError ? <div className="note error">{String(data.preview)}</div> : null;
    case 'request': {
      const request = data as unknown as PendingRequest;
      return (
        <RequestCard
          request={request}
          open={open.has(request.id)}
          held={open.get(request.id)}
          closed={closed.get(request.id)}
          botName={botName}
        />
      );
    }
    case 'result':
      return !data.ok && data.error ? <div className="note error">{String(data.error)}</div> : null;
    case 'state':
      return <div className="note">— {STATE_LABEL[data.state as Task['state']] ?? String(data.state)} —</div>;
    case 'archived':
      return <div className="note">— archived —</div>;
    case 'unarchived':
      return <div className="note">— back from the archive —</div>;
    default:
      return null;
  }
});

/** One sub-agent's full history and what can be done with it. Optional: its project bot reports on it anyway. */
export function TaskDetail({ taskId }: { taskId: string }) {
  const app = useAppState();
  const log = app.taskLogs.get(taskId);
  const task = log?.task ?? app.tasks.find((candidate) => candidate.id === taskId);
  const events = log?.events;
  const scroller = useStickToBottom(`${events?.length ?? 0}:${log?.live.length ?? 0}`);
  const [error, setError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const open = useMemo(
    () =>
      new Map(
        app.requests.filter((request) => request.taskId === taskId).map((request) => [request.id, Boolean(request.held)] as const),
      ),
    [app.requests, taskId],
  );
  const closed = useMemo(() => {
    const map = new Map<string, ClosedData>();
    for (const event of events ?? []) {
      if (event.type !== 'request.resolved') continue;
      const data = event.data as { id: string; decision: ClosedData['decision']; by: ClosedData['by'] };
      map.set(data.id, { requestId: data.id, decision: data.decision, by: data.by });
    }
    return map;
  }, [events]);
  const botName = task ? (app.bot(task.botId)?.name ?? 'the project bot') : 'the project bot';
  const active = task ? ACTIVE_STATES.includes(task.state) : false;
  const engine = task ? app.engines.find((candidate) => candidate.id === task.engine) : undefined;
  const canResume = Boolean(task && !active && task.engineSessionId && engine?.canResume);

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      if (/uncommitted changes/.test(message)) setConfirmDiscard(true);
      setError(message);
    }
  };

  return (
    <div className="panel-body detail">
      <div className="panel-head">
        <button type="button" className="link" onClick={() => app.closeTask()}>
          ← Sub-agents
        </button>
        <span className="head-actions">
          {canResume && (
            <button
              type="button"
              data-testid="open-terminal"
              title="Continue this sub-agent's session yourself, in a terminal"
              onClick={() => void run(() => api.openInTerminal(taskId))}
            >
              Open in terminal
            </button>
          )}
          {task && !active && (
            <button
              type="button"
              data-testid="archive-task"
              onClick={() => void run(() => app.setTaskArchived(taskId, !task.archivedAt))}
            >
              {task.archivedAt ? 'Unarchive' : 'Archive'}
            </button>
          )}
          {active && (
            <button type="button" className="danger" onClick={() => void api.cancelTask(taskId)}>
              Stop
            </button>
          )}
        </span>
      </div>
      {task && (
        <div className="detail-head">
          <h2>{task.title}</h2>
          <div className="task-meta">
            <StatePill task={task} />
            <span>{taskId}</span>
            <span>{botName}</span>
            <span>{settings(task)}</span>
            {task.costUsd > 0 && <span title="The agent's own estimate for the whole session">{money(task.costUsd)} est.</span>}
            {task.maxBudgetUsd !== null && <span>budget {money(task.maxBudgetUsd)}</span>}
            {task.maxTurns !== null && <span>max {task.maxTurns} turns per run</span>}
          </div>
          {task.worktree ? (
            <div className="task-meta" data-testid="worktree-info">
              <span title={`From ${task.worktree.base} at ${task.worktree.baseCommit.slice(0, 10)}`}>branch {task.worktree.branch}</span>
              {task.worktree.removed ? (
                <span>worktree removed (it comes back if the sub-agent continues)</span>
              ) : (
                <button
                  type="button"
                  className="link folder"
                  title={task.worktree.path}
                  onClick={() => void api.openPath(task.worktree?.path ?? '').catch(() => undefined)}
                >
                  open worktree
                </button>
              )}
            </div>
          ) : (
            <button type="button" className="link folder" title={task.cwd} onClick={() => void api.openPath(task.cwd).catch(() => undefined)}>
              {basename(task.cwd)}
            </button>
          )}
          {error && (
            <div className="form-error" role="alert">
              {error}
              {confirmDiscard && (
                <span className="inline-actions">
                  <button
                    type="button"
                    className="danger"
                    onClick={() => {
                      setConfirmDiscard(false);
                      void run(() => app.setTaskArchived(taskId, true, true));
                    }}
                  >
                    Discard the changes and archive
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setConfirmDiscard(false);
                      setError(null);
                    }}
                  >
                    Keep it
                  </button>
                </span>
              )}
            </div>
          )}
        </div>
      )}
      <div className="log small" ref={scroller}>
        {!events ? (
          <p className="muted pad">Loading…</p>
        ) : (
          events.map((event) => <TaskItem key={event.seq} event={event} open={open} closed={closed} botName={botName} />)
        )}
        {log?.live && (
          <div className="msg bot live">
            <MarkdownText text={log.live} />
          </div>
        )}
      </div>
      <Composer
        label="Message to this sub-agent"
        placeholder={`Write to this sub-agent directly (usually ${botName} does)`}
        onSend={(text) => api.sendToTask(taskId, text)}
      />
    </div>
  );
}
