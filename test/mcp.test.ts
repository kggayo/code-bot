import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claudeMcpOptions } from '../src/core/engines/claude.ts';
import { codexMcpConfig } from '../src/core/engines/codex.ts';
import { cleanMcpServers, launchCommand, MAX_MCP_SERVERS } from '../src/core/mcp.ts';
import { projectBotPrompt } from '../src/core/prompts.ts';
import { joinCommandLine, splitCommandLine } from '../src/shared/command-line.ts';
import type { McpServer } from '../src/shared/types.ts';
import { idle, mockSubagents, setup, waitFor } from './helpers.ts';

const playwright: McpServer = { type: 'stdio', name: 'playwright', command: 'npx', args: ['@playwright/mcp@latest'], allowTools: true };
const docs: McpServer = { type: 'http', name: 'docs', url: 'https://docs.example.com/mcp', allowTools: false };

test('MCP servers in bot settings are checked and tidied', () => {
  assert.deepEqual(cleanMcpServers(undefined), []);
  assert.deepEqual(
    cleanMcpServers([
      { type: 'stdio', name: ' playwright ', command: ' npx ', args: ['@playwright/mcp@latest'], allowTools: true },
      { type: 'http', name: 'docs', url: 'https://docs.example.com/mcp' },
    ]),
    [
      { type: 'stdio', name: 'playwright', command: 'npx', args: ['@playwright/mcp@latest'], allowTools: true },
      { type: 'http', name: 'docs', url: 'https://docs.example.com/mcp', allowTools: false },
    ],
  );
  const refused = (value: unknown, pattern: RegExp) => assert.throws(() => cleanMcpServers(value), pattern);
  refused('playwright', /must be a list/);
  refused([{ type: 'stdio', name: '', command: 'x', args: [] }], /Give each MCP server a name/);
  refused([{ type: 'stdio', name: 'my server', command: 'x', args: [] }], /cannot be an MCP server name/);
  refused([{ type: 'stdio', name: 'a.b', command: 'x', args: [] }], /cannot be an MCP server name/);
  refused(
    [
      { type: 'stdio', name: 'Docs', command: 'x', args: [] },
      { type: 'http', name: 'docs', url: 'https://x.example' },
    ],
    /two MCP servers named "docs"/,
  );
  refused([{ type: 'stdio', name: 'x', command: '  ', args: [] }], /Give the command that starts the MCP server "x"/);
  refused([{ type: 'stdio', name: 'x', command: 'run\nme', args: [] }], /command of "x" is not valid/);
  refused([{ type: 'http', name: 'x', url: 'docs.example.com/mcp' }], /needs a full address/);
  refused([{ type: 'http', name: 'x', url: 'ftp://docs.example.com' }], /http:\/\/ or https:\/\//);
  refused([{ type: 'http', name: 'x', url: 'https://me:secret@docs.example.com' }], /does not keep credentials/);
  refused([{ name: 'x', command: 'npx' }], /a command or an address/);
  refused(
    Array.from({ length: MAX_MCP_SERVERS + 1 }, (_, i) => ({ type: 'stdio', name: `s${i}`, command: 'x', args: [] })),
    /at most 20 MCP servers/,
  );
});

test('on Windows, commands other than .exe and .com start through cmd /c', () => {
  assert.deepEqual(launchCommand('npx', ['-y', 'pkg'], 'win32'), { command: 'cmd.exe', args: ['/d', '/c', 'npx', '-y', 'pkg'] });
  assert.deepEqual(launchCommand('C:\\tools\\server.cmd', [], 'win32'), {
    command: 'cmd.exe',
    args: ['/d', '/c', 'C:\\tools\\server.cmd'],
  });
  assert.deepEqual(launchCommand('C:\\tools\\Server.EXE', ['--stdio'], 'win32'), { command: 'C:\\tools\\Server.EXE', args: ['--stdio'] });
  assert.deepEqual(launchCommand('npx', ['-y', 'pkg'], 'linux'), { command: 'npx', args: ['-y', 'pkg'] });
});

test('Claude Code sub-agents get the servers as SDK options, and allowed servers as allowedTools rules', () => {
  assert.deepEqual(claudeMcpOptions(undefined, 'acceptEdits'), {});
  assert.deepEqual(claudeMcpOptions([], 'acceptEdits'), {});
  assert.deepEqual(claudeMcpOptions([playwright, docs], 'acceptEdits', 'linux'), {
    mcpServers: {
      playwright: { type: 'stdio', command: 'npx', args: ['@playwright/mcp@latest'] },
      docs: { type: 'http', url: 'https://docs.example.com/mcp' },
    },
    allowedTools: ['mcp__playwright'],
  });
  // Plan mode promises a read-only run: every tool asks.
  const planned = claudeMcpOptions([playwright], 'plan', 'linux');
  assert.equal(planned.allowedTools, undefined);
  assert.deepEqual(claudeMcpOptions([playwright], 'default', 'win32').mcpServers, {
    playwright: { type: 'stdio', command: 'cmd.exe', args: ['/d', '/c', 'npx', '@playwright/mcp@latest'] },
  });
});

test('Codex sub-agents get one config override per server, added to their own servers', () => {
  assert.deepEqual(codexMcpConfig(undefined, 'acceptEdits'), {});
  assert.deepEqual(codexMcpConfig([playwright, docs], 'acceptEdits', 'linux'), {
    'mcp_servers.playwright': { command: 'npx', args: ['@playwright/mcp@latest'], default_tools_approval_mode: 'approve' },
    'mcp_servers.docs': { url: 'https://docs.example.com/mcp', default_tools_approval_mode: 'prompt' },
  });
  assert.deepEqual(codexMcpConfig([playwright], 'plan', 'win32'), {
    'mcp_servers.playwright': {
      command: 'cmd.exe',
      args: ['/d', '/c', 'npx', '@playwright/mcp@latest'],
      default_tools_approval_mode: 'prompt',
    },
  });
});

test('a command line is split into words, with quotes keeping spaces, and joined back', () => {
  assert.deepEqual(splitCommandLine('  npx   @playwright/mcp@latest  '), ['npx', '@playwright/mcp@latest']);
  assert.deepEqual(splitCommandLine('"C:\\Program Files\\tool\\mcp.exe" --root \'my folder\' ""'), [
    'C:\\Program Files\\tool\\mcp.exe',
    '--root',
    'my folder',
    '',
  ]);
  assert.deepEqual(splitCommandLine(''), []);
  const words = ['C:\\Program Files\\tool\\mcp.exe', '--name', 'say "hi"', ''];
  assert.equal(joinCommandLine(words), '"C:\\Program Files\\tool\\mcp.exe" --name \'say "hi"\' ""');
  assert.deepEqual(splitCommandLine(joinCommandLine(words)), words);
});

test("a project's MCP servers are saved, reach its sub-agents at every turn, and the lead knows them", async (t) => {
  const { core, brain, projectBot } = setup(t);
  assert.throws(
    () => projectBot('broken', { subagents: mockSubagents({ mcpServers: [{ ...docs, url: 'not an address' }] }) }),
    /needs a full address/,
  );
  const alpha = projectBot('alpha', { subagents: mockSubagents({ mcpServers: [playwright] }) });
  assert.deepEqual(core.bot(alpha.id).subagents.mcpServers, [playwright]);
  assert.match(projectBotPrompt(core.bot(alpha.id)), /MCP servers, set up by the user for this project: playwright \(its tools run without asking\)/);

  brain.overrides.set(alpha.id, async (input, tools) => {
    if (input.prompt.startsWith('go')) {
      const started = (await tools.call('start_subagent', { title: 'Check the page', brief: 'check the page' })) as { id: string };
      return `Started ${started.id}.`;
    }
    return 'Noted.';
  });
  core.sendToBot(alpha.id, 'go');
  const task = await waitFor(core, () => {
    const found = core.listTasks({ botId: alpha.id })[0];
    return found?.state === 'done' ? found : undefined;
  });
  assert.equal(task.lastResult, 'echo[default/default mcp:playwright]: check the page');
  await idle(core);

  // Changed settings reach the same sub-agent at its next turn; other settings keep its servers.
  core.updateBot(alpha.id, { subagents: { ...core.bot(alpha.id).subagents, mcpServers: [playwright, docs] } });
  core.updateBot(alpha.id, { description: 'Still the alpha project' });
  assert.deepEqual(core.bot(alpha.id).subagents.mcpServers, [playwright, docs]);
  core.sendToTask(task.id, 'check it again');
  await waitFor(core, () => core.getTask(task.id).task.lastResult?.includes('again') || undefined);
  assert.equal(core.getTask(task.id).task.lastResult, 'echo[default/default mcp:playwright,docs]: check it again');
  assert.match(projectBotPrompt(core.bot(alpha.id)), /playwright \(its tools run without asking\), docs\. You do not have them yourself/);
});
