import type { Logger } from "pino";
import type { Socket } from "socket.io";

import type {
  TimelineAlbumDetailBeginAck,
  TimelineAlbumDetailCloseAck,
  TimelineAlbumDetailCloseFailedEvent,
  TimelineAlbumDetailCloseRequest,
  TimelineAlbumDetailClosedEvent,
  TimelineAlbumDetailFailedEvent,
  TimelineAlbumDetailLoadedEvent,
  TimelineAlbumDetailRequest,
  TimelineArtistLoadBeginAck,
  TimelineArtistLoadFailedEvent,
  TimelineArtistLoadedEvent,
  TimelineArtistLoadRequest,
  TimelineSessionReconnectAck,
  TimelineSessionReconnectRequest,
  TimelineSessionReleaseAck,
  TimelineSessionReleaseRequest,
} from "../../../shared/timelineBrowseContracts";
import type { CatalogArtistAlbumsResponse } from "../../../shared/timelineCatalogContracts";
import type {
  TimelineArtistLoadOrigin,
  TimelineArtistLoadReservation,
  TimelineArtistLoadSink,
  TimelineAlbumDetailCloseReservation,
  TimelineAlbumDetailCloseSink,
  TimelineAlbumDetailReservation,
  TimelineAlbumDetailSink,
} from "../../../core/roon/TimelineBrowseService";
import {
  registerTimelineBrowseSocket,
  type TimelineBrowseSocketService,
} from "../timelineBrowse";

const ARTIST_ID = "10000000-0000-4000-8000-000000000001";
const ALBUM_ID = "20000000-0000-4000-8000-000000000001";
const AT = "2026-07-15T00:00:00.000Z";
const SESSION = { handleId: "mode-handle-1", generation: 7 } as const;

function request(): TimelineArtistLoadRequest {
  return {
    requestId: "artist-load-1",
    tabId: "timeline-tab-1",
    artistLocalId: ARTIST_ID,
  };
}

function acceptedAck(): TimelineArtistLoadBeginAck {
  return {
    success: true,
    data: {
      requestId: "artist-load-1",
      session: SESSION,
      loadingDeadlineAt: 2_000_000_000_000,
    },
  };
}

function detailRequest(): TimelineAlbumDetailRequest {
  return {
    requestId: "detail-load-1",
    tabId: "timeline-tab-1",
    session: SESSION,
    artistLocalId: ARTIST_ID,
    albumLocalId: ALBUM_ID,
  };
}

function acceptedDetailAck(): TimelineAlbumDetailBeginAck {
  return {
    success: true,
    data: {
      requestId: "detail-load-1",
      session: SESSION,
      artistLocalId: ARTIST_ID,
      albumLocalId: ALBUM_ID,
      loadingDeadlineAt: 2_000_000_000_000,
    },
  };
}

function closeRequest(): TimelineAlbumDetailCloseRequest {
  return {
    requestId: "detail-close-1",
    tabId: "timeline-tab-1",
    session: SESSION,
    baseArtistLocalId: ARTIST_ID,
    detailArtistLocalId: ARTIST_ID,
    albumLocalId: ALBUM_ID,
  };
}

function acceptedCloseAck(): TimelineAlbumDetailCloseAck {
  return {
    success: true,
    data: {
      requestId: "detail-close-1",
      session: SESSION,
      baseArtistLocalId: ARTIST_ID,
      detailArtistLocalId: ARTIST_ID,
      albumLocalId: ALBUM_ID,
      closingDeadlineAt: 2_000_000_000_000,
    },
  };
}

function reconnectRequest(): TimelineSessionReconnectRequest {
  return {
    requestId: "timeline-reconnect-1",
    tabId: "timeline-tab-1",
    session: SESSION,
  };
}

function reconnectAck(): TimelineSessionReconnectAck {
  return {
    success: true,
    data: {
      requestId: "timeline-reconnect-1",
      session: SESSION,
    },
  };
}

function releaseRequest(): TimelineSessionReleaseRequest {
  return {
    requestId: "timeline-release-1",
    tabId: "timeline-tab-1",
    session: SESSION,
  };
}

function releaseAck(): TimelineSessionReleaseAck {
  return {
    success: true,
    data: {
      requestId: "timeline-release-1",
      session: SESSION,
    },
  };
}

function discography(): CatalogArtistAlbumsResponse {
  return {
    status: {
      coreId: "core-1",
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
    },
    artist: {
      localId: ARTIST_ID,
      coreId: "core-1",
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
        coreId: "core-1",
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

class FakeSocket {
  public readonly id = "socket-1";
  public readonly emitted: Array<{ event: string; value: unknown }> = [];
  private readonly handlers = new Map<
    string,
    Array<(...args: unknown[]) => void>
  >();

  public on(event: string, handler: (...args: unknown[]) => void): this {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
    return this;
  }

  public emit(event: string, value: unknown): boolean {
    this.emitted.push({ event, value });
    return true;
  }

  public trigger(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }
}

class FakeTimelineBrowseService implements TimelineBrowseSocketService {
  public readonly order: string[] = [];
  public readonly beginCalls: Array<{
    origin: TimelineArtistLoadOrigin;
    request: TimelineArtistLoadRequest;
  }> = [];
  public readonly disconnectCalls: string[] = [];
  public readonly detailCalls: Array<{
    origin: TimelineArtistLoadOrigin;
    request: TimelineAlbumDetailRequest;
  }> = [];
  public readonly closeCalls: Array<{
    origin: TimelineArtistLoadOrigin;
    request: TimelineAlbumDetailCloseRequest;
  }> = [];
  public readonly reconnectCalls: Array<{
    origin: TimelineArtistLoadOrigin;
    request: TimelineSessionReconnectRequest;
  }> = [];
  public readonly releaseCalls: Array<{
    origin: TimelineArtistLoadOrigin;
    request: TimelineSessionReleaseRequest;
  }> = [];
  public sink?: TimelineArtistLoadSink;
  public detailSink?: TimelineAlbumDetailSink;
  public closeSink?: TimelineAlbumDetailCloseSink;
  public reservation: TimelineArtistLoadReservation = {
    ack: acceptedAck(),
    start: () => {
      this.order.push("start");
      return Promise.resolve();
    },
    abandon: () => {
      this.order.push("abandon");
      return Promise.resolve();
    },
  };
  public detailReservation: TimelineAlbumDetailReservation = {
    ack: acceptedDetailAck(),
    start: () => {
      this.order.push("detail-start");
      return Promise.resolve();
    },
    abandon: () => {
      this.order.push("detail-abandon");
      return Promise.resolve();
    },
  };
  public closeReservation: TimelineAlbumDetailCloseReservation = {
    ack: acceptedCloseAck(),
    start: () => {
      this.order.push("close-start");
      return Promise.resolve();
    },
    abandon: () => {
      this.order.push("close-abandon");
      return Promise.resolve();
    },
  };
  public reconnectResponse: TimelineSessionReconnectAck = reconnectAck();
  public releaseResponse: TimelineSessionReleaseAck = releaseAck();

  public begin(
    origin: TimelineArtistLoadOrigin,
    value: TimelineArtistLoadRequest,
    sink: TimelineArtistLoadSink
  ): TimelineArtistLoadReservation {
    this.order.push("begin");
    this.beginCalls.push({ origin, request: value });
    this.sink = sink;
    return this.reservation;
  }

  public beginDetail(
    origin: TimelineArtistLoadOrigin,
    value: TimelineAlbumDetailRequest,
    sink: TimelineAlbumDetailSink
  ): TimelineAlbumDetailReservation {
    this.order.push("detail-begin");
    this.detailCalls.push({ origin, request: value });
    this.detailSink = sink;
    return this.detailReservation;
  }

  public closeDetail(
    origin: TimelineArtistLoadOrigin,
    value: TimelineAlbumDetailCloseRequest,
    sink: TimelineAlbumDetailCloseSink
  ): TimelineAlbumDetailCloseReservation {
    this.order.push("close-begin");
    this.closeCalls.push({ origin, request: value });
    this.closeSink = sink;
    return this.closeReservation;
  }

  public reconnect(
    origin: TimelineArtistLoadOrigin,
    value: TimelineSessionReconnectRequest
  ): TimelineSessionReconnectAck {
    this.order.push("reconnect");
    this.reconnectCalls.push({ origin, request: value });
    return this.reconnectResponse;
  }

  public release(
    origin: TimelineArtistLoadOrigin,
    value: TimelineSessionReleaseRequest
  ): TimelineSessionReleaseAck {
    this.order.push("release");
    this.releaseCalls.push({ origin, request: value });
    return this.releaseResponse;
  }

  public disconnectSocket(socketId: string): void {
    this.order.push("disconnect");
    this.disconnectCalls.push(socketId);
  }
}

describe("registerTimelineBrowseSocket", () => {
  let socket: FakeSocket;
  let timelineBrowseService: FakeTimelineBrowseService;
  let coreId: string | null;
  let logger: Logger;

  beforeEach(() => {
    socket = new FakeSocket();
    timelineBrowseService = new FakeTimelineBrowseService();
    coreId = "core-1";
    logger = {
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as Logger;
    registerTimelineBrowseSocket(socket as unknown as Socket, {
      timelineBrowseService,
      getCoreId: () => coreId,
      logger,
    });
  });

  it("creates no operation when an acknowledgment callback is missing", () => {
    socket.trigger("timeline-artist:begin", request());

    expect(timelineBrowseService.beginCalls).toHaveLength(0);
    expect(timelineBrowseService.order).toEqual([]);
  });

  it("rejects malformed requests without beginning an operation", () => {
    const ack = jest.fn();

    socket.trigger(
      "timeline-artist:begin",
      { ...request(), itemKey: "forbidden-raw-authority" },
      ack
    );

    expect(ack).toHaveBeenCalledWith({
      success: false,
      code: "INVALID_REQUEST",
      error: "Invalid Timeline artist load request",
    });
    expect(timelineBrowseService.beginCalls).toHaveLength(0);
  });

  it("reports an unavailable Core without beginning an operation", () => {
    coreId = null;
    const ack = jest.fn();

    socket.trigger("timeline-artist:begin", request(), ack);

    expect(ack).toHaveBeenCalledWith({
      success: false,
      code: "CORE_UNAVAILABLE",
      error: "Roon Core is unavailable",
    });
    expect(timelineBrowseService.beginCalls).toHaveLength(0);
  });

  it("acknowledges an accepted reservation before starting it", () => {
    const ack = jest.fn(() => timelineBrowseService.order.push("ack"));

    socket.trigger("timeline-artist:begin", request(), ack);

    expect(timelineBrowseService.order).toEqual(["begin", "ack", "start"]);
    expect(timelineBrowseService.beginCalls).toEqual([
      {
        origin: { coreId: "core-1", socketId: "socket-1" },
        request: request(),
      },
    ]);
    expect(ack).toHaveBeenCalledWith(acceptedAck());
  });

  it("does not start a reservation whose acknowledgment rejects the request", () => {
    timelineBrowseService.reservation = {
      ack: {
        success: false,
        code: "BACKPRESSURE",
        error: "Timeline capacity is busy",
      },
      start: () => {
        timelineBrowseService.order.push("start");
        return Promise.resolve();
      },
    };
    const ack = jest.fn(() => timelineBrowseService.order.push("ack"));

    socket.trigger("timeline-artist:begin", request(), ack);

    expect(timelineBrowseService.order).toEqual(["begin", "ack"]);
    expect(ack).toHaveBeenCalledWith(timelineBrowseService.reservation.ack);
  });

  it("abandons an accepted reservation when its acknowledgment throws", () => {
    socket.trigger("timeline-artist:begin", request(), () => {
      timelineBrowseService.order.push("ack");
      throw new Error("ack failed");
    });

    expect(timelineBrowseService.order).toEqual(["begin", "ack", "abandon"]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "Timeline artist-load acknowledgment callback failed"
    );
  });

  it("emits loaded and failed terminal events only through the origin socket", () => {
    socket.trigger("timeline-artist:begin", request(), jest.fn());
    const correlation = {
      requestId: "artist-load-1",
      session: { handleId: "mode-handle-1", generation: 7 },
      loadingDeadlineAt: 2_000_000_000_000,
    };
    const loaded: TimelineArtistLoadedEvent = {
      ...correlation,
      discography: discography(),
    };
    const failed: TimelineArtistLoadFailedEvent = {
      ...correlation,
      code: "ARTIST_AMBIGUOUS",
      error: "Artist could not be resolved uniquely",
    };

    timelineBrowseService.sink?.loaded(loaded);
    timelineBrowseService.sink?.failed(failed);

    expect(socket.emitted).toEqual([
      { event: "timeline-artist:loaded", value: loaded },
      { event: "timeline-artist:failed", value: failed },
    ]);
  });

  it.each([
    ["timeline-detail:begin", detailRequest(), "detail"],
    ["timeline-detail:close", closeRequest(), "close"],
    ["timeline-session:reconnect", reconnectRequest(), "reconnect"],
    ["timeline-session:release", releaseRequest(), "release"],
  ] as const)(
    "creates no %s operation when its acknowledgment callback is missing",
    (event, value, kind) => {
      socket.trigger(event, value);

      expect(
        kind === "detail"
          ? timelineBrowseService.detailCalls
          : kind === "close"
            ? timelineBrowseService.closeCalls
            : kind === "reconnect"
              ? timelineBrowseService.reconnectCalls
              : timelineBrowseService.releaseCalls
      ).toHaveLength(0);
    }
  );

  it.each([
    ["timeline-detail:begin", detailRequest(), "detail"],
    ["timeline-detail:close", closeRequest(), "close"],
    ["timeline-session:reconnect", reconnectRequest(), "reconnect"],
    ["timeline-session:release", releaseRequest(), "release"],
  ] as const)("strictly rejects malformed %s payloads", (event, value, kind) => {
    const ack = jest.fn();
    socket.trigger(event, { ...value, itemKey: "forbidden" }, ack);

    expect(ack).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, code: "INVALID_REQUEST" })
    );
    expect(
      kind === "detail"
        ? timelineBrowseService.detailCalls
        : kind === "close"
          ? timelineBrowseService.closeCalls
          : kind === "reconnect"
            ? timelineBrowseService.reconnectCalls
            : timelineBrowseService.releaseCalls
    ).toHaveLength(0);
  });

  it("acknowledges detail and close reservations before starting them", () => {
    const detailAck = jest.fn(() => timelineBrowseService.order.push("detail-ack"));
    socket.trigger("timeline-detail:begin", detailRequest(), detailAck);
    expect(timelineBrowseService.order).toEqual([
      "detail-begin",
      "detail-ack",
      "detail-start",
    ]);
    expect(detailAck).toHaveBeenCalledWith(acceptedDetailAck());
    expect(timelineBrowseService.detailCalls).toEqual([
      {
        origin: { coreId: "core-1", socketId: "socket-1" },
        request: detailRequest(),
      },
    ]);

    timelineBrowseService.order.length = 0;
    const closeAck = jest.fn(() => timelineBrowseService.order.push("close-ack"));
    socket.trigger("timeline-detail:close", closeRequest(), closeAck);
    expect(timelineBrowseService.order).toEqual([
      "close-begin",
      "close-ack",
      "close-start",
    ]);
    expect(closeAck).toHaveBeenCalledWith(acceptedCloseAck());
  });

  it("abandons an unstarted detail reservation when its acknowledgment throws", () => {
    socket.trigger("timeline-detail:begin", detailRequest(), () => {
      timelineBrowseService.order.push("detail-ack");
      throw new Error("ack failed");
    });

    expect(timelineBrowseService.order).toEqual([
      "detail-begin",
      "detail-ack",
      "detail-abandon",
    ]);
  });

  it("emits origin-bound detail and close terminal events", () => {
    socket.trigger("timeline-detail:begin", detailRequest(), jest.fn());
    socket.trigger("timeline-detail:close", closeRequest(), jest.fn());
    const response = discography();
    const detail = {
      artist: response.artist,
      album: {
        ...response.albums[0],
        trackTitleFingerprint: "test-track-fingerprint",
      },
      orderedTrackTitles: ["Hunter"],
    };
    const detailAck = acceptedDetailAck();
    const closeAck = acceptedCloseAck();
    if (!detailAck.success || !closeAck.success) {
      throw new Error("expected successful fixture acknowledgments");
    }
    const loaded: TimelineAlbumDetailLoadedEvent = {
      ...detailAck.data,
      detail,
    };
    const detailFailed: TimelineAlbumDetailFailedEvent = {
      ...detailAck.data,
      code: "DETAIL_UNAVAILABLE",
      error: "Detail changed",
    };
    const closed: TimelineAlbumDetailClosedEvent = {
      ...closeAck.data,
      discography: response,
    };
    const closeFailed: TimelineAlbumDetailCloseFailedEvent = {
      ...closeAck.data,
      code: "SESSION_LOST",
      error: "Parent changed",
    };

    timelineBrowseService.detailSink?.loaded(loaded);
    timelineBrowseService.detailSink?.failed(detailFailed);
    timelineBrowseService.closeSink?.closed(closed);
    timelineBrowseService.closeSink?.failed(closeFailed);

    expect(socket.emitted).toEqual([
      { event: "timeline-detail:loaded", value: loaded },
      { event: "timeline-detail:failed", value: detailFailed },
      { event: "timeline-detail:closed", value: closed },
      { event: "timeline-detail:close-failed", value: closeFailed },
    ]);
  });

  it("returns reconnect as an acknowledgment-only origin-bound call", () => {
    const ack = jest.fn();
    socket.trigger("timeline-session:reconnect", reconnectRequest(), ack);

    expect(ack).toHaveBeenCalledWith(reconnectAck());
    expect(timelineBrowseService.reconnectCalls).toEqual([
      {
        origin: { coreId: "core-1", socketId: "socket-1" },
        request: reconnectRequest(),
      },
    ]);
    expect(socket.emitted).toEqual([]);
  });

  it("returns release as a strict acknowledgment-only origin-bound call", () => {
    const ack = jest.fn();
    socket.trigger("timeline-session:release", releaseRequest(), ack);

    expect(ack).toHaveBeenCalledWith(releaseAck());
    expect(timelineBrowseService.releaseCalls).toEqual([
      {
        origin: { coreId: "core-1", socketId: "socket-1" },
        request: releaseRequest(),
      },
    ]);
    expect(socket.emitted).toEqual([]);
  });

  it("cleans up service operations on socket disconnect", () => {
    socket.trigger("disconnect");

    expect(timelineBrowseService.disconnectCalls).toEqual(["socket-1"]);
    expect(timelineBrowseService.order).toEqual(["disconnect"]);
  });
});
