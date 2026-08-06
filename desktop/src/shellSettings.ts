/**
 * The shell's own settings — the two advanced options that exist, plus the
 * rules for reading them back safely.
 *
 * These are *shell* settings, not application settings. Everything the user
 * normally touches lives in the engine's own UI; this file holds only the two
 * decisions the shell has to make before the engine exists at all:
 *
 *   `serverUrl`       point the window at somebody else's engine instead of
 *                     spawning one (a buried advanced setting, plan §1 — never
 *                     part of onboarding, and invisible to a normal user).
 *   `serveOnNetwork`  bind the spawned engine to every interface on a fixed
 *                     port instead of an ephemeral loopback one, so other
 *                     devices on the LAN can reach it. Off by default, and the
 *                     UI states the trusted-LAN/no-auth caveat when it is on.
 *
 * Everything here is pure apart from two tiny injected file operations, so the
 * validation — which is the part that must never throw — is unit-testable
 * without a filesystem. **A settings file that is missing, unreadable, not
 * JSON, not an object, or written by a version this build does not know is not
 * an error condition: it produces the defaults and a logged warning.** The app
 * has to start. A user who hand-edits this file into nonsense gets a working
 * app with default settings, not a window that never opens.
 */

import fs from 'fs';
import path from 'path';

/**
 * Bumped only when an existing field changes meaning. A file stamped with any
 * other version is read as "not mine" and ignored in favour of the defaults —
 * see `normalizeShellSettings`.
 */
export const SHELL_SETTINGS_VERSION = 1;

/** File name inside Electron's per-user `userData` directory. */
export const SHELL_SETTINGS_FILE = 'shell-settings.json';

/**
 * The port "serve on the network" binds. 3333 is the appliance install's own
 * default, so a browser bookmark works against either without editing.
 */
export const DEFAULT_NETWORK_PORT = 3333;

export interface ShellSettings {
  /**
   * Absolute `http:`/`https:` URL of another controller server, or null to run
   * the app's own engine. Stored normalized (`new URL(...).href`).
   */
  readonly serverUrl: string | null;
  /** Bind the spawned engine to every interface, not just loopback. */
  readonly serveOnNetwork: boolean;
  /** The fixed port used when `serveOnNetwork` is on. Ignored when it is off. */
  readonly networkPort: number;
}

export const DEFAULT_SHELL_SETTINGS: ShellSettings = {
  serverUrl: null,
  serveOnNetwork: false,
  networkPort: DEFAULT_NETWORK_PORT,
};

/** Where warnings go. Deliberately not `console`, so tests can read them. */
export type SettingsWarn = (message: string) => void;

const noWarn: SettingsWarn = () => undefined;

/** The two filesystem operations this module needs, injected for testing. */
export interface SettingsFileIo {
  /** Read the file as UTF-8. Throws when it does not exist or cannot be read. */
  readFile(filePath: string): string;
  /** Write the file, creating its directory if needed. Throws on failure. */
  writeFile(filePath: string, contents: string): void;
}

export const nodeSettingsIo: SettingsFileIo = {
  readFile: (filePath) => fs.readFileSync(filePath, 'utf8'),
  writeFile: (filePath, contents) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents, 'utf8');
  },
};

export function settingsFilePath(userDataDir: string): string {
  return path.join(userDataDir, SHELL_SETTINGS_FILE);
}

/**
 * Validate a candidate remote server URL.
 *
 * Only `http:` and `https:` survive. Anything else — a `file:` path, a
 * `javascript:` URL, a bare hostname, an empty box — is not a server this shell
 * can point a window at, and returning null here is what makes the setting
 * "treated as absent" everywhere downstream (plan §1: the option is buried, so
 * a broken value must degrade to normal local behaviour rather than to a
 * mystery).
 */
export function parseServerUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }
  // `new URL('http://')` throws, but a URL whose origin is opaque could still
  // slip through a future scheme change; an origin is what the navigation
  // policy compares against, so no origin means no remote mode.
  if (parsed.origin === 'null' || parsed.origin === '') {
    return null;
  }
  // Credentials would be persisted in plaintext and echoed into logs; a URL
  // carrying them is refused outright rather than silently stripped (dt6-2).
  if (parsed.username !== '' || parsed.password !== '') {
    return null;
  }
  // Everything downstream consumes an origin: the window loads it, the
  // navigation policy compares against it, and socket.io would read a URL
  // path as a namespace and leave the tray silently dead (dt6-3). Storing
  // the normalized origin keeps the value inside every consumer's contract.
  return `${parsed.origin}/`;
}

function parsePort(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return null;
  }
  // Port 0 means "let the OS choose", which is exactly what the *default*
  // behaviour already does. As a fixed LAN port it is meaningless: nothing
  // could bookmark it.
  if (value < 1 || value > 65535) {
    return null;
  }
  return value;
}

/**
 * Read a *stored document*: check the version stamp, then normalize the shape.
 *
 * The version check lives here and **not** in `normalizeShellSettings`, which is
 * a deliberate split. Field normalization runs on its own output (a settings
 * object read back from the settings page carries no version stamp, and should
 * not have to), so a version check inside it would silently discard every value
 * on the way back to disk. That is not hypothetical: it is the defect the live
 * smoke of this slice found, and the split is what makes it unrepeatable.
 */
export function parseSettingsDocument(
  raw: unknown,
  warn: SettingsWarn = noWarn,
): ShellSettings {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    warn('settings file does not contain an object; using defaults');
    return DEFAULT_SHELL_SETTINGS;
  }

  const version = (raw as Record<string, unknown>).version;
  if (version !== SHELL_SETTINGS_VERSION) {
    // Either a file from a future build or something that was never ours.
    // Reading unknown fields as if we understood them is how a "safe" loader
    // silently turns a stranger's data into a configuration.
    warn(
      `settings file version ${JSON.stringify(version)} is not ` +
        `${String(SHELL_SETTINGS_VERSION)}; using defaults`,
    );
    return DEFAULT_SHELL_SETTINGS;
  }

  return normalizeShellSettings(raw, warn);
}

/**
 * Coerce any object into usable settings — shape only, no version stamp
 * required. Never throws. Every rejected field falls back to its default and
 * reports one warning, so a half-corrupt file still yields the good half.
 */
export function normalizeShellSettings(
  raw: unknown,
  warn: SettingsWarn = noWarn,
): ShellSettings {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    warn('settings are not an object; using defaults');
    return DEFAULT_SHELL_SETTINGS;
  }

  const candidate = raw as Record<string, unknown>;

  const rawServerUrl = candidate.serverUrl;
  const serverUrl = parseServerUrl(rawServerUrl);
  // An empty box is how the setting is *cleared*, not a mistake worth a warning.
  const clearedOnPurpose =
    rawServerUrl === undefined ||
    rawServerUrl === null ||
    (typeof rawServerUrl === 'string' && rawServerUrl.trim() === '');
  if (serverUrl === null && !clearedOnPurpose) {
    warn(
      `ignoring serverUrl ${JSON.stringify(rawServerUrl)}: not an http(s) URL`,
    );
  }

  const rawServeOnNetwork = candidate.serveOnNetwork;
  let serveOnNetwork = DEFAULT_SHELL_SETTINGS.serveOnNetwork;
  if (typeof rawServeOnNetwork === 'boolean') {
    serveOnNetwork = rawServeOnNetwork;
  } else if (rawServeOnNetwork !== undefined) {
    warn(
      `ignoring serveOnNetwork ${JSON.stringify(rawServeOnNetwork)}: not a boolean`,
    );
  }

  const rawPort = candidate.networkPort;
  const parsedPort = parsePort(rawPort);
  if (parsedPort === null && rawPort !== undefined) {
    warn(`ignoring networkPort ${JSON.stringify(rawPort)}: not a port number`);
  }

  return {
    serverUrl,
    serveOnNetwork,
    networkPort: parsedPort ?? DEFAULT_SHELL_SETTINGS.networkPort,
  };
}

/** The exact bytes written to disk, version stamp included. */
export function serializeShellSettings(settings: ShellSettings): string {
  return `${JSON.stringify(
    {
      version: SHELL_SETTINGS_VERSION,
      serverUrl: settings.serverUrl,
      serveOnNetwork: settings.serveOnNetwork,
      networkPort: settings.networkPort,
    },
    null,
    2,
  )}\n`;
}

export interface LoadSettingsOptions {
  readonly filePath: string;
  readonly io?: SettingsFileIo;
  readonly warn?: SettingsWarn;
}

/**
 * Read the settings file. Returns the defaults for every failure mode there is,
 * silently for the one that is not a failure at all: the file not existing yet.
 */
export function loadShellSettings(options: LoadSettingsOptions): ShellSettings {
  const io = options.io ?? nodeSettingsIo;
  const warn = options.warn ?? noWarn;

  let contents: string;
  try {
    contents = io.readFile(options.filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code !== 'ENOENT') {
      warn(
        `could not read ${options.filePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return DEFAULT_SHELL_SETTINGS;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    warn(
      `${options.filePath} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return DEFAULT_SHELL_SETTINGS;
  }

  return parseSettingsDocument(parsed, warn);
}

export interface SaveSettingsOptions {
  readonly filePath: string;
  /** Anything at all: it is normalized before it is written. */
  readonly settings: unknown;
  readonly io?: SettingsFileIo;
  readonly warn?: SettingsWarn;
}

/**
 * Normalize and write. Returns what was actually stored, which is what the
 * settings page redisplays — so a rejected value visibly reverts instead of
 * appearing to have been accepted.
 *
 * Write failures propagate: the caller has a user waiting on a Save button and
 * must be able to say it did not work.
 */
export function saveShellSettings(options: SaveSettingsOptions): ShellSettings {
  const io = options.io ?? nodeSettingsIo;
  const settings = normalizeShellSettings(
    options.settings,
    options.warn ?? noWarn,
  );
  io.writeFile(options.filePath, serializeShellSettings(settings));
  return settings;
}

/**
 * Build a settings object from the settings page's raw form values.
 *
 * The page posts strings; this is the one place that turns them into the stored
 * shape, so the page needs no validation logic of its own (and cannot have any
 * the main process does not enforce).
 */
export function shellSettingsFromForm(
  form: unknown,
  warn: SettingsWarn = noWarn,
): ShellSettings {
  const candidate =
    typeof form === 'object' && form !== null
      ? (form as Record<string, unknown>)
      : {};

  // An empty port box means "I did not set one", not "port NaN".
  const rawPort = candidate.networkPort;
  let networkPort: unknown = rawPort;
  if (typeof rawPort === 'string') {
    const trimmed = rawPort.trim();
    const asNumber = Number(trimmed);
    networkPort =
      trimmed === '' ? undefined : Number.isFinite(asNumber) ? asNumber : rawPort;
  }

  return normalizeShellSettings(
    {
      serverUrl: candidate.serverUrl,
      // A checkbox is present-or-absent on the wire; anything that is not a
      // literal `true` is off.
      serveOnNetwork: candidate.serveOnNetwork === true,
      networkPort,
    },
    warn,
  );
}
