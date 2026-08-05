import type {
  CatalogArtistAlbumsResponse,
  CatalogStatus,
} from "../timelineCatalogContracts";
import {
  normalizeTimelineAlbumDetailBeginAck,
  normalizeTimelineAlbumDetailCloseAck,
  normalizeTimelineAlbumDetailCloseFailedEvent,
  normalizeTimelineAlbumDetailClosedEvent,
  normalizeTimelineAlbumDetailCloseRequest,
  normalizeTimelineAlbumDetailFailedEvent,
  normalizeTimelineAlbumDetailLoadedEvent,
  normalizeTimelineAlbumDetailRequest,
  normalizeTimelineSessionReconnectAck,
  normalizeTimelineSessionReconnectRequest,
  normalizeTimelineSessionReleaseAck,
  normalizeTimelineSessionReleaseRequest,
  normalizeTimelineArtistLoadBeginAck,
  normalizeTimelineArtistLoadFailedEvent,
  normalizeTimelineArtistLoadedEvent,
  normalizeTimelineArtistLoadRequest,
  type TimelineAlbumDetailCloseCorrelation,
  type TimelineAlbumDetailCloseRequest,
  type TimelineAlbumDetailCorrelation,
  type TimelineAlbumDetailRequest,
  type TimelineAlbumDetailSnapshot,
  type TimelineArtistLoadCorrelation,
  type TimelineSessionReconnectRequest,
  type TimelineSessionReleaseRequest,
} from "../timelineBrowseContracts";

const ARTIST_ID = "10000000-0000-4000-8000-000000000001";
const AUXILIARY_ARTIST_ID = "10000000-0000-4000-8000-000000000002";
const ALBUM_ID = "20000000-0000-4000-8000-000000000001";
const AT = "2026-07-15T00:00:00.000Z";

function status(): CatalogStatus {
  return {
    coreId: "core-a",
    freshness: "fresh",
    persistence: "healthy",
    refresh: "idle",
    available: true,
    complete: true,
    revision: 2,
    artistCount: 1,
    albumCount: 1,
    updatedAt: AT,
    lastCompleteScanAt: AT,
  };
}

function discography(): CatalogArtistAlbumsResponse {
  return {
    status: status(),
    artist: {
      localId: ARTIST_ID,
      coreId: "core-a",
      exactName: "Björk",
      normalizedName: "björk",
      firstSeenAt: AT,
      lastSeenAt: AT,
      resolutionStatus: "resolved",
    },
    limit: 500,
    total: 1,
    truncated: false,
    albums: [
      {
        localId: ALBUM_ID,
        coreId: "core-a",
        artistLocalId: ARTIST_ID,
        exactTitle: "Homogenic",
        exactArtist: "Björk",
        normalizedTitle: "homogenic",
        normalizedArtist: "björk",
        editionText: "",
        firstSeenAt: AT,
        lastSeenAt: AT,
        resolutionStatus: "resolved",
      },
    ],
  };
}

function correlation(): TimelineArtistLoadCorrelation {
  return {
    requestId: "artist-load-1",
    session: { handleId: "mode-handle-1", generation: 7 },
    loadingDeadlineAt: 2_000_000_000_000,
  };
}

function detailRequest(): TimelineAlbumDetailRequest {
  return {
    requestId: "detail-load-1",
    tabId: "timeline-tab-1",
    session: { handleId: "mode-handle-1", generation: 7 },
    artistLocalId: ARTIST_ID,
    albumLocalId: ALBUM_ID,
  };
}

function detailCorrelation(): TimelineAlbumDetailCorrelation {
  const request = detailRequest();
  return {
    requestId: request.requestId,
    session: request.session,
    artistLocalId: request.artistLocalId,
    albumLocalId: request.albumLocalId,
    loadingDeadlineAt: 2_000_000_000_000,
  };
}

function detailSnapshot(): TimelineAlbumDetailSnapshot {
  const response = discography();
  return {
    artist: response.artist,
    album: {
      ...response.albums[0],
      trackTitleFingerprint: "a".repeat(64),
    },
    orderedTrackTitles: ["Hunter", "Jóga"],
  };
}

function closeRequest(): TimelineAlbumDetailCloseRequest {
  return {
    requestId: "detail-close-1",
    tabId: "timeline-tab-1",
    session: { handleId: "mode-handle-1", generation: 7 },
    baseArtistLocalId: ARTIST_ID,
    detailArtistLocalId: ARTIST_ID,
    albumLocalId: ALBUM_ID,
  };
}

function closeCorrelation(): TimelineAlbumDetailCloseCorrelation {
  const request = closeRequest();
  return {
    requestId: request.requestId,
    session: request.session,
    baseArtistLocalId: request.baseArtistLocalId,
    detailArtistLocalId: request.detailArtistLocalId,
    albumLocalId: request.albumLocalId,
    closingDeadlineAt: 2_000_000_000_000,
  };
}

function reconnectRequest(): TimelineSessionReconnectRequest {
  return {
    requestId: "session-reconnect-1",
    tabId: "timeline-tab-1",
    session: { handleId: "mode-handle-1", generation: 7 },
  };
}

function releaseRequest(): TimelineSessionReleaseRequest {
  return {
    requestId: "session-release-1",
    tabId: "timeline-tab-1",
    session: { handleId: "mode-handle-1", generation: 7 },
  };
}

describe("Timeline artist-load contracts", () => {
  it("accepts only the exact keyless load request", () => {
    const request = {
      requestId: "artist-load-1",
      tabId: "timeline-tab-1",
      artistLocalId: ARTIST_ID,
    };
    expect(normalizeTimelineArtistLoadRequest(request)).toEqual(request);
    expect(
      normalizeTimelineArtistLoadRequest({ ...request, itemKey: "forbidden" })
    ).toBeNull();
    expect(
      normalizeTimelineArtistLoadRequest({ ...request, artistLocalId: "not-a-uuid" })
    ).toBeNull();
  });

  it("normalizes an immediate correlated begin acknowledgment", () => {
    const expected = correlation();
    expect(
      normalizeTimelineArtistLoadBeginAck(
        { success: true, data: expected },
        expected.requestId
      )
    ).toEqual({ success: true, data: expected });
    expect(
      normalizeTimelineArtistLoadBeginAck(
        {
          success: true,
          data: { ...expected, session: { ...expected.session, multiSessionKey: "raw" } },
        },
        expected.requestId
      )
    ).toBeNull();
  });

  it("normalizes only the loaded event bound to the acknowledged generation", () => {
    const expected = correlation();
    const event = { ...expected, discography: discography() };
    const normalized = normalizeTimelineArtistLoadedEvent(event, expected);
    expect(normalized).toEqual(event);
    expect(normalized).not.toBe(event);
    expect(
      normalizeTimelineArtistLoadedEvent(
        {
          ...event,
          session: { ...event.session, generation: event.session.generation + 1 },
        },
        expected
      )
    ).toBeNull();
    expect(
      normalizeTimelineArtistLoadedEvent(
        {
          ...event,
          discography: {
            ...event.discography,
            albums: [
              {
                ...event.discography.albums[0],
                artistLocalId: "30000000-0000-4000-8000-000000000001",
              },
            ],
          },
        },
        expected
      )
    ).toBeNull();
  });

  it("accepts only a correlated, bounded, enumerated terminal failure", () => {
    const expected = correlation();
    const event = {
      ...expected,
      code: "ARTIST_AMBIGUOUS" as const,
      error: "Artist could not be resolved uniquely",
    };
    expect(normalizeTimelineArtistLoadFailedEvent(event, expected)).toEqual(event);
    expect(
      normalizeTimelineArtistLoadFailedEvent(
        { ...event, code: "ITEM_KEY_EXPIRED" },
        expected
      )
    ).toBeNull();
    expect(
      normalizeTimelineArtistLoadFailedEvent(
        { ...event, requestId: "artist-load-2" },
        expected
      )
    ).toBeNull();
  });
});

describe("Timeline album-detail contracts", () => {
  it("accepts only the exact stable-ID detail request and opaque session", () => {
    const request = detailRequest();

    expect(normalizeTimelineAlbumDetailRequest(request)).toEqual(request);
    expect(
      normalizeTimelineAlbumDetailRequest({ ...request, itemKey: "forbidden" })
    ).toBeNull();
    expect(
      normalizeTimelineAlbumDetailRequest({
        ...request,
        session: { ...request.session, kind: "mode" },
      })
    ).toBeNull();
    expect(
      normalizeTimelineAlbumDetailRequest({
        ...request,
        albumLocalId: request.artistLocalId,
      })
    ).toBeNull();
  });

  it("binds the accepted detail acknowledgment to every request field", () => {
    const request = detailRequest();
    const accepted = { success: true as const, data: detailCorrelation() };

    expect(normalizeTimelineAlbumDetailBeginAck(accepted, request)).toEqual(
      accepted
    );
    expect(
      normalizeTimelineAlbumDetailBeginAck(
        {
          ...accepted,
          data: {
            ...accepted.data,
            session: {
              ...accepted.data.session,
              generation: accepted.data.session.generation + 1,
            },
          },
        },
        request
      )
    ).toBeNull();
    expect(
      normalizeTimelineAlbumDetailBeginAck(
        {
          success: false,
          code: "ITEM_KEY_EXPIRED",
          error: "Raw key expired",
        },
        request
      )
    ).toBeNull();
  });

  it("normalizes one correlated keyless detail snapshot", () => {
    const expected = detailCorrelation();
    const event = { ...expected, detail: detailSnapshot() };
    const normalized = normalizeTimelineAlbumDetailLoadedEvent(event, expected);

    expect(normalized).toEqual(event);
    expect(normalized).not.toBe(event);
    expect(normalized?.detail.orderedTrackTitles).not.toBe(
      event.detail.orderedTrackTitles
    );
    expect(
      normalizeTimelineAlbumDetailLoadedEvent(
        {
          ...event,
          detail: { ...event.detail, itemKey: "forbidden" },
        },
        expected
      )
    ).toBeNull();
    expect(
      normalizeTimelineAlbumDetailLoadedEvent(
        {
          ...event,
          detail: {
            ...event.detail,
            album: { ...event.detail.album, coreId: "core-b" },
          },
        },
        expected
      )
    ).toBeNull();
    const { trackTitleFingerprint: _fingerprint, ...albumWithoutFingerprint } =
      event.detail.album;
    expect(_fingerprint).toHaveLength(64);
    expect(
      normalizeTimelineAlbumDetailLoadedEvent(
        {
          ...event,
          detail: {
            ...event.detail,
            album: albumWithoutFingerprint,
          },
        },
        expected
      )
    ).toBeNull();
  });

  it("requires a complete dense bounded canonical track sequence", () => {
    const expected = detailCorrelation();
    const detail = detailSnapshot();
    const sparse = ["Hunter"];
    sparse.length = 2;

    expect(
      normalizeTimelineAlbumDetailLoadedEvent(
        {
          ...expected,
          detail: {
            ...detail,
            orderedTrackTitles: Array.from(
              { length: 501 },
              (_, index) => `Track ${index + 1}`
            ),
          },
        },
        expected
      )
    ).toBeNull();
    expect(
      normalizeTimelineAlbumDetailLoadedEvent(
        {
          ...expected,
          detail: { ...detail, orderedTrackTitles: sparse },
        },
        expected
      )
    ).toBeNull();
    expect(
      normalizeTimelineAlbumDetailLoadedEvent(
        {
          ...expected,
          detail: { ...detail, orderedTrackTitles: [" Hunter"] },
        },
        expected
      )
    ).toBeNull();
  });

  it("accepts only a correlated enumerated detail failure", () => {
    const expected = detailCorrelation();
    const event = {
      ...expected,
      code: "ALBUM_AMBIGUOUS" as const,
      error: "Album could not be resolved uniquely",
    };

    expect(normalizeTimelineAlbumDetailFailedEvent(event, expected)).toEqual(
      event
    );
    expect(
      normalizeTimelineAlbumDetailFailedEvent(
        { ...event, albumLocalId: "20000000-0000-4000-8000-000000000002" },
        expected
      )
    ).toBeNull();
    expect(
      normalizeTimelineAlbumDetailFailedEvent(
        { ...event, code: "ACTION_UNAVAILABLE" },
        expected
      )
    ).toBeNull();
  });
});

describe("Timeline session-reconnect contracts", () => {
  it("accepts only an exact opaque-session reconnect request", () => {
    const request = reconnectRequest();

    expect(normalizeTimelineSessionReconnectRequest(request)).toEqual(request);
    expect(
      normalizeTimelineSessionReconnectRequest({
        ...request,
        session: { ...request.session, multiSessionKey: "forbidden" },
      })
    ).toBeNull();
    expect(
      normalizeTimelineSessionReconnectRequest({
        ...request,
        artistLocalId: ARTIST_ID,
      })
    ).toBeNull();
  });

  it("accepts only the unchanged correlated session in the reconnect ack", () => {
    const request = reconnectRequest();
    const accepted = {
      success: true as const,
      data: { requestId: request.requestId, session: request.session },
    };

    expect(normalizeTimelineSessionReconnectAck(accepted, request)).toEqual(
      accepted
    );
    expect(
      normalizeTimelineSessionReconnectAck(
        {
          ...accepted,
          data: {
            ...accepted.data,
            session: {
              ...accepted.data.session,
              generation: accepted.data.session.generation + 1,
            },
          },
        },
        request
      )
    ).toBeNull();
    expect(
      normalizeTimelineSessionReconnectAck(
        {
          success: false,
          code: "OWNER_MISMATCH",
          error: "Session owner changed",
        },
        request
      )
    ).toBeNull();
  });
});

describe("Timeline session-release contracts", () => {
  it("accepts only an exact opaque-session release request", () => {
    const request = releaseRequest();

    expect(normalizeTimelineSessionReleaseRequest(request)).toEqual(request);
    expect(
      normalizeTimelineSessionReleaseRequest({
        ...request,
        session: { ...request.session, multiSessionKey: "forbidden" },
      })
    ).toBeNull();
    expect(
      normalizeTimelineSessionReleaseRequest({ ...request, itemKey: "forbidden" })
    ).toBeNull();
  });

  it("accepts only the exact released generation in the acknowledgment", () => {
    const request = releaseRequest();
    const accepted = {
      success: true as const,
      data: { requestId: request.requestId, session: request.session },
    };

    expect(normalizeTimelineSessionReleaseAck(accepted, request)).toEqual(accepted);
    expect(
      normalizeTimelineSessionReleaseAck(
        {
          ...accepted,
          data: {
            ...accepted.data,
            session: {
              ...accepted.data.session,
              generation: accepted.data.session.generation + 1,
            },
          },
        },
        request
      )
    ).toBeNull();
    expect(
      normalizeTimelineSessionReleaseAck(
        { success: false, code: "OWNER_MISMATCH", error: "Session owner changed" },
        request
      )
    ).toBeNull();
  });
});

describe("Timeline album-detail close contracts", () => {
  it("accepts exact primary and auxiliary stable-ID close requests", () => {
    const primary = closeRequest();
    const auxiliary = {
      ...primary,
      detailArtistLocalId: AUXILIARY_ARTIST_ID,
    };

    expect(normalizeTimelineAlbumDetailCloseRequest(primary)).toEqual(primary);
    expect(normalizeTimelineAlbumDetailCloseRequest(auxiliary)).toEqual(
      auxiliary
    );
    expect(
      normalizeTimelineAlbumDetailCloseRequest({
        ...primary,
        itemKey: "forbidden",
      })
    ).toBeNull();
  });

  it("binds the close acknowledgment to the exact live semantic target", () => {
    const request = closeRequest();
    const accepted = { success: true as const, data: closeCorrelation() };

    expect(normalizeTimelineAlbumDetailCloseAck(accepted, request)).toEqual(
      accepted
    );
    expect(
      normalizeTimelineAlbumDetailCloseAck(
        {
          ...accepted,
          data: {
            ...accepted.data,
            detailArtistLocalId: AUXILIARY_ARTIST_ID,
          },
        },
        request
      )
    ).toBeNull();
  });

  it("publishes only the freshly validated base-artist discography on close", () => {
    const expected = closeCorrelation();
    const event = { ...expected, discography: discography() };
    const wrongBase = discography();
    const mismatchedDiscography = {
      ...wrongBase,
      artist: { ...wrongBase.artist, localId: AUXILIARY_ARTIST_ID },
      albums: wrongBase.albums.map((album) => ({
        ...album,
        artistLocalId: AUXILIARY_ARTIST_ID,
      })),
    };

    expect(normalizeTimelineAlbumDetailClosedEvent(event, expected)).toEqual(
      event
    );
    expect(
      normalizeTimelineAlbumDetailClosedEvent(
        { ...event, discography: mismatchedDiscography },
        expected
      )
    ).toBeNull();
    expect(
      normalizeTimelineAlbumDetailClosedEvent(
        { ...event, itemKey: "forbidden" },
        expected
      )
    ).toBeNull();
  });

  it("accepts only a correlated enumerated close failure", () => {
    const expected = closeCorrelation();
    const event = {
      ...expected,
      code: "SESSION_LOST" as const,
      error: "Timeline detail session was lost",
    };

    expect(
      normalizeTimelineAlbumDetailCloseFailedEvent(event, expected)
    ).toEqual(event);
    expect(
      normalizeTimelineAlbumDetailCloseFailedEvent(
        { ...event, closingDeadlineAt: event.closingDeadlineAt + 1 },
        expected
      )
    ).toBeNull();
    expect(
      normalizeTimelineAlbumDetailCloseFailedEvent(
        { ...event, code: "ALBUM_AMBIGUOUS" },
        expected
      )
    ).toBeNull();
  });
});
