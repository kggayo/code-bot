import { posix, win32 } from 'node:path';
import type { Store } from '../core/store.ts';
import { CODE_BOT_VERSION } from '../core/version.ts';
import type { BotInput, CodeBotApi, Effort, RoutineSchedule } from '../shared/types.ts';
import { MAIN_BOT_ID } from '../shared/types.ts';

/**
 * Moving bots between machines: `code-bot export` writes the project bots, the
 * main bot's own settings and the routines to a JSON file; `code-bot import`
 * creates them on another machine through its running core (so every value is
 * checked as if typed in the window), with project folders mapped to that
 * machine's paths. Conversations and sub-agents stay where they are: their
 * sessions live in that machine's Claude Code and Codex data.
 */

export interface ExportedRoutine {
  /** The project bot's name, or "main". */
  bot: string;
  title: string;
  prompt: string;
  schedule: RoutineSchedule;
  enabled: boolean;
}

export interface ExportFile {
  codeBot: string;
  exportedAt: string;
  platform: string;
  mainBot: { model: string | null; effort: Effort | null; instructions: string };
  bots: BotInput[];
  routines: ExportedRoutine[];
}

export function exportBots(store: Store, platform: string = process.platform): ExportFile {
  const bots = store.listBots();
  const names = new Map(bots.map((bot) => [bot.id, bot.kind === 'main' ? 'main' : bot.name]));
  const main = bots.find((bot) => bot.id === MAIN_BOT_ID);
  return {
    codeBot: CODE_BOT_VERSION,
    exportedAt: new Date().toISOString(),
    platform,
    mainBot: { model: main?.model ?? null, effort: main?.effort ?? null, instructions: main?.instructions ?? '' },
    bots: bots
      .filter((bot) => bot.kind === 'project')
      .map((bot) => ({
        name: bot.name,
        description: bot.description,
        folders: bot.folders,
        instructions: bot.instructions,
        model: bot.model,
        effort: bot.effort,
        subagents: bot.subagents,
      })),
    routines: store
      .listRoutines()
      .filter((routine) => names.has(routine.botId))
      .map((routine) => ({
        bot: names.get(routine.botId) ?? 'main',
        title: routine.title,
        prompt: routine.prompt,
        schedule: routine.schedule,
        enabled: routine.enabled,
      })),
  };
}

export function parseExport(text: string): ExportFile {
  let value: Partial<ExportFile>;
  try {
    value = JSON.parse(text) as Partial<ExportFile>;
  } catch {
    throw new Error('This is not a code-bot export (not JSON)');
  }
  if (!value || typeof value.codeBot !== 'string' || !Array.isArray(value.bots)) throw new Error('This is not a code-bot export');
  return {
    codeBot: value.codeBot,
    exportedAt: String(value.exportedAt ?? ''),
    platform: String(value.platform ?? ''),
    mainBot: value.mainBot ?? { model: null, effort: null, instructions: '' },
    bots: value.bots,
    routines: Array.isArray(value.routines) ? value.routines : [],
  };
}

export interface FolderMap {
  from: string;
  to: string;
}

/** "C:\src=/home/me/src" → { from: "C:\src", to: "/home/me/src" }. */
export function parseMap(value: string): FolderMap {
  const index = value.lastIndexOf('=');
  if (index <= 0 || index === value.length - 1) throw new Error(`Write a folder map as FROM=TO, e.g. "C:\\src=/home/me/src", not "${value}"`);
  return { from: value.slice(0, index), to: value.slice(index + 1) };
}

const slashes = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '');
const windowsPath = (path: string) => /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\');

/**
 * A folder from the other machine on this one: the longest matching FROM is
 * replaced by its TO (Windows paths compared without regard to case), and the
 * separators become this platform's.
 */
export function mapFolder(folder: string, maps: FolderMap[], platform: string = process.platform): string {
  const source = slashes(folder);
  const fold = windowsPath(folder);
  let best: FolderMap | undefined;
  for (const map of maps) {
    const from = slashes(map.from);
    const a = fold ? source.toLowerCase() : source;
    const b = fold ? from.toLowerCase() : from;
    if ((a === b || a.startsWith(`${b}/`)) && (!best || from.length > slashes(best.from).length)) best = map;
  }
  const mapped = best ? `${slashes(best.to)}${source.slice(slashes(best.from).length)}` : folder;
  return platform === 'win32' ? win32.normalize(mapped) : posix.normalize(mapped.replace(/\\/g, '/'));
}

export interface ImportLine {
  kind: 'bot' | 'routine' | 'main';
  name: string;
  outcome: 'created' | 'updated' | 'skipped' | 'would create' | 'would update';
  detail?: string;
}

/** Creates the exported bots and routines through a running core. With `check`, only reports what would happen. */
export async function importBots(
  api: CodeBotApi,
  file: ExportFile,
  options: { maps: FolderMap[]; check?: boolean; platform?: string },
): Promise<ImportLine[]> {
  const lines: ImportLine[] = [];
  const existing = await api.listBots();
  const ids = new Map<string, string>([['main', MAIN_BOT_ID]]);
  for (const bot of existing) if (bot.kind === 'project') ids.set(bot.name.toLowerCase(), bot.id);
  const created = new Set<string>();

  const main = file.mainBot;
  if (main.model || main.effort || main.instructions) {
    const detail = [main.model && `model ${main.model}`, main.effort && `effort ${main.effort}`, main.instructions && 'instructions']
      .filter(Boolean)
      .join(', ');
    if (!options.check) await api.updateBot(MAIN_BOT_ID, { model: main.model, effort: main.effort, instructions: main.instructions });
    lines.push({ kind: 'main', name: 'main bot', outcome: options.check ? 'would update' : 'updated', detail });
  }

  for (const bot of file.bots) {
    const folders = bot.folders.map((folder) => mapFolder(folder, options.maps, options.platform));
    if (ids.has(bot.name.toLowerCase())) {
      lines.push({ kind: 'bot', name: bot.name, outcome: 'skipped', detail: 'a bot with this name exists here' });
      continue;
    }
    const missing = (await api.checkFolders(folders)).filter((check) => !check.exists).map((check) => check.path);
    if (missing.length) {
      lines.push({ kind: 'bot', name: bot.name, outcome: 'skipped', detail: `missing here: ${missing.join(', ')} (map it with --map FROM=TO)` });
      continue;
    }
    if (options.check) {
      lines.push({ kind: 'bot', name: bot.name, outcome: 'would create', detail: folders.join(', ') });
      created.add(bot.name.toLowerCase());
      continue;
    }
    try {
      const view = await api.createBot({ ...bot, folders });
      ids.set(bot.name.toLowerCase(), view.id);
      created.add(bot.name.toLowerCase());
      lines.push({ kind: 'bot', name: bot.name, outcome: 'created', detail: folders.join(', ') });
    } catch (error) {
      lines.push({ kind: 'bot', name: bot.name, outcome: 'skipped', detail: (error as Error).message });
    }
  }

  for (const routine of file.routines) {
    const key = routine.bot.toLowerCase();
    const label = `${routine.title} (${routine.bot})`;
    if (key !== 'main' && !created.has(key)) {
      lines.push({ kind: 'routine', name: label, outcome: 'skipped', detail: 'its bot was not imported' });
      continue;
    }
    if (options.check) {
      lines.push({ kind: 'routine', name: label, outcome: 'would create' });
      continue;
    }
    const botId = ids.get(key);
    if (!botId) continue;
    try {
      await api.createRoutine({ botId, title: routine.title, prompt: routine.prompt, schedule: routine.schedule, enabled: routine.enabled });
      lines.push({ kind: 'routine', name: label, outcome: 'created' });
    } catch (error) {
      lines.push({ kind: 'routine', name: label, outcome: 'skipped', detail: (error as Error).message });
    }
  }
  return lines;
}
