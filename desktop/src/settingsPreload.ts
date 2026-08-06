/**
 * Preload for the Advanced Settings window ONLY.
 *
 * The settings bridge is deliberately not part of the main window's preload:
 * in remote mode that window shows another server's content, and content that
 * can call saveSettings can durably redirect the whole app (dt6-1). The
 * settings window shows exactly one local file, so only it gets these two
 * channels — and the main-process handlers additionally verify the sender
 * frame, so neither layer trusts the other.
 *
 * The channel literals are duplicated from `shellChannels.ts` on purpose — a
 * sandboxed preload cannot require a sibling module. See that file.
 */

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('roonControllerShell', {
  getSettings: async (): Promise<unknown> =>
    ipcRenderer.invoke('shell:get-settings'),
  saveSettings: async (form: unknown): Promise<unknown> =>
    ipcRenderer.invoke('shell:save-settings', form),
});
