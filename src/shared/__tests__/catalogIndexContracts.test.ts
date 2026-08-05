import {
  buildCatalogIndexResponse,
  normalizeCatalogIndexResponse,
  type CatalogIndexResponse,
} from "../catalogIndexContracts";
import type {
  AlbumRef,
  ArtistRef,
  CatalogStatus,
} from "../timelineCatalogContracts";

const ARTIST_ID = "10000000-0000-4000-8000-000000000001";
const ARTIST_ID_2 = "10000000-0000-4000-8000-000000000002";
const ALBUM_ID = "20000000-0000-4000-8000-000000000001";
const ALBUM_ID_2 = "20000000-0000-4000-8000-000000000002";
const OBSERVED_AT = "2026-07-15T00:00:00.000Z";

function status(): CatalogStatus {
  return {
    coreId: "core-a",
    freshness: "fresh",
    persistence: "healthy",
    refresh: "idle",
    available: true,
    complete: true,
    revision: 1,
    artistCount: 2,
    albumCount: 2,
    updatedAt: OBSERVED_AT,
    lastCompleteScanAt: OBSERVED_AT,
  };
}

function artist(localId = ARTIST_ID, exactName = "Björk"): ArtistRef {
  return {
    localId,
    coreId: "core-a",
    exactName,
    normalizedName: exactName.toLocaleLowerCase("en-US"),
    firstSeenAt: OBSERVED_AT,
    lastSeenAt: OBSERVED_AT,
    resolutionStatus: "resolved",
  };
}

function album(
  localId = ALBUM_ID,
  over: Partial<AlbumRef> = {}
): AlbumRef {
  return {
    localId,
    coreId: "core-a",
    artistLocalId: ARTIST_ID,
    exactTitle: "Homogenic",
    exactArtist: "Björk",
    normalizedTitle: "homogenic",
    normalizedArtist: "björk",
    editionText: "",
    firstSeenAt: OBSERVED_AT,
    lastSeenAt: OBSERVED_AT,
    resolutionStatus: "resolved",
    imageKeyHint: "img-1",
    ...over,
  } as AlbumRef;
}

function unboundAlbum(): AlbumRef {
  const value = album(ALBUM_ID_2, {
    exactTitle: "Mystery",
    normalizedTitle: "mystery",
    resolutionStatus: "ambiguous",
  });
  delete (value as unknown as Record<string, unknown>).artistLocalId;
  delete (value as unknown as Record<string, unknown>).imageKeyHint;
  return value;
}

function wireCopy(value: CatalogIndexResponse): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe("buildCatalogIndexResponse", () => {
  it("emits honest counts and preserves unbound albums", () => {
    const built = buildCatalogIndexResponse(status(), {
      artists: [artist(), artist(ARTIST_ID_2, "Ãtest")],
      albums: [album(), unboundAlbum()],
    });
    expect(built.artists).toEqual([
      {
        localId: ARTIST_ID,
        name: "Björk",
        knownAlbumCount: 1,
        countComplete: false,
      },
      {
        localId: ARTIST_ID_2,
        name: "Ãtest",
        knownAlbumCount: 0,
        countComplete: false,
      },
    ]);
    expect(built.albums[1]).toEqual({
      localId: ALBUM_ID_2,
      resolutionStatus: "ambiguous",
      title: "Mystery",
      artist: "Björk",
    });
  });

  it("marks counts complete only when every album is bound", () => {
    const built = buildCatalogIndexResponse(status(), {
      artists: [artist()],
      albums: [album()],
    });
    expect(built.artists[0].countComplete).toBe(true);
  });
});

describe("normalizeCatalogIndexResponse", () => {
  function valid(): CatalogIndexResponse {
    return buildCatalogIndexResponse(status(), {
      artists: [artist(), artist(ARTIST_ID_2, "Second")],
      albums: [album(), unboundAlbum()],
    });
  }

  it("round-trips a built index over the wire", () => {
    const built = valid();
    expect(normalizeCatalogIndexResponse(wireCopy(built))).toEqual(built);
  });

  it.each<[string, (value: any) => void]>([
    ["extra top-level key", (v) => (v.extra = 1)],
    ["invalid status", (v) => (v.status.freshness = "great")],
    ["non-array artists", (v) => (v.artists = {})],
    ["artist extra key", (v) => (v.artists[0].extra = 1)],
    ["bad artist localId", (v) => (v.artists[0].localId = "nope")],
    [
      "duplicate artist localId",
      (v) => (v.artists[1].localId = v.artists[0].localId),
    ],
    ["control character in name", (v) => (v.artists[0].name = "a\u0007b")],
    ["dishonest knownAlbumCount", (v) => (v.artists[0].knownAlbumCount = 5)],
    ["dishonest countComplete", (v) => (v.artists[0].countComplete = true)],
    ["album extra key", (v) => (v.albums[0].originalReleaseYear = 1997)],
    ["bad album localId", (v) => (v.albums[0].localId = "nope")],
    [
      "duplicate album localId",
      (v) => (v.albums[1].localId = v.albums[0].localId),
    ],
    ["unknown resolution status", (v) => (v.albums[0].resolutionStatus = "ok")],
    ["empty album title", (v) => (v.albums[0].title = "")],
    [
      "binding to unlisted artist",
      (v) =>
        (v.albums[0].artistLocalId = "30000000-0000-4000-8000-000000000003"),
    ],
    ["empty imageKeyHint", (v) => (v.albums[0].imageKeyHint = "")],
  ])("rejects %s", (_name, mutate) => {
    const damaged = wireCopy(valid()) as any;
    mutate(damaged);
    expect(normalizeCatalogIndexResponse(damaged)).toBeNull();
  });

  it("rejects non-record values", () => {
    expect(normalizeCatalogIndexResponse(null)).toBeNull();
    expect(normalizeCatalogIndexResponse([])).toBeNull();
    expect(normalizeCatalogIndexResponse("index")).toBeNull();
  });
});

describe("native capability field (Slice 4)", () => {
  function valid(): CatalogIndexResponse {
    return buildCatalogIndexResponse(
      status(),
      {
        artists: [artist()],
        albums: [album()],
      },
      { dateFeaturesAvailable: true, playFeaturesAvailable: true, playlistFeaturesAvailable: true }
    );
  }

  it("round-trips the capability field over the wire", () => {
    const built = valid();
    expect(built.native).toEqual({
      dateFeaturesAvailable: true,
      playFeaturesAvailable: true,
      playlistFeaturesAvailable: true,
    });
    expect(normalizeCatalogIndexResponse(wireCopy(built))).toEqual(built);
  });

  it("carries the honest reason exactly when date features are unavailable", () => {
    const built = buildCatalogIndexResponse(
      status(),
      { artists: [artist()], albums: [album()] },
      {
        dateFeaturesAvailable: false,
        dateFeaturesUnavailableReason:
          "no native catalog snapshot is available",
        playFeaturesAvailable: true,
        playlistFeaturesAvailable: true,
      }
    );
    expect(normalizeCatalogIndexResponse(wireCopy(built))).toEqual(built);
  });

  it("carries the honest reason exactly when play features are unavailable", () => {
    const built = buildCatalogIndexResponse(
      status(),
      { artists: [artist()], albums: [album()] },
      {
        dateFeaturesAvailable: true,
        playFeaturesAvailable: false,
        playFeaturesUnavailableReason:
          "the Core does not report play-statistics support; most played is unavailable",
        playlistFeaturesAvailable: true,
      }
    );
    expect(normalizeCatalogIndexResponse(wireCopy(built))).toEqual(built);
  });

  it("carries the honest reason exactly when playlist features are unavailable", () => {
    const built = buildCatalogIndexResponse(
      status(),
      { artists: [artist()], albums: [album()] },
      {
        dateFeaturesAvailable: true,
        playFeaturesAvailable: true,
        playlistFeaturesAvailable: false,
        playlistFeaturesUnavailableReason:
          "the native playlist list has not been pulled yet; it arrives with the next catalog refresh",
      }
    );
    expect(normalizeCatalogIndexResponse(wireCopy(built))).toEqual(built);
  });

  it("omits the field cleanly when the server did not evaluate it", () => {
    const built = buildCatalogIndexResponse(status(), {
      artists: [artist()],
      albums: [album()],
    });
    expect(built).not.toHaveProperty("native");
    expect(normalizeCatalogIndexResponse(wireCopy(built))).toEqual(built);
  });

  it.each<[string, (value: any) => void]>([
    ["an available flag with a reason", (v) => {
      v.native = {
        dateFeaturesAvailable: true,
        dateFeaturesUnavailableReason: "contradiction",
        playFeaturesAvailable: true,
        playlistFeaturesAvailable: true,
      };
    }],
    ["an unavailable flag without a reason", (v) => {
      v.native = { dateFeaturesAvailable: false, playFeaturesAvailable: true, playlistFeaturesAvailable: true };
    }],
    ["an available play flag with a reason", (v) => {
      v.native = {
        dateFeaturesAvailable: true,
        playFeaturesAvailable: true,
        playFeaturesUnavailableReason: "contradiction",
        playlistFeaturesAvailable: true,
      };
    }],
    ["an unavailable play flag without a reason", (v) => {
      v.native = { dateFeaturesAvailable: true, playFeaturesAvailable: false, playlistFeaturesAvailable: true };
    }],
    ["an available playlist flag with a reason", (v) => {
      v.native = {
        dateFeaturesAvailable: true,
        playFeaturesAvailable: true,
        playlistFeaturesAvailable: true,
        playlistFeaturesUnavailableReason: "contradiction",
      };
    }],
    ["an unavailable playlist flag without a reason", (v) => {
      v.native = { dateFeaturesAvailable: true, playFeaturesAvailable: true, playlistFeaturesAvailable: false };
    }],
    ["a non-boolean flag", (v) => {
      v.native = { dateFeaturesAvailable: "yes", playFeaturesAvailable: true, playlistFeaturesAvailable: true };
    }],
    ["an empty reason", (v) => {
      v.native = {
        dateFeaturesAvailable: false,
        dateFeaturesUnavailableReason: "",
        playFeaturesAvailable: true,
        playlistFeaturesAvailable: true,
      };
    }],
    ["an extra capability key", (v) => {
      v.native = {
        dateFeaturesAvailable: true,
        playFeaturesAvailable: true,
        playlistFeaturesAvailable: true,
        futureFeature: true,
      };
    }],
    ["a non-record capability", (v) => (v.native = "COMPATIBLE_FRESH")],
  ])("rejects %s", (_name, mutate) => {
    const damaged = wireCopy(valid()) as any;
    mutate(damaged);
    expect(normalizeCatalogIndexResponse(damaged)).toBeNull();
  });
});

describe("native date/play fields (catalog v3)", () => {
  const NATIVE_FIELDS = {
    originalReleaseDate: { year: 1959, month: 8, day: 17 },
    releaseDate: { year: 1959, month: 0, day: 0 },
    importDate: "2020-01-02T03:04:05.000Z",
    playCount: 7,
    lastPlayedAt: "2026-07-01T00:00:00.000Z",
  } as const;

  it("serves the native fields exactly when the album carries them", () => {
    const enriched = album(ALBUM_ID, { ...NATIVE_FIELDS });
    const plain = album(ALBUM_ID_2, {
      exactTitle: "Mystery",
      normalizedTitle: "mystery",
    });
    const built = buildCatalogIndexResponse(status(), {
      artists: [artist()],
      albums: [enriched, plain],
    });
    expect(built.albums[0]).toMatchObject({ ...NATIVE_FIELDS });
    for (const key of Object.keys(NATIVE_FIELDS)) {
      expect(built.albums[1]).not.toHaveProperty(key);
    }
    // The wire round-trip preserves the fields and the omission.
    expect(normalizeCatalogIndexResponse(wireCopy(built))).toEqual(built);
  });

  it("never serves the native identity binding on the index", () => {
    const bound = album(ALBUM_ID, {
      extendedAlbumId: "4242",
      extendedRoonAlbumId: "9001",
      playCount: 7,
    });
    const built = buildCatalogIndexResponse(status(), {
      artists: [artist()],
      albums: [bound],
    });
    expect(built.albums[0]).not.toHaveProperty("extendedAlbumId");
    expect(built.albums[0]).not.toHaveProperty("extendedRoonAlbumId");
    expect(built.albums[0]).toMatchObject({ playCount: 7 });
    // A tampered payload that smuggles the binding in is rejected.
    const damaged = wireCopy(built) as any;
    damaged.albums[0].extendedAlbumId = "4242";
    expect(normalizeCatalogIndexResponse(damaged)).toBeNull();
  });

  it.each<[string, (album: any) => void]>([
    ["a non-integer play count", (a) => (a.playCount = 1.5)],
    ["a negative play count", (a) => (a.playCount = -1)],
    [
      "a native date with an out-of-range month",
      (a) => (a.originalReleaseDate = { year: 1959, month: 13, day: 1 }),
    ],
    [
      "a native date with extra keys",
      (a) =>
        (a.originalReleaseDate = { year: 1959, month: 8, day: 17, era: "ce" }),
    ],
    ["a non-canonical import date", (a) => (a.importDate = "2020-01-02")],
    [
      "a non-canonical last-played instant",
      (a) => (a.lastPlayedAt = "yesterday"),
    ],
  ])("rejects %s", (_name, mutate) => {
    const built = buildCatalogIndexResponse(status(), {
      artists: [artist()],
      albums: [album(ALBUM_ID, { ...NATIVE_FIELDS })],
    });
    const damaged = wireCopy(built) as any;
    mutate(damaged.albums[0]);
    expect(normalizeCatalogIndexResponse(damaged)).toBeNull();
  });
});
