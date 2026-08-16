/* eslint-disable @typescript-eslint/no-var-requires */
// Pins the vendored Roon API's transport-close cleanup against the live
// crash observed 2026-08-12: `Moo.clean_up` iterates a snapshot of pending
// request keys and invokes each callback, but a callback's side effects can
// delete other pending entries (an unsubscribe settling during teardown), so
// a later key resolves to undefined and the whole controller process died on
// every Core unpair with requests in flight.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Moo = require("../../../../vendor/node-roon-api/moo.js");

type MooRequests = Record<string, { cb?: () => void } | undefined>;
interface MooLike {
  requests: MooRequests;
  clean_up(): void;
}

function mooWithRequests(requests: MooRequests): MooLike {
  const moo = Object.create(Moo.prototype) as MooLike;
  moo.requests = requests;
  return moo;
}

describe("vendored Moo.clean_up", () => {
  it("survives a callback deleting another pending entry mid-cleanup", () => {
    const survivor = jest.fn();
    const moo = mooWithRequests({});
    moo.requests["1"] = {
      cb: () => {
        delete moo.requests["2"];
      },
    };
    moo.requests["2"] = { cb: jest.fn() };
    moo.requests["3"] = { cb: survivor };

    expect(() => moo.clean_up()).not.toThrow();
    expect(survivor).toHaveBeenCalledTimes(1);
    expect(moo.requests).toEqual({});
  });

  it("still invokes every intact pending callback once", () => {
    const first = jest.fn();
    const second = jest.fn();
    const moo = mooWithRequests({
      "1": { cb: first },
      "2": { cb: second },
      "3": {},
    });

    moo.clean_up();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(moo.requests).toEqual({});
  });
});
