import path from 'path';

/**
 * Absolute-path fixtures that are absolute on every platform.
 *
 * Tests describe layouts with POSIX literals (`/Applications/Songr.app/...`)
 * because they read well. On Windows such a literal is drive-relative, and the
 * code under test correctly resolves it (`path.resolve`) or keeps it
 * drive-less (`path.join`), so a literal expectation can never match there.
 * `abs` joins the POSIX segments onto the platform root: the literal itself on
 * POSIX, the same path on the current drive on Windows. Expectations built with
 * it stay exact.
 */
export function abs(posixPath: string): string {
  return path.join(path.parse(process.cwd()).root, ...posixPath.split('/'));
}

/**
 * The `file:` URL Chromium reports for `abs(posixPath)`: `file:///C:/app/x` on
 * Windows, `file:///app/x` on POSIX. Spelled out by hand rather than through
 * Node's `pathToFileURL`, which is what the settings-sender check under test
 * itself uses: an expectation built from the same function would agree with
 * any mistake in it. Fixture paths must not need percent-encoding.
 */
export function fileUrl(posixPath: string): string {
  const root = path.parse(process.cwd()).root.replace(/[\\/]+$/, '');
  return `file://${root === '' ? '' : `/${root}`}${posixPath}`;
}
