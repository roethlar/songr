import { ConfigError, loadConfig } from "./config/env";
import { createLogger } from "./core/logger";
import { startServer } from "./server/server";

const bootstrap = () => {
  try {
    const config = loadConfig();
    const logger = createLogger(config);

    logger.info("Bootstrapping Roon web controller");

    const context = startServer(config, logger);

    const shutdown = (signal: string) => {
      logger.info({ signal }, "Received shutdown signal");

      // Tell startServer to skip the deferred httpServer.listen if
      // RP startup hasn't completed yet. Without this, the listen
      // would still fire after our close() ran (or close() would
      // error because the server never bound).
      context.requestShutdown();

      try {
        context.catalogLifecycle.shutdown();
      } catch (error) {
        logger.warn({ err: error }, "Error while stopping catalog services");
      }

      // Tear down Roon subscriptions before closing transports so the Core
      // doesn't queue stale callbacks for this extension while it restarts.
      try {
        context.transportService.shutdown();
      } catch (error) {
        logger.warn({ err: error }, "Error while stopping transport service");
      }

      void context.socketContext.io.close(() => {
        logger.info("Socket server closed");
      });

      if (!context.isListening()) {
        // Shutdown landed during the deferred-listen window. There's
        // no httpServer to close; just exit cleanly.
        logger.info("HTTP server never started listening; exiting");
        process.exit(0);
        return;
      }

      context.httpServer.close((error) => {
        if (error) {
          logger.error({ err: error }, "Error while closing HTTP server");
          process.exit(1);
        } else {
          logger.info("HTTP server closed");
          process.exit(0);
        }
      });
    };

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
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
