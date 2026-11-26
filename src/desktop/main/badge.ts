import { crc32, deflateSync } from 'node:zlib';
import { app, nativeImage } from 'electron';
import type { BrowserWindow, NativeImage } from 'electron';

/**
 * The count of questions and approvals waiting for the user, on the app's
 * taskbar or dock icon: an overlay badge on Windows, the dock badge on macOS,
 * the launcher count on Linux (Unity and KDE). Windows draws overlays at 16
 * logical pixels, so the badge is drawn here pixel by pixel in three sizes
 * (crisp at 100 %, 150 % and 200 % scaling) instead of from a font.
 */

/** 3×5 pixel glyphs, '#' = ink. */
const GLYPHS: Record<string, string[]> = {
  '0': ['###', '#.#', '#.#', '#.#', '###'],
  '1': ['.#.', '##.', '.#.', '.#.', '###'],
  '2': ['###', '..#', '###', '#..', '###'],
  '3': ['###', '..#', '.##', '..#', '###'],
  '4': ['#.#', '#.#', '###', '..#', '..#'],
  '5': ['###', '#..', '###', '..#', '###'],
  '6': ['###', '#..', '###', '#.#', '###'],
  '7': ['###', '..#', '.#.', '.#.', '.#.'],
  '8': ['###', '#.#', '###', '#.#', '###'],
  '9': ['###', '#.#', '###', '..#', '###'],
  '+': ['...', '.#.', '###', '.#.', '...'],
};

const RED = [0xd9, 0x30, 0x25] as const;

/** A PNG of RGBA pixels (zlib from Node; no image library). */
function png(width: number, height: number, rgba: Buffer): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8); // bit depth
  header.writeUInt8(6, 9); // RGBA
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) rgba.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A red disc with the text in white, `size` pixels square. */
function drawBadge(size: number, text: string): Buffer {
  const pixels = Buffer.alloc(size * size * 4);
  const radius = size / 2;
  // The disc, smoothed by sampling each pixel 4×4 times.
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let inside = 0;
      for (let sy = 0; sy < 4; sy += 1) {
        for (let sx = 0; sx < 4; sx += 1) {
          const dx = x + (sx + 0.5) / 4 - radius;
          const dy = y + (sy + 0.5) / 4 - radius;
          if (dx * dx + dy * dy <= radius * radius) inside += 1;
        }
      }
      const at = (y * size + x) * 4;
      pixels[at] = RED[0];
      pixels[at + 1] = RED[1];
      pixels[at + 2] = RED[2];
      pixels[at + 3] = Math.round((inside / 16) * 255);
    }
  }
  // The text: whole-pixel glyphs at the largest scale that fits inside the disc.
  const glyphs = [...text].map((char) => GLYPHS[char] ?? GLYPHS['+']!);
  const columns = glyphs.length * 3 + (glyphs.length - 1);
  const room = Math.floor(size * 0.66);
  const scale = Math.max(1, Math.min(Math.floor(room / columns), Math.floor(room / 5)));
  const left = Math.floor((size - columns * scale) / 2);
  const top = Math.floor((size - 5 * scale) / 2);
  glyphs.forEach((glyph, index) => {
    const offset = left + index * 4 * scale;
    glyph.forEach((row, gy) => {
      [...row].forEach((cell, gx) => {
        if (cell !== '#') return;
        for (let py = 0; py < scale; py += 1) {
          for (let px = 0; px < scale; px += 1) {
            const at = ((top + gy * scale + py) * size + offset + gx * scale + px) * 4;
            pixels[at] = 255;
            pixels[at + 1] = 255;
            pixels[at + 2] = 255;
            pixels[at + 3] = 255;
          }
        }
      });
    });
  });
  return png(size, size, pixels);
}

const cache = new Map<string, NativeImage>();

function overlay(count: number): NativeImage {
  const text = count > 9 ? '9+' : String(count);
  let image = cache.get(text);
  if (!image) {
    image = nativeImage.createFromBuffer(drawBadge(16, text), { scaleFactor: 1 });
    image.addRepresentation({ scaleFactor: 1.5, buffer: drawBadge(24, text) });
    image.addRepresentation({ scaleFactor: 2, buffer: drawBadge(32, text) });
    cache.set(text, image);
  }
  return image;
}

let shown = -1;

/** Shows how many questions and approvals wait for the user (0 removes the badge). */
export function showWaiting(window: BrowserWindow | undefined, count: number): void {
  if (count === shown) return;
  shown = count;
  if (process.platform === 'win32') {
    if (!window || window.isDestroyed()) return;
    window.setOverlayIcon(count > 0 ? overlay(count) : null, count > 0 ? `${count} waiting for you` : '');
  } else if (process.platform === 'darwin') {
    app.dock?.setBadge(count > 0 ? String(count) : '');
  } else {
    app.setBadgeCount(count);
  }
}

/** Forgets what was shown, so the next call draws it again (a new window has no overlay yet). */
export function resetBadge(): void {
  shown = -1;
}
