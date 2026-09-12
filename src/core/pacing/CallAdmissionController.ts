/**
 * The pacing controller: how many calls of one background workload may be in
 * flight against one Core at a time, and when that workload must stop.
 *
 * LibraryReadPacing supplies the call shapes and pressure source. The
 * controller knows only latency, outcome and an opaque kind label; it has no
 * knowledge of Roon hierarchies, requests or response fields.
 *
 * What it is. One controller that decides HOW MANY reads may be in flight, and
 * nothing else. It is concurrency-only and completion-clocked: there is no gap
 * knob, no pacing knob, no wall-clock wait anywhere in it. Every decision fires
 * on a call completion, so no default path can carry a fixed slowdown.
 *
 * Why a workload governs itself. Every governed call IS a measured Core call,
 * so the workload already holds the freshest latency evidence about the Core
 * there is. A fixed-rate probe answers once per slot; a running workload
 * answers hundreds of times in that window. Governing off its own calls means
 * no extra probe traffic and no slot lag between the Core slowing down and the
 * workload noticing.
 *
 * Two lives, in order.
 *
 * 1. *Bootstrap* — before this Core has a durable baseline. There is no
 *    "healthy median" yet, so "strained" is not a question that can be asked,
 *    and the controller does not pretend otherwise: it pins concurrency at the
 *    floor (1), never ramps, and leans on the signals that need no baseline at
 *    all — an own-call timeout, a lost connection, a health authority that is
 *    explicitly exceeding. Any of those pauses the workload to zero. This is
 *    the protection against learning from a Core that was already degraded: a
 *    first run against an already-wedged Core has stable, slow medians, and a
 *    controller that froze them would teach itself that degradation is normal.
 * 2. *Ramping* — once a baseline is frozen. Admission starts at 2 and doubles
 *    on each consecutive run of healthy completions (slow-start), up to the
 *    configured cap. A strained kind halves it.
 *
 * The freeze gate, all three conditions necessary. A kind's provisional median
 * freezes into the durable baseline only when (a) it has met the minimum
 * sample count, (b) the median over its most recent completion epoch is within
 * tolerance of the epoch before it — completion-clocked, no wall-clock wait —
 * and (c) the health authority is explicitly HEALTHY. "Unknown" defers the
 * freeze rather than passing it. Samples taken while the controller is
 * holding a post-decrease strain never enter the durable baseline. The
 * whole point is that a baseline may only be learned from a Core that some
 * authority OTHER than the workload's own samples says is healthy.
 *
 * The health authority is a health authority, not a threshold source. Its own
 * threshold is deliberately not reused as the strain threshold: it probes one
 * call shape and the workload makes another, and one shape's p95 says nothing
 * about the other's. The authority gates the bootstrap pause and the freeze;
 * the strain rule compares each kind only against its own baseline.
 *
 * Strain hysteresis. Call shapes are tracked separately, because two shapes a
 * workload makes may have nothing in common but the socket. A kind is strained
 * when its current decision epoch has met the minimum sample count AND that
 * epoch's median exceeds 3× the kind's own frozen baseline. A decrease halves
 * admission — and every decision, up or down, clears the epochs and moves the
 * decision generation. That single rule gives both guards: no further decrease
 * can fire until a full post-decrease epoch of fresh samples exists (the epoch
 * it would need was just cleared), and completions admitted before a scale-down
 * are discarded from controller input when they land late (their generation is
 * stale).
 *
 * Handoff to a breaker. The controller never opens, half-opens or closes
 * anything. It reports pressure — an own-call timeout, a lost connection, or
 * sustained strain that has nowhere left to go because admission is already at
 * the floor — and the breaker owns what happens next. A breaker close is what
 * re-authorizes the workload, and it comes back at a reduced rate: back to the
 * floor, with the ramp to be re-earned. That reduced-rate state is keyed by
 * Core id and survives a same-Core re-pair, because a pressure-induced unpair
 * is evidence FOR the reduction. A genuinely different Core is a different
 * machine with a different library and resets everything.
 */
import type { Logger } from "pino";

/** How one measured call ended. */
export type GovernedCallOutcome =
  /** Answered, with a latency worth measuring. */
  | "answered"
  /** The Core took the call and never answered it. */
  | "timed-out"
  /** The connection dropped under the call. */
  | "connection-lost"
  /** Any other failure: a refusal, a protocol error, an unreadable row. */
  | "failed";

/**
 * What an independent health authority says about the Core, as three states
 * rather than two.
 *
 * `unknown` is the state an install with no configured authority lives in — no
 * probe, or a probe with no configured baseline, or one that has not answered
 * yet. It is emphatically not `healthy`: a controller that read silence as
 * health would freeze a baseline with nothing standing behind it, which is the
 * exact mistake the freeze gate exists to prevent.
 */
export type AdmissionHealthAuthority = "healthy" | "exceeding" | "unknown";

/** The degradation the controller reports outward; a breaker owns the rest. */
export type AdmissionPressureKind = "timeout" | "connection-lost" | "strain";

export interface AdmissionPressureReport<Source extends string = string> {
  readonly source: Source;
  readonly kind: AdmissionPressureKind;
}

/** Concurrency the controller pins itself to before it has any baseline. */
export const ADMISSION_BOOTSTRAP_CONCURRENCY = 1;

/** Where the ramp begins once a baseline exists. */
export const ADMISSION_RAMP_START_CONCURRENCY = 2;

/** Slow-start growth per healthy run. Owner-set default. */
export const ADMISSION_RAMP_FACTOR = 2;

/**
 * Multiple of a kind's own frozen baseline median that counts as strained.
 *
 * Three, matching the multiple the health probe and the breaker use, so the
 * things in this system that can say "slow" cannot mean three different things
 * by it. Applied per kind against that kind's own baseline, never against an
 * authority's own threshold — different call shape, different number.
 *
 * Proposed default, owner-set.
 */
export const ADMISSION_STRAIN_MULTIPLE = 3;

/**
 * Samples of one kind that make one epoch.
 *
 * It is the minimum sample count per decision epoch AND the length of a
 * completion epoch during bootstrap, deliberately one number: both answer the
 * same question — how many completions of one shape are enough to say anything
 * about it. Four is small enough that a workload of any size crosses it many
 * times over and large enough that a single spike cannot carry a median.
 *
 * Proposed default, owner-set.
 */
export const ADMISSION_MIN_EPOCH_SAMPLES = 4;

/**
 * How far two consecutive bootstrap epoch medians may sit apart and still
 * count as settled. 1.5× either way. Proposed default, owner-set.
 */
export const ADMISSION_BASELINE_STABILITY_TOLERANCE = 1.5;

/**
 * One admitted call. The ticket is what makes late results discardable: it
 * carries the decision generation the call was admitted under, and a
 * completion whose generation has moved contributes to nothing.
 */
export interface GovernedCallTicket<Kind extends string> {
  readonly coreId: string;
  readonly kind: Kind;
  /** Decision generation at admission. */
  readonly decisions: number;
  /**
   * Revocation generation at admission.
   *
   * Deliberately separate from `decisions`, which moves on every concurrency
   * decision including an ordinary ramp: a timeout on a call admitted one
   * doubling ago is still news about the Core, and fencing hard signals on the
   * decision generation would throw those away. This one moves only when
   * admission is REVOKED — a breaker trip, a bootstrap pause — which is the
   * only event that makes a settlement evidence about a Core that no longer
   * exists as far as this workload is concerned.
   */
  readonly authorization: number;
  /**
   * Whether this sample may ever enter a durable baseline, decided at
   * ADMISSION rather than at completion.
   *
   * A call issued while strain is held stays ineligible even if the strain
   * clears before its response arrives.
   */
  readonly baselineEligible: boolean;
}

/** What the controller will say about itself, for logs and for tests. */
export interface AdmissionControllerState<Kind extends string> {
  readonly phase: "bootstrap" | "ramping";
  /** Admission right now; 0 means the workload is paused. */
  readonly limit: number;
  readonly paused: boolean;
  /** True once a breaker trip has demoted this Core's rate. */
  readonly reduced: boolean;
  readonly decisions: number;
  /** Frozen baseline median per kind, or null while still learning it. */
  readonly baselineMs: Readonly<Record<Kind, number | null>>;
}

export interface CallAdmissionControllerOptions<
  Kind extends string,
  Source extends string,
> {
  /**
   * The call shapes this workload makes. Closed on purpose, and per workload:
   * a fourth read added to a worker seam without a decision about how it
   * should be measured is a fourth latency shape averaged into someone else's
   * median.
   *
   * The set is also what ends bootstrap — every kind in it must freeze a
   * baseline — so a kind the workload never actually issues pins it at the
   * floor forever. That is the whole reason this is a parameter rather than a
   * constant.
   */
  readonly kinds: readonly Kind[];
  /** The name pressure is reported under, for whoever receives it. */
  readonly pressureSource: Source;
  /**
   * The configured concurrency the ramp climbs toward — the workload's own
   * concurrency option, so the controller can only ever be at or below what
   * the workload was already allowed.
   */
  cap: number;
  logger?: Logger;
  /**
   * Where pressure goes. A breaker in production; the seam exists so the
   * controller can be proven without one.
   */
  onPressure?: (coreId: string, report: AdmissionPressureReport<Source>) => void;
  /**
   * Fires after every concurrency decision, with the admission that decision
   * left in force (0 while paused).
   *
   * The controller owns no clock and holds no caller, so a workload that wants
   * to WAIT for admission rather than shed work needs to be told when to look
   * again. This is that seam, and it is deliberately a notification rather
   * than a promise: the controller still decides nothing on a schedule, and a
   * workload that ignores it behaves exactly as before.
   */
  onDecision?: (coreId: string, limit: number) => void;
  strainMultiple?: number;
  minEpochSamples?: number;
  stabilityTolerance?: number;
  rampFactor?: number;
  bootstrapConcurrency?: number;
  rampStartConcurrency?: number;
}

/** Everything the controller learns about one call shape on one Core. */
interface KindState {
  /**
   * The frozen durable baseline median, or null while it is still being
   * learned. Null is what makes "strained" an unaskable question rather than a
   * question with a made-up answer.
   */
  baselineMs: number | null;
  /** Samples in the current decision epoch; strain reads these. */
  epoch: number[];
  /** Samples in the current bootstrap completion epoch. */
  provisional: number[];
  /** Median of the previous bootstrap epoch, or null before there was one. */
  previousEpochMedianMs: number | null;
}

interface ControllerCoreState<Kind extends string> {
  limit: number;
  decisions: number;
  /** Bumped every time admission is revoked; fences settlements taken before. */
  authorization: number;
  /** Consecutive healthy completions since the last decision; the ramp's run. */
  healthyRun: number;
  /**
   * True from a decrease until a full fresh epoch has been seen. Samples taken
   * under it never enter a durable baseline.
   */
  strained: boolean;
  /** Zero admission, awaiting an independent authority's all-clear. */
  paused: boolean;
  /** A breaker trip demoted this Core; survives a same-Core re-pair. */
  reduced: boolean;
  kinds: Record<Kind, KindState>;
}

function freshKindState(): KindState {
  return {
    baselineMs: null,
    epoch: [],
    provisional: [],
    previousEpochMedianMs: null,
  };
}

/** Ordinary median over a non-empty sample list. */
export function admissionSampleMedian(samples: readonly number[]): number {
  if (samples.length === 0) {
    throw new Error("A median over no samples is not a number");
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Whether two consecutive epoch medians agree closely enough to be called
 * settled. Symmetric on purpose: a Core that got twice as fast between epochs
 * is no more settled than one that got twice as slow, and freezing on the fast
 * one would leave a baseline that declares the ordinary case strained.
 */
export function admissionMediansAgree(
  earlierMs: number,
  laterMs: number,
  tolerance: number
): boolean {
  if (earlierMs <= 0 || laterMs <= 0) return earlierMs === laterMs;
  const ratio = laterMs / earlierMs;
  return ratio <= tolerance && ratio >= 1 / tolerance;
}

export class CallAdmissionController<
  Kind extends string,
  Source extends string = string,
> {
  private readonly kinds: readonly Kind[];
  private readonly pressureSource: Source;
  private readonly cap: number;
  private readonly logger?: Logger;
  private readonly onPressure?: (
    coreId: string,
    report: AdmissionPressureReport<Source>
  ) => void;
  private readonly onDecision?: (coreId: string, limit: number) => void;
  private readonly strainMultiple: number;
  private readonly minEpochSamples: number;
  private readonly stabilityTolerance: number;
  private readonly rampFactor: number;
  private readonly bootstrapConcurrency: number;
  private readonly rampStartConcurrency: number;

  private readonly cores = new Map<string, ControllerCoreState<Kind>>();

  /**
   * What the independent authority last said, and about WHICH Core.
   *
   * The two travel together because the verdict is worth nothing without the
   * identity: there is one probe and it measures whichever Core is paired, so
   * a bare verdict outlives the machine it was measured on. A healthy verdict
   * about the Core that just went away is the dangerous direction — it would
   * let the next Core, degraded and unprobed, freeze a baseline on evidence
   * from a different library on a different machine.
   */
  private health: AdmissionHealthAuthority = "unknown";

  /** The Core `health` is about; null whenever the verdict is `unknown`. */
  private healthCoreId: string | null = null;

  /**
   * The Core paired right now, so a health verdict — which may carry no Core
   * id of its own — lands on the Core it was actually about.
   */
  private pairedCoreId: string | null = null;

  /** The last Core paired, kept across unpairs so a Core CHANGE is visible. */
  private lastPairedCoreId: string | null = null;

  public constructor(options: CallAdmissionControllerOptions<Kind, Source>) {
    this.kinds = [...options.kinds];
    if (this.kinds.length === 0) {
      // `hasBaseline` is a universal quantifier, and over an empty set it is
      // vacuously true: a controller with no kinds would declare itself
      // ramping before it had measured anything at all.
      throw new Error("An admission controller needs at least one call kind");
    }
    if (new Set(this.kinds).size !== this.kinds.length) {
      throw new Error("An admission controller's call kinds must be distinct");
    }
    this.pressureSource = options.pressureSource;
    this.bootstrapConcurrency = Math.max(
      1,
      options.bootstrapConcurrency ?? ADMISSION_BOOTSTRAP_CONCURRENCY
    );
    this.cap = Math.max(this.bootstrapConcurrency, options.cap);
    this.logger = options.logger;
    if (options.onPressure !== undefined) this.onPressure = options.onPressure;
    if (options.onDecision !== undefined) this.onDecision = options.onDecision;
    this.strainMultiple = Math.max(
      1,
      options.strainMultiple ?? ADMISSION_STRAIN_MULTIPLE
    );
    this.minEpochSamples = Math.max(
      1,
      options.minEpochSamples ?? ADMISSION_MIN_EPOCH_SAMPLES
    );
    this.stabilityTolerance = Math.max(
      1,
      options.stabilityTolerance ?? ADMISSION_BASELINE_STABILITY_TOLERANCE
    );
    this.rampFactor = Math.max(1, options.rampFactor ?? ADMISSION_RAMP_FACTOR);
    this.rampStartConcurrency = Math.min(
      this.cap,
      Math.max(
        this.bootstrapConcurrency,
        options.rampStartConcurrency ?? ADMISSION_RAMP_START_CONCURRENCY
      )
    );
  }

  /**
   * How many governed calls may be in flight against this Core right now.
   *
   * Zero is a real answer, not an error: it is what the bootstrap says after a
   * baseline-free degradation signal, and it means the workload must stop
   * taking new work rather than wait for permission — the controller owns no
   * clock and will not hold a caller.
   */
  public limitFor(coreId: string): number {
    const state = this.cores.get(coreId);
    if (state === undefined) return this.bootstrapConcurrency;
    return state.paused ? 0 : state.limit;
  }

  /** Whether this Core's admission is held at zero. */
  public isPaused(coreId: string): boolean {
    return this.cores.get(coreId)?.paused ?? false;
  }

  public stateFor(coreId: string): AdmissionControllerState<Kind> {
    const state = this.stateOf(coreId);
    const baselineMs = {} as Record<Kind, number | null>;
    for (const kind of this.kinds) {
      baselineMs[kind] = state.kinds[kind].baselineMs;
    }
    return {
      phase: this.hasBaseline(state) ? "ramping" : "bootstrap",
      limit: state.paused ? 0 : state.limit,
      paused: state.paused,
      reduced: state.reduced,
      decisions: state.decisions,
      baselineMs,
    };
  }

  /**
   * Admits one call and stamps it with everything the controller will need to
   * decide whether the result still means anything when it lands.
   */
  public beginCall(coreId: string, kind: Kind): GovernedCallTicket<Kind> {
    const state = this.stateOf(coreId);
    return {
      coreId,
      kind,
      decisions: state.decisions,
      authorization: state.authorization,
      // A call admitted under held strain cannot define a healthy baseline.
      baselineEligible: !state.strained,
    };
  }

  /**
   * One call came back. This is the only place a concurrency decision is ever
   * taken, which is what "completion-clocked" means here.
   */
  public settleCall(
    ticket: GovernedCallTicket<Kind>,
    outcome: GovernedCallOutcome,
    latencyMs: number
  ): void {
    const state = this.cores.get(ticket.coreId);
    if (state === undefined) return;
    // Admitted under an authorization that has since been revoked, so this
    // call is not evidence about anything: whatever it says, it says about a
    // Core the breaker already shed this workload from. The dangerous one is a
    // hard signal. A call taken before a trip can still be on the wire minutes
    // later, and the timeout it eventually reports would walk into a breaker
    // that had just recovered through half-open and re-open it on evidence
    // older than the recovery — the workload shed again for a stall the Core
    // has already been proved out of. Post-ramp signals are untouched: this
    // generation does not move on a concurrency decision.
    if (ticket.authorization !== state.authorization) return;
    if (outcome === "timed-out" || outcome === "connection-lost") {
      // A hard signal needs no baseline, so the bootstrap acts on it too. It
      // is reported whatever phase we are in: the breaker, not the controller,
      // decides whether one timeout is worth shedding the whole workload for.
      this.reportPressure(
        ticket.coreId,
        outcome === "timed-out" ? "timeout" : "connection-lost"
      );
      this.pauseIfBootstrapping(ticket.coreId, state, outcome);
      return;
    }
    // A read that failed for a reason other than the Core going quiet — an
    // unreadable row, a refused query — carries no latency worth measuring and
    // is no evidence of pressure. It does break the run of healthy
    // completions, though: "consecutive" has to mean consecutive, or a Core
    // that answers one call in three would ramp as if it answered all of them.
    if (outcome === "failed") {
      if (ticket.decisions === state.decisions) state.healthyRun = 0;
      return;
    }
    // Admitted under a decision this one has outlived. The late-result
    // discard: a completion that started life under a concurrency the
    // controller has since abandoned may not argue for or against the new one.
    if (ticket.decisions !== state.decisions) return;
    this.recordSample(ticket, state, latencyMs);
  }

  /**
   * What the independent authority now says, about the Core it says it about.
   *
   * Health is the only thing that lifts a bootstrap pause and the only thing
   * that lets a baseline freeze, so it is authority, and authority carries an
   * identity or it is not authority. A verdict about a Core this controller is
   * not paired to is refused rather than stored: the observer and the pairing
   * feed can disagree — a probe in flight across a re-pair is exactly how —
   * and the one thing that must never happen is one Core's all-clear being
   * spent on another's workload.
   */
  public noteHealth(coreId: string, health: AdmissionHealthAuthority): void {
    if (coreId !== this.pairedCoreId) {
      this.logger?.debug(
        {
          stage: "admission-controller",
          source: this.pressureSource,
          coreId,
          pairedCoreId: this.pairedCoreId,
          health,
        },
        "Admission controller ignored a health verdict about another Core"
      );
      return;
    }
    this.health = health;
    this.healthCoreId = health === "unknown" ? null : coreId;
    if (health !== "healthy") {
      if (health === "exceeding") this.pauseOnExceed();
      return;
    }
    const state = this.cores.get(coreId);
    if (state === undefined || !state.paused) return;
    this.release(coreId, state, "health-authority-healthy");
  }

  /**
   * What the authority says about ONE Core: `unknown` unless the standing
   * verdict was measured on that Core. Everything that reads health goes
   * through here, so no caller can forget to ask whose verdict it has.
   */
  private healthFor(coreId: string): AdmissionHealthAuthority {
    return this.healthCoreId === coreId ? this.health : "unknown";
  }

  /** Drops the standing verdict; the next Core starts from `unknown`. */
  private forgetHealth(): void {
    this.health = "unknown";
    this.healthCoreId = null;
  }

  /**
   * The breaker tripped. Admission goes to zero and the Core is marked
   * demoted, so the workload that comes back after the close comes back slower
   * than the one that was shed.
   */
  public onBreakerOpen(coreId: string): void {
    const state = this.stateOf(coreId);
    state.reduced = true;
    // Every trip revokes, including one that lands on an already-paused Core:
    // what the generation fences is calls admitted BEFORE it, and a second
    // trip has its own set of those.
    this.revoke(state);
    if (state.paused) return;
    state.paused = true;
    state.limit = this.bootstrapConcurrency;
    this.decide(coreId, state, "breaker-open");
  }

  /**
   * The breaker closed. This is what re-authorizes the workload — and it lifts
   * a bootstrap pause as well as a trip pause, because the breaker's half-open
   * probe is an independent authority that has just proved the Core answers.
   * Without that reading, an install with no health probe could take one
   * bootstrap timeout and never run again.
   *
   * The workload comes back at the floor with the ramp to be re-earned. The
   * floor is not re-applied here: the trip already took admission down to it,
   * and a second assignment on this side would be a guard with no reachable
   * state to guard — a close only ever follows a trip or a Core change, and a
   * Core change starts from a fresh record at the floor anyway. The `reduced`
   * mark is kept, because it is a fact about this Core that survives a
   * re-pair.
   */
  public onBreakerClose(coreId: string): void {
    const state = this.stateOf(coreId);
    if (state.paused) {
      this.release(coreId, state, "breaker-close");
      return;
    }
    this.decide(coreId, state, "breaker-close");
  }

  /**
   * A Core paired. The same Core keeps everything it learned, reduced rate
   * included — a pressure-induced unpair is evidence for the reduction, not
   * against it. A different Core is a different machine with a different
   * library, and shares no history worth carrying.
   */
  public onCorePaired(coreId: string): void {
    const previous = this.lastPairedCoreId;
    this.pairedCoreId = coreId;
    this.lastPairedCoreId = coreId;
    if (previous === null || previous === coreId) return;
    this.cores.delete(previous);
    this.cores.delete(coreId);
    // Including the verdict. A different library on a different machine has
    // not been probed yet, and `unknown` is what "not probed yet" is called.
    this.forgetHealth();
    this.logger?.info(
      {
        stage: "admission-controller",
        source: this.pressureSource,
        coreId,
        previousCoreId: previous,
      },
      "Admission controller reset for a different Core"
    );
  }

  public onCoreUnpaired(): void {
    this.pairedCoreId = null;
    // The verdict was about a Core nothing is talking to now. Keeping it would
    // let it be spent on whatever pairs next.
    this.forgetHealth();
  }

  /** Forgets one Core entirely; the operator reset the breaker's twin. */
  public reset(coreId: string): void {
    this.cores.delete(coreId);
  }

  private stateOf(coreId: string): ControllerCoreState<Kind> {
    const existing = this.cores.get(coreId);
    if (existing !== undefined) return existing;
    const kinds = {} as Record<Kind, KindState>;
    for (const kind of this.kinds) kinds[kind] = freshKindState();
    const fresh: ControllerCoreState<Kind> = {
      limit: this.bootstrapConcurrency,
      decisions: 0,
      authorization: 0,
      healthyRun: 0,
      strained: false,
      paused: false,
      reduced: false,
      kinds,
    };
    this.cores.set(coreId, fresh);
    return fresh;
  }

  /** Whether every call shape has a baseline, which is what ends bootstrap. */
  private hasBaseline(state: ControllerCoreState<Kind>): boolean {
    return this.kinds.every((kind) => state.kinds[kind].baselineMs !== null);
  }

  private recordSample(
    ticket: GovernedCallTicket<Kind>,
    state: ControllerCoreState<Kind>,
    latencyMs: number
  ): void {
    const kind = state.kinds[ticket.kind];
    // Counted per completion rather than per epoch, so a failed read in the
    // middle of an epoch genuinely breaks the run. An epoch's median is taken
    // over the calls that answered, so without this the epoch would close
    // healthy and double admission across a failure it never saw.
    state.healthyRun += 1;
    if (kind.baselineMs === null) {
      this.learnBaseline(ticket, state, kind, latencyMs);
      return;
    }
    kind.epoch.push(latencyMs);
    const strained = this.kindIsStrained(kind);
    if (strained === null) return;
    if (strained) {
      this.decrease(ticket.coreId, state, ticket.kind);
      return;
    }
    kind.epoch = [];
    // Slow start: the run that earns a doubling is one admission's worth of
    // healthy completions, so the evidence required to double scales with what
    // is being doubled rather than being an invented constant.
    if (state.healthyRun < state.limit) return;
    this.increase(ticket.coreId, state);
  }

  /**
   * Bootstrap's half: gather provisional epochs and freeze one only when all
   * three conditions hold at once.
   */
  private learnBaseline(
    ticket: GovernedCallTicket<Kind>,
    state: ControllerCoreState<Kind>,
    kind: KindState,
    latencyMs: number
  ): void {
    if (!ticket.baselineEligible) return;
    kind.provisional.push(latencyMs);
    if (kind.provisional.length < this.minEpochSamples) return;
    const medianMs = admissionSampleMedian(kind.provisional);
    kind.provisional = [];
    const previousMs = kind.previousEpochMedianMs;
    kind.previousEpochMedianMs = medianMs;
    if (previousMs === null) return;
    if (!admissionMediansAgree(previousMs, medianMs, this.stabilityTolerance)) {
      return;
    }
    // The third condition, and the one that cannot be answered from the
    // workload's own samples: an authority outside it has to call the Core
    // healthy. "Unknown" defers — a run that measured only itself has no way
    // to tell a healthy Core from one that has been slow since it started.
    const health = this.healthFor(ticket.coreId);
    if (health !== "healthy") {
      this.logger?.debug(
        {
          stage: "admission-controller",
          source: this.pressureSource,
          coreId: ticket.coreId,
          operation: ticket.kind,
          medianMs,
          health,
        },
        "Admission controller deferred a baseline freeze; no health authority calls the Core healthy"
      );
      return;
    }
    kind.baselineMs = medianMs;
    this.logger?.info(
      {
        stage: "admission-controller",
        source: this.pressureSource,
        coreId: ticket.coreId,
        operation: ticket.kind,
        baselineMs: medianMs,
      },
      "Admission controller froze a baseline"
    );
    if (!this.hasBaseline(state)) return;
    // Bootstrap is over: leave the floor for the ramp's starting rung.
    state.limit = Math.min(this.cap, this.rampStartConcurrency);
    this.decide(ticket.coreId, state, "baseline-frozen");
  }

  /**
   * Whether this kind's current epoch is strained, or null when the epoch is
   * not yet long enough to be asked. The minimum sample count is what makes
   * "one stale spike cannot cascade halvings" true: a decision clears every
   * epoch, so the next decrease needs a whole fresh epoch to exist first.
   */
  private kindIsStrained(kind: KindState): boolean | null {
    if (kind.baselineMs === null) return null;
    if (kind.epoch.length < this.minEpochSamples) return null;
    return (
      admissionSampleMedian(kind.epoch) > kind.baselineMs * this.strainMultiple
    );
  }

  private increase(coreId: string, state: ControllerCoreState<Kind>): void {
    // A closed healthy epoch is what lifts the strain hold, wherever admission
    // happens to be. The hold and the limit answer different questions — one
    // is about what may define a baseline, the other about what may run — and
    // tying the lift to a raise would strand the hold at the floor, where a
    // raise is exactly what cannot happen.
    state.strained = false;
    // Bootstrap stays pinned at the floor. One call shape having frozen is not
    // this Core having a baseline: a frozen kind reaches the ramping path
    // while another is still being learned, and a partial baseline may not buy
    // concurrency.
    if (!this.hasBaseline(state) || state.limit >= this.cap) {
      state.healthyRun = 0;
      return;
    }
    state.limit = Math.min(this.cap, state.limit * this.rampFactor);
    this.decide(coreId, state, "healthy-run");
  }

  private decrease(
    coreId: string,
    state: ControllerCoreState<Kind>,
    operation: Kind
  ): void {
    const floor = this.bootstrapConcurrency;
    if (state.limit <= floor) {
      // Nowhere left to go. This is the second of the two pressure events:
      // strain that has already spent every halving it had.
      state.strained = true;
      this.decide(coreId, state, "strained-at-floor");
      this.reportPressure(coreId, "strain");
      return;
    }
    state.limit = Math.max(floor, Math.floor(state.limit / 2));
    state.strained = true;
    this.logger?.info(
      {
        stage: "admission-controller",
        source: this.pressureSource,
        coreId,
        operation,
        limit: state.limit,
      },
      "Admission controller halved admission on a strained call shape"
    );
    this.decide(coreId, state, "strained");
  }

  /**
   * Ends one decision epoch and starts the next. Every decision moves the
   * generation and clears every epoch, so both guards — no cascade of
   * halvings, no late completion arguing about a concurrency it was never
   * admitted under — fall out of one rule rather than two.
   */
  private decide(
    coreId: string,
    state: ControllerCoreState<Kind>,
    reason: string
  ): void {
    state.decisions += 1;
    state.healthyRun = 0;
    for (const kind of this.kinds) state.kinds[kind].epoch = [];
    const limit = state.paused ? 0 : state.limit;
    this.logger?.debug(
      {
        stage: "admission-controller",
        source: this.pressureSource,
        coreId,
        reason,
        limit,
        decisions: state.decisions,
      },
      "Admission controller took a concurrency decision"
    );
    this.announceDecision(coreId, limit);
  }

  /**
   * The bootstrap's substitute for a strain rule it cannot run. Once a
   * baseline exists the halving rule owns degradation and the breaker owns
   * hard signals, so this fires only while there is no baseline to reason
   * with.
   */
  private pauseIfBootstrapping(
    coreId: string,
    state: ControllerCoreState<Kind>,
    outcome: GovernedCallOutcome
  ): void {
    if (this.hasBaseline(state)) return;
    if (state.paused) return;
    state.paused = true;
    state.limit = this.bootstrapConcurrency;
    // A pause to zero is a revocation like the breaker's, and the calls that
    // were already out when it fired are the same stale evidence: one of them
    // caused this pause, and the rest describe the same moment.
    this.revoke(state);
    this.logger?.warn(
      {
        stage: "admission-controller",
        source: this.pressureSource,
        coreId,
        outcome,
      },
      "Admission controller paused a bootstrapping workload on a signal that needs no baseline"
    );
    this.decide(coreId, state, "bootstrap-degraded");
  }

  /** An authority that is explicitly exceeding pauses a bootstrapping run. */
  private pauseOnExceed(): void {
    const coreId = this.pairedCoreId;
    if (coreId === null) return;
    // The paired Core is materialized rather than merely looked up: the verdict
    // that matters most lands BEFORE this Core's first governed call. That
    // is the cold start against a Core a previous run left wedged — an
    // authority already exceeding at the moment the workload is triggered —
    // and a controller that only paused Cores it had already heard from would
    // answer that first admission question with the bootstrap concurrency and
    // let the degraded run begin, throwing away the one verdict it had.
    this.pauseIfBootstrapping(coreId, this.stateOf(coreId), "failed");
  }

  private release(
    coreId: string,
    state: ControllerCoreState<Kind>,
    reason: string
  ): void {
    state.paused = false;
    this.logger?.info(
      {
        stage: "admission-controller",
        source: this.pressureSource,
        coreId,
        reason,
        limit: state.limit,
      },
      "Admission controller re-admitted the workload"
    );
    this.decide(coreId, state, reason);
  }

  /**
   * Ends the current authorization. Everything already on the wire was
   * admitted under it, and stops counting as evidence the moment it ends — the
   * settlements the workload is about to unwind through describe the Core this
   * revocation is the answer to, not the one that comes back.
   */
  private revoke(state: ControllerCoreState<Kind>): void {
    state.authorization += 1;
  }

  /**
   * Hands one degradation signal outward. A refusing observer is logged and
   * swallowed: the controller's own record is not the breaker's to spoil, and
   * a throw here would abandon the concurrency decision that came with it.
   */
  private reportPressure(coreId: string, kind: AdmissionPressureKind): void {
    if (this.onPressure === undefined) return;
    try {
      this.onPressure(coreId, { source: this.pressureSource, kind });
    } catch (error) {
      this.logger?.warn(
        {
          err: error,
          stage: "admission-controller",
          source: this.pressureSource,
          coreId,
          kind,
        },
        "Admission controller pressure report was refused"
      );
    }
  }

  /**
   * Tells a waiting workload that admission moved. Swallowed the same way a
   * refused pressure report is, and for the same reason: a listener that
   * throws must not abandon the decision that had already been taken.
   */
  private announceDecision(coreId: string, limit: number): void {
    if (this.onDecision === undefined) return;
    try {
      this.onDecision(coreId, limit);
    } catch (error) {
      this.logger?.warn(
        {
          err: error,
          stage: "admission-controller",
          source: this.pressureSource,
          coreId,
          limit,
        },
        "Admission controller decision listener threw"
      );
    }
  }
}
