/**
 * The server's one shutdown sequence, extracted so its ordering is testable.
 */
import type { Logger } from "pino";

export interface ShutdownContext {
  requestShutdown(): void;
  /**
   * The post-connect load trial's browse canary, when this run has one. Null
   * or absent in every ordinary install; stopped first so a shutting-down
   * process cannot issue one more probe at a Core it is leaving.
   */
  browseCanary?: { stop(): void } | null;
  /**
   * The background-load gate. Stopped alongside the canary and for the same
   * reason: its half-open probe is a Core call, and a shutting-down process
   * must not have one armed behind it.
   */
  corePressureBreaker?: { stop(): void } | null;
  /**
   * The live library session, when this run has one. Closed before the
   * Core-scoped services it rides on: its refresh timer is the one thing here
   * that could still ask a departing process to read a library.
   */
  liveLibrary?: { close(): void } | null;
  coreLifecycle: { shutdown(): void };
  transportService: { shutdown(): void };
  socketContext: { io: { close(done?: () => void): unknown } };
  isListening(): boolean;
  httpServer: { close(done: (error?: Error) => void): unknown };
}

export function createShutdownHandler(options: {
  context: ShutdownContext;
  logger: Logger;
  /** Injectable for tests; defaults to `process.exit`. */
  exit?: (code: number) => void;
}): (signal: string) => void {
  const { context, logger } = options;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  return (signal: string): void => {
    logger.info({ signal }, "Received shutdown signal");

    // Tell startServer to skip the deferred httpServer.listen if
    // RP startup hasn't completed yet. Without this, the listen
    // would still fire after our close() ran (or close() would
    // error because the server never bound).
    context.requestShutdown();

    try {
      context.browseCanary?.stop();
    } catch (error) {
      logger.warn({ err: error }, "Error while stopping the browse canary");
    }

    try {
      context.corePressureBreaker?.stop();
    } catch (error) {
      logger.warn(
        { err: error },
        "Error while stopping the core pressure breaker"
      );
    }

    try {
      context.liveLibrary?.close();
    } catch (error) {
      logger.warn({ err: error }, "Error while closing the live library");
    }

    try {
      context.coreLifecycle.shutdown();
    } catch (error) {
      logger.warn({ err: error }, "Error while stopping Core-scoped services");
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
