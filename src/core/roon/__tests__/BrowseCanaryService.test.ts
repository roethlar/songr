/**
 * The post-connect load trial's browse canary and its §A3 wedge rule
 * (`.agents/plans/core-wedge-postconnect.md`).
 *
 * Two halves, proven separately because they fail differently. The rule is a
 * pure function over recorded slots, so it is exercised directly rather than
 * through a clock. The service's job is everything the rule cannot see: that
 * slots are keyed to scheduled deadlines rather than to when answers arrive,
 * that an unanswered slot still reaches the window, and that a run without a
 * configured baseline declares nothing at all.
 */
import type { Logger } from "pino";

import {
  BROWSE_CANARY_HIERARCHY,
  BROWSE_CANARY_SESSION_KEY,
  BROWSE_CANARY_WINDOW_SLOTS,
  BrowseCanaryService,
  browseCanaryProbeHealth,
  browseCanarySlotExceeds,
  evaluateBrowseCanaryWindow,
  type BrowseCanaryProbeResult,
  type BrowseCanaryProbeTarget,
  type BrowseCanarySlot,
} from "../BrowseCanaryService";
import { RoonTimeoutError } from "../errors";

const INTERVAL_MS = 30_000;
const PROBE_TIMEOUT_MS = 15_000;

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

function slot(over: Partial<BrowseCanarySlot> & { index: number }): BrowseCanarySlot {
  const scheduledIssueAtMs = over.scheduledIssueAtMs ?? over.index * INTERVAL_MS;
  return {
    scheduledIssueAtMs,
    deadlineAtMs: scheduledIssueAtMs + PROBE_TIMEOUT_MS,
    outcome: "answered",
    latencyMs: 50,
    ...over,
  };
}

/** A window of `count` slots, every one of them fast and answered. */
function healthyWindow(count = BROWSE_CANARY_WINDOW_SLOTS): BrowseCanarySlot[] {
  return Array.from({ length: count }, (_unused, index) => slot({ index }));
}

describe("the browse canary wedge rule", () => {
  it("declares nothing before a full window of slots has expired", () => {
    const slots = healthyWindow(BROWSE_CANARY_WINDOW_SLOTS - 1).map((entry) => ({
      ...entry,
      outcome: "timed-out" as const,
      latencyMs: PROBE_TIMEOUT_MS,
    }));
    expect(evaluateBrowseCanaryWindow(slots, 300)).toBeNull();
  });

  it("declares a wedge when ten of eleven slots exceed the threshold", () => {
    const slots = healthyWindow();
    for (let index = 1; index < BROWSE_CANARY_WINDOW_SLOTS; index += 1) {
      slots[index] = slot({ index, latencyMs: 5_000 });
    }
    const evaluation = evaluateBrowseCanaryWindow(slots, 300);
    expect(evaluation?.exceedingSlots).toBe(10);
    expect(evaluation?.wedged).toBe(true);
  });

  it("tolerates a single sub-threshold sample as noise", () => {
    const slots = healthyWindow();
    for (let index = 0; index < BROWSE_CANARY_WINDOW_SLOTS - 2; index += 1) {
      slots[index] = slot({ index, latencyMs: 5_000 });
    }
    const evaluation = evaluateBrowseCanaryWindow(slots, 300);
    expect(evaluation?.exceedingSlots).toBe(9);
    expect(evaluation?.wedged).toBe(false);
  });

  it("counts a slot with no probe, and one unanswered at its deadline, as exceeding", () => {
    expect(
      browseCanarySlotExceeds(
        slot({ index: 0, outcome: "not-issued", latencyMs: null }),
        Number.MAX_SAFE_INTEGER
      )
    ).toBe(true);
    expect(
      browseCanarySlotExceeds(
        slot({ index: 1, outcome: "timed-out", latencyMs: PROBE_TIMEOUT_MS }),
        Number.MAX_SAFE_INTEGER
      )
    ).toBe(true);
  });

  it("scores only the eleven most recent slots", () => {
    const stale = Array.from({ length: 20 }, (_unused, index) =>
      slot({ index, outcome: "timed-out", latencyMs: PROBE_TIMEOUT_MS })
    );
    const recent = Array.from({ length: BROWSE_CANARY_WINDOW_SLOTS }, (_unused, offset) =>
      slot({ index: 20 + offset })
    );
    const evaluation = evaluateBrowseCanaryWindow([...stale, ...recent], 300);
    expect(evaluation?.exceedingSlots).toBe(0);
    expect(evaluation?.wedged).toBe(false);
  });
});

/**
 * Drives the canary on a clock the test owns. `now` is read by the service
 * for every latency and every slot boundary, and jest's timers are advanced
 * in step with it, so a case can put a probe's answer wherever it likes
 * relative to its slot's deadline.
 */
function harness(options: {
  baselineP95Ms?: number | null;
  answer?: (call: number) => Promise<void>;
  onProbeSettled?: (result: BrowseCanaryProbeResult) => void;
}): {
  service: BrowseCanaryService;
  logger: Logger;
  browse: BrowseCanaryProbeTarget & { calls: { hierarchy: string; key: string }[] };
  advance: (ms: number) => Promise<void>;
} {
  let clock = 1_000_000;
  let call = 0;
  const calls: { hierarchy: string; key: string }[] = [];
  const browse = {
    calls,
    reRoot: (hierarchy: string, key: string): Promise<void> => {
      calls.push({ hierarchy, key });
      call += 1;
      return options.answer ? options.answer(call) : Promise.resolve();
    },
  };
  const logger = testLogger();
  const service = new BrowseCanaryService({
    browse,
    logger,
    baselineP95Ms: options.baselineP95Ms ?? null,
    now: () => clock,
    intervalMs: INTERVAL_MS,
    probeTimeoutMs: PROBE_TIMEOUT_MS,
    ...(options.onProbeSettled ? { onProbeSettled: options.onProbeSettled } : {}),
  });
  const advance = async (ms: number): Promise<void> => {
    // Stepped rather than jumped, and in a step smaller than the gap between
    // any two timers this service arms, so an issue and a deadline never land
    // inside one step: a probe's answer is a microtask, and a step that swept
    // both boundaries at once would judge every probe unanswered no matter
    // how fast it really was.
    const step = PROBE_TIMEOUT_MS / 3;
    let moved = 0;
    do {
      const delta = Math.min(step, ms - moved);
      clock += delta;
      jest.advanceTimersByTime(delta);
      await Promise.resolve();
      await Promise.resolve();
      moved += delta;
    } while (moved < ms);
  };
  return { service, logger, browse, advance };
}

describe("the browse canary service", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("probes one root-level library hierarchy on its own session", async () => {
    const { service, browse, advance } = harness({});
    service.start();
    await advance(0);
    expect(browse.calls).toEqual([
      { hierarchy: BROWSE_CANARY_HIERARCHY, key: BROWSE_CANARY_SESSION_KEY },
    ]);
    await advance(INTERVAL_MS);
    expect(browse.calls).toHaveLength(2);
    service.stop();
  });

  it("records a slot only once its deadline expires, never when the answer lands", async () => {
    const { service, advance } = harness({});
    service.start();
    await advance(0);
    // The probe has answered, but its slot's deadline has not arrived.
    expect(service.recordedSlots()).toHaveLength(0);
    await advance(PROBE_TIMEOUT_MS);
    expect(service.recordedSlots()).toHaveLength(1);
    expect(service.recordedSlots()[0]?.outcome).toBe("answered");
    service.stop();
  });

  it("records a probe still outstanding at its deadline as unanswered", async () => {
    const { service, advance } = harness({
      answer: () => new Promise<void>(() => undefined),
    });
    service.start();
    await advance(PROBE_TIMEOUT_MS);
    expect(service.recordedSlots()[0]).toMatchObject({
      outcome: "timed-out",
      latencyMs: PROBE_TIMEOUT_MS,
    });
    service.stop();
  });

  it("declares a wedge once eleven slots have gone unanswered", async () => {
    const { service, logger, advance } = harness({
      baselineP95Ms: 100,
      answer: () => Promise.reject(new RoonTimeoutError("browse.browse", PROBE_TIMEOUT_MS)),
    });
    service.start();
    // Deliberately past the first full window, so several evaluations fire
    // over a Core that stays wedged: the declaration is a latch, and a run
    // that re-declared every 30 s would bury the log it belongs to.
    await advance(INTERVAL_MS * (BROWSE_CANARY_WINDOW_SLOTS + 3));
    expect(service.recordedSlots().length).toBeGreaterThan(
      BROWSE_CANARY_WINDOW_SLOTS
    );
    const declarations = (logger.warn as jest.Mock).mock.calls.filter(
      ([, message]) => message === "Post-connect stage: browse canary declares the Core wedged"
    );
    expect(declarations).toHaveLength(1);
    service.stop();
  });

  it("declares nothing while every probe answers inside the threshold", async () => {
    const { service, logger, advance } = harness({ baselineP95Ms: 100 });
    service.start();
    await advance(INTERVAL_MS * BROWSE_CANARY_WINDOW_SLOTS);
    const declarations = (logger.warn as jest.Mock).mock.calls.filter(
      ([, message]) => message === "Post-connect stage: browse canary declares the Core wedged"
    );
    expect(declarations).toHaveLength(0);
    service.stop();
  });

  it("declares nothing at all without a configured baseline", async () => {
    const { service, logger, advance } = harness({
      baselineP95Ms: null,
      answer: () => Promise.reject(new RoonTimeoutError("browse.browse", PROBE_TIMEOUT_MS)),
    });
    service.start();
    await advance(INTERVAL_MS * BROWSE_CANARY_WINDOW_SLOTS);
    const declarations = (logger.warn as jest.Mock).mock.calls.filter(
      ([, message]) => message === "Post-connect stage: browse canary declares the Core wedged"
    );
    expect(declarations).toHaveLength(0);
    expect(
      (logger.info as jest.Mock).mock.calls.some(
        ([, message]) =>
          message ===
          "Post-connect stage: browse canary has no configured baseline p95; recording latencies and declaring nothing"
      )
    ).toBe(true);
    service.stop();
  });

  it("logs every probe result at default level", async () => {
    const { service, logger, advance } = harness({});
    service.start();
    await advance(INTERVAL_MS * 2);
    const results = (logger.info as jest.Mock).mock.calls.filter(
      ([, message]) => message === "Post-connect stage: browse canary probe result"
    );
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0]?.[0]).toMatchObject({ outcome: "answered" });
    service.stop();
  });

  it("issues nothing once stopped", async () => {
    const { service, browse, advance } = harness({});
    service.start();
    await advance(0);
    const issued = browse.calls.length;
    service.stop();
    await advance(INTERVAL_MS * 3);
    expect(browse.calls).toHaveLength(issued);
  });
});

/**
 * The canary's lifecycle (plan B6b, "Canary lifecycle"), which is a separate
 * question from the wedge rule: what a stopped or suspended canary is allowed
 * to still do. The answer is nothing — and "nothing" has to survive the one
 * thing the Roon API cannot do, which is recall a call already handed over.
 */
describe("the browse canary lifecycle", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("records nothing from a probe that answers after the canary stopped", async () => {
    const settlers: ((value: void) => void)[] = [];
    const { service, logger, advance } = harness({
      answer: () =>
        new Promise<void>((resolve) => {
          settlers.push(resolve);
        }),
    });
    service.start();
    await advance(0);
    service.stop();
    settlers[0]?.();
    await advance(PROBE_TIMEOUT_MS * 2);
    // The run is over, so there is no slot for the answer to land in and no
    // probe-result line for it to write. Without the generation fence the
    // late answer would still be logged as this canary's evidence.
    expect(service.recordedSlots()).toHaveLength(0);
    expect(
      (logger.info as jest.Mock).mock.calls.filter(
        ([, message]) => message === "Post-connect stage: browse canary probe result"
      )
    ).toHaveLength(0);
  });

  it("does not let a stopped run's late answer free the next run's probe slot", async () => {
    const settlers: ((value: void) => void)[] = [];
    const { service, browse, advance } = harness({
      answer: (call) =>
        call === 1
          ? new Promise<void>((resolve) => {
              settlers.push(resolve);
            })
          : new Promise<void>(() => undefined),
    });
    service.start();
    await advance(0);
    service.stop();
    service.start();
    await advance(0);
    expect(browse.calls).toHaveLength(2);
    // The first run's probe answers now. It must not clear the flag that is
    // holding the SECOND run's probe at concurrency 1, or the canary would
    // start issuing two probes at once at every slot from here on.
    settlers[0]?.();
    await advance(INTERVAL_MS);
    expect(browse.calls).toHaveLength(2);
    service.stop();
  });

  it("issues nothing while suspended and declares nothing either", async () => {
    const { service, browse, logger, advance } = harness({
      baselineP95Ms: 100,
      answer: () => Promise.reject(new RoonTimeoutError("browse.browse", PROBE_TIMEOUT_MS)),
    });
    service.start();
    await advance(0);
    const issued = browse.calls.length;
    service.suspend();
    await advance(INTERVAL_MS * (BROWSE_CANARY_WINDOW_SLOTS + 2));
    expect(browse.calls).toHaveLength(issued);
    // The suspended interval must not read as a run of slots with no probe.
    // Those count as exceeding, so a canary that kept scoring while silent
    // would declare the Core wedged for the crime of being left alone.
    expect(service.recordedSlots()).toHaveLength(0);
    expect(
      (logger.warn as jest.Mock).mock.calls.filter(
        ([, message]) => message === "Post-connect stage: browse canary declares the Core wedged"
      )
    ).toHaveLength(0);
  });

  it("probes again on resume, from a fresh window", async () => {
    const { service, browse, advance } = harness({});
    service.start();
    await advance(INTERVAL_MS * 2);
    expect(service.recordedSlots().length).toBeGreaterThan(0);
    service.suspend();
    await advance(INTERVAL_MS * 3);
    const issued = browse.calls.length;
    service.resume();
    await advance(0);
    expect(browse.calls.length).toBe(issued + 1);
    expect(service.recordedSlots()).toHaveLength(0);
    service.stop();
  });

  it("stays silent through an unpair and re-pair while it is suspended", async () => {
    const { service, browse, advance } = harness({});
    service.start();
    await advance(0);
    service.suspend();
    const issued = browse.calls.length;
    // The recorded failure mode drops the extension session under pressure,
    // so the breaker's open interval routinely spans a re-pair. If start()
    // cleared the suspension the canary would come back probing alongside
    // the half-open probe it is meant to be making way for.
    service.stop();
    service.start();
    await advance(INTERVAL_MS * 3);
    expect(browse.calls).toHaveLength(issued);
    expect(service.isSuspended()).toBe(true);
    service.resume();
    await advance(0);
    expect(browse.calls.length).toBe(issued + 1);
    service.stop();
  });

  it("reports every settled probe to its observer, and nothing once stopped", async () => {
    const results: BrowseCanaryProbeResult[] = [];
    const settlers: ((value: void) => void)[] = [];
    let call = 0;
    const { service, advance } = harness({
      onProbeSettled: (result) => results.push(result),
      answer: () => {
        call += 1;
        if (call === 1) return Promise.resolve();
        return new Promise<void>((resolve) => {
          settlers.push(resolve);
        });
      },
    });
    service.start();
    await advance(INTERVAL_MS);
    expect(results).toEqual([{ outcome: "answered", latencyMs: 0 }]);
    service.stop();
    settlers[0]?.();
    await advance(INTERVAL_MS);
    // A stopped canary is not a source of evidence, so the breaker hears
    // nothing more from it — including the answer that was already in
    // flight when it stopped.
    expect(results).toHaveLength(1);
  });

  it("keeps its own record when the observer throws", async () => {
    const { service, logger, advance } = harness({
      onProbeSettled: () => {
        throw new Error("synthetic observer failure");
      },
    });
    service.start();
    await advance(PROBE_TIMEOUT_MS);
    expect(service.recordedSlots()[0]?.outcome).toBe("answered");
    expect(
      (logger.warn as jest.Mock).mock.calls.some(
        ([, message]) =>
          message ===
          "Post-connect stage: browse canary probe observer threw; the probe result stands"
      )
    ).toBe(true);
    service.stop();
  });
});

describe("one probe, read as a health verdict", () => {
  const answered = (latencyMs: number): BrowseCanaryProbeResult => ({
    outcome: "answered",
    latencyMs,
  });

  it("says nothing at all when there is no threshold to say it against", () => {
    // The stock install. `unknown` is not a polite `healthy`: a consumer that
    // read silence as health would be taking no evidence for good evidence,
    // which is the whole mistake the verdict exists to avoid.
    expect(browseCanaryProbeHealth(answered(5), null)).toBe("unknown");
    expect(
      browseCanaryProbeHealth(
        { outcome: "timed-out", latencyMs: 15_000 },
        null
      )
    ).toBe("unknown");
  });

  it("calls a probe inside the threshold healthy, boundary included", () => {
    expect(browseCanaryProbeHealth(answered(20), 63)).toBe("healthy");
    expect(browseCanaryProbeHealth(answered(63), 63)).toBe("healthy");
  });

  it("calls a probe past the threshold exceeding", () => {
    expect(browseCanaryProbeHealth(answered(64), 63)).toBe("exceeding");
  });

  it("calls anything that did not answer exceeding, whatever its latency", () => {
    // A probe that timed out or lost the connection is the strongest evidence
    // the canary has. Reading its recorded latency as though it were an answer
    // would turn the worst case into the best one.
    expect(
      browseCanaryProbeHealth(
        { outcome: "timed-out", latencyMs: 1 },
        63
      )
    ).toBe("exceeding");
    expect(
      browseCanaryProbeHealth(
        { outcome: "failed", latencyMs: 1 },
        63
      )
    ).toBe("exceeding");
  });
});
