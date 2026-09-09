import { EventEmitter } from "events";

describe("SOOD local socket error observations", () => {
  let sood: any;
  let sockets: any[];
  let membershipError: Error | undefined;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.resetModules();
    jest.dontMock("../../../../vendor/node-roon-api/sood.js");
    sockets = [];
    membershipError = undefined;
    jest.doMock("os", () => ({ networkInterfaces: () => ({ eth0: [{
      family: "IPv4", address: "192.0.2.10", netmask: "255.255.255.0",
    }] }) }));
    jest.doMock("dgram", () => ({ createSocket: () => {
      const events = new EventEmitter();
      const socket = Object.assign(events, {
        bind: jest.fn((_options: unknown, cb: () => void) => cb()),
        addMembership: jest.fn(() => { if (membershipError) throw membershipError; }),
        setBroadcast: jest.fn(), setMulticastTTL: jest.fn(), send: jest.fn(),
        close: jest.fn(() => events.emit("close")),
      });
      sockets.push(socket);
      return socket;
    } }));
    sood = require("../../../../vendor/node-roon-api/sood.js")({ log: jest.fn() });
  });

  afterEach(() => { sood.stop(); jest.useRealTimers(); });

  it("reports errors on receive, interface-send and unicast sockets, then retires each socket", () => {
    const error = jest.fn();
    sood.on("socket-error", error);
    sood.start();
    expect(sockets).toHaveLength(3);
    const failure = Object.assign(new Error("socket refused"), { code: "EACCES" });
    for (const socket of sockets) {
      socket.emit("error", failure);
      expect(socket.close).toHaveBeenCalledTimes(1);
    }
    expect(error).toHaveBeenCalledTimes(3);
    expect(error).toHaveBeenLastCalledWith(failure);
  });

  it("reports a multicast membership failure instead of crashing startup", () => {
    const error = jest.fn();
    sood.on("socket-error", error);
    membershipError = Object.assign(new Error("membership refused"), { code: "ENODEV" });
    expect(() => sood.start()).not.toThrow();
    expect(error).toHaveBeenCalledWith(membershipError);
    expect(sockets[0].close).toHaveBeenCalledTimes(1);
  });
});
