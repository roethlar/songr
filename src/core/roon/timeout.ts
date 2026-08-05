import { RoonTimeoutError } from "./errors";

/**
 * How long a single Roon API callback may stay unanswered before the
 * wrapping promise rejects. Applies per call — a paginated browse that
 * chains many load() roundtrips gets a fresh budget for each one.
 */
export const DEFAULT_ROON_CALL_TIMEOUT_MS = 15_000;

/**
 * Called after the wrapper has timed out with a promise that mirrors the
 * eventual settlement of the uncancellable Roon operation. A rejection has
 * an internal handler attached before the observer runs, so callers may use
 * the promise only as a settlement signal without risking an unhandled
 * rejection.
 */
export type RoonLateSettlementObserver = (
  lateSettlement: Promise<void>
) => void;

/**
 * Reject `promise` with a RoonTimeoutError if it does not settle within
 * `timeoutMs`. The Roon API gives no way to cancel an in-flight call, so
 * a late callback still settles the inner promise — its result is simply
 * discarded (both outcomes have handlers attached, so a late rejection
 * cannot become an unhandled rejection).
 */
export function withRoonTimeout<T>(
  operation: string,
  promise: Promise<T>,
  timeoutMs: number = DEFAULT_ROON_CALL_TIMEOUT_MS,
  onTimeout?: RoonLateSettlementObserver
): Promise<T> {
  const lateSettlement = promise.then<void>(
    () => undefined,
    (error: unknown) => {
      throw error instanceof Error ? error : new Error(String(error));
    }
  );
  // Mark a possible late rejection handled before exposing the promise to an
  // observer. The observer can still await the original rejecting promise.
  void lateSettlement.catch(() => undefined);

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new RoonTimeoutError(operation, timeoutMs));
      try {
        onTimeout?.(lateSettlement);
      } catch {
        // Observability must not replace the timeout result with observer code.
      }
    }, timeoutMs);
    // Don't let a pending Roon call hold the process open during shutdown.
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}
