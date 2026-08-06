/**
 * What the window points at, and when that counts as broken. Pure — no
 * Electron — because "which origin is the app" is the input to the navigation
 * policy, and getting it wrong in remote mode would either lock the user out of
 * their own server or hand the preload bridge to a stranger's origin.
 *
 * Two modes, decided once at startup and never mid-session:
 *
 *   **local**   the shell spawns its own engine and learns its port from the
 *               handshake. This is the whole product for a normal user.
 *   **remote**  an advanced setting names another controller server; the shell
 *               spawns nothing at all and shows that origin.
 *
 * Remote mode deliberately has **no fallback to local**. The owner rejected a
 * shell that quietly starts a second engine when the configured one is
 * unreachable (plan §1): a machine with two engines has two Roon extensions,
 * two catalog crawls and two sets of settings, and the user cannot tell which
 * one they are looking at. Unreachable therefore means the error page, and
 * retry means "try that server again".
 */

import { pathToFileURL } from 'url';

import { engineUrl } from './engineConfig';
import type { ShellSettings } from './shellSettings';

/**
 * Is this sender frame the settings page itself? The settings IPC handlers
 * act only for the one local file the settings window shows — a second wall
 * behind the per-window preload split, so remote content can never reach the
 * settings channels even through a future preload mistake (dt6-1).
 */
export function isSettingsSender(
  frameUrl: string | null | undefined,
  settingsPagePath: string,
): boolean {
  if (!frameUrl) {
    return false;
  }
  const pageUrl = pathToFileURL(settingsPagePath).href;
  // The page may carry a query/hash; the file part must match exactly.
  const bare = frameUrl.split(/[?#]/, 1)[0];
  return bare === pageUrl;
}

export type ShellMode =
  | { readonly kind: 'local' }
  | {
      readonly kind: 'remote';
      /** The URL to load, exactly as stored. */
      readonly url: string;
      /** Its origin — the one the navigation policy allows in-frame. */
      readonly origin: string;
    };

export const LOCAL_MODE: ShellMode = { kind: 'local' };

/**
 * Remote mode iff a valid server URL survived validation. `serverUrl` is
 * already normalized by `normalizeShellSettings`, so an unparseable value never
 * reaches here — it arrives as null and this returns local mode.
 */
export function resolveShellMode(settings: ShellSettings): ShellMode {
  const configured = settings.serverUrl;
  if (configured === null) {
    return LOCAL_MODE;
  }
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    return LOCAL_MODE;
  }
  return { kind: 'remote', url: parsed.href, origin: parsed.origin };
}

/**
 * The URL the window should be showing, or null when there is nothing to show
 * yet (local mode before the engine reports its port — the starting page).
 */
export function windowUrl(mode: ShellMode, enginePort: number | null): string | null {
  if (mode.kind === 'remote') {
    return mode.url;
  }
  return enginePort === null ? null : engineUrl(enginePort);
}

/**
 * The single origin allowed to load in the app frame. Feeds
 * `decideNavigation`'s `engineOrigin` argument, which is why remote mode has to
 * answer it: without this the user's own server would be treated as an external
 * web link and opened in their browser instead.
 */
export function windowOrigin(mode: ShellMode, enginePort: number | null): string | null {
  const url = windowUrl(mode, enginePort);
  if (url === null) {
    return null;
  }
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Chromium's code for "a newer navigation superseded this one". */
const ERR_ABORTED = -3;

export interface LoadFailure {
  readonly mode: ShellMode;
  /** The URL Chromium was trying to load when it gave up. */
  readonly failedUrl: string;
  readonly errorCode: number;
  readonly isMainFrame: boolean;
}

/**
 * Whether a `did-fail-load` should put the window on the error page.
 *
 * Four filters, each of which has to be there:
 *
 *   - **Remote mode only.** In local mode the supervisor owns failure: it knows
 *     about crashes, backoff and the attempt budget, and a second error path
 *     racing it would overwrite its message with a less informative one.
 *   - **The configured server only.** Otherwise the error page's own `file:`
 *     load failing would show the error page, which would fail, forever.
 *   - **Main frame only.** A failed image or iframe inside the app is the app's
 *     problem, not the shell's.
 *   - **Not an abort.** Every navigation-during-navigation reports `ERR_ABORTED`,
 *     including the shell's own switch away from the starting page.
 */
export function shouldReportLoadFailure(failure: LoadFailure): boolean {
  if (failure.mode.kind !== 'remote' || !failure.isMainFrame) {
    return false;
  }
  if (failure.errorCode === ERR_ABORTED) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(failure.failedUrl);
  } catch {
    return false;
  }
  return parsed.origin === failure.mode.origin;
}
