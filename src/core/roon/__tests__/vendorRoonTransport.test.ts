// Pins vendor/node-roon-api/transport-websocket.js Transport.close() against
// the reconnect defect diagnosed 2026-08-28
// (.agents/plans/reconnect-and-performance.md, Slice 1): close() only
// forwarded onclose() to the caller once the socket had reached "open"
// (`_isonopencalled`). A connect attempt that fails before open -- exactly
// what happens when a rebooting Core answers SOOD discovery before its
// websocket API is ready -- never told lib.js the connection died, leaking
// the discovery-suppression entry in `_sood_conns` forever and blocking
// every future reconnect until the whole process restarted.

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

describe("vendored Transport.close", () => {
  let instances: any[];
  let TransportCtor: any;

  beforeEach(() => {
    jest.resetModules();
    const MockWebSocket = require("ws");
    instances = MockWebSocket.instances;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    TransportCtor = require("../../../../vendor/node-roon-api/transport-websocket.js");
  });

  function makeTransport() {
    const transport = new TransportCtor("127.0.0.1", 9330, { log: jest.fn() });
    const onclose = jest.fn();
    transport.onclose = onclose;
    return { transport, onclose, ws: instances[instances.length - 1] };
  }

  it("fires onclose exactly once when close() is called before the socket ever opens", () => {
    const { transport, onclose } = makeTransport();

    transport.close();

    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it("fires onclose exactly once after a normal open then close", () => {
    const { transport, onclose, ws } = makeTransport();

    ws.onopen();
    transport.close();

    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it("fires onclose exactly once when a pre-open socket error is followed by the native ws close event", () => {
    const { transport, onclose, ws } = makeTransport();

    ws.onerror(new Error("ECONNREFUSED"));
    ws.onclose();

    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it("does not double-fire onclose when a manual close() is followed by the native ws close event", () => {
    const { transport, onclose, ws } = makeTransport();

    ws.onopen();
    transport.close();
    // The underlying socket's own close event can still arrive after we
    // already asked it to close and cleared our reference to it.
    ws.onclose();

    expect(onclose).toHaveBeenCalledTimes(1);
  });
});
