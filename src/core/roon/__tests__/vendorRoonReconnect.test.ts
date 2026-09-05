// Pins the reconnect chain fixed by vendor/node-roon-api/transport-websocket.js
// Transport.close() (.agents/plans/reconnect-and-performance.md, Slice 1),
// exercised through the real vendor/node-roon-api/lib.js SOOD message
// handler. A pre-open connect failure must reach `onclose` so the SOOD
// discovery-suppression entry (`_sood_conns[unique_id]`) gets deleted; only
// then can a later SOOD response for the same core retry the connection.
// Before the fix, a pre-open failure never reached lib.js's `onclose`, the
// entry never got deleted, and every future discovery response for that
// core_id was silently dropped by the `if (this._sood_conns[unique_id])
// return;` guard -- the mechanism behind "songr did not reconnect until I
// restarted it" after a Core reboot (a rebooting Core answers SOOD over UDP
// before its websocket API accepts connections).
//
// The transport unit tests in vendorRoonTransport.test.ts prove `onclose`
// fires correctly in isolation; this test proves the fix actually unblocks
// the leaked map entry when driven through the real, unmodified SOOD
// handler in lib.js.

import { EventEmitter } from "events";

jest.mock("ws", () => {
  class MockWebSocket {
    static instances: MockWebSocket[] = [];

    public on = jest.fn();
    public close = jest.fn();
    public terminate = jest.fn();
    public send = jest.fn();
    public ping = jest.fn();
    public onopen: (() => void) | undefined;
    public onclose: (() => void) | undefined;
    public onerror: ((err: unknown) => void) | undefined;
    public onmessage: ((event: { data: unknown }) => void) | undefined;

    constructor() {
      MockWebSocket.instances.push(this);
    }
  }
  return MockWebSocket;
});

const SOOD_SERVICE_ID = "00720724-5143-4a9b-abac-0e50cba674bb";

function makeSoodMessage(uniqueId: string) {
  return {
    // TEST-NET-3 (RFC 5737): guaranteed not to match a real local interface
    // address, so the handler's "rewrite to 127.0.0.1" loop is a no-op.
    from: { ip: "203.0.113.10", port: 9003 },
    props: {
      service_id: SOOD_SERVICE_ID,
      unique_id: uniqueId,
      http_port: "9330",
    },
  };
}

describe("vendored RoonApi SOOD reconnect chain", () => {
  let RoonApi: any;
  let sood: EventEmitter & { query: jest.Mock; start: jest.Mock; stop: jest.Mock };
  let wsInstances: any[];
  let currentApi: any;

  // Guaranteed even if an assertion throws mid-test: start_discovery() sets
  // a real (unmocked) 10s setInterval, and a failed assertion must not leak
  // it into later test files.
  afterEach(() => {
    if (currentApi) currentApi.stop_discovery();
    currentApi = undefined;
  });

  beforeEach(() => {
    jest.resetModules();

    jest.doMock("../../../../vendor/node-roon-api/sood.js", () => {
      return jest.fn(() => {
        const emitter = new EventEmitter() as any;
        emitter.query = jest.fn();
        emitter.start = jest.fn((cb?: () => void) => cb && cb());
        emitter.stop = jest.fn();
        return emitter;
      });
    });

    const MockWebSocket = require("ws");
    wsInstances = MockWebSocket.instances;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    RoonApi = require("../../../../vendor/node-roon-api/lib.js");
  });

  function makeRoonApi() {
    const api = new RoonApi({
      extension_id: "com.test.reconnect",
      display_name: "Test",
      display_version: "1.0.0",
      publisher: "Test",
      email: "test@example.com",
      log_level: "none",
    });
    api.start_discovery();
    sood = api._sood;
    currentApi = api;
    return api;
  }

  it("deletes the leaked _sood_conns entry after a pre-open connect failure, and allows a later SOOD response to retry", () => {
    const api = makeRoonApi();
    const uniqueId = "core-under-test";

    // First SOOD response: the real handler synchronously starts a connect
    // attempt and records it under _sood_conns.
    sood.emit("message", makeSoodMessage(uniqueId));
    expect(api._sood_conns[uniqueId]).toBeDefined();
    expect(wsInstances).toHaveLength(1);

    // Simulate a rebooting Core answering SOOD before its websocket API is
    // ready: the connect attempt fails before "open".
    const firstWs = wsInstances[0];
    firstWs.onerror(new Error("ECONNREFUSED"));
    firstWs.onclose();

    expect(api._sood_conns[uniqueId]).toBeUndefined();

    // A second SOOD response for the same core must not be dropped by the
    // "already connecting" guard now that the leaked entry is gone.
    sood.emit("message", makeSoodMessage(uniqueId));
    expect(api._sood_conns[uniqueId]).toBeDefined();
    expect(wsInstances).toHaveLength(2);
  });
});
