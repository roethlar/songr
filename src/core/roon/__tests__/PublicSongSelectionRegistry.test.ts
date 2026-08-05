import {
  DEFAULT_PUBLIC_SONG_SELECTION_LIMIT,
  DEFAULT_PUBLIC_SONG_SELECTION_TTL_MS,
  PublicSongSelection,
  PublicSongSelectionRegistry,
  PublicSongSelectionRegistryError,
} from "../PublicSongSelectionRegistry";

function selection(
  overrides: Partial<PublicSongSelection> = {}
): PublicSongSelection {
  return {
    coreId: "core-a",
    title: "Seven Nation Army",
    artist: "The White Stripes",
    albumTitle: "Elephant",
    lengthSeconds: 232,
    source: {
      kind: "smart-playlist",
      playlistId: "2801d5fa",
      position: 182,
      playlistItemId: "9001",
      nativeTrackId: "7001",
    },
    ...overrides,
  };
}

function expectCode(
  work: () => unknown,
  code: PublicSongSelectionRegistryError["code"]
): void {
  try {
    work();
    throw new Error("expected registry call to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(PublicSongSelectionRegistryError);
    expect((error as PublicSongSelectionRegistryError).code).toBe(code);
  }
}

describe("PublicSongSelectionRegistry", () => {
  it("uses the approved thirty-minute and 4,096-per-Core defaults", () => {
    expect(DEFAULT_PUBLIC_SONG_SELECTION_TTL_MS).toBe(30 * 60 * 1_000);
    expect(DEFAULT_PUBLIC_SONG_SELECTION_LIMIT).toBe(4_096);

    let id = 0;
    const registry = new PublicSongSelectionRegistry({
      maxEntries: 2,
      randomId: () => `id-${(id += 1)}`,
    });
    const firstA = registry.publish(selection({ title: "first-a" }));
    const secondA = registry.publish(selection({ title: "second-a" }));
    const firstB = registry.publish(
      selection({ coreId: "core-b", title: "first-b" })
    );
    const thirdA = registry.publish(selection({ title: "third-a" }));

    expectCode(() => registry.resolve(firstA, "core-a"), "STALE_SELECTION");
    expect(registry.resolve(secondA, "core-a").title).toBe("second-a");
    expect(registry.resolve(thirdA, "core-a").title).toBe("third-a");
    expect(registry.resolve(firstB, "core-b").title).toBe("first-b");
  });

  it("publishes opaque immutable Core-scoped source authority", () => {
    const source = selection();
    const registry = new PublicSongSelectionRegistry({
      randomId: () => "opaque",
    });
    const id = registry.publish(source);
    (source.source as { position: number }).position = 999;
    source.title = "changed";

    expect(id).toMatch(/^public-song-selection-opaque-/u);
    expect(id).not.toContain("Seven");
    const retained = registry.resolve(id, "core-a");
    expect(retained).toEqual(selection());
    expect(Object.isFrozen(retained)).toBe(true);
    expect(Object.isFrozen(retained.source)).toBe(true);
    expect(() => registry.resolve(id, "core-b")).toThrow(
      "different Core"
    );
  });

  it("uses nullable native track identity only for Most Played drill anchors", () => {
    let id = 0;
    const registry = new PublicSongSelectionRegistry({
      randomId: () => `most-played-${(id += 1)}`,
    });
    const performer = registry.publish(
      selection({
        title: "Lio-Marcus Mendel",
        artist: "",
        albumTitle: "",
        lengthSeconds: null,
        source: {
          kind: "most-played",
          snapshotPulledAt: "2026-07-26T12:00:00.000Z",
          view: "performer",
          sourceEntityId: "777",
          nativeTrackId: null,
        },
      })
    );
    const release = registry.publish(
      selection({
        title: "Hamilton",
        artist: "Various Artists",
        albumTitle: "Hamilton",
        lengthSeconds: null,
        source: {
          kind: "most-played",
          snapshotPulledAt: "2026-07-26T12:00:00.000Z",
          view: "release",
          sourceEntityId: "4242",
          nativeTrackId: null,
        },
      })
    );

    expect(registry.resolve(performer, "core-a").source).toMatchObject({
      view: "performer",
      nativeTrackId: null,
    });
    expect(registry.resolve(release, "core-a").source).toMatchObject({
      view: "release",
      nativeTrackId: null,
    });
    expectCode(
      () =>
        registry.publish(
          selection({
            source: {
              kind: "most-played",
              snapshotPulledAt: "2026-07-26T12:00:00.000Z",
              view: "tracks",
              sourceEntityId: "7001",
              nativeTrackId: null,
            },
          })
        ),
      "INVALID_SELECTION"
    );
  });

  it("accepts nullable smart track ids only with stable item or complete tuple fallback", () => {
    let id = 0;
    const registry = new PublicSongSelectionRegistry({
      randomId: () => `fallback-${(id += 1)}`,
    });
    const itemBound = registry.publish(
      selection({
        artist: "",
        albumTitle: "",
        lengthSeconds: null,
        source: {
          kind: "smart-playlist",
          playlistId: "2801d5fa",
          position: 182,
          playlistItemId: "9001",
          nativeTrackId: null,
        },
      })
    );
    expect(registry.resolve(itemBound, "core-a").source).toMatchObject({
      playlistItemId: "9001",
      nativeTrackId: null,
    });

    const tupleBound = registry.publish(
      selection({
        source: {
          kind: "smart-playlist",
          playlistId: "2801d5fa",
          position: 182,
          playlistItemId: null,
          nativeTrackId: null,
        },
      })
    );
    expect(registry.resolve(tupleBound, "core-a")).toMatchObject({
      title: "Seven Nation Army",
      artist: "The White Stripes",
      albumTitle: "Elephant",
      lengthSeconds: 232,
    });

    for (const incomplete of [
      selection({
        artist: "",
        source: {
          kind: "smart-playlist",
          playlistId: "2801d5fa",
          position: 182,
          playlistItemId: null,
          nativeTrackId: null,
        },
      }),
      selection({
        albumTitle: "",
        source: {
          kind: "smart-playlist",
          playlistId: "2801d5fa",
          position: 182,
          playlistItemId: null,
          nativeTrackId: null,
        },
      }),
      selection({
        lengthSeconds: null,
        source: {
          kind: "smart-playlist",
          playlistId: "2801d5fa",
          position: 182,
          playlistItemId: null,
          nativeTrackId: null,
        },
      }),
    ]) {
      expectCode(() => registry.publish(incomplete), "INVALID_SELECTION");
    }
  });

  it("expires available authority and reports the same stale result for unknown ids", () => {
    let now = 10;
    const registry = new PublicSongSelectionRegistry({
      ttlMs: 20,
      now: () => now,
      randomId: () => "id",
    });
    const id = registry.publish(selection());
    now = 30;

    expectCode(() => registry.resolve(id, "core-a"), "STALE_SELECTION");
    expectCode(
      () => registry.resolve("public-song-selection-missing", "core-a"),
      "STALE_SELECTION"
    );
    expect(registry.size).toBe(0);
  });

  it("enforces single-flight issue, restores only pre-issue failures, and retires terminal outcomes", () => {
    let now = 100;
    const registry = new PublicSongSelectionRegistry({
      ttlMs: 50,
      now: () => now,
      randomId: () => "id",
    });
    const id = registry.publish(selection());
    const issue = registry.beginIssue(id, "core-a");
    expectCode(() => registry.resolve(id, "core-a"), "IN_FLIGHT");
    expectCode(() => registry.beginIssue(id, "core-a"), "IN_FLIGHT");

    expect(registry.restore(issue)).toBe(true);
    const second = registry.beginIssue(id, "core-a");
    registry.retire(second);
    expectCode(() => registry.resolve(id, "core-a"), "STALE_SELECTION");

    const expiring = registry.publish(selection());
    const expiredIssue = registry.beginIssue(expiring, "core-a");
    now = 151;
    expect(registry.restore(expiredIssue)).toBe(false);
    expectCode(
      () => registry.resolve(expiring, "core-a"),
      "STALE_SELECTION"
    );
  });

  it("evicts the oldest available entry but never an issuing entry", () => {
    let now = 0;
    let id = 0;
    const registry = new PublicSongSelectionRegistry({
      maxEntries: 2,
      now: () => now,
      randomId: () => `id-${(id += 1)}`,
    });
    const first = registry.publish(selection({ title: "first" }));
    now = 1;
    const second = registry.publish(selection({ title: "second" }));
    const issuing = registry.beginIssue(first, "core-a");
    now = 2;
    const third = registry.publish(selection({ title: "third" }));

    expectCode(() => registry.resolve(first, "core-a"), "IN_FLIGHT");
    expectCode(() => registry.resolve(second, "core-a"), "STALE_SELECTION");
    expect(registry.resolve(third, "core-a").title).toBe("third");

    const thirdIssue = registry.beginIssue(third, "core-a");
    expectCode(
      () => registry.publish(selection({ title: "blocked" })),
      "BACKPRESSURE"
    );
    registry.retire(issuing);
    registry.retire(thirdIssue);
  });

  it("clears one Core without invalidating another", () => {
    const registry = new PublicSongSelectionRegistry({
      randomId: () => "id",
    });
    const first = registry.publish(selection());
    const second = registry.publish(selection({ coreId: "core-b" }));
    registry.clearCore("core-a");

    expectCode(() => registry.resolve(first, "core-a"), "STALE_SELECTION");
    expect(registry.resolve(second, "core-b").coreId).toBe("core-b");
  });

  it("invalidates stale available sources and guards exact-handoff issue leases", () => {
    const registry = new PublicSongSelectionRegistry({
      randomId: () => "id",
    });
    const stale = registry.publish(selection());
    registry.invalidate(stale, "core-a");
    expectCode(() => registry.resolve(stale, "core-a"), "STALE_SELECTION");

    const live = registry.publish(selection());
    const issue = registry.beginIssue(live, "core-a");
    expect(registry.assertIssue(issue)).toEqual(selection());
    expectCode(() => registry.invalidate(live, "core-a"), "IN_FLIGHT");
    registry.retire(issue);
    expectCode(() => registry.assertIssue(issue), "ISSUE_MISMATCH");
  });

  it("rejects malformed source proofs and invalid limits", () => {
    const registry = new PublicSongSelectionRegistry();
    expectCode(
      () =>
        registry.publish(
          selection({
            source: {
              kind: "smart-playlist",
              playlistId: "xyz",
              position: 0,
              playlistItemId: null,
              nativeTrackId: "1",
            },
          })
        ),
      "INVALID_SELECTION"
    );
    expectCode(
      () => new PublicSongSelectionRegistry({ maxEntries: 0 }),
      "INVALID_SELECTION"
    );
  });
});
