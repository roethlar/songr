import type { Socket } from "socket.io";

import type {
  LibraryAlbumEventSink,
  LibraryAlbumOpenReservation,
  LibraryAlbumSelectReservation,
} from "../../../core/roon/LibraryAlbumService";
import { registerLibraryAlbumSocket } from "../libraryAlbum";

class FakeSocket {
  public readonly id = "socket-1";
  public readonly handlers = new Map<string, (...args: unknown[]) => unknown>();
  public readonly emitted: unknown[][] = [];

  public on(event: string, handler: (...args: unknown[]) => unknown): this {
    this.handlers.set(event, handler);
    return this;
  }

  public emit(...args: unknown[]): void {
    this.emitted.push(args);
  }

  public trigger(event: string, ...args: unknown[]): unknown {
    const handler = this.handlers.get(event);
    if (!handler) throw new Error(`missing ${event} handler`);
    return handler(...args);
  }
}

const openRequest = {
  requestId: "request-1",
  tabId: "tab-1",
  albumLocalId: "018f0f64-3f31-7a9b-8c2d-8f572cb18a12",
  generation: 7,
};

describe("library album socket adapter", () => {
  let socket: FakeSocket;
  let service: {
    open: jest.Mock;
    select: jest.Mock;
    cancel: jest.Mock;
    disconnectSocket: jest.Mock;
  };

  beforeEach(() => {
    socket = new FakeSocket();
    service = {
      open: jest.fn(),
      select: jest.fn(),
      cancel: jest.fn(() => ({ success: true, data: { claimed: true } })),
      disconnectSocket: jest.fn(),
    };
    registerLibraryAlbumSocket(socket as unknown as Socket, {
      libraryAlbumService: service,
      getCoreId: () => "core-1",
      logger: { warn: jest.fn() } as never,
    });
  });

  it("acks an open before starting and forwards all page events", () => {
    const order: string[] = [];
    service.open.mockImplementation(
      (_origin: unknown, _request: unknown, sink: LibraryAlbumEventSink) =>
        ({
          ack: {
            success: true,
            data: {
              requestId: "request-1",
              operationId: "operation-1",
              resolvingDeadlineAt: 1000,
            },
          },
          start: () => {
            order.push("start");
            sink.versions({
              requestId: "request-1",
              operationId: "operation-1",
              generation: 7,
              artist: "Artist",
              title: "Album",
              versions: [{ versionId: "version-1", editionText: "" }],
            });
            sink.resolved({
              requestId: "request-1",
              operationId: "operation-1",
              generation: 7,
              versionId: "version-1",
              artist: "Artist",
              title: "Album",
              actionsAvailable: true,
              versionSummary: { versionId: "version-1", editionText: "" },
              orderedTracks: [{ index: 0, title: "Track" }],
            });
            sink.versionFailed({
              requestId: "request-1",
              operationId: "operation-1",
              generation: 7,
              resolvingDeadlineAt: 1001,
              versionId: "version-1",
              code: "DETAIL_INCOMPLETE",
              error: "Incomplete",
            });
          },
        }) satisfies LibraryAlbumOpenReservation
    );
    const ack = jest.fn(() => order.push("ack"));

    socket.trigger("library-album:open", openRequest, ack);

    expect(order).toEqual(["ack", "start"]);
    expect(service.open).toHaveBeenCalledWith(
      { coreId: "core-1", socketId: "socket-1" },
      openRequest,
      expect.any(Object)
    );
    expect(socket.emitted.map(([event]) => event)).toEqual([
      "library-album:versions",
      "library-album:resolved",
      "library-album:version-failed",
    ]);
  });

  it("acks an exact version selection before starting it", () => {
    const order: string[] = [];
    service.select.mockReturnValue({
      ack: {
        success: true,
        data: {
          operationId: "operation-1",
          versionId: "version-1",
          resolvingDeadlineAt: 1000,
        },
      },
      start: () => order.push("start"),
    } satisfies LibraryAlbumSelectReservation);
    const ack = jest.fn(() => order.push("ack"));
    const request = { operationId: "operation-1", versionId: "version-1" };

    socket.trigger("library-album:select", request, ack);

    expect(order).toEqual(["ack", "start"]);
    expect(service.select).toHaveBeenCalledWith(
      { coreId: "core-1", socketId: "socket-1" },
      request
    );
  });

  it("rejects raw row keys before they reach the service", () => {
    const ack = jest.fn();
    socket.trigger(
      "library-album:select",
      {
        operationId: "operation-1",
        versionId: "version-1",
        itemKey: "must-not-cross",
      },
      ack
    );

    expect(service.select).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledWith({
      success: false,
      code: "INVALID_REQUEST",
      error: "Invalid library album version request",
    });
  });

  it("closes every page owned by a disconnected socket", () => {
    socket.trigger("disconnect");
    expect(service.disconnectSocket).toHaveBeenCalledWith("socket-1");
  });
});
