import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import { IPC } from '../../shared/types.ts';
import type { CodeBotMethod, CoreEvent, DesktopBridge } from '../../shared/types.ts';

// Bundled into one CommonJS file: sandboxed preload scripts can only require 'electron'.
const bridge: DesktopBridge = {
  call: (method: CodeBotMethod, args: unknown[]) => ipcRenderer.invoke(IPC.call, method, args),
  onEvent: (listener) => {
    const handler = (_event: IpcRendererEvent, coreEvent: CoreEvent) => listener(coreEvent);
    ipcRenderer.on(IPC.event, handler);
    return () => {
      ipcRenderer.removeListener(IPC.event, handler);
    };
  },
  onFocusBot: (listener) => {
    const handler = (_event: IpcRendererEvent, botId: string) => listener(botId);
    ipcRenderer.on(IPC.focusBot, handler);
    return () => {
      ipcRenderer.removeListener(IPC.focusBot, handler);
    };
  },
  platform: process.platform,
};

contextBridge.exposeInMainWorld('codeBot', bridge);
