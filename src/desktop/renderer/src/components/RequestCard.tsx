import { useState } from 'react';
import type { ClosedData, PendingRequest, UserResponse } from '../../../../shared/types.ts';
import { state } from '../state.ts';
import { RequestDetails, approvalTitle } from './RequestDetails.tsx';
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
  /** What this window sent, shown at once while the confirmation travels back. */
  const [sent, setSent] = useState<UserResponse | null>(null);

  const answer = async (response: UserResponse) => {
    setBusy(true);
    setError(null);
    try {
      await state.respond(request.taskId, request.id, response);
      setSent(response);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
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
        setError(`Pick an option or type an answer${questions.length > 1 ? ' for each question' : ''}.`);
        return;
      }
      answers[question.question] = value;
    }
    void answer({ decision: 'allow', answers });
  };

  const waiting = open && !sent;
  const disabled = !waiting || busy;
  const answers = closed?.answers ?? (sent?.decision === 'allow' ? sent.answers : undefined);
  const heading = request.kind === 'question' ? 'Question' : request.tool === 'ExitPlanMode' ? 'Plan to approve' : 'Approval needed';

  return (
    <div className={`request-card${waiting ? '' : ' closed'}`} data-kind={request.kind} data-testid="request-card">
      <div className="request-head">
        <span className="request-kind">{heading}</span>
        <span className="request-from">
          {botName && <span>{botName} · </span>}
          <TaskChip id={request.taskId} />
          {taskTitle && <span className="request-title"> {taskTitle}</span>}
        </span>
      </div>

      {questions.length > 0 ? (
        questions.map((question, index) =>
          waiting ? (
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
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    submit();
                  }
                }}
              />
            </fieldset>
          ) : (
            <div key={question.question} className="question answered">
              <p className="question-text">{question.question}</p>
              {answers?.[question.question] && (
                <p className="answer" data-testid="answer">
                  ✓ {answers[question.question]}
                </p>
              )}
            </div>
          ),
        )
      ) : (
        <>
          <div className="request-what">
            <strong>{approvalTitle(request)}</strong>
            {request.summary && <span className="muted"> · {request.summary}</span>}
          </div>
          <RequestDetails request={request} />
        </>
      )}

      {waiting && held && (
        <p className="held-note">code-bot was closed while this waited. Answering resumes the sub-agent with your answer.</p>
      )}
      {error && (
        <p className="request-error" role="alert">
          {error}
        </p>
      )}
      {waiting ? (
        <div className="request-actions">
          {request.kind === 'question' && questions.length > 0 ? (
            <>
              <button type="button" className="primary" disabled={disabled} onClick={submit}>
                {busy ? 'Sending…' : 'Send answer'}
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
                {busy ? 'Sending…' : request.tool === 'ExitPlanMode' ? 'Approve' : 'Allow'}
              </button>
              <button type="button" disabled={disabled} onClick={() => void answer({ decision: 'deny' })}>
                Deny
              </button>
            </>
          )}
        </div>
      ) : (
        <p className="request-outcome" data-testid="request-outcome">
          {closed || !sent ? outcome(request, closed, botName) : sent.decision === 'allow' ? 'Sent. The sub-agent carries on.' : 'Sent.'}
          {closed?.message && closed.by === 'user' && request.kind === 'permission' && <span className="muted"> ({closed.message})</span>}
        </p>
      )}
    </div>
  );
}
