/**
 * The live library's adapter over the shared pacing controller.
 *
 * `.agents/plans/library-live-view.md`, "Pacing safety (kept)": the roots are
 * read through `CallAdmissionController` under the browse canary, exactly as
 * the walk was, so a Core that has stopped answering promptly is not handed
 * another 61-call read.
 *
 * WHY THIS REFUSES RATHER THAN PARKS, which is where it differs from
 * `ArtistAlbumWalkPacingController`. The walk was a long serial loop with
 * thousands of steps, so parking a step until admission returned was the right
 * shape: the work still had to happen and there was nothing else to do with
 * it. A roots read is one bounded operation with a timer behind it. Parking it
 * would hold a request open for however long the Core stays unhealthy and then
 * do work nobody is waiting for any more; refusing it leaves the snapshot the
 * reader already has exactly as it was, tells the surface plainly that the
 * Core is being spared, and lets the next tick try again. The plan asks for
 * "the UI shows what it says and that it is waiting for the Core", and a
 * refusal is the only outcome that can say that.
 *
 * WHAT IT MEASURES. One sample is one whole roots read — two root reads and
 * about sixty calls — or one count check. That is coarse, and it is the same
 * coarseness the walk's adapter accepted for the same reason: the seam sits
 * where the work is, and a finer seam would measure calls the caller does not
 * issue. Strain here means "reading the roots is taking much longer than it
 * did on this Core", which is exactly the thing worth slowing down for.
 *
 * `onPressure` is left unwired by default, as it was for the walk: handing a
 * coarse verdict to the breaker is a decision, not a default.
 */
import type { Logger } from "pino";

import {
  AdmissionHealthAuthority,
  AdmissionPressureReport,
  CallAdmissionController,
  GovernedCallOutcome,
  GovernedCallTicket,
} from "../pacing/CallAdmissionController";

/** What the live library calls itself when it reports pressure. */
export const LIBRARY_READ_PRESSURE_SOURCE = "library-roots" as const;

/**
 * Its call shapes: reading a root, checking a root's count, and opening one
 * level (`.agents/plans/library-live-view.md` Slice 2).
 *
 * An open is its own kind rather than another `roots` sample because it is a
 * different size of work — one browse and a handful of loads, against about
 * sixty calls for the roots — and mixing the two latency populations would make
 * a healthy Core look strained the moment a reader stopped opening pages.
 * Bounded previews have their own sample too: one prefix must not bias the
 * latency population of complete levels.
 */
export const LIBRARY_READ_CALL_KINDS = ["roots", "count", "open", "preview"] as const;

export type LibraryReadCallKind = (typeof LIBRARY_READ_CALL_KINDS)[number];

export type LibraryReadPressureReport = AdmissionPressureReport<
  typeof LIBRARY_READ_PRESSURE_SOURCE
>;

export interface LibraryReadPacingOptions {
  /**
   * One by default, and one is honest: the roots are read on a single
   * serialized catalog session, so a larger admission would describe a
   * parallelism that does not exist.
   */
  cap?: number;
  logger?: Logger;
  onPressure?: (coreId: string, report: LibraryReadPressureReport) => void;
  minEpochSamples?: number;
  strainMultiple?: number;
}

export class LibraryReadPacing {
  private readonly controller: CallAdmissionController<
    LibraryReadCallKind,
    typeof LIBRARY_READ_PRESSURE_SOURCE
  >;

  public constructor(options: LibraryReadPacingOptions = {}) {
    this.controller = new CallAdmissionController({
      kinds: LIBRARY_READ_CALL_KINDS,
      pressureSource: LIBRARY_READ_PRESSURE_SOURCE,
      cap: options.cap ?? 1,
      ...(options.logger !== undefined ? { logger: options.logger } : {}),
      ...(options.onPressure !== undefined
        ? { onPressure: options.onPressure }
        : {}),
      ...(options.minEpochSamples !== undefined
        ? { minEpochSamples: options.minEpochSamples }
        : {}),
      ...(options.strainMultiple !== undefined
        ? { strainMultiple: options.strainMultiple }
        : {}),
    });
  }

  /** Whether a read may go out to this Core at all right now. */
  public admits(coreId: string): boolean {
    return this.controller.limitFor(coreId) > 0;
  }

  public begin(coreId: string, kind: LibraryReadCallKind) {
    return this.controller.beginCall(coreId, kind);
  }

  public settle(
    ticket: GovernedCallTicket<LibraryReadCallKind>,
    outcome: GovernedCallOutcome,
    elapsedMs: number
  ): void {
    // A clock that went backwards is not a Core that got faster.
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return;
    this.controller.settleCall(ticket, outcome, elapsedMs);
  }

  /** What an independent authority — the browse canary — says about the Core. */
  public noteHealth(coreId: string, health: AdmissionHealthAuthority): void {
    this.controller.noteHealth(coreId, health);
  }

  public onCorePaired(coreId: string): void {
    this.controller.onCorePaired(coreId);
  }

  public onCoreUnpaired(): void {
    this.controller.onCoreUnpaired();
  }

  public onBreakerOpen(coreId: string): void {
    this.controller.onBreakerOpen(coreId);
  }

  public onBreakerClose(coreId: string): void {
    this.controller.onBreakerClose(coreId);
  }

  /** For logs and tests; the controller's own view of this Core. */
  public stateFor(coreId: string) {
    return this.controller.stateFor(coreId);
  }
}
