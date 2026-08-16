/* eslint-disable @typescript-eslint/no-explicit-any */
import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import path from "path";
import { Logger } from "pino";
import { ROON_EXTENSION_DISPLAY_NAME } from "../../shared/types";

const RoonApi = require("node-roon-api");
const RoonApiTransport = require("node-roon-api-transport");
const RoonApiBrowse = require("node-roon-api-browse");
const RoonApiImage = require("node-roon-api-image");
const SONGR_EVER_PAIRED_KEY = "songr_ever_paired";

export interface RoonClientOptions {
  tokenPath: string;
  logger: Logger;
}

export interface RoonCoreInfo {
  readonly id: string;
  readonly displayName: string;
  readonly displayVersion: string;
}

/**
 * The paired Core's broker address as learned by the extension-API
 * connection (install-finish Slice 1): `host` is the address node-roon-api
 * connected to (SOOD responder IP, loopback-normalized to 127.0.0.1 when
 * the Core shares this host) and `uniqueId` is the registry `core_id`,
 * which is the Core's broker id — the identity the native handshake
 * requires. This is the derivation source for the native client's
 * zero-config connect target.
 */
export interface RoonCoreAddress {
  readonly host: string;
  readonly uniqueId: string;
}

export interface RoonEvents {
  readonly coreStatus: "discovering" | "paired" | "unpaired";
  readonly coreInfo?: RoonCoreInfo;
}

export declare interface RoonClient {
  on(event: "core-status", listener: (event: RoonEvents) => void): this;
  emit(event: "core-status", data: RoonEvents): boolean;
}

export class RoonClient extends EventEmitter {
  private readonly options: RoonClientOptions;
  private roon: any | null = null;
  private apiGeneration = 0;
  private switchPending = false;
  private transport: any | null = null;
  private browse: any | null = null;
  private image: any | null = null;
  private pairedCore: RoonCoreInfo | null = null;
  private pairedCoreAddress: RoonCoreAddress | null = null;
  private coreStatus: "discovering" | "paired" | "unpaired" = "discovering";

  constructor(options: RoonClientOptions) {
    super();
    this.options = options;
  }

  public start(): void {
    // Migrate any pre-existing config.json that earlier builds wrote to
    // the working directory by accident. node-roon-api's default
    // save_config() writes a `config.json` next to the process cwd; we
    // used to provide a no-op `save_config` callback that the library
    // ignores (it only honors set_persisted_state). The accidental file
    // contains the real pairing token, so port it to the configured
    // location and remove the cwd copy.
    this.migrateLegacyConfigJson();

    const generation = this.apiGeneration + 1;
    const roon = this.createApi(generation);
    this.apiGeneration = generation;
    this.roon = roon;
    this.coreStatus = "discovering";
    this.emit("core-status", { coreStatus: "discovering" });
    roon.start_discovery();
  }

  private createApi(generation: number): any {
    const roon = new RoonApi({
      // The product's own vendor id. The historical
      // "com.roonlabs.webcontroller" both squatted Roon Labs' namespace and
      // collided across every install of this codebase's ancestors; Roon
      // treats an id change as a new extension, so upgrading past this
      // commit requires one re-enable in Roon Settings → Extensions.
      extension_id: "app.songr.controller",
      // Base name shared with the UI so the onboarding step can tell the
      // user the exact label to look for in Roon Settings → Extensions; the
      // host name disambiguates multiple instances paired to one Core.
      display_name: `${ROON_EXTENSION_DISPLAY_NAME} (${os.hostname()})`,
      display_version: "1.1.3",
      publisher: "roethlar",
      email: "mcoelho@gmail.com",
      website: "https://github.com/roethlar/songr",
      log_level: this.options.logger.level ?? "info",
      // node-roon-api persists pairing state via these two callbacks
      // (it reads `paired_core_id` + per-core `tokens` to resume
      // pairing across restarts). The earlier `token` + `save_config`
      // options were dead code — the library ignores `token` and only
      // calls its own default save_config (which writes config.json
      // in cwd, NOT at our configured path).
      get_persisted_state: () => this.loadPersistedState(),
      set_persisted_state: (state: unknown) => {
        if (generation !== this.apiGeneration) return;
        this.savePersistedState(state);
      },
      core_paired: (core: any) => {
        if (generation !== this.apiGeneration) return;
        this.onCorePaired(core);
      },
      core_unpaired: () => {
        if (generation !== this.apiGeneration) return;
        this.onCoreUnpaired();
      },
    });

    roon.init_services({
      required_services: [RoonApiTransport, RoonApiBrowse],
      optional_services: [RoonApiImage],
      provided_services: [],
    });
    return roon;
  }

  public getTransport(): any | null {
    return this.transport;
  }

  public getBrowse(): any | null {
    return this.browse;
  }

  public getImage(): any | null {
    return this.image;
  }

  public getCoreInfo(): RoonCoreInfo | null {
    return this.pairedCore;
  }

  /**
   * The paired Core's broker address (see RoonCoreAddress), or null when
   * unpaired or the connection did not report one. Consumed by the native
   * client's deriveTarget hook.
   */
  public getCoreAddress(): RoonCoreAddress | null {
    return this.pairedCoreAddress;
  }

  public getCoreStatus(): "discovering" | "paired" | "unpaired" {
    return this.coreStatus;
  }

  /**
   * Has this install EVER completed pairing with a Roon Core?
   *
   * Distinct from `getCoreStatus()`, which reports the live connection and
   * reads `discovering` both on a brand-new install and on a long-paired
   * one whose Core happens to be off. The durable answer is the persisted
   * pairing identity node-roon-api writes at `tokenPath`: a non-empty
   * `paired_core_id`, or at least one entry in the per-core `tokens` map.
   * An unreadable or absent file answers false, which is the same thing a
   * first run looks like.
   *
   * Read-only, and read on demand rather than cached: the file is written
   * by the library out from under us the moment pairing completes.
   */
  public hasEverPaired(): boolean {
    if (this.coreStatus === "paired") return true;
    const state = this.loadPersistedState();
    if (state[SONGR_EVER_PAIRED_KEY] === true) return true;
    const pairedCoreId = state.paired_core_id;
    if (typeof pairedCoreId === "string" && pairedCoreId.length > 0) {
      return true;
    }
    const tokens = state.tokens;
    if (tokens && typeof tokens === "object" && !Array.isArray(tokens)) {
      return Object.keys(tokens as Record<string, unknown>).length > 0;
    }
    return false;
  }

  /**
   * Forget the currently selected Core and restart discovery with a fresh
   * node-roon-api instance. The library keeps pairing identity and live
   * connections in memory, so editing its persisted state alone is not a
   * switch. Returns false when an earlier confirmed switch is already waiting
   * for authorization; repeated confirmation is deliberately idempotent.
   */
  public switchCore(): boolean {
    if (this.switchPending) return false;
    if (!this.roon) throw new Error("Roon client has not started");

    const persisted = this.loadPersistedState();
    const persistedCoreId = persisted.paired_core_id;
    const currentCoreId =
      this.pairedCore?.id ??
      (typeof persistedCoreId === "string" && persistedCoreId.length > 0
        ? persistedCoreId
        : null);
    const nextPersisted: Record<string, unknown> = {
      ...persisted,
      [SONGR_EVER_PAIRED_KEY]: true,
    };
    delete nextPersisted.paired_core_id;
    if (
      currentCoreId &&
      nextPersisted.tokens &&
      typeof nextPersisted.tokens === "object" &&
      !Array.isArray(nextPersisted.tokens)
    ) {
      const tokens = { ...(nextPersisted.tokens as Record<string, unknown>) };
      delete tokens[currentCoreId];
      nextPersisted.tokens = tokens;
    }

    // Build first: a constructor/init failure must leave the working client
    // and its persisted authorization untouched.
    const nextGeneration = this.apiGeneration + 1;
    const nextRoon = this.createApi(nextGeneration);
    // Strict write before disconnect. Unlike the library callback wrapper,
    // this error must escape so the HTTP request cannot report acceptance.
    this.writePersistedState(nextPersisted);

    const previousRoon = this.roon;
    this.switchPending = true;
    this.apiGeneration = nextGeneration;
    this.clearCoreState("Switching to a different Roon core");

    try {
      previousRoon.stop_discovery?.();
    } catch (error) {
      this.options.logger.warn({ err: error }, "Failed to stop retired Roon discovery");
    }
    try {
      previousRoon.disconnect_all?.();
    } catch (error) {
      this.options.logger.warn({ err: error }, "Failed to disconnect retired Roon sockets");
    }

    this.roon = nextRoon;
    this.coreStatus = "discovering";
    this.emit("core-status", { coreStatus: "discovering" });
    nextRoon.start_discovery();
    return true;
  }

  private onCorePaired(core: any): void {
    this.options.logger.info(
      {
        coreName: core.display_name,
        version: core.display_version,
      },
      "Paired with Roon core"
    );

    this.coreStatus = "paired";
    this.switchPending = false;
    this.pairedCore = {
      id: core.core_id,
      displayName: core.display_name,
      displayVersion: core.display_version,
    };
    // Derivation source for the native zero-config connect target: the
    // address the extension-API websocket is connected to (already
    // loopback-normalized by node-roon-api for same-host Cores) plus the
    // registry core_id, which is the Core's broker id.
    const transportHost = core?.moo?.transport?.host;
    this.pairedCoreAddress =
      typeof transportHost === "string" &&
      transportHost.length > 0 &&
      typeof core?.core_id === "string" &&
      core.core_id.length > 0
        ? { host: transportHost, uniqueId: core.core_id }
        : null;

    this.transport = core.services?.RoonApiTransport ?? null;
    this.browse = core.services?.RoonApiBrowse ?? null;
    this.image = core.services?.RoonApiImage ?? null;

    this.emit("core-status", {
      coreStatus: "paired",
      coreInfo: this.pairedCore,
    });
  }

  private onCoreUnpaired(): void {
    this.clearCoreState("Roon core unpaired");
  }

  private clearCoreState(message: string): void {
    this.options.logger.warn(message);
    this.coreStatus = "unpaired";
    this.transport = null;
    this.browse = null;
    this.image = null;
    this.pairedCore = null;
    this.pairedCoreAddress = null;
    this.emit("core-status", { coreStatus: "unpaired" });
  }

  /**
   * Read the pairing state from `tokenPath`. Returns `{}` (the shape
   * node-roon-api defaults to) on missing file or parse error so the
   * library can proceed to discover/re-pair.
   */
  private loadPersistedState(): Record<string, unknown> {
    try {
      const filePath = path.resolve(this.options.tokenPath);
      if (!fs.existsSync(filePath)) return {};
      const buffer = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(buffer);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      this.options.logger.warn(
        { filePath },
        "Persisted Roon state is not an object; ignoring"
      );
      return {};
    } catch (error) {
      this.options.logger.warn(
        { err: error },
        "Failed to read persisted Roon state"
      );
      return {};
    }
  }

  /**
   * Write the pairing state to `tokenPath`. The file holds Roon's
   * pairing identity (paired_core_id + per-core tokens) — treat as
   * a secret (mode 0o600). Atomic via tmp + rename so a crash
   * mid-write can't leave a torn file.
   */
  private savePersistedState(state: unknown): void {
    try {
      this.writePersistedState(this.withEverPairedMarker(state));
      const filePath = path.resolve(this.options.tokenPath);
      this.options.logger.debug(
        { filePath },
        "Persisted Roon pairing state"
      );
    } catch (error) {
      this.options.logger.error(
        { err: error },
        "Failed to save Roon pairing state"
      );
    }
  }

  private withEverPairedMarker(state: unknown): unknown {
    if (!state || typeof state !== "object" || Array.isArray(state)) return state;
    const record = state as Record<string, unknown>;
    const pairedCoreId = record.paired_core_id;
    const tokens = record.tokens;
    const paired = typeof pairedCoreId === "string" && pairedCoreId.length > 0;
    const hasToken =
      !!tokens &&
      typeof tokens === "object" &&
      !Array.isArray(tokens) &&
      Object.keys(tokens as Record<string, unknown>).length > 0;
    return paired || hasToken ? { ...record, [SONGR_EVER_PAIRED_KEY]: true } : record;
  }

  /** Strict atomic writer used by both the library callback and Core switch. */
  private writePersistedState(state: unknown): void {
    const filePath = path.resolve(this.options.tokenPath);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const tmp = `${filePath}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), {
        encoding: "utf-8",
        mode: 0o600,
      });
      fs.renameSync(tmp, filePath);
    } catch (error) {
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch {
        // Preserve the original persistence failure; cleanup is best effort.
      }
      throw error;
    }
  }

  /**
   * A parsed legacy file must LOOK like node-roon-api persisted state
   * before we touch it: a string `paired_core_id` and/or an object
   * `tokens` map. `config.json` is a generic name — an unrelated
   * app's config sitting in the process cwd must never be copied into
   * the token path, and above all never deleted.
   */
  private static isRoonPersistedStateShape(parsed: Record<string, unknown>): boolean {
    const hasCoreId = typeof parsed.paired_core_id === "string";
    const hasTokens =
      !!parsed.tokens &&
      typeof parsed.tokens === "object" &&
      !Array.isArray(parsed.tokens);
    return hasCoreId || hasTokens;
  }

  /**
   * One-time migration from the cwd `config.json` the library writes
   * by default. If the configured tokenPath is empty AND a
   * `config.json` exists in cwd AND it is shaped like Roon persisted
   * state, copy it over and remove the cwd file so it can't drift
   * back into use. Anything else in cwd is left strictly alone.
   */
  private migrateLegacyConfigJson(): void {
    try {
      const targetPath = path.resolve(this.options.tokenPath);
      if (fs.existsSync(targetPath)) return;
      const legacyPath = path.resolve("config.json");
      if (!fs.existsSync(legacyPath)) return;
      // Read first to validate JSON; don't migrate garbage.
      const raw = fs.readFileSync(legacyPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        this.options.logger.warn(
          { legacyPath },
          "Legacy config.json is not an object; not migrating"
        );
        return;
      }
      if (!RoonClient.isRoonPersistedStateShape(parsed as Record<string, unknown>)) {
        this.options.logger.warn(
          { legacyPath },
          "cwd config.json does not look like Roon persisted state (no paired_core_id/tokens); leaving it untouched"
        );
        return;
      }
      const dir = path.dirname(targetPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      fs.writeFileSync(targetPath, JSON.stringify(parsed, null, 2), {
        encoding: "utf-8",
        mode: 0o600,
      });
      fs.unlinkSync(legacyPath);
      this.options.logger.info(
        { from: legacyPath, to: targetPath },
        "Migrated Roon pairing state from legacy config.json"
      );
    } catch (error) {
      this.options.logger.warn(
        { err: error },
        "Legacy config.json migration skipped"
      );
    }
  }
}
