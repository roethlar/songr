import path from "path";

import {
  BROWSE_CANARY_LATENCY_MULTIPLE,
} from "../../core/roon/BrowseCanaryService";
import { DEFAULT_ROON_CALL_TIMEOUT_MS } from "../../core/roon/timeout";
import {
  ConfigError,
  DEFAULT_BROWSE_CANARY_BASELINE_P95_MS,
  loadConfig,
} from "../env";

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
    expect(config.navigationSettingsPath).toBe(path.resolve("./data/navigation-preferences.json"));
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
    expect(config.navigationSettingsPath).toBe(path.join("/tmp/songr-test/data", "navigation-preferences.json"));
  });

  it("leaves CONFIG_DIR and DATA_DIR independent of each other", () => {
    process.env.CONFIG_DIR = "/tmp/songr-test/config";
    const config = loadConfig();

    expect(config.roonTokenPath).toBe(
      path.join("/tmp/songr-test/config", "roon-token.json")
    );
    expect(config.favoritesPath).toBe(path.resolve("./data/favorites.json"));
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
    expect(config.navigationSettingsPath).toBe(path.join("/tmp/songr-test/data", "navigation-preferences.json"));
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

/**
 * The post-connect load trial's canary switches
 * (`.agents/plans/core-wedge-postconnect.md` §A0/§A3). The canary is real
 * traffic against the Core, so the default must be off; and a switch that
 * read `=0` as on would silently invert what a trial cell was set up to
 * measure, which is why an unrecognized value is refused rather than guessed.
 */
describe("browse canary configuration", () => {
  const env = withEnv([
    "ROON_BROWSE_CANARY",
    "ROON_BROWSE_CANARY_BASELINE_P95_MS",
  ]);

  beforeEach(() => {
    env.save();
    env.clear();
  });

  afterEach(env.restore);

  it("runs the canary on a stock install, against the shipped reference", () => {
    // A build that shipped the canary off shipped a sweep governor that could
    // never freeze a baseline, and so could never ramp past one. The stock
    // install has to reach the full ramp with nothing configured.
    const config = loadConfig();
    expect(config.browseCanaryEnabled).toBe(true);
    expect(config.browseCanaryBaselineP95Ms).toBe(
      DEFAULT_BROWSE_CANARY_BASELINE_P95_MS
    );
  });

  it("draws the shipped line well clear of a healthy Core and well inside a wedge", () => {
    // Every rule fires at 3x the reference, so this is the number that
    // matters. It has to sit far above a slow-but-healthy root browse and far
    // below the 15 s call budget, or it is either a nuisance or a decoration.
    const thresholdMs =
      DEFAULT_BROWSE_CANARY_BASELINE_P95_MS * BROWSE_CANARY_LATENCY_MULTIPLE;
    expect(thresholdMs).toBeGreaterThanOrEqual(1_000);
    expect(thresholdMs).toBeLessThan(DEFAULT_ROON_CALL_TIMEOUT_MS);
    // The observed wedge precursor included a 3.4 s stall.
    expect(thresholdMs).toBeLessThan(3_400);
  });

  it.each(["1", "true", "yes", "on", "ON", " true "])(
    "switches the canary on for %j",
    (value) => {
      process.env.ROON_BROWSE_CANARY = value;
      expect(loadConfig().browseCanaryEnabled).toBe(true);
    }
  );

  it.each(["0", "false", "no", "off"])(
    "takes %j as the emergency valve",
    (value) => {
      process.env.ROON_BROWSE_CANARY = value;
      expect(loadConfig().browseCanaryEnabled).toBe(false);
    }
  );

  it("reads an empty value as unset rather than as off", () => {
    // A commented-out line in a deployed .env leaves the variable set to the
    // empty string. That is nobody having configured it, not somebody having
    // turned it off.
    process.env.ROON_BROWSE_CANARY = "";
    expect(loadConfig().browseCanaryEnabled).toBe(true);
  });

  it("refuses a value it cannot read as on or off", () => {
    process.env.ROON_BROWSE_CANARY = "maybe";
    expect(() => loadConfig()).toThrow(/ROON_BROWSE_CANARY/u);
  });

  it("carries a configured baseline p95", () => {
    process.env.ROON_BROWSE_CANARY_BASELINE_P95_MS = "420";
    expect(loadConfig().browseCanaryBaselineP95Ms).toBe(420);
  });

  it.each(["0", "-1", "abc"])("refuses the baseline %j", (value) => {
    process.env.ROON_BROWSE_CANARY_BASELINE_P95_MS = value;
    expect(() => loadConfig()).toThrow(/ROON_BROWSE_CANARY_BASELINE_P95_MS/u);
  });
});
