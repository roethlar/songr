/**
 * Child-process probe for `workspaceFeaturesPresence.test.ts`.
 *
 * Runs OUTSIDE the jest worker for the same reason the library-features
 * probe does (pub-16): loading the real `native/workspaceFeatureLayer`
 * inside the worker would poison the sibling absence suite's virtual mocks.
 *
 * The absent and installed layers are deliberately behavior-identical in
 * Slice 1 (both attach nothing yet), so the probe distinguishes them by the
 * loader's own reporting: absence logs the absent reason, a fault logs an
 * error, and a real load does neither.
 *
 * Prints one JSON line: { "absentLogged": bool, "errorLogged": bool }.
 */
import type { Logger } from "pino";

import {
  loadWorkspaceFeatureLayer,
  WORKSPACE_FEATURES_ABSENT_REASON,
  type WorkspaceFeatureHost,
} from "../workspaceFeatures";

let absentLogged = false;
let errorLogged = false;

const logger = {
  info: (first: unknown) => {
    if (
      typeof first === "object" &&
      first !== null &&
      (first as { reason?: unknown }).reason === WORKSPACE_FEATURES_ABSENT_REASON
    ) {
      absentLogged = true;
    }
  },
  warn: () => undefined,
  error: () => {
    errorLogged = true;
  },
  debug: () => undefined,
  trace: () => undefined,
  level: "info",
} as unknown as Logger;

const host: WorkspaceFeatureHost = {
  logger,
  getCoreId: () => null,
  getCoreAddress: () => null,
  getZones: () => [],
  onZonesChanged: () => () => {},
  onCoreChanged: () => () => {},
};

loadWorkspaceFeatureLayer(host);
process.stdout.write(`${JSON.stringify({ absentLogged, errorLogged })}\n`);
