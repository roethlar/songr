/**
 * The pacing controller's parameterization, baseline and admission safeguards.
 * There is no clock in the controller; assertions advance it by settling calls.
 */
import type { Logger } from "pino";

import {
  ADMISSION_MIN_EPOCH_SAMPLES,
  AdmissionPressureReport,
  CallAdmissionController,
} from "../CallAdmissionController";

const CORE_ID = "55555555-5555-4555-8555-555555555555";

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
  level: "info",
} as unknown as Logger;

/** Settles `count` answered calls of one kind at one latency. */
function answer<Kind extends string, Source extends string>(
  controller: CallAdmissionController<Kind, Source>,
  kind: Kind,
  latencyMs: number,
  count: number,
  coreId: string = CORE_ID
): void {
  for (let index = 0; index < count; index += 1) {
    controller.settleCall(
      controller.beginCall(coreId, kind),
      "answered",
      latencyMs
    );
  }
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("the kinds it measures are the workload's, not a constant", () => {
  it("leaves bootstrap when a single-kind workload freezes its one baseline", () => {
    // The walk drills and does nothing else. Run through a fixed three-kind
    // set it would sit at the floor forever, waiting on baselines for two
    // calls it never makes — which is the reason the set is a parameter.
    const controller = new CallAdmissionController<"drill", "artist-walk">({
      kinds: ["drill"],
      pressureSource: "artist-walk",
      cap: 4,
      logger,
    });
    controller.onCorePaired(CORE_ID);
    controller.noteHealth(CORE_ID, "healthy");

    answer(controller, "drill", 100, ADMISSION_MIN_EPOCH_SAMPLES * 2);

    expect(controller.stateFor(CORE_ID).baselineMs).toEqual({ drill: 100 });
    expect(controller.stateFor(CORE_ID).phase).toBe("ramping");
    expect(controller.limitFor(CORE_ID)).toBe(2);
  });

  it("still waits for every kind a many-kind workload declares", () => {
    // The control for the case above: the single-kind ramp must come from
    // having measured everything declared, not from having weakened the gate.
    const controller = new CallAdmissionController<
      "drill" | "count",
      "artist-walk"
    >({
      kinds: ["drill", "count"],
      pressureSource: "artist-walk",
      cap: 4,
      logger,
    });
    controller.onCorePaired(CORE_ID);
    controller.noteHealth(CORE_ID, "healthy");

    answer(controller, "drill", 100, ADMISSION_MIN_EPOCH_SAMPLES * 2);

    expect(controller.stateFor(CORE_ID).phase).toBe("bootstrap");
    expect(controller.limitFor(CORE_ID)).toBe(1);
  });

  it("refuses a workload that declares no kinds at all", () => {
    // "Every kind has a baseline" is a universal quantifier, and over an empty
    // set it is vacuously true. A controller built this way would call itself
    // ramping before it had measured anything — the one failure mode that
    // parameterizing the kinds introduces, refused at construction.
    expect(
      () =>
        new CallAdmissionController<string, "empty">({
          kinds: [],
          pressureSource: "empty",
          cap: 4,
        })
    ).toThrow(/at least one call kind/);
  });

  it("refuses a kind declared twice", () => {
    // A repeated kind is one shape's samples counted as two shapes' evidence:
    // the record is keyed by kind, so the duplicate silently shares state with
    // itself while the gate counts it twice.
    expect(
      () =>
        new CallAdmissionController<"drill", "artist-walk">({
          kinds: ["drill", "drill"],
          pressureSource: "artist-walk",
          cap: 4,
        })
    ).toThrow(/distinct/);
  });
});

describe("the pressure source is the workload's own name", () => {
  it("reports under the name the workload was built with", () => {
    const reports: AdmissionPressureReport<"artist-walk">[] = [];
    const controller = new CallAdmissionController<"drill", "artist-walk">({
      kinds: ["drill"],
      pressureSource: "artist-walk",
      cap: 4,
      logger,
      onPressure: (_coreId, report) => reports.push(report),
    });
    controller.onCorePaired(CORE_ID);

    controller.settleCall(
      controller.beginCall(CORE_ID, "drill"),
      "timed-out",
      15_000
    );

    expect(reports).toEqual([{ source: "artist-walk", kind: "timeout" }]);
  });
});

describe("the decision announcement", () => {
  it("tells a waiting workload the admission each decision left in force", () => {
    // The controller holds no caller and owns no clock, so a workload that
    // waits for admission rather than shedding work has to be told when to
    // look again. Zero on the pause, back above zero on the release.
    const seen: number[] = [];
    const controller = new CallAdmissionController<"drill", "artist-walk">({
      kinds: ["drill"],
      pressureSource: "artist-walk",
      cap: 4,
      logger,
      onDecision: (_coreId, limit) => seen.push(limit),
    });
    controller.onCorePaired(CORE_ID);

    controller.settleCall(
      controller.beginCall(CORE_ID, "drill"),
      "timed-out",
      15_000
    );
    expect(seen).toEqual([0]);

    controller.noteHealth(CORE_ID, "healthy");

    expect(seen).toEqual([0, 1]);
  });

  it("survives a listener that throws, and still takes the decision", () => {
    const controller = new CallAdmissionController<"drill", "artist-walk">({
      kinds: ["drill"],
      pressureSource: "artist-walk",
      cap: 4,
      logger,
      onDecision: () => {
        throw new Error("synthetic listener failure");
      },
    });
    controller.onCorePaired(CORE_ID);

    expect(() =>
      controller.settleCall(
        controller.beginCall(CORE_ID, "drill"),
        "timed-out",
        15_000
      )
    ).not.toThrow();
    expect(controller.limitFor(CORE_ID)).toBe(0);
  });
});
