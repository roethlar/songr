/**
 * The single interface between this application and its optional workspace
 * feature layer — private, output-scoped workspaces the public product does
 * not carry.
 *
 * The public interface is deliberately limited to lifecycle mechanics: attach
 * optional handlers to one connected socket, retire everything a departed
 * socket owned, and shut every workspace session down with the server.
 * Everything a workspace actually is — its events, contracts, validation,
 * and behavior — lives behind the wall; nothing here names any of it.
 *
 * Absence mechanics mirror `libraryFeatures.ts`: the implementation loads
 * once at wiring time through a runtime-assembled specifier the type-checker
 * never resolves, so a build without the implementation directory still
 * compiles. A load failure is never fatal — `loadWorkspaceFeatureLayer`
 * always returns a layer, and the absent layer attaches nothing, which is
 * exactly how an absent workspace should reach a client: not there, never
 * broken.
 */

import type { Logger } from "pino";
import type { Socket } from "socket.io";

import type { RoonCoreAddress } from "../core/roon/RoonClient";

/** A read-only summary of one public zone and its outputs. */
export interface WorkspaceZoneSummary {
  readonly zoneId: string;
  readonly name: string;
  readonly outputs: readonly { readonly outputId: string; readonly name: string }[];
}

export interface WorkspaceFeatureLayer {
  /** Attach this build's optional workspace handlers to one socket. */
  attachSocket(socket: Socket): void;
  /** Retire every workspace resource owned by one departed socket. */
  retireSocket(socketId: string): void;
  /** Close every workspace session; called once during server shutdown. */
  shutdown(): Promise<void>;
}

export interface WorkspaceFeatureHost {
  readonly logger: Logger;
  /** The paired Core's identity, when one is paired. */
  readonly getCoreId: () => string | null;
  /** The paired Core's address, when one is paired. */
  readonly getCoreAddress: () => RoonCoreAddress | null;
  /** Read-only lookup of the current public zones and outputs. */
  readonly getZones: () => readonly WorkspaceZoneSummary[];
  /**
   * Subscribe to public zone/output topology changes; returns the
   * unsubscribe. Listeners re-read `getZones` — the event carries nothing.
   */
  readonly onZonesChanged: (listener: () => void) => () => void;
  /** Subscribe to paired-Core identity changes; returns the unsubscribe. */
  readonly onCoreChanged: (listener: () => void) => () => void;
}

/** The layer's entry point: one factory, taking the host, returning the layer. */
export type WorkspaceFeatureLayerFactory = (
  host: WorkspaceFeatureHost
) => WorkspaceFeatureLayer;

/** Reason logged when this build does not carry the workspace layer at all. */
export const WORKSPACE_FEATURES_ABSENT_REASON =
  "the workspace features are not part of this build";

/** Reason logged when the layer is present but could not be started. */
export const WORKSPACE_FEATURES_UNUSABLE_REASON =
  "the workspace features are installed but could not be started";

/** The layer that attaches nothing: the honest answer for an absent build. */
export function absentWorkspaceFeatureLayer(): WorkspaceFeatureLayer {
  return {
    attachSocket: () => {},
    retireSocket: () => {},
    shutdown: async () => {},
  };
}

const IMPLEMENTATION_DIRECTORY = "native";
const IMPLEMENTATION_ENTRY = "workspaceFeatureLayer";
const IMPLEMENTATION_FACTORY = "createWorkspaceFeatureLayer";

/** True when the failure is "there is no such module", not a fault inside it. */
function isModuleAbsence(error: unknown, specifier: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (code !== "MODULE_NOT_FOUND" && code !== "ERR_MODULE_NOT_FOUND") {
    return false;
  }
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && message.includes(specifier);
}

function readFactory(loaded: unknown): WorkspaceFeatureLayerFactory | null {
  if (typeof loaded !== "object" || loaded === null) return null;
  const candidate = (loaded as Record<string, unknown>)[IMPLEMENTATION_FACTORY];
  return typeof candidate === "function"
    ? (candidate as WorkspaceFeatureLayerFactory)
    : null;
}

/** Narrows the produced layer to the members host code relies on always having. */
function isUsableLayer(layer: unknown): layer is WorkspaceFeatureLayer {
  if (typeof layer !== "object" || layer === null) return false;
  const candidate = layer as Partial<WorkspaceFeatureLayer>;
  return (
    typeof candidate.attachSocket === "function" &&
    typeof candidate.retireSocket === "function" &&
    typeof candidate.shutdown === "function"
  );
}

/**
 * Loads the workspace layer, or returns the layer that attaches nothing.
 * Never throws and never rejects: a missing implementation is a normal
 * outcome, and a present-but-broken one is logged and treated as absent,
 * because a half-wired workspace is worse than none.
 */
export function loadWorkspaceFeatureLayer(
  host: WorkspaceFeatureHost
): WorkspaceFeatureLayer {
  const specifier = `./${IMPLEMENTATION_DIRECTORY}/${IMPLEMENTATION_ENTRY}`;
  let loaded: unknown;
  try {
    loaded = require(specifier);
  } catch (error) {
    if (isModuleAbsence(error, specifier)) {
      host.logger.info(
        { reason: WORKSPACE_FEATURES_ABSENT_REASON },
        "Workspace features are not installed; serving without them"
      );
      return absentWorkspaceFeatureLayer();
    }
    host.logger.error(
      { err: error },
      "Workspace features failed to load; serving without them"
    );
    return absentWorkspaceFeatureLayer();
  }

  const factory = readFactory(loaded);
  if (!factory) {
    host.logger.error(
      { specifier },
      "Workspace features did not expose their entry point; serving without them"
    );
    return absentWorkspaceFeatureLayer();
  }

  let layer: unknown;
  try {
    layer = factory(host);
  } catch (error) {
    host.logger.error(
      { err: error },
      "Workspace features failed to start; serving without them"
    );
    return absentWorkspaceFeatureLayer();
  }
  if (!isUsableLayer(layer)) {
    host.logger.error(
      { specifier },
      "Workspace features produced an unusable layer; serving without them"
    );
    return absentWorkspaceFeatureLayer();
  }
  return layer;
}
