import path from "path";
import dotenv from "dotenv";

dotenv.config();

export interface AppConfig {
  readonly host: string;
  readonly port: number;
  readonly logLevel: LogLevel;
  readonly roonTokenPath: string;
  readonly imageCachePath: string;
  readonly imageCacheMaxBytes: number;
  readonly recentlyPlayedPath: string;
  readonly recentlyPlayedCap: number;
  readonly favoritesPath: string;
  /**
   * Where an earlier install's saved catalog store sits, so it can be removed
   * at start (`src/server/removeRetiredCatalogStore.ts`). Nothing reads or
   * writes a library model here any more; the key survives only so an operator
   * who moved the store with CATALOG_PATH still gets it cleaned up.
   */
  readonly retiredCatalogPath: string;
  /**
   * Whether the browse canary runs (post-connect load trial, plan
   * `.agents/plans/core-wedge-postconnect.md` §A0).
   *
   * ON unless explicitly switched off. It began as trial instrumentation and
   * shipped off for that reason — the canary is real traffic against the Core,
   * one root-level classic-browse request every 30 s, and a default-on probe
   * would have changed what every install did to its Core, which was the thing
   * the trial existed to measure. It is now a health authority the mitigations
   * depend on: it is what pauses a bootstrapping sweep against a Core that is
   * already wedged, and the only thing that can license a latency baseline.
   * `ROON_BROWSE_CANARY=0` is the emergency valve.
   */
  readonly browseCanaryEnabled: boolean;
  /**
   * The baseline p95 browse latency, in milliseconds, the canary's wedge rule
   * compares against (plan §A3: a slot exceeds at 3× this value).
   *
   * Never null: `DEFAULT_BROWSE_CANARY_BASELINE_P95_MS` (500 ms, so the rule
   * fires at 1.5 s) applies when nothing is configured — see that constant for
   * why a shipped line is sized to catch a wedge and not to police tens of
   * milliseconds. Measuring a real value on a quiet, healthy Core is what
   * catches degradation short of a wedge.
   */
  readonly browseCanaryBaselineP95Ms: number;
}

export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const VALID_LOG_LEVELS: LogLevel[] = [
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
];

const coerceString = (value: string | undefined): string | undefined =>
  value?.trim() ? value.trim() : undefined;

const FLAG_ON = new Set(["1", "true", "yes", "on"]);
const FLAG_OFF = new Set(["", "0", "false", "no", "off"]);

/**
 * The one canonical reading of an on/off environment switch.
 *
 * Deliberately NOT "any value at all means on". `SWITCH=0` reads as off in
 * every shell an operator has ever used, and a switch that turned itself on
 * for it would silently invert the intent behind a trial run whose whole
 * purpose is knowing which workloads were active. An unrecognized value is a
 * configuration error rather than a guess, for the same reason.
 */
const parseEnvFlag = (
  value: string | undefined,
  name: string,
  whenUnset = false
): boolean => {
  const raw = value?.trim().toLowerCase() ?? "";
  // Unset is answered by the caller's default rather than by the OFF set.
  // A kill switch that ships off and a feature that ships on both spell
  // "nobody configured this" the same way, and only the caller knows which
  // of the two it is.
  if (raw === "") return whenUnset;
  if (FLAG_ON.has(raw)) return true;
  if (FLAG_OFF.has(raw)) return false;
  throw new ConfigError(
    `${name} must be one of: 1, true, yes, on, 0, false, no, off`
  );
};

const parseHost = (value: string | undefined): string => {
  const host = coerceString(value) ?? "0.0.0.0";
  if (host.length === 0) {
    throw new ConfigError("HOST cannot be empty");
  }
  return host;
};

const parsePort = (value: string | undefined): number => {
  if (value === undefined || value.trim().length === 0) {
    return 3333;
  }

  const parsed = Number(value);

  // 0 is legal and means "let the OS pick an ephemeral port". The desktop
  // shell forks the engine that way and learns the real port from the
  // `listening` IPC handshake (see server/listeningHandshake.ts). The
  // appliance never sets PORT=0, so its 3333 default is untouched.
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new ConfigError("PORT must be an integer between 0 and 65535");
  }

  return parsed;
};

const parseLogLevel = (value: string | undefined): LogLevel => {
  const level = coerceString(value)?.toLowerCase() as LogLevel | undefined;

  if (!level) {
    return "info";
  }

  if (!VALID_LOG_LEVELS.includes(level)) {
    throw new ConfigError(
      `LOG_LEVEL must be one of: ${VALID_LOG_LEVELS.join(", ")}`
    );
  }

  return level;
};

/**
 * Base directories for everything the controller writes. `CONFIG_DIR` holds
 * pairing state, `DATA_DIR` holds caches and persisted user data. They exist
 * so a host process (the desktop shell) can relocate the whole footprint with
 * two variables instead of five. The per-file variables below still win when
 * set, and with both unset every resolved path is identical to the historical
 * `./config` / `./data` layout the appliance install uses.
 */
const DEFAULT_CONFIG_DIR = "./config";
const DEFAULT_DATA_DIR = "./data";

const parseBaseDir = (
  value: string | undefined,
  fallback: string,
  name: string
): string => {
  const rawPath = coerceString(value) ?? fallback;
  if (!rawPath) {
    throw new ConfigError(`${name} cannot be empty`);
  }
  return path.resolve(rawPath);
};

/** The one canonical resolution of `DATA_DIR`. */
const resolveDataDir = (): string =>
  parseBaseDir(process.env.DATA_DIR, DEFAULT_DATA_DIR, "DATA_DIR");

const parseTokenPath = (
  value: string | undefined,
  configDir: string
): string => {
  const rawPath = coerceString(value) ?? path.join(configDir, "roon-token.json");
  if (!rawPath) {
    throw new ConfigError("ROON_TOKEN_PATH cannot be empty");
  }
  return path.resolve(rawPath);
};

const parseImageCachePath = (
  value: string | undefined,
  dataDir: string
): string => {
  const rawPath = coerceString(value) ?? path.join(dataDir, "image-cache");
  return path.resolve(rawPath);
};

const DEFAULT_IMAGE_CACHE_MAX_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB

const parseImageCacheMaxBytes = (value: string | undefined): number => {
  const raw = coerceString(value);
  if (!raw) return DEFAULT_IMAGE_CACHE_MAX_BYTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ConfigError("IMAGE_CACHE_MAX_BYTES must be a positive number");
  }
  return Math.floor(parsed);
};

const parseRecentlyPlayedPath = (
  value: string | undefined,
  dataDir: string
): string => {
  const rawPath =
    coerceString(value) ?? path.join(dataDir, "recently-played.json");
  return path.resolve(rawPath);
};

const parseFavoritesPath = (
  value: string | undefined,
  dataDir: string
): string => {
  const rawPath = coerceString(value) ?? path.join(dataDir, "favorites.json");
  return path.resolve(rawPath);
};

const parseCatalogPath = (
  value: string | undefined,
  dataDir: string
): string => {
  const rawPath = coerceString(value) ?? path.join(dataDir, "catalog");
  return path.resolve(rawPath);
};

const DEFAULT_RECENTLY_PLAYED_CAP = 50;

const parseRecentlyPlayedCap = (value: string | undefined): number => {
  const raw = coerceString(value);
  if (!raw) return DEFAULT_RECENTLY_PLAYED_CAP;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 1000) {
    throw new ConfigError(
      "RECENTLY_PLAYED_CAP must be an integer between 1 and 1000"
    );
  }
  return parsed;
};

/**
 * The healthy-speed reference the canary, the breaker and the sweep governor
 * all measure against, when the operator has not measured their own.
 *
 * WHAT IT IS FOR. Every rule built on it fires at 3x this number, so the
 * shipped default draws one line: 1.5 s for a single root-level browse. Its
 * job is to catch a WEDGE — the recorded failure mode is a Core that takes a
 * request and never answers it, presenting as multi-second stalls and 15 s
 * budget timeouts — not to police tens of milliseconds.
 *
 * WHY 500 AND NOT LESS. The owner's own Core answers this probe at a p95 of
 * 21 ms, so the default leaves roughly 24x headroom: a Core twenty times
 * slower than the reference install still reads as healthy. A root-level
 * browse that takes over a second and a half is not a healthy Core by any
 * reading, on any LAN.
 *
 * WHY 500 AND NOT MORE. The rule has to be able to speak before the 15 s call
 * budget does, and the observed wedge precursor included a 3.4 s stall. At
 * 1.5 s both are caught with room to spare.
 *
 * THE ASYMMETRY THAT SETTLES IT. Erring high costs only sensitivity: the rule
 * stays quiet and the breaker falls back to hard signals, which is the
 * behavior every install had before this default existed. Erring low actively
 * harms — it sheds background work on a Core that was fine. So the default
 * sits high enough that the direction it can be wrong in is the harmless one,
 * and every consumer's false-trip cost is cheap and self-healing anyway (one
 * exceeding probe pauses a bootstrapping sweep until the next probe 30 s
 * later; a breaker trip needs three consecutive, and backs off).
 *
 * WHAT IT DELIBERATELY DOES NOT DO. Cell-4 protection — refusing to learn a
 * baseline from a Core that has been degraded since startup — is relative to
 * that Core's own healthy speed. The A2 precursor sat at 383 ms, well inside
 * this line. Catching degradation at that grade needs a MEASURED value, which
 * is what `ROON_BROWSE_CANARY_BASELINE_P95_MS` is for. The shipped default
 * still catches the wedge itself, because a wedged Core times its probes out
 * and a timeout is a hard signal that needs no threshold at all.
 */
export const DEFAULT_BROWSE_CANARY_BASELINE_P95_MS = 500;

const parseBrowseCanaryBaselineP95Ms = (value: string | undefined): number => {
  const raw = coerceString(value);
  if (!raw) return DEFAULT_BROWSE_CANARY_BASELINE_P95_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ConfigError(
      "ROON_BROWSE_CANARY_BASELINE_P95_MS must be a positive number of milliseconds"
    );
  }
  return parsed;
};

export const loadConfig = (): AppConfig => {
  const host = parseHost(process.env.HOST);
  const port = parsePort(process.env.PORT);
  const logLevel = parseLogLevel(process.env.LOG_LEVEL);
  const configDir = parseBaseDir(
    process.env.CONFIG_DIR,
    DEFAULT_CONFIG_DIR,
    "CONFIG_DIR"
  );
  const dataDir = resolveDataDir();
  const roonTokenPath = parseTokenPath(process.env.ROON_TOKEN_PATH, configDir);
  const imageCachePath = parseImageCachePath(
    process.env.IMAGE_CACHE_PATH,
    dataDir
  );
  const imageCacheMaxBytes = parseImageCacheMaxBytes(process.env.IMAGE_CACHE_MAX_BYTES);
  const recentlyPlayedPath = parseRecentlyPlayedPath(
    process.env.RECENTLY_PLAYED_PATH,
    dataDir
  );
  const recentlyPlayedCap = parseRecentlyPlayedCap(
    process.env.RECENTLY_PLAYED_CAP
  );
  const favoritesPath = parseFavoritesPath(process.env.FAVORITES_PATH, dataDir);
  // CATALOG_PATH is the key; TIMELINE_CATALOG_PATH is honored as a fallback
  // because deployed .env files predate Timeline's removal (2026-08-09).
  const retiredCatalogPath = parseCatalogPath(
    process.env.CATALOG_PATH ?? process.env.TIMELINE_CATALOG_PATH,
    dataDir
  );
  // On by default since the B6b follow-up. The sweep governor will not freeze
  // a latency baseline without an authority outside its own samples calling
  // the Core healthy, so a build that shipped the canary off shipped a
  // governor that could never ramp past one. The variable stays as the
  // emergency valve, per the campaign rule that kill switches are valves and
  // features are on.
  const browseCanaryEnabled = parseEnvFlag(
    process.env.ROON_BROWSE_CANARY,
    "ROON_BROWSE_CANARY",
    true
  );
  const browseCanaryBaselineP95Ms = parseBrowseCanaryBaselineP95Ms(
    process.env.ROON_BROWSE_CANARY_BASELINE_P95_MS
  );
  return {
    host,
    port,
    logLevel,
    roonTokenPath,
    imageCachePath,
    imageCacheMaxBytes,
    recentlyPlayedPath,
    recentlyPlayedCap,
    favoritesPath,
    retiredCatalogPath,
    browseCanaryEnabled,
    browseCanaryBaselineP95Ms,
  };
};
