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
  readonly catalogPath: string;
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

  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new ConfigError("PORT must be an integer between 1 and 65535");
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

const parseTokenPath = (value: string | undefined): string => {
  const rawPath = coerceString(value) ?? "./config/roon-token.json";
  if (!rawPath) {
    throw new ConfigError("ROON_TOKEN_PATH cannot be empty");
  }
  return path.resolve(rawPath);
};

const parseImageCachePath = (value: string | undefined): string => {
  const rawPath = coerceString(value) ?? "./data/image-cache";
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

const parseRecentlyPlayedPath = (value: string | undefined): string => {
  const rawPath = coerceString(value) ?? "./data/recently-played.json";
  return path.resolve(rawPath);
};

const parseFavoritesPath = (value: string | undefined): string => {
  const rawPath = coerceString(value) ?? "./data/favorites.json";
  return path.resolve(rawPath);
};

const parseCatalogPath = (value: string | undefined): string => {
  const rawPath = coerceString(value) ?? "./data/catalog";
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

export const loadConfig = (): AppConfig => {
  const host = parseHost(process.env.HOST);
  const port = parsePort(process.env.PORT);
  const logLevel = parseLogLevel(process.env.LOG_LEVEL);
  const roonTokenPath = parseTokenPath(process.env.ROON_TOKEN_PATH);
  const imageCachePath = parseImageCachePath(process.env.IMAGE_CACHE_PATH);
  const imageCacheMaxBytes = parseImageCacheMaxBytes(process.env.IMAGE_CACHE_MAX_BYTES);
  const recentlyPlayedPath = parseRecentlyPlayedPath(
    process.env.RECENTLY_PLAYED_PATH
  );
  const recentlyPlayedCap = parseRecentlyPlayedCap(
    process.env.RECENTLY_PLAYED_CAP
  );
  const favoritesPath = parseFavoritesPath(process.env.FAVORITES_PATH);
  const catalogPath = parseCatalogPath(process.env.TIMELINE_CATALOG_PATH);
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
    catalogPath,
  };
};
