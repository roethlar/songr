import childProcess, { execFileSync, spawnSync } from "child_process";
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
interface MockRoonApiInstance {
  init_services: jest.Mock;
  start_discovery: jest.Mock;
  stop_discovery: jest.Mock;
  disconnect_all: jest.Mock;
}
const mockRoonInstances: MockRoonApiInstance[] = [];
jest.mock("node-roon-api", () => {
  return jest.fn().mockImplementation((opts: unknown) => {
    capturedOptions = opts;
    const instance: MockRoonApiInstance = {
      init_services: jest.fn(),
      start_discovery: jest.fn(),
      stop_discovery: jest.fn(),
      disconnect_all: jest.fn(),
    };
    mockRoonInstances.push(instance);
    return instance;
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

// ── Windows ACL read-back ───────────────────────────────────────────────
// Read independently of the code under test: PowerShell's Get-Acl SDDL and
// .NET's view of the current user, never windowsPrivateAcl's own whoami.

const SDDL_ALIASES: Record<string, string> = {
  SY: "S-1-5-18",
  BA: "S-1-5-32-544",
  BU: "S-1-5-32-545",
  WD: "S-1-1-0",
  AU: "S-1-5-11",
};

interface DaclEntry { type: string; flags: string; rights: string; sid: string }
interface Dacl { flags: string; entries: DaclEntry[] }

function runPowerShell(script: string, env: Record<string, string> = {}): string {
  // Windows PowerShell 5.1 cannot load its own modules from a PowerShell 7
  // module path inherited from the shell that started Jest.
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
  for (const key of Object.keys(childEnv)) {
    if (key.toLowerCase() === "psmodulepath") delete childEnv[key];
  }
  return execFileSync(
    path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", env: childEnv, windowsHide: true }
  ).trim();
}

function readDacl(target: string): Dacl {
  const sddl = runPowerShell("(Get-Acl -LiteralPath $env:ACL_TARGET).Sddl", { ACL_TARGET: target });
  const match = /D:([A-Z]*)((?:\([^)]*\))*)/.exec(sddl);
  if (!match) throw new Error(`No DACL in SDDL ${sddl}`);
  const entries = [...match[2].matchAll(/\(([^)]*)\)/g)].map((m) => {
    const [type, flags, rights, , , sid] = m[1].split(";");
    return { type, flags, rights, sid: SDDL_ALIASES[sid] ?? sid };
  });
  return { flags: match[1], entries };
}

function readSddl(target: string): string {
  return runPowerShell("(Get-Acl -LiteralPath $env:ACL_TARGET).Sddl", { ACL_TARGET: target });
}

function currentWindowsUserSid(): string {
  return runPowerShell("[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value");
}

/**
 * The installer's layout on Windows: a `config\` directory under a parent
 * (`C:\Program Files`) whose inheritable ACE lets every local user read.
 * Seeded with icacls itself, not with the code under test.
 */
async function makeUsersReadableTokenPath(): Promise<string> {
  return path.join(await makeUsersReadableDir("config"), "roon-token.json");
}

interface ProtectObservation {
  target: string;
  sizeWhenProtected: number;
  otherProcessOpen: string;
}

const OPEN_FOR_READ_PROBE =
  "try{const fs=require('fs');fs.closeSync(fs.openSync(process.argv[1],'r'));console.log('opened')}" +
  "catch(e){console.log(e.code)}";

/**
 * Watch the real icacls calls: for each, how many bytes the target held and
 * whether another process could open it for reading at that moment.
 */
function observeProtectCalls(): { calls: ProtectObservation[]; restore: () => void } {
  const calls: ProtectObservation[] = [];
  const real = childProcess.execFileSync as (...args: unknown[]) => unknown;
  const spy = jest.spyOn(childProcess, "execFileSync").mockImplementation(((
    file: string,
    args: readonly string[],
    options: unknown
  ) => {
    if (/icacls\.exe$/i.test(file)) {
      const target = args[0];
      const probe = spawnSync(process.execPath, ["-e", OPEN_FOR_READ_PROBE, target], {
        encoding: "utf8",
        windowsHide: true,
      });
      calls.push({
        target,
        sizeWhenProtected: fs.statSync(target).size,
        otherProcessOpen: probe.stdout.trim(),
      });
    }
    return real(file, args, options);
  }) as unknown as typeof childProcess.execFileSync);
  return { calls, restore: () => spy.mockRestore() };
}

async function makeUsersReadableDir(name: string): Promise<string> {
  const parent = await fsp.mkdtemp(path.join(os.tmpdir(), "roon-token-acl-"));
  execFileSync(
    path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "icacls.exe"),
    [parent, "/grant", "*S-1-5-32-545:(OI)(CI)(RX)", "/q"],
    { encoding: "utf8", windowsHide: true }
  );
  const dir = path.join(parent, name);
  await fsp.mkdir(dir);
  // Precondition: without Songr's ACL a token here would be readable by Users.
  expect(readDacl(dir).entries).toContainEqual(
    expect.objectContaining({ sid: "S-1-5-32-545", flags: expect.stringContaining("ID") })
  );
  return dir;
}

/** Exactly user, SYSTEM and Administrators, full control, nothing inherited. */
function expectOwnerOnlyAcl(target: string, userSid: string): void {
  const dacl = readDacl(target);
  expect(dacl.flags).toContain("P");
  expect(dacl.entries.filter((e) => e.flags.includes("ID"))).toEqual([]);
  for (const broad of ["S-1-5-32-545", "S-1-1-0", "S-1-5-11"]) {
    expect(dacl.entries.map((e) => e.sid)).not.toContain(broad);
  }
  expect([...new Set(dacl.entries.map((e) => e.sid))].sort()).toEqual(
    [...new Set([userSid, "S-1-5-18", "S-1-5-32-544"])].sort()
  );
  for (const entry of dacl.entries) {
    expect(entry).toMatchObject({ type: "A", rights: "FA" });
  }
}

beforeEach(() => {
  capturedOptions = null;
  mockRoonInstances.length = 0;
  jest.clearAllMocks();
});

describe("RoonClient — persisted-state callbacks", () => {
  it("registers current Songr display metadata while reusing existing authorization", async () => {
    const tokenPath = await makeTokenPath();
    const persisted = {
      paired_core_id: "core-abc",
      tokens: { "core-abc": "existing-token", "core-def": "other-core-token" },
    };
    const saved = JSON.stringify(persisted, null, 2);
    await fsp.writeFile(tokenPath, saved, { mode: 0o600 });
    const version = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "../../../../package.json"), "utf8")
    ).version;

    // Both the first start after upgrade and subsequent starts use the same
    // extension identity and token path; display metadata cannot reset pairing.
    for (let start = 0; start < 2; start += 1) {
      new RoonClient({ tokenPath, logger: stubLogger }).start();
      expect(capturedOptions).toMatchObject({
        extension_id: "app.songr.controller",
        display_name: `Songr (${os.hostname()})`,
        display_version: version,
        publisher: "Songr",
      });
      expect(capturedOptions.get_persisted_state()).toEqual(persisted);
      expect(fs.readFileSync(tokenPath, "utf8")).toBe(saved);
    }
  });

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
    const isWindows = process.platform === "win32";
    const tokenPath = isWindows ? await makeUsersReadableTokenPath() : await makeTokenPath();
    // The token's directory is Songr's own CONFIG_DIR, as in every default layout.
    new RoonClient({ tokenPath, configDir: path.dirname(tokenPath), logger: stubLogger }).start();

    const state = {
      paired_core_id: "core-1",
      tokens: { "core-1": "secret-token" },
    };
    capturedOptions.set_persisted_state(state);

    const onDisk = JSON.parse(fs.readFileSync(tokenPath, "utf-8"));
    expect(onDisk).toEqual({ ...state, songr_ever_paired: true });
    expect(fs.existsSync(`${tokenPath}.tmp`)).toBe(false);
    // Owner-only — the token grants Roon control identity. POSIX: mode
    // 0o600. Windows ignores modes; the file and its directory carry an ACL
    // granting only this user, SYSTEM and Administrators.
    if (isWindows) {
      const userSid = currentWindowsUserSid();
      expectOwnerOnlyAcl(tokenPath, userSid);
      expectOwnerOnlyAcl(path.dirname(tokenPath), userSid);
    } else {
      const mode = fs.statSync(tokenPath).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it("set_persisted_state creates the parent directory if missing", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "roon-token-"));
    // Configure a nested path that doesn't yet exist.
    const tokenPath = path.join(tmpDir, "nested", "subdir", "roon-token.json");

    new RoonClient({ tokenPath, logger: stubLogger }).start();
    capturedOptions.set_persisted_state({ tokens: { "c": "x" } });

    expect(fs.existsSync(tokenPath)).toBe(true);
    // A directory Songr created is Songr's own, so it is owner-only too.
    if (process.platform === "win32") {
      const userSid = currentWindowsUserSid();
      expectOwnerOnlyAcl(path.dirname(tokenPath), userSid);
      expectOwnerOnlyAcl(tokenPath, userSid);
    } else {
      expect(fs.statSync(path.dirname(tokenPath)).mode & 0o777).toBe(0o700);
      expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600);
    }
  });

  it("leaves an existing directory that is not CONFIG_DIR exactly as it was, and keeps the token owner-only", async () => {
    // A custom ROON_TOKEN_PATH into a shared folder, e.g. C:\data\songr-token.json.
    const isWindows = process.platform === "win32";
    const shared = isWindows
      ? await makeUsersReadableDir("shared")
      : await fsp.mkdtemp(path.join(os.tmpdir(), "roon-shared-"));
    if (!isWindows) await fsp.chmod(shared, 0o755);
    const sibling = path.join(shared, "someone-elses-notes.txt");
    await fsp.writeFile(sibling, "not Songr's", "utf-8");
    const tokenPath = path.join(shared, "songr-token.json");
    const configDir = await fsp.mkdtemp(path.join(os.tmpdir(), "roon-config-"));
    const readPermissions = (target: string): string =>
      isWindows ? readSddl(target) : (fs.statSync(target).mode & 0o777).toString(8);
    const dirBefore = readPermissions(shared);
    const siblingBefore = readPermissions(sibling);

    new RoonClient({ tokenPath, configDir, logger: stubLogger }).start();
    capturedOptions.set_persisted_state({ paired_core_id: "core-1", tokens: { "core-1": "t" } });

    expect(fs.existsSync(tokenPath)).toBe(true);
    expect(readPermissions(shared)).toBe(dirBefore);
    expect(readPermissions(sibling)).toBe(siblingBefore);
    if (isWindows) {
      // The renamed token keeps the explicit, protected ACL its tmp file got.
      expectOwnerOnlyAcl(tokenPath, currentWindowsUserSid());
    } else {
      expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600);
    }
  });

  (process.platform === "win32" ? it : it.skip)(
    "secures the tmp file while it is empty and no other process can open it, whatever the directory allows",
    async () => {
      const shared = await makeUsersReadableDir("shared");
      const tokenPath = path.join(shared, "songr-token.json");
      new RoonClient({ tokenPath, logger: stubLogger }).start();

      const observed = observeProtectCalls();
      try {
        capturedOptions.set_persisted_state({ paired_core_id: "core-1", tokens: { "core-1": "t" } });
      } finally {
        observed.restore();
      }

      // The shared directory is not Songr's: only the tmp file is secured.
      expect(observed.calls).toEqual([
        { target: `${tokenPath}.tmp`, sizeWhenProtected: 0, otherProcessOpen: "EBUSY" },
      ]);
      expect(JSON.parse(fs.readFileSync(tokenPath, "utf-8")).tokens).toEqual({ "core-1": "t" });
    }
  );
});

describe("RoonClient — discovery observations", () => {
  const candidate = { id: "core-a", host: "203.0.113.10", displayName: "Studio Core", phase: "connecting" };

  it("keeps independent, sanitized Core observations without emitting pairing events", async () => {
    const client = new RoonClient({ tokenPath: await makeTokenPath(), logger: stubLogger });
    client.start();
    const discovery = jest.fn();
    const lifecycle = jest.fn();
    client.on("core-discovery", discovery);
    client.on("core-status", lifecycle);
    capturedOptions.connection_status({ ...candidate, token: "private" });
    capturedOptions.connection_status({ ...candidate, id: "core-b", phase: "awaiting-approval" });
    expect(client.getDiscoveryStatus().cores).toEqual([
      candidate, { ...candidate, id: "core-b", phase: "awaiting-approval" },
    ]);
    expect(discovery).toHaveBeenCalledTimes(2);
    expect(lifecycle).not.toHaveBeenCalled();
    expect(client.getCoreStatus()).toBe("discovering");
    const copy = client.getDiscoveryStatus().cores[0] as any;
    copy.phase = "failed";
    expect(client.getDiscoveryStatus().cores[0].phase).toBe("connecting");
    capturedOptions.connection_status({ ...candidate, phase: "unknown" });
    expect(discovery).toHaveBeenCalledTimes(2);
  });

  it("clears observations on Core switch and ignores retired API callbacks", async () => {
    const client = new RoonClient({ tokenPath: await makeTokenPath(), logger: stubLogger });
    client.start();
    const retired = capturedOptions;
    retired.connection_status({ ...candidate, phase: "awaiting-approval" });
    retired.discovery_error("EACCES");
    expect(client.getDiscoveryStatus().error).toContain("EACCES");
    client.switchCore();
    expect(client.getDiscoveryStatus()).toEqual({ cores: [] });
    retired.connection_status(candidate);
    retired.discovery_error("EACCES");
    expect(client.getDiscoveryStatus()).toEqual({ cores: [] });
    capturedOptions.connection_status(candidate);
    expect(client.getDiscoveryStatus().cores).toEqual([candidate]);
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

  it("stays true from the Songr marker while a new Core awaits authorization", async () => {
    const tokenPath = await makeTokenPath();
    await fsp.mkdir(path.dirname(tokenPath), { recursive: true });
    await fsp.writeFile(
      tokenPath,
      JSON.stringify({ songr_ever_paired: true, tokens: {} }),
      "utf-8"
    );

    const client = new RoonClient({ tokenPath, logger: stubLogger });
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

describe("RoonClient — switch Core", () => {
  function pairedCore(id: string, services: Record<string, unknown> = {}): unknown {
    return {
      core_id: id,
      display_name: id === "core-a" ? "Core A" : "Core B",
      display_version: "2.0",
      moo: { transport: { host: "10.0.0.5" } },
      services,
    };
  }

  it("retires the current API, preserves unrelated tokens, and fences stale callbacks", async () => {
    const tokenPath = await makeTokenPath();
    await fsp.writeFile(
      tokenPath,
      JSON.stringify({
        paired_core_id: "core-a",
        tokens: { "core-a": "token-a", "core-b": "token-b" },
        retained: "value",
      }),
      "utf-8"
    );
    const client = new RoonClient({ tokenPath, logger: stubLogger });
    const statuses: string[] = [];
    client.on("core-status", ({ coreStatus }) => statuses.push(coreStatus));
    client.start();
    const firstOptions = capturedOptions;
    const firstApi = mockRoonInstances[0];
    const transport = { transport: true };
    firstOptions.core_paired(
      pairedCore("core-a", {
        RoonApiTransport: transport,
        RoonApiBrowse: { browse: true },
        RoonApiImage: { image: true },
      })
    );

    expect(client.switchCore()).toBe(true);

    expect(firstApi.stop_discovery).toHaveBeenCalledTimes(1);
    expect(firstApi.disconnect_all).toHaveBeenCalledTimes(1);
    expect(mockRoonInstances).toHaveLength(2);
    expect(mockRoonInstances[1].start_discovery).toHaveBeenCalledTimes(1);
    expect(statuses.slice(-2)).toEqual(["unpaired", "discovering"]);
    expect(client.getCoreStatus()).toBe("discovering");
    expect(client.getCoreInfo()).toBeNull();
    expect(client.getTransport()).toBeNull();
    expect(client.getBrowse()).toBeNull();
    expect(client.getImage()).toBeNull();
    expect(JSON.parse(await fsp.readFile(tokenPath, "utf-8"))).toEqual({
      tokens: { "core-b": "token-b" },
      retained: "value",
      songr_ever_paired: true,
    });

    // The retired instance can close or report a late pair after the switch;
    // neither callback may reclaim live Core/service authority.
    firstOptions.core_paired(pairedCore("core-a", { RoonApiTransport: transport }));
    firstOptions.core_unpaired();
    expect(client.getCoreStatus()).toBe("discovering");
    expect(client.getCoreInfo()).toBeNull();
    firstOptions.set_persisted_state({
      paired_core_id: "core-a",
      tokens: { "core-a": "late-token-a" },
    });
    expect(JSON.parse(await fsp.readFile(tokenPath, "utf-8"))).toEqual({
      tokens: { "core-b": "token-b" },
      retained: "value",
      songr_ever_paired: true,
    });

    capturedOptions.core_paired(pairedCore("core-b"));
    expect(client.getCoreStatus()).toBe("paired");
    expect(client.getCoreInfo()?.id).toBe("core-b");
  });

  it("leaves the working connection intact when the strict persisted-state write fails", async () => {
    const tokenPath = await makeTokenPath();
    const persisted = {
      paired_core_id: "core-a",
      tokens: { "core-a": "token-a" },
    };
    await fsp.writeFile(tokenPath, JSON.stringify(persisted), "utf-8");
    const client = new RoonClient({ tokenPath, logger: stubLogger });
    client.start();
    const firstApi = mockRoonInstances[0];
    capturedOptions.core_paired(
      pairedCore("core-a", {
        RoonApiTransport: { transport: true },
        RoonApiBrowse: { browse: true },
      })
    );
    const rename = jest.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("disk is read-only");
    });

    expect(() => client.switchCore()).toThrow("disk is read-only");

    rename.mockRestore();
    expect(client.getCoreStatus()).toBe("paired");
    expect(client.getCoreInfo()?.id).toBe("core-a");
    expect(client.getTransport()).not.toBeNull();
    expect(firstApi.stop_discovery).not.toHaveBeenCalled();
    expect(firstApi.disconnect_all).not.toHaveBeenCalled();
    expect(mockRoonInstances[1].start_discovery).not.toHaveBeenCalled();
    expect(fs.existsSync(`${tokenPath}.tmp`)).toBe(false);
    expect(JSON.parse(await fsp.readFile(tokenPath, "utf-8"))).toEqual(persisted);
  });

  it("treats repeated confirmation as idempotent while discovery is pending", async () => {
    const tokenPath = await makeTokenPath();
    await fsp.writeFile(
      tokenPath,
      JSON.stringify({ paired_core_id: "core-a", tokens: { "core-a": "token-a" } }),
      "utf-8"
    );
    const client = new RoonClient({ tokenPath, logger: stubLogger });
    client.start();
    capturedOptions.core_paired(pairedCore("core-a"));

    expect(client.switchCore()).toBe(true);
    expect(client.switchCore()).toBe(false);

    expect(mockRoonInstances).toHaveLength(2);
    expect(mockRoonInstances[0].disconnect_all).toHaveBeenCalledTimes(1);
    expect(mockRoonInstances[1].start_discovery).toHaveBeenCalledTimes(1);
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
    const observed = process.platform === "win32" ? observeProtectCalls() : null;
    try {
      new RoonClient({ tokenPath, logger: stubLogger }).start();
    } finally {
      observed?.restore();
    }
    // Windows: the migrated file was secured while empty and unopenable.
    if (observed) {
      expect(observed.calls.filter((c) => c.target === tokenPath)).toEqual([
        { target: tokenPath, sizeWhenProtected: 0, otherProcessOpen: "EBUSY" },
      ]);
    }

    // Migrated to the configured path…
    expect(fs.existsSync(tokenPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(tokenPath, "utf-8"))).toEqual(persisted);
    // …and removed from cwd so it can't drift back into use.
    expect(fs.existsSync(legacyPath)).toBe(false);
    // …owner-only, like every token write.
    if (process.platform === "win32") {
      const userSid = currentWindowsUserSid();
      expectOwnerOnlyAcl(tokenPath, userSid);
      expectOwnerOnlyAcl(path.dirname(tokenPath), userSid);
    } else {
      expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600);
    }
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

describe("RoonClient — public pairing boundary", () => {
  it("pairs using public Core fields without reading SDK connection internals", async () => {
    const tokenPath = await makeTokenPath();
    try {
      const client = new RoonClient({ tokenPath, logger: stubLogger });
      client.start();
      const browse = {};
      const transport = {};
      const core = {
        core_id: "core-public",
        display_name: "Public Core",
        display_version: "2.0",
        services: { RoonApiBrowse: browse, RoonApiTransport: transport },
      };
      Object.defineProperty(core, "moo", {
        get() { throw new Error("SDK connection internals must not be read"); },
      });

      expect(() => capturedOptions.core_paired(core)).not.toThrow();
      expect(client.getCoreInfo()).toEqual({
        id: "core-public", displayName: "Public Core", displayVersion: "2.0",
      });
      expect(client.getBrowse()).toBe(browse);
      expect(client.getTransport()).toBe(transport);
      capturedOptions.core_unpaired();
      expect(client.getCoreInfo()).toBeNull();
      expect(client.getBrowse()).toBeNull();
    } finally {
      await fsp.rm(path.dirname(tokenPath), { recursive: true, force: true });
    }
  });
});
