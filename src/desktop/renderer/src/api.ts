import type { CodeBotApi, CodeBotMethod } from '../../../shared/types.ts';

/** Electron prefixes errors thrown in the main process; show only the message itself. */
function cleanError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, ''));
}

/** The app's operations, called over IPC through the preload bridge. */
export const api = new Proxy({} as CodeBotApi, {
  get: (_target, method) => {
    // Not a promise: without this, `await api` would treat the proxy as a thenable.
    if (typeof method !== 'string' || method === 'then') return undefined;
    return (...args: unknown[]) =>
      window.codeBot.call(method as CodeBotMethod, args).catch((error: unknown) => {
        throw cleanError(error);
      });
  },
});
