import path from "path";

import { loadConfig } from "../env";

describe("Timeline catalog configuration", () => {
  const original = process.env.TIMELINE_CATALOG_PATH;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.TIMELINE_CATALOG_PATH;
    } else {
      process.env.TIMELINE_CATALOG_PATH = original;
    }
  });

  it("defaults to a controller-local catalog directory", () => {
    delete process.env.TIMELINE_CATALOG_PATH;
    expect(loadConfig().catalogPath).toBe(path.resolve("./data/catalog"));
  });

  it("resolves an explicit catalog directory", () => {
    process.env.TIMELINE_CATALOG_PATH = "./var/timeline-catalog";
    expect(loadConfig().catalogPath).toBe(
      path.resolve("./var/timeline-catalog")
    );
  });
});
