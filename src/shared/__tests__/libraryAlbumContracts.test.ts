import {
  LIBRARY_ALBUM_FAILURE_CODES,
  LIBRARY_ALBUM_MAX_CANDIDATES,
  LIBRARY_ALBUM_MAX_TRACKS,
  LIBRARY_ALBUM_OPEN_ERROR_CODES,
  normalizeLibraryAlbumCancelAck,
  normalizeLibraryAlbumCancelRequest,
  normalizeLibraryAlbumCandidate,
  normalizeLibraryAlbumFailedEvent,
  normalizeLibraryAlbumOpenAck,
  normalizeLibraryAlbumOpenRequest,
  normalizeLibraryAlbumResolvedEvent,
  type LibraryAlbumCorrelation,
} from "../libraryAlbumContracts";

const REQUEST_ID = "request-01";
const OPERATION_ID = "operation-01";
const ALBUM_ID = "018f0f64-3f31-7a9b-8c2d-8f572cb18a12";
const RESOLVING_DEADLINE = 1_752_550_000_000;

function correlation(): LibraryAlbumCorrelation {
  return {
    requestId: REQUEST_ID,
    operationId: OPERATION_ID,
    generation: 4,
    resolvingDeadlineAt: RESOLVING_DEADLINE,
  };
}

function candidate(editionText = "2011 Remaster") {
  return { title: "Album", artist: "Artist", editionText };
}

function resolvedEvent() {
  return {
    requestId: REQUEST_ID,
    operationId: OPERATION_ID,
    generation: 4,
    artist: "Artist",
    title: "Album",
    actionsAvailable: true,
    orderedTracks: [
      { index: 0, title: "First" },
      { index: 1, title: "Second" },
    ],
  };
}

function failedEvent(patch: Record<string, unknown> = {}) {
  return {
    requestId: REQUEST_ID,
    operationId: OPERATION_ID,
    generation: 4,
    resolvingDeadlineAt: RESOLVING_DEADLINE,
    error: "Failed",
    code: "ALBUM_NOT_FOUND",
    ...patch,
  };
}

describe("library album open contracts", () => {
  it("normalizes the exact keyless open request into a defensive copy", () => {
    const source = {
      requestId: REQUEST_ID,
      tabId: "tab-01",
      albumLocalId: ALBUM_ID,
      generation: 4,
    };
    const normalized = normalizeLibraryAlbumOpenRequest(source);
    expect(normalized).toEqual(source);
    expect(normalized).not.toBe(source);
  });

  it("normalizes an open request carrying a chooser candidate", () => {
    const source = {
      requestId: REQUEST_ID,
      tabId: "tab-01",
      albumLocalId: ALBUM_ID,
      generation: 4,
      candidate: candidate(),
    };
    const normalized = normalizeLibraryAlbumOpenRequest(source);
    expect(normalized).toEqual(source);
    expect(normalized?.candidate).not.toBe(source.candidate);
  });

  it("accepts an empty edition text and rejects other blank fields", () => {
    expect(normalizeLibraryAlbumCandidate(candidate(""))).toEqual(candidate(""));
    expect(
      normalizeLibraryAlbumCandidate({ ...candidate(), title: "" })
    ).toBeNull();
    expect(
      normalizeLibraryAlbumCandidate({ ...candidate(), artist: " padded " })
    ).toBeNull();
  });

  it.each([
    ["missing key", { requestId: REQUEST_ID, tabId: "tab-01", generation: 4 }],
    [
      "extra key",
      {
        requestId: REQUEST_ID,
        tabId: "tab-01",
        albumLocalId: ALBUM_ID,
        generation: 4,
        extra: true,
      },
    ],
    [
      "non-uuid album",
      { requestId: REQUEST_ID, tabId: "tab-01", albumLocalId: "album", generation: 4 },
    ],
    [
      "negative generation",
      { requestId: REQUEST_ID, tabId: "tab-01", albumLocalId: ALBUM_ID, generation: -1 },
    ],
    [
      "malformed candidate",
      {
        requestId: REQUEST_ID,
        tabId: "tab-01",
        albumLocalId: ALBUM_ID,
        generation: 4,
        candidate: { title: "Album" },
      },
    ],
  ])("rejects an invalid open request (%s)", (_label, value) => {
    expect(normalizeLibraryAlbumOpenRequest(value)).toBeNull();
  });

  it("normalizes accepted open acknowledgments only for the expected request", () => {
    const ack = {
      success: true,
      data: {
        requestId: REQUEST_ID,
        operationId: OPERATION_ID,
        resolvingDeadlineAt: RESOLVING_DEADLINE,
      },
    };
    const normalized = normalizeLibraryAlbumOpenAck(ack, REQUEST_ID);
    expect(normalized).toEqual(ack);
    expect(normalized).not.toBe(ack);
    expect(normalizeLibraryAlbumOpenAck(ack, "request-02")).toBeNull();
  });

  it.each(LIBRARY_ALBUM_OPEN_ERROR_CODES)(
    "normalizes typed open rejection %s",
    (code) => {
      expect(
        normalizeLibraryAlbumOpenAck({ success: false, error: "Rejected", code }, REQUEST_ID)
      ).toEqual({ success: false, error: "Rejected", code });
    }
  );
});

describe("library album resolved events", () => {
  it("normalizes a correlated resolved event", () => {
    const event = resolvedEvent();
    const normalized = normalizeLibraryAlbumResolvedEvent(event, correlation());
    expect(normalized).toEqual(event);
    expect(normalized).not.toBe(event);
  });

  it("rejects foreign correlation and broken track ordering", () => {
    expect(
      normalizeLibraryAlbumResolvedEvent(
        { ...resolvedEvent(), operationId: "operation-02" },
        correlation()
      )
    ).toBeNull();
    expect(
      normalizeLibraryAlbumResolvedEvent(
        {
          ...resolvedEvent(),
          orderedTracks: [
            { index: 1, title: "First" },
            { index: 0, title: "Second" },
          ],
        },
        correlation()
      )
    ).toBeNull();
    expect(
      normalizeLibraryAlbumResolvedEvent(
        { ...resolvedEvent(), orderedTracks: [] },
        correlation()
      )
    ).toBeNull();
    expect(
      normalizeLibraryAlbumResolvedEvent(
        { ...resolvedEvent(), actionsAvailable: "yes" },
        correlation()
      )
    ).toBeNull();
    const missingAuthority = resolvedEvent() as Record<string, unknown>;
    delete missingAuthority.actionsAvailable;
    expect(
      normalizeLibraryAlbumResolvedEvent(missingAuthority, correlation())
    ).toBeNull();
  });

  it("bounds the track list", () => {
    const tracks = Array.from({ length: LIBRARY_ALBUM_MAX_TRACKS + 1 }, (_, index) => ({
      index,
      title: `Track ${index}`,
    }));
    expect(
      normalizeLibraryAlbumResolvedEvent(
        { ...resolvedEvent(), orderedTracks: tracks },
        correlation()
      )
    ).toBeNull();
  });
});

describe("library album failed events", () => {
  it.each(LIBRARY_ALBUM_FAILURE_CODES)("normalizes failure code %s", (code) => {
    expect(
      normalizeLibraryAlbumFailedEvent(failedEvent({ code }), correlation())
    ).toEqual(failedEvent({ code }));
  });

  it("accepts candidates only alongside ALBUM_AMBIGUOUS", () => {
    const ambiguous = failedEvent({
      code: "ALBUM_AMBIGUOUS",
      candidates: [candidate(""), candidate()],
    });
    expect(normalizeLibraryAlbumFailedEvent(ambiguous, correlation())).toEqual(
      ambiguous
    );
    expect(
      normalizeLibraryAlbumFailedEvent(
        failedEvent({ code: "ALBUM_NOT_FOUND", candidates: [candidate()] }),
        correlation()
      )
    ).toBeNull();
  });

  it("rejects duplicate or oversized candidate sets", () => {
    expect(
      normalizeLibraryAlbumFailedEvent(
        failedEvent({ code: "ALBUM_AMBIGUOUS", candidates: [candidate(), candidate()] }),
        correlation()
      )
    ).toBeNull();
    const oversized = Array.from(
      { length: LIBRARY_ALBUM_MAX_CANDIDATES + 1 },
      (_, index) => candidate(`Edition ${index}`)
    );
    expect(
      normalizeLibraryAlbumFailedEvent(
        failedEvent({ code: "ALBUM_AMBIGUOUS", candidates: oversized }),
        correlation()
      )
    ).toBeNull();
  });

  it("rejects a drifted resolving deadline", () => {
    expect(
      normalizeLibraryAlbumFailedEvent(
        failedEvent({ resolvingDeadlineAt: RESOLVING_DEADLINE + 1 }),
        correlation()
      )
    ).toBeNull();
  });
});

describe("library album cancel contracts", () => {
  it("normalizes both cancel request shapes and their acks", () => {
    expect(normalizeLibraryAlbumCancelRequest({ requestId: REQUEST_ID })).toEqual({
      requestId: REQUEST_ID,
    });
    expect(
      normalizeLibraryAlbumCancelRequest({ operationId: OPERATION_ID })
    ).toEqual({ operationId: OPERATION_ID });
    expect(
      normalizeLibraryAlbumCancelRequest({
        requestId: REQUEST_ID,
        operationId: OPERATION_ID,
      })
    ).toBeNull();
    expect(
      normalizeLibraryAlbumCancelAck({ success: true, data: { claimed: true } })
    ).toEqual({ success: true, data: { claimed: true } });
    expect(
      normalizeLibraryAlbumCancelAck({
        success: false,
        error: "Invalid",
        code: "INVALID_REQUEST",
      })
    ).toEqual({ success: false, error: "Invalid", code: "INVALID_REQUEST" });
    expect(normalizeLibraryAlbumCancelAck({ success: true, data: {} })).toBeNull();
  });

  it("rejects prototype-polluted payloads", () => {
    const polluted = JSON.parse(
      `{"requestId":"${REQUEST_ID}","__proto__":{"admin":true}}`
    ) as Record<string, unknown>;
    expect(normalizeLibraryAlbumCancelRequest(polluted)).toBeNull();
  });
});
