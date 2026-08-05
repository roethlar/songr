import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { EventEmitter } from "events";
import { Logger } from "pino";
import { RecentlyPlayedService } from "../RecentlyPlayedService";
import type { TransportService } from "../../roon/TransportService";
import type { NowPlaying } from "../../../shared/types";

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
  level: "info",
} as unknown as Logger;

class FakeTransport extends EventEmitter {
  fireNowPlaying(zoneId: string, nowPlaying: NowPlaying | null): void {
    this.emit("now-playing-updated", { zone_id: zoneId, now_playing: nowPlaying });
  }
}

function nowPlaying(over: Partial<NowPlaying> = {}): NowPlaying {
  return {
    zone_id: "zone-a",
    title: "Track",
    artist: "Artist",
    album: "Album",
    duration: 180,
    image_key: "img-1",
    state: "playing",
    ...over,
  };
}

async function makeTmpPath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "recently-played-"));
  return path.join(dir, "recently-played.json");
}

async function readPersisted(filePath: string): Promise<unknown> {
  const raw = await fs.readFile(filePath, "utf-8");
  const parsed = JSON.parse(raw);
  // The service now writes `{ entries, generation }` but legacy
  // tests asserted against a bare array. Unwrap so the array
  // assertions still apply; tests that care about generation read
  // the raw file via readPersistedRaw.
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray(parsed.entries)) {
    return parsed.entries;
  }
  return parsed;
}

async function readPersistedRaw(filePath: string): Promise<unknown> {
  const raw = await fs.readFile(filePath, "utf-8");
  return JSON.parse(raw);
}

async function flushWrites(svc: RecentlyPlayedService): Promise<void> {
  // Drain insert chain AND write chain. Inserts are now serialized
  // through `insertChain` and only emit `inserted` once their
  // persist commits — so observable state lags by an async tick.
  // svc.flush() awaits both chains in order.
  await svc.flush();
  // Settle any follow-up microtasks (e.g. listener bodies that ran
  // synchronously inside emit but enqueued additional work).
  await Promise.resolve();
}

describe("RecentlyPlayedService", () => {
  describe("dedupe + suppression window", () => {
    it("inserts the first entry from a now-playing event", async () => {
      const transport = new FakeTransport();
      const filePath = await makeTmpPath();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath, suppressionWindowMs: 30_000 }
      );
      const inserts: unknown[] = [];
      svc.on("inserted", (e) => inserts.push(e));
      await svc.start();

      transport.fireNowPlaying("zone-a", nowPlaying({ title: "Hey Jude" }));

      await flushWrites(svc);
      expect(svc.getEntries()).toHaveLength(1);
      expect(svc.getEntries()[0].title).toBe("Hey Jude");
      expect(inserts).toHaveLength(1);
    });

    it("collapses duplicate now-playing events within the suppression window", async () => {
      const transport = new FakeTransport();
      const filePath = await makeTmpPath();
      let clock = 1_000_000;
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath, suppressionWindowMs: 30_000, now: () => clock }
      );
      const inserts: unknown[] = [];
      svc.on("inserted", (e) => inserts.push(e));
      await svc.start();

      const np = nowPlaying({ title: "Hey Jude" });
      transport.fireNowPlaying("zone-a", np);
      clock += 5_000; // 5s later, well under the 30s window
      transport.fireNowPlaying("zone-a", np);
      clock += 10_000; // 15s total
      transport.fireNowPlaying("zone-a", np);

      await flushWrites(svc);
      expect(svc.getEntries()).toHaveLength(1);
      expect(inserts).toHaveLength(1);
    });

    it("bubbles a replay to the top once the suppression window has passed", async () => {
      // Use duration: 0 so the effective window is just the
      // configured 30s floor; otherwise duration would dominate.
      const transport = new FakeTransport();
      const filePath = await makeTmpPath();
      let clock = 1_000_000;
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath, suppressionWindowMs: 30_000, now: () => clock }
      );
      const inserts: unknown[] = [];
      svc.on("inserted", (e) => inserts.push(e));
      await svc.start();

      const np = nowPlaying({ title: "Hey Jude", duration: 0 });
      transport.fireNowPlaying("zone-a", np);
      await flushWrites(svc);
      const firstPlayedAt = svc.getEntries()[0].played_at;
      clock += 31_000; // past the 30s window (duration is 0)
      transport.fireNowPlaying("zone-a", np);

      // Replay bubbles in place: one entry, fresh played_at, and the
      // bubble re-emits `inserted` so the socket broadcast fires.
      await flushWrites(svc);
      expect(svc.getEntries()).toHaveLength(1);
      expect(svc.getEntries()[0].played_at).not.toBe(firstPlayedAt);
      expect(inserts).toHaveLength(2);
    });

    it("collapses cross-zone duplicates within the window (group play)", async () => {
      // Grouped zones playing the same track produce a now-playing
      // event per zone within milliseconds. We collapse them to one
      // entry — same dedupe key + within window = same play, even
      // across zones. Trade-off: two zones independently playing the
      // same track within the window collapse too. Acceptable for
      // "recently played" UX.
      const transport = new FakeTransport();
      const filePath = await makeTmpPath();
      let clock = 1_000_000;
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath, suppressionWindowMs: 30_000, now: () => clock }
      );
      await svc.start();

      const np = nowPlaying({ title: "Hey Jude", duration: 200 });
      transport.fireNowPlaying("zone-a", { ...np, zone_id: "zone-a" });
      clock += 5; // 5ms later — group-play emit
      transport.fireNowPlaying("zone-b", { ...np, zone_id: "zone-b" });

      await flushWrites(svc);
      expect(svc.getEntries()).toHaveLength(1);
    });

    it("uses track duration as the window so mid-play re-emits get suppressed", async () => {
      // Roon can re-emit the same now_playing well after the start of
      // a track (queue-changed, metadata refresh). Without using the
      // track's own duration as the window floor, a 4-minute track
      // re-emitted at 2 minutes slips past the 30s default and
      // duplicates.
      const transport = new FakeTransport();
      const filePath = await makeTmpPath();
      let clock = 1_000_000;
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath, suppressionWindowMs: 30_000, now: () => clock }
      );
      await svc.start();

      const np = nowPlaying({ title: "Alexander Hamilton", duration: 236 });
      transport.fireNowPlaying("zone-a", np);
      clock += 107_000; // 107s in — past 30s default, well within song
      transport.fireNowPlaying("zone-a", np);

      await flushWrites(svc);
      expect(svc.getEntries()).toHaveLength(1);
    });

    it("dedupes against any prior entry within the window, not just head (multi-zone interleaving)", async () => {
      // Zone A starts X, zone B starts Y, then zone A re-emits X
      // mid-play. Head when X re-emits is Y, but the suppression
      // check must also see the earlier X within the window.
      const transport = new FakeTransport();
      const filePath = await makeTmpPath();
      let clock = 1_000_000;
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath, suppressionWindowMs: 30_000, now: () => clock }
      );
      await svc.start();

      const trackX = nowPlaying({ title: "Track X", duration: 200 });
      const trackY = nowPlaying({
        title: "Track Y",
        duration: 200,
        zone_id: "zone-b"
      });

      transport.fireNowPlaying("zone-a", trackX);
      clock += 2_000;
      transport.fireNowPlaying("zone-b", trackY);
      clock += 5_000; // 7s after X started — well within X's 200s window
      transport.fireNowPlaying("zone-a", trackX); // mid-play re-emit

      // Two distinct tracks recorded; the X re-emit was suppressed
      // even though head was Y.
      await flushWrites(svc);
      const titles = svc.getEntries().map((e) => e.title);
      expect(titles).toEqual(["Track Y", "Track X"]);
    });

    it("bubbles a replay to the top once the track-duration window has passed", async () => {
      const transport = new FakeTransport();
      const filePath = await makeTmpPath();
      let clock = 1_000_000;
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath, suppressionWindowMs: 30_000, now: () => clock }
      );
      await svc.start();

      const np = nowPlaying({ title: "Short Song", duration: 60 });
      transport.fireNowPlaying("zone-a", np);
      clock += 70_000; // past duration + grace (5s) — legitimate replay
      transport.fireNowPlaying("zone-a", np);

      // Legitimate replay → bubble, not duplicate.
      await flushWrites(svc);
      expect(svc.getEntries()).toHaveLength(1);
    });

    it("bubbles a replayed track over later plays instead of duplicating", async () => {
      // The user-reported bug: play A, play another track, play A
      // again — A duplicated instead of moving to the top. With
      // move-to-front dedup the prior A is removed and a fresh A
      // unshifted, so the list holds at most one entry per track.
      const transport = new FakeTransport();
      const filePath = await makeTmpPath();
      let clock = 1_000_000;
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath, suppressionWindowMs: 30_000, now: () => clock }
      );
      await svc.start();

      const trackA = nowPlaying({ title: "Track A", duration: 60 });
      const trackB = nowPlaying({ title: "Track B", duration: 60 });

      transport.fireNowPlaying("zone-a", trackA);
      await flushWrites(svc);
      clock += 1_000;
      transport.fireNowPlaying("zone-a", trackB);
      await flushWrites(svc);
      clock += 70_000; // past Track A's 65s window
      transport.fireNowPlaying("zone-a", trackA); // genuine replay

      await flushWrites(svc);
      expect(svc.getEntries().map((e) => e.title)).toEqual([
        "Track A",
        "Track B",
      ]);
    });

    it("ignores null now_playing payloads (zone went idle)", async () => {
      const transport = new FakeTransport();
      const filePath = await makeTmpPath();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath }
      );
      await svc.start();

      transport.fireNowPlaying("zone-a", null);
      transport.fireNowPlaying("zone-a", nowPlaying({ title: "" }));

      await flushWrites(svc);
      expect(svc.getEntries()).toHaveLength(0);
    });

    it("only emits `inserted` for new entries (not for suppressed duplicates)", async () => {
      const transport = new FakeTransport();
      const filePath = await makeTmpPath();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath, suppressionWindowMs: 30_000 }
      );
      const inserts: unknown[] = [];
      svc.on("inserted", (e) => inserts.push(e));
      await svc.start();

      transport.fireNowPlaying("zone-a", nowPlaying({ title: "A" }));
      transport.fireNowPlaying("zone-a", nowPlaying({ title: "A" })); // dup
      transport.fireNowPlaying("zone-a", nowPlaying({ title: "B" }));

      await flushWrites(svc);
      expect(inserts).toHaveLength(2);
      expect(svc.getEntries().map((e) => e.title)).toEqual(["B", "A"]);
    });
  });

  describe("clear()", () => {
    it("awaits persist before resolving and emits `cleared` once durable", async () => {
      const transport = new FakeTransport();
      const filePath = await makeTmpPath();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath }
      );
      let clearedCount = 0;
      svc.on("cleared", () => clearedCount++);
      await svc.start();

      transport.fireNowPlaying("zone-a", nowPlaying({ title: "A" }));
      transport.fireNowPlaying("zone-b", nowPlaying({ title: "B", zone_id: "zone-b" }));
      await flushWrites(svc);
      expect(svc.getEntries()).toHaveLength(2);

      await svc.clear();

      // By the time the await resolves: in-memory empty, file empty,
      // and `cleared` already emitted (which drives the socket
      // broadcast).
      expect(svc.getEntries()).toEqual([]);
      expect(await readPersisted(filePath)).toEqual([]);
      expect(clearedCount).toBe(1);
    });

    it("clear() on an already-empty list still emits (idempotent across clients)", async () => {
      const transport = new FakeTransport();
      const filePath = await makeTmpPath();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath }
      );
      let clearedCount = 0;
      svc.on("cleared", () => clearedCount++);
      await svc.start();

      await svc.clear();

      expect(svc.getEntries()).toEqual([]);
      expect(clearedCount).toBe(1);
    });

    it("buffers a concurrent insert and broadcasts cleared before inserted", async () => {
      // The race the reviewer flagged: a now-playing event arrives
      // between clear()'s synchronous in-memory wipe and its awaited
      // persist. Without buffering, the insert mutates the array
      // back to [entry], the persist serializes that array (so disk
      // ends up non-empty), and clients receive `inserted` then
      // `cleared` — leaving them empty while server/disk still hold
      // the entry.
      const transport = new FakeTransport();
      const filePath = await makeTmpPath();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath }
      );
      const events: string[] = [];
      svc.on("cleared", () => events.push("cleared"));
      svc.on("inserted", (e) => events.push(`inserted:${e.title}`));
      await svc.start();

      // Don't await yet — clear's synchronous prelude runs (entries
      // emptied, clearInFlight=true), then the persist await yields.
      const clearPromise = svc.clear();
      // Now-playing arrives mid-await. Should be buffered, NOT
      // mutate entries and NOT emit `inserted` yet.
      transport.fireNowPlaying("zone-a", nowPlaying({ title: "MidClear" }));
      expect(svc.getEntries()).toEqual([]);
      expect(events).toEqual([]);

      await clearPromise;

      // After clear: cleared emitted first, then the buffered insert
      // drained through the normal handler → inserted emitted with
      // the entry.
      await flushWrites(svc);
      expect(events).toEqual(["cleared", "inserted:MidClear"]);
      expect(svc.getEntries().map((e) => e.title)).toEqual(["MidClear"]);

      // Disk converges with in-memory: clear's persist wrote [], then
      // the drained insert's persist wrote [MidClear].
      await flushWrites(svc);
      const persisted = (await readPersisted(filePath)) as Array<{ title: string }>;
      expect(persisted.map((e) => e.title)).toEqual(["MidClear"]);
    });

    it("drains buffered inserts onto the rolled-back list when persist fails; drained inserts also roll back if their persist fails", async () => {
      // Failure path of the same race: a now-playing event arrives
      // during a clear that ultimately fails to persist.
      //
      // M-3 contract: inserts are durable-or-nothing. The drained
      // insert is enqueued (correct — it wasn't lost), but if its
      // own persist also fails (the writeSpy is still active), it
      // rolls back too and does NOT broadcast `inserted`. Clients
      // are never told about an entry that won't survive a restart.
      // `cleared` is also NOT broadcast (clear's persist failed).
      const filePath = await makeTmpPath();
      const transport = new FakeTransport();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath }
      );
      const events: string[] = [];
      svc.on("cleared", () => events.push("cleared"));
      svc.on("inserted", (e) => events.push(`inserted:${e.title}`));
      await svc.start();

      transport.fireNowPlaying("zone-a", nowPlaying({ title: "Before" }));
      await flushWrites(svc);
      expect(svc.getEntries().map((e) => e.title)).toEqual(["Before"]);

      const writeSpy = jest
        .spyOn(fs, "writeFile")
        .mockRejectedValue(new Error("injected persist failure"));
      try {
        const clearPromise = svc.clear();
        transport.fireNowPlaying("zone-a", nowPlaying({ title: "MidClear" }));
        await expect(clearPromise).rejects.toThrow();

        // Drained insert ran AFTER clear resolved; let its chain settle.
        await flushWrites(svc);

        // Neither `cleared` (clear's persist failed) nor
        // `inserted:MidClear` (drained insert's persist also failed)
        // is broadcast. Only the original "Before" insert (which
        // committed before the writeSpy was installed) appears.
        expect(events).toEqual(["inserted:Before"]);
        // In-memory state is the clear-rollback list. MidClear's
        // insert mutation was rolled back when its persist failed,
        // so it does NOT appear.
        expect(svc.getEntries().map((e) => e.title)).toEqual(["Before"]);
      } finally {
        writeSpy.mockRestore();
      }

      // After the writeSpy is restored, a fresh insert commits normally
      // — the rollback didn't poison the chain.
      transport.fireNowPlaying("zone-a", nowPlaying({ title: "After" }));
      await flushWrites(svc);
      expect(events).toEqual(["inserted:Before", "inserted:After"]);
      expect(svc.getEntries().map((e) => e.title)).toEqual(["After", "Before"]);
    });

    it("coalesces overlapping clear() calls into one persist + one cleared broadcast", async () => {
      // Two clients hitting DELETE simultaneously must not produce
      // two interleaved clear operations. Without coalescing, the
      // second clear's late `cleared` broadcast can land after the
      // first clear's drained `inserted`, leaving clients empty
      // while server/disk hold the entry.
      const transport = new FakeTransport();
      const filePath = await makeTmpPath();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath }
      );
      const events: string[] = [];
      svc.on("cleared", () => events.push("cleared"));
      svc.on("inserted", (e) => events.push(`inserted:${e.title}`));
      await svc.start();

      transport.fireNowPlaying("zone-a", nowPlaying({ title: "Before" }));
      await flushWrites(svc);
      events.length = 0; // ignore the seed insert

      const a = svc.clear();
      const b = svc.clear();

      // Same in-flight operation, returned to both callers.
      expect(a).toBe(b);

      await Promise.all([a, b]);

      // Single cleared broadcast — no late broadcast from a second
      // operation finishing later.
      expect(events).toEqual(["cleared"]);
      expect(svc.getEntries()).toEqual([]);
    });

    it("overlapping clears + concurrent insert: one cleared broadcast, deferred insert after", async () => {
      // The exact divergence the reviewer flagged: while two clears
      // overlap, a now-playing event arrives. Coalescing means the
      // single drain runs once; the insert lands AFTER the single
      // `cleared` broadcast. Server, disk, and clients converge.
      const transport = new FakeTransport();
      const filePath = await makeTmpPath();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath }
      );
      const events: string[] = [];
      svc.on("cleared", () => events.push("cleared"));
      svc.on("inserted", (e) => events.push(`inserted:${e.title}`));
      await svc.start();

      const a = svc.clear();
      const b = svc.clear();
      transport.fireNowPlaying("zone-a", nowPlaying({ title: "MidClear" }));
      await Promise.all([a, b]);

      await flushWrites(svc);
      expect(events).toEqual(["cleared", "inserted:MidClear"]);
      expect(svc.getEntries().map((e) => e.title)).toEqual(["MidClear"]);

      // Disk converges with in-memory.
      const persisted = (await readPersisted(filePath)) as Array<{ title: string }>;
      expect(persisted.map((e) => e.title)).toEqual(["MidClear"]);
    });

    it("does not wedge service state when a 'cleared' listener throws", async () => {
      // EventEmitter listener exceptions propagate synchronously
      // back to emit()'s caller. Without isolation, a throwing
      // listener would skip the post-emit state reset
      // (clearInFlight stays true, pendingClear stays pinned to a
      // rejected promise) — future inserts buffer forever, future
      // clear() calls coalesce to the dead promise.
      const transport = new FakeTransport();
      const filePath = await makeTmpPath();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath }
      );
      svc.on("cleared", () => {
        throw new Error("listener boom");
      });
      await svc.start();

      transport.fireNowPlaying("zone-a", nowPlaying({ title: "A" }));
      await flushWrites(svc);
      expect(svc.getEntries()).toHaveLength(1);

      // First clear: listener throws; the service swallows it,
      // resets state, and resolves cleanly.
      await expect(svc.clear()).resolves.toBeUndefined();
      expect(svc.getEntries()).toEqual([]);

      // Subsequent insert lands normally — proves clearInFlight
      // was reset (otherwise the event would be buffered, not
      // applied to entries).
      transport.fireNowPlaying("zone-a", nowPlaying({ title: "B" }));
      await flushWrites(svc);
      expect(svc.getEntries().map((e) => e.title)).toEqual(["B"]);

      // Subsequent clear works — proves pendingClear was reset
      // (otherwise this would await the prior op's settled promise
      // and never run a fresh clear).
      await expect(svc.clear()).resolves.toBeUndefined();
      expect(svc.getEntries()).toEqual([]);
    });

    it("rejects and rolls back the in-memory list when persist fails", async () => {
      // start() with a writable path so the service comes up
      // healthy (not degraded). Then inject a persist failure
      // mid-test via fs.writeFile spy so we can isolate the
      // "clear's persist fails → rollback" path from the
      // "startup fails → degraded" path.
      const filePath = await makeTmpPath();
      const transport = new FakeTransport();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath }
      );
      let clearedCount = 0;
      svc.on("cleared", () => clearedCount++);
      await svc.start();

      transport.fireNowPlaying("zone-a", nowPlaying({ title: "Stays" }));
      await flushWrites(svc);
      expect(svc.getEntries()).toHaveLength(1);

      const writeSpy = jest
        .spyOn(fs, "writeFile")
        .mockRejectedValue(new Error("injected persist failure"));
      try {
        await expect(svc.clear()).rejects.toThrow();

        // Rolled back: the in-memory list matches the prior state.
        // `cleared` was NOT emitted — clients don't see a broadcast
        // they'd then disagree with after restart.
        expect(svc.getEntries()).toHaveLength(1);
        expect(svc.getEntries()[0].title).toBe("Stays");
        expect(clearedCount).toBe(0);
      } finally {
        writeSpy.mockRestore();
      }
    });
  });

  describe("cap enforcement", () => {
    it("keeps only the most recent N entries", async () => {
      const transport = new FakeTransport();
      const filePath = await makeTmpPath();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath, cap: 3, suppressionWindowMs: 0 }
      );
      await svc.start();

      for (let i = 0; i < 5; i++) {
        transport.fireNowPlaying(
          "zone-a",
          nowPlaying({ title: `Track ${i}` })
        );
      }

      await flushWrites(svc);
      expect(svc.getEntries()).toHaveLength(3);
      expect(svc.getEntries().map((e) => e.title)).toEqual([
        "Track 4",
        "Track 3",
        "Track 2",
      ]);
    });
  });

  describe("M-3: insert is durable-or-nothing", () => {
    it("does NOT emit `inserted` and rolls back in-memory state when persist fails after startup", async () => {
      // Pre-M-3: schedulePersist was fire-and-forget and emit fired
      // immediately. A disk-full / permission-flip after startup
      // would broadcast revisions the file never received; on
      // restart the list reverted to the older file while /health
      // still reported OK.
      const transport = new FakeTransport();
      const filePath = await makeTmpPath();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath, suppressionWindowMs: 0 }
      );
      const inserts: string[] = [];
      svc.on("inserted", (e) => inserts.push(e.title ?? ""));
      await svc.start();

      // A first successful insert commits the baseline.
      transport.fireNowPlaying("zone-a", nowPlaying({ title: "Committed" }));
      await flushWrites(svc);
      expect(svc.getEntries().map((e) => e.title)).toEqual(["Committed"]);
      expect(inserts).toEqual(["Committed"]);

      // Now break the disk and fire another insert.
      const writeSpy = jest
        .spyOn(fs, "writeFile")
        .mockRejectedValue(new Error("ENOSPC: no space left"));
      try {
        transport.fireNowPlaying("zone-a", nowPlaying({ title: "Lost" }));
        await flushWrites(svc);

        // No inserted broadcast for the lost entry; in-memory list
        // matches the on-disk file (still just "Committed").
        expect(inserts).toEqual(["Committed"]);
        expect(svc.getEntries().map((e) => e.title)).toEqual(["Committed"]);

        const persistedAfter = (await readPersisted(filePath)) as Array<{
          title: string;
        }>;
        expect(persistedAfter.map((e) => e.title)).toEqual(["Committed"]);
      } finally {
        writeSpy.mockRestore();
      }

      // The chain isn't poisoned — once disk recovers, the next
      // insert commits normally and broadcasts.
      transport.fireNowPlaying("zone-a", nowPlaying({ title: "Recovered" }));
      await flushWrites(svc);
      expect(inserts).toEqual(["Committed", "Recovered"]);
      expect(svc.getEntries().map((e) => e.title)).toEqual([
        "Recovered",
        "Committed",
      ]);
    });

    it("preserves revision monotonicity across failed inserts", async () => {
      // The rollback also reverts the revision bump, so clients
      // don't see a "gap" or future-revision broadcast that never
      // happens. After a failed insert, the next successful insert
      // bumps revision from the pre-failure value.
      const transport = new FakeTransport();
      const filePath = await makeTmpPath();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath, suppressionWindowMs: 0 }
      );
      await svc.start();

      transport.fireNowPlaying("zone-a", nowPlaying({ title: "A" }));
      await flushWrites(svc);
      const revAfterA = svc.getRevision();
      expect(revAfterA).toBe(1);

      const writeSpy = jest
        .spyOn(fs, "writeFile")
        .mockRejectedValueOnce(new Error("transient I/O"));
      transport.fireNowPlaying("zone-a", nowPlaying({ title: "Failed" }));
      await flushWrites(svc);
      // Revision rolled back to pre-failure value.
      expect(svc.getRevision()).toBe(revAfterA);
      writeSpy.mockRestore();

      transport.fireNowPlaying("zone-a", nowPlaying({ title: "B" }));
      await flushWrites(svc);
      // Next successful insert bumps from the pre-failure base, not
      // from a phantom higher value.
      expect(svc.getRevision()).toBe(revAfterA + 1);
      expect(svc.getEntries().map((e) => e.title)).toEqual(["B", "A"]);
    });

    it("M-3 reopen: clear() and insert() FIFO-serialize on insertChain (no shared-revision broadcast)", async () => {
      // Reviewer race: clear was not on insertChain, so it could
      // start during the await between an insert's mutation and its
      // emit. Two ops would land at the same revision when the
      // server listener read getRevision() at emit time.
      // Now clear runs inside insertChain, so the order is:
      // insert.run -> clear.run, with distinct revisions.
      const transport = new FakeTransport();
      const filePath = await makeTmpPath();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath, suppressionWindowMs: 0 }
      );
      const events: Array<{ kind: string; rev: number }> = [];
      svc.on("inserted", () => events.push({ kind: "inserted", rev: svc.getRevision() }));
      svc.on("cleared", () => events.push({ kind: "cleared", rev: svc.getRevision() }));
      await svc.start();

      // Fire insert + clear back-to-back. With serialization the
      // insert's run (including its emit) completes before clear's
      // run starts.
      transport.fireNowPlaying("zone-a", nowPlaying({ title: "Track-A" }));
      const clearPromise = svc.clear();
      await clearPromise;
      await flushWrites(svc);

      expect(events.map((e) => e.kind)).toEqual(["inserted", "cleared"]);
      // Distinct revisions: insert bumped to 1, clear bumped to 2.
      expect(events[0].rev).toBe(1);
      expect(events[1].rev).toBe(2);
      expect(events[0].rev).not.toBe(events[1].rev);
      expect(svc.getEntries()).toEqual([]);
    });

    it("M-3 reopen: insert rollback cannot clobber a queued clear's revision", async () => {
      // Reviewer race #2: if insert's persist failed AFTER clear()
      // had already started and bumped revision, the rollback would
      // overwrite the clear's revision. Now the rollback runs to
      // completion before clear's chain entry even starts, so the
      // sequence is insert.rollback (rev=0) -> clear.mutate (rev=1).
      const transport = new FakeTransport();
      const filePath = await makeTmpPath();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath, suppressionWindowMs: 0 }
      );
      const events: Array<{ kind: string; rev: number }> = [];
      svc.on("inserted", () => events.push({ kind: "inserted", rev: svc.getRevision() }));
      svc.on("cleared", () => events.push({ kind: "cleared", rev: svc.getRevision() }));
      await svc.start();

      const writeSpy = jest
        .spyOn(fs, "writeFile")
        .mockRejectedValueOnce(new Error("insert persist failure"));
      transport.fireNowPlaying("zone-a", nowPlaying({ title: "Doomed" }));
      // Don't await between the fire and the clear — that's the
      // whole point of the race.
      const clearPromise = svc.clear();
      await clearPromise;
      writeSpy.mockRestore();
      await flushWrites(svc);

      // Insert's persist failed -> rollback, no emit, no rev bump.
      // Clear ran next on the chain, started from rev=0, bumped to
      // rev=1, persist succeeded, emitted.
      expect(events).toEqual([{ kind: "cleared", rev: 1 }]);
      expect(svc.getRevision()).toBe(1);
      expect(svc.getEntries()).toEqual([]);
    });
  });

  describe("persistence + recovery", () => {
    it("loads previously-persisted entries on start", async () => {
      const filePath = await makeTmpPath();
      const seed = [
        {
          title: "Old",
          zone_id: "zone-a",
          played_at: new Date().toISOString(),
        },
      ];
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, JSON.stringify(seed), "utf-8");

      const transport = new FakeTransport();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath }
      );
      await svc.start();

      expect(svc.getEntries()).toHaveLength(1);
      expect(svc.getEntries()[0].title).toBe("Old");
    });

    it("persists new entries to disk via atomic write (tmp + rename)", async () => {
      const transport = new FakeTransport();
      const filePath = await makeTmpPath();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath }
      );
      await svc.start();

      transport.fireNowPlaying("zone-a", nowPlaying({ title: "A" }));
      await flushWrites(svc);

      const persisted = (await readPersisted(filePath)) as Array<{
        title: string;
      }>;
      expect(persisted).toHaveLength(1);
      expect(persisted[0].title).toBe("A");

      // No leftover .tmp file.
      await expect(fs.access(`${filePath}.tmp`)).rejects.toThrow();
    });

    it("degrades on corrupt JSON and suppresses now-playing ingestion (file stays untouched)", async () => {
      // Old behavior: silently recover and continue ingesting. That
      // would overwrite the corrupt file with `{ entries, generation:
      // 0 }`, destroying the only evidence of the prior state AND
      // resetting the epoch (which would let restarted clients
      // reject events as stale). New behavior: degrade, don't attach
      // the listener, leave the file alone.
      const filePath = await makeTmpPath();
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const garbage = "{ not json";
      await fs.writeFile(filePath, garbage, "utf-8");

      const transport = new FakeTransport();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath }
      );
      await svc.start();

      expect(svc.isDegraded()).toBe(true);
      expect(svc.getEntries()).toEqual([]);

      // Listener not attached → fireNowPlaying is a no-op.
      transport.fireNowPlaying("zone-a", nowPlaying({ title: "A" }));
      await flushWrites(svc);
      expect(svc.getEntries()).toEqual([]);

      // File on disk is unchanged — degraded mode skips the eager
      // persist so the original (corrupt) content can be inspected
      // or restored from backup.
      expect(await fs.readFile(filePath, "utf-8")).toBe(garbage);
    });

    it("degrades when JSON is an object missing the entries array", async () => {
      // Generation present but no entries — the file isn't usable as
      // a snapshot. Degrade. The generation IS extracted internally
      // (so a follow-up clean run picks up the monotonic chain), but
      // we don't expose that here — just that the service refuses
      // to serve.
      const filePath = await makeTmpPath();
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, JSON.stringify({ generation: 12 }), "utf-8");

      const transport = new FakeTransport();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath }
      );
      await svc.start();

      expect(svc.isDegraded()).toBe(true);
    });

    it("degrades on an object file with entries but no generation field", async () => {
      // Same shape the service writes, MINUS generation. Could
      // happen via manual edit, partial truncation, or a schema we
      // don't recognize. Don't silently reset.
      const filePath = await makeTmpPath();
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(
        filePath,
        JSON.stringify({
          entries: [
            { title: "A", zone_id: "z1", played_at: new Date().toISOString() },
          ],
        }),
        "utf-8"
      );

      const transport = new FakeTransport();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath }
      );
      await svc.start();

      expect(svc.isDegraded()).toBe(true);
    });

    it("degrades when `generation` is malformed (negative, float, or NaN-shaped)", async () => {
      // Math.floor + Math.max(0, ...) coercion would silently turn
      // -1 into 0 and 12.5 into 12, both of which lose the monotonic
      // guarantee. Strict validation: non-negative safe integer or
      // degrade.
      const cases = [
        { generation: -1, entries: [] },
        { generation: 12.5, entries: [] },
        { generation: Number.NaN, entries: [] },
        { generation: "12", entries: [] },
        { generation: Number.MAX_SAFE_INTEGER + 1, entries: [] }, // unsafe
      ];

      for (const payload of cases) {
        const filePath = await makeTmpPath();
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, JSON.stringify(payload), "utf-8");

        const transport = new FakeTransport();
        const svc = new RecentlyPlayedService(
          transport as unknown as TransportService,
          mockLogger,
          { filePath }
        );
        await svc.start();
        expect(svc.isDegraded()).toBe(true);
      }
    });

    it("clear() rejects when degraded so the persisted file isn't overwritten", async () => {
      // The route already 503s, but the invariant belongs in the
      // service too — protects against any future caller (or
      // misuse) that bypasses the route layer.
      const filePath = await makeTmpPath();
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const garbage = "{ not json";
      await fs.writeFile(filePath, garbage, "utf-8");

      const transport = new FakeTransport();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath }
      );
      await svc.start();
      expect(svc.isDegraded()).toBe(true);

      await expect(svc.clear()).rejects.toThrow(/degraded/);

      // File untouched.
      await flushWrites(svc);
      expect(await fs.readFile(filePath, "utf-8")).toBe(garbage);
    });

    it("dedupes legacy duplicates from the persisted file on load", async () => {
      // A file written before move-to-front dedup can hold the same
      // track twice. loadFromDisk must collapse it, keeping the
      // newest (first) occurrence — otherwise the duplicate surfaces
      // via /api/recently-played until that track happens to replay.
      const filePath = await makeTmpPath();
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const seed = [
        {
          title: "A",
          artist: "Artist",
          album: "Album",
          duration: 180,
          image_key: "img",
          zone_id: "z1",
          played_at: "2026-05-14T03:00:00.000Z",
        },
        {
          title: "B",
          zone_id: "z1",
          played_at: "2026-05-14T02:00:00.000Z",
        },
        {
          title: "A",
          artist: "Artist",
          album: "Album",
          duration: 180,
          image_key: "img",
          zone_id: "z1",
          played_at: "2026-05-14T01:00:00.000Z",
        },
      ];
      await fs.writeFile(filePath, JSON.stringify(seed), "utf-8");

      const transport = new FakeTransport();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath }
      );
      await svc.start();

      expect(svc.getEntries().map((e) => e.title)).toEqual(["A", "B"]);
      expect(svc.getEntries()[0].played_at).toBe("2026-05-14T03:00:00.000Z");
    });

    it("increments + persists the generation on each start (monotonic epoch source)", async () => {
      const filePath = await makeTmpPath();
      const transport = new FakeTransport();

      // First start: file doesn't exist → generation starts at 0 →
      // epoch = 1, persisted immediately.
      const svc1 = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath }
      );
      await svc1.start();
      expect(svc1.getEpoch()).toBe(1);

      const raw1 = (await readPersistedRaw(filePath)) as {
        entries: unknown[];
        generation: number;
      };
      expect(raw1.generation).toBe(1);
      expect(raw1.entries).toEqual([]);

      // Second start (simulating a restart): loads generation=1,
      // bumps to epoch=2, persists.
      const svc2 = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath }
      );
      await svc2.start();
      expect(svc2.getEpoch()).toBe(2);

      const raw2 = (await readPersistedRaw(filePath)) as { generation: number };
      expect(raw2.generation).toBe(2);
    });

    it("start() is idempotent — second call returns the same promise and does NOT re-bump generation", async () => {
      // Now that loadFromDisk persists an incremented generation,
      // repeated start() calls would otherwise advance the epoch
      // every time AND reload disk over current in-memory state.
      const filePath = await makeTmpPath();
      const transport = new FakeTransport();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath }
      );

      const p1 = svc.start();
      const p2 = svc.start();
      expect(p1).toBe(p2);
      await p1;
      expect(svc.getEpoch()).toBe(1);

      // Mutate via an insert (revision should advance).
      transport.fireNowPlaying("zone-a", nowPlaying({ title: "A" }));
      await flushWrites(svc);
      expect(svc.getRevision()).toBe(1);

      // Repeated start() must NOT reload disk over the in-memory
      // entry or bump epoch.
      await svc.start();
      expect(svc.getEpoch()).toBe(1);
      expect(svc.getEntries().map((e) => e.title)).toEqual(["A"]);
    });

    it("start(); stop(); start() during in-flight startup: one listener + one generation bump for the effective restart", async () => {
      // Race: doStart1 captures token, awaits readFromDisk; stop()
      // bumps the token + clears the memo; start() launches doStart2
      // before doStart1 resumes. doStart1 must NOT bump epoch or
      // persist — only doStart2 (the effective restart) should.
      // Verified deterministically by spying on fs.writeFile and
      // counting persist calls: should be exactly 1 (doStart2's
      // eager generation persist), not 2.
      const filePath = await makeTmpPath();
      const transport = new FakeTransport();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath }
      );

      const writeSpy = jest.spyOn(fs, "writeFile");
      try {
        const p1 = svc.start();
        svc.stop();
        const p2 = svc.start();
        await Promise.all([p1, p2]);

        // Filter to writes targeting THIS service's tmp file. Other
        // fs.writeFile calls in the process (e.g., test scaffolding,
        // other tests' parallel work even in --runInBand if shared
        // module state caused leaks) shouldn't pollute the count.
        const ourWrites = writeSpy.mock.calls.filter(
          ([path]) => typeof path === "string" && path.startsWith(filePath)
        );
        // Exactly one eager persist for the effective restart.
        // doStart1 cancelled before its bump, so it queued nothing.
        expect(ourWrites).toHaveLength(1);

        // Exactly one bump (no skipped generations).
        expect(svc.getEpoch()).toBe(1);

        // Exactly one listener. A doubled listener would emit
        // `inserted` twice for the same event.
        const inserts: unknown[] = [];
        svc.on("inserted", (e) => inserts.push(e));
        transport.fireNowPlaying(
          "zone-a",
          nowPlaying({ title: "After Restart" })
        );
        await flushWrites(svc);
        expect(inserts).toHaveLength(1);
      } finally {
        writeSpy.mockRestore();
      }
    });

    it("stop() + start() recovers from degraded mode if the file gets fixed in between", async () => {
      // Degraded should not be a process-lifetime sticky state — an
      // in-process restart (e.g., during admin recovery) must be able
      // to clear it once the underlying problem is resolved.
      const filePath = await makeTmpPath();
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, "{ not json", "utf-8");

      const transport = new FakeTransport();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath }
      );
      await svc.start();
      expect(svc.isDegraded()).toBe(true);

      // Admin fixes the file (or restores from backup).
      svc.stop();
      await fs.writeFile(
        filePath,
        JSON.stringify({ entries: [], generation: 5 }),
        "utf-8"
      );
      await svc.start();

      expect(svc.isDegraded()).toBe(false);
      // Generation bumped from the fixed file's 5 → 6.
      expect(svc.getEpoch()).toBe(6);

      // Listener attached again — ingestion works.
      transport.fireNowPlaying("zone-a", nowPlaying({ title: "Recovered" }));
      await flushWrites(svc);
      expect(svc.getEntries().map((e) => e.title)).toEqual(["Recovered"]);
    });

    it("stop() during in-flight start() cancels listener attach", async () => {
      // Without a cancellation token, an in-flight doStart resuming
      // after stop() would still attach its listener, leaving a
      // ghost handler that mutates state after the caller asked the
      // service to stop.
      const filePath = await makeTmpPath();
      const transport = new FakeTransport();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath }
      );

      const startPromise = svc.start();
      // Sync slice of doStart has run (token captured, loadFromDisk
      // initiated and now awaiting fs.readFile). Yank the rug:
      svc.stop();
      await startPromise;

      // Listener never attached — fireNowPlaying is a no-op.
      transport.fireNowPlaying("zone-a", nowPlaying({ title: "Ghost" }));
      await flushWrites(svc);
      expect(svc.getEntries()).toEqual([]);

      // A subsequent start() runs cleanly with a fresh attach.
      await svc.start();
      transport.fireNowPlaying("zone-a", nowPlaying({ title: "Real" }));
      await flushWrites(svc);
      expect(svc.getEntries().map((e) => e.title)).toEqual(["Real"]);
    });

    it("stop() then start() reattaches the listener and bumps generation again", async () => {
      // The start memoization is reset by stop() so a true restart
      // cycle works. Each cycle conceptually represents a new
      // server instance, so the generation advances every time.
      const filePath = await makeTmpPath();
      const transport = new FakeTransport();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath }
      );

      await svc.start();
      expect(svc.getEpoch()).toBe(1);

      svc.stop();
      transport.fireNowPlaying("zone-a", nowPlaying({ title: "Ignored" }));
      await flushWrites(svc);
      expect(svc.getEntries()).toHaveLength(0);

      await svc.start();
      expect(svc.getEpoch()).toBe(2);

      transport.fireNowPlaying("zone-a", nowPlaying({ title: "Heard" }));
      await flushWrites(svc);
      expect(svc.getEntries().map((e) => e.title)).toEqual(["Heard"]);
    });

    it("enters degraded mode when the eager generation persist fails", async () => {
      // Unwritable path: file-as-parent-dir trick → mkdir ENOTDIR
      // during the eager persist.
      const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "rp-degraded-"));
      const blocker = path.join(tmpdir, "blocker");
      await fs.writeFile(blocker, "");
      const badPath = path.join(blocker, "recently-played.json");

      const transport = new FakeTransport();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath: badPath }
      );

      expect(svc.isDegraded()).toBe(false);
      await svc.start();
      // Eager persist failed → degraded so callers (routes / socket
      // emit handlers) can refuse to serve from the uncommitted epoch.
      expect(svc.isDegraded()).toBe(true);
    });

    it("migrates a legacy bare-array file to the new {entries, generation} shape", async () => {
      const filePath = await makeTmpPath();
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const legacy = [
        {
          title: "Hey Jude",
          zone_id: "zone-a",
          played_at: "2026-05-08T00:00:00.000Z",
        },
      ];
      await fs.writeFile(filePath, JSON.stringify(legacy), "utf-8");

      const transport = new FakeTransport();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath }
      );
      await svc.start();

      // Entries survived migration; epoch starts at 1 (legacy file had
      // no persisted generation, so we treat it as 0).
      expect(svc.getEntries().map((e) => e.title)).toEqual(["Hey Jude"]);
      expect(svc.getEpoch()).toBe(1);

      // File is now in the new shape.
      const raw = (await readPersistedRaw(filePath)) as Record<string, unknown>;
      expect(Array.isArray(raw)).toBe(false);
      expect(Array.isArray(raw.entries)).toBe(true);
      expect(raw.generation).toBe(1);
    });

    it("filters out implausible entries when loading", async () => {
      const filePath = await makeTmpPath();
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const mixed = [
        { title: "Good", zone_id: "z1", played_at: new Date().toISOString() },
        { title: "Bad — no zone_id", played_at: new Date().toISOString() },
        { duration: "not a number", zone_id: "z1", played_at: new Date().toISOString() },
        null,
        "not even an object",
      ];
      await fs.writeFile(filePath, JSON.stringify(mixed), "utf-8");

      const transport = new FakeTransport();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath }
      );
      await svc.start();

      expect(svc.getEntries()).toHaveLength(1);
      expect(svc.getEntries()[0].title).toBe("Good");
    });

    it("first-run empty file path doesn't throw (ENOENT is graceful)", async () => {
      const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "rp-"));
      const filePath = path.join(tmpdir, "nope-not-yet.json");

      const transport = new FakeTransport();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath }
      );
      await svc.start();

      expect(svc.getEntries()).toEqual([]);
    });
  });

  describe("zone-name lookup", () => {
    it("stamps the zone display name onto each entry at insert time", async () => {
      const transport = new FakeTransport();
      const filePath = await makeTmpPath();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath }
      );
      svc.setZoneNameLookup((zoneId) =>
        zoneId === "zone-a" ? "Living Room" : undefined
      );
      await svc.start();

      transport.fireNowPlaying("zone-a", nowPlaying({ title: "A" }));
      transport.fireNowPlaying("zone-b", nowPlaying({ title: "B", zone_id: "zone-b" }));

      await flushWrites(svc);
      const entries = svc.getEntries();
      expect(entries[1].zone_name).toBe("Living Room");
      expect(entries[0].zone_name).toBeUndefined();
    });
  });

  describe("stop()", () => {
    it("detaches the now-playing listener", async () => {
      const transport = new FakeTransport();
      const filePath = await makeTmpPath();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath }
      );
      await svc.start();

      transport.fireNowPlaying("zone-a", nowPlaying({ title: "Before" }));
      await flushWrites(svc);
      svc.stop();
      transport.fireNowPlaying("zone-a", nowPlaying({ title: "After" }));

      await flushWrites(svc);
      expect(svc.getEntries().map((e) => e.title)).toEqual(["Before"]);
    });
  });

  describe("encoding repair", () => {
    const mojibake = (value: string): string =>
      Buffer.from(value, "utf8").toString("latin1");

    it("repairs mojibake now-playing strings at insertion", async () => {
      const transport = new FakeTransport();
      const filePath = await makeTmpPath();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath }
      );
      await svc.start();

      transport.fireNowPlaying(
        "zone-a",
        nowPlaying({
          title: mojibake("Don’t Stop"),
          artist: mojibake("Café Tacvba"),
          album: mojibake("Re – deluxe"),
        })
      );
      await flushWrites(svc);

      const entry = svc.getEntries()[0];
      expect(entry.title).toBe("Don’t Stop");
      expect(entry.artist).toBe("Café Tacvba");
      expect(entry.album).toBe("Re – deluxe");

      const persisted = (await readPersisted(filePath)) as Array<{
        title?: string;
      }>;
      expect(persisted[0].title).toBe("Don’t Stop");
      svc.stop();
    });

    it("repairs mojibake in entries persisted before the repair existed", async () => {
      const filePath = await makeTmpPath();
      const seed = {
        generation: 3,
        entries: [
          {
            title: mojibake("Don’t Stop"),
            artist: mojibake("Café Tacvba"),
            zone_id: "zone-a",
            played_at: new Date().toISOString(),
          },
        ],
      };
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, JSON.stringify(seed), "utf-8");

      const transport = new FakeTransport();
      const svc = new RecentlyPlayedService(
        transport as unknown as TransportService,
        mockLogger,
        { filePath }
      );
      await svc.start();

      expect(svc.getEntries()[0].title).toBe("Don’t Stop");
      expect(svc.getEntries()[0].artist).toBe("Café Tacvba");
      svc.stop();
    });
  });
});
