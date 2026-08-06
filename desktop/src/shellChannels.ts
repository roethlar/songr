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

/** Renderer → main (invoke): the settings page wants the current settings. */
export const GET_SETTINGS_CHANNEL = 'shell:get-settings';

/**
 * Renderer → main (invoke): store these settings. The reply carries what was
 * actually stored, so a rejected value visibly reverts in the form rather than
 * appearing to have been accepted.
 */
export const SAVE_SETTINGS_CHANNEL = 'shell:save-settings';
