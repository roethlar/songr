import { ConfigError, loadConfig } from "./config/env";
import { createLogger } from "./core/logger";
import { attachParentDisconnectWatchdog } from "./server/parentDisconnectWatchdog";
import { startServer } from "./server/server";
import { createShutdownHandler } from "./server/shutdown";

const bootstrap = () => {
  try {
    const config = loadConfig();
    const logger = createLogger(config);

    logger.info("Bootstrapping Roon web controller");

    const context = startServer(config, logger);

    const shutdown = createShutdownHandler({ context, logger });

    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));

    // When the desktop shell forked us, its death closes our IPC channel and
    // we shut down with it. No IPC channel (appliance install) means no-op.
    attachParentDisconnectWatchdog({
      onDisconnect: () => void shutdown("parent-disconnect"),
      logger,
    });
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`Configuration error: ${error.message}`);
    } else {
      console.error("Fatal error during startup", error);
    }
    process.exit(1);
  }
};

bootstrap();
