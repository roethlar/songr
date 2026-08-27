/**
 * Editorial session lifecycle (rich-item plan §5.3): honest absence,
 * correlation, page replacement, idle expiry, cancellation, disconnect and
 * Core invalidation, foreign-target rejection, follow-target re-minting,
 * out-of-contract port output, and prose-free logging. Synthetic data only.
 */
import {
  EditorialItemReadError,
  EditorialItemSessionService,
  type EditorialItemReadPort,
  type EditorialItemReadResult,
  type EditorialItemSink,
} from "../EditorialItemSessionService";
import type {
  EditorialItemFailedEvent,
  EditorialItemReadyEvent,
} from "../../../shared/editorialItemContracts";

const CORE = "core-a";

function sinkRecorder(): {
  sink: EditorialItemSink;
  ready: EditorialItemReadyEvent[];
  failed: EditorialItemFailedEvent[];
} {
  const ready: EditorialItemReadyEvent[] = [];
  const failed: EditorialItemFailedEvent[] = [];
  return {
    sink: {
      ready: (event) => ready.push(event),
      failed: (event) => failed.push(event),
    },
    ready,
    failed,
  };
}

function albumView(): EditorialItemReadResult {
  return {
    view: {
      kind: "album",
      title: "Album Title",
      sections: {
        review: { text: "Prose body.", source: "Provider", language: "en" },
      },
      relationshipGroups: [
        {
          label: "Similar",
          items: [{ title: "Related Artist", followTarget: "port-target-1" }],
        },
      ],
    },
    followKeys: new Map([["port-target-1", "server-key-1"]]),
  };
}

function fakePort(
  read: () => Promise<EditorialItemReadResult> = () => Promise.resolve(albumView()),
  follow: (followKey: string) => Promise<EditorialItemReadResult> = () =>
    Promise.resolve(albumView())
): EditorialItemReadPort {
  return {
    readEditorialItem: () => read(),
    followEditorialTarget: ({ followKey }) => follow(followKey),
  };
}

function openInput(sink: EditorialItemSink, overrides: Record<string, unknown> = {}) {
  return {
    socketId: "sock-1",
    coreId: CORE,
    tabId: "tab-1",
    requestId: "req-1",
    generation: 4,
    anchor: { kind: "album", albumLocalId: "alb-1" } as const,
    sink,
    ...overrides,
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function countingPort(
  result: () => EditorialItemReadResult = albumView
): { port: EditorialItemReadPort; reads: () => number } {
  let reads = 0;
  return {
    port: fakePort(() => {
      reads += 1;
      return Promise.resolve(result());
    }),
    reads: () => reads,
  };
}

async function openAndSettle(
  service: EditorialItemSessionService,
  recorder: ReturnType<typeof sinkRecorder>,
  overrides: Record<string, unknown> = {}
): Promise<EditorialItemReadyEvent> {
  const reservation = service.open(openInput(recorder.sink, overrides));
  if (!reservation.ack.ok) throw new Error("expected success ack");
  reservation.start?.();
  await settle();
  expect(recorder.failed).toHaveLength(0);
  expect(recorder.ready).toHaveLength(1);
  return recorder.ready[0];
}

describe("absence", () => {
  it("acks FEATURE_UNAVAILABLE with no session when no port is present", () => {
    const service = new EditorialItemSessionService();
    const { sink } = sinkRecorder();
    const reservation = service.open(openInput(sink));
    expect(reservation.ack).toMatchObject({ ok: false, code: "FEATURE_UNAVAILABLE" });
    expect(reservation.start).toBeUndefined();
    expect(service.liveSessionCount()).toBe(0);
  });
});

describe("open and ready", () => {
  it("delivers the normalized view with re-minted follow targets", async () => {
    const service = new EditorialItemSessionService({
      port: fakePort(),
      randomId: (() => {
        let n = 0;
        return () => `id-${++n}`;
      })(),
    });
    const recorder = sinkRecorder();
    const reservation = service.open(openInput(recorder.sink));
    if (!reservation.ack.ok) throw new Error("expected success ack");
    expect(reservation.ack.data.requestId).toBe("req-1");
    reservation.start?.();
    await settle();
    expect(recorder.failed).toHaveLength(0);
    expect(recorder.ready).toHaveLength(1);
    const event = recorder.ready[0];
    expect(event.sessionId).toBe(reservation.ack.data.sessionId);
    const target = event.view.relationshipGroups?.[0].items[0].followTarget;
    // The browser-facing target is freshly minted, never the port's id.
    expect(target).toBeDefined();
    expect(target).not.toBe("port-target-1");
  });

  it("fails closed with INVALID_RESPONSE when the port breaks the contract", async () => {
    const service = new EditorialItemSessionService({
      port: fakePort(() =>
        Promise.resolve({
          view: {
            kind: "album",
            title: "Album",
            sections: {},
            unexpected: true,
          } as never,
        })
      ),
    });
    const recorder = sinkRecorder();
    const reservation = service.open(openInput(recorder.sink));
    reservation.start?.();
    await settle();
    expect(recorder.ready).toHaveLength(0);
    expect(recorder.failed[0]).toMatchObject({ code: "INVALID_RESPONSE", retryable: false });
  });

  it("carries a wide portrait key through to the browser", async () => {
    const service = new EditorialItemSessionService({
      port: fakePort(() =>
        Promise.resolve({
          view: {
            kind: "artist",
            title: "Artist",
            artworkKey: "square/key?1",
            wideArtworkKey: "portrait-wideportraitaa",
            sections: {},
          },
        })
      ),
    });
    const recorder = sinkRecorder();
    const reservation = service.open(openInput(recorder.sink));
    reservation.start?.();
    await settle();
    expect(recorder.failed).toHaveLength(0);
    expect(recorder.ready[0].view.wideArtworkKey).toBe("portrait-wideportraitaa");
  });

  it("costs the banner, never the page, when one key fills both artwork roles", async () => {
    // The two keys name different pictures from different places, so one
    // value in both roles is a mix-up. It must not reach the browser, and
    // it must not cost the reader the page either: absence, not an error.
    //
    // The shared value is a legal WIDE reference deliberately: only then is
    // the collision itself the reason it is dropped. A bare key would be
    // refused by the tag rule first and prove nothing about this one.
    const service = new EditorialItemSessionService({
      port: fakePort(() =>
        Promise.resolve({
          view: {
            kind: "artist",
            title: "Artist",
            artworkKey: "portrait-sharedkey1",
            wideArtworkKey: "portrait-sharedkey1",
            sections: {},
          },
        })
      ),
    });
    const recorder = sinkRecorder();
    const reservation = service.open(openInput(recorder.sink));
    reservation.start?.();
    await settle();
    expect(recorder.failed).toHaveLength(0);
    expect(recorder.ready).toHaveLength(1);
    expect(recorder.ready[0].view.title).toBe("Artist");
    expect(recorder.ready[0].view.artworkKey).toBe("portrait-sharedkey1");
    expect(recorder.ready[0].view.wideArtworkKey).toBeUndefined();
  });

  it("maps hostile port output and sync throws to INVALID_RESPONSE (ri2-1)", async () => {
    // A collection that is not an array would have CRASHED the read path
    // before validation; now the malformed family is dropped by the §7
    // salvage and the remainder ships — never a crash.
    const hostile = new EditorialItemSessionService({
      port: fakePort(() =>
        Promise.resolve({
          view: {
            kind: "album",
            title: "Album",
            sections: {},
            creditGroups: {},
          } as never,
        })
      ),
    });
    const first = sinkRecorder();
    const one = hostile.open(openInput(first.sink));
    one.start?.();
    await settle();
    expect(first.ready).toHaveLength(1);
    expect("creditGroups" in first.ready[0].view).toBe(false);

    const throwing = new EditorialItemSessionService({
      port: {
        readEditorialItem: () => {
          throw new Error("sync explosion");
        },
        followEditorialTarget: () => Promise.resolve(albumView()),
      },
    });
    const second = sinkRecorder();
    const two = throwing.open(openInput(second.sink));
    expect(() => two.start?.()).not.toThrow();
    await settle();
    expect(second.failed[0]).toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("keeps valid sections when one is malformed (ri2-6)", async () => {
    const service = new EditorialItemSessionService({
      port: fakePort(() =>
        Promise.resolve({
          view: {
            kind: "album",
            title: "Album Title",
            sections: {
              review: { text: "Valid prose.", source: "Provider", language: "en" },
              biography: { text: "", source: "Provider", language: "en" },
            },
          } as never,
        })
      ),
    });
    const recorder = sinkRecorder();
    const reservation = service.open(openInput(recorder.sink));
    reservation.start?.();
    await settle();
    // The valid review survives; only the malformed biography is dropped,
    // reported in its own section-scoped failure.
    expect(recorder.ready).toHaveLength(1);
    expect(recorder.ready[0].view.sections.review?.text).toBe("Valid prose.");
    expect("biography" in recorder.ready[0].view.sections).toBe(false);
    expect(recorder.failed).toHaveLength(1);
    expect(recorder.failed[0]).toMatchObject({
      code: "INVALID_RESPONSE",
      section: "biography",
      retryable: false,
    });
  });

  it("maps port errors to their stable codes", async () => {
    const service = new EditorialItemSessionService({
      port: fakePort(() =>
        Promise.reject(new EditorialItemReadError("READ_TIMEOUT", "Core did not settle.", true))
      ),
    });
    const recorder = sinkRecorder();
    const reservation = service.open(openInput(recorder.sink));
    reservation.start?.();
    await settle();
    expect(recorder.failed[0]).toMatchObject({ code: "READ_TIMEOUT", retryable: true });
  });
});

describe("page replacement and cancellation", () => {
  it("a new open on the same tab retires the previous session", async () => {
    const service = new EditorialItemSessionService({ port: fakePort() });
    const first = sinkRecorder();
    const second = sinkRecorder();
    const one = service.open(openInput(first.sink));
    if (!one.ack.ok) throw new Error("expected success");
    const two = service.open(openInput(second.sink, { requestId: "req-2" }));
    if (!two.ack.ok) throw new Error("expected success");
    expect(service.liveSessionCount()).toBe(1);
    // The superseded session's read result must never reach the browser.
    one.start?.();
    two.start?.();
    await settle();
    expect(first.ready).toHaveLength(0);
    expect(second.ready).toHaveLength(1);
  });

  it("replacement at capacity is not backpressure (ri2-7)", () => {
    const service = new EditorialItemSessionService({ port: fakePort() });
    for (let index = 0; index < 8; index++) {
      const reservation = service.open(
        openInput(sinkRecorder().sink, {
          tabId: `tab-${index}`,
          requestId: `req-${index}`,
        })
      );
      if (!reservation.ack.ok) throw new Error("expected success");
    }
    expect(service.liveSessionCount()).toBe(8);
    // A ninth TAB is backpressure...
    expect(
      service.open(
        openInput(sinkRecorder().sink, { tabId: "tab-9", requestId: "req-9" })
      ).ack
    ).toMatchObject({ ok: false, code: "BACKPRESSURE" });
    // ...but replacing an existing tab keeps the count flat and succeeds.
    const replacement = service.open(
      openInput(sinkRecorder().sink, { tabId: "tab-0", requestId: "req-r" })
    );
    expect(replacement.ack.ok).toBe(true);
    expect(service.liveSessionCount()).toBe(8);
  });

  it("cancel retires the session and rejects foreign owners", () => {
    const service = new EditorialItemSessionService({ port: fakePort() });
    const { sink } = sinkRecorder();
    const reservation = service.open(openInput(sink));
    if (!reservation.ack.ok) throw new Error("expected success");
    const sessionId = reservation.ack.data.sessionId;
    expect(
      service.cancel({ socketId: "someone-else", tabId: "tab-1", sessionId })
    ).toBe(false);
    expect(
      service.cancel({ socketId: "sock-1", tabId: "tab-1", sessionId })
    ).toBe(true);
    expect(service.liveSessionCount()).toBe(0);
  });
});

describe("follow targets", () => {
  async function openedSession(service: EditorialItemSessionService) {
    const recorder = sinkRecorder();
    const reservation = service.open(openInput(recorder.sink));
    if (!reservation.ack.ok) throw new Error("expected success");
    reservation.start?.();
    await settle();
    const target = recorder.ready[0].view.relationshipGroups?.[0].items[0]
      .followTarget as string;
    return { sessionId: reservation.ack.data.sessionId, target, recorder };
  }

  it("follows only targets minted by the exact live session", async () => {
    const follow = jest.fn((followKey: string) =>
      Promise.resolve(albumView())
    );
    const service = new EditorialItemSessionService({
      port: fakePort(undefined, follow),
    });
    const { sessionId, target } = await openedSession(service);

    const foreignTarget = service.follow({
      socketId: "sock-1",
      coreId: CORE,
      tabId: "tab-1",
      requestId: "req-f",
      generation: 4,
      sessionId,
      target: "never-minted",
      sink: sinkRecorder().sink,
    });
    expect(foreignTarget.ack).toMatchObject({ ok: false, code: "ITEM_NOT_FOUND" });

    const foreignSocket = service.follow({
      socketId: "intruder",
      coreId: CORE,
      tabId: "tab-1",
      requestId: "req-f",
      generation: 4,
      sessionId,
      target,
      sink: sinkRecorder().sink,
    });
    expect(foreignSocket.ack).toMatchObject({ ok: false, code: "SESSION_LOST" });

    const staleGeneration = service.follow({
      socketId: "sock-1",
      coreId: CORE,
      tabId: "tab-1",
      requestId: "req-f",
      generation: 3,
      sessionId,
      target,
      sink: sinkRecorder().sink,
    });
    expect(staleGeneration.ack).toMatchObject({ ok: false, code: "SESSION_LOST" });

    const good = service.follow({
      socketId: "sock-1",
      coreId: CORE,
      tabId: "tab-1",
      requestId: "req-f",
      generation: 4,
      sessionId,
      target,
      sink: sinkRecorder().sink,
    });
    expect(good.ack.ok).toBe(true);
    good.start?.();
    await settle();
    // The follow resolved through the server-held key, never the browser id.
    expect(follow).toHaveBeenCalledWith("server-key-1");
  });

  it("a follow rebinds the session to its page generation (ri2-4)", async () => {
    const service = new EditorialItemSessionService({ port: fakePort() });
    const { sessionId, target } = await openedSession(service);
    // The related-item transition arrives with the NEW page generation.
    const forward = service.follow({
      socketId: "sock-1",
      coreId: CORE,
      tabId: "tab-1",
      requestId: "req-f",
      generation: 5,
      sessionId,
      target,
      sink: sinkRecorder().sink,
    });
    expect(forward.ack.ok).toBe(true);
    // A REJECTED follow must not move the generation: a bad target at a
    // newer generation fails ITEM_NOT_FOUND and the next valid follow at
    // the current generation still works (ri2-4 reopen).
    const badTarget = service.follow({
      socketId: "sock-1",
      coreId: CORE,
      tabId: "tab-1",
      requestId: "req-x",
      generation: 9,
      sessionId,
      target: "never-minted",
      sink: sinkRecorder().sink,
    });
    expect(badTarget.ack).toMatchObject({ ok: false, code: "ITEM_NOT_FOUND" });
    const stillCurrent = service.follow({
      socketId: "sock-1",
      coreId: CORE,
      tabId: "tab-1",
      requestId: "req-y",
      generation: 5,
      sessionId,
      target,
      sink: sinkRecorder().sink,
    });
    expect(stillCurrent.ack.ok).toBe(true);
    // The old page generation is now stale for this session.
    const stale = service.follow({
      socketId: "sock-1",
      coreId: CORE,
      tabId: "tab-1",
      requestId: "req-g",
      generation: 4,
      sessionId,
      target,
      sink: sinkRecorder().sink,
    });
    expect(stale.ack).toMatchObject({ ok: false, code: "SESSION_LOST" });
  });

  it("serves a revisited view from the session cache (ri2-5)", async () => {
    let reads = 0;
    let follows = 0;
    const service = new EditorialItemSessionService({
      port: {
        readEditorialItem: () => {
          reads++;
          return Promise.resolve(albumView());
        },
        followEditorialTarget: () => {
          follows++;
          return Promise.resolve(albumView());
        },
      },
    });
    const { sessionId, target, recorder } = await openedSession(service);
    expect(reads).toBe(1);

    // Follow the child once (a real read)...
    const first = service.follow({
      socketId: "sock-1",
      coreId: CORE,
      tabId: "tab-1",
      requestId: "req-f",
      generation: 4,
      sessionId,
      target,
      sink: recorder.sink,
    });
    first.start?.();
    await settle();
    expect(follows).toBe(1);

    // ...then Back to the parent: the SAME tab reopen reuses the session
    // and the cached parent view — no second Core read.
    const reopen = service.open(openInput(recorder.sink, { requestId: "req-b" }));
    if (!reopen.ack.ok) throw new Error("expected success");
    expect(reopen.ack.data.sessionId).toBe(sessionId);
    reopen.start?.();
    await settle();
    expect(reads).toBe(1);

    // Forward to the child again: served from the cache too, and the
    // minted target is still valid (targets live until eviction).
    const revisit = service.follow({
      socketId: "sock-1",
      coreId: CORE,
      tabId: "tab-1",
      requestId: "req-g",
      generation: 4,
      sessionId,
      target,
      sink: recorder.sink,
    });
    expect(revisit.ack.ok).toBe(true);
    revisit.start?.();
    await settle();
    expect(follows).toBe(1);
    expect(recorder.ready.length).toBeGreaterThanOrEqual(4);
  });

  it("does not cache transient views (ri6-4)", async () => {
    let reads = 0;
    const service = new EditorialItemSessionService({
      port: {
        readEditorialItem: () => {
          reads++;
          return Promise.resolve({ ...albumView(), transient: true });
        },
        followEditorialTarget: () => Promise.resolve(albumView()),
      },
    });
    const { sessionId, recorder } = await openedSession(service);
    expect(reads).toBe(1);
    // A transient view swallowed a retryable section failure: the same
    // tab's reopen must perform a FRESH read, never serve the cache.
    const reopen = service.open(openInput(recorder.sink, { requestId: "req-t" }));
    if (!reopen.ack.ok) throw new Error("expected success");
    expect(reopen.ack.data.sessionId).toBe(sessionId);
    reopen.start?.();
    await settle();
    expect(reads).toBe(2);
  });

  it("evicted cache entries retire their minted targets (ri2-5)", async () => {
    const service = new EditorialItemSessionService({
      port: fakePort(),
      viewCacheCap: 1,
    });
    const { sessionId, target, recorder } = await openedSession(service);
    // The follow caches the child view; at cap 1 the parent entry is
    // evicted and its targets expire honestly.
    const follow = service.follow({
      socketId: "sock-1",
      coreId: CORE,
      tabId: "tab-1",
      requestId: "req-f",
      generation: 4,
      sessionId,
      target,
      sink: recorder.sink,
    });
    follow.start?.();
    await settle();
    const stale = service.follow({
      socketId: "sock-1",
      coreId: CORE,
      tabId: "tab-1",
      requestId: "req-g",
      generation: 4,
      sessionId,
      target,
      sink: recorder.sink,
    });
    expect(stale.ack).toMatchObject({ ok: false, code: "ITEM_NOT_FOUND" });
  });
});

describe("expiry and teardown", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("expires an idle session after ten minutes", () => {
    const service = new EditorialItemSessionService({ port: fakePort() });
    const { sink } = sinkRecorder();
    const reservation = service.open(openInput(sink));
    if (!reservation.ack.ok) throw new Error("expected success");
    jest.advanceTimersByTime(10 * 60_000 - 1);
    expect(service.liveSessionCount()).toBe(1);
    jest.advanceTimersByTime(2);
    expect(service.liveSessionCount()).toBe(0);
  });

  it("emits READ_TIMEOUT when the read outlives its deadline (ri2-2)", async () => {
    let resolveRead: (value: EditorialItemReadResult) => void = () => undefined;
    const pending = new Promise<EditorialItemReadResult>((resolve) => {
      resolveRead = resolve;
    });
    const service = new EditorialItemSessionService({
      port: fakePort(() => pending),
      readDeadlineMs: 1_000,
    });
    const recorder = sinkRecorder();
    const reservation = service.open(openInput(recorder.sink));
    reservation.start?.();
    jest.advanceTimersByTime(1_001);
    expect(recorder.failed[0]).toMatchObject({
      code: "READ_TIMEOUT",
      retryable: true,
    });
    // The retired read's late settlement never reaches the browser.
    resolveRead(albumView());
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(recorder.ready).toHaveLength(0);
  });

  it("disconnect, Core invalidation, and shutdown retire everything", () => {
    const service = new EditorialItemSessionService({ port: fakePort() });
    const openOn = (socketId: string, tabId: string, coreId: string) => {
      const reservation = service.open(
        openInput(sinkRecorder().sink, { socketId, tabId, coreId })
      );
      if (!reservation.ack.ok) throw new Error("expected success");
    };
    openOn("sock-1", "tab-1", CORE);
    openOn("sock-2", "tab-2", CORE);
    openOn("sock-3", "tab-3", "core-b");
    expect(service.liveSessionCount()).toBe(3);
    service.disconnectSocket("sock-1");
    expect(service.liveSessionCount()).toBe(2);
    service.invalidateCore(CORE);
    expect(service.liveSessionCount()).toBe(1);
    service.shutdown();
    expect(service.liveSessionCount()).toBe(0);
    expect(service.open(openInput(sinkRecorder().sink)).ack).toMatchObject({
      ok: false,
      code: "SESSION_LOST",
    });
  });

  it("aborts the in-flight read on every close path (ri2-3)", async () => {
    jest.useRealTimers();
    let observedSignal: AbortSignal | undefined;
    const service = new EditorialItemSessionService({
      port: {
        readEditorialItem: ({ signal }) => {
          observedSignal = signal;
          return new Promise<EditorialItemReadResult>(() => undefined);
        },
        followEditorialTarget: () => Promise.resolve(albumView()),
      },
    });
    const reservation = service.open(openInput(sinkRecorder().sink));
    reservation.start?.();
    await Promise.resolve();
    expect(observedSignal?.aborted).toBe(false);
    service.disconnectSocket("sock-1");
    expect(observedSignal?.aborted).toBe(true);
  });

  it("a late read result never reaches a retired session", async () => {
    jest.useRealTimers();
    let resolveRead: (value: EditorialItemReadResult) => void = () => undefined;
    const pending = new Promise<EditorialItemReadResult>((resolve) => {
      resolveRead = resolve;
    });
    const service = new EditorialItemSessionService({
      port: fakePort(() => pending),
    });
    const recorder = sinkRecorder();
    const reservation = service.open(openInput(recorder.sink));
    if (!reservation.ack.ok) throw new Error("expected success");
    reservation.start?.();
    service.disconnectSocket("sock-1");
    resolveRead(albumView());
    await settle();
    expect(recorder.ready).toHaveLength(0);
    expect(recorder.failed).toHaveLength(0);
  });
});

describe("log hygiene", () => {
  it("never logs prose, titles, or view content", async () => {
    const lines: unknown[] = [];
    const logger = {
      debug: (...args: unknown[]) => lines.push(args),
      info: (...args: unknown[]) => lines.push(args),
      warn: (...args: unknown[]) => lines.push(args),
      error: (...args: unknown[]) => lines.push(args),
    } as never;
    const service = new EditorialItemSessionService({
      port: fakePort(),
      logger,
    });
    const recorder = sinkRecorder();
    const reservation = service.open(openInput(recorder.sink));
    reservation.start?.();
    await settle();
    service.disconnectSocket("sock-1");
    const serialized = JSON.stringify(lines);
    expect(serialized).not.toContain("Prose body");
    expect(serialized).not.toContain("Album Title");
    expect(serialized).not.toContain("Related Artist");
  });
});


describe("cross-session view cache (Q9)", () => {
  it("serves a second session's open of the same item from the shared cache", async () => {
    const { port, reads } = countingPort();
    let n = 0;
    const service = new EditorialItemSessionService({
      port,
      randomId: () => `id-${++n}`,
    });
    const first = sinkRecorder();
    const eventA = await openAndSettle(service, first);
    const targetA = eventA.view.relationshipGroups?.[0].items[0].followTarget;
    expect(reads()).toBe(1);

    const second = sinkRecorder();
    const reservationB = service.open(
      openInput(second.sink, {
        socketId: "sock-2",
        tabId: "tab-2",
        requestId: "req-2",
      })
    );
    if (!reservationB.ack.ok) throw new Error("expected success ack");
    reservationB.start?.();
    await settle();

    // No second Core read, and the shared view is rebuilt for THIS session.
    expect(second.failed).toHaveLength(0);
    expect(second.ready).toHaveLength(1);
    expect(reads()).toBe(1);
    const targetB =
      second.ready[0].view.relationshipGroups?.[0].items[0].followTarget;
    expect(targetB).toBeDefined();
    expect(targetB).not.toBe(targetA);

    // The shared hit's minted target works through its own session.
    const followRecorder = sinkRecorder();
    const follow = service.follow({
      socketId: "sock-2",
      coreId: CORE,
      tabId: "tab-2",
      requestId: "req-3",
      generation: 4,
      sessionId: reservationB.ack.data.sessionId,
      target: targetB as string,
      sink: followRecorder.sink,
    });
    expect(follow.ack.ok).toBe(true);
  });

  it("never shares a transient view", async () => {
    const { port, reads } = countingPort(() => ({
      ...albumView(),
      transient: true,
    }));
    const service = new EditorialItemSessionService({ port });
    await openAndSettle(service, sinkRecorder());
    await openAndSettle(service, sinkRecorder(), {
      socketId: "sock-2",
      tabId: "tab-2",
      requestId: "req-2",
    });
    expect(reads()).toBe(2);
  });

  it("expires shared views at the TTL", async () => {
    let now = 1_000_000;
    const { port, reads } = countingPort();
    const service = new EditorialItemSessionService({ port, now: () => now });
    await openAndSettle(service, sinkRecorder());

    now += 10 * 60_000;
    await openAndSettle(service, sinkRecorder(), {
      socketId: "sock-2",
      tabId: "tab-2",
      requestId: "req-2",
    });
    expect(reads()).toBe(2);
  });

  it("drops shared views on Core invalidation", async () => {
    const { port, reads } = countingPort();
    const service = new EditorialItemSessionService({ port });
    await openAndSettle(service, sinkRecorder());

    service.invalidateCore(CORE);
    await openAndSettle(service, sinkRecorder(), {
      socketId: "sock-2",
      tabId: "tab-2",
      requestId: "req-2",
    });
    expect(reads()).toBe(2);
  });
});


describe("profile authority fencing (q9-1)", () => {
  it("drops shared views, session caches, and minted targets when the profile authority changes", async () => {
    let authority: string | null = "profile-a";
    let calls = 0;
    const port: EditorialItemReadPort = {
      readEditorialItem: () => {
        calls += 1;
        return Promise.resolve({
          view: {
            ...albumView().view,
            title: calls === 1 ? "Old Profile View" : "New Profile View",
          },
        });
      },
      followEditorialTarget: () => Promise.resolve(albumView()),
    };
    let n = 0;
    const service = new EditorialItemSessionService({
      port,
      randomId: () => `id-${++n}`,
      readAuthority: () => authority,
    });

    const first = sinkRecorder();
    const eventA = await openAndSettle(service, first);
    const targetA = eventA.view.relationshipGroups?.[0].items[0].followTarget;
    // Same authority, new session: shared hit.
    await openAndSettle(service, sinkRecorder(), {
      socketId: "sock-2",
      tabId: "tab-2",
      requestId: "req-2",
    });
    expect(calls).toBe(1);

    authority = "profile-b";
    // The stale-authority shared entry is never served.
    await openAndSettle(service, sinkRecorder(), {
      socketId: "sock-3",
      tabId: "tab-3",
      requestId: "req-3",
    });
    expect(calls).toBe(2);

    // The first session's own cache was purged too: its reopen must not
    // serve the old authority's content.
    const again = sinkRecorder();
    const eventD = await openAndSettle(service, again, { requestId: "req-4" });
    expect(eventD.view.title).toBe("New Profile View");

    // And a follow target minted from the old authority's content is retired.
    const followRecorder = sinkRecorder();
    const follow = service.follow({
      socketId: "sock-1",
      coreId: CORE,
      tabId: "tab-1",
      requestId: "req-5",
      generation: 4,
      sessionId: eventA.sessionId,
      target: targetA as string,
      sink: followRecorder.sink,
    });
    expect(follow.ack).toMatchObject({ ok: false, code: "ITEM_NOT_FOUND" });
  });

  it("never publishes a late read started under an older authority into the shared cache", async () => {
    let authority: string | null = "profile-a";
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    let calls = 0;
    const port: EditorialItemReadPort = {
      readEditorialItem: async () => {
        calls += 1;
        const title = calls === 1 ? "Old Profile View" : "New Profile View";
        if (calls === 1) await gate;
        return { view: { ...albumView().view, title } };
      },
      followEditorialTarget: () => Promise.resolve(albumView()),
    };
    const service = new EditorialItemSessionService({
      port,
      readAuthority: () => authority,
    });

    // A read starts under profile-a and stays in flight...
    const first = sinkRecorder();
    const reservation = service.open(openInput(first.sink));
    if (!reservation.ack.ok) throw new Error("expected success ack");
    reservation.start?.();
    await settle();

    // ...the authority changes, and a second session completes a fresh read
    // under profile-b before the first read settles.
    authority = "profile-b";
    await openAndSettle(service, sinkRecorder(), {
      socketId: "sock-2",
      tabId: "tab-2",
      requestId: "req-2",
    });
    expect(calls).toBe(2);

    release();
    await settle();
    // The late read completes into NOTHING (q10-1): no ready for the old
    // authority's content, an honest retryable failure instead...
    expect(first.ready).toHaveLength(0);
    expect(first.failed[0]).toMatchObject({
      code: "SESSION_LOST",
      retryable: true,
    });

    // ...but the late result must not overwrite the new authority's cache:
    // the next session is served the profile-b read, not the late one.
    const third = sinkRecorder();
    const eventC = await openAndSettle(service, third, {
      socketId: "sock-3",
      tabId: "tab-3",
      requestId: "req-3",
    });
    expect(calls).toBe(2);
    expect(eventC.view.title).toBe("New Profile View");
  });
});


describe("shared cache eviction order (q9-2)", () => {
  it("keeps a hot entry over a cold one at capacity", async () => {
    const counts = new Map<string, number>();
    const port: EditorialItemReadPort = {
      readEditorialItem: ({ anchor }) => {
        const id = anchor.kind === "album" ? anchor.albumLocalId : "unknown";
        counts.set(id, (counts.get(id) ?? 0) + 1);
        return Promise.resolve(albumView());
      },
      followEditorialTarget: () => Promise.resolve(albumView()),
    };
    const service = new EditorialItemSessionService({
      port,
      sharedViewCacheCap: 2,
    });
    let tab = 0;
    const open = (albumLocalId: string): Promise<EditorialItemReadyEvent> =>
      openAndSettle(service, sinkRecorder(), {
        tabId: `tab-${++tab}`,
        requestId: `req-${tab}`,
        anchor: { kind: "album", albumLocalId },
      });

    await open("alb-a");
    await open("alb-b");
    // The hit moves A to the young end without refreshing its TTL.
    await open("alb-a");
    expect(counts.get("alb-a")).toBe(1);
    // Caching C evicts the cold B, not the hot A.
    await open("alb-c");
    await open("alb-a");
    expect(counts.get("alb-a")).toBe(1);
    await open("alb-b");
    expect(counts.get("alb-b")).toBe(2);
  });
});


describe("in-flight read fencing (q10-1)", () => {
  it("rejects an in-flight read that completes after its profile authority retired", async () => {
    let authority: string | null = "profile-a";
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    let calls = 0;
    const port: EditorialItemReadPort = {
      readEditorialItem: async () => {
        calls += 1;
        if (calls === 1) await gate;
        return {
          view: {
            ...albumView().view,
            title: calls === 1 ? "Old Profile View" : "New Profile View",
          },
        };
      },
      followEditorialTarget: () => Promise.resolve(albumView()),
    };
    let n = 0;
    const service = new EditorialItemSessionService({
      port,
      randomId: () => `id-${++n}`,
      readAuthority: () => authority,
    });

    // A read starts under profile-a and stays in flight...
    const first = sinkRecorder();
    const reservation = service.open(openInput(first.sink));
    if (!reservation.ack.ok) throw new Error("expected success ack");
    reservation.start?.();
    await settle();

    // ...the authority flips and the purge runs (triggered by a second
    // session's open) before the first read settles.
    authority = "profile-b";
    await openAndSettle(service, sinkRecorder(), {
      socketId: "sock-2",
      tabId: "tab-2",
      requestId: "req-2",
    });
    expect(calls).toBe(2);

    release();
    await settle();
    // The late completion is rejected honestly: no ready event, a retryable
    // SESSION_LOST, and NOTHING cached for the next open of that session.
    expect(first.ready).toHaveLength(0);
    expect(first.failed).toHaveLength(1);
    expect(first.failed[0]).toMatchObject({
      code: "SESSION_LOST",
      retryable: true,
    });

    // The reopen must not serve the rejected read — a fresh P2 read or the
    // P2 shared entry, never the old authority's content.
    const again = sinkRecorder();
    const reopened = await openAndSettle(service, again, { requestId: "req-3" });
    expect(reopened.view.title).toBe("New Profile View");
  });
});


describe("authority-raced read rejection (q11-1)", () => {
  it("maps an old-authority read's rejection to retryable SESSION_LOST", async () => {
    let authority: string | null = "profile-a";
    let reject!: (error: unknown) => void;
    const gate = new Promise<void>((_resolve, rejectPromise) => {
      reject = rejectPromise;
    });
    const port: EditorialItemReadPort = {
      readEditorialItem: async () => {
        await gate;
        return albumView();
      },
      followEditorialTarget: () => Promise.resolve(albumView()),
    };
    const service = new EditorialItemSessionService({
      port,
      readAuthority: () => authority,
    });
    const recorder = sinkRecorder();
    const reservation = service.open(openInput(recorder.sink));
    if (!reservation.ack.ok) throw new Error("expected success ack");
    reservation.start?.();
    await settle();

    // The profile flips mid-read; the old-authority read then rejects with
    // a NON-retryable class — the page must still get retryable
    // SESSION_LOST, or it hides retry and the section stays dead.
    authority = "profile-b";
    reject(new EditorialItemReadError("INVALID_RESPONSE", "bad payload", false));
    await settle();

    expect(recorder.ready).toHaveLength(0);
    expect(recorder.failed).toHaveLength(1);
    expect(recorder.failed[0]).toMatchObject({
      code: "SESSION_LOST",
      retryable: true,
    });
  });
});
