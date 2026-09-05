/**
 * BrowseCanaryService — the wedge detector for the post-connect load trial
 * (`.agents/plans/core-wedge-postconnect.md`, phase A0 instrumentation and
 * the A3 decision rule).
 *
 * What it is. One root-level classic-browse request every 30 s, on its own
 * browse session so it never disturbs a client's navigation, with the
 * ordinary 15 s call budget. Nothing else: no pagination, no drill, no item
 * load. It runs in every trial cell including the baseline, and it is the
 * only latency source the plan scores — the UI is closed in most cells, so
 * the canary is what says whether the Core is still answering.
 *
 * Why a library hierarchy rather than the cheap menu root. The recorded
 * failure is exactly this call against a library hierarchy: the Core takes
 * the request, runs the query, and never completes it, so `browse.browse`
 * expires at 15 s. A probe on a hierarchy that stays healthy while the
 * library ones wedge would report all-clear through the whole incident.
 *
 * Evaluation is clock-driven and keyed to SLOT DEADLINES, never to probe
 * arrival (plan §A3). Every 30 s from the run's start is a slot, whose
 * response deadline is its scheduled issue time plus the probe timeout. A
 * slot enters the history when its deadline expires and not before, so no
 * probe is ever judged before it has had its full time to answer — and a
 * probe stream that has stopped entirely still produces slots, still
 * evaluates, and still declares. The window is the 11 most recent
 * deadline-expired slots, which spans a true 5 minutes of scheduled issue
 * times; the first evaluation is therefore at the eleventh slot's deadline.
 * No quantile is computed: each slot is compared directly to 3× the
 * configured baseline p95, and a wedge is declared when at least 10 of the
 * 11 exceed it. One sub-threshold sample is tolerated as noise. A slot whose
 * probe is missing or unanswered at its deadline counts as exceeding, which
 * is what makes silence indistinguishable from slowness to the rule. One
 * evaluation suffices — the window itself is the 5-minute sustain.
 *
 * Lifecycle (plan B6b, "Canary lifecycle"). `stop()` and `suspend()` both
 * cancel the outstanding probe by moving a generation, so a stopped or
 * suspended canary can neither declare a wedge nor record a sample: the
 * abandoned probe's late answer finds a generation that is no longer current
 * and does nothing at all. Suspension is the pressure breaker's, and it
 * outlives an unpair — a Core that re-pairs while the breaker is open comes
 * back with the canary still silent, because the breaker's half-open probe
 * is meant to be the only traffic and that has to be enforced rather than
 * assumed.
 *
 * Without a configured baseline there is no threshold and so no rule: the
 * canary still issues probes and still logs every latency, and says once
 * that it is declaring nothing. That is the state the plan's own baseline
 * runs begin in, and inventing a threshold from the run's own samples would
 * make a degraded run look normal to itself.
 */
import type { Logger } from "pino";

import { RoonTimeoutError } from "./errors";
import { DEFAULT_ROON_CALL_TIMEOUT_MS } from "./timeout";

/**
 * The hierarchy the probe re-roots. A library hierarchy on purpose — see the
 * header: the menu roots stayed answerable through the recorded incident.
 */
export const BROWSE_CANARY_HIERARCHY = "albums";

/**
 * The probe's own browse session. Distinct from every client session and
 * from the server's catalog lease, so a probe can neither pop a reader out
 * of their list nor be starved behind one.
 */
export const BROWSE_CANARY_SESSION_KEY = "browse-canary";

/** Scheduled gap between probe slots (plan §A0: one probe per 30 s). */
export const BROWSE_CANARY_INTERVAL_MS = 30_000;

/** A probe's response budget; also the offset from issue time to deadline. */
export const BROWSE_CANARY_PROBE_TIMEOUT_MS = DEFAULT_ROON_CALL_TIMEOUT_MS;

/** Slots per evaluation window (plan §A3). */
export const BROWSE_CANARY_WINDOW_SLOTS = 11;

/** Exceeding slots in a window that declare a wedge (plan §A3). */
export const BROWSE_CANARY_WEDGE_SLOTS = 10;

/** Multiple of the baseline p95 a slot must beat not to count as exceeding. */
export const BROWSE_CANARY_LATENCY_MULTIPLE = 3;

/**
 * How a slot's probe ended, judged at the slot's deadline.
 *
 * `not-issued` is a real outcome rather than an absence: the slot came due
 * with the previous probe still outstanding (concurrency is 1, always), so
 * no request was made and the slot has no latency to compare.
 */
export type BrowseCanarySlotOutcome =
  | "answered"
  | "timed-out"
  | "failed"
  | "not-issued";

/** One scheduled probe slot, as it stood when its deadline expired. */
export interface BrowseCanarySlot {
  /** 0-based position from the run's start; slot n is issued at n × interval. */
  readonly index: number;
  /** Scheduled issue time — not the moment the request was handed over. */
  readonly scheduledIssueAtMs: number;
  /** Scheduled issue time plus the probe timeout. */
  readonly deadlineAtMs: number;
  readonly outcome: BrowseCanarySlotOutcome;
  /** Measured round trip, or null when no probe was issued for this slot. */
  readonly latencyMs: number | null;
}

/**
 * Whether one slot counts against the wedge rule.
 *
 * A slot with no probe, and a slot whose probe was still unanswered at its
 * deadline, both count as exceeding — the rule cannot tell "too slow to
 * measure" from "too slow", and must not treat silence as health.
 */
export function browseCanarySlotExceeds(
  slot: BrowseCanarySlot,
  thresholdMs: number
): boolean {
  if (slot.outcome === "not-issued" || slot.outcome === "timed-out") {
    return true;
  }
  if (slot.latencyMs === null) return true;
  return slot.latencyMs > thresholdMs;
}

/** One window's verdict. */
export interface BrowseCanaryEvaluation {
  readonly thresholdMs: number;
  readonly slots: readonly BrowseCanarySlot[];
  readonly exceedingSlots: number;
  readonly wedged: boolean;
}

/**
 * Applies the §A3 rule to the slots recorded so far, or answers null when
 * fewer than a full window of current-run slots have expired deadlines.
 * Pure, so the rule can be proven without a clock.
 */
export function evaluateBrowseCanaryWindow(
  slots: readonly BrowseCanarySlot[],
  thresholdMs: number
): BrowseCanaryEvaluation | null {
  if (slots.length < BROWSE_CANARY_WINDOW_SLOTS) return null;
  const window = slots.slice(-BROWSE_CANARY_WINDOW_SLOTS);
  const exceedingSlots = window.filter((slot) =>
    browseCanarySlotExceeds(slot, thresholdMs)
  ).length;
  return {
    thresholdMs,
    slots: window,
    exceedingSlots,
    wedged: exceedingSlots >= BROWSE_CANARY_WEDGE_SLOTS,
  };
}

/**
 * The slice of BrowseService the canary probes through: one root-level
 * request on a named session, and nothing that could load rows.
 */
export interface BrowseCanaryProbeTarget {
  reRoot(hierarchy: string, multiSessionKey: string): Promise<void>;
}

/**
 * What an independent authority says about the Core, as three states rather
 * than two (plan B6b, "Baseline bootstrap").
 *
 * `unknown` is not a polite `healthy`. It is the state a stock install lives
 * in — no canary, or a canary with no configured baseline — and anything that
 * reads it as health would be taking silence for evidence. The whole reason
 * the sweep governor asks an authority outside itself before freezing a
 * baseline is that its own samples cannot tell a healthy Core from one that
 * has been slow since it started; answering `healthy` where nothing is known
 * would hand it exactly that mistake in a different wrapper.
 */
export type CoreHealthVerdict = "healthy" | "exceeding" | "unknown";

/**
 * One probe, read as a health verdict.
 *
 * Pure, and separate from the canary's own wedge rule on purpose: the wedge
 * rule is a window of eleven slots and takes five minutes to speak, while a
 * consumer that wants to know whether the Core is answering RIGHT NOW should
 * not have to wait for a declaration. Both read the same threshold, so they
 * cannot disagree about what "slow" means — they only disagree about how much
 * evidence is worth acting on, which is the caller's business.
 *
 * With no threshold there is no verdict. That is the same stance the canary
 * takes about declaring a wedge, for the same reason.
 */
export function browseCanaryProbeHealth(
  result: BrowseCanaryProbeResult,
  thresholdMs: number | null
): CoreHealthVerdict {
  if (thresholdMs === null) return "unknown";
  if (result.outcome !== "answered") return "exceeding";
  return result.latencyMs <= thresholdMs ? "healthy" : "exceeding";
}

/** One settled probe, as an observer outside the canary sees it. */
export interface BrowseCanaryProbeResult {
  readonly outcome: Exclude<BrowseCanarySlotOutcome, "not-issued">;
  readonly latencyMs: number;
}

export interface BrowseCanaryServiceOptions {
  browse: BrowseCanaryProbeTarget;
  logger: Logger;
  /**
   * Baseline p95 latency the wedge threshold is derived from, or null when
   * none is configured and the rule therefore does not run.
   */
  baselineP95Ms?: number | null;
  now?: () => number;
  intervalMs?: number;
  probeTimeoutMs?: number;
  /**
   * Called for every probe this canary settles, after the generation fence.
   * The seam the pressure breaker takes its latency and timeout evidence
   * through, so the canary keeps knowing nothing about the breaker while the
   * breaker still gets the only latency stream that exists. An observer that
   * throws is logged and swallowed — the canary's own record is not a
   * listener's to spoil, and a stopped or suspended canary calls it never.
   */
  onProbeSettled?: (result: BrowseCanaryProbeResult) => void;
}

/**
 * A slot between its issue time and its deadline.
 *
 * `issued` and `settled` are separate flags because the three states they
 * distinguish are exactly the three the rule treats differently: a slot that
 * never got a request, one whose request is still outstanding at the
 * deadline, and one that came back.
 */
interface PendingProbe {
  readonly slotIndex: number;
  readonly issued: boolean;
  settled: boolean;
  outcome: BrowseCanarySlotOutcome;
  latencyMs: number | null;
}

/**
 * The identity a probe was issued under.
 *
 * Every stop, suspend and start bumps it. The Roon API cannot recall an
 * in-flight call, so this is the whole of what "cancel" can mean here: the
 * abandoned probe still settles, finds a generation that is no longer
 * current, and changes nothing — it cannot record a sample, cannot free the
 * next run's concurrency slot, and cannot contribute to a wedge declaration.
 * Without it, a canary stopped at an unpair and started again at the re-pair
 * would take the previous run's late answer as the new run's evidence.
 */
type ProbeGeneration = number;

type Timer = ReturnType<typeof setTimeout>;

export class BrowseCanaryService {
  private readonly browse: BrowseCanaryProbeTarget;
  private readonly logger: Logger;
  private readonly baselineP95Ms: number | null;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly probeTimeoutMs: number;
  private readonly onProbeSettled?: (result: BrowseCanaryProbeResult) => void;

  private running = false;
  /**
   * Set by the pressure breaker while it holds the Core open. Independent of
   * `running` on purpose: an unpair stops the canary and the re-pair starts
   * it again, and if suspension did not outlive that the canary would come
   * back probing alongside the breaker's half-open probe.
   */
  private suspended = false;
  private runStartedAtMs = 0;
  private nextSlotIndex = 0;
  private readonly timers = new Set<Timer>();
  /** Slot state between issue and deadline; keyed by slot index. */
  private readonly pending = new Map<number, PendingProbe>();
  /** Slots whose deadlines have expired, oldest first. */
  private readonly slots: BrowseCanarySlot[] = [];
  /** True while a probe is outstanding, which is what caps concurrency at 1. */
  private probeInFlight = false;
  /** Bumped by every start, stop and suspend; fences late settlement. */
  private probeGeneration: ProbeGeneration = 0;
  /** Latched so a declared wedge is reported once per run, not every 30 s. */
  private wedgeDeclared = false;
  /** Latched so "no baseline, declaring nothing" is said once, not forever. */
  private missingBaselineReported = false;

  public constructor(options: BrowseCanaryServiceOptions) {
    this.browse = options.browse;
    this.logger = options.logger;
    this.baselineP95Ms = options.baselineP95Ms ?? null;
    this.now = options.now ?? Date.now;
    this.intervalMs = options.intervalMs ?? BROWSE_CANARY_INTERVAL_MS;
    this.probeTimeoutMs = options.probeTimeoutMs ?? BROWSE_CANARY_PROBE_TIMEOUT_MS;
    if (options.onProbeSettled !== undefined) {
      this.onProbeSettled = options.onProbeSettled;
    }
  }

  /**
   * The wedge threshold, or null when no baseline is configured. Exposed so
   * the log can say what a run is measuring against without the reader
   * recomputing it.
   */
  public thresholdMs(): number | null {
    return this.baselineP95Ms === null
      ? null
      : this.baselineP95Ms * BROWSE_CANARY_LATENCY_MULTIPLE;
  }

  /** Slots whose deadlines have expired in this run, oldest first. */
  public recordedSlots(): readonly BrowseCanarySlot[] {
    return this.slots;
  }

  /**
   * Begins a run. Slot 0 is issued immediately, so the first thing a trial
   * log carries is a latency rather than 30 s of nothing. Restarting a
   * running canary is a no-op — the run's start is what every slot time is
   * measured from, and silently re-basing it would renumber the window.
   */
  public start(): void {
    if (this.running) return;
    this.running = true;
    this.logger.info(
      {
        stage: "browse-canary",
        hierarchy: BROWSE_CANARY_HIERARCHY,
        intervalMs: this.intervalMs,
        probeTimeoutMs: this.probeTimeoutMs,
        baselineP95Ms: this.baselineP95Ms,
        thresholdMs: this.thresholdMs(),
        suspended: this.suspended,
      },
      "Post-connect stage: browse canary started"
    );
    // A canary started while the breaker holds the Core open issues nothing.
    // The breaker's half-open probe is the only traffic until it closes, and
    // this is where that is enforced across an unpair/re-pair.
    if (this.suspended) return;
    this.beginRun();
  }

  /**
   * Ends the run. Timers are cleared and a probe still outstanding is
   * cancelled: the generation moves, so the abandoned probe's late
   * settlement records nothing, declares nothing, and does not free the next
   * run's concurrency slot.
   */
  public stop(): void {
    if (!this.running) return;
    this.running = false;
    this.cancelRun();
    this.logger.info(
      { stage: "browse-canary", slots: this.slots.length },
      "Post-connect stage: browse canary stopped"
    );
  }

  /**
   * Stops issuing probes without ending the canary's life, and cancels the
   * outstanding one. Called by the pressure breaker on a trip: while the
   * breaker is open the fixed-rate canary must be silent, so that the
   * breaker's half-open probe is genuinely the only traffic rather than
   * merely the traffic that matters.
   *
   * Idempotent, and valid before `start` — a Core that pairs while the
   * breaker is already open must not start probing.
   */
  public suspend(): void {
    if (this.suspended) return;
    this.suspended = true;
    this.cancelRun();
    this.logger.info(
      { stage: "browse-canary", slots: this.slots.length },
      "Post-connect stage: browse canary suspended while the pressure breaker is open"
    );
  }

  /**
   * Resumes the fixed rate on breaker close. The run re-bases: the slots
   * recorded before the suspension belong to a different Core condition, and
   * the suspended interval itself would otherwise read as a run of slots
   * with no probe — which the wedge rule counts as exceeding, so a recovered
   * Core would declare itself wedged the moment it came back.
   */
  public resume(): void {
    if (!this.suspended) return;
    this.suspended = false;
    this.logger.info(
      { stage: "browse-canary" },
      "Post-connect stage: browse canary resumed"
    );
    if (!this.running) return;
    this.beginRun();
  }

  /** True while the breaker holds this canary silent. */
  public isSuspended(): boolean {
    return this.suspended;
  }

  /** Starts (or restarts) the slot clock from now. */
  private beginRun(): void {
    this.cancelRun();
    this.runStartedAtMs = this.now();
    this.nextSlotIndex = 0;
    this.slots.length = 0;
    this.wedgeDeclared = false;
    this.missingBaselineReported = false;
    this.armNextSlot();
  }

  /** Drops every timer and fences whatever probe is still outstanding. */
  private cancelRun(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.pending.clear();
    this.probeInFlight = false;
    this.probeGeneration += 1;
  }

  /** setTimeout that neither leaks its handle nor holds the process open. */
  private schedule(delayMs: number, run: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      // Only `running` is tested. Suspension always clears the timers as it
      // sets its flag, so a suspended run has none of these pending — a
      // second test for it here would duplicate the guard in `start`, and
      // two guards that cover each other are two guards neither of which a
      // test can prove.
      if (!this.running) return;
      run();
    }, Math.max(0, delayMs));
    if (typeof timer === "object" && "unref" in timer) timer.unref();
    this.timers.add(timer);
  }

  /**
   * Arms the next slot's issue and, with it, that slot's deadline. Delays are
   * computed from the run's start rather than from the previous slot, so a
   * late callback cannot walk the schedule forward — slot n is at n ×
   * interval from the run start no matter what happened to slot n − 1.
   */
  private armNextSlot(): void {
    const index = this.nextSlotIndex;
    this.nextSlotIndex += 1;
    const scheduledIssueAtMs = this.runStartedAtMs + index * this.intervalMs;
    const deadlineAtMs = scheduledIssueAtMs + this.probeTimeoutMs;
    this.schedule(scheduledIssueAtMs - this.now(), () => {
      this.issueSlot(index, scheduledIssueAtMs);
      this.armNextSlot();
    });
    this.schedule(deadlineAtMs - this.now(), () => {
      this.closeSlot(index, scheduledIssueAtMs, deadlineAtMs);
    });
  }

  private issueSlot(index: number, scheduledIssueAtMs: number): void {
    if (this.probeInFlight) {
      // Concurrency 1. The slot still exists and its deadline still expires;
      // it simply has no probe, which the rule counts as exceeding.
      this.pending.set(index, {
        slotIndex: index,
        issued: false,
        settled: false,
        outcome: "not-issued",
        latencyMs: null,
      });
      this.logger.warn(
        { stage: "browse-canary", slot: index, scheduledIssueAtMs },
        "Post-connect stage: browse canary slot skipped, previous probe still outstanding"
      );
      return;
    }
    const probe: PendingProbe = {
      slotIndex: index,
      issued: true,
      settled: false,
      outcome: "not-issued",
      latencyMs: null,
    };
    this.pending.set(index, probe);
    this.probeInFlight = true;
    const generation = this.probeGeneration;
    const issuedAtMs = this.now();
    void this.browse
      .reRoot(BROWSE_CANARY_HIERARCHY, BROWSE_CANARY_SESSION_KEY)
      .then(
        () => {
          this.settleProbe(probe, generation, "answered", this.now() - issuedAtMs);
        },
        (error: unknown) => {
          this.settleProbe(
            probe,
            generation,
            error instanceof RoonTimeoutError ? "timed-out" : "failed",
            this.now() - issuedAtMs,
            error
          );
        }
      );
  }

  private settleProbe(
    probe: PendingProbe,
    generation: ProbeGeneration,
    outcome: Exclude<BrowseCanarySlotOutcome, "not-issued">,
    latencyMs: number,
    error?: unknown
  ): void {
    // The fence, and it comes before everything — including the in-flight
    // flag. A probe from a stopped or suspended run must not free the
    // concurrency slot a live run's probe is holding.
    //
    // It is also the ONLY check here. Every transition that ends a run —
    // stop, suspend, and the re-base inside start and resume — moves the
    // generation, so a second `running`/`suspended` test below would be a
    // guard no reachable state could reach, and an unreachable guard is a
    // claim nothing can prove.
    if (generation !== this.probeGeneration) return;
    this.probeInFlight = false;
    probe.settled = true;
    probe.outcome = outcome;
    probe.latencyMs = latencyMs;
    // Every probe result at default level: this stream IS the trial's
    // latency record, so it may not sit behind a debug switch.
    this.logger.info(
      {
        stage: "browse-canary",
        slot: probe.slotIndex,
        outcome,
        latencyMs,
        ...(error !== undefined && outcome === "failed" ? { err: error } : {}),
      },
      "Post-connect stage: browse canary probe result"
    );
    if (this.onProbeSettled === undefined) return;
    try {
      this.onProbeSettled({ outcome, latencyMs });
    } catch (observerError) {
      this.logger.warn(
        { err: observerError, stage: "browse-canary", slot: probe.slotIndex },
        "Post-connect stage: browse canary probe observer threw; the probe result stands"
      );
    }
  }

  /**
   * The slot's deadline. This is the only place a slot enters the history and
   * the only place an evaluation fires, which is what keys the whole rule to
   * deadlines rather than to when answers happen to arrive.
   */
  private closeSlot(
    index: number,
    scheduledIssueAtMs: number,
    deadlineAtMs: number
  ): void {
    const probe = this.pending.get(index);
    this.pending.delete(index);
    // Three cases, and only three. No request at all; a request still
    // outstanding at its deadline, which is unanswered however it settles
    // later; or a settled one, recorded as it came back.
    let outcome: BrowseCanarySlotOutcome = "not-issued";
    let latencyMs: number | null = null;
    if (probe?.settled === true) {
      outcome = probe.outcome;
      latencyMs = probe.latencyMs;
    } else if (probe?.issued === true) {
      outcome = "timed-out";
      latencyMs = this.probeTimeoutMs;
    }
    const slot: BrowseCanarySlot = {
      index,
      scheduledIssueAtMs,
      deadlineAtMs,
      outcome,
      latencyMs,
    };
    this.slots.push(slot);
    this.evaluate(slot);
  }

  private evaluate(slot: BrowseCanarySlot): void {
    const thresholdMs = this.thresholdMs();
    if (thresholdMs === null) {
      if (
        !this.missingBaselineReported &&
        this.slots.length >= BROWSE_CANARY_WINDOW_SLOTS
      ) {
        this.missingBaselineReported = true;
        this.logger.info(
          { stage: "browse-canary" },
          "Post-connect stage: browse canary has no configured baseline p95; recording latencies and declaring nothing"
        );
      }
      return;
    }
    const evaluation = evaluateBrowseCanaryWindow(this.slots, thresholdMs);
    if (evaluation === null) return;
    this.logger.info(
      {
        stage: "browse-canary",
        slot: slot.index,
        thresholdMs,
        exceedingSlots: evaluation.exceedingSlots,
        windowSlots: BROWSE_CANARY_WINDOW_SLOTS,
        wedged: evaluation.wedged,
      },
      "Post-connect stage: browse canary window evaluated"
    );
    if (!evaluation.wedged || this.wedgeDeclared) return;
    // One evaluation suffices (plan §A3): the window is the sustain, so the
    // declaration is latched rather than re-argued every 30 s.
    this.wedgeDeclared = true;
    this.logger.warn(
      {
        stage: "browse-canary",
        slot: slot.index,
        thresholdMs,
        exceedingSlots: evaluation.exceedingSlots,
        windowSlots: BROWSE_CANARY_WINDOW_SLOTS,
        window: evaluation.slots.map((entry) => ({
          slot: entry.index,
          outcome: entry.outcome,
          latencyMs: entry.latencyMs,
        })),
      },
      "Post-connect stage: browse canary declares the Core wedged"
    );
  }
}
