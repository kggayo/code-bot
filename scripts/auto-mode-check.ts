// Tries Claude Code's "auto" permission mode with this machine's Claude login:
// a sub-agent writes a file and runs two harmless commands, and the script
// prints which of its tool calls still asked for approval. Uses model usage.
//
//   node scripts/auto-mode-check.ts [model]     (default model: haiku)
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeEngine } from '../src/core/engines/claude.ts';

const model = process.argv[2] ?? 'haiku';
// Canonical path: a Windows short name would make Claude Code ask even to read.
const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'code-bot-auto-')));
const asked: string[] = [];
const tools: string[] = [];
let ok = false;
let error = '';

const run = new ClaudeEngine().start(
  {
    cwd: dir,
    model,
    effort: 'low',
    permissionMode: 'auto',
    prompt:
      'Create a file notes.txt containing the line "auto mode works". Then run `git --version` and `node --version` with the Bash tool and report both outputs. Do not ask questions.',
  },
  async (request) => {
    asked.push(`${request.kind}: ${request.tool} ${JSON.stringify(request.input).slice(0, 100)}`);
    return { decision: 'allow' };
  },
);
for await (const event of run.events) {
  if (event.type === 'tool_use') tools.push(`${event.name} ${JSON.stringify(event.input).slice(0, 80)}`);
  if (event.type === 'session') console.log(`session on ${event.model ?? model}`);
  if (event.type === 'result') {
    ok = event.ok;
    error = event.error ?? '';
    console.log(`result: ${event.ok ? 'ok' : `failed: ${event.error}`}\n${event.text.slice(0, 400)}`);
  }
}
const written = existsSync(join(dir, 'notes.txt')) ? readFileSync(join(dir, 'notes.txt'), 'utf8').trim() : '(missing)';
console.log(`tool calls (${tools.length}):\n  ${tools.join('\n  ')}`);
console.log(`asked for approval (${asked.length}):\n  ${asked.join('\n  ') || '(none)'}`);
console.log(`notes.txt: ${written}`);
rmSync(dir, { recursive: true, force: true });
if (!ok) {
  console.log(`auto mode did not complete: ${error}`);
  process.exit(1);
}
