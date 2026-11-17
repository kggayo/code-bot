/// <reference types="vite/client" />
import type { DesktopBridge } from '../../../shared/types.ts';

declare global {
  interface Window {
    codeBot: DesktopBridge;
  }
}

export {};
