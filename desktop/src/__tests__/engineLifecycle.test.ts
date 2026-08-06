/**
 * Lifecycle tests. Everything the supervisor waits on is injected, so these run
 * in zero real milliseconds and there is no polling, no flake and no ordering
 * left to chance.
 */

import {
  backoffDelayMs,
  EngineSupervisor,
} from '../engineLifecycle';
import type {
  EngineCallbacks,
  EngineFailure,
  EngineHandle,
  EngineState,
  LifecycleTimers,
} from '../engineLifecycle';

/** A hand-rolled clock: `advance` fires everything due, in due order. */
class FakeClock implements LifecycleTimers {
  #now = 0;
  #next = 1;
  readonly #scheduled = new Map<number, { at: number; callback: () => void }>();

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.#next;
    this.#next += 1;
    this.#scheduled.set(id, { at: this.#now + ms, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#scheduled.delete(handle as number);
  }

  get pendingCount(): number {
    return this.#scheduled.size;
  }

  advance(ms: number): void {
    const target = this.#now + ms;
    for (;;) {
      const due = [...this.#scheduled.entries()]
        .filter(([, entry]) => entry.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
      const first = due[0];
      if (first === undefined) {
        break;
      }
      const [id, entry] = first;
      this.#scheduled.delete(id);
      this.#now = entry.at;
      entry.callback();
    }
    this.#now = target;
  }
}

interface FakeChild {
  readonly callbacks: EngineCallbacks;
  readonly requestShutdown: jest.Mock<void, []>;
  readonly forceKill: jest.Mock<void, []>;
}

interface Harness {
  readonly clock: FakeClock;
  readonly children: FakeChild[];
  readonly states: EngineState[];
  readonly ready: number[];
  readonly retries: { failure: EngineFailure; retryInMs: number }[];
  readonly failures: EngineFailure[];
  readonly supervisor: EngineSupervisor;
  readonly spawnCount: () => number;
  readonly latest: () => FakeChild;
}

interface HarnessOptions {
  readonly listenTimeoutMs?: number;
  readonly shutdownGraceMs?: number;
  readonly maxRestartAttempts?: number;
  readonly backoffBaseMs?: number;
  readonly backoffMaxMs?: number;
  readonly stableRunMs?: number;
  /** Make the nth spawn (1-based) throw instead of producing a child. */
  readonly throwOnSpawn?: number;
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const clock = new FakeClock();
  const children: FakeChild[] = [];
  const states: EngineState[] = [];
  const ready: number[] = [];
  const retries: { failure: EngineFailure; retryInMs: number }[] = [];
  const failures: EngineFailure[] = [];
  let spawns = 0;

  const supervisor = new EngineSupervisor({
    timers: clock,
    listenTimeoutMs: options.listenTimeoutMs ?? 15_000,
    shutdownGraceMs: options.shutdownGraceMs ?? 5_000,
    maxRestartAttempts: options.maxRestartAttempts ?? 3,
    backoffBaseMs: options.backoffBaseMs ?? 500,
    backoffMaxMs: options.backoffMaxMs ?? 8_000,
    stableRunMs: options.stableRunMs ?? 60_000,
    spawn: (callbacks): EngineHandle => {
      spawns += 1;
      if (options.throwOnSpawn === spawns) {
        throw new Error('ENOENT: engine entry missing');
      }
      const child: FakeChild = {
        callbacks,
        requestShutdown: jest.fn(),
        forceKill: jest.fn(),
      };
      children.push(child);
      return {
        requestShutdown: child.requestShutdown,
        forceKill: child.forceKill,
      };
    },
    observer: {
      onStateChange: (state) => states.push(state),
      onReady: (port) => ready.push(port),
      onRetryScheduled: (failure, retryInMs) => retries.push({ failure, retryInMs }),
      onFailed: (failure) => failures.push(failure),
    },
  });

  return {
    clock,
    children,
    states,
    ready,
    retries,
    failures,
    supervisor,
    spawnCount: () => spawns,
    latest: () => {
      const child = children[children.length - 1];
      if (child === undefined) {
        throw new Error('no child spawned yet');
      }
      return child;
    },
  };
}

describe('backoffDelayMs', () => {
  it('doubles from the base and stops at the ceiling', () => {
    expect(backoffDelayMs(1, 500, 8_000)).toBe(500);
    expect(backoffDelayMs(2, 500, 8_000)).toBe(1_000);
    expect(backoffDelayMs(3, 500, 8_000)).toBe(2_000);
    expect(backoffDelayMs(6, 500, 8_000)).toBe(8_000);
    expect(backoffDelayMs(20, 500, 8_000)).toBe(8_000);
  });
});

describe('port handshake', () => {
  it('reaches running on the listening message and reports the port', () => {
    const h = makeHarness();
    h.supervisor.start();

    expect(h.supervisor.state).toBe('starting');
    expect(h.supervisor.port).toBeNull();

    h.latest().callbacks.onListening(52_143);

    expect(h.supervisor.state).toBe('running');
    expect(h.supervisor.port).toBe(52_143);
    expect(h.ready).toEqual([52_143]);
    expect(h.states).toEqual(['starting', 'running']);
  });

  it('ignores a second listening message and any later handshake noise', () => {
    const h = makeHarness();
    h.supervisor.start();
    h.latest().callbacks.onListening(41_000);
    h.latest().callbacks.onListening(41_999);

    expect(h.supervisor.port).toBe(41_000);
    expect(h.ready).toEqual([41_000]);
  });

  it('cancels the handshake timeout once the port arrives', () => {
    const h = makeHarness({ listenTimeoutMs: 15_000, stableRunMs: 60_000 });
    h.supervisor.start();
    h.latest().callbacks.onListening(3_000);

    h.clock.advance(15_001);

    expect(h.supervisor.state).toBe('running');
    expect(h.failures).toEqual([]);
    expect(h.spawnCount()).toBe(1);
  });
});

describe('handshake timeout', () => {
  it('kills the silent child and relaunches after the backoff delay', () => {
    const h = makeHarness({ listenTimeoutMs: 15_000, backoffBaseMs: 500 });
    h.supervisor.start();
    const first = h.latest();

    h.clock.advance(14_999);
    expect(h.supervisor.state).toBe('starting');

    h.clock.advance(1);
    expect(h.supervisor.state).toBe('backoff');
    expect(first.requestShutdown).toHaveBeenCalledTimes(1);
    expect(h.retries[0]?.failure.kind).toBe('listen-timeout');
    expect(h.retries[0]?.retryInMs).toBe(500);

    h.clock.advance(500);
    expect(h.spawnCount()).toBe(2);
    expect(h.supervisor.state).toBe('starting');

    h.latest().callbacks.onListening(9_100);
    expect(h.supervisor.state).toBe('running');
    expect(h.ready).toEqual([9_100]);
  });

  it('force-kills a child that ignores the shutdown request', () => {
    const h = makeHarness({ listenTimeoutMs: 1_000, shutdownGraceMs: 5_000 });
    h.supervisor.start();
    const first = h.latest();

    h.clock.advance(1_000);
    expect(first.requestShutdown).toHaveBeenCalledTimes(1);
    expect(first.forceKill).not.toHaveBeenCalled();

    h.clock.advance(5_000);
    expect(first.forceKill).toHaveBeenCalledTimes(1);
  });
});

describe('crash relaunch and the attempt cap', () => {
  it('relaunches a crashed engine with capped exponential backoff, then fails', () => {
    const h = makeHarness({
      maxRestartAttempts: 3,
      backoffBaseMs: 500,
      backoffMaxMs: 1_500,
    });
    h.supervisor.start();

    // Crash 1 -> 500ms, crash 2 -> 1000ms, crash 3 -> capped 1500ms.
    const expectedDelays = [500, 1_000, 1_500];
    for (const delay of expectedDelays) {
      h.latest().callbacks.onExit({ code: 1, signal: null });
      expect(h.supervisor.state).toBe('backoff');
      const scheduled = h.retries[h.retries.length - 1];
      expect(scheduled?.retryInMs).toBe(delay);
      h.clock.advance(delay);
      expect(h.supervisor.state).toBe('starting');
    }

    expect(h.spawnCount()).toBe(4);

    // The fourth death is past the budget: no more relaunches.
    h.latest().callbacks.onExit({ code: 1, signal: null });
    expect(h.supervisor.state).toBe('failed');
    expect(h.failures).toHaveLength(1);
    expect(h.failures[0]?.attempts).toBe(4);
    expect(h.failures[0]?.kind).toBe('exited');

    h.clock.advance(60_000);
    expect(h.spawnCount()).toBe(4);
  });

  it('treats a spawn that throws as a failed attempt', () => {
    const h = makeHarness({ throwOnSpawn: 1, backoffBaseMs: 500 });
    h.supervisor.start();

    expect(h.supervisor.state).toBe('backoff');
    expect(h.retries[0]?.failure.kind).toBe('spawn-error');
    expect(h.retries[0]?.failure.message).toContain('ENOENT');

    h.clock.advance(500);
    expect(h.spawnCount()).toBe(2);
    h.latest().callbacks.onListening(7_777);
    expect(h.supervisor.state).toBe('running');
  });

  it('never relaunches from an exit reported by an abandoned child', () => {
    const h = makeHarness({ listenTimeoutMs: 1_000, backoffBaseMs: 500 });
    h.supervisor.start();
    const abandoned = h.latest();

    h.clock.advance(1_000); // handshake timeout: this child is written off
    expect(h.supervisor.state).toBe('backoff');

    abandoned.callbacks.onExit({ code: null, signal: 'SIGKILL' });
    expect(h.supervisor.state).toBe('backoff');
    expect(h.retries).toHaveLength(1);

    h.clock.advance(500);
    expect(h.spawnCount()).toBe(2);

    // Late noise from the abandoned child cannot disturb the new one.
    abandoned.callbacks.onListening(1_234);
    expect(h.supervisor.port).toBeNull();
    expect(h.supervisor.state).toBe('starting');
  });

  it('forgives earlier crashes once an engine has run long enough', () => {
    const h = makeHarness({
      maxRestartAttempts: 3,
      backoffBaseMs: 500,
      stableRunMs: 60_000,
    });
    h.supervisor.start();

    h.latest().callbacks.onExit({ code: 1, signal: null });
    h.clock.advance(500);
    h.latest().callbacks.onExit({ code: 1, signal: null });
    h.clock.advance(1_000);
    expect(h.spawnCount()).toBe(3);

    h.latest().callbacks.onListening(6_000);
    h.clock.advance(60_000);

    // Two crashes ago no longer counts: the next one starts back at the base.
    h.latest().callbacks.onExit({ code: 1, signal: null });
    expect(h.retries[h.retries.length - 1]?.retryInMs).toBe(500);
    expect(h.retries[h.retries.length - 1]?.failure.attempts).toBe(1);
  });

  it('refills the budget when a human presses retry', () => {
    const h = makeHarness({ maxRestartAttempts: 1, backoffBaseMs: 500 });
    h.supervisor.start();

    h.latest().callbacks.onExit({ code: 1, signal: null });
    h.clock.advance(500);
    h.latest().callbacks.onExit({ code: 1, signal: null });
    expect(h.supervisor.state).toBe('failed');

    h.supervisor.retry();
    expect(h.supervisor.state).toBe('starting');
    expect(h.spawnCount()).toBe(3);

    h.latest().callbacks.onExit({ code: 1, signal: null });
    expect(h.supervisor.state).toBe('backoff');
    expect(h.retries[h.retries.length - 1]?.retryInMs).toBe(500);
  });
});

describe('shutdown', () => {
  it('asks first, kills only after the grace period, and reports stopped', async () => {
    const h = makeHarness({ shutdownGraceMs: 5_000 });
    h.supervisor.start();
    h.latest().callbacks.onListening(4_242);
    const child = h.latest();

    let resolved = false;
    const stopped = h.supervisor.stop().then(() => {
      resolved = true;
    });

    expect(h.supervisor.state).toBe('stopping');
    expect(child.requestShutdown).toHaveBeenCalledTimes(1);
    expect(child.forceKill).not.toHaveBeenCalled();

    h.clock.advance(4_999);
    expect(child.forceKill).not.toHaveBeenCalled();
    expect(resolved).toBe(false);

    h.clock.advance(1);
    expect(child.forceKill).toHaveBeenCalledTimes(1);

    child.callbacks.onExit({ code: null, signal: 'SIGKILL' });
    await stopped;

    expect(resolved).toBe(true);
    expect(h.supervisor.state).toBe('stopped');
    expect(h.supervisor.port).toBeNull();
    expect(h.states[h.states.length - 1]).toBe('stopped');
  });

  it('does not kill a child that exits inside the grace period', async () => {
    const h = makeHarness({ shutdownGraceMs: 5_000 });
    h.supervisor.start();
    h.latest().callbacks.onListening(4_242);
    const child = h.latest();

    const stopped = h.supervisor.stop();
    h.clock.advance(120);
    child.callbacks.onExit({ code: 0, signal: null });
    await stopped;

    h.clock.advance(10_000);
    expect(child.forceKill).not.toHaveBeenCalled();
    expect(h.supervisor.state).toBe('stopped');
  });

  it('never relaunches an engine that exits during shutdown', async () => {
    const h = makeHarness();
    h.supervisor.start();
    h.latest().callbacks.onListening(4_242);

    const stopped = h.supervisor.stop();
    h.latest().callbacks.onExit({ code: 1, signal: null });
    await stopped;

    h.clock.advance(60_000);
    expect(h.spawnCount()).toBe(1);
    expect(h.supervisor.state).toBe('stopped');
    expect(h.failures).toEqual([]);
  });

  it('cancels a pending relaunch and leaves no timers behind', async () => {
    const h = makeHarness({ backoffBaseMs: 500 });
    h.supervisor.start();
    h.latest().callbacks.onExit({ code: 1, signal: null });
    expect(h.supervisor.state).toBe('backoff');

    await h.supervisor.stop();

    expect(h.supervisor.state).toBe('stopped');
    h.clock.advance(60_000);
    expect(h.spawnCount()).toBe(1);
  });

  it('is safe to call twice and resolves both callers', async () => {
    const h = makeHarness({ shutdownGraceMs: 5_000 });
    h.supervisor.start();
    h.latest().callbacks.onListening(4_242);
    const child = h.latest();

    const first = h.supervisor.stop();
    const second = h.supervisor.stop();
    expect(child.requestShutdown).toHaveBeenCalledTimes(1);

    child.callbacks.onExit({ code: 0, signal: null });
    await Promise.all([first, second]);

    expect(h.supervisor.state).toBe('stopped');
    await expect(h.supervisor.stop()).resolves.toBeUndefined();
  });

  it('stops cleanly when nothing was ever started', async () => {
    const h = makeHarness();
    await h.supervisor.stop();
    expect(h.supervisor.state).toBe('stopped');
    expect(h.spawnCount()).toBe(0);
  });
});

describe('winding-down children (dt2-1)', () => {
  it('kills an abandoned child synchronously when stop() runs inside its grace window', async () => {
    const h = makeHarness();
    h.supervisor.start();
    const hung = h.latest();

    // Listen timeout: the child is abandoned with SIGTERM sent and a
    // deferred SIGKILL armed; a relaunch is waiting in backoff.
    h.clock.advance(15_000);
    expect(hung.requestShutdown).toHaveBeenCalledTimes(1);
    expect(hung.forceKill).not.toHaveBeenCalled();

    // Quit before either timer fires: the corpse must die NOW, not on a
    // timer that will never run once the main process exits.
    await h.supervisor.stop();
    expect(hung.forceKill).toHaveBeenCalledTimes(1);
    expect(h.clock.pendingCount).toBe(0);
    expect(h.supervisor.state).toBe('stopped');
  });

  it('does not kill again a corpse whose own grace timer already fired', () => {
    const h = makeHarness();
    h.supervisor.start();
    const hung = h.latest();

    h.clock.advance(15_000);
    // Backoff relaunch happens at +500ms; the corpse timer fires at +5s.
    h.clock.advance(5_000);
    expect(hung.forceKill).toHaveBeenCalledTimes(1);

    void h.supervisor.stop();
    expect(hung.forceKill).toHaveBeenCalledTimes(1);
  });
});

describe('corpse exits during stop (dt3-1)', () => {
  it('ignores a swept corpse exit and keeps waiting for the live child', async () => {
    const h = makeHarness();
    h.supervisor.start();
    const corpse = h.latest();

    // Abandon the first child (listen timeout), relaunch, reach running.
    h.clock.advance(15_000);
    h.clock.advance(500);
    const live = h.latest();
    expect(live).not.toBe(corpse);
    live.callbacks.onListening(52_000);
    expect(h.supervisor.state).toBe('running');

    let stopResolved = false;
    const stopPromise = h.supervisor.stop().then(() => {
      stopResolved = true;
    });
    expect(h.supervisor.state).toBe('stopping');
    expect(corpse.forceKill).toHaveBeenCalledTimes(1);

    // The swept corpse's exit event lands during the stopping window. It
    // must not clear the grace timer, resolve the stop, or touch state.
    corpse.callbacks.onExit({ code: null, signal: 'SIGKILL' });
    await Promise.resolve();
    expect(stopResolved).toBe(false);
    expect(h.supervisor.state).toBe('stopping');

    // Only the live child ends the stop.
    live.callbacks.onExit({ code: 0, signal: null });
    await stopPromise;
    expect(stopResolved).toBe(true);
    expect(h.supervisor.state).toBe('stopped');
  });
});
