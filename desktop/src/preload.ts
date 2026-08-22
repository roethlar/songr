/**
 * Preload for the main window's pages (loading, error, and the engine UI).
 *
 * The window is sandboxed with context isolation on and Node integration off,
 * so this is the only bridge those pages get: one function, one channel, no
 * filesystem and no Node. The engine UI loaded from the server gets the same
 * preload and simply ignores it. The settings bridge lives in
 * `settingsPreload.ts`, given only to the settings window — the main window
 * can show a remote server's content, which must never reach the settings
 * channels (dt6-1).
 *
 * The channel literal is duplicated from `shellChannels.ts` on purpose — a
 * sandboxed preload cannot require a sibling module. See that file.
 */

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('roonControllerShell', {
  retryEngine: (): void => {
    ipcRenderer.send('shell:retry-engine');
  },
  /**
   * Open the shell's advanced settings window. The app's own Settings menu
   * offers this only when the bridge is present, so a plain browser tab shows
   * nothing. Send-only: no settings cross this bridge in either direction.
   */
  openAdvancedSettings: (): void => {
    ipcRenderer.send('shell:open-settings');
  },
});
