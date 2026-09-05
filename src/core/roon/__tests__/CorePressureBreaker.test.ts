/**
 * The B5 pressure breaker (`.agents/plans/core-wedge-postconnect.md`).
 *
 * The breaker is a state machine over a clock and a probe, so everything here
 * runs on fake timers with an injected `now`. What each case is really
 * pinning is one of the four claims the plan makes for this slice: that a
 * trip both refuses new work AND cancels what is running; that recovery
 * needs a real answer from the Core rather than the passage of time; that
 * the open state survives the unpair the pressure itself provokes; and that
 * a different Core owes nothing to the last one's trouble.
 */
import type { Logger } from "pino";

import {
  BROWSE_CANARY_HIERARCHY,
  BROWSE_CANARY_SESSION_KEY,
} from "../BrowseCanaryService";
import {
  CORE_PRESSURE_PROBE_SESSION_KEY,
  CorePressureBreaker,
  type CorePressureSubscriber,
} from "../CorePressureBreaker";
import { RoonTimeoutError } from "../errors";

const CORE_ID = "core-a";
const OTHER_CORE_ID = "core-b";
const BASELINE_P95_MS = 100;
/** 3 × the baseline; the breaker's own default multiple. */
const THRESHOLD_MS = 300;
const BACKOFF_MS = 1_000;
const PROBE_TIMEOUT_MS = 15_000;
/**
 * How far the harness moves the clock per step. It bounds the finest latency
 * the tests can express, so it has to sit well under the threshold: a probe
 * that answers "instantly" still reads as one step of latency, and a step
 * above the threshold would make every recovery look like a slow one.
 */
const CLOCK_STEP_MS = 100;

function testLogger(): Logger {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
    fatal: jest.fn(),
  } as unknown as Logger;
}

/** A subscriber that records what the breaker did to it, and when. */
function recordingSubscriber(
  workload: CorePressureSubscriber["workload"]
): CorePressureSubscriber & {
  suspends: string[];
  resumes: string[];
} {
  const suspends: string[] = [];
  const resumes: string[] = [];
  return {
    workload,
    suspends,
    resumes,
    suspend: (coreId: string) => suspends.push(coreId),
    resume: (coreId: string) => resumes.push(coreId),
  };
}

interface ProbeAnswer {
  /** How long the probe takes to answer, on the test's clock. */
  latencyMs: number;
  /** Absent means it resolves; present means it rejects with this. */
  reject?: unknown;
}

function harness(options: {
  baselineP95Ms?: number | null;
  /** Answer for probe n (1-based). Absent entries repeat the last one. */
  answers?: ProbeAnswer[];
  canary?: { suspend: jest.Mock; resume: jest.Mock };
}): {
  breaker: CorePressureBreaker;
  logger: Logger;
  probes: { hierarchy: string; key: string }[];
  advance: (ms: number) => Promise<void>;
} {
  let clock = 1_000_000;
  const probes: { hierarchy: string; key: string }[] = [];
  const answers = options.answers ?? [];
  const logger = testLogger();
  const breaker = new CorePressureBreaker({
    probe: {
      reRoot: (hierarchy: string, key: string): Promise<void> => {
        probes.push({ hierarchy, key });
        const answer =
          answers[probes.length - 1] ??
          answers[answers.length - 1] ?? { latencyMs: 10 };
        // The answer lands on the test's own clock: the probe is timed by
        // `now`, so a latency has to be expressed as a delay in fake time,
        // not as a real one.
        return new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            if (answer.reject !== undefined) reject(answer.reject);
            else resolve();
          }, answer.latencyMs);
          if (typeof timer === "object" && "unref" in timer) timer.unref();
        });
      },
    },
    logger,
    baselineP95Ms:
      options.baselineP95Ms === undefined
        ? BASELINE_P95_MS
        : options.baselineP95Ms,
    now: () => clock,
    backoffInitialMs: BACKOFF_MS,
    probeTimeoutMs: PROBE_TIMEOUT_MS,
    ...(options.canary ? { canary: options.canary } : {}),
  });
  // Paired before the test body runs, because the breaker only acts on
  // reports about the Core paired right now and every case below is about a
  // Core that IS paired. The cases that turn on the fence itself re-pair or
  // unpair explicitly, so this default hides nothing from them.
  breaker.onCorePaired(CORE_ID);
  const advance = async (ms: number): Promise<void> => {
    // Stepped, so a probe's answer and the timer that follows it never land
    // inside one jump; the settle is a microtask and a coarse jump would run
    // the next arming before the previous answer had been heard.
    const step = CLOCK_STEP_MS;
    let moved = 0;
    do {
      const delta = Math.min(step, ms - moved);
      clock += delta;
      jest.advanceTimersByTime(delta);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      moved += delta;
    } while (moved < ms);
  };
  return { breaker, logger, probes, advance };
}

describe("the core pressure breaker", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("admits every background workload while it is closed", () => {
    const { breaker } = harness({});
    expect(breaker.admit(CORE_ID, "catalog-refresh")).toBe(true);
    expect(breaker.admit(CORE_ID, "artist-album-binding")).toBe(true);
    expect(breaker.admit(CORE_ID, "catalog-walk")).toBe(true);
    expect(breaker.stateFor(CORE_ID)).toBe("closed");
  });

  it("trips on a single browse timeout and refuses every workload", () => {
    const { breaker } = harness({});
    breaker.reportPressure(CORE_ID, { source: "browse-canary", kind: "timeout" });
    expect(breaker.stateFor(CORE_ID)).toBe("open");
    expect(breaker.admit(CORE_ID, "catalog-refresh")).toBe(false);
    expect(breaker.admit(CORE_ID, "artist-album-binding")).toBe(false);
    expect(breaker.admit(CORE_ID, "catalog-walk")).toBe(false);
  });

  it("cancels work already running, not just the work not yet started", () => {
    const { breaker } = harness({});
    const refresh = recordingSubscriber("catalog-refresh");
    const binding = recordingSubscriber("artist-album-binding");
    breaker.register(refresh);
    breaker.register(binding);
    breaker.reportPressure(CORE_ID, {
      source: "artist-album-binding",
      kind: "connection-lost",
    });
    // The whole point of the slice: a gate that only declined the next pass
    // would leave ten minutes of reads running against the Core it has just
    // declared overloaded.
    expect(refresh.suspends).toEqual([CORE_ID]);
    expect(binding.suspends).toEqual([CORE_ID]);
    expect(refresh.resumes).toEqual([]);
  });

  it("trips only after latency is sustained, never on one slow sample", () => {
    const { breaker } = harness({});
    breaker.reportLatency(CORE_ID, { source: "browse-canary", latencyMs: THRESHOLD_MS + 1 });
    expect(breaker.stateFor(CORE_ID)).toBe("closed");
    breaker.reportLatency(CORE_ID, { source: "browse-canary", latencyMs: THRESHOLD_MS + 1 });
    expect(breaker.stateFor(CORE_ID)).toBe("closed");
    breaker.reportLatency(CORE_ID, { source: "browse-canary", latencyMs: THRESHOLD_MS + 1 });
    expect(breaker.stateFor(CORE_ID)).toBe("open");
  });

  it("lets one good sample break the run", () => {
    const { breaker } = harness({});
    breaker.reportLatency(CORE_ID, { source: "browse-canary", latencyMs: THRESHOLD_MS + 1 });
    breaker.reportLatency(CORE_ID, { source: "browse-canary", latencyMs: THRESHOLD_MS + 1 });
    breaker.reportLatency(CORE_ID, { source: "browse-canary", latencyMs: THRESHOLD_MS });
    breaker.reportLatency(CORE_ID, { source: "browse-canary", latencyMs: THRESHOLD_MS + 1 });
    breaker.reportLatency(CORE_ID, { source: "browse-canary", latencyMs: THRESHOLD_MS + 1 });
    expect(breaker.stateFor(CORE_ID)).toBe("closed");
  });

  it("runs no latency rule at all without a configured baseline", () => {
    const { breaker } = harness({ baselineP95Ms: null });
    for (let index = 0; index < 20; index += 1) {
      breaker.reportLatency(CORE_ID, { source: "browse-canary", latencyMs: 60_000 });
    }
    // Deliberate: a threshold invented from a degraded run's own samples
    // would make the degradation look normal to itself. Hard signals still
    // work, which is what keeps the breaker useful on a stock install.
    expect(breaker.stateFor(CORE_ID)).toBe("closed");
    breaker.reportPressure(CORE_ID, { source: "catalog-refresh", kind: "timeout" });
    expect(breaker.stateFor(CORE_ID)).toBe("open");
  });

  it("probes once, on the canary's request shape and its own session", async () => {
    const { breaker, probes, advance } = harness({});
    breaker.reportPressure(CORE_ID, { source: "browse-canary", kind: "timeout" });
    expect(probes).toHaveLength(0);
    await advance(BACKOFF_MS);
    expect(probes).toEqual([
      {
        hierarchy: BROWSE_CANARY_HIERARCHY,
        key: CORE_PRESSURE_PROBE_SESSION_KEY,
      },
    ]);
    // Same hierarchy as the canary, so the two are measuring the same thing;
    // a different session, so the probe cannot inherit or disturb the
    // canary's browse position.
    expect(CORE_PRESSURE_PROBE_SESSION_KEY).not.toBe(BROWSE_CANARY_SESSION_KEY);
  });

  it("closes on a probe that answers inside the threshold, and re-authorizes the workloads", async () => {
    const { breaker, advance } = harness({ answers: [{ latencyMs: 50 }] });
    const refresh = recordingSubscriber("catalog-refresh");
    breaker.register(refresh);
    breaker.reportPressure(CORE_ID, { source: "browse-canary", kind: "timeout" });
    await advance(BACKOFF_MS + 1_000);
    expect(breaker.stateFor(CORE_ID)).toBe("closed");
    expect(refresh.resumes).toEqual([CORE_ID]);
    expect(breaker.admit(CORE_ID, "catalog-refresh")).toBe(true);
  });

  it("does not close on a probe that answers but is still too slow", async () => {
    const { breaker, advance } = harness({
      answers: [{ latencyMs: THRESHOLD_MS + 5_000 }],
    });
    breaker.reportPressure(CORE_ID, { source: "browse-canary", kind: "timeout" });
    await advance(BACKOFF_MS + THRESHOLD_MS + 6_000);
    // An answer is not a recovery. A Core that takes six seconds to answer a
    // root re-root is the condition the breaker exists for, and closing on
    // it would re-admit the burst into exactly that.
    expect(breaker.stateFor(CORE_ID)).toBe("open");
  });

  it("doubles the wait after each failed probe", async () => {
    const { breaker, probes, advance } = harness({
      answers: [
        { latencyMs: 10, reject: new RoonTimeoutError("browse.browse", PROBE_TIMEOUT_MS) },
      ],
    });
    breaker.reportPressure(CORE_ID, { source: "browse-canary", kind: "timeout" });
    await advance(BACKOFF_MS + 1_000);
    expect(probes).toHaveLength(1);
    // The second probe is two backoffs away, not one: at one backoff after
    // the first, nothing has been issued yet.
    await advance(BACKOFF_MS);
    expect(probes).toHaveLength(1);
    await advance(BACKOFF_MS + 1_000);
    expect(probes).toHaveLength(2);
  });

  it("re-trips after recovering, and starts its backoff over", async () => {
    const { breaker, probes, advance } = harness({ answers: [{ latencyMs: 20 }] });
    breaker.reportPressure(CORE_ID, { source: "browse-canary", kind: "timeout" });
    await advance(BACKOFF_MS + 1_000);
    expect(breaker.stateFor(CORE_ID)).toBe("closed");
    expect(breaker.tripsFor(CORE_ID)).toBe(1);

    breaker.reportPressure(CORE_ID, { source: "catalog-refresh", kind: "timeout" });
    expect(breaker.stateFor(CORE_ID)).toBe("open");
    expect(breaker.tripsFor(CORE_ID)).toBe(2);
    const before = probes.length;
    // One backoff, not the doubled one the previous open interval had
    // reached: a recovery that held is not evidence about the next fault.
    await advance(BACKOFF_MS + 1_000);
    expect(probes.length).toBe(before + 1);
  });

  it("keeps the open state and the backoff across a re-pair to the same Core", async () => {
    const { breaker, probes, advance } = harness({
      answers: [
        { latencyMs: 10, reject: new RoonTimeoutError("browse.browse", PROBE_TIMEOUT_MS) },
        { latencyMs: 10, reject: new RoonTimeoutError("browse.browse", PROBE_TIMEOUT_MS) },
        { latencyMs: 20 },
      ],
    });
    breaker.onCorePaired(CORE_ID);
    breaker.reportPressure(CORE_ID, { source: "browse-canary", kind: "timeout" });
    await advance(BACKOFF_MS + 1_000);
    expect(probes).toHaveLength(1);

    // The failure mode this whole property exists for: the pressure itself
    // drops the extension session.
    breaker.onCoreUnpaired();
    await advance(BACKOFF_MS * 4);
    expect(probes).toHaveLength(1);
    expect(breaker.stateFor(CORE_ID)).toBe("open");
    expect(breaker.admit(CORE_ID, "catalog-refresh")).toBe(false);

    breaker.onCorePaired(CORE_ID);
    // Still open, still requiring a probe: the re-pair did not itself count
    // as recovery. And the wait is the DOUBLED one the failed probe earned,
    // so nothing about the unpair discounted the backoff.
    expect(breaker.stateFor(CORE_ID)).toBe("open");
    await advance(BACKOFF_MS);
    expect(probes).toHaveLength(1);
    await advance(BACKOFF_MS + 1_000);
    expect(probes).toHaveLength(2);
    expect(breaker.stateFor(CORE_ID)).toBe("open");
  });

  it("still requires a successful probe after the re-pair before it closes", async () => {
    const { breaker, advance } = harness({ answers: [{ latencyMs: 20 }] });
    breaker.onCorePaired(CORE_ID);
    breaker.reportPressure(CORE_ID, { source: "browse-canary", kind: "timeout" });
    breaker.onCoreUnpaired();
    breaker.onCorePaired(CORE_ID);
    expect(breaker.stateFor(CORE_ID)).toBe("open");
    await advance(BACKOFF_MS + 1_000);
    expect(breaker.stateFor(CORE_ID)).toBe("closed");
  });

  it("resets when a genuinely different Core pairs", () => {
    const { breaker } = harness({});
    breaker.onCorePaired(CORE_ID);
    breaker.reportPressure(CORE_ID, { source: "browse-canary", kind: "timeout" });
    expect(breaker.stateFor(CORE_ID)).toBe("open");

    breaker.onCorePaired(OTHER_CORE_ID);
    // A different machine with a different library owes nothing to the last
    // one's trouble, and the old Core's record goes with it rather than
    // waiting to ambush a later re-pair.
    expect(breaker.stateFor(OTHER_CORE_ID)).toBe("closed");
    expect(breaker.admit(OTHER_CORE_ID, "catalog-refresh")).toBe(true);
    expect(breaker.stateFor(CORE_ID)).toBe("closed");
    expect(breaker.tripsFor(CORE_ID)).toBe(0);
  });

  it("ignores a report about a Core that is no longer the paired one", () => {
    const canary = { suspend: jest.fn(), resume: jest.fn() };
    const { breaker, probes, logger } = harness({ canary });
    const refresh = recordingSubscriber("catalog-refresh");
    breaker.register(refresh);
    breaker.onCorePaired(CORE_ID);
    breaker.onCorePaired(OTHER_CORE_ID);

    // A refresh or a binding pass aimed at A can still be unwinding when B
    // pairs, and its failure arrives afterwards. Acting on it would open a
    // breaker for A that nothing can close, suspend B's workloads on A's
    // evidence, and — worst of the three — start probing "A" through a
    // BrowseService that now reaches B, putting the recovery traffic on the
    // one Core nobody has complained about.
    breaker.reportPressure(CORE_ID, {
      source: "catalog-refresh",
      kind: "timeout",
    });

    expect(breaker.stateFor(CORE_ID)).toBe("closed");
    expect(breaker.stateFor(OTHER_CORE_ID)).toBe("closed");
    expect(breaker.tripsFor(CORE_ID)).toBe(0);
    expect(refresh.suspends).toEqual([]);
    expect(canary.suspend).not.toHaveBeenCalled();
    expect(probes).toHaveLength(0);
    expect(jest.getTimerCount()).toBe(0);
    expect(breaker.admit(OTHER_CORE_ID, "catalog-refresh")).toBe(true);
    expect(
      (logger.debug as jest.Mock).mock.calls.some(
        ([, message]) =>
          message ===
          "Post-connect stage: core pressure report ignored; it is not about the paired Core"
      )
    ).toBe(true);
  });

  it("ignores a latency sample about a Core that is no longer the paired one", () => {
    const { breaker } = harness({});
    breaker.onCorePaired(CORE_ID);
    breaker.onCorePaired(OTHER_CORE_ID);
    for (let index = 0; index < 10; index += 1) {
      breaker.reportLatency(CORE_ID, {
        source: "browse-canary",
        latencyMs: THRESHOLD_MS + 1,
      });
    }
    // The sustained rule counts a run of samples, so an unfenced stale
    // stream would not merely trip once — it would keep the breaker open on
    // evidence about a Core the controller has left.
    expect(breaker.stateFor(CORE_ID)).toBe("closed");
    expect(breaker.stateFor(OTHER_CORE_ID)).toBe("closed");
  });

  it("ignores a report that arrives while no Core is paired", async () => {
    const { breaker, probes, advance } = harness({});
    const refresh = recordingSubscriber("catalog-refresh");
    breaker.register(refresh);
    breaker.onCorePaired(CORE_ID);
    breaker.onCoreUnpaired();

    breaker.reportPressure(CORE_ID, {
      source: "artist-album-binding",
      kind: "connection-lost",
    });

    // There is nothing to probe and nothing to relieve. Arming a probe here
    // would call reRoot with no Core paired at all, which is the one state
    // the canary's own start is careful never to be in.
    expect(breaker.stateFor(CORE_ID)).toBe("closed");
    expect(refresh.suspends).toEqual([]);
    await advance(BACKOFF_MS * 4);
    expect(probes).toHaveLength(0);
  });

  it("acts on a report about the Core that re-paired", async () => {
    // The other half: the fence must not be a mute button. A Core that
    // unpaired and came back is the paired Core again, and its evidence
    // counts from that moment.
    const { breaker, probes, advance } = harness({});
    breaker.onCorePaired(CORE_ID);
    breaker.onCoreUnpaired();
    breaker.onCorePaired(CORE_ID);
    breaker.reportPressure(CORE_ID, { source: "browse-canary", kind: "timeout" });
    expect(breaker.stateFor(CORE_ID)).toBe("open");
    await advance(BACKOFF_MS + 1_000);
    expect(probes.length).toBeGreaterThan(0);
  });

  it("hands a different Core an unpaused world", () => {
    const canary = { suspend: jest.fn(), resume: jest.fn() };
    const { breaker } = harness({ canary });
    const refresh = recordingSubscriber("catalog-refresh");
    const binding = recordingSubscriber("artist-album-binding");
    breaker.register(refresh);
    breaker.register(binding);
    breaker.onCorePaired(CORE_ID);
    breaker.reportPressure(CORE_ID, { source: "browse-canary", kind: "timeout" });
    expect(refresh.suspends).toEqual([CORE_ID]);
    expect(canary.suspend).toHaveBeenCalledTimes(1);

    breaker.onCorePaired(OTHER_CORE_ID);

    // Dropping the old Core's record is not enough, because what the trip
    // actually did was process-wide: `pauseRefresh` and the binding pass's
    // pause take no Core at all, and the canary has one instance. Forgetting
    // A's open state without resuming would leave B's refresh and binding
    // pass revoked, and the canary silent, for as long as B stayed paired —
    // and with A's record gone, nothing would ever close them again.
    expect(refresh.resumes).toEqual([OTHER_CORE_ID]);
    expect(binding.resumes).toEqual([OTHER_CORE_ID]);
    expect(canary.resume).toHaveBeenCalledTimes(1);
    expect(breaker.admit(OTHER_CORE_ID, "catalog-refresh")).toBe(true);
  });

  it("still sees a Core change when the switch went through an unpair", () => {
    const canary = { suspend: jest.fn(), resume: jest.fn() };
    const { breaker } = harness({ canary });
    const refresh = recordingSubscriber("catalog-refresh");
    breaker.register(refresh);
    breaker.reportPressure(CORE_ID, { source: "browse-canary", kind: "timeout" });

    // The ordinary shape of switching Cores: A goes away first, and only
    // then does B arrive. If "which Core were we on?" were answered by the
    // currently-paired field, the unpair would have blanked it and B would
    // look like a first pairing — leaving A's open record in the map, its
    // process-wide hold in force, and nothing able to lift either.
    breaker.onCoreUnpaired();
    breaker.onCorePaired(OTHER_CORE_ID);

    expect(breaker.stateFor(CORE_ID)).toBe("closed");
    expect(breaker.tripsFor(CORE_ID)).toBe(0);
    expect(refresh.resumes).toEqual([OTHER_CORE_ID]);
    expect(canary.resume).toHaveBeenCalledTimes(1);
    expect(breaker.admit(OTHER_CORE_ID, "catalog-refresh")).toBe(true);
  });

  it("resumes nothing when the Core it replaces was never suspended", () => {
    const canary = { suspend: jest.fn(), resume: jest.fn() };
    const { breaker } = harness({ canary });
    const refresh = recordingSubscriber("catalog-refresh");
    breaker.register(refresh);
    breaker.onCorePaired(CORE_ID);

    breaker.onCorePaired(OTHER_CORE_ID);

    // A resume nobody asked for is not free: it would lift a pause an
    // operator set by hand, and it would make the resume log say a recovery
    // happened where none did.
    expect(refresh.resumes).toEqual([]);
    expect(canary.resume).not.toHaveBeenCalled();
  });

  it("reopens for the original Core if it comes back and misbehaves again", () => {
    const { breaker } = harness({});
    breaker.onCorePaired(CORE_ID);
    breaker.reportPressure(CORE_ID, { source: "browse-canary", kind: "timeout" });
    breaker.onCorePaired(OTHER_CORE_ID);
    breaker.onCorePaired(CORE_ID);
    expect(breaker.stateFor(CORE_ID)).toBe("closed");
    breaker.reportPressure(CORE_ID, { source: "browse-canary", kind: "timeout" });
    expect(breaker.stateFor(CORE_ID)).toBe("open");
    expect(breaker.tripsFor(CORE_ID)).toBe(1);
  });

  it("clears on an explicit operator reset and re-authorizes the workloads", () => {
    const { breaker } = harness({});
    const refresh = recordingSubscriber("catalog-refresh");
    breaker.register(refresh);
    breaker.onCorePaired(CORE_ID);
    breaker.reportPressure(CORE_ID, { source: "browse-canary", kind: "timeout" });
    breaker.reset(CORE_ID);
    expect(breaker.stateFor(CORE_ID)).toBe("closed");
    expect(refresh.resumes).toEqual([CORE_ID]);
    expect(breaker.admit(CORE_ID, "catalog-refresh")).toBe(true);
  });

  it("suspends the fixed-rate canary while it is open and resumes it on close", async () => {
    const canary = { suspend: jest.fn(), resume: jest.fn() };
    const { breaker, advance } = harness({ canary, answers: [{ latencyMs: 20 }] });
    breaker.reportPressure(CORE_ID, { source: "browse-canary", kind: "timeout" });
    expect(canary.suspend).toHaveBeenCalledTimes(1);
    expect(canary.resume).not.toHaveBeenCalled();
    await advance(BACKOFF_MS + 1_000);
    expect(canary.resume).toHaveBeenCalledTimes(1);
  });

  it("suspends a canary attached while it is already open", () => {
    const { breaker } = harness({});
    breaker.reportPressure(CORE_ID, { source: "browse-canary", kind: "timeout" });
    const canary = { suspend: jest.fn(), resume: jest.fn() };
    breaker.attachCanary(canary);
    // Otherwise a canary built after a trip would probe straight into an
    // open breaker, and "the half-open probe is the only traffic" would be
    // a claim rather than a fact.
    expect(canary.suspend).toHaveBeenCalledTimes(1);
  });

  it("hears nothing from a probe abandoned by an unpair", async () => {
    // Held open by hand rather than by the harness clock, because the point
    // turns on a probe that would otherwise be a textbook recovery: it
    // answers, and it answers fast. Only the fence separates that from a
    // close, and closing here would re-admit the whole burst into a Core
    // that has just dropped the session under exactly that load.
    const held: (() => void)[] = [];
    let clock = 1_000_000;
    const breaker = new CorePressureBreaker({
      probe: {
        reRoot: (): Promise<void> =>
          new Promise<void>((resolve) => {
            held.push(resolve);
          }),
      },
      logger: testLogger(),
      baselineP95Ms: BASELINE_P95_MS,
      now: () => clock,
      backoffInitialMs: BACKOFF_MS,
    });
    const flush = async (): Promise<void> => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    };
    breaker.onCorePaired(CORE_ID);
    breaker.reportPressure(CORE_ID, { source: "browse-canary", kind: "timeout" });
    clock += BACKOFF_MS;
    jest.advanceTimersByTime(BACKOFF_MS);
    await flush();
    expect(breaker.stateFor(CORE_ID)).toBe("half-open");
    expect(held).toHaveLength(1);

    breaker.onCoreUnpaired();
    held[0]?.();
    await flush();
    expect(breaker.stateFor(CORE_ID)).not.toBe("closed");
    expect(breaker.admit(CORE_ID, "catalog-refresh")).toBe(false);
  });

  it("keeps one probe on the wire, deferring the next until the abandoned one drains", async () => {
    const held: (() => void)[] = [];
    let clock = 1_000_000;
    const probes: string[] = [];
    const breaker = new CorePressureBreaker({
      probe: {
        reRoot: (_hierarchy: string, key: string): Promise<void> => {
          probes.push(key);
          if (probes.length === 1) {
            return new Promise<void>((resolve) => {
              held.push(resolve);
            });
          }
          return Promise.resolve();
        },
      },
      logger: testLogger(),
      baselineP95Ms: BASELINE_P95_MS,
      now: () => clock,
      backoffInitialMs: BACKOFF_MS,
    });
    const advance = async (ms: number): Promise<void> => {
      clock += ms;
      jest.advanceTimersByTime(ms);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    };
    breaker.onCorePaired(CORE_ID);
    breaker.reportPressure(CORE_ID, { source: "browse-canary", kind: "timeout" });
    await advance(BACKOFF_MS + 1);
    expect(probes).toHaveLength(1);

    // Abandon it and let several backoffs elapse. Nothing new goes out:
    // putting a second request on a Core the breaker has already judged
    // overloaded is the one thing the probe must never do.
    breaker.onCoreUnpaired();
    breaker.onCorePaired(CORE_ID);
    await advance(BACKOFF_MS * 4);
    expect(probes).toHaveLength(1);

    held[0]?.();
    // The drain clears on a microtask, so it has to be flushed before the
    // next timer runs — otherwise the test would only be proving that the
    // deferral is permanent.
    await Promise.resolve();
    await Promise.resolve();
    await advance(BACKOFF_MS * 2);
    expect(probes.length).toBeGreaterThan(1);
  });

  it("issues nothing once stopped", async () => {
    const { breaker, probes, advance } = harness({});
    breaker.reportPressure(CORE_ID, { source: "browse-canary", kind: "timeout" });
    breaker.stop();
    await advance(BACKOFF_MS * 4);
    expect(probes).toHaveLength(0);
  });

  it("records how long each Core spent not closed", async () => {
    const { breaker, advance } = harness({ answers: [{ latencyMs: 20 }] });
    expect(breaker.openMsFor(CORE_ID)).toBe(0);
    breaker.reportPressure(CORE_ID, { source: "browse-canary", kind: "timeout" });
    await advance(BACKOFF_MS + 1_000);
    expect(breaker.stateFor(CORE_ID)).toBe("closed");
    // The Phase B acceptance protocol fails a trial whose total open time
    // passes a minute, so the figure has to be readable without
    // reconstructing it from the log.
    expect(breaker.openMsFor(CORE_ID)).toBeGreaterThanOrEqual(BACKOFF_MS);
  });

  it("survives a subscriber that refuses to suspend", () => {
    const { breaker, logger } = harness({});
    breaker.register({
      workload: "catalog-refresh",
      suspend: () => {
        throw new Error("synthetic suspend failure");
      },
      resume: () => undefined,
    });
    const binding = recordingSubscriber("artist-album-binding");
    breaker.register(binding);
    breaker.reportPressure(CORE_ID, { source: "browse-canary", kind: "timeout" });
    // One workload's bug must not leave the other one running against a Core
    // the breaker has already opened for.
    expect(binding.suspends).toEqual([CORE_ID]);
    expect(breaker.stateFor(CORE_ID)).toBe("open");
    expect(
      (logger.warn as jest.Mock).mock.calls.some(
        ([, message]) => message === "Core pressure subscriber refused to suspend"
      )
    ).toBe(true);
  });
});
