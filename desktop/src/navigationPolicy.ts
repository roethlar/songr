/**
 * Where the shell window may navigate, decided in one pure function (dt2-2).
 *
 * The window shows exactly two kinds of content: the engine's UI on
 * `http://127.0.0.1:<port>` and the shell's own local resource pages. Anything
 * else a page asks for — a plain anchor to the wider web, a `window.open`, a
 * `javascript:` URL — must not replace the app frame, because whatever loads
 * there inherits the preload bridge. Web links go to the user's browser;
 * everything unrecognizable is dropped.
 */

import path from 'path';
import { fileURLToPath } from 'url';

export type NavigationDecision = 'allow' | 'open-external' | 'deny';

/** True when `fileUrl` resolves to a file inside `dir` (never `dir` itself). */
function isFileInside(fileUrl: URL, dir: string): boolean {
  let filePath: string;
  try {
    filePath = fileURLToPath(fileUrl);
  } catch {
    return false;
  }
  const relative = path.relative(path.resolve(dir), path.resolve(filePath));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function decideNavigation(
  targetUrl: string,
  engineOrigin: string | null,
  /** The one directory whose files may load in-frame (the shell's pages). */
  localPageDir: string | null,
): NavigationDecision {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return 'deny';
  }

  // Only the shell's own pages — a scheme-wide file: allow would let any
  // local path load in-frame with the preload bridge (dt3-3).
  if (parsed.protocol === 'file:') {
    return localPageDir !== null && isFileInside(parsed, localPageDir)
      ? 'allow'
      : 'deny';
  }

  if (engineOrigin !== null && parsed.origin === engineOrigin) {
    return 'allow';
  }

  // Real web links belong in the user's browser, never in this frame. Only
  // web schemes are handed to the OS: shell.openExternal on an arbitrary
  // scheme is a code-execution primitive.
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    return 'open-external';
  }

  return 'deny';
}
