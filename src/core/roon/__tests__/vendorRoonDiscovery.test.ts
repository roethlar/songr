import { EventEmitter } from "events";

jest.mock("ws", () => {
  return class MockWebSocket {
    static instances: any[] = [];
    on = jest.fn(); close = jest.fn(); terminate = jest.fn();
    send = jest.fn(); ping = jest.fn();
    constructor() { MockWebSocket.instances.push(this); }
  };
});

describe("vendored discovery progress over the real registry handshake", () => {
  let api: any;
  let sockets: any[];
  let progress: jest.Mock;
  let paired: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.resetModules();
    jest.doMock("../../../../vendor/node-roon-api/sood.js", () => () =>
      Object.assign(new EventEmitter(), {
        query: jest.fn(), start: (cb: () => void) => cb(), stop: jest.fn(),
      }));
    sockets = require("ws").instances;
    const RoonApi = require("../../../../vendor/node-roon-api/lib.js");
    let persisted = {};
    progress = jest.fn();
    paired = jest.fn();
    api = new RoonApi({
      extension_id: "app.test.discovery", display_name: "Test", display_version: "1",
      publisher: "Test", email: "test@example.com", log_level: "none",
      get_persisted_state: () => persisted,
      set_persisted_state: (state: object) => { persisted = state; },
      core_paired: paired, core_unpaired: jest.fn(),
      connection_status: progress, discovery_error: jest.fn(),
    });
    api.init_services({});
    api.start_discovery();
  });

  afterEach(() => {
    api.stop_discovery();
    api.disconnect_all();
    jest.useRealTimers();
  });

  function discover(id = "core-a") {
    api._sood.emit("message", {
      from: { ip: "203.0.113.10", port: 9003 },
      props: { service_id: "00720724-5143-4a9b-abac-0e50cba674bb", unique_id: id,
        http_port: "9330", name: "Studio Core" },
    });
    return sockets[sockets.length - 1];
  }

  function response(ws: any, id: number, name: string, body: object, verb = "COMPLETE") {
    const json = JSON.stringify(body);
    ws.onmessage({ data: Buffer.from(
      `MOO/1 ${verb} ${name}\nRequest-Id: ${id}\nContent-Type: application/json\nContent-Length: ${Buffer.byteLength(json)}\n\n${json}`,
    ) });
  }

  it("does not invent progress or approval when SOOD receives no response", () => {
    jest.advanceTimersByTime(60_000);
    expect(progress).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(0);
  });

  it("names discovery, waits for registry identity, then requests approval and pairs", () => {
    const ws = discover();
    expect(progress).toHaveBeenLastCalledWith({
      id: "core-a", host: "203.0.113.10", displayName: "Studio Core", phase: "connecting",
    });
    expect(paired).not.toHaveBeenCalled();
    ws.onopen();
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "registering" }));
    expect(ws.send.mock.calls[0][0].toString()).toContain("registry:1/info");
    response(ws, 0, "Success", { core_id: "core-a", display_name: "Verified Core" });
    expect(ws.send.mock.calls[1][0].toString()).toContain("registry:1/register");
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: "awaiting-approval", displayName: "Verified Core",
    }));
    jest.advanceTimersByTime(120_000);
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "awaiting-approval" }));
    response(ws, 1, "Registered", { core_id: "core-a", display_name: "Verified Core",
      display_version: "2", token: "must-not-reach-progress", provided_services: [] }, "CONTINUE");
    expect(paired).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "registered" }));
    expect(JSON.stringify(progress.mock.calls)).not.toContain("must-not-reach-progress");
  });

  it("reports connection failure with a safe code, retains it on close, and observes retry", () => {
    const ws = discover();
    ws.onerror({ error: { code: "ECONNREFUSED", message: "private payload" } });
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: "failed", detail: "Connecting to the Core failed (ECONNREFUSED).",
    }));
    const calls = progress.mock.calls.length;
    ws.onclose();
    expect(progress).toHaveBeenCalledTimes(calls);
    discover();
    expect(sockets).toHaveLength(2);
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "connecting" }));
    expect(JSON.stringify(progress.mock.calls)).not.toContain("private payload");
  });

  it("reports a stalled identity read and accepts a late successful handshake", () => {
    const ws = discover();
    ws.onopen();
    jest.advanceTimersByTime(15_000);
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: "failed", detail: expect.stringContaining("Reading the Core identity timed out"),
    }));
    response(ws, 0, "Success", { core_id: "core-a", display_name: "Recovered Core" });
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "awaiting-approval" }));
  });

  it("does not call a failed identity or rejected registration awaiting approval", () => {
    const bad = discover();
    bad.onopen();
    response(bad, 0, "InvalidRequest", {});
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "failed" }));
    expect(bad.send).toHaveBeenCalledTimes(1);
    const ws = discover("core-b");
    ws.onopen();
    response(ws, 0, "Success", { core_id: "core-b", display_name: "Second Core" });
    response(ws, 1, "NotCompatible", { error: "untrusted body" });
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: "failed", detail: "The Core refused extension registration.",
    }));
  });

  it("clears pending approval on connection loss and ignores late callbacks", () => {
    const ws = discover();
    ws.onopen();
    response(ws, 0, "Success", { core_id: "core-a", display_name: "Core" });
    const lateRegistration = api._sood_conns["core-a"].requests[1].cb;
    ws.onclose();
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "failed" }));
    const calls = progress.mock.calls.length;
    lateRegistration({ name: "Registered" }, { core_id: "core-a", token: "secret", provided_services: [] });
    jest.advanceTimersByTime(30_000);
    expect(progress).toHaveBeenCalledTimes(calls);
    expect(paired).not.toHaveBeenCalled();
  });

  it("forwards local discovery socket errors without their raw message", () => {
    api._sood.emit("socket-error", { code: "EACCES", message: "private" });
    expect(api.extension_opts.discovery_error).toHaveBeenCalledWith("EACCES");
  });
});
