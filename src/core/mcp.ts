/**
 * MCP servers a project gives its sub-agents (bot settings): checking what the user entered,
 * and how a server's program is started. Each engine turns the list into its own settings
 * (engines/claude.ts, engines/codex.ts); this file holds what they share.
 */
import type { McpServer } from '../shared/types.ts';
import { CodeBotError } from './util.ts';

export const MAX_MCP_SERVERS = 20;
const MAX_ARGS = 50;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

/** The servers as entered in bot settings, checked and tidied; throws a CodeBotError naming the problem. */
export function cleanMcpServers(value: unknown): McpServer[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new CodeBotError('invalid', 'MCP servers must be a list');
  if (value.length > MAX_MCP_SERVERS) throw new CodeBotError('invalid', `A project can have at most ${MAX_MCP_SERVERS} MCP servers`);
  const seen = new Set<string>();
  return value.map((entry): McpServer => {
    const raw = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
    const name = String(raw.name ?? '').trim();
    if (!name) throw new CodeBotError('invalid', 'Give each MCP server a name');
    if (!NAME_PATTERN.test(name)) {
      throw new CodeBotError(
        'invalid',
        `"${name}" cannot be an MCP server name: use up to 40 letters, digits, "_" and "-", starting with a letter or digit`,
      );
    }
    if (seen.has(name.toLowerCase())) throw new CodeBotError('invalid', `There are two MCP servers named "${name}"`);
    seen.add(name.toLowerCase());
    const allowTools = raw.allowTools === true;

    if (raw.type === 'http') {
      const text = String(raw.url ?? '').trim();
      let url: URL;
      try {
        url = new URL(text);
      } catch {
        throw new CodeBotError('invalid', `The MCP server "${name}" needs a full address, such as https://example.com/mcp`);
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new CodeBotError('invalid', `The MCP server "${name}" needs an http:// or https:// address`);
      }
      if (url.username || url.password) {
        throw new CodeBotError('invalid', `Leave the sign-in out of the address of "${name}": code-bot does not keep credentials`);
      }
      if (text.length > 2000) throw new CodeBotError('invalid', `The address of "${name}" is too long`);
      return { type: 'http', name, url: url.toString(), allowTools };
    }

    if (raw.type !== 'stdio') throw new CodeBotError('invalid', `Say how to reach the MCP server "${name}": a command or an address`);
    const command = String(raw.command ?? '').trim();
    if (!command) throw new CodeBotError('invalid', `Give the command that starts the MCP server "${name}"`);
    if (command.length > 1000 || CONTROL.test(command)) throw new CodeBotError('invalid', `The command of "${name}" is not valid`);
    const args = Array.isArray(raw.args) ? raw.args.map((arg) => String(arg ?? '')) : [];
    if (args.length > MAX_ARGS) throw new CodeBotError('invalid', `The command of "${name}" has more than ${MAX_ARGS} arguments`);
    if (args.some((arg) => arg.length > 2000 || CONTROL.test(arg))) {
      throw new CodeBotError('invalid', `An argument of "${name}" is not valid`);
    }
    return { type: 'stdio', name, command, args, allowTools };
  });
}

/**
 * How to start a server's program. On Windows, commands such as npx are batch files (npx.cmd)
 * that agents cannot start directly, so everything but an .exe or .com runs through cmd /c,
 * as Claude Code's own instructions for Windows say.
 */
export function launchCommand(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (platform !== 'win32' || /\.(exe|com)$/i.test(command)) return { command, args: [...args] };
  return { command: 'cmd.exe', args: ['/d', '/c', command, ...args] };
}

/** The servers whose tools may run without asking for a sub-agent in this permission mode. */
export function allowedServers(servers: readonly McpServer[], permissionMode: string | undefined): McpServer[] {
  // Plan mode promises a read-only run; a server's tools can change things, so they ask there.
  if (permissionMode === 'plan') return [];
  return servers.filter((server) => server.allowTools);
}
