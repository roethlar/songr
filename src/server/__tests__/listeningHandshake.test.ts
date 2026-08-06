import http from "http";
import type { AddressInfo } from "net";

import {
  attachListeningHandshake,
  notifyListening,
} from "../listeningHandshake";

/**
 * `process.send` only exists when the process was forked with an IPC channel.
 * Jest's in-band runner has none, so these tests install a fake channel and
 * remove it again rather than depending on the ambient runner shape.
 */
const withIpcChannel = (): jest.Mock => {
  const send = jest.fn().mockReturnValue(true);
  (process as NodeJS.Process & { send?: typeof process.send }).send =
    send as unknown as typeof process.send;
  return send;
};

const listenOnEphemeralPort = (server: http.Server): Promise<void> =>
  new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

const closeServer = (server: http.Server): Promise<void> =>
  new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });

describe("listening handshake", () => {
  const originalSend = process.send;
  let server: http.Server;

  beforeEach(() => {
    server = http.createServer();
  });

  afterEach(async () => {
    await closeServer(server);
    if (originalSend === undefined) {
      delete (process as NodeJS.Process & { send?: typeof process.send }).send;
    } else {
      process.send = originalSend;
    }
  });

  it("reports the real ephemeral port over IPC once the server is bound", async () => {
    const send = withIpcChannel();
    attachListeningHandshake(server);

    await listenOnEphemeralPort(server);

    const boundPort = (server.address() as AddressInfo).port;
    expect(boundPort).toBeGreaterThan(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ type: "listening", port: boundPort });
  });

  it("stays silent when the process has no IPC channel", async () => {
    delete (process as NodeJS.Process & { send?: typeof process.send }).send;
    attachListeningHandshake(server);

    await listenOnEphemeralPort(server);

    // Nothing to assert a call against — the guarantee is that binding
    // completes without a send and without throwing.
    expect(server.listening).toBe(true);
    expect(process.send).toBeUndefined();
  });

  it("returns false from notifyListening when there is no IPC channel", () => {
    delete (process as NodeJS.Process & { send?: typeof process.send }).send;
    expect(notifyListening(server)).toBe(false);
  });

  it("does not send before the server is listening", () => {
    const send = withIpcChannel();
    attachListeningHandshake(server);

    expect(send).not.toHaveBeenCalled();
  });

  it("skips the handshake when the server is not bound to a TCP port", () => {
    const send = withIpcChannel();
    const warn = jest.fn();

    // Unbound server: address() is null, so there is no port to report.
    expect(notifyListening(server, { info: jest.fn(), warn })).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("reports failure when the channel refuses the message (dt1-2)", async () => {
    const send = withIpcChannel();
    send.mockReturnValue(false);
    const info = jest.fn();
    const warn = jest.fn();

    await listenOnEphemeralPort(server);

    // `process.send` returning false means the message was not handed to the
    // channel — claiming success would leave the parent waiting forever.
    expect(notifyListening(server, { info, warn })).toBe(false);
    expect(warn).toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it("survives a closed IPC channel instead of taking the engine down", async () => {
    const send = withIpcChannel();
    send.mockImplementation(() => {
      throw new Error("channel closed");
    });
    const warn = jest.fn();

    await listenOnEphemeralPort(server);

    expect(notifyListening(server, { info: jest.fn(), warn })).toBe(false);
    expect(warn).toHaveBeenCalled();
  });
});
