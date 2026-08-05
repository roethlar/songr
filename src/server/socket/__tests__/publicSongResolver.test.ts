import type { Socket } from "socket.io";

import { PublicSongResolverError } from "../../../core/roon/PublicSongResolverService";
import type {
  PublicSongActionAck,
  PublicSongResolveAck,
} from "../../../shared/publicSongResolverContracts";
import { registerPublicSongResolverSocket } from "../publicSongResolver";

class FakeSocket {
  public readonly id = "socket-1";
  private readonly handlers = new Map<
    string,
    (value: unknown, ack?: (value: unknown) => void) => void
  >();

  public on(
    event: string,
    handler: (value: unknown, ack?: (value: unknown) => void) => void
  ): this {
    this.handlers.set(event, handler);
    return this;
  }

  public async dispatch(event: string, value: unknown): Promise<unknown> {
    const handler = this.handlers.get(event);
    if (!handler) throw new Error(`missing ${event} handler`);
    return new Promise((resolve) => handler(value, resolve));
  }
}

const resolveRequest = {
  requestId: "request-1",
  tabId: "tab-1",
  session: { handleId: "mode-1", generation: 2 },
  selectionId: "selection-1",
};

const actionRequest = {
  ...resolveRequest,
  candidateId: "candidate-1",
  zoneId: "zone-1",
  semantic: "play-now" as const,
};

describe("registerPublicSongResolverSocket", () => {
  let socket: FakeSocket;
  let resolver: {
    resolve: jest.Mock;
    execute: jest.Mock;
  };
  let getCoreId: jest.Mock;
  let logger: { error: jest.Mock };

  beforeEach(() => {
    socket = new FakeSocket();
    resolver = {
      resolve: jest.fn(),
      execute: jest.fn(),
    };
    getCoreId = jest.fn(() => "core-1");
    logger = { error: jest.fn() };
    registerPublicSongResolverSocket(socket as unknown as Socket, {
      resolver,
      getCoreId,
      logger: logger as never,
    });
  });

  it("rejects malformed requests before calling the resolver", async () => {
    const ack = (await socket.dispatch("public-song:resolve", {
      ...resolveRequest,
      rawItemKey: "must-not-cross",
    })) as PublicSongResolveAck;
    expect(ack).toEqual({
      success: false,
      code: "INVALID_REQUEST",
      error: "Invalid public song resolve request",
    });
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it("passes only current Core/session authority and correlates resolution", async () => {
    resolver.resolve.mockResolvedValue({
      kind: "authorized",
      candidate: {
        candidateId: "candidate-1",
        title: "Seven Nation Army",
        subtitle: "The White Stripes, Jack White",
        imageKey: null,
      },
    });
    const ack = (await socket.dispatch(
      "public-song:resolve",
      resolveRequest
    )) as PublicSongResolveAck;

    expect(resolver.resolve).toHaveBeenCalledWith({
      access: {
        coreId: "core-1",
        socketId: "socket-1",
        tabId: "tab-1",
        handle: {
          kind: "mode",
          mode: "classic",
          handleId: "mode-1",
          generation: 2,
        },
      },
      selectionId: "selection-1",
    });
    expect(ack).toMatchObject({
      success: true,
      data: {
        requestId: "request-1",
        selectionId: "selection-1",
        resolution: { kind: "authorized" },
      },
    });
  });

  it("executes one correlated action and reports terminal retirement", async () => {
    resolver.execute.mockResolvedValue({ authorityRetired: true });
    const ack = (await socket.dispatch(
      "public-song:action",
      actionRequest
    )) as PublicSongActionAck;

    expect(resolver.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        selectionId: "selection-1",
        candidateId: "candidate-1",
        zoneId: "zone-1",
        semantic: "play-now",
      })
    );
    expect(ack).toEqual({
      success: true,
      data: {
        requestId: "request-1",
        session: actionRequest.session,
        selectionId: "selection-1",
        candidateId: "candidate-1",
        semantic: "play-now",
        outcome: "executed",
        authorityRetired: true,
      },
    });
  });

  it("rejects duplicate action request IDs before a second execute", async () => {
    resolver.execute.mockResolvedValue({ authorityRetired: false });
    await socket.dispatch("public-song:action", actionRequest);
    const duplicate = (await socket.dispatch(
      "public-song:action",
      actionRequest
    )) as PublicSongActionAck;

    expect(duplicate).toEqual({
      success: false,
      code: "REQUEST_ID_CONFLICT",
      error: "The public song action request ID was already used",
    });
    expect(resolver.execute).toHaveBeenCalledTimes(1);
  });

  it("maps fail-closed resolver errors without leaking internals", async () => {
    resolver.resolve.mockRejectedValue(
      new PublicSongResolverError(
        "STALE_SELECTION",
        "the track selection expired; refresh the list"
      )
    );
    await expect(
      socket.dispatch("public-song:resolve", resolveRequest)
    ).resolves.toEqual({
      success: false,
      code: "STALE_SELECTION",
      error: "the track selection expired; refresh the list",
    });

    resolver.execute.mockRejectedValue(
      new PublicSongResolverError(
        "OUTCOME_UNKNOWN",
        "Roon received the action but confirmation was lost"
      )
    );
    await expect(
      socket.dispatch("public-song:action", {
        ...actionRequest,
        requestId: "request-2",
      })
    ).resolves.toEqual({
      success: false,
      code: "OUTCOME_UNKNOWN",
      error: "Roon received the action but confirmation was lost",
    });
  });

  it("returns Core unavailable before resolving or executing", async () => {
    getCoreId.mockReturnValue(null);
    await expect(
      socket.dispatch("public-song:resolve", resolveRequest)
    ).resolves.toMatchObject({
      success: false,
      code: "CORE_UNAVAILABLE",
    });
    await expect(
      socket.dispatch("public-song:action", actionRequest)
    ).resolves.toMatchObject({
      success: false,
      code: "CORE_UNAVAILABLE",
    });
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(resolver.execute).not.toHaveBeenCalled();
  });
});
