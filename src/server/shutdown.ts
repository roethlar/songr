/**
 * The server's one shutdown sequence, extracted so its ordering is
 * testable (ms1-2): optional workspace-session cleanup is asynchronous and
 * MUST settle before the socket server closes underneath it — a
 * fire-and-forget start here let process exit race native cleanup.
 */
import type { Logger } from "pino";

export interface ShutdownContext {
  requestShutdown(): void;
  catalogLifecycle: { shutdown(): void };
  transportService: { shutdown(): void };
  workspaceFeatures: { shutdown(): Promise<void> };
  socketContext: { io: { close(done?: () => void): unknown } };
  isListening(): boolean;
  httpServer: { close(done: (error?: Error) => void): unknown };
}

export function createShutdownHandler(options: {
  context: ShutdownContext;
  logger: Logger;
  /** Injectable for tests; defaults to `process.exit`. */
  exit?: (code: number) => void;
}): (signal: string) => Promise<void> {
  const { context, logger } = options;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  return async (signal: string): Promise<void> => {
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

    // Close every optional workspace session BEFORE the sockets go away,
    // and wait for it: workspace cleanup retires native connections, and
    // exiting mid-retire abandons them at the Core (ms1-2).
    try {
      await context.workspaceFeatures.shutdown();
    } catch (error) {
      logger.warn({ err: error }, "Error while stopping workspace features");
    }

    void context.socketContext.io.close(() => {
      logger.info("Socket server closed");
    });

    if (!context.isListening()) {
      // Shutdown landed during the deferred-listen window. There's
      // no httpServer to close; just exit cleanly.
      logger.info("HTTP server never started listening; exiting");
      exit(0);
      return;
    }

    context.httpServer.close((error) => {
      if (error) {
        logger.error({ err: error }, "Error while closing HTTP server");
        exit(1);
      } else {
        logger.info("HTTP server closed");
        exit(0);
      }
    });
  };
}
