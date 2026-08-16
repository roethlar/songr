/**
 * Positive control for the workspace-features absence mechanism,
 * mirroring the library-features control (pub-16): the sibling
 * suite proves a build WITHOUT the implementation still answers, but only
 * against virtual mocks. This suite proves the loader is still attached to
 * the real module while it exists on disk — rename the file or the exported
 * factory and this bites while the mocked suite stays green.
 *
 * Same two constraints as the precedent: conditioned on disk existence (so
 * it SKIPS in a build that ships no implementation), and run in a CHILD
 * PROCESS so the real module never resolves inside the jest worker where it
 * would poison the sibling suite's virtual mocks.
 */
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

const IMPLEMENTATION = path.join(
  __dirname,
  "..",
  "native",
  "workspaceFeatureLayer.ts"
);
const IMPLEMENTATION_PRESENT = fs.existsSync(IMPLEMENTATION);

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const TS_NODE = path.join(REPO_ROOT, "node_modules", ".bin", "ts-node");
const PROBE = path.join(__dirname, "workspaceFeaturesPresenceProbe.ts");

(IMPLEMENTATION_PRESENT ? describe : describe.skip)(
  "the workspace absence mechanism's positive control",
  () => {
    it("the loader loads the real layer without reporting absence or a fault", () => {
      const output = execFileSync(TS_NODE, ["--transpile-only", PROBE], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        timeout: 120000,
      });
      const { absentLogged, errorLogged } = JSON.parse(
        output.trim().split("\n").pop() ?? ""
      ) as { absentLogged: boolean; errorLogged: boolean };

      expect(absentLogged).toBe(false);
      expect(errorLogged).toBe(false);
    }, 150000);
  }
);
