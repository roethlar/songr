import { promises as fsp } from "fs";
import fs from "fs";
import path from "path";
import os from "os";
import { Logger } from "pino";

// Capture the options the lib was constructed with so tests can poke
// at get_persisted_state / set_persisted_state directly. RoonApi is a
// no-op stub here — start() must not try to discover/network during a
// unit test.
let capturedOptions: any = null;
jest.mock("node-roon-api", () => {
  return jest.fn().mockImplementation((opts: unknown) => {
    capturedOptions = opts;
    return {
      init_services: jest.fn(),
      start_discovery: jest.fn(),
    };
  });
});
jest.mock("node-roon-api-transport", () => ({}));
jest.mock("node-roon-api-browse", () => ({}));
jest.mock("node-roon-api-image", () => ({}));

import { RoonClient } from "../RoonClient";

const stubLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
  level: "info",
} as unknown as Logger;

async function makeTokenPath(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "roon-token-"));
  return path.join(dir, "roon-token.json");
}

beforeEach(() => {
  capturedOptions = null;
  jest.clearAllMocks();
});

describe("RoonClient — persisted-state callbacks", () => {
  it("get_persisted_state returns {} when token file does not exist", async () => {
    const tokenPath = await makeTokenPath();
    new RoonClient({ tokenPath, logger: stubLogger }).start();

    expect(capturedOptions.get_persisted_state).toBeInstanceOf(Function);
    expect(capturedOptions.get_persisted_state()).toEqual({});
  });

  it("get_persisted_state reads and parses an existing JSON file", async () => {
    const tokenPath = await makeTokenPath();
    const persisted = {
      paired_core_id: "core-abc",
      tokens: { "core-abc": "tk-xyz" },
    };
    await fsp.mkdir(path.dirname(tokenPath), { recursive: true });
    await fsp.writeFile(tokenPath, JSON.stringify(persisted), "utf-8");

    new RoonClient({ tokenPath, logger: stubLogger }).start();
    expect(capturedOptions.get_persisted_state()).toEqual(persisted);
  });

  it("get_persisted_state returns {} when the file is corrupt (and warns)", async () => {
    const tokenPath = await makeTokenPath();
    await fsp.mkdir(path.dirname(tokenPath), { recursive: true });
    await fsp.writeFile(tokenPath, "{ not json", "utf-8");

    new RoonClient({ tokenPath, logger: stubLogger }).start();
    expect(capturedOptions.get_persisted_state()).toEqual({});
    expect(stubLogger.warn).toHaveBeenCalled();
  });

  it("set_persisted_state writes JSON atomically (tmp + rename, no leftover .tmp)", async () => {
    const tokenPath = await makeTokenPath();
    new RoonClient({ tokenPath, logger: stubLogger }).start();

    const state = {
      paired_core_id: "core-1",
      tokens: { "core-1": "secret-token" },
    };
    capturedOptions.set_persisted_state(state);

    const onDisk = JSON.parse(fs.readFileSync(tokenPath, "utf-8"));
    expect(onDisk).toEqual(state);
    expect(fs.existsSync(`${tokenPath}.tmp`)).toBe(false);
    // 0o600 — the token grants Roon control identity.
    const mode = fs.statSync(tokenPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("set_persisted_state creates the parent directory if missing", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "roon-token-"));
    // Configure a nested path that doesn't yet exist.
    const tokenPath = path.join(tmpDir, "nested", "subdir", "roon-token.json");

    new RoonClient({ tokenPath, logger: stubLogger }).start();
    capturedOptions.set_persisted_state({ tokens: { "c": "x" } });

    expect(fs.existsSync(tokenPath)).toBe(true);
  });
});

describe("RoonClient — hasEverPaired", () => {
  it("is false on a first run with no token file", async () => {
    const tokenPath = await makeTokenPath();
    const client = new RoonClient({ tokenPath, logger: stubLogger });
    client.start();

    expect(client.getCoreStatus()).toBe("discovering");
    expect(client.hasEverPaired()).toBe(false);
  });

  it("is true from a persisted paired_core_id while the Core is unreachable", async () => {
    const tokenPath = await makeTokenPath();
    await fsp.mkdir(path.dirname(tokenPath), { recursive: true });
    await fsp.writeFile(
      tokenPath,
      JSON.stringify({ paired_core_id: "core-abc" }),
      "utf-8"
    );

    const client = new RoonClient({ tokenPath, logger: stubLogger });
    client.start();

    // The live status is indistinguishable from a first run — which is
    // exactly why the durable answer has to come from the token file.
    expect(client.getCoreStatus()).toBe("discovering");
    expect(client.hasEverPaired()).toBe(true);
  });

  it("is true from a non-empty tokens map alone", async () => {
    const tokenPath = await makeTokenPath();
    await fsp.mkdir(path.dirname(tokenPath), { recursive: true });
    await fsp.writeFile(
      tokenPath,
      JSON.stringify({ tokens: { "core-abc": "tk-xyz" } }),
      "utf-8"
    );

    const client = new RoonClient({ tokenPath, logger: stubLogger });
    client.start();

    expect(client.hasEverPaired()).toBe(true);
  });

  it("is false for placeholder state — empty id, empty tokens map, corrupt file", async () => {
    const emptyish = await makeTokenPath();
    await fsp.mkdir(path.dirname(emptyish), { recursive: true });
    await fsp.writeFile(
      emptyish,
      JSON.stringify({ paired_core_id: "", tokens: {} }),
      "utf-8"
    );
    expect(
      new RoonClient({ tokenPath: emptyish, logger: stubLogger }).hasEverPaired()
    ).toBe(false);

    const corrupt = await makeTokenPath();
    await fsp.mkdir(path.dirname(corrupt), { recursive: true });
    await fsp.writeFile(corrupt, "{ not json", "utf-8");
    expect(
      new RoonClient({ tokenPath: corrupt, logger: stubLogger }).hasEverPaired()
    ).toBe(false);
  });

  it("flips to true as soon as pairing lands, before anything is written", async () => {
    const tokenPath = await makeTokenPath();
    const client = new RoonClient({ tokenPath, logger: stubLogger });
    client.start();
    expect(client.hasEverPaired()).toBe(false);

    capturedOptions.core_paired({
      core_id: "core-live",
      display_name: "Living Room",
      display_version: "2.0",
      services: {},
    });

    expect(client.hasEverPaired()).toBe(true);
    expect(fs.existsSync(tokenPath)).toBe(false);
  });
});

describe("RoonClient — legacy config.json migration", () => {
  let originalCwd: string;
  let cwdDir: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    cwdDir = await fsp.mkdtemp(path.join(os.tmpdir(), "roon-cwd-"));
    process.chdir(cwdDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
  });

  it("migrates a pre-existing config.json from cwd to the configured tokenPath", async () => {
    const legacyPath = path.join(cwdDir, "config.json");
    const persisted = {
      paired_core_id: "core-legacy",
      tokens: { "core-legacy": "legacy-token" },
    };
    await fsp.writeFile(legacyPath, JSON.stringify(persisted), "utf-8");

    const tokenPath = path.join(cwdDir, "data", "roon-token.json");
    new RoonClient({ tokenPath, logger: stubLogger }).start();

    // Migrated to the configured path…
    expect(fs.existsSync(tokenPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(tokenPath, "utf-8"))).toEqual(persisted);
    // …and removed from cwd so it can't drift back into use.
    expect(fs.existsSync(legacyPath)).toBe(false);
  });

  it("does NOT migrate when the configured tokenPath already exists (no clobber)", async () => {
    const legacyPath = path.join(cwdDir, "config.json");
    await fsp.writeFile(legacyPath, JSON.stringify({ tokens: { x: "legacy" } }), "utf-8");

    const tokenPath = path.join(cwdDir, "roon-token.json");
    await fsp.writeFile(tokenPath, JSON.stringify({ tokens: { y: "current" } }), "utf-8");

    new RoonClient({ tokenPath, logger: stubLogger }).start();

    // Configured target untouched, legacy file untouched.
    expect(JSON.parse(fs.readFileSync(tokenPath, "utf-8"))).toEqual({
      tokens: { y: "current" },
    });
    expect(fs.existsSync(legacyPath)).toBe(true);
  });

  it("leaves an unrelated cwd config.json untouched (no copy, no delete)", async () => {
    // config.json is a generic name: another app's config in the
    // process cwd must never be swallowed into the token path — and
    // above all never deleted.
    const legacyPath = path.join(cwdDir, "config.json");
    const unrelated = { port: 8080, theme: "dark", plugins: ["a", "b"] };
    await fsp.writeFile(legacyPath, JSON.stringify(unrelated), "utf-8");

    const tokenPath = path.join(cwdDir, "roon-token.json");
    new RoonClient({ tokenPath, logger: stubLogger }).start();

    expect(fs.existsSync(tokenPath)).toBe(false);
    expect(JSON.parse(fs.readFileSync(legacyPath, "utf-8"))).toEqual(unrelated);
    expect(stubLogger.warn).toHaveBeenCalled();
  });

  it("recognizes a tokens-only legacy file as Roon state and migrates it", async () => {
    const legacyPath = path.join(cwdDir, "config.json");
    const persisted = { tokens: { "core-x": "tok" } };
    await fsp.writeFile(legacyPath, JSON.stringify(persisted), "utf-8");

    const tokenPath = path.join(cwdDir, "data", "roon-token.json");
    new RoonClient({ tokenPath, logger: stubLogger }).start();

    expect(JSON.parse(fs.readFileSync(tokenPath, "utf-8"))).toEqual(persisted);
    expect(fs.existsSync(legacyPath)).toBe(false);
  });

  it("skips migration when the legacy file is not valid JSON", async () => {
    const legacyPath = path.join(cwdDir, "config.json");
    await fsp.writeFile(legacyPath, "{ not json", "utf-8");

    const tokenPath = path.join(cwdDir, "roon-token.json");
    new RoonClient({ tokenPath, logger: stubLogger }).start();

    expect(fs.existsSync(tokenPath)).toBe(false);
    expect(fs.existsSync(legacyPath)).toBe(true); // left for human inspection
    expect(stubLogger.warn).toHaveBeenCalled();
  });

  it("does nothing when neither file exists", async () => {
    const tokenPath = path.join(cwdDir, "roon-token.json");
    new RoonClient({ tokenPath, logger: stubLogger }).start();

    expect(fs.existsSync(tokenPath)).toBe(false);
    expect(capturedOptions.get_persisted_state()).toEqual({});
  });
});

describe("RoonClient — Core address derivation (install-finish Slice 1)", () => {
  function pairedCore(over: Record<string, unknown> = {}): unknown {
    return {
      core_id: "deadbeef-0000-4000-8000-000000000000",
      display_name: "Q",
      display_version: "2.0",
      // node-roon-api's websocket transport reports the address it
      // connected to (loopback-normalized for same-host Cores).
      moo: { transport: { host: "10.1.10.59" } },
      services: {},
      ...over,
    };
  }

  it("exposes the paired Core's broker host and id, cleared on unpair", async () => {
    const tokenPath = await makeTokenPath();
    const client = new RoonClient({ tokenPath, logger: stubLogger });
    client.start();
    expect(client.getCoreAddress()).toBeNull();

    capturedOptions.core_paired(pairedCore());
    expect(client.getCoreAddress()).toEqual({
      host: "10.1.10.59",
      uniqueId: "deadbeef-0000-4000-8000-000000000000",
    });

    capturedOptions.core_unpaired();
    expect(client.getCoreAddress()).toBeNull();
  });

  it("answers null when the paired Core reports no transport address", async () => {
    const tokenPath = await makeTokenPath();
    const client = new RoonClient({ tokenPath, logger: stubLogger });
    client.start();

    capturedOptions.core_paired(pairedCore({ moo: undefined }));
    expect(client.getCoreAddress()).toBeNull();
    // The pairing itself is unaffected.
    expect(client.getCoreInfo()?.id).toBe(
      "deadbeef-0000-4000-8000-000000000000"
    );
  });
});
