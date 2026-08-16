import {
  LIBRARY_ALBUM_FAILURE_CODES,
  LIBRARY_ALBUM_MAX_VERSIONS,
  LIBRARY_ALBUM_MAX_TRACKS,
  LIBRARY_ALBUM_OPEN_ERROR_CODES,
  normalizeLibraryAlbumCancelAck,
  normalizeLibraryAlbumCancelRequest,
  normalizeLibraryAlbumFailedEvent,
  normalizeLibraryAlbumOpenAck,
  normalizeLibraryAlbumOpenRequest,
  normalizeLibraryAlbumResolvedEvent,
  normalizeLibraryAlbumSelectAck,
  normalizeLibraryAlbumSelectRequest,
  normalizeLibraryAlbumVersionFailedEvent,
  normalizeLibraryAlbumVersionSummary,
  normalizeLibraryAlbumVersionsEvent,
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

function version(versionId: string, editionText = "") {
  return { versionId, editionText };
}

function resolvedEvent() {
  return {
    requestId: REQUEST_ID,
    operationId: OPERATION_ID,
    generation: 4,
    versionId: "version-01",
    artist: "Artist",
    title: "Album",
    actionsAvailable: true,
    versionSummary: version("version-01"),
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

  it("rejects the retired chooser-candidate request shape", () => {
    expect(normalizeLibraryAlbumOpenRequest({
      requestId: REQUEST_ID,
      tabId: "tab-01",
      albumLocalId: ALBUM_ID,
      generation: 4,
      candidate: { title: "Album", artist: "Artist", editionText: "Remaster" },
    })).toBeNull();
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

  it("rejects the retired versionless and summaryless detail shapes", () => {
    const versionless = resolvedEvent() as Record<string, unknown>;
    delete versionless.versionId;
    expect(normalizeLibraryAlbumResolvedEvent(versionless, correlation())).toBeNull();

    const summaryless = resolvedEvent() as Record<string, unknown>;
    delete summaryless.versionSummary;
    expect(normalizeLibraryAlbumResolvedEvent(summaryless, correlation())).toBeNull();
  });

  it("accepts bounded exact track metadata and a matching version summary", () => {
    const event = {
      ...resolvedEvent(),
      versionId: "version-01",
      versionSummary: {
        versionId: "version-01",
        editionText: "Deluxe",
        sourceLabel: "Local",
        releaseDate: "2003-09-16",
        trackCount: 2,
        durationSeconds: 401,
        available: true,
      },
      orderedTracks: [
        {
          index: 0,
          title: "First",
          trackNumber: 1,
          mediaNumber: 1,
          lengthSeconds: 200,
          available: true,
        },
        { index: 1, title: "Second", lengthSeconds: null, available: false },
      ],
    };
    expect(normalizeLibraryAlbumResolvedEvent(event, correlation())).toEqual(event);
    expect(
      normalizeLibraryAlbumResolvedEvent(
        {
          ...event,
          versionSummary: { ...event.versionSummary, versionId: "version-02" },
        },
        correlation()
      )
    ).toBeNull();
  });
});

describe("library album version page contracts", () => {
  it("normalizes select requests and correlated acknowledgments", () => {
    const request = { operationId: OPERATION_ID, versionId: "version-01" };
    expect(normalizeLibraryAlbumSelectRequest(request)).toEqual(request);
    expect(
      normalizeLibraryAlbumSelectRequest({ ...request, itemKey: "raw-row" })
    ).toBeNull();

    const ack = {
      success: true,
      data: {
        ...request,
        resolvingDeadlineAt: RESOLVING_DEADLINE,
      },
    };
    expect(normalizeLibraryAlbumSelectAck(ack, request)).toEqual(ack);
    expect(
      normalizeLibraryAlbumSelectAck(ack, { ...request, versionId: "version-02" })
    ).toBeNull();
  });

  it("keeps identical display versions distinct by opaque version ID", () => {
    const event = {
      requestId: REQUEST_ID,
      operationId: OPERATION_ID,
      generation: 4,
      artist: "Artist",
      title: "Album",
      versions: [version("version-01"), version("version-02")],
    };
    expect(normalizeLibraryAlbumVersionsEvent(event, correlation())).toEqual(event);
    expect(
      normalizeLibraryAlbumVersionsEvent(
        { ...event, versions: [version("version-01"), version("version-01")] },
        correlation()
      )
    ).toBeNull();

    const oversized = Array.from(
      { length: LIBRARY_ALBUM_MAX_VERSIONS + 1 },
      (_, index) => version(`version-${index}`)
    );
    expect(
      normalizeLibraryAlbumVersionsEvent({ ...event, versions: oversized }, correlation())
    ).toBeNull();
  });

  it("treats artwork as optional bounded display data only", () => {
    expect(
      normalizeLibraryAlbumVersionSummary({
        ...version("version-01", "Remaster"),
        imageKeyHint: "same-cover",
      })
    ).toEqual({
      ...version("version-01", "Remaster"),
      imageKeyHint: "same-cover",
    });
    expect(
      normalizeLibraryAlbumVersionSummary({
        ...version("version-01"),
        imageKeyHint: "",
      })
    ).toBeNull();
  });

  it("normalizes richer display metadata but rejects private identity fields", () => {
    const summary = {
      ...version("version-01", "Deluxe"),
      sourceLabel: "Local",
      releaseDate: "2003",
      trackCount: 12,
      durationSeconds: 2_401,
      available: true,
      playCount: 4,
      lastPlayedAt: "2026-08-01T12:30:00.000Z",
      isFavorite: true,
      isListenLater: false,
      isBanned: false,
    };
    expect(normalizeLibraryAlbumVersionSummary(summary)).toEqual(summary);
    expect(
      normalizeLibraryAlbumVersionSummary({ ...summary, stableKey: "123" })
    ).toBeNull();
    expect(
      normalizeLibraryAlbumVersionSummary({ ...summary, albumId: "123" })
    ).toBeNull();
    expect(
      normalizeLibraryAlbumVersionSummary({ ...summary, releaseDate: "2003-00" })
    ).toBeNull();
  });

  it("normalizes only the expected version failure", () => {
    const event = { ...failedEvent(), versionId: "version-01" };
    const expected = { ...correlation(), versionId: "version-01" };
    expect(normalizeLibraryAlbumVersionFailedEvent(event, expected)).toEqual(event);
    expect(
      normalizeLibraryAlbumVersionFailedEvent(event, {
        ...expected,
        versionId: "version-02",
      })
    ).toBeNull();
  });
});

describe("library album failed events", () => {
  it.each(LIBRARY_ALBUM_FAILURE_CODES)("normalizes failure code %s", (code) => {
    expect(
      normalizeLibraryAlbumFailedEvent(failedEvent({ code }), correlation())
    ).toEqual(failedEvent({ code }));
  });

  it("rejects the retired chooser-candidate failure payload", () => {
    expect(
      normalizeLibraryAlbumFailedEvent(
        failedEvent({
          code: "ALBUM_AMBIGUOUS",
          candidates: [{ title: "Album", artist: "Artist", editionText: "" }],
        }),
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
