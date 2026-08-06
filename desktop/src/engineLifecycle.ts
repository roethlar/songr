/**
 * Engine lifecycle state machine — pure, no Electron and no Node child-process
 * APIs.
 *
 * The desktop shell runs the controller backend ("the engine") as a child
 * process and points a window at it. Everything about *when* to spawn, how long
 * to wait for the port handshake, when to give up, how long to wait between
 * relaunch attempts and in what order to tear the child down lives here, behind
 * injected ports (`spawn`, `timers`). `main.ts` supplies the Electron-flavoured
 * implementations of those ports; the tests supply fakes.
 *
 * The split exists so the part that is easy to get wrong — ordering and timing —
 * is unit-testable without launching a browser or a real server.
 *
 * States:
 *   idle       nothing spawned yet
 *   starting   child spawned, waiting for the `listening` handshake
 *   running    handshake received, engine reachable on `port`
 *   backoff    child died or never reported; waiting to relaunch
 *   stopping   deliberate shutdown in progress (never relaunches)
 *   stopped    deliberate shutdown finished
 *   failed     relaunch budget exhausted; the shell shows its error state
 */

export type EngineState =
  | 'idle'
  | 'starting'
  | 'running'
  | 'backoff'
  | 'stopping'
  | 'stopped'
  | 'failed';

export interface EngineExit {
  readonly code: number | null;
  readonly signal: string | null;
}

/** How a launch attempt ended badly. */
export type EngineFailureKind =
  /** `spawn` threw, or the child emitted an error before doing anything. */
  | 'spawn-error'
  /** No `listening` message arrived inside the handshake timeout. */
  | 'listen-timeout'
  /** The child exited on its own while the shell wanted it alive. */
  | 'exited';

export interface EngineFailure {
  readonly kind: EngineFailureKind;
  readonly message: string;
  /** Consecutive failed attempts including this one. */
  readonly attempts: number;
}

/**
 * A spawned child, reduced to the two things the state machine does to it.
 * Deliberately not a `ChildProcess`: the machine must not know about signals,
 * IPC channels or platform quirks.
 */
export interface EngineHandle {
  /** Ask the engine to shut down cleanly (SIGTERM on POSIX). */
  requestShutdown(): void;
  /** Kill it outright, after the grace period expired. */
  forceKill(): void;
}

/** Callbacks a spawn implementation must drive. */
export interface EngineCallbacks {
  /** The engine reported the port it bound to. */
  onListening(port: number): void;
  /** The child process ended, for any reason. */
  onExit(exit: EngineExit): void;
  /** The child could not be spawned, or errored before exiting. */
  onError(error: Error): void;
}

export type SpawnEngine = (callbacks: EngineCallbacks) => EngineHandle;

export type TimerHandle = unknown;

/** The four things this machine ever waits on. */
type TimerSlot = 'listen' | 'backoff' | 'grace' | 'stability';

/** Injected clock, so tests never wait in real time. */
export interface LifecycleTimers {
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

const realTimers: LifecycleTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export interface LifecycleObserver {
  /** Every state transition, in order. */
  onStateChange?(state: EngineState, previous: EngineState): void;
  /** The engine is up and reachable on `port`. */
  onReady?(port: number): void;
  /** A launch attempt failed; a relaunch is scheduled in `retryInMs`. */
  onRetryScheduled?(failure: EngineFailure, retryInMs: number): void;
  /** The relaunch budget is gone. Nothing more happens without `retry()`. */
  onFailed?(failure: EngineFailure): void;
}

export interface EngineSupervisorOptions {
  readonly spawn: SpawnEngine;
  readonly timers?: LifecycleTimers;
  readonly observer?: LifecycleObserver;
  /** How long to wait for the `listening` handshake. Default 15s. */
  readonly listenTimeoutMs?: number;
  /** How long a shutdown request has before the child is killed. Default 5s. */
  readonly shutdownGraceMs?: number;
  /** Relaunches allowed after consecutive failures. Default 3. */
  readonly maxRestartAttempts?: number;
  /** First relaunch delay; doubles per consecutive failure. Default 500ms. */
  readonly backoffBaseMs?: number;
  /** Ceiling for the doubling. Default 8s. */
  readonly backoffMaxMs?: number;
  /**
   * How long a running engine must survive before its predecessors' failures
   * stop counting. Without this an app left open for weeks would spend its
   * three-relaunch budget on three unrelated crashes and then refuse to
   * recover. Default 60s.
   */
  readonly stableRunMs?: number;
}

const DEFAULTS = {
  listenTimeoutMs: 15_000,
  shutdownGraceMs: 5_000,
  maxRestartAttempts: 3,
  backoffBaseMs: 500,
  backoffMaxMs: 8_000,
  stableRunMs: 60_000,
} as const;

/**
 * Relaunch delay for the nth consecutive failure (n starting at 1), doubling
 * from the base and capped.
 */
export function backoffDelayMs(
  attempt: number,
  baseMs: number,
  maxMs: number,
): number {
  const uncapped = baseMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(uncapped, maxMs);
}

function describeExit(exit: EngineExit): string {
  if (exit.signal !== null) {
    return `engine exited on signal ${exit.signal}`;
  }
  if (exit.code !== null) {
    return `engine exited with code ${String(exit.code)}`;
  }
  return 'engine exited';
}

export class EngineSupervisor {
  readonly #spawn: SpawnEngine;
  readonly #timers: LifecycleTimers;
  readonly #observer: LifecycleObserver;
  readonly #listenTimeoutMs: number;
  readonly #shutdownGraceMs: number;
  readonly #maxRestartAttempts: number;
  readonly #backoffBaseMs: number;
  readonly #backoffMaxMs: number;
  readonly #stableRunMs: number;

  #state: EngineState = 'idle';
  #handle: EngineHandle | null = null;
  #port: number | null = null;
  #consecutiveFailures = 0;
  #lastFailure: EngineFailure | null = null;

  /**
   * Bumped on every launch and on every failure. Callbacks captured by an
   * earlier generation are ignored, so a child that dies *after* we already
   * gave up on it cannot drive a second relaunch.
   */
  #generation = 0;

  readonly #pending: Record<TimerSlot, TimerHandle | null> = {
    listen: null,
    backoff: null,
    grace: null,
    stability: null,
  };

  #stopWaiters: (() => void)[] = [];

  /**
   * Children handed a shutdown request by `#fail` and abandoned for relaunch
   * purposes, but not yet confirmed dead. Tracked so a deliberate `stop()`
   * can kill them synchronously instead of leaving their SIGKILL timers to
   * die with the main process (dt2-1).
   */
  #windingDown: { handle: EngineHandle; timer: TimerHandle }[] = [];

  constructor(options: EngineSupervisorOptions) {
    this.#spawn = options.spawn;
    this.#timers = options.timers ?? realTimers;
    this.#observer = options.observer ?? {};
    this.#listenTimeoutMs = options.listenTimeoutMs ?? DEFAULTS.listenTimeoutMs;
    this.#shutdownGraceMs = options.shutdownGraceMs ?? DEFAULTS.shutdownGraceMs;
    this.#maxRestartAttempts =
      options.maxRestartAttempts ?? DEFAULTS.maxRestartAttempts;
    this.#backoffBaseMs = options.backoffBaseMs ?? DEFAULTS.backoffBaseMs;
    this.#backoffMaxMs = options.backoffMaxMs ?? DEFAULTS.backoffMaxMs;
    this.#stableRunMs = options.stableRunMs ?? DEFAULTS.stableRunMs;
  }

  get state(): EngineState {
    return this.#state;
  }

  /** The port the engine reported, or null when it is not running. */
  get port(): number | null {
    return this.#port;
  }

  get lastFailure(): EngineFailure | null {
    return this.#lastFailure;
  }

  /** First launch. A no-op once something is already in flight. */
  start(): void {
    if (this.#state !== 'idle' && this.#state !== 'stopped') {
      return;
    }
    this.#consecutiveFailures = 0;
    this.#lastFailure = null;
    this.#launch();
  }

  /**
   * Manual relaunch from the error state — what the error page's retry button
   * calls. The failure budget is refilled, because a human asked.
   */
  retry(): void {
    if (this.#state !== 'failed') {
      return;
    }
    this.#consecutiveFailures = 0;
    this.#lastFailure = null;
    this.#launch();
  }

  /**
   * Deliberate shutdown. Resolves once the child is gone (or immediately when
   * there is nothing to stop). Ordering: request a clean shutdown, wait up to
   * the grace period, then kill.
   */
  stop(): Promise<void> {
    // Whatever else this call does, no abandoned child may outlive the quit:
    // their deferred SIGKILL timers would die with the main process (dt2-1).
    this.#sweepWindingDown();

    if (this.#state === 'stopped') {
      return Promise.resolve();
    }

    if (this.#state === 'stopping') {
      return new Promise((resolve) => this.#stopWaiters.push(resolve));
    }

    this.#clearTimer('listen');
    this.#clearTimer('backoff');
    this.#clearTimer('stability');

    if (this.#handle === null) {
      // idle, backoff or failed: nothing is alive to wind down.
      this.#setState('stopped');
      return Promise.resolve();
    }

    this.#setState('stopping');
    const promise = new Promise<void>((resolve) => {
      this.#stopWaiters.push(resolve);
    });

    const handle = this.#handle;
    handle.requestShutdown();
    this.#arm('grace', this.#shutdownGraceMs, () => {
      handle.forceKill();
    });

    return promise;
  }

  #launch(): void {
    this.#generation += 1;
    const generation = this.#generation;
    this.#port = null;
    this.#setState('starting');

    const callbacks: EngineCallbacks = {
      onListening: (port) => {
        this.#onListening(generation, port);
      },
      onExit: (exit) => {
        this.#onExit(generation, exit);
      },
      onError: (error) => {
        this.#onError(generation, error);
      },
    };

    try {
      this.#handle = this.#spawn(callbacks);
    } catch (error) {
      this.#handle = null;
      const message = error instanceof Error ? error.message : String(error);
      this.#fail(generation, 'spawn-error', `could not spawn engine: ${message}`);
      return;
    }

    this.#arm('listen', this.#listenTimeoutMs, () => {
      this.#fail(
        generation,
        'listen-timeout',
        `engine did not report a port within ${String(this.#listenTimeoutMs)}ms`,
      );
    });
  }

  #onListening(generation: number, port: number): void {
    if (generation !== this.#generation || this.#state !== 'starting') {
      return;
    }
    this.#clearTimer('listen');
    this.#port = port;
    this.#setState('running');
    this.#observer.onReady?.(port);

    this.#arm('stability', this.#stableRunMs, () => {
      this.#consecutiveFailures = 0;
    });
  }

  #onExit(generation: number, exit: EngineExit): void {
    if (generation !== this.#generation) {
      // A corpse from an abandoned generation. Checked BEFORE the stopping
      // branch: the sweep guarantees corpse exits arrive during 'stopping',
      // and one of them clearing the grace timer and resolving the stop
      // waiters would let quit proceed while the live engine still runs
      // (dt3-1). The live child always carries the current generation —
      // stop() never bumps it.
      return;
    }
    if (this.#state === 'stopping') {
      // Ordering matters: a child that exits inside the grace period must not
      // be killed afterwards, and must never trigger a relaunch.
      this.#clearTimer('grace');
      this.#handle = null;
      this.#port = null;
      this.#setState('stopped');
      this.#resolveStopWaiters();
      return;
    }
    this.#fail(generation, 'exited', describeExit(exit));
  }

  #onError(generation: number, error: Error): void {
    if (generation !== this.#generation || this.#state === 'stopping') {
      return;
    }
    this.#fail(generation, 'spawn-error', `engine process error: ${error.message}`);
  }

  #fail(generation: number, kind: EngineFailureKind, message: string): void {
    if (generation !== this.#generation) {
      return;
    }
    // Invalidate this generation first: whatever the dying child emits next is
    // history, not a new event.
    this.#generation += 1;
    this.#clearTimer('listen');
    this.#clearTimer('stability');
    this.#port = null;

    const handle = this.#handle;
    this.#handle = null;
    if (handle !== null && kind !== 'exited') {
      // The child is still alive but useless to us (it never reported a port,
      // or it errored). Wind it down on the same ask-then-kill ordering a
      // deliberate shutdown uses, but do not wait for it: the relaunch runs on
      // its own ephemeral port and cannot collide with the corpse. The kill
      // timer is tracked so `stop()` can collapse it synchronously (dt2-1).
      handle.requestShutdown();
      const entry: { handle: EngineHandle; timer: TimerHandle } = {
        handle,
        timer: this.#timers.setTimeout(() => {
          this.#windingDown = this.#windingDown.filter((e) => e !== entry);
          handle.forceKill();
        }, this.#shutdownGraceMs),
      };
      this.#windingDown.push(entry);
    }

    this.#consecutiveFailures += 1;
    const failure: EngineFailure = {
      kind,
      message,
      attempts: this.#consecutiveFailures,
    };
    this.#lastFailure = failure;

    if (this.#consecutiveFailures > this.#maxRestartAttempts) {
      this.#setState('failed');
      this.#observer.onFailed?.(failure);
      return;
    }

    const delay = backoffDelayMs(
      this.#consecutiveFailures,
      this.#backoffBaseMs,
      this.#backoffMaxMs,
    );
    this.#setState('backoff');
    this.#observer.onRetryScheduled?.(failure, delay);
    this.#arm('backoff', delay, () => {
      this.#launch();
    });
  }

  #arm(slot: TimerSlot, ms: number, callback: () => void): void {
    this.#clearTimer(slot);
    this.#pending[slot] = this.#timers.setTimeout(() => {
      this.#pending[slot] = null;
      callback();
    }, ms);
  }

  #clearTimer(slot: TimerSlot): void {
    const handle = this.#pending[slot];
    if (handle === null) {
      return;
    }
    this.#pending[slot] = null;
    this.#timers.clearTimeout(handle);
  }

  /** Kill every abandoned child now and cancel its deferred SIGKILL. */
  #sweepWindingDown(): void {
    const entries = this.#windingDown;
    this.#windingDown = [];
    for (const entry of entries) {
      this.#timers.clearTimeout(entry.timer);
      entry.handle.forceKill();
    }
  }

  #resolveStopWaiters(): void {
    const waiters = this.#stopWaiters;
    this.#stopWaiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  }

  #setState(next: EngineState): void {
    if (next === this.#state) {
      return;
    }
    const previous = this.#state;
    this.#state = next;
    this.#observer.onStateChange?.(next, previous);
  }
}
