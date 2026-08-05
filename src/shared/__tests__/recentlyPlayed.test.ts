import {
  recentlyPlayedDedupeKey,
  dedupeRecentlyPlayed,
} from "../recentlyPlayed";
import type { RecentlyPlayedEntry } from "../types";

function entry(over: Partial<RecentlyPlayedEntry> = {}): RecentlyPlayedEntry {
  return {
    title: "Track",
    artist: "Artist",
    album: "Album",
    duration: 180,
    image_key: "img-1",
    zone_id: "zone-a",
    played_at: "2026-05-14T00:00:00.000Z",
    ...over,
  };
}

describe("recentlyPlayedDedupeKey", () => {
  it("treats same track / different zone / different time as the same key", () => {
    const a = entry({ zone_id: "zone-a", played_at: "2026-05-14T00:00:00.000Z" });
    const b = entry({ zone_id: "zone-b", played_at: "2026-05-14T01:00:00.000Z" });
    expect(recentlyPlayedDedupeKey(a)).toBe(recentlyPlayedDedupeKey(b));
  });

  it("does NOT collide when metadata contains the old '|' delimiter", () => {
    // Delimiter-joined keys would render both as "A|B|C|...".
    const x = entry({ title: "A|B", artist: "C" });
    const y = entry({ title: "A", artist: "B|C" });
    expect(recentlyPlayedDedupeKey(x)).not.toBe(recentlyPlayedDedupeKey(y));
  });

  it("distinguishes entries that differ only in one field", () => {
    expect(recentlyPlayedDedupeKey(entry({ title: "X" }))).not.toBe(
      recentlyPlayedDedupeKey(entry({ title: "Y" }))
    );
    expect(recentlyPlayedDedupeKey(entry({ duration: 180 }))).not.toBe(
      recentlyPlayedDedupeKey(entry({ duration: 181 }))
    );
  });

  it("treats a missing field and an empty string as distinct", () => {
    // null (absent) vs "" — JSON tuple keeps them apart; a joined
    // string would render both as the same empty slot.
    expect(recentlyPlayedDedupeKey(entry({ artist: undefined }))).not.toBe(
      recentlyPlayedDedupeKey(entry({ artist: "" }))
    );
  });
});

describe("dedupeRecentlyPlayed", () => {
  it("keeps the first occurrence of each key (newest play wins)", () => {
    const list = [
      entry({ title: "A", played_at: "2026-05-14T03:00:00.000Z" }),
      entry({ title: "B", played_at: "2026-05-14T02:00:00.000Z" }),
      entry({ title: "A", played_at: "2026-05-14T01:00:00.000Z" }),
    ];
    const out = dedupeRecentlyPlayed(list);
    expect(out.map((e) => e.title)).toEqual(["A", "B"]);
    expect(out[0].played_at).toBe("2026-05-14T03:00:00.000Z");
  });

  it("is a no-op on an already-unique list", () => {
    const list = [entry({ title: "A" }), entry({ title: "B" })];
    expect(dedupeRecentlyPlayed(list)).toEqual(list);
  });

  it("returns an empty list unchanged", () => {
    expect(dedupeRecentlyPlayed([])).toEqual([]);
  });
});
