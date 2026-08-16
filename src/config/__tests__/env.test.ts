import path from "path";

import { ConfigError, loadConfig } from "../env";

/**
 * Snapshot/restore for the variables a test mutates. Jest runs the backend
 * suite in-band, so leaking an env var would contaminate later files.
 */
const withEnv = (names: string[]) => {
  const originals = new Map<string, string | undefined>();

  const save = () => {
    for (const name of names) {
      originals.set(name, process.env[name]);
    }
  };

  const restore = () => {
    for (const name of names) {
      const value = originals.get(name);
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  };

  const clear = () => {
    for (const name of names) {
      delete process.env[name];
    }
  };

  return { save, restore, clear };
};

describe("Catalog path configuration", () => {
  const env = withEnv(["CATALOG_PATH", "TIMELINE_CATALOG_PATH"]);

  beforeEach(() => {
    env.save();
    env.clear();
  });

  afterEach(env.restore);

  it("defaults to a controller-local catalog directory", () => {
    expect(loadConfig().catalogPath).toBe(path.resolve("./data/catalog"));
  });

  it("resolves an explicit catalog directory", () => {
    process.env.CATALOG_PATH = "./var/catalog";
    expect(loadConfig().catalogPath).toBe(path.resolve("./var/catalog"));
  });

  it("honors the legacy TIMELINE_CATALOG_PATH key from pre-removal deployments", () => {
    process.env.TIMELINE_CATALOG_PATH = "./var/legacy-catalog";
    expect(loadConfig().catalogPath).toBe(path.resolve("./var/legacy-catalog"));
  });

  it("prefers CATALOG_PATH when both keys are set", () => {
    process.env.CATALOG_PATH = "./var/catalog";
    process.env.TIMELINE_CATALOG_PATH = "./var/legacy-catalog";
    expect(loadConfig().catalogPath).toBe(path.resolve("./var/catalog"));
  });
});

describe("Port resolution", () => {
  const env = withEnv(["PORT"]);

  beforeEach(() => {
    env.save();
    env.clear();
  });

  afterEach(env.restore);

  it("defaults to the appliance port when PORT is unset", () => {
    expect(loadConfig().port).toBe(3333);
  });

  it("defaults to the appliance port when PORT is blank", () => {
    process.env.PORT = "   ";
    expect(loadConfig().port).toBe(3333);
  });

  it("accepts an explicit port", () => {
    process.env.PORT = "8080";
    expect(loadConfig().port).toBe(8080);
  });

  it("accepts PORT=0 for an OS-assigned ephemeral port", () => {
    process.env.PORT = "0";
    expect(loadConfig().port).toBe(0);
  });

  it("rejects a negative port", () => {
    process.env.PORT = "-1";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  it("rejects a port above the TCP range", () => {
    process.env.PORT = "65536";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  it("rejects a non-integer port", () => {
    process.env.PORT = "3333.5";
    expect(() => loadConfig()).toThrow(ConfigError);
  });
});

describe("Host resolution", () => {
  const env = withEnv(["HOST"]);

  beforeEach(() => {
    env.save();
    env.clear();
  });

  afterEach(env.restore);

  it("defaults to the appliance LAN bind", () => {
    expect(loadConfig().host).toBe("0.0.0.0");
  });

  it("accepts an explicit loopback bind", () => {
    process.env.HOST = "127.0.0.1";
    expect(loadConfig().host).toBe("127.0.0.1");
  });
});

describe("Config and data base directories", () => {
  const env = withEnv([
    "CONFIG_DIR",
    "DATA_DIR",
    "ROON_TOKEN_PATH",
    "IMAGE_CACHE_PATH",
    "RECENTLY_PLAYED_PATH",
    "FAVORITES_PATH",
    "CATALOG_PATH",
    "TIMELINE_CATALOG_PATH",
  ]);

  beforeEach(() => {
    env.save();
    env.clear();
  });

  afterEach(env.restore);

  it("keeps the historical appliance layout when both base dirs are unset", () => {
    const config = loadConfig();

    expect(config.roonTokenPath).toBe(path.resolve("./config/roon-token.json"));
    expect(config.imageCachePath).toBe(path.resolve("./data/image-cache"));
    expect(config.recentlyPlayedPath).toBe(
      path.resolve("./data/recently-played.json")
    );
    expect(config.favoritesPath).toBe(path.resolve("./data/favorites.json"));
    expect(config.catalogPath).toBe(path.resolve("./data/catalog"));
  });

  it("relocates the pairing token with CONFIG_DIR", () => {
    process.env.CONFIG_DIR = "/tmp/songr-test/config";

    expect(loadConfig().roonTokenPath).toBe(
      path.join("/tmp/songr-test/config", "roon-token.json")
    );
  });

  it("relocates every data file with DATA_DIR", () => {
    process.env.DATA_DIR = "/tmp/songr-test/data";
    const config = loadConfig();

    expect(config.imageCachePath).toBe(
      path.join("/tmp/songr-test/data", "image-cache")
    );
    expect(config.recentlyPlayedPath).toBe(
      path.join("/tmp/songr-test/data", "recently-played.json")
    );
    expect(config.favoritesPath).toBe(
      path.join("/tmp/songr-test/data", "favorites.json")
    );
    expect(config.catalogPath).toBe(path.join("/tmp/songr-test/data", "catalog"));
  });

  it("leaves CONFIG_DIR and DATA_DIR independent of each other", () => {
    process.env.CONFIG_DIR = "/tmp/songr-test/config";
    const config = loadConfig();

    expect(config.roonTokenPath).toBe(
      path.join("/tmp/songr-test/config", "roon-token.json")
    );
    expect(config.catalogPath).toBe(path.resolve("./data/catalog"));
  });

  it("resolves a relative base dir against the working directory", () => {
    process.env.DATA_DIR = "./var/songr";

    expect(loadConfig().favoritesPath).toBe(
      path.join(path.resolve("./var/songr"), "favorites.json")
    );
  });

  it("lets a per-file variable override its base dir", () => {
    process.env.CONFIG_DIR = "/tmp/songr-test/config";
    process.env.DATA_DIR = "/tmp/songr-test/data";
    process.env.ROON_TOKEN_PATH = "/tmp/songr-test/elsewhere/token.json";
    process.env.FAVORITES_PATH = "/tmp/songr-test/elsewhere/favorites.json";

    const config = loadConfig();

    expect(config.roonTokenPath).toBe("/tmp/songr-test/elsewhere/token.json");
    expect(config.favoritesPath).toBe(
      "/tmp/songr-test/elsewhere/favorites.json"
    );
    // Unoverridden entries still follow the base dir.
    expect(config.catalogPath).toBe(path.join("/tmp/songr-test/data", "catalog"));
  });

  it("rejects a blank-but-present base dir the same way as other paths", () => {
    process.env.CONFIG_DIR = "   ";
    // A whitespace-only value is treated as unset, matching every other
    // path variable in this module.
    expect(loadConfig().roonTokenPath).toBe(
      path.resolve("./config/roon-token.json")
    );
  });
});
