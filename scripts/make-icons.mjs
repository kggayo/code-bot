// Renders build/icon.svg (and build/icon-small.svg for 32 px and below) into the
// icons electron-builder and the window use:
//   build/icon.png          1024x1024 (Linux, and the source for macOS .icns)
//   build/icon.ico          16-256 px, PNG entries (Windows)
//   build/icons/NxN.png     sizes for Linux desktop entries
// The .ico has every size Windows asks for at 100-200 % display scaling (taskbar
// 24/30/36/48, window 16/20/24/32/40, Explorer 48-256). A missing size is made by
// shrinking a larger one, which is what made the taskbar icon look blurred.
// Run with Electron, which draws the SVG (no image library needed):
//   npx electron scripts/make-icons.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, app } from 'electron';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const build = join(root, 'build');
const svg = readFileSync(join(build, 'icon.svg'), 'utf8');
const smallSvg = readFileSync(join(build, 'icon-small.svg'), 'utf8');
/** Up to this size the small drawing is used: bolder shapes on a 16-pixel grid. */
const SMALL_MAX = 32;
const PNG_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const ICO_SIZES = [16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 128, 256];

/** An .ico file whose images are PNGs (Windows Vista and later). */
function ico(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, index) => {
    const entry = 6 + index * 16;
    header.writeUInt8(size >= 256 ? 0 : size, entry);
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt8(0, entry + 2);
    header.writeUInt8(0, entry + 3);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.png)]);
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await window.loadURL('data:text/html,<canvas></canvas>');
  const pngs = new Map();
  for (const size of [...new Set([...PNG_SIZES, ...ICO_SIZES])].sort((a, b) => a - b)) {
    // An explicit pixel size, so the drawing is rasterised at that size rather than scaled from another.
    const sized = (size <= SMALL_MAX ? smallSvg : svg).replace('<svg ', `<svg width="${size}" height="${size}" `);
    const source = `data:image/svg+xml;base64,${Buffer.from(sized).toString('base64')}`;
    const dataUrl = await window.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = ${size};
          canvas.height = ${size};
          const context = canvas.getContext('2d');
          context.imageSmoothingQuality = 'high';
          context.drawImage(image, 0, 0, ${size}, ${size});
          resolve(canvas.toDataURL('image/png'));
        };
        image.onerror = () => reject(new Error('The SVG did not load'));
        image.src = ${JSON.stringify(source)};
      })
    `);
    pngs.set(size, Buffer.from(String(dataUrl).split(',')[1], 'base64'));
  }
  mkdirSync(join(build, 'icons'), { recursive: true });
  for (const size of PNG_SIZES) writeFileSync(join(build, 'icons', `${size}x${size}.png`), pngs.get(size));
  writeFileSync(join(build, 'icon.png'), pngs.get(1024));
  writeFileSync(join(build, 'icon.ico'), ico(ICO_SIZES.map((size) => ({ size, png: pngs.get(size) }))));
  console.log(`Wrote build/icon.png, build/icon.ico (${ICO_SIZES.length} sizes) and ${PNG_SIZES.length} sizes in build/icons/`);
  app.quit();
});
