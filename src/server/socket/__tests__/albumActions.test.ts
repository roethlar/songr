import { Logger } from "pino";
import { Socket } from "socket.io";

import {
  AlbumActionBeginRequest,
  AlbumActionCancelAck,
  AlbumActionExecuteAck,
  AlbumActionFailedEvent,
  AlbumActionResolvedEvent,
} from "../../../shared/albumActionContracts";
import {
  AlbumActionBeginReservation,
  AlbumActionEventSink,
  AlbumActionOrigin,
} from "../../../core/roon/AlbumActionService";
import {
  AlbumActionSocketCoordinator,
  AlbumActionSocketService,
  registerAlbumActionSocket,
} from "../albumActions";

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function request(): AlbumActionBeginRequest {
  return {
    requestId: "request-1",
    pageId: "page-1",
    versionId: "version-1",
    zoneId: "zone-1",
    tabId: "tab-1",
    generation: 7,
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

class FakeActionService implements AlbumActionSocketService {
  public readonly order: string[] = [];
  public readonly beginCalls: Array<{
    origin: AlbumActionOrigin;
    value: unknown;
  }> = [];
  public readonly cancelCalls: Array<{
    origin: AlbumActionOrigin;
    value: unknown;
  }> = [];
  public readonly executeCalls: Array<{
    origin: AlbumActionOrigin;
    value: unknown;
  }> = [];
  public readonly disconnectCalls: string[] = [];
  public sink?: AlbumActionEventSink;
  public reservation: AlbumActionBeginReservation = {
    ack: {
      success: true,
      data: {
        requestId: "request-1",
        operationId: "operation-1",
        resolvingDeadlineAt: 1_000,
      },
    },
    start: () => this.order.push("start"),
  };
  public cancelAck: AlbumActionCancelAck = {
    success: true,
    data: { claimed: true },
  };
  public executeAck: AlbumActionExecuteAck = {
    success: true,
    data: { claimed: true, outcome: "executed" },
  };

  public begin(
    origin: AlbumActionOrigin,
    value: unknown,
    sink: AlbumActionEventSink
  ): AlbumActionBeginReservation {
    this.order.push("begin");
    this.beginCalls.push({ origin, value });
    this.sink = sink;
    return this.reservation;
  }

  public cancel(
    origin: AlbumActionOrigin,
    value: unknown
  ): AlbumActionCancelAck {
    this.cancelCalls.push({ origin, value });
    return this.cancelAck;
  }

  public execute(
    origin: AlbumActionOrigin,
    value: unknown
  ): Promise<AlbumActionExecuteAck> {
    this.executeCalls.push({ origin, value });
    return Promise.resolve(this.executeAck);
  }

  public disconnectSocket(socketId: string): void {
    this.order.push("action-disconnect");
    this.disconnectCalls.push(socketId);
  }
}

describe("registerAlbumActionSocket", () => {
  let socket: FakeSocket;
  let actionService: FakeActionService;
  let coordinatorOrder: string[];
  let coordinator: AlbumActionSocketCoordinator;
  let coreId: string | null;

  beforeEach(() => {
    socket = new FakeSocket();
    actionService = new FakeActionService();
    coordinatorOrder = actionService.order;
    coordinator = {
      disconnectSocket: (disconnectedCoreId, socketId) => {
        coordinatorOrder.push(`coordinator-disconnect:${disconnectedCoreId}:${socketId}`);
      },
    };
    coreId = "core-1";
    registerAlbumActionSocket(socket as unknown as Socket, {
      actionService,
      coordinator,
      getCoreId: () => coreId,
      logger: {
        warn: jest.fn(),
        error: jest.fn(),
      } as unknown as Logger,
    });
  });

  it("acknowledges an accepted begin before starting and emits only to its socket", () => {
    const ack = jest.fn(() => actionService.order.push("ack"));

    socket.trigger("album-action:begin", request(), ack);

    expect(actionService.order).toEqual(["begin", "ack", "start"]);
    expect(actionService.beginCalls).toEqual([
      {
        origin: { coreId: "core-1", socketId: "socket-1" },
        value: request(),
      },
    ]);

    const resolved: AlbumActionResolvedEvent = {
      requestId: "request-1",
      operationId: "operation-1",
      generation: 7,
      choosingDeadlineAt: 2_000,
      actions: [
        { actionId: "action-1", label: "Play Now", semantic: "play-now" },
      ],
    };
    const failed: AlbumActionFailedEvent = {
      requestId: "request-1",
      operationId: "operation-1",
      generation: 7,
      resolvingDeadlineAt: 1_000,
      error: "canceled",
      code: "CANCELED",
    };
    actionService.sink?.resolved(resolved);
    actionService.sink?.failed(failed);
    expect(socket.emitted).toEqual([
      { event: "album-action:resolved", value: resolved },
      { event: "album-action:failed", value: failed },
    ]);
  });

  it("creates no operation without an ack and rejects malformed or Core-less begins", () => {
    socket.trigger("album-action:begin", request());
    expect(actionService.beginCalls).toHaveLength(0);

    const malformedAck = jest.fn();
    socket.trigger("album-action:begin", { requestId: "request-1" }, malformedAck);
    expect(malformedAck).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, code: "INVALID_REQUEST" })
    );
    expect(actionService.beginCalls).toHaveLength(0);

    coreId = null;
    const corelessAck = jest.fn();
    socket.trigger("album-action:begin", request(), corelessAck);
    expect(corelessAck).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, code: "INVALID_REQUEST" })
    );
    expect(actionService.beginCalls).toHaveLength(0);
  });

  it("cancels an accepted reservation if its acknowledgment callback throws", () => {
    socket.trigger("album-action:begin", request(), () => {
      throw new Error("ack failed");
    });

    expect(actionService.order).toEqual(["begin"]);
    expect(actionService.cancelCalls).toEqual([
      {
        origin: { coreId: "core-1", socketId: "socket-1" },
        value: { operationId: "operation-1" },
      },
    ]);
  });

  it("strictly validates cancel and execute and requires their acknowledgments", async () => {
    socket.trigger("album-action:cancel", { operationId: "operation-1" });
    socket.trigger("album-action:execute", { actionId: "action-1" });
    expect(actionService.cancelCalls).toHaveLength(0);
    expect(actionService.executeCalls).toHaveLength(0);

    const invalidCancelAck = jest.fn();
    const invalidExecuteAck = jest.fn();
    socket.trigger("album-action:cancel", { bad: true }, invalidCancelAck);
    socket.trigger("album-action:execute", { bad: true }, invalidExecuteAck);
    expect(invalidCancelAck).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, code: "INVALID_REQUEST" })
    );
    expect(invalidExecuteAck).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, code: "INVALID_REQUEST" })
    );

    const cancelAck = jest.fn();
    const executeAck = jest.fn();
    socket.trigger("album-action:cancel", { operationId: "operation-1" }, cancelAck);
    socket.trigger("album-action:execute", { actionId: "action-1" }, executeAck);
    await flush();
    expect(actionService.cancelCalls[0]).toEqual({
      origin: { coreId: "core-1", socketId: "socket-1" },
      value: { operationId: "operation-1" },
    });
    expect(actionService.executeCalls[0]).toEqual({
      origin: { coreId: "core-1", socketId: "socket-1" },
      value: { actionId: "action-1" },
    });
    expect(cancelAck).toHaveBeenCalledWith(actionService.cancelAck);
    expect(executeAck).toHaveBeenCalledWith(actionService.executeAck);
  });

  it("claims service cancellation before coordinator disconnect", () => {
    socket.trigger("disconnect");

    expect(actionService.order).toEqual([
      "action-disconnect",
      "coordinator-disconnect:core-1:socket-1",
    ]);
    expect(actionService.disconnectCalls).toEqual(["socket-1"]);
  });

  it("still cancels socket operations when no current Core remains", () => {
    coreId = null;

    socket.trigger("disconnect");

    expect(actionService.order).toEqual(["action-disconnect"]);
  });
});
