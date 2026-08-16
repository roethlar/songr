/**
 * Editorial item socket adapter: handler registration, the missing-ack
 * short-circuit, ack-then-start ordering, abandoned reservations on ack
 * failure, and disconnect forwarding. Synthetic values only.
 */
import type { Socket } from "socket.io";

import { registerEditorialItemSocket } from "../editorialItem";
import type {
  EditorialItemOpenReservation,
} from "../../../core/roon/EditorialItemSessionService";

type Handler = (value: unknown, ack?: (response: unknown) => void) => void;

function fakeSocket(): {
  socket: Socket;
  handlers: Map<string, Handler>;
  emitted: Array<{ event: string; payload: unknown }>;
} {
  const handlers = new Map<string, Handler>();
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const socket = {
    id: "sock-1",
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
    },
    emit: (event: string, payload: unknown) => {
      emitted.push({ event, payload });
    },
  } as unknown as Socket;
  return { socket, handlers, emitted };
}

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as never;

function openPayload(): Record<string, unknown> {
  return {
    requestId: "req-1",
    tabId: "tab-1",
    generation: 2,
    anchor: { kind: "album", albumLocalId: "alb-1" },
  };
}

describe("editorial item socket adapter", () => {
  it("acks before starting the read and forwards sink events", () => {
    const { socket, handlers, emitted } = fakeSocket();
    const order: string[] = [];
    const service = {
      open: (input: { sink: { ready(event: unknown): void } }) => {
        const reservation: EditorialItemOpenReservation = {
          ack: {
            ok: true,
            data: { requestId: "req-1", sessionId: "ses-1", deadlineAt: 10 },
          },
          start: () => {
            order.push("start");
            input.sink.ready({ requestId: "req-1", sessionId: "ses-1", view: {} });
          },
        };
        return reservation;
      },
      follow: jest.fn(),
      cancel: jest.fn(),
      disconnectSocket: jest.fn(),
    };
    registerEditorialItemSocket(socket, {
      editorialItemService: service as never,
      getCoreId: () => "core-a",
      logger,
    });
    handlers.get("item-editorial:open")?.(openPayload(), () => order.push("ack"));
    expect(order).toEqual(["ack", "start"]);
    expect(emitted[0]).toMatchObject({ event: "item-editorial:ready" });
  });

  it("creates nothing without an acknowledgment callback", () => {
    const { socket, handlers } = fakeSocket();
    const open = jest.fn();
    registerEditorialItemSocket(socket, {
      editorialItemService: {
        open,
        follow: jest.fn(),
        cancel: jest.fn(),
        disconnectSocket: jest.fn(),
      } as never,
      getCoreId: () => "core-a",
      logger,
    });
    handlers.get("item-editorial:open")?.(openPayload(), undefined);
    expect(open).not.toHaveBeenCalled();
  });

  it("abandons the reservation when the ack cannot be delivered", () => {
    const { socket, handlers } = fakeSocket();
    const abandon = jest.fn();
    const start = jest.fn();
    registerEditorialItemSocket(socket, {
      editorialItemService: {
        open: () => ({
          ack: {
            ok: true,
            data: { requestId: "req-1", sessionId: "ses-1", deadlineAt: 10 },
          },
          start,
          abandon,
        }),
        follow: jest.fn(),
        cancel: jest.fn(),
        disconnectSocket: jest.fn(),
      } as never,
      getCoreId: () => "core-a",
      logger,
    });
    handlers.get("item-editorial:open")?.(openPayload(), () => {
      throw new Error("client went away");
    });
    expect(abandon).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  });

  it("rejects invalid requests and a missing Core without touching the service", () => {
    const { socket, handlers } = fakeSocket();
    const open = jest.fn();
    registerEditorialItemSocket(socket, {
      editorialItemService: {
        open,
        follow: jest.fn(),
        cancel: jest.fn(),
        disconnectSocket: jest.fn(),
      } as never,
      getCoreId: () => null,
      logger,
    });
    const responses: unknown[] = [];
    handlers.get("item-editorial:open")?.(openPayload(), (response) =>
      responses.push(response)
    );
    handlers.get("item-editorial:open")?.({ nonsense: true }, (response) =>
      responses.push(response)
    );
    expect(open).not.toHaveBeenCalled();
    expect(responses).toHaveLength(2);
    expect(responses[0]).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
  });

  it("forwards disconnects to the service", () => {
    const { socket, handlers } = fakeSocket();
    const disconnectSocket = jest.fn();
    registerEditorialItemSocket(socket, {
      editorialItemService: {
        open: jest.fn(),
        follow: jest.fn(),
        cancel: jest.fn(),
        disconnectSocket,
      } as never,
      getCoreId: () => "core-a",
      logger,
    });
    handlers.get("disconnect")?.(undefined, undefined);
    expect(disconnectSocket).toHaveBeenCalledWith("sock-1");
  });
});
