/**
 * IPC channel names shared by the main process and the shell's own pages.
 *
 * `preload.ts` repeats the literals instead of importing this module: the window
 * runs with `sandbox: true`, and a sandboxed preload script can only `require`
 * Electron's own polyfilled subset, not a sibling file. A unit test asserts the
 * two stay in step.
 */

/** Renderer → main: the error page's retry button was pressed. */
export const RETRY_ENGINE_CHANNEL = 'shell:retry-engine';

/**
 * Renderer → main: the app window asks for the advanced settings window.
 *
 * This is the ONLY way to reach advanced settings without a tray, and network
 * serving lives there — the shell binds its engine to loopback on a random port
 * unless `serveOnNetwork` is set. The tray used to be the sole entry point, so
 * on any desktop without a StatusNotifier host (the Flatpak by ruling, GNOME
 * without an extension, bare wlroots) the setting was unreachable and a user
 * could not expose the server at all.
 *
 * Deliberately a command and nothing more: it opens a window and carries no
 * payload, so the app window — which may be showing a remote server's page —
 * still cannot read or write settings. Those stay on the settings window's own
 * preload, and the save handler additionally checks the sender's URL.
 */
export const OPEN_SETTINGS_CHANNEL = 'shell:open-settings';

/** Renderer → main (invoke): the settings page wants the current settings. */
export const GET_SETTINGS_CHANNEL = 'shell:get-settings';

/**
 * Renderer → main (invoke): store these settings. The reply carries what was
 * actually stored, so a rejected value visibly reverts in the form rather than
 * appearing to have been accepted.
 */
export const SAVE_SETTINGS_CHANNEL = 'shell:save-settings';
