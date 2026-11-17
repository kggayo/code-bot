import { useState } from 'react';
import type { ClosedData, PendingRequest } from '../../../../shared/types.ts';
import { state } from '../state.ts';
import { TaskChip } from './Text.tsx';

interface Question {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: { label: string; description?: string }[];
}

interface RequestCardProps {
  request: PendingRequest;
  /** Whether the sub-agent is still waiting on it. */
  open: boolean;
  /** The sub-agent stopped when code-bot closed; answering resumes it. */
  held?: boolean;
  closed?: ClosedData;
  botName?: string;
  taskTitle?: string;
}

/** What an approval is for: a command as plain text (not JSON-escaped), then any other fields. */
function inputText(input: unknown): string {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const { command, ...rest } = input as Record<string, unknown>;
    if (typeof command === 'string') {
      return Object.keys(rest).length > 0 ? `${command}\n\n${JSON.stringify(rest, null, 2)}` : command;
    }
  }
  return JSON.stringify(input, null, 2);
}

function outcome(request: PendingRequest, closed: ClosedData | undefined, botName: string | undefined): string {
  if (!closed) return 'No longer waiting.';
  if (closed.by === 'bot') return `Answered by ${botName ?? 'the project'} bot.`;
  if (closed.by === 'system' || closed.decision === 'withdrawn') return 'No longer needed: the sub-agent stopped.';
  if (request.kind === 'permission') return closed.decision === 'allow' ? 'You allowed it.' : 'You denied it.';
  return closed.decision === 'allow' ? 'You answered.' : 'You skipped it.';
}

/** A sub-agent's question or approval request, answerable in place. */
export function RequestCard({ request, open, held, closed, botName, taskTitle }: RequestCardProps) {
  const questions: Question[] =
    request.kind === 'question' && Array.isArray((request.input as { questions?: unknown })?.questions)
      ? ((request.input as { questions: Question[] }).questions ?? [])
      : [];
  const [picks, setPicks] = useState<string[][]>(() => questions.map(() => []));
  const [typed, setTyped] = useState<string[]>(() => questions.map(() => ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const answer = async (response: Parameters<typeof state.respond>[2]) => {
    setBusy(true);
    setError(null);
    try {
      await state.respond(request.taskId, request.id, response);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setBusy(false);
    }
  };

  const toggle = (index: number, label: string, multi: boolean) => {
    setPicks((current) =>
      current.map((chosen, i) => {
        if (i !== index) return chosen;
        if (chosen.includes(label)) return chosen.filter((item) => item !== label);
        return multi ? [...chosen, label] : [label];
      }),
    );
  };

  const submit = () => {
    const answers: Record<string, string> = {};
    for (const [index, question] of questions.entries()) {
      const value = typed[index]?.trim() || (picks[index] ?? []).join(', ');
      if (!value) {
        setError('Pick an option or type an answer for each question.');
        return;
      }
      answers[question.question] = value;
    }
    void answer({ decision: 'allow', answers });
  };

  const disabled = !open || busy;
  const heading = request.kind === 'question' ? 'Question' : 'Approval needed';

  return (
    <div className={`request-card${open ? '' : ' closed'}`} data-kind={request.kind}>
      <div className="request-head">
        <span className="request-kind">{heading}</span>
        <span className="request-from">
          {botName && <span>{botName} · </span>}
          <TaskChip id={request.taskId} />
          {taskTitle && <span className="request-title"> {taskTitle}</span>}
        </span>
      </div>

      {questions.length > 0 ? (
        questions.map((question, index) => (
          <fieldset key={question.question} className="question" disabled={disabled}>
            <legend>{question.question}</legend>
            <div className="options">
              {(question.options ?? []).map((option) => (
                <button
                  key={option.label}
                  type="button"
                  className="option"
                  aria-pressed={(picks[index] ?? []).includes(option.label)}
                  onClick={() => toggle(index, option.label, question.multiSelect === true)}
                >
                  <span>{option.label}</span>
                  {option.description && <small>{option.description}</small>}
                </button>
              ))}
            </div>
            <input
              type="text"
              placeholder="Or type your own answer"
              aria-label="Your own answer"
              value={typed[index] ?? ''}
              onChange={(event) => setTyped((current) => current.map((item, i) => (i === index ? event.target.value : item)))}
            />
          </fieldset>
        ))
      ) : (
        <>
          <div className="request-what">
            <strong>{request.tool}</strong>
            {request.summary && <span> · {request.summary}</span>}
          </div>
          <pre className="request-input">{inputText(request.input)}</pre>
        </>
      )}

      {open && held && (
        <p className="held-note">code-bot was closed while this waited. Answering resumes the sub-agent with your answer.</p>
      )}
      {error && <p className="request-error" role="alert">{error}</p>}
      {open ? (
        <div className="request-actions">
          {request.kind === 'question' && questions.length > 0 ? (
            <>
              <button type="button" className="primary" disabled={disabled} onClick={submit}>
                Send answer
              </button>
              <button
                type="button"
                disabled={disabled}
                onClick={() => void answer({ decision: 'deny', message: 'The user skipped this question; use your own judgement.' })}
              >
                Skip
              </button>
            </>
          ) : (
            <>
              <button type="button" className="primary" disabled={disabled} onClick={() => void answer({ decision: 'allow' })}>
                Allow
              </button>
              <button type="button" disabled={disabled} onClick={() => void answer({ decision: 'deny' })}>
                Deny
              </button>
            </>
          )}
        </div>
      ) : (
        <p className="request-outcome">{outcome(request, closed, botName)}</p>
      )}
    </div>
  );
}
