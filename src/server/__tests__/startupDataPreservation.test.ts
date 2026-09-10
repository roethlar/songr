import fs from "fs";
import os from "os";
import path from "path";
import type { Logger } from "pino";

import { loadConfig } from "../../config/env";
import { startServer } from "../server";

// Stop before constructing any service, binding a port or connecting to a Core.
// The retired cleanup used to run before this first construction boundary.
jest.mock("../../core/roon/RoonClient", () => ({
  RoonClient: jest.fn(() => {
    throw new Error("startup stopped before Roon services");
  }),
}));

const ENV_KEYS = ["CATALOG_PATH", "TIMELINE_CATALOG_PATH", "DATA_DIR", "CONFIG_DIR"];

describe("startup preserves user data named by retired catalog settings", () => {
  let directory: string;
  let originalEnv: Map<string, string | undefined>;

  beforeEach(() => {
    originalEnv = new Map(ENV_KEYS.map((name) => [name, process.env[name]]));
    for (const name of ENV_KEYS) delete process.env[name];
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "songr-startup-preservation-"));
    process.env.DATA_DIR = path.join(directory, "data");
    process.env.CONFIG_DIR = path.join(directory, "config");
    fs.mkdirSync(process.env.DATA_DIR);
    fs.writeFileSync(path.join(process.env.DATA_DIR, "favorites.json"), "favorite sentinel\n");
    fs.writeFileSync(path.join(process.env.DATA_DIR, "navigation-settings.json"), "navigation sentinel\n");
  });

  afterEach(() => {
    for (const [name, value] of originalEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    // Only the directory created by this test is ever removed.
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it.each(["CATALOG_PATH", "TIMELINE_CATALOG_PATH"])("ignores obsolete %s during startup", (name) => {
    process.env[name] = process.env.DATA_DIR;
    const config = loadConfig();
    const logger = { info: jest.fn(), warn: jest.fn() } as unknown as Logger;

    expect(() => startServer(config, logger)).toThrow("startup stopped before Roon services");

    const favorites = path.join(directory, "data", "favorites.json");
    const navigation = path.join(directory, "data", "navigation-settings.json");
    expect(fs.existsSync(favorites)).toBe(true);
    expect(fs.readFileSync(favorites, "utf-8")).toBe("favorite sentinel\n");
    expect(fs.readFileSync(navigation, "utf-8")).toBe("navigation sentinel\n");
  });
});
