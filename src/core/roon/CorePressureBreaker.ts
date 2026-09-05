/**
 * CorePressureBreaker — the required B5 slice of
 * `.agents/plans/core-wedge-postconnect.md` (Phase B).
 *
 * One admission gate, per Core, over every BACKGROUND workload that puts
 * bulk read traffic on the Core: the catalog refresh pull, the artist-album
 * binding pass, and the server-driven catalog walk. Foreground work — a
 * reader opening an artist, a search, an explicit operator refresh — never
 * passes through here. The point of the gate is to shed load the user did
 * not ask for while the Core is struggling, not to make the app slower.
 *
 * Trip. Two conditions, and only two. A browse timeout (or a lost
 * connection) is a hard signal and trips at once — the recorded failure mode
 * is a Core that takes a request and never answers it, and waiting for a
 * second fifteen-second timeout buys fifteen more seconds of pressure for no
 * new information. Sustained latency is the soft signal: a run of
 * consecutive probe samples past the threshold, where the threshold is a
 * multiple of the owner-set baseline p95. Without a configured baseline
 * there is no threshold and so no latency rule at all — the same stance the
 * canary takes, and for the same reason: a threshold invented from a
 * degraded run's own samples makes degradation look normal to itself.
 *
 * Trip does two things, not one. New admissions are refused, AND work
 * already running is cooperatively cancelled through the registered
 * subscribers, which release their connections as they unwind. A gate that
 * only refused new work would leave ten minutes of picker traffic running
 * against the Core it just declared wedged.
 *
 * Recovery is half-open, and the breaker owns it. After an exponential
 * backoff the breaker issues ONE probe of the canary's own request shape on
 * its own session key, and nothing else runs. Answered inside the threshold
 * closes the breaker and re-authorizes every workload; anything else stays
 * open with the backoff doubled. The fixed-rate canary is suspended for the
 * whole open interval and resumed on close, so "the half-open probe is the
 * only probe traffic" is enforced here rather than assumed.
 *
 * State is keyed by Core id and survives a re-pair to the same Core. That is
 * deliberate: the known failure mode includes pressure-induced unpairs, so a
 * breaker that reset itself on re-pair would re-admit the whole burst into
 * the Core that just dropped it. A re-pair to the same Core keeps the open
 * state and the backoff level and still requires a successful half-open
 * probe before closing. Only pairing to a genuinely different Core, or an
 * explicit operator reset, clears it.
 */
import type { Logger } from "pino";

import {
  BROWSE_CANARY_HIERARCHY,
  type BrowseCanaryProbeTarget,
} from "./BrowseCanaryService";
import { RoonTimeoutError } from "./errors";
import { DEFAULT_ROON_CALL_TIMEOUT_MS } from "./timeout";

/**
 * The half-open probe's own browse session. Distinct from the canary's and
 * from every client session: the probe must not inherit, or disturb, the
 * session state of the traffic it is deciding about.
 */
export const CORE_PRESSURE_PROBE_SESSION_KEY = "core-pressure-probe";

/**
 * Multiple of the baseline p95 a latency sample must beat not to count
 * against the breaker. Deliberately the canary's own multiple: the breaker
 * and the canary must not disagree about what "slow" means.
 *
 * Proposed default, owner-set (plan "Open questions").
 */
export const CORE_PRESSURE_LATENCY_MULTIPLE = 3;

/**
 * Consecutive exceeding samples that constitute "sustained" latency.
 *
 * Three, not the canary's ten-of-eleven: the canary's window is the trial's
 * *wedge declaration*, which is allowed to take five minutes because it is
 * making a claim about the Core. The breaker is shedding load, which has to
 * happen before the wedge completes, and a wrong trip costs only a delayed
 * background pass. Proposed default, owner-set.
 */
export const CORE_PRESSURE_SUSTAINED_SAMPLES = 3;

/** First half-open delay after a trip; one canary slot. Owner-set default. */
export const CORE_PRESSURE_BACKOFF_INITIAL_MS = 30_000;

/** Backoff growth per failed half-open probe. Owner-set default. */
export const CORE_PRESSURE_BACKOFF_FACTOR = 2;

/** Ceiling on the half-open delay. Owner-set default. */
export const CORE_PRESSURE_BACKOFF_MAX_MS = 300_000;

/** The background workloads the gate admits. */
export type CorePressureWorkload =
  /** The native snapshot pull. */
  | "catalog-refresh"
  /** The whole-library artist→album binding pass. */
  | "artist-album-binding"
  /** A server-driven walk of the public browse hierarchies. */
  | "catalog-walk"
  /** The live view's read of Roon's own library roots. */
  | "library-roots";

export type CorePressureState = "closed" | "open" | "half-open";

/** A hard degradation signal, reported by a workload or by the canary. */
export type CorePressureKind =
  /** A call the Core took and never answered. */
  | "timeout"
  /** The connection dropped, or could not be opened at all. */
  | "connection-lost"
  /**
   * The reporter's own judgement that it is sustainedly degraded. The seam
   * the later adaptive governor reports through; nothing in this slice
   * derives strain, it only accepts the report.
   */
  | "strain";

/**
 * A workload the breaker can revoke. `suspend` must both refuse new work and
 * cooperatively stop what is already running — a subscriber that only did the
 * first would leave the trip half-done.
 */
export interface CorePressureSubscriber {
  readonly workload: CorePressureWorkload;
  suspend(coreId: string): void;
  resume(coreId: string): void;
}

/** The fixed-rate canary, as the breaker steers it. */
export interface CorePressureCanaryControl {
  suspend(): void;
  resume(): void;
}

export interface CorePressureBreakerOptions {
  probe: BrowseCanaryProbeTarget;
  logger: Logger;
  /**
   * Baseline p95 the latency threshold is derived from, or null when none is
   * configured and only the hard signals can trip the breaker.
   */
  baselineP95Ms?: number | null;
  canary?: CorePressureCanaryControl | null;
  now?: () => number;
  latencyMultiple?: number;
  sustainedSamples?: number;
  backoffInitialMs?: number;
  backoffFactor?: number;
  backoffMaxMs?: number;
  probeTimeoutMs?: number;
}

/** Everything the breaker remembers about one Core. */
interface CoreState {
  state: CorePressureState;
  /** Run of consecutive exceeding latency samples; reset by any good one. */
  consecutiveExceeding: number;
  /** Delay before the NEXT half-open probe. */
  backoffMs: number;
  /** When the current open interval began; 0 while closed. */
  openedAtMs: number;
  /** Total time this Core has spent not-closed, for the acceptance record. */
  totalOpenMs: number;
  trips: number;
}

/**
 * The probe's identity on the wire.
 *
 * `generation` fences late settlement: a probe abandoned by an unpair, a
 * reset or a shutdown can never close the breaker afterwards. `outstanding`
 * is the drain — the Roon API cannot cancel an in-flight call, so the only
 * honest way to keep one probe on the wire is to refuse to issue the next
 * one until the abandoned one has actually settled.
 */
interface ProbeSession {
  generation: number;
  outstanding: Promise<void> | null;
}

type Timer = ReturnType<typeof setTimeout>;

export class CorePressureBreaker {
  private readonly browse: BrowseCanaryProbeTarget;
  private readonly logger: Logger;
  private readonly baselineP95Ms: number | null;
  /**
   * Mutable because the wiring is circular: the canary reports its probes to
   * the breaker, and the breaker silences the canary. One of the two has to
   * be handed over after construction, and the canary is the optional half.
   */
  private canary: CorePressureCanaryControl | null;
  private readonly now: () => number;
  private readonly latencyMultiple: number;
  private readonly sustainedSamples: number;
  private readonly backoffInitialMs: number;
  private readonly backoffFactor: number;
  private readonly backoffMaxMs: number;
  private readonly probeTimeoutMs: number;

  private readonly cores = new Map<string, CoreState>();
  private readonly subscribers: CorePressureSubscriber[] = [];
  private readonly probeSession: ProbeSession = {
    generation: 0,
    outstanding: null,
  };
  private probeTimer: Timer | null = null;
  /**
   * The Core paired RIGHT NOW, or null between an unpair and the next pair.
   * Every incoming report is fenced against this.
   */
  private pairedCoreId: string | null = null;
  /**
   * The Core last paired, kept across unpairs so a genuine Core CHANGE stays
   * distinguishable from a re-pair. Separate from `pairedCoreId` because the
   * two answer different questions: this one asks "is this a new machine?",
   * which must survive the unpair, and that one asks "is anyone there right
   * now?", which must not.
   */
  private lastPairedCoreId: string | null = null;
  private stopped = false;

  public constructor(options: CorePressureBreakerOptions) {
    this.browse = options.probe;
    this.logger = options.logger;
    this.baselineP95Ms = options.baselineP95Ms ?? null;
    this.canary = options.canary ?? null;
    this.now = options.now ?? Date.now;
    this.latencyMultiple =
      options.latencyMultiple ?? CORE_PRESSURE_LATENCY_MULTIPLE;
    this.sustainedSamples = Math.max(
      1,
      options.sustainedSamples ?? CORE_PRESSURE_SUSTAINED_SAMPLES
    );
    this.backoffInitialMs =
      options.backoffInitialMs ?? CORE_PRESSURE_BACKOFF_INITIAL_MS;
    this.backoffFactor = options.backoffFactor ?? CORE_PRESSURE_BACKOFF_FACTOR;
    this.backoffMaxMs = options.backoffMaxMs ?? CORE_PRESSURE_BACKOFF_MAX_MS;
    this.probeTimeoutMs =
      options.probeTimeoutMs ?? DEFAULT_ROON_CALL_TIMEOUT_MS;
  }

  /**
   * The latency a sample must beat, or null when no baseline is configured
   * and the latency rule therefore does not run.
   */
  public thresholdMs(): number | null {
    return this.baselineP95Ms === null
      ? null
      : this.baselineP95Ms * this.latencyMultiple;
  }

  /** Registers a workload the breaker may revoke. */
  public register(subscriber: CorePressureSubscriber): void {
    this.subscribers.push(subscriber);
  }

  /**
   * Hands the breaker the fixed-rate canary to silence. Attaching one while
   * the breaker is already open suspends it at once — otherwise a canary
   * built after a trip would probe straight into an open breaker.
   */
  public attachCanary(canary: CorePressureCanaryControl): void {
    this.canary = canary;
    for (const state of this.cores.values()) {
      if (state.state !== "closed") {
        canary.suspend();
        return;
      }
    }
  }

  public stateFor(coreId: string): CorePressureState {
    return this.cores.get(coreId)?.state ?? "closed";
  }

  /**
   * Total time this Core has spent with the breaker not closed, including
   * the interval in progress. The Phase B acceptance protocol fails a trial
   * whose total open time exceeds a minute, so the number has to be readable
   * without reconstructing it from the log.
   */
  public openMsFor(coreId: string): number {
    const state = this.cores.get(coreId);
    if (state === undefined) return 0;
    if (state.state === "closed") return state.totalOpenMs;
    return state.totalOpenMs + (this.now() - state.openedAtMs);
  }

  public tripsFor(coreId: string): number {
    return this.cores.get(coreId)?.trips ?? 0;
  }

  /**
   * The admission question. Answered false while the breaker is open OR
   * half-open: during half-open the breaker's own probe is the only traffic
   * that may run, so a workload that admitted itself alongside it would be
   * measuring the recovery it was disturbing.
   */
  public admit(coreId: string, workload: CorePressureWorkload): boolean {
    const state = this.stateFor(coreId);
    if (state === "closed") return true;
    this.logger.info(
      { stage: "core-pressure", coreId, workload, breaker: state },
      "Post-connect stage: core pressure breaker refused a background workload"
    );
    return false;
  }

  /**
   * A hard degradation signal about the paired Core. Trips a closed breaker
   * immediately.
   */
  public reportPressure(
    coreId: string,
    report: { source: string; kind: CorePressureKind }
  ): void {
    if (this.stopped) return;
    if (!this.isLiveReport(coreId, report.source)) return;
    const state = this.stateOf(coreId);
    if (state.state !== "closed") return;
    this.trip(coreId, state, report.source, report.kind);
  }

  /**
   * One probe-shaped latency sample. Only samples of the canary's request
   * shape belong here: the sustained rule compares them against one
   * threshold, and mixing call shapes under a single threshold would make
   * the rule mean nothing.
   */
  public reportLatency(
    coreId: string,
    sample: { source: string; latencyMs: number }
  ): void {
    if (this.stopped) return;
    if (!this.isLiveReport(coreId, sample.source)) return;
    const thresholdMs = this.thresholdMs();
    if (thresholdMs === null) return;
    const state = this.stateOf(coreId);
    if (state.state !== "closed") return;
    if (sample.latencyMs <= thresholdMs) {
      state.consecutiveExceeding = 0;
      return;
    }
    state.consecutiveExceeding += 1;
    if (state.consecutiveExceeding < this.sustainedSamples) return;
    this.trip(coreId, state, sample.source, "strain");
  }

  /**
   * A Core paired. The same Core keeps everything — an open breaker stays
   * open across a re-pair and re-arms its half-open probe, because a
   * pressure-induced unpair is evidence FOR the open state, not against it.
   * A different Core is a different machine with a different library and no
   * shared history, so its state starts clean and the old Core's is dropped.
   */
  public onCorePaired(coreId: string): void {
    if (this.stopped) return;
    const previous = this.lastPairedCoreId;
    this.pairedCoreId = coreId;
    this.lastPairedCoreId = coreId;
    if (previous !== null && previous !== coreId) {
      this.cancelProbe();
      // Whether anything is actually being HELD, not merely recorded. The
      // suspension a trip performs is process-wide — `pauseRefresh` and the
      // binding pass's pause take no Core, and there is one canary — so
      // forgetting the old Core's record without lifting it would leave the
      // new Core's workloads revoked with no record left that could ever
      // close them again. Checked rather than resumed unconditionally: a
      // resume nobody asked for would lift an operator's own pause and would
      // put a recovery in the log where none happened.
      const held =
        this.isHeld(this.cores.get(previous)) ||
        this.isHeld(this.cores.get(coreId));
      this.cores.delete(previous);
      this.cores.delete(coreId);
      this.logger.info(
        { stage: "core-pressure", coreId, previousCoreId: previous, held },
        "Post-connect stage: core pressure breaker reset for a different Core"
      );
      if (held) this.releaseWorkloads(coreId);
      return;
    }
    const state = this.cores.get(coreId);
    if (state === undefined || state.state === "closed") return;
    // Re-pair while open: the probe timer died with the previous pairing,
    // so recovery has to be re-armed or the breaker would stay open forever.
    // The state itself — open, and at whatever backoff it had reached — is
    // deliberately carried over.
    state.state = "open";
    this.logger.info(
      { stage: "core-pressure", coreId, backoffMs: state.backoffMs },
      "Post-connect stage: core pressure breaker stayed open across a re-pair to the same Core"
    );
    this.armProbe(coreId, state);
  }

  /**
   * The Core unpaired. Probing stops (there is nothing to probe) and the
   * outstanding probe is fenced, but the open/backoff state is kept for the
   * re-pair.
   */
  public onCoreUnpaired(): void {
    this.pairedCoreId = null;
    this.cancelProbe();
  }

  /**
   * Explicit operator reset: forget this Core's breaker state entirely and
   * re-authorize its workloads. The only way out of an open breaker other
   * than a successful probe or a different Core.
   */
  public reset(coreId: string): void {
    this.cancelProbe();
    const state = this.cores.get(coreId);
    this.cores.delete(coreId);
    if (state === undefined || state.state === "closed") return;
    this.logger.info(
      { stage: "core-pressure", coreId },
      "Post-connect stage: core pressure breaker reset by operator request"
    );
    this.releaseWorkloads(coreId);
  }

  /** Shutdown. No further probe is issued and no late one is heard. */
  public stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.cancelProbe();
  }

  /**
   * Whether a report about `coreId` is one this breaker may act on.
   *
   * Background work unwinds slowly, so a refresh or a binding pass aimed at
   * the Core that just went away can still be failing after the controller
   * has moved on. Acting on that is wrong three times over: it opens a
   * breaker for a Core nothing can close, it suspends the CURRENT Core's
   * workloads on a departed Core's evidence, and it arms a half-open probe
   * that goes out over a BrowseService now pointed somewhere else — so the
   * recovery traffic lands on the one Core that never misbehaved. With no
   * Core paired at all there is nothing to probe and nothing to relieve.
   *
   * Debug rather than warn: a late report is ordinary during a Core switch,
   * not a fault.
   */
  private isLiveReport(coreId: string, source: string): boolean {
    if (this.pairedCoreId === coreId) return true;
    this.logger.debug(
      {
        stage: "core-pressure",
        coreId,
        source,
        pairedCoreId: this.pairedCoreId,
      },
      "Post-connect stage: core pressure report ignored; it is not about the paired Core"
    );
    return false;
  }

  /** Whether this Core's record is one that is holding the workloads down. */
  private isHeld(state: CoreState | undefined): boolean {
    return state !== undefined && state.state !== "closed";
  }

  private stateOf(coreId: string): CoreState {
    const existing = this.cores.get(coreId);
    if (existing !== undefined) return existing;
    const fresh: CoreState = {
      state: "closed",
      consecutiveExceeding: 0,
      backoffMs: this.backoffInitialMs,
      openedAtMs: 0,
      totalOpenMs: 0,
      trips: 0,
    };
    this.cores.set(coreId, fresh);
    return fresh;
  }

  private trip(
    coreId: string,
    state: CoreState,
    source: string,
    kind: CorePressureKind
  ): void {
    state.state = "open";
    state.openedAtMs = this.now();
    state.consecutiveExceeding = 0;
    state.trips += 1;
    this.logger.warn(
      {
        stage: "core-pressure",
        coreId,
        source,
        kind,
        trips: state.trips,
        backoffMs: state.backoffMs,
      },
      "Post-connect stage: core pressure breaker tripped; suspending background workloads"
    );
    // The canary first: while the breaker is open the half-open probe is the
    // only probe traffic, and that has to be true before the probe is armed.
    this.canary?.suspend();
    for (const subscriber of this.subscribers) {
      try {
        subscriber.suspend(coreId);
      } catch (error) {
        this.logger.warn(
          { err: error, coreId, workload: subscriber.workload },
          "Core pressure subscriber refused to suspend"
        );
      }
    }
    this.armProbe(coreId, state);
  }

  private armProbe(coreId: string, state: CoreState): void {
    if (this.stopped) return;
    this.clearProbeTimer();
    const delayMs = state.backoffMs;
    const timer = setTimeout(() => {
      this.probeTimer = null;
      void this.issueProbe(coreId);
    }, delayMs);
    if (typeof timer === "object" && "unref" in timer) timer.unref();
    this.probeTimer = timer;
  }

  private clearProbeTimer(): void {
    if (this.probeTimer !== null) clearTimeout(this.probeTimer);
    this.probeTimer = null;
  }

  /**
   * Fences every outstanding probe and drops the pending one. The in-flight
   * call itself cannot be recalled, so the drain in `issueProbe` is what
   * keeps a second probe off the wire behind it.
   */
  private cancelProbe(): void {
    this.clearProbeTimer();
    this.probeSession.generation += 1;
  }

  private issueProbe(coreId: string): void {
    if (this.stopped) return;
    const state = this.cores.get(coreId);
    if (state === undefined || state.state === "closed") return;
    if (this.probeSession.outstanding !== null) {
      // An abandoned probe is still on the wire. Issuing another would put
      // two requests on a Core the breaker has already judged overloaded.
      this.logger.info(
        { stage: "core-pressure", coreId },
        "Post-connect stage: core pressure probe deferred; the previous probe has not drained"
      );
      this.armProbe(coreId, state);
      return;
    }
    state.state = "half-open";
    const generation = this.probeSession.generation;
    const issuedAtMs = this.now();
    this.logger.info(
      { stage: "core-pressure", coreId, backoffMs: state.backoffMs },
      "Post-connect stage: core pressure breaker is half-open; probing"
    );
    const call = this.browse.reRoot(
      BROWSE_CANARY_HIERARCHY,
      CORE_PRESSURE_PROBE_SESSION_KEY
    );
    const drain = call.then(
      () => undefined,
      () => undefined
    );
    this.probeSession.outstanding = drain;
    void drain.then(() => {
      if (this.probeSession.outstanding === drain) {
        this.probeSession.outstanding = null;
      }
    });
    call.then(
      () => {
        this.settleProbe(coreId, generation, "answered", this.now() - issuedAtMs);
      },
      (error: unknown) => {
        this.settleProbe(
          coreId,
          generation,
          error instanceof RoonTimeoutError ? "timed-out" : "failed",
          this.now() - issuedAtMs
        );
      }
    );
  }

  private settleProbe(
    coreId: string,
    generation: number,
    outcome: "answered" | "timed-out" | "failed",
    latencyMs: number
  ): void {
    // The fence. A probe abandoned by an unpair, an operator reset, a Core
    // change or a shutdown settles into nothing.
    if (this.stopped || generation !== this.probeSession.generation) return;
    const state = this.cores.get(coreId);
    if (state === undefined || state.state !== "half-open") return;
    const thresholdMs = this.thresholdMs();
    const recovered =
      outcome === "answered" &&
      (thresholdMs === null || latencyMs <= thresholdMs);
    this.logger.info(
      {
        stage: "core-pressure",
        coreId,
        outcome,
        latencyMs,
        thresholdMs,
        recovered,
      },
      "Post-connect stage: core pressure probe result"
    );
    if (recovered) {
      this.closeBreaker(coreId, state);
      return;
    }
    // Still degraded. Back to open, with the wait doubled.
    state.state = "open";
    state.backoffMs = Math.min(
      state.backoffMs * this.backoffFactor,
      this.backoffMaxMs
    );
    this.armProbe(coreId, state);
  }

  private closeBreaker(coreId: string, state: CoreState): void {
    state.totalOpenMs += this.now() - state.openedAtMs;
    state.state = "closed";
    state.openedAtMs = 0;
    state.backoffMs = this.backoffInitialMs;
    state.consecutiveExceeding = 0;
    this.clearProbeTimer();
    this.logger.info(
      {
        stage: "core-pressure",
        coreId,
        totalOpenMs: state.totalOpenMs,
        trips: state.trips,
      },
      "Post-connect stage: core pressure breaker closed; background workloads re-authorized"
    );
    this.releaseWorkloads(coreId);
  }

  private releaseWorkloads(coreId: string): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber.resume(coreId);
      } catch (error) {
        this.logger.warn(
          { err: error, coreId, workload: subscriber.workload },
          "Core pressure subscriber refused to resume"
        );
      }
    }
    this.canary?.resume();
  }
}
