import pino, { Logger } from "pino";
import { AppConfig } from "../config/env";

let loggerInstance: Logger | null = null;

/**
 * Whether the pretty transport can actually be loaded. `pino-pretty` is a
 * devDependency: a source checkout has it, but a production-pruned deployment
 * (the server tarball, the desktop app's engine payload) does not, and pino
 * throws at startup when told to use a transport that is not there. Pretty
 * logging is a convenience for a developer's terminal, so its absence must
 * degrade to plain JSON logs, never to a crash.
 */
export const prettyTransportAvailable = (
  resolve: (id: string) => unknown = require.resolve
): boolean => {
  if (process.env.NODE_ENV === "production") {
    return false;
  }
  try {
    resolve("pino-pretty");
    return true;
  } catch {
    return false;
  }
};

export const createLogger = (config: AppConfig): Logger => {
  if (loggerInstance) {
    return loggerInstance;
  }

  loggerInstance = pino({
    level: config.logLevel,
    transport: prettyTransportAvailable()
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:standard",
          },
        }
      : undefined,
  });

  return loggerInstance;
};
