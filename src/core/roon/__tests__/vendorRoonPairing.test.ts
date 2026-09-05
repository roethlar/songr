// Pins vendor/node-roon-api/lib.js pairing_service_1.lost_core against the
// missing-braces defect diagnosed 2026-08-28
// (.agents/plans/reconnect-and-performance.md, Slice 1): the paired-core
// check guarded `is_paired = false` correctly, but the following statement
// -- `if (this.extension_opts.core_unpaired) this.extension_opts.core_unpaired(core);`
// -- sat outside that `if` block, so `core_unpaired` fired for *any* lost
// core, paired or not, misreporting an unpairing for every Core the
// extension merely knew about but was never paired to.

describe("vendored RoonApi pairing_service_1.lost_core", () => {
  let RoonApi: any;

  beforeEach(() => {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    RoonApi = require("../../../../vendor/node-roon-api/lib.js");
  });

  function makePairedApi(corePaired: jest.Mock, coreUnpaired: jest.Mock) {
    const api = new RoonApi({
      extension_id: "com.test.pairing",
      display_name: "Test",
      display_version: "1.0.0",
      publisher: "Test",
      email: "test@example.com",
      log_level: "none",
      // Avoid the library's default file-backed persistence entirely; this
      // test only exercises the in-memory pairing state machine.
      get_persisted_state: () => ({}),
      set_persisted_state: () => {},
      core_paired: corePaired,
      core_unpaired: coreUnpaired,
    });
    api.init_services({});

    const coreA = { core_id: "core-a" };
    api.pairing_service_1.found_core(coreA);
    return { api, coreA };
  }

  it("does not call core_unpaired when a core other than the paired one is lost", () => {
    const corePaired = jest.fn();
    const coreUnpaired = jest.fn();
    const { api } = makePairedApi(corePaired, coreUnpaired);

    const coreB = { core_id: "core-b" };
    api.pairing_service_1.lost_core(coreB);

    expect(coreUnpaired).not.toHaveBeenCalled();
    expect(api.is_paired).toBe(true);
  });

  it("calls core_unpaired exactly once when the paired core is lost", () => {
    const corePaired = jest.fn();
    const coreUnpaired = jest.fn();
    const { api, coreA } = makePairedApi(corePaired, coreUnpaired);

    api.pairing_service_1.lost_core(coreA);

    expect(coreUnpaired).toHaveBeenCalledTimes(1);
    expect(coreUnpaired).toHaveBeenCalledWith(coreA);
    expect(api.is_paired).toBe(false);
  });
});
