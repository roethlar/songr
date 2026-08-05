/**
 * Child-process probe for `libraryFeaturesPresence.test.ts` (pub-16).
 *
 * This runs OUTSIDE the jest worker on purpose: loading the real
 * `native/libraryFeatureLayer` inside the worker poisons the sibling absence
 * suite — once the real module resolves in the shared process, that suite's
 * virtual mocks stop intercepting and it goes red (the reopened verdict of
 * the 2026-08-05 review). In its own process the real module is free to be
 * real.
 *
 * Prints one JSON line: { "reason": <capability reason of the loaded layer> }.
 */
import fs from "fs";
import os from "os";
import path from "path";

import type { Logger } from "pino";

import { loadLibraryFeatureLayer, type LibraryFeatureHost } from "../libraryFeatures";

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
  level: "info",
} as unknown as Logger;

const host: LibraryFeatureHost = {
  config: {
    catalogPath: fs.mkdtempSync(path.join(os.tmpdir(), "pub16-probe-catalog-")),
  } as LibraryFeatureHost["config"],
  logger,
  catalog: {} as LibraryFeatureHost["catalog"],
  selectionRegistry: {} as LibraryFeatureHost["selectionRegistry"],
  getCoreAddress: () => null,
  runCatalogBrowse: () => {
    throw new Error("no browse lease is expected in this probe");
  },
};

async function main(): Promise<void> {
  const layer = loadLibraryFeatureLayer(host);
  const capability = await layer.catalog.getCapability("core-presence");
  process.stdout.write(`${JSON.stringify({ reason: capability.reason })}\n`);
}

void main();
