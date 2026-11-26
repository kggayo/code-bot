import type { ReactNode } from 'react';
import type { PendingRequest } from '../../../../shared/types.ts';
import { basename } from '../format.ts';
import { MarkdownText } from './Text.tsx';

type Input = Record<string, unknown>;

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const records = (value: unknown): Input[] =>
  Array.isArray(value) ? value.filter((item): item is Input => Boolean(item) && typeof item === 'object' && !Array.isArray(item)) : [];

/** What the agent wants to do, in a few words, by tool. */
export function approvalTitle(request: PendingRequest): string {
  const input = (request.input ?? {}) as Input;
  switch (request.tool) {
    case 'ExitPlanMode':
      return 'Approve the plan';
    case 'Bash':
    case 'PowerShell':
    case 'shell':
      return 'Run a command';
    case 'Write':
      return `Write ${basename(str(input.file_path)) || 'a file'}`;
    case 'Edit':
    case 'MultiEdit':
      return `Edit ${basename(str(input.file_path)) || 'a file'}`;
    case 'NotebookEdit':
      return `Edit ${basename(str(input.notebook_path)) || 'a notebook'}`;
    case 'apply_patch': {
      const changes = records(input.changes);
      return changes.length === 1 ? `Change ${basename(str(changes[0]?.path))}` : `Change ${changes.length || 'some'} files`;
    }
    case 'WebFetch':
      return 'Open a web page';
    case 'WebSearch':
      return 'Search the web';
    case 'permissions':
      return 'More access than the sandbox allows';
    default:
      return request.tool.startsWith('mcp__') ? `Use ${request.tool.replace(/^mcp__/, '').replace(/__/g, ' · ')}` : `Use ${request.tool}`;
  }
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <span className="field-value">{children}</span>
    </div>
  );
}

function Code({ text, kind }: { text: string; kind?: 'diff' }) {
  if (kind !== 'diff') return <pre className="request-code">{text}</pre>;
  return (
    <pre className="request-code diff">
      {text.split('\n').map((line, index) => (
        <span
          key={index}
          className={line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : undefined}
        >
          {line}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}

/** An Edit as a small diff: the text it replaces, then the new text. */
function editDiff(oldText: string, newText: string): string {
  const lines = (text: string, mark: string) => (text ? text.split('\n').map((line) => `${mark} ${line}`) : []);
  return [...lines(oldText, '-'), ...lines(newText, '+')].join('\n');
}

/** Any other input: each field on its own line, long text and structures as blocks. */
function Fields({ input, skip = [] }: { input: Input; skip?: string[] }) {
  const entries = Object.entries(input).filter(([key, value]) => !skip.includes(key) && value !== undefined && value !== null && value !== '');
  if (entries.length === 0) return null;
  return (
    <div className="fields">
      {entries.map(([key, value]) => {
        const label = key.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
        if (typeof value === 'string') {
          return value.includes('\n') || value.length > 90 ? (
            <div key={key} className="field block">
              <span className="field-label">{label}</span>
              <Code text={value} />
            </div>
          ) : (
            <Field key={key} label={label}>
              <code>{value}</code>
            </Field>
          );
        }
        if (typeof value === 'number' || typeof value === 'boolean') {
          return (
            <Field key={key} label={label}>
              {String(value)}
            </Field>
          );
        }
        return (
          <div key={key} className="field block">
            <span className="field-label">{label}</span>
            <Code text={JSON.stringify(value, null, 2)} />
          </div>
        );
      })}
    </div>
  );
}

/** What an approval is for, laid out for the tool it is about rather than as raw JSON. */
export function RequestDetails({ request }: { request: PendingRequest }) {
  const input = (request.input && typeof request.input === 'object' ? request.input : { value: request.input }) as Input;
  switch (request.tool) {
    case 'ExitPlanMode':
      return (
        <div className="request-body">
          <div className="plan" data-testid="plan">
            <MarkdownText text={str(input.plan) || '(no plan text)'} />
          </div>
          {str(input.planFilePath) && <Field label="Plan file">{str(input.planFilePath)}</Field>}
        </div>
      );
    case 'Bash':
    case 'PowerShell':
    case 'shell':
      return (
        <div className="request-body">
          {str(input.description) && <p className="request-why">{str(input.description)}</p>}
          <Code text={str(input.command)} />
          <Fields input={input} skip={['command', 'description']} />
        </div>
      );
    case 'Write':
      return (
        <div className="request-body">
          <Field label="File">{str(input.file_path)}</Field>
          <Code text={str(input.content)} />
        </div>
      );
    case 'Edit':
      return (
        <div className="request-body">
          <Field label="File">{str(input.file_path)}</Field>
          <Code kind="diff" text={editDiff(str(input.old_string), str(input.new_string))} />
          {input.replace_all === true && <Field label="Replace">every occurrence</Field>}
        </div>
      );
    case 'MultiEdit':
      return (
        <div className="request-body">
          <Field label="File">{str(input.file_path)}</Field>
          {records(input.edits).map((edit, index) => (
            <Code key={index} kind="diff" text={editDiff(str(edit.old_string), str(edit.new_string))} />
          ))}
        </div>
      );
    case 'apply_patch':
      return (
        <div className="request-body">
          {records(input.changes).map((change, index) => (
            <div key={index} className="field block">
              <span className="field-label">
                {str(change.kind) || 'change'} · {str(change.path)}
              </span>
              {str(change.diff) && <Code kind="diff" text={str(change.diff)} />}
            </div>
          ))}
          <Fields input={input} skip={['changes', 'path']} />
        </div>
      );
    case 'WebFetch':
      return (
        <div className="request-body">
          <Field label="Page">
            <code>{str(input.url)}</code>
          </Field>
          <Fields input={input} skip={['url']} />
        </div>
      );
    default:
      return (
        <div className="request-body">
          <Fields input={input} />
        </div>
      );
  }
}
