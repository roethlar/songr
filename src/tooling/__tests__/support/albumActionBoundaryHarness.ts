export type ActionResolution<Action> =
  | { kind: "missing" }
  | { kind: "unsupported" }
  | { kind: "supported"; action: Action };

export type BoundaryOutcome =
  | { code: "MISSING_ACTION"; executeIssued: false }
  | { code: "UNSUPPORTED_ACTION"; executeIssued: false }
  | { code: "RESOLUTION_FAILED"; executeIssued: false }
  | { code: "PRE_EXECUTE_TIMEOUT"; executeIssued: false }
  | { code: "EXECUTED"; executeIssued: true }
  | { code: "EXECUTION_FAILED"; executeIssued: true }
  | { code: "OUTCOME_UNKNOWN"; executeIssued: true };

export type CleanupDisposition = "clean-release" | "tainted-discard";

export interface BoundaryPorts<Action> {
  resolveAction(): Promise<ActionResolution<Action>>;
  executeAction(action: Action): Promise<void>;
}

export interface BoundarySnapshot {
  phase: "idle" | "resolving" | "claimed-execute" | "quarantined" | "terminal";
  executeIssued: boolean;
  choiceValid: boolean;
  leaseHeld: boolean;
  quarantineReason?: "pre-execute-timeout" | "post-execute-timeout";
  outcome?: BoundaryOutcome;
  cleanupCount: number;
  cleanupDisposition?: CleanupDisposition;
}

interface BoundaryOptions {
  callTimeoutMs: number;
  quarantineReapMs: number;
  now?: () => number;
}

/**
 * Test-only model of the irreversible album-action boundary.
 *
 * This helper intentionally lives under __tests__: production TypeScript
 * excludes it, and no server, socket, UI, or Roon client imports it. It models
 * contract outcomes only; it never receives a live identifier or adapter.
 */
export class AlbumActionBoundaryHarness<Action> {
  private readonly ports: BoundaryPorts<Action>;
  private readonly callTimeoutMs: number;
  private readonly quarantineReapMs: number;
  private readonly now: () => number;
  private started = false;
  private phase: BoundarySnapshot["phase"] = "idle";
  private executeIssued = false;
  private choiceValid = false;
  private leaseHeld = false;
  private quarantineReason?: BoundarySnapshot["quarantineReason"];
  private outcome?: BoundaryOutcome;
  private cleanupCount = 0;
  private cleanupDisposition?: CleanupDisposition;
  private reapTimer?: ReturnType<typeof setTimeout>;

  constructor(ports: BoundaryPorts<Action>, options: BoundaryOptions) {
    if (!Number.isFinite(options.callTimeoutMs) || options.callTimeoutMs <= 0) {
      throw new Error("callTimeoutMs must be a positive finite number");
    }
    if (!Number.isFinite(options.quarantineReapMs) || options.quarantineReapMs <= 0) {
      throw new Error("quarantineReapMs must be a positive finite number");
    }

    this.ports = ports;
    this.callTimeoutMs = options.callTimeoutMs;
    this.quarantineReapMs = options.quarantineReapMs;
    this.now = options.now ?? Date.now;
  }

  public run(): Promise<BoundaryOutcome> {
    if (this.started) {
      return Promise.reject(new Error("AlbumActionBoundaryHarness is one-shot"));
    }
    this.started = true;
    this.phase = "resolving";
    this.leaseHeld = true;

    const deadlineAt = this.now() + this.callTimeoutMs;
    let resolution: Promise<ActionResolution<Action>>;
    try {
      resolution = Promise.resolve(this.ports.resolveAction());
    } catch (error) {
      resolution = Promise.reject(error);
    }

    return new Promise((complete) => {
      let boundarySettled = false;
      const timeoutResolution = (): BoundaryOutcome => {
        const outcome: BoundaryOutcome = {
          code: "PRE_EXECUTE_TIMEOUT",
          executeIssued: false,
        };
        this.quarantine("pre-execute-timeout", outcome);
        return outcome;
      };
      const timeout = setTimeout(() => {
        if (boundarySettled) return;
        boundarySettled = true;
        complete(timeoutResolution());
      }, Math.max(0, deadlineAt - this.now()));

      resolution.then(
        (resolved) => {
          if (boundarySettled) {
            this.cleanupOnce("tainted-discard");
            return;
          }
          if (this.now() >= deadlineAt) {
            boundarySettled = true;
            clearTimeout(timeout);
            const outcome = timeoutResolution();
            this.cleanupOnce("tainted-discard");
            complete(outcome);
            return;
          }

          boundarySettled = true;
          clearTimeout(timeout);
          if (resolved.kind === "missing" || resolved.kind === "unsupported") {
            const outcome: BoundaryOutcome =
              resolved.kind === "missing"
                ? { code: "MISSING_ACTION", executeIssued: false }
                : { code: "UNSUPPORTED_ACTION", executeIssued: false };
            this.publish(outcome);
            this.cleanupOnce("clean-release");
            complete(outcome);
            return;
          }

          this.choiceValid = true;
          void this.execute(resolved.action).then(complete);
        },
        () => {
          if (boundarySettled) {
            this.cleanupOnce("tainted-discard");
            return;
          }
          if (this.now() >= deadlineAt) {
            boundarySettled = true;
            clearTimeout(timeout);
            const outcome = timeoutResolution();
            this.cleanupOnce("tainted-discard");
            complete(outcome);
            return;
          }

          boundarySettled = true;
          clearTimeout(timeout);
          const outcome: BoundaryOutcome = {
            code: "RESOLUTION_FAILED",
            executeIssued: false,
          };
          this.publish(outcome);
          this.cleanupOnce("clean-release");
          complete(outcome);
        }
      );
    });
  }

  public snapshot(): BoundarySnapshot {
    return {
      phase: this.phase,
      executeIssued: this.executeIssued,
      choiceValid: this.choiceValid,
      leaseHeld: this.leaseHeld,
      quarantineReason: this.quarantineReason,
      outcome: this.outcome,
      cleanupCount: this.cleanupCount,
      cleanupDisposition: this.cleanupDisposition,
    };
  }

  private execute(action: Action): Promise<BoundaryOutcome> {
    this.phase = "claimed-execute";
    this.choiceValid = false;
    const deadlineAt = this.now() + this.callTimeoutMs;

    let execution: Promise<void>;
    try {
      this.executeIssued = true;
      execution = Promise.resolve(this.ports.executeAction(action));
    } catch (error) {
      execution = Promise.reject(error);
    }

    return new Promise((complete) => {
      let boundarySettled = false;
      const timeoutExecution = (): BoundaryOutcome => {
        const outcome: BoundaryOutcome = {
          code: "OUTCOME_UNKNOWN",
          executeIssued: true,
        };
        this.quarantine("post-execute-timeout", outcome);
        return outcome;
      };
      const timeout = setTimeout(() => {
        if (boundarySettled) return;
        boundarySettled = true;
        complete(timeoutExecution());
      }, Math.max(0, deadlineAt - this.now()));

      execution.then(
        () => {
          if (boundarySettled) {
            this.cleanupOnce("tainted-discard");
            return;
          }
          if (this.now() >= deadlineAt) {
            boundarySettled = true;
            clearTimeout(timeout);
            const outcome = timeoutExecution();
            this.cleanupOnce("tainted-discard");
            complete(outcome);
            return;
          }

          boundarySettled = true;
          clearTimeout(timeout);
          const outcome: BoundaryOutcome = {
            code: "EXECUTED",
            executeIssued: true,
          };
          this.publish(outcome);
          this.cleanupOnce("clean-release");
          complete(outcome);
        },
        () => {
          if (boundarySettled) {
            this.cleanupOnce("tainted-discard");
            return;
          }
          if (this.now() >= deadlineAt) {
            boundarySettled = true;
            clearTimeout(timeout);
            const outcome = timeoutExecution();
            this.cleanupOnce("tainted-discard");
            complete(outcome);
            return;
          }

          boundarySettled = true;
          clearTimeout(timeout);
          const outcome: BoundaryOutcome = {
            code: "EXECUTION_FAILED",
            executeIssued: true,
          };
          this.publish(outcome);
          this.cleanupOnce("clean-release");
          complete(outcome);
        }
      );
    });
  }

  private quarantine(
    reason: NonNullable<BoundarySnapshot["quarantineReason"]>,
    outcome: BoundaryOutcome
  ): void {
    this.phase = "quarantined";
    this.choiceValid = false;
    this.quarantineReason = reason;
    this.publish(outcome);
    this.reapTimer = setTimeout(() => {
      this.cleanupOnce("tainted-discard");
    }, this.quarantineReapMs);
  }

  private publish(outcome: BoundaryOutcome): void {
    if (this.outcome === undefined) this.outcome = outcome;
  }

  private cleanupOnce(disposition: CleanupDisposition): void {
    if (this.cleanupCount > 0) return;
    this.cleanupCount = 1;
    this.cleanupDisposition = disposition;
    this.choiceValid = false;
    this.leaseHeld = false;
    this.phase = "terminal";
    if (this.reapTimer !== undefined) {
      clearTimeout(this.reapTimer);
      this.reapTimer = undefined;
    }
  }
}
