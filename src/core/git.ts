import { execFile } from 'node:child_process';

/**
 * Read-only git for project bots, so a team lead can look at what its
 * sub-agents changed without being able to change anything itself.
 */

export const GIT_SUBCOMMANDS = ['status', 'diff', 'log', 'show', 'branch', 'ls-files'] as const;

const ALLOWED = new Set<string>(GIT_SUBCOMMANDS);
/** `git branch` may only list. */
const BRANCH_ARGS = new Set(['--list', '-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose', '--show-current', '--no-color']);
/** Arguments that write files, read files outside the repository, or run configured programs. */
const FORBIDDEN = [/^--output(=|$)/, /^--no-index$/, /^--ext-diff$/, /^--textconv$/, /^--exec(=|$)/];
const OUTPUT_LIMIT = 30_000;

export function runGit(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  const [subcommand, ...rest] = args;
  if (!subcommand || !ALLOWED.has(subcommand)) {
    return Promise.reject(new Error(`Only these git commands are allowed: ${GIT_SUBCOMMANDS.join(', ')}`));
  }
  const forbidden = rest.find((arg) => FORBIDDEN.some((pattern) => pattern.test(arg)));
  if (forbidden) return Promise.reject(new Error(`The argument "${forbidden}" is not allowed`));
  if (subcommand === 'branch') {
    const other = rest.find((arg) => !BRANCH_ARGS.has(arg));
    if (other) return Promise.reject(new Error(`git branch may only list branches; "${other}" is not allowed`));
  }
  const safety = subcommand === 'diff' || subcommand === 'log' || subcommand === 'show' ? ['--no-ext-diff', '--no-textconv'] : [];
  const fullArgs = ['-c', 'core.fsmonitor=false', '-c', 'color.ui=never', '--no-pager', subcommand, ...safety, ...rest];

  return new Promise((resolve, reject) => {
    execFile(
      'git',
      fullArgs,
      {
        cwd,
        timeout: 20_000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        signal,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error((stderr || error.message).trim().slice(0, 2000)));
          return;
        }
        const output = stdout || '(no output)';
        resolve(output.length > OUTPUT_LIMIT ? `${output.slice(0, OUTPUT_LIMIT)}\n… (${output.length} chars in total, cut)` : output);
      },
    );
  });
}
