/**
 * Positive control for the extended-features absence mechanism (pub-16).
 *
 * The sibling suite (`libraryFeatures.test.ts`) proves a build WITHOUT the
 * implementation still answers — but every case there mocks the
 * implementation virtually, so nothing in it proves the loader is still
 * attached to the real module: rename the file, the directory, or the
 * exported factory and that suite stays green while the private build
 * silently serves "features absent" for every extended feature. This suite
 * is the missing direction: while the implementation exists on disk, the
 * loader must return a real layer, not the unavailable one.
 *
 * Two deliberate constraints:
 *
 * - Conditioned on disk existence — the same decision the UI side already
 *   makes in `ui/src/lib/libraryFeatures/resolveScopeSlots.js` — so it
 *   SKIPS, never fails, in a build that ships no implementation (the public
 *   export tree, or a walled-root deletion proof).
 * - Run in a CHILD PROCESS (the probe beside this file). Loading the real
 *   `native/libraryFeatureLayer` inside the jest worker poisons the sibling
 *   absence suite: once the real module resolves in the shared process,
 *   that suite's virtual mocks stop intercepting and 6 of its 10 cases fail
 *   when jest schedules this file first (the reopened verdict of the
 *   2026-08-05 review, reproduced deterministically with a presence-first
 *   sequencer). The real module must never load in this worker.
 */
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

import {
  LIBRARY_FEATURES_ABSENT_REASON,
  LIBRARY_FEATURES_UNUSABLE_REASON,
} from "../libraryFeatures";

const IMPLEMENTATION = path.join(__dirname, "..", "native", "libraryFeatureLayer.ts");
const IMPLEMENTATION_PRESENT = fs.existsSync(IMPLEMENTATION);

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const TS_NODE = path.join(REPO_ROOT, "node_modules", ".bin", "ts-node");
const PROBE = path.join(__dirname, "libraryFeaturesPresenceProbe.ts");

(IMPLEMENTATION_PRESENT ? describe : describe.skip)(
  "the absence mechanism's positive control (pub-16)",
  () => {
    it("the loader returns a real layer, not the unavailable one", () => {
      const output = execFileSync(TS_NODE, ["--transpile-only", PROBE], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        timeout: 120000,
      });
      const { reason } = JSON.parse(output.trim().split("\n").pop() ?? "") as {
        reason: string;
      };

      expect(reason).not.toBe(LIBRARY_FEATURES_ABSENT_REASON);
      expect(reason).not.toBe(LIBRARY_FEATURES_UNUSABLE_REASON);
    }, 150000);
  }
);
