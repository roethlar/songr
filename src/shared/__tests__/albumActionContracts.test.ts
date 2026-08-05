import {
  ALBUM_ACTION_BEGIN_ERROR_CODES,
  ALBUM_ACTION_FAILURE_CODES,
  ALBUM_ACTION_MAX_CHOICES,
  normalizeAlbumActionBeginAck,
  normalizeAlbumActionBeginRequest,
  normalizeAlbumActionCancelAck,
  normalizeAlbumActionCancelRequest,
  normalizeAlbumActionChoice,
  normalizeAlbumActionExecuteAck,
  normalizeAlbumActionExecuteRequest,
  normalizeAlbumActionFailedEvent,
  normalizeAlbumActionResolvedEvent,
  type AlbumActionResolutionCorrelation,
} from "../albumActionContracts";

const REQUEST_ID = "request-01";
const OPERATION_ID = "operation-01";
const ACTION_ID = "action-01";
const ALBUM_ID = "018f0f64-3f31-7a9b-8c2d-8f572cb18a12";
const RESOLVING_DEADLINE = 1_752_550_000_000;
const CHOOSING_DEADLINE = RESOLVING_DEADLINE + 30_000;

function correlation(): AlbumActionResolutionCorrelation {
  return {
    requestId: REQUEST_ID,
    operationId: OPERATION_ID,
    generation: 4,
    resolvingDeadlineAt: RESOLVING_DEADLINE,
  };
}

function choice(index = 1) {
  return {
    actionId: `action-${index}`,
    label: index === 1 ? "Play Now" : `Action ${index}`,
    semantic: index === 1 ? ("play-now" as const) : ("other" as const),
  };
}

describe("album action begin contracts", () => {
  it("normalizes the exact keyless begin request into a defensive copy", () => {
    const source = {
      requestId: REQUEST_ID,
      albumLocalId: ALBUM_ID,
      zoneId: "zone-01",
      tabId: "tab-01",
      generation: 4,
    };
    const normalized = normalizeAlbumActionBeginRequest(source);
    expect(normalized).toEqual(source);
    expect(normalized).not.toBe(source);
  });

  it("normalizes a begin request carrying a track selector", () => {
    const source = {
      requestId: REQUEST_ID,
      albumLocalId: ALBUM_ID,
      zoneId: "zone-01",
      tabId: "tab-01",
      generation: 4,
      track: { index: 3, title: "Third Track" },
    };
    const normalized = normalizeAlbumActionBeginRequest(source);
    expect(normalized).toEqual(source);
    expect(normalized?.track).not.toBe(source.track);
  });

  it.each([
    ["negative index", { index: -1, title: "Track" }],
    ["fractional index", { index: 1.5, title: "Track" }],
    ["oversized index", { index: 500, title: "Track" }],
    ["empty title", { index: 0, title: "" }],
    ["padded title", { index: 0, title: " Track " }],
    ["missing title", { index: 0 }],
    ["extra key", { index: 0, title: "Track", itemKey: "raw" }],
  ])("rejects a begin request with an invalid track selector (%s)", (_label, track) => {
    expect(
      normalizeAlbumActionBeginRequest({
        requestId: REQUEST_ID,
        albumLocalId: ALBUM_ID,
        zoneId: "zone-01",
        tabId: "tab-01",
        generation: 4,
        track,
      })
    ).toBeNull();
  });

  it("normalizes accepted begin acknowledgments only for the expected request", () => {
    const ack = {
      success: true,
      data: {
        requestId: REQUEST_ID,
        operationId: OPERATION_ID,
        resolvingDeadlineAt: RESOLVING_DEADLINE,
      },
    };
    const normalized = normalizeAlbumActionBeginAck(ack, REQUEST_ID);
    expect(normalized).toEqual(ack);
    expect(normalized).not.toBe(ack);
    expect(normalized?.success && normalized.data).not.toBe(ack.data);
    expect(normalizeAlbumActionBeginAck(ack, "request-02")).toBeNull();
  });

  it.each(ALBUM_ACTION_BEGIN_ERROR_CODES)(
    "normalizes typed begin rejection %s",
    (code) => {
      expect(
        normalizeAlbumActionBeginAck(
          { success: false, error: "Rejected", code },
          REQUEST_ID
        )
      ).toEqual({ success: false, error: "Rejected", code });
    }
  );

  it("rejects malformed or cross-arm begin acknowledgments", () => {
    expect(
      normalizeAlbumActionBeginAck(
        { success: true, data: { requestId: REQUEST_ID, operationId: OPERATION_ID } },
        REQUEST_ID
      )
    ).toBeNull();
    expect(
      normalizeAlbumActionBeginAck(
        {
          success: true,
          data: {
            requestId: REQUEST_ID,
            operationId: OPERATION_ID,
            resolvingDeadlineAt: RESOLVING_DEADLINE,
          },
          error: "cross-arm",
        },
        REQUEST_ID
      )
    ).toBeNull();
    expect(
      normalizeAlbumActionBeginAck(
        { success: false, error: "Rejected", code: "UNKNOWN" },
        REQUEST_ID
      )
    ).toBeNull();
  });

  it.each([
    ["empty request ID", { requestId: "" }],
    ["path-like request ID", { requestId: "/tmp/request" }],
    ["malformed album UUID", { albumLocalId: "album-1" }],
    ["negative generation", { generation: -1 }],
    ["fractional generation", { generation: 1.5 }],
    ["unsafe generation", { generation: Number.MAX_SAFE_INTEGER + 1 }],
    ["extra item key", { itemKey: "roon-key" }],
    ["extra session key", { multiSessionKey: "session" }],
  ])("rejects begin request with %s", (_label, patch) => {
    expect(
      normalizeAlbumActionBeginRequest({
        requestId: REQUEST_ID,
        albumLocalId: ALBUM_ID,
        zoneId: "zone-01",
        tabId: "tab-01",
        generation: 4,
        ...patch,
      })
    ).toBeNull();
  });
});

describe("album action resolution events", () => {
  it("preserves exact display labels while defensively copying unique choices", () => {
    const source = {
      requestId: REQUEST_ID,
      operationId: OPERATION_ID,
      generation: 4,
      choosingDeadlineAt: CHOOSING_DEADLINE,
      actions: [choice(1), { ...choice(2), label: "Add Next", semantic: "add-next" }],
    };
    const normalized = normalizeAlbumActionResolvedEvent(source, correlation());
    expect(normalized).toEqual(source);
    expect(normalized).not.toBe(source);
    expect(normalized?.actions).not.toBe(source.actions);
    expect(normalized?.actions[0]).not.toBe(source.actions[0]);
    expect(normalized?.actions[0].label).toBe("Play Now");
  });

  it("requires exact correlation and allows a full chooser phase with an equal timestamp", () => {
    const base = {
      requestId: REQUEST_ID,
      operationId: OPERATION_ID,
      generation: 4,
      choosingDeadlineAt: CHOOSING_DEADLINE,
      actions: [choice(1)],
    };
    expect(
      normalizeAlbumActionResolvedEvent({ ...base, requestId: "request-02" }, correlation())
    ).toBeNull();
    expect(
      normalizeAlbumActionResolvedEvent({ ...base, operationId: "operation-02" }, correlation())
    ).toBeNull();
    expect(
      normalizeAlbumActionResolvedEvent({ ...base, generation: 5 }, correlation())
    ).toBeNull();
    expect(
      normalizeAlbumActionResolvedEvent(
        { ...base, choosingDeadlineAt: RESOLVING_DEADLINE },
        correlation()
      )
    ).toEqual({ ...base, choosingDeadlineAt: RESOLVING_DEADLINE });
    expect(
      normalizeAlbumActionResolvedEvent(
        { ...base, choosingDeadlineAt: RESOLVING_DEADLINE - 1 },
        correlation()
      )
    ).toBeNull();
  });

  it("rejects empty, duplicate, sparse, or oversized choice arrays", () => {
    const event = (actions: unknown[]) => ({
      requestId: REQUEST_ID,
      operationId: OPERATION_ID,
      generation: 4,
      choosingDeadlineAt: CHOOSING_DEADLINE,
      actions,
    });
    expect(normalizeAlbumActionResolvedEvent(event([]), correlation())).toBeNull();
    expect(
      normalizeAlbumActionResolvedEvent(event([choice(1), { ...choice(1) }]), correlation())
    ).toBeNull();

    const sparse = new Array(2);
    sparse[1] = choice(2);
    expect(normalizeAlbumActionResolvedEvent(event(sparse), correlation())).toBeNull();

    const oversized = Array.from({ length: ALBUM_ACTION_MAX_CHOICES + 1 }, (_, index) =>
      choice(index + 1)
    );
    expect(normalizeAlbumActionResolvedEvent(event(oversized), correlation())).toBeNull();
  });

  it("keeps labels display-only and rejects malformed choice fields", () => {
    expect(normalizeAlbumActionChoice(choice(1))).toEqual(choice(1));
    expect(
      normalizeAlbumActionChoice({ ...choice(1), semantic: "raw-roon-action" })
    ).toBeNull();
    expect(normalizeAlbumActionChoice({ ...choice(1), label: " Play Now" })).toBeNull();
    expect(
      normalizeAlbumActionChoice({ ...choice(1), rawActionKey: "forbidden" })
    ).toBeNull();
  });

  it.each(ALBUM_ACTION_FAILURE_CODES)("normalizes correlated failure %s", (code) => {
    const event = {
      requestId: REQUEST_ID,
      operationId: OPERATION_ID,
      generation: 4,
      resolvingDeadlineAt: RESOLVING_DEADLINE,
      error: "Resolution failed",
      code,
    };
    expect(normalizeAlbumActionFailedEvent(event, correlation())).toEqual(event);
  });

  it("rejects failed events with choices or mismatched correlation", () => {
    const event = {
      requestId: REQUEST_ID,
      operationId: OPERATION_ID,
      generation: 4,
      resolvingDeadlineAt: RESOLVING_DEADLINE,
      error: "Resolution failed",
      code: "ALBUM_AMBIGUOUS",
    };
    expect(
      normalizeAlbumActionFailedEvent({ ...event, actions: [choice(1)] }, correlation())
    ).toBeNull();
    expect(
      normalizeAlbumActionFailedEvent(
        { ...event, resolvingDeadlineAt: RESOLVING_DEADLINE + 1 },
        correlation()
      )
    ).toBeNull();
  });
});

describe("album action claim and execution contracts", () => {
  it("accepts exactly one cancel authority", () => {
    expect(normalizeAlbumActionCancelRequest({ requestId: REQUEST_ID })).toEqual({
      requestId: REQUEST_ID,
    });
    expect(normalizeAlbumActionCancelRequest({ operationId: OPERATION_ID })).toEqual({
      operationId: OPERATION_ID,
    });
    expect(
      normalizeAlbumActionCancelRequest({ requestId: REQUEST_ID, operationId: OPERATION_ID })
    ).toBeNull();
    expect(normalizeAlbumActionCancelRequest({})).toBeNull();
  });

  it("accepts only the opaque action ID for execution", () => {
    expect(normalizeAlbumActionExecuteRequest({ actionId: ACTION_ID })).toEqual({
      actionId: ACTION_ID,
    });
    for (const extra of [
      { label: "Play Now" },
      { zoneId: "zone-01" },
      { albumLocalId: ALBUM_ID },
      { itemKey: "roon-key" },
      { multiSessionKey: "session" },
      { filesystemPath: "/tmp/action" },
    ]) {
      expect(normalizeAlbumActionExecuteRequest({ actionId: ACTION_ID, ...extra })).toBeNull();
    }
    expect(normalizeAlbumActionExecuteRequest({ label: "Play Now" })).toBeNull();
  });

  it("normalizes every cancel acknowledgment arm", () => {
    expect(normalizeAlbumActionCancelAck({ success: true, data: { claimed: true } })).toEqual({
      success: true,
      data: { claimed: true },
    });
    expect(normalizeAlbumActionCancelAck({ success: true, data: { claimed: false } })).toEqual({
      success: true,
      data: { claimed: false },
    });
    expect(
      normalizeAlbumActionCancelAck({
        success: false,
        error: "Bad cancel payload",
        code: "INVALID_REQUEST",
      })
    ).toEqual({ success: false, error: "Bad cancel payload", code: "INVALID_REQUEST" });
  });

  it.each([
    { claimed: false },
    { claimed: true, outcome: "executed" },
    {
      claimed: true,
      outcome: "rejected",
      code: "ZONE_CHANGED",
      error: "Target zone changed",
    },
    {
      claimed: true,
      outcome: "outcome-unknown",
      error: "Roon call did not settle",
    },
  ])("normalizes execute result %#", (data) => {
    expect(normalizeAlbumActionExecuteAck({ success: true, data })).toEqual({
      success: true,
      data,
    });
  });

  it("rejects malformed execute result discriminants", () => {
    expect(
      normalizeAlbumActionExecuteAck({
        success: true,
        data: { claimed: false, outcome: "executed" },
      })
    ).toBeNull();
    expect(
      normalizeAlbumActionExecuteAck({
        success: true,
        data: { claimed: true, outcome: "rejected", error: "Missing code" },
      })
    ).toBeNull();
    expect(
      normalizeAlbumActionExecuteAck({
        success: true,
        data: {
          claimed: true,
          outcome: "rejected",
          code: "REQUEST_ID_CONFLICT",
          error: "Wrong code family",
        },
      })
    ).toBeNull();
    expect(
      normalizeAlbumActionExecuteAck({
        success: false,
        error: "Bad payload",
        code: "NOT_OWNER",
      })
    ).toBeNull();
  });
});

describe("hostile album action payloads", () => {
  it("rejects symbol, accessor, prototype, and hostile records", () => {
    const symbolic: Record<PropertyKey, unknown> = { actionId: ACTION_ID };
    symbolic[Symbol("label")] = "Play Now";
    expect(normalizeAlbumActionExecuteRequest(symbolic)).toBeNull();

    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, "actionId", {
      enumerable: true,
      get: () => ACTION_ID,
    });
    expect(normalizeAlbumActionExecuteRequest(accessor)).toBeNull();

    expect(
      normalizeAlbumActionExecuteRequest(
        Object.assign(Object.create({ inherited: true }), { actionId: ACTION_ID })
      )
    ).toBeNull();

    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("uninspectable");
        },
      }
    );
    expect(normalizeAlbumActionBeginRequest(hostile)).toBeNull();
  });

  it("rejects invalid deadlines and oversized identifiers", () => {
    const ack = (deadline: unknown) => ({
      success: true,
      data: {
        requestId: REQUEST_ID,
        operationId: OPERATION_ID,
        resolvingDeadlineAt: deadline,
      },
    });
    expect(normalizeAlbumActionBeginAck(ack(0), REQUEST_ID)).toBeNull();
    expect(normalizeAlbumActionBeginAck(ack(1.5), REQUEST_ID)).toBeNull();
    expect(
      normalizeAlbumActionBeginAck(ack(Number.MAX_SAFE_INTEGER + 1), REQUEST_ID)
    ).toBeNull();
    expect(
      normalizeAlbumActionExecuteRequest({ actionId: "a".repeat(129) })
    ).toBeNull();
  });
});
