import { randomBytes } from 'node:crypto';

export type ErrorCode = 'invalid' | 'not_found' | 'conflict' | 'busy';

/** An error meant for the person or bot that made the request. */
export class CodeBotError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'CodeBotError';
    this.code = code;
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(5).toString('hex')}`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function clip(text: string | null | undefined, limit: number): string {
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit)}… (${text.length} chars in total)` : text;
}

const STORED_STRING_LIMIT = 2000;

/** Keeps stored events small: long strings (file contents, command output) are cut at `limit` characters. */
export function truncate(value: unknown, depth = 0, limit = STORED_STRING_LIMIT): unknown {
  if (typeof value === 'string') {
    return value.length > limit ? `${value.slice(0, limit)}… (${value.length} chars)` : value;
  }
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => truncate(item, depth + 1, limit));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, truncate(v, depth + 1, limit)]));
}

export function titleFrom(prompt: string): string {
  const line = prompt.trim().split(/\r?\n/, 1)[0] ?? '';
  return line.length > 80 ? `${line.slice(0, 77)}…` : line || 'Untitled task';
}
