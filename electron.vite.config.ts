import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';

/**
 * Built pages get a strict Content-Security-Policy: only the app's own scripts
 * and styles, no network, no inline code. The dev server is left without one
 * because hot reload needs inline scripts and a websocket.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
].join('; ');

function contentSecurityPolicy(): Plugin {
  return {
    name: 'code-bot:csp',
    apply: 'build',
    transformIndexHtml: (html) =>
      html.replace('<!-- csp -->', `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
  };
}

export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      rolldownOptions: { input: { index: resolve('src/desktop/main/index.ts') } },
    },
  },
  preload: {
    build: {
      outDir: 'out/preload',
      rolldownOptions: {
        input: { index: resolve('src/desktop/preload/index.ts') },
        // Sandboxed preload scripts must be CommonJS.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: 'src/desktop/renderer',
    plugins: [react(), contentSecurityPolicy()],
    build: {
      outDir: resolve('out/renderer'),
      rolldownOptions: { input: { index: resolve('src/desktop/renderer/index.html') } },
    },
  },
});
