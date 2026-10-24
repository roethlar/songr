import { execFileSync } from "child_process";
import path from "path";

/**
 * Owner-only access for the Roon pairing secret on Windows.
 *
 * On POSIX the token's privacy comes from `mode: 0o600` / `0o700`. On Windows
 * Node maps `mode` only to the read-only attribute; who may read the file is
 * decided by the ACL it inherits from its directory. Under
 * `C:\Program Files` that ACL grants `BUILTIN\Users` read, so without this
 * every local account could read and reuse the token
 * (`.agents/plans/windows-token-file-acl.md`).
 *
 * `protectSecretPath` removes inheritance and grants full control to exactly
 * three principals: the process's own user, SYSTEM and Administrators. It runs
 * `%SystemRoot%\System32\icacls.exe` through `execFileSync` with an argument
 * array — never a shell string — and SID arguments only, so no account name
 * (localized, or carrying shell metacharacters) is ever interpreted. A failure
 * throws: the caller treats it as a persistence failure.
 */

export const SYSTEM_SID = "S-1-5-18";
export const ADMINISTRATORS_SID = "S-1-5-32-544";

export type SecretPathKind = "file" | "directory";

/** Runs an executable with an argument array and returns its stdout. */
export type ExecFile = (file: string, args: readonly string[]) => string;

const SID_PATTERN = /^S-1-\d+(?:-\d+)+$/;

function system32(executable: string): string {
  const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  return path.win32.join(root, "System32", executable);
}

export const ICACLS_PATH = (): string => system32("icacls.exe");
export const WHOAMI_PATH = (): string => system32("whoami.exe");

const defaultExecFile: ExecFile = (file, args) =>
  execFileSync(file, [...args], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

/**
 * The SID `whoami /user /fo csv /nh` reports: `"host\user","S-1-5-21-..."`.
 * The last CSV field is the SID; anything else is refused rather than guessed.
 */
export function parseWhoamiUserSid(output: string): string {
  const match = /"(S-1-[0-9-]+)"\s*$/.exec(output.trim());
  if (!match || !SID_PATTERN.test(match[1])) {
    throw new Error(`Could not read the current user's SID from whoami: ${JSON.stringify(output)}`);
  }
  return match[1];
}

/**
 * icacls arguments that leave `target` with exactly the three explicit
 * full-control entries and no inherited ones. A directory's entries are
 * inheritable `(OI)(CI)`, so a file created inside it (the token's `.tmp`)
 * is owner-only from its first byte.
 */
export function privateAclArgs(
  target: string,
  kind: SecretPathKind,
  userSid: string
): string[] {
  if (!SID_PATTERN.test(userSid)) {
    throw new Error(`Refusing to build an ACL for a malformed SID: ${JSON.stringify(userSid)}`);
  }
  const inherit = kind === "directory" ? "(OI)(CI)" : "";
  const sids = [...new Set([userSid, SYSTEM_SID, ADMINISTRATORS_SID])];
  return [
    target,
    "/inheritance:r",
    "/grant:r",
    ...sids.map((sid) => `*${sid}:${inherit}F`),
    "/q",
  ];
}

let cachedUserSid: string | null = null;

/** The process's own SID, read once per process. */
export function currentUserSid(execFile: ExecFile = defaultExecFile): string {
  if (cachedUserSid === null) {
    cachedUserSid = parseWhoamiUserSid(execFile(WHOAMI_PATH(), ["/user", "/fo", "csv", "/nh"]));
  }
  return cachedUserSid;
}

/**
 * libuv's `UV_FS_O_EXLOCK`, which Node does not export: on Windows the file
 * is opened with share mode 0, so while the handle is open no other process
 * can open it to read or write (EBUSY). Changing its ACL is still possible:
 * that access is outside the share mode. Zero elsewhere, where the flag has
 * no meaning.
 */
export function exclusiveOpenFlag(platform: NodeJS.Platform = process.platform): number {
  return platform === "win32" ? 0x10000000 : 0;
}

/** Test seam: forget the cached SID. */
export function resetCurrentUserSidForTests(): void {
  cachedUserSid = null;
}

/**
 * Make `target` owner-only on Windows. Elsewhere a no-op: POSIX callers rely on
 * the `0o600` / `0o700` modes they already pass.
 */
export function protectSecretPath(
  target: string,
  kind: SecretPathKind,
  platform: NodeJS.Platform = process.platform,
  execFile: ExecFile = defaultExecFile
): void {
  if (platform !== "win32") return;
  execFile(ICACLS_PATH(), privateAclArgs(target, kind, currentUserSid(execFile)));
}
