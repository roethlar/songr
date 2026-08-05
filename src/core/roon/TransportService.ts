/* eslint-disable @typescript-eslint/no-explicit-any */
import { EventEmitter } from "events";
import { Logger } from "pino";
import { RoonClient } from "./RoonClient";
import {
  Zone,
  NowPlaying,
  PlaybackState,
  VolumeSettings,
  QueueItem,
  ZoneQueue,
  ZonePlaybackSettingsRequest,
} from "../../shared/types";
import { CoreUnpairedError, RoonOperationError } from "./errors";
import { withRoonTimeout } from "./timeout";

/**
 * Transport service event payloads
 */
export interface ZoneUpdatedEvent {
  zone: Zone;
}

export interface NowPlayingUpdatedEvent {
  zone_id: string;
  now_playing: NowPlaying;
}

export interface ZoneRemovedEvent {
  zone_id: string;
}

export interface QueueUpdatedEvent {
  queue: ZoneQueue;
}

export interface SeekChangedEvent {
  zone_id: string;
  seek_position: number;
}

/**
 * TransportService event declarations for TypeScript
 */
export declare interface TransportService {
  on(event: "zone-updated", listener: (data: ZoneUpdatedEvent) => void): this;
  on(
    event: "now-playing-updated",
    listener: (data: NowPlayingUpdatedEvent) => void
  ): this;
  on(event: "zone-removed", listener: (data: ZoneRemovedEvent) => void): this;
  on(event: "queue-updated", listener: (data: QueueUpdatedEvent) => void): this;
  on(event: "seek-changed", listener: (data: SeekChangedEvent) => void): this;
  emit(event: "zone-updated", data: ZoneUpdatedEvent): boolean;
  emit(event: "now-playing-updated", data: NowPlayingUpdatedEvent): boolean;
  emit(event: "zone-removed", data: ZoneRemovedEvent): boolean;
  emit(event: "queue-updated", data: QueueUpdatedEvent): boolean;
  emit(event: "seek-changed", data: SeekChangedEvent): boolean;
}

/**
 * Transport Service Wrapper
 *
 * Provides high-level control over Roon playback and zone management.
 * Wraps the RoonApiTransport service with typed interfaces and event emission.
 *
 * Events:
 * - zone-updated: Emitted when zone state changes
 * - now-playing-updated: Emitted when track/playback changes
 */
export class TransportService extends EventEmitter {
  private static readonly MIN_QUEUE_SUBSCRIPTION_ITEMS = 5000;
  private static readonly QUEUE_SUBSCRIPTION_HEADROOM = 32;
  /**
   * Upper bound on `max_item_count` for queue subscriptions. Exposed
   * publicly so REST/socket route validators can reject oversized
   * requests with a clear error rather than silently clamping. The
   * cap also lives inside `resolveQueueSubscriptionSize` as defense
   * in depth — even a bypassed validator can't push a 1B-item
   * subscription through to Roon.
   *
   * Sized as 10× the MIN floor. Real-world queues rarely top a few
   * thousand; 50k headroom covers extreme playlists without exposing
   * us to a malicious or buggy client requesting Number.MAX_SAFE_INTEGER.
   */
  public static readonly MAX_QUEUE_SUBSCRIPTION_ITEMS = 50_000;

  private transport: any | null = null;
  private subscriptions: Map<string, Zone> = new Map();
  private nowPlayingByZone: Map<string, NowPlaying> = new Map();
  private queueByZone: Map<string, ZoneQueue> = new Map();
  private queueSubscriptions: Map<
    string,
    {
      max_item_count: number;
      unsubscribe?: (cb?: (error?: unknown) => void) => void;
    }
  > = new Map();

  constructor(
    private roonClient: RoonClient,
    private logger: Logger
  ) {
    super();
  }

  /**
   * Initialize transport service and subscribe to zone updates
   */
  public start(): void {
    this.transport = this.roonClient.getTransport();

    if (!this.transport) {
      this.logger.warn("Transport service not available yet, will retry on core pairing");
      return;
    }

    this.logger.info("TransportService started");
  }

  /**
   * Wrap a Roon control callback in a promise with a timeout, so a
   * stalled Core rejects the command instead of hanging it forever.
   */
  private roonCall(
    operation: string,
    executor: (resolve: () => void, reject: (error: Error) => void) => void
  ): Promise<void> {
    return withRoonTimeout(operation, new Promise<void>(executor));
  }

  /**
   * Play or pause playback in a zone
   */
  public async playPause(zone_id: string): Promise<void> {
    this.ensureTransport();

    return this.roonCall("playPause", (resolve, reject) => {
      this.transport.control(zone_id, "playpause", (error: any) => {
        if (error) {
          this.logger.error({ err: error, zone_id }, "playPause failed");
          reject(new RoonOperationError("playPause", error, { zone_id }));
        } else {
          this.logger.debug({ zone_id }, "playPause succeeded");
          resolve();
        }
      });
    });
  }

  /**
   * Skip to next track
   */
  public async next(zone_id: string): Promise<void> {
    this.ensureTransport();

    return this.roonCall("next", (resolve, reject) => {
      this.transport.control(zone_id, "next", (error: any) => {
        if (error) {
          this.logger.error({ err: error, zone_id }, "next failed");
          reject(new RoonOperationError("next", error, { zone_id }));
        } else {
          this.logger.debug({ zone_id }, "next succeeded");
          resolve();
        }
      });
    });
  }

  /**
   * Skip to previous track
   */
  public async previous(zone_id: string): Promise<void> {
    this.ensureTransport();

    return this.roonCall("previous", (resolve, reject) => {
      this.transport.control(zone_id, "previous", (error: any) => {
        if (error) {
          this.logger.error({ err: error, zone_id }, "previous failed");
          reject(new RoonOperationError("previous", error, { zone_id }));
        } else {
          this.logger.debug({ zone_id }, "previous succeeded");
          resolve();
        }
      });
    });
  }

  /**
   * Stop playback
   */
  public async stop(zone_id: string): Promise<void> {
    this.ensureTransport();

    return this.roonCall("stop", (resolve, reject) => {
      this.transport.control(zone_id, "stop", (error: any) => {
        if (error) {
          this.logger.error({ err: error, zone_id }, "stop failed");
          reject(new RoonOperationError("stop", error, { zone_id }));
        } else {
          this.logger.debug({ zone_id }, "stop succeeded");
          resolve();
        }
      });
    });
  }

  /**
   * Change volume for an output.
   *
   * For type="number" / "db" outputs, `value` is an absolute volume in the
   * output's native scale (from VolumeSettings.min to max).
   * For type="incremental" outputs, `value` is a step delta (typically ±1)
   * and is sent in Roon's `relative` mode since incremental controls have
   * no readable level.
   *
   * @param output_id - The output identifier
   * @param value - Absolute target (number/db) or step delta (incremental)
   */
  public async setVolume(output_id: string, value: number): Promise<void> {
    this.ensureTransport();

    const mode = this.resolveVolumeMode(output_id);

    return this.roonCall("setVolume", (resolve, reject) => {
      this.transport.change_volume(output_id, mode, value, (error: any) => {
        if (error) {
          this.logger.error({ err: error, output_id, value, mode }, "setVolume failed");
          reject(new RoonOperationError("setVolume", error, { output_id, value, mode }));
        } else {
          this.logger.debug({ output_id, value, mode }, "setVolume succeeded");
          resolve();
        }
      });
    });
  }

  /**
   * Look up the volume mode appropriate for an output. Defaults to "absolute"
   * when the output is unknown so legacy callers keep working.
   */
  private resolveVolumeMode(output_id: string): "absolute" | "relative" {
    for (const zone of this.subscriptions.values()) {
      const output = zone.outputs?.find((o) => o.output_id === output_id);
      if (output?.volume?.type === "incremental") {
        return "relative";
      }
      if (output) {
        return "absolute";
      }
    }
    return "absolute";
  }

  /**
   * Seek to position in current track
   * @param zone_id - Zone identifier
   * @param seconds - Position in seconds
   */
  public async seek(zone_id: string, seconds: number): Promise<void> {
    this.ensureTransport();

    return this.roonCall("seek", (resolve, reject) => {
      this.transport.seek(zone_id, "absolute", seconds, (error: any) => {
        if (error) {
          this.logger.error({ err: error, zone_id, seconds }, "seek failed");
          reject(new RoonOperationError("seek", error, { zone_id, seconds }));
        } else {
          this.logger.debug({ zone_id, seconds }, "seek succeeded");
          resolve();
        }
      });
    });
  }

  /**
   * Update zone playback settings (shuffle / loop / auto radio).
   */
  public async setPlaybackSettings(
    zone_id: string,
    settings: Omit<ZonePlaybackSettingsRequest, "zone_id">
  ): Promise<void> {
    this.ensureTransport();

    return this.roonCall("setPlaybackSettings", (resolve, reject) => {
      const request: Record<string, unknown> = {};

      if (typeof settings.shuffle === "boolean") {
        request.shuffle = settings.shuffle;
      }
      if (typeof settings.auto_radio === "boolean") {
        request.auto_radio = settings.auto_radio;
      }
      if (settings.loop) {
        request.loop = settings.loop;
      }

      this.transport.change_settings(zone_id, request, (error: any) => {
        if (error) {
          this.logger.error({ err: error, zone_id, settings }, "setPlaybackSettings failed");
          reject(new RoonOperationError("setPlaybackSettings", error, { zone_id, settings }));
        } else {
          this.logger.debug({ zone_id, settings }, "setPlaybackSettings succeeded");
          resolve();
        }
      });
    });
  }

  /**
   * Group outputs into a synchronized zone.
   *
   * Per node-roon-api-transport docs: "The first output's zone's queue
   * is preserved." So the order matters — callers should put the
   * "primary" output first.
   *
   * Roon returns a string error name (e.g. "InvalidOutput") on
   * failure; the wrapper converts to a `RoonOperationError` so
   * downstream callers can inspect.
   */
  public async groupOutputs(output_ids: string[]): Promise<void> {
    this.ensureTransport();

    return this.roonCall("groupOutputs", (resolve, reject) => {
      // Roon's group_outputs expects an array of "output objects"
      // (it walks each and calls oid() to extract output_id). Passing
      // bare { output_id } shapes satisfies the same contract and
      // keeps the wrapper agnostic of Roon's internal Output type.
      const outputs = output_ids.map((id) => ({ output_id: id }));
      this.transport.group_outputs(outputs, (error: any) => {
        if (error) {
          this.logger.error({ err: error, output_ids }, "groupOutputs failed");
          reject(new RoonOperationError("groupOutputs", error, { output_ids }));
        } else {
          this.logger.debug({ output_ids }, "groupOutputs succeeded");
          resolve();
        }
      });
    });
  }

  /**
   * Ungroup outputs that were previously grouped via {@link groupOutputs}.
   */
  public async ungroupOutputs(output_ids: string[]): Promise<void> {
    this.ensureTransport();

    return this.roonCall("ungroupOutputs", (resolve, reject) => {
      const outputs = output_ids.map((id) => ({ output_id: id }));
      this.transport.ungroup_outputs(outputs, (error: any) => {
        if (error) {
          this.logger.error({ err: error, output_ids }, "ungroupOutputs failed");
          reject(new RoonOperationError("ungroupOutputs", error, { output_ids }));
        } else {
          this.logger.debug({ output_ids }, "ungroupOutputs succeeded");
          resolve();
        }
      });
    });
  }

  /**
   * Put an output into standby. **Idempotent** — calling on an
   * already-standby output is a no-op (per Roon's `standby`
   * semantics). Prefer this over `toggleStandby` for "make sure
   * the output is asleep" intent: a duplicate / retried / stale
   * command can't accidentally wake it up.
   *
   * If `control_key` is omitted, all `source_controls` on the
   * output that report `supports_standby: true` are put into
   * standby together.
   */
  public async standby(
    output_id: string,
    control_key?: string
  ): Promise<void> {
    this.ensureTransport();

    return this.roonCall("standby", (resolve, reject) => {
      const output = { output_id };
      const opts: { control_key?: string } = {};
      if (control_key) opts.control_key = control_key;
      this.transport.standby(output, opts, (error: any) => {
        if (error) {
          this.logger.error(
            { err: error, output_id, control_key },
            "standby failed"
          );
          reject(
            new RoonOperationError("standby", error, { output_id, control_key })
          );
        } else {
          this.logger.debug({ output_id, control_key }, "standby succeeded");
          resolve();
        }
      });
    });
  }

  /**
   * Toggle the standby state of an output. NOT idempotent — a
   * duplicate / retried call flips the state. Use `standby()` for
   * idempotent "put to sleep" intent.
   *
   * If the output has multiple `source_controls` that expose
   * `supports_standby`, the caller picks which one via
   * `control_key`; for single-control outputs the key can be
   * omitted.
   */
  public async toggleStandby(
    output_id: string,
    control_key?: string
  ): Promise<void> {
    this.ensureTransport();

    return this.roonCall("toggleStandby", (resolve, reject) => {
      const output = { output_id };
      const opts: { control_key?: string } = {};
      if (control_key) opts.control_key = control_key;
      this.transport.toggle_standby(output, opts, (error: any) => {
        if (error) {
          this.logger.error(
            { err: error, output_id, control_key },
            "toggleStandby failed"
          );
          reject(
            new RoonOperationError("toggleStandby", error, { output_id, control_key })
          );
        } else {
          this.logger.debug({ output_id, control_key }, "toggleStandby succeeded");
          resolve();
        }
      });
    });
  }

  /**
   * "Wake" an output via Roon's convenience-switch — takes it out
   * of standby and switches its source-control inputs if applicable.
   * Omitting `control_key` cycles all controls on the output.
   *
   * Use case: a "Wake all" button on a grouped zone iterates this
   * per output (the API has no batch form).
   */
  public async convenienceSwitch(
    output_id: string,
    control_key?: string
  ): Promise<void> {
    this.ensureTransport();

    return this.roonCall("convenienceSwitch", (resolve, reject) => {
      const output = { output_id };
      const opts: { control_key?: string } = {};
      if (control_key) opts.control_key = control_key;
      this.transport.convenience_switch(output, opts, (error: any) => {
        if (error) {
          this.logger.error(
            { err: error, output_id, control_key },
            "convenienceSwitch failed"
          );
          reject(
            new RoonOperationError("convenienceSwitch", error, {
              output_id,
              control_key
            })
          );
        } else {
          this.logger.debug(
            { output_id, control_key },
            "convenienceSwitch succeeded"
          );
          resolve();
        }
      });
    });
  }

  /**
   * Subscribe to queue updates for a zone.
   * Safe to call repeatedly (idempotent per zone_id).
   */
  public subscribeQueue(zone_id: string, max_item_count?: number): void {
    this.ensureTransport();

    const targetCount = this.resolveQueueSubscriptionSize(zone_id, max_item_count);
    const existingSubscription = this.queueSubscriptions.get(zone_id);

    if (existingSubscription && existingSubscription.max_item_count >= targetCount) {
      return;
    }

    const nextSubscription: {
      max_item_count: number;
      unsubscribe?: (cb?: (error?: unknown) => void) => void;
    } = { max_item_count: targetCount };

    // Install the replacement identity before asking Roon to unsubscribe the
    // previous listener. Roon can deliver callbacks synchronously or while an
    // unsubscribe is still settling, and those callbacks must not mutate the
    // cache owned by the replacement subscription.
    this.queueSubscriptions.set(zone_id, nextSubscription);

    if (existingSubscription) {
      try {
        existingSubscription.unsubscribe?.();
      } catch (error) {
        this.logger.warn(
          { err: error, zone_id },
          "Queue unsubscribe failed before re-subscribing"
        );
      }
    }

    try {
      const subscription = this.transport.subscribe_queue(
        zone_id,
        targetCount,
        (response: any, data: any) => {
          if (this.queueSubscriptions.get(zone_id) !== nextSubscription) {
            this.logger.debug(
              { zone_id, response },
              "Ignoring callback from superseded queue subscription"
            );
            return;
          }

          // Trace-level dump of raw Roon payload — set LOG_LEVEL=trace and
          // exercise queue mutations (Play Next, remove, reorder) to capture
          // the delta payload shape for positional-diff implementation.
          this.logger.trace({ zone_id, response, data }, "subscribe_queue callback (raw)");
          this.handleQueueUpdate(zone_id, targetCount, response, data);
        }
      );

      if (this.queueSubscriptions.get(zone_id) === nextSubscription) {
        nextSubscription.unsubscribe = subscription?.unsubscribe;
      } else {
        subscription?.unsubscribe?.();
      }
    } catch (error) {
      if (this.queueSubscriptions.get(zone_id) === nextSubscription) {
        this.queueSubscriptions.delete(zone_id);
      }
      throw error;
    }
  }

  /**
   * Get queue snapshot for a zone.
   */
  public getQueue(zone_id: string): ZoneQueue {
    const existing = this.queueByZone.get(zone_id);
    if (existing) {
      return existing;
    }

    const empty: ZoneQueue = {
      zone_id,
      items: [],
      max_item_count:
        this.queueSubscriptions.get(zone_id)?.max_item_count ??
        this.resolveQueueSubscriptionSize(zone_id),
      updated_at: new Date().toISOString(),
    };
    this.queueByZone.set(zone_id, empty);
    return empty;
  }

  /**
   * Start playback from a specific queue item.
   */
  public async playFromHere(zone_id: string, queue_item_id: number): Promise<void> {
    this.ensureTransport();

    return this.roonCall("playFromHere", (resolve, reject) => {
      this.transport.play_from_here(zone_id, queue_item_id, (error: any) => {
        if (error && error.name && error.name !== "Success") {
          this.logger.error({ err: error, zone_id, queue_item_id }, "playFromHere failed");
          reject(new RoonOperationError("playFromHere", error.name, { zone_id, queue_item_id }));
        } else {
          this.logger.debug({ zone_id, queue_item_id }, "playFromHere succeeded");
          resolve();
        }
      });
    });
  }

  /**
   * Subscribe to zone updates
   * Emits zone-updated and now-playing-updated events
   */
  public subscribeZones(): void {
    this.ensureTransport();

    this.transport.subscribe_zones((response: any, data: any) => {
      // Trace-level dump of raw Roon payload for queue-feature investigation.
      // Set LOG_LEVEL=trace to capture and paste back for review.
      this.logger.trace({ response, data }, "subscribe_zones callback (raw)");

      if (response === "Subscribed" || response === "Changed") {
        if (response === "Subscribed") {
          this.logger.info("Subscribed to zone updates");
        }
        this.handleZonesUpdate(data);
        // Seek changes only appear on `Changed` payloads in practice, but
        // calling this for both branches is harmless (it noops when
        // `zones_seek_changed` is absent) and avoids a silent break if
        // Roon ever bundles seek info into the initial snapshot.
        this.handleSeekChanged(data);
      } else if (response === "Unsubscribed") {
        this.logger.warn("Unsubscribed from zone updates");
        this.subscriptions.clear();
      }
    });
  }

  /**
   * Get all zones from subscriptions
   */
  public getZones(): Zone[] {
    return Array.from(this.subscriptions.values());
  }

  /**
   * Get specific zone by ID
   */
  public getZone(zone_id: string): Zone | undefined {
    return this.subscriptions.get(zone_id);
  }

  /**
   * Get all cached now-playing states (used to hydrate new socket connections)
   */
  public getNowPlayingAll(): NowPlaying[] {
    return Array.from(this.nowPlayingByZone.values());
  }

  /**
   * Reset all in-memory transport state.
   * Useful when the core disconnects/unpairs and previously cached zones are stale.
   */
  public resetState(): void {
    this.subscriptions.clear();
    this.nowPlayingByZone.clear();
    this.queueByZone.clear();

    const queueSubscriptions = Array.from(this.queueSubscriptions.entries());
    this.queueSubscriptions.clear();
    for (const [zone_id, subscription] of queueSubscriptions) {
      try {
        subscription.unsubscribe?.();
      } catch (error) {
        this.logger.warn({ err: error, zone_id }, "Failed to unsubscribe queue listener");
      }
    }
  }

  /**
   * Tear down all live subscriptions. Called from the process shutdown
   * handler so the Roon Core does not keep stale callbacks queued for the
   * extension after restart.
   */
  public shutdown(): void {
    this.resetState();
  }

  /**
   * Handle zone updates from Roon
   * Processes zones, zones_changed, zones_added, zones_removed
   */
  private handleZonesUpdate(data: any): void {
    if (!data) {
      return;
    }

    // Handle initial snapshot or full zones update
    if (data.zones) {
      for (const roonZone of data.zones) {
        const zone = this.normalizeZone(roonZone);
        this.subscriptions.set(zone.zone_id, zone);
        
        this.emit("zone-updated", { zone });

        if (roonZone.now_playing) {
          this.emitNowPlaying(zone.zone_id, this.normalizeNowPlaying(roonZone));
        }
      }
    }

    // Handle incremental zone changes
    if (data.zones_changed) {
      for (const roonZone of data.zones_changed) {
        const zone = this.normalizeZone(roonZone);
        this.subscriptions.set(zone.zone_id, zone);

        this.emit("zone-updated", { zone });

        if (roonZone.now_playing) {
          this.emitNowPlaying(zone.zone_id, this.normalizeNowPlaying(roonZone));
        }
      }
    }

    // Handle newly added zones
    if (data.zones_added) {
      for (const roonZone of data.zones_added) {
        const zone = this.normalizeZone(roonZone);
        this.subscriptions.set(zone.zone_id, zone);

        this.logger.info({ zone_id: zone.zone_id }, "Zone added");
        this.emit("zone-updated", { zone });

        if (roonZone.now_playing) {
          this.emitNowPlaying(zone.zone_id, this.normalizeNowPlaying(roonZone));
        }
      }
    }

    // Handle removed zones
    if (data.zones_removed) {
      for (const zone_id of data.zones_removed) {
        this.subscriptions.delete(zone_id);
        this.nowPlayingByZone.delete(zone_id);
        this.queueByZone.delete(zone_id);
        const queueSubscription = this.queueSubscriptions.get(zone_id);
        if (queueSubscription) {
          this.queueSubscriptions.delete(zone_id);
          try {
            queueSubscription.unsubscribe?.();
          } catch (error) {
            this.logger.warn({ err: error, zone_id }, "Queue unsubscribe failed on zone removal");
          }
        }

        this.logger.info({ zone_id }, "Zone removed");
        this.emit("zone-removed", { zone_id });
        this.emit("queue-updated", {
          queue: {
            zone_id,
            items: [],
            max_item_count: this.resolveQueueSubscriptionSize(zone_id),
            updated_at: new Date().toISOString(),
          },
        });
      }
    }
  }

  /**
   * Handle seek position updates without full zone updates
   */
  private handleSeekChanged(data: any): void {
    if (!data?.zones_seek_changed) {
      return;
    }

    for (const seekUpdate of data.zones_seek_changed) {
      const zoneId = seekUpdate.zone_id;
      const seekPosition = seekUpdate.seek_position;

      // Update stored zone if exists
      const zone = this.subscriptions.get(zoneId);
      if (zone) {
        zone.seek_position = seekPosition;
        this.subscriptions.set(zoneId, zone);
      }

      this.emit("seek-changed", { zone_id: zoneId, seek_position: seekPosition });
    }
  }

  /**
   * Handle queue subscription updates for a zone.
   */
  private handleQueueUpdate(
    zone_id: string,
    max_item_count: number,
    response: string,
    data: any
  ): void {
    if (response === "Unsubscribed") {
      this.queueByZone.delete(zone_id);
      this.queueSubscriptions.delete(zone_id);
      this.emit("queue-updated", {
        queue: {
          zone_id,
          items: [],
          max_item_count,
          updated_at: new Date().toISOString(),
        },
      });
      return;
    }

    const existing = this.getQueue(zone_id);
    let nextItems = [...existing.items];

    if (Array.isArray(data?.items)) {
      // Full snapshot (initial Subscribed response, or a re-sync). Trust
      // Roon's order — `queue_item_id` is opaque, not a position, so
      // sorting by it would silently misorder queues. Some Changed payloads
      // include both the resulting full snapshot and the deltas that produced
      // it; the snapshot is already post-change, so applying both would
      // duplicate inserted rows.
      nextItems = this.normalizeQueueItems(data.items);
    } else if (Array.isArray(data?.changes)) {
      // Positional deltas. Roon's actual wire format is `changes: [{...}]` with
      // splice-style ops applied in order when no full snapshot accompanies
      // them. The fields `items_added` / `items_changed` / `items_removed`
      // referenced in some Roon docs are not what the transport service
      // actually delivers (verified by capture against a live Core, May 2026).
      for (const change of data.changes) {
        nextItems = this.applyQueueChange(nextItems, change);
      }
    }

    const snapshot: ZoneQueue = {
      zone_id,
      items: nextItems,
      max_item_count,
      updated_at: new Date().toISOString(),
    };

    this.queueByZone.set(zone_id, snapshot);
    this.emit("queue-updated", { queue: snapshot });
  }

  /**
   * Apply a single Roon queue-subscription change to the local array.
   * Operations seen in practice:
   *   - { operation: "insert", index, items: [...] } — splice items in at index
   *   - { operation: "remove", index, count }       — splice `count` items out at index
   *
   * Malformed known operations (missing/invalid `index` or `count`) are
   * skipped with a warn log rather than defaulted, because defaulting
   * `index` to 0 would silently mutate the currently-playing row, and
   * defaulting `count` to 1 would silently remove the wrong item.
   */
  private applyQueueChange(items: QueueItem[], change: any): QueueItem[] {
    if (!change || typeof change.operation !== "string") return items;

    if (change.operation !== "insert" && change.operation !== "remove") {
      this.logger.warn({ change }, "Ignoring unknown queue change operation");
      return items;
    }

    if (
      typeof change.index !== "number" ||
      !Number.isFinite(change.index) ||
      change.index < 0
    ) {
      this.logger.warn({ change }, "Skipping queue change with invalid index");
      return items;
    }
    const index = Math.floor(change.index);

    if (change.operation === "insert") {
      if (!Array.isArray(change.items)) {
        this.logger.warn({ change }, "Skipping insert change with non-array items");
        return items;
      }
      const incoming = this.normalizeQueueItems(change.items);
      const next = [...items];
      next.splice(index, 0, ...incoming);
      return next;
    }

    // remove
    if (
      typeof change.count !== "number" ||
      !Number.isFinite(change.count) ||
      change.count <= 0
    ) {
      this.logger.warn({ change }, "Skipping remove change with invalid count");
      return items;
    }
    const count = Math.floor(change.count);
    const next = [...items];
    next.splice(index, count);
    return next;
  }

  private normalizeQueueItems(items: any[]): QueueItem[] {
    const result: QueueItem[] = [];
    for (const raw of items) {
      const item = this.normalizeQueueItem(raw);
      if (item) result.push(item);
    }
    return result;
  }

  private normalizeQueueItem(item: any): QueueItem | null {
    const id = this.extractQueueItemId(item);
    if (typeof id !== "number") {
      this.logger.warn({ item }, "Dropping queue item without a valid queue_item_id");
      return null;
    }
    return {
      queue_item_id: id,
      length: typeof item?.length === "number" ? item.length : undefined,
      image_key: item?.image_key,
      one_line: item?.one_line,
      two_line: item?.two_line,
      three_line: item?.three_line,
    };
  }

  private extractQueueItemId(item: any): number | undefined {
    if (typeof item === "number" && Number.isFinite(item)) {
      return item;
    }
    if (typeof item?.queue_item_id === "number" && Number.isFinite(item.queue_item_id)) {
      return item.queue_item_id;
    }
    return undefined;
  }

  /**
   * Resolve queue subscription size so "full queue" snapshots are practical by default.
   * Uses zone queue metadata when available and enforces a large minimum.
   */
  private resolveQueueSubscriptionSize(
    zone_id: string,
    requestedMaxItemCount?: number
  ): number {
    const requested =
      typeof requestedMaxItemCount === "number" &&
      Number.isFinite(requestedMaxItemCount) &&
      requestedMaxItemCount > 0
        ? Math.floor(requestedMaxItemCount)
        : 0;

    const zone = this.subscriptions.get(zone_id);
    const basedOnZone =
      typeof zone?.queue_items_remaining === "number" && zone.queue_items_remaining >= 0
        ? zone.queue_items_remaining +
          1 +
          TransportService.QUEUE_SUBSCRIPTION_HEADROOM
        : 0;

    // Clamp at MAX as defense in depth: REST/socket validators
    // already reject > MAX, but a bypassed validator (or a future
    // internal caller) shouldn't be able to push a million-item
    // subscription through to Roon. The clamp is silent here — the
    // upstream validators produce the user-facing error.
    return Math.min(
      TransportService.MAX_QUEUE_SUBSCRIPTION_ITEMS,
      Math.max(
        TransportService.MIN_QUEUE_SUBSCRIPTION_ITEMS,
        requested,
        basedOnZone
      )
    );
  }

  /**
   * Normalize Roon zone data to our Zone interface
   */
  private normalizeZone(roonZone: any): Zone {
    return {
      zone_id: roonZone.zone_id,
      display_name: roonZone.display_name,
      state: this.normalizeState(roonZone.state),
      seek_position: roonZone.now_playing?.seek_position,
      is_play_allowed: roonZone.is_play_allowed ?? false,
      is_pause_allowed: roonZone.is_pause_allowed ?? false,
      is_previous_allowed: roonZone.is_previous_allowed ?? false,
      is_next_allowed: roonZone.is_next_allowed ?? false,
      is_seek_allowed: roonZone.is_seek_allowed ?? false,
      queue_items_remaining:
        typeof roonZone.queue_items_remaining === "number"
          ? roonZone.queue_items_remaining
          : undefined,
      queue_time_remaining:
        typeof roonZone.queue_time_remaining === "number"
          ? roonZone.queue_time_remaining
          : undefined,
      settings: roonZone.settings
        ? {
            loop: roonZone.settings.loop,
            shuffle: roonZone.settings.shuffle,
            auto_radio: roonZone.settings.auto_radio,
          }
        : undefined,
      outputs: roonZone.outputs?.map((output: any) => ({
        output_id: output.output_id,
        display_name: output.display_name,
        volume: output.volume ? this.normalizeVolume(output.volume) : undefined,
        source_controls: this.normalizeSourceControls(output.source_controls),
      })),
    };
  }

  /**
   * Normalize Roon's `source_controls` array on an output. Each entry
   * carries the power/standby endpoint info the UI needs to render
   * standby/wake affordances. Filter to entries with a usable
   * `control_key` and `display_name` — anything malformed is dropped
   * silently so we never surface a button that can't be acted on.
   *
   * Returns `undefined` when the input is missing or yields no usable
   * entries, so the JSON serialization omits the field entirely
   * (matches how a `null` volume is handled).
   */
  private normalizeSourceControls(
    raw: unknown
  ): Zone["outputs"] extends Array<infer O>
    ? O extends { source_controls?: infer SC }
      ? SC | undefined
      : never
    : never {
    if (!Array.isArray(raw)) return undefined as never;
    const out = raw
      .filter(
        (c: any) =>
          c &&
          typeof c.control_key === "string" &&
          c.control_key.length > 0 &&
          typeof c.display_name === "string"
      )
      .map((c: any) => {
        const status: "selected" | "deselected" | "standby" | "indeterminate" =
          c.status === "selected" ||
          c.status === "deselected" ||
          c.status === "standby" ||
          c.status === "indeterminate"
            ? c.status
            : "indeterminate";
        return {
          control_key: c.control_key as string,
          display_name: c.display_name as string,
          status,
          supports_standby: c.supports_standby === true,
        };
      });
    return (out.length > 0 ? out : undefined) as never;
  }

  private emitNowPlaying(zone_id: string, nowPlaying: NowPlaying): void {
    this.nowPlayingByZone.set(zone_id, nowPlaying);
    this.emit("now-playing-updated", { zone_id, now_playing: nowPlaying });
  }

  /**
   * Normalize Roon now playing data to our NowPlaying interface
   */
  private normalizeNowPlaying(roonZone: any): NowPlaying {
    const np = roonZone.now_playing || {};

    return {
      zone_id: roonZone.zone_id,
      title: np.three_line?.line1,
      artist: np.three_line?.line2,
      album: np.three_line?.line3,
      duration: np.length,
      seek_position: np.seek_position,
      image_key: np.image_key,
      state: this.normalizeState(roonZone.state),
      loop: np.settings?.loop,
      shuffle: np.settings?.shuffle,
    };
  }

  /**
   * Normalize playback state string
   */
  private normalizeState(state: string): PlaybackState {
    const normalized = state?.toLowerCase();
    if (
      normalized === "playing" ||
      normalized === "paused" ||
      normalized === "stopped" ||
      normalized === "loading"
    ) {
      return normalized as PlaybackState;
    }
    return "stopped";
  }

  /**
   * Normalize volume settings. Preserves the Roon-reported type for
   * "number", "db", and "incremental"; unknown types fall back to "number"
   * (the safest default for absolute-volume calls).
   */
  private normalizeVolume(roonVolume: any): VolumeSettings {
    const rawType = String(roonVolume?.type ?? "");
    const type: VolumeSettings["type"] =
      rawType === "db" ? "db" : rawType === "incremental" ? "incremental" : "number";
    return {
      type,
      min: roonVolume.min ?? 0,
      max: roonVolume.max ?? 100,
      value: roonVolume.value ?? 50,
      step: roonVolume.step,
      is_muted: roonVolume.is_muted ?? false,
    };
  }

  /**
   * Ensure transport service is available
   * @throws Error if core not paired or transport unavailable
   */
  private ensureTransport(): void {
    this.transport = this.roonClient.getTransport();

    if (!this.transport) {
      this.logger.error("Transport operation attempted without paired core");
      throw new CoreUnpairedError("Transport service unavailable");
    }
  }
}
