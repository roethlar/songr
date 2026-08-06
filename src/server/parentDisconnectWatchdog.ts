/**
 * Parent-death watchdog for a forked engine process.
 *
 * The desktop shell forks this backend as a child. If the shell exits cleanly
 * it sends SIGTERM and waits, and the normal shutdown path runs. If the shell
 * is killed outright — SIGKILL, a crash, a force-quit — no signal reaches the
 * child, and without this the engine would keep running: still holding its
 * port, still registered with the Roon Core, invisible and unkillable from the
 * UI. The next launch would then meet a stale extension.
 *
 * Node closes a forked child's IPC channel when the parent dies, which the
 * child sees as a `disconnect` event. That is the death certificate this
 * watchdog waits for.
 *
 * The appliance install (systemd, Docker, `npm start`) has no IPC channel, so
 * `process.send` is undefined and attaching is a strict no-op — the same
 * IPC-presence guard `listeningHandshake.ts` uses, for the same reason.
 */

export interface WatchdogLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

/** The parts of `process` this module touches, so tests can supply a fake. */
export interface WatchdogProcess {
  readonly send?: unknown;
  readonly connected?: boolean;
  once(event: "disconnect", listener: () => void): unknown;
  exit(code?: number): unknown;
}

/**
 * How long the graceful shutdown gets before the watchdog exits the process
 * itself. Draining an HTTP server can block on a connection that will never
 * close, and "the engine must not outlive the shell" outranks a clean drain.
 */
export const DEFAULT_FORCE_EXIT_AFTER_MS = 5000;

export interface ParentDisconnectWatchdogOptions {
  /** The graceful shutdown to run. Expected to end the process on its own. */
  readonly onDisconnect: () => void;
  readonly logger?: WatchdogLogger;
  readonly forceExitAfterMs?: number;
  readonly proc?: WatchdogProcess;
  /** Injected for tests; the default timer is unref'd so it never holds the
   * event loop open when the graceful path wins the race. */
  readonly scheduleForceExit?: (callback: () => void, ms: number) => void;
}

const defaultScheduleForceExit = (callback: () => void, ms: number): void => {
  const timer = setTimeout(callback, ms);
  timer.unref();
};

/**
 * Arm the watchdog. Returns true when it was armed, false when there is no IPC
 * channel to watch (the appliance case).
 */
export const attachParentDisconnectWatchdog = (
  options: ParentDisconnectWatchdogOptions
): boolean => {
  const proc = options.proc ?? process;

  // No IPC channel means no parent to outlive: this process was started by an
  // init system or a shell, and its lifetime is not ours to police.
  if (typeof proc.send !== "function") {
    return false;
  }

  const {
    onDisconnect,
    logger,
    forceExitAfterMs = DEFAULT_FORCE_EXIT_AFTER_MS,
    scheduleForceExit = defaultScheduleForceExit,
  } = options;

  const handleDisconnect = (): void => {
    logger?.warn(
      {},
      "Parent process closed the IPC channel; shutting the engine down"
    );

    scheduleForceExit(() => {
      logger?.warn(
        { forceExitAfterMs },
        "Graceful shutdown did not finish after parent disconnect; exiting"
      );
      proc.exit(0);
    }, forceExitAfterMs);

    try {
      onDisconnect();
    } catch (error) {
      // A shutdown that throws must not leave the engine alive; that is the
      // exact orphan this watchdog exists to prevent.
      logger?.warn(
        { err: error },
        "Shutdown threw after parent disconnect; exiting immediately"
      );
      proc.exit(0);
    }
  };

  // The parent can die in the window between the fork and this call. Then the
  // channel is already closed and `disconnect` will never fire again, so the
  // already-orphaned case is handled here rather than waited for forever.
  if (proc.connected === false) {
    handleDisconnect();
    return true;
  }

  proc.once("disconnect", handleDisconnect);
  logger?.info({}, "Watching parent IPC channel for shell exit");
  return true;
};
