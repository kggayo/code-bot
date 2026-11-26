import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, chmodSync, constants, createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { app, net, shell } from 'electron';
import type { UpdateInfo } from '../../shared/types.ts';

/**
 * Finds out whether a newer code-bot was released on GitHub and installs it.
 * Releases are built by .github/workflows/release.yml; each has the Windows
 * installer (code-bot-Setup-X.Y.Z.exe), the portable zip, the AppImage and the
 * deb. Every download is checked against the size and SHA-256 GitHub lists for
 * it before it is used.
 * - An installed Windows app downloads the installer, starts it and quits so it
 *   can replace the files.
 * - An AppImage downloads the new AppImage next to itself, puts it in place of
 *   the running file (which stays mounted until code-bot quits) and restarts
 *   into it, or starts it the next time.
 * - Everywhere else the release page is opened.
 */

const REPOSITORY = 'kggayo/code-bot';
const LATEST = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const CHECK_TIMEOUT_MS = 15_000;

interface Asset {
  name: string;
  url: string;
  size: number;
  /** "sha256:…", when GitHub lists it. */
  digest: string | null;
}

export interface UpdaterDeps {
  /** Something changed: the window shows it. */
  changed(info: UpdateInfo): void;
  /** Asks whether code-bot may quit now (it may have sub-agents working) and, if so, quits. */
  quitToInstall(): boolean;
  /** Asks the same, and if so quits and starts the program at execPath (the new AppImage). */
  restart(execPath: string): boolean;
}

/** -1, 0 or 1 for versions like "0.3.1" (pre-release suffixes are ignored). */
export function compareVersions(a: string, b: string): number {
  const parts = (version: string) => version.replace(/^v/, '').split('-')[0]!.split('.').map((part) => Number(part) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * Where to ask for the newest release. CODE_BOT_UPDATE_FEED points it at a local address instead,
 * for checking the update flow without publishing a release (scripts/appimage-update-check.ts);
 * anything but localhost is ignored.
 */
function feed(): string {
  const local = process.env.CODE_BOT_UPDATE_FEED;
  return local && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(local) ? local : LATEST;
}

/** The running AppImage, when code-bot is one and may replace it (its folder is writable). */
function appImage(): string | null {
  const path = process.env.APPIMAGE;
  if (process.platform !== 'linux' || !path || !existsSync(path)) return null;
  try {
    accessSync(dirname(path), constants.W_OK);
    return path;
  } catch {
    return null;
  }
}

/** How this copy of code-bot can be updated, and why when it must be done by hand. */
function method(): Pick<UpdateInfo, 'method' | 'methodNote'> {
  if (!app.isPackaged) {
    return { method: 'manual', methodNote: 'This code-bot runs from source: pull the new version, then npm install and npm run code-bot.' };
  }
  if (process.platform === 'win32') {
    // The NSIS installer leaves its uninstaller next to the app; the portable zip has none.
    const installed = existsSync(join(dirname(process.execPath), `Uninstall ${app.getName()}.exe`));
    return installed
      ? { method: 'installer', methodNote: null }
      : { method: 'manual', methodNote: 'This is the portable zip: download the new zip from the release page and unpack it over this folder.' };
  }
  if (process.platform === 'linux') {
    if (appImage()) return { method: 'appimage', methodNote: null };
    return process.env.APPIMAGE
      ? { method: 'manual', methodNote: "This AppImage's folder cannot be written to: download the new AppImage from the release page." }
      : {
          method: 'manual',
          methodNote: 'Installed from the .deb: download the new .deb from the release page and install it with sudo apt install ./<file>.deb.',
        };
  }
  return { method: 'manual', methodNote: 'Download the new version from the release page.' };
}

/** The release file this copy installs itself from, by method. */
function assetName(how: UpdateInfo['method'], version: string): string | null {
  if (how === 'installer') return `${app.getName()}-Setup-${version}.exe`;
  if (how === 'appimage') return `${app.getName()}-${version}.AppImage`;
  return null;
}

export class Updater {
  private readonly deps: UpdaterDeps;
  private info: UpdateInfo;
  private asset: Asset | null = null;
  private checking: Promise<UpdateInfo> | undefined;
  private installing = false;

  constructor(deps: UpdaterDeps) {
    this.deps = deps;
    this.info = {
      current: app.getVersion(),
      latest: null,
      available: false,
      ...method(),
      installed: null,
      url: `https://github.com/${REPOSITORY}/releases`,
      notes: null,
      checkedAt: null,
      downloadPercent: null,
      error: null,
    };
  }

  get(): UpdateInfo {
    return { ...this.info };
  }

  /** Asks GitHub for the newest release. Never throws: a failure is kept in `error`. */
  check(): Promise<UpdateInfo> {
    if (this.checking) return this.checking;
    this.checking = this.fetchLatest()
      .then((release) => {
        const latest = String(release.tag_name ?? '').replace(/^v/, '');
        const assets = Array.isArray(release.assets) ? (release.assets as Record<string, unknown>[]) : [];
        const how = method();
        const wanted = assetName(how.method, latest);
        const found = wanted ? assets.find((asset) => asset.name === wanted) : undefined;
        this.asset = found
          ? {
              name: String(found.name),
              url: String(found.browser_download_url),
              size: Number(found.size) || 0,
              digest: typeof found.digest === 'string' ? found.digest : null,
            }
          : null;
        const available = Boolean(latest) && compareVersions(latest, this.info.current) > 0;
        this.update({
          latest: latest || null,
          available,
          ...(how.method !== 'manual' && !this.asset
            ? { method: 'manual', methodNote: `This release has no ${how.method === 'installer' ? 'Windows installer' : 'AppImage'}: download it from the release page.` }
            : how),
          url: typeof release.html_url === 'string' ? release.html_url : this.info.url,
          notes: typeof release.body === 'string' ? release.body.slice(0, 20_000) : null,
          checkedAt: new Date().toISOString(),
          error: null,
        });
        return this.get();
      })
      .catch((error: unknown) => {
        this.update({ checkedAt: new Date().toISOString(), error: `Could not check for updates: ${error instanceof Error ? error.message : String(error)}` });
        return this.get();
      })
      .finally(() => {
        this.checking = undefined;
      });
    return this.checking;
  }

  /** Installs the newest release: runs its installer, replaces the AppImage, or opens the release page. */
  async install(): Promise<void> {
    if (!this.info.checkedAt) await this.check();
    if (!this.info.available) throw new Error(`code-bot ${this.info.current} is the newest version`);
    if (this.info.method === 'manual' || !this.asset) {
      await shell.openExternal(this.info.url ?? `https://github.com/${REPOSITORY}/releases`);
      return;
    }
    if (this.installing) throw new Error('The update is already downloading');
    this.installing = true;
    try {
      if (this.info.method === 'appimage') {
        await this.installAppImage(this.asset);
        return;
      }
      const file = await this.download(this.asset, join(app.getPath('temp'), 'code-bot-update'), this.asset.name);
      if (!this.deps.quitToInstall()) {
        this.update({ downloadPercent: null, error: 'Not installed: code-bot was not closed. Try again when the sub-agents are done.' });
        return;
      }
      // The installer replaces the app's files, so it runs on its own while code-bot quits.
      spawn(file, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    } catch (error) {
      this.update({ downloadPercent: null, error: `The update failed: ${error instanceof Error ? error.message : String(error)}` });
      throw error;
    } finally {
      this.installing = false;
    }
  }

  /**
   * Downloads the new AppImage next to the running one and renames it over it. The running copy
   * keeps working (it is mounted from the old file) until code-bot restarts into the new one.
   */
  private async installAppImage(asset: Asset): Promise<void> {
    const target = appImage();
    if (!target) throw new Error('this AppImage cannot be replaced; download the new one from the release page');
    if (this.info.installed !== this.info.latest) {
      const file = await this.download(asset, dirname(target), `.${basename(target)}.download`);
      chmodSync(file, 0o755);
      renameSync(file, target);
      this.update({ installed: this.info.latest, downloadPercent: null });
    }
    if (!this.deps.restart(target)) {
      this.update({ error: null, methodNote: `code-bot ${this.info.latest} is in place: it starts the next time you open code-bot.` });
    }
  }

  private async fetchLatest(): Promise<Record<string, unknown>> {
    const response = await net.fetch(feed(), {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `code-bot/${this.info.current}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (response.status === 404) throw new Error('no release has been published yet');
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    return (await response.json()) as Record<string, unknown>;
  }

  /** Downloads a release file into `folder` as `name` and checks it. Returns its path. */
  private async download(asset: Asset, folder: string, name: string): Promise<string> {
    mkdirSync(folder, { recursive: true });
    const file = join(folder, name);
    rmSync(file, { force: true });
    this.update({ downloadPercent: 0, error: null });
    const response = await net.fetch(asset.url, { headers: { 'User-Agent': `code-bot/${this.info.current}` } });
    if (!response.ok || !response.body) throw new Error(`the download failed (${response.status})`);
    const total = asset.size || Number(response.headers.get('content-length')) || 0;
    const hash = createHash('sha256');
    const out = createWriteStream(file);
    let received = 0;
    let shownPercent = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        received += value.length;
        if (!out.write(value)) await new Promise<void>((resolve) => out.once('drain', resolve));
        const percent = total ? Math.floor((received / total) * 100) : 0;
        if (percent >= shownPercent + 2) {
          shownPercent = percent;
          this.update({ downloadPercent: Math.min(percent, 99) });
        }
      }
    } finally {
      await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => (error ? reject(error) : resolve())));
    }
    if (asset.size && received !== asset.size) {
      rmSync(file, { force: true });
      throw new Error(`the download is incomplete (${received} of ${asset.size} bytes)`);
    }
    const digest = `sha256:${hash.digest('hex')}`;
    if (asset.digest && asset.digest.toLowerCase() !== digest) {
      rmSync(file, { force: true });
      throw new Error('the download does not match the checksum GitHub lists for it');
    }
    this.update({ downloadPercent: 100 });
    return file;
  }

  private update(patch: Partial<UpdateInfo>): void {
    this.info = { ...this.info, ...patch };
    this.deps.changed(this.get());
  }
}
