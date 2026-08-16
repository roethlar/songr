import {
  AlbumRef,
  ArtistRef,
  CATALOG_RELEASE_EVIDENCE_SOURCE_CONTRACT,
  deriveCatalogChronologyPlacement,
  normalizeCatalogText,
} from "../../../shared/catalogContracts";
import {
  CATALOG_SELECTED_ARTIST_OBSERVATION_SOURCE_CONTRACT,
  CatalogReconciliationError,
  createCatalogTrackTitleFingerprint,
  normalizeSelectedArtistObservation,
  reconcileSelectedArtist,
} from "../CatalogReconciliation";

const CORE_ID = "core-a";
const ARTIST_ID = "10000000-0000-4000-8000-000000000001";
const ALBUM_ID = "20000000-0000-4000-8000-000000000001";
const FIRST_SEEN = "2026-07-15T00:00:00.000Z";
const OBSERVED_AT = "2026-07-16T00:00:00.000Z";

function idFactory(start = 1): () => string {
  let value = start;
  return () => {
    const suffix = value.toString(16).padStart(12, "0");
    value += 1;
    return `30000000-0000-4000-8000-${suffix}`;
  };
}

function artist(over: Partial<ArtistRef> = {}): ArtistRef {
  const exactName = over.exactName ?? "Selected Artist";
  return {
    localId: ARTIST_ID,
    coreId: CORE_ID,
    exactName,
    normalizedName: normalizeCatalogText(exactName),
    firstSeenAt: FIRST_SEEN,
    lastSeenAt: FIRST_SEEN,
    resolutionStatus: "resolved",
    ...over,
  };
}

function album(over: Partial<AlbumRef> = {}): AlbumRef {
  const exactTitle = over.exactTitle ?? "Selected Album";
  const exactArtist = over.exactArtist ?? "Selected Artist";
  return {
    localId: ALBUM_ID,
    coreId: CORE_ID,
    artistLocalId: ARTIST_ID,
    exactTitle,
    exactArtist,
    normalizedTitle: normalizeCatalogText(exactTitle),
    normalizedArtist: normalizeCatalogText(exactArtist),
    editionText: "",
    firstSeenAt: FIRST_SEEN,
    lastSeenAt: FIRST_SEEN,
    resolutionStatus: "resolved",
    ...over,
  } as AlbumRef;
}

function detail(
  title = "Selected Album",
  tracks: readonly string[] = ["1. First", "2. Second"],
  dates: {
    original?: string;
    edition?: string;
  } = {}
) {
  return {
    sourceContract: CATALOG_RELEASE_EVIDENCE_SOURCE_CONTRACT,
    fieldInventoryComplete: true,
    headerTitle: title,
    headerSubtitle: "Selected Artist",
    returnedTrackCount: tracks.length,
    totalTrackCount: tracks.length,
    orderedTrackTitles: [...tracks],
    originalReleaseDateField: dates.original
      ? { status: "observed" as const, date: dates.original }
      : { status: "not-exposed" as const },
    editionReleaseDateField: dates.edition
      ? { status: "observed" as const, date: dates.edition }
      : { status: "not-exposed" as const },
  };
}

function observedAlbum(
  over: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    exactTitle: "Selected Album",
    exactArtist: "Selected Artist",
    editionText: "",
    detail: detail(),
    ...over,
  };
}

function resolvedObservation(
  albums: readonly Record<string, unknown>[] = [observedAlbum()],
  over: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    sourceContract: CATALOG_SELECTED_ARTIST_OBSERVATION_SOURCE_CONTRACT,
    artist: { exactName: "Selected Artist", candidateCount: 1 },
    discographyComplete: true,
    albums,
    ...over,
  };
}

function reconcile(
  observation: unknown,
  currentArtists: readonly ArtistRef[] = [],
  currentAlbums: readonly AlbumRef[] = [],
  over: Partial<Parameters<typeof reconcileSelectedArtist>[0]> = {}
) {
  return reconcileSelectedArtist({
    coreId: CORE_ID,
    selectedArtistLocalId: currentArtists[0]?.localId ?? null,
    observation,
    currentArtists,
    currentAlbums,
    observedAt: OBSERVED_AT,
    createLocalId: idFactory(),
    ...over,
  });
}

describe("Catalog selected-artist reconciliation", () => {
  it("strictly normalizes only complete keyless exact-detail observations", () => {
    expect(normalizeSelectedArtistObservation(resolvedObservation())).not.toBeNull();
    expect(
      normalizeSelectedArtistObservation({
        ...resolvedObservation(),
        itemKey: "forbidden",
      })
    ).toBeNull();
    expect(
      normalizeSelectedArtistObservation(
        resolvedObservation([
          observedAlbum({
            detail: { ...detail(), headerTitle: "Another Album" },
          }),
        ])
      )
    ).toBeNull();
    expect(
      normalizeSelectedArtistObservation(
        resolvedObservation([
          observedAlbum({
            detail: { ...detail(), returnedTrackCount: 1 },
          }),
        ])
      )
    ).toBeNull();
    expect(
      normalizeSelectedArtistObservation({
        ...resolvedObservation(),
        artist: {
          exactName: "Selected Artist",
          candidateCount: 1,
          localId: ARTIST_ID,
        },
      })
    ).toBeNull();
  });

  it("hashes a versioned normalized ordered track sequence without delimiter collisions", () => {
    expect(createCatalogTrackTitleFingerprint(["1. First", "2. Second"])).toBe(
      createCatalogTrackTitleFingerprint(["First", "Second"])
    );
    expect(createCatalogTrackTitleFingerprint(["a", "b|c"])).not.toBe(
      createCatalogTrackTitleFingerprint(["a|b", "c"])
    );
    expect(createCatalogTrackTitleFingerprint(["First", "Second"])).not.toBe(
      createCatalogTrackTitleFingerprint(["Second", "First"])
    );
  });

  it("reuses a unique fingerprint ID while advancing metadata and independent dates", () => {
    const fingerprint = createCatalogTrackTitleFingerprint(["First", "Second"]);
    const previous = album({
      trackTitleFingerprint: fingerprint,
      imageKeyHint: "old-image",
      originalReleaseYear: 1997,
      originalReleaseYearEvidence: {
        sourceContract: CATALOG_RELEASE_EVIDENCE_SOURCE_CONTRACT,
        field: "original-release-date",
        date: "1997-09-22",
      },
    });

    const result = reconcile(
      resolvedObservation([
        observedAlbum({
          exactTitle: "Selected Album (Deluxe)",
          imageKeyHint: "new-image",
          detail: detail(
            "Selected Album (Deluxe)",
            ["1. First", "2. Second"],
            { original: "1997-09-22", edition: "2022-03" }
          ),
        }),
      ]),
      [artist()],
      [previous]
    );

    expect(result.artist.localId).toBe(ARTIST_ID);
    expect(result.albums).toHaveLength(1);
    expect(result.albums[0]).toMatchObject({
      localId: ALBUM_ID,
      firstSeenAt: FIRST_SEEN,
      lastSeenAt: OBSERVED_AT,
      exactTitle: "Selected Album (Deluxe)",
      imageKeyHint: "new-image",
      originalReleaseYear: 1997,
      editionReleaseYear: 2022,
      resolutionStatus: "resolved",
    });
    expect(result.albums[0].originalReleaseYearEvidence?.field).toBe(
      "original-release-date"
    );
    expect(result.albums[0].editionReleaseYearEvidence?.field).toBe(
      "edition-release-date"
    );
  });

  it("keeps current not-exposed fields from erasing prior proven evidence", () => {
    const fingerprint = createCatalogTrackTitleFingerprint(["First", "Second"]);
    const previous = album({
      trackTitleFingerprint: fingerprint,
      originalReleaseYear: 1997,
      originalReleaseYearEvidence: {
        sourceContract: CATALOG_RELEASE_EVIDENCE_SOURCE_CONTRACT,
        field: "original-release-date",
        date: "1997-09-22",
      },
    });

    const result = reconcile(resolvedObservation(), [artist()], [previous]);

    expect(result.albums[0].originalReleaseYearEvidence?.date).toBe("1997-09-22");
  });

  it("resolves duplicate descriptors only when distinct fingerprints separate them", () => {
    const firstObservation = resolvedObservation([
      observedAlbum({ detail: detail("Selected Album", ["A"]) }),
      observedAlbum({ detail: detail("Selected Album", ["B"]) }),
    ]);
    const first = reconcile(firstObservation);
    const idByFingerprint = new Map(
      first.albums.map((value) => [value.trackTitleFingerprint, value.localId])
    );

    const second = reconcile(
      resolvedObservation([
        observedAlbum({ detail: detail("Selected Album", ["B"]) }),
        observedAlbum({ detail: detail("Selected Album", ["A"]) }),
      ]),
      [first.artist],
      [...first.albums],
      { selectedArtistLocalId: first.artist.localId }
    );

    expect(first.albums.every((value) => value.resolutionStatus === "resolved"))
      .toBe(true);
    expect(second.albums.every((value) => value.resolutionStatus === "resolved"))
      .toBe(true);
    expect(
      second.albums.map((value) => idByFingerprint.get(value.trackTitleFingerprint))
    ).toEqual(second.albums.map((value) => value.localId));
  });

  it("retains identical duplicate editions as an ambiguous ID set", () => {
    const duplicateObservation = resolvedObservation([
      observedAlbum(),
      observedAlbum(),
    ]);
    const first = reconcile(duplicateObservation);
    const second = reconcile(
      duplicateObservation,
      [first.artist],
      [...first.albums],
      { selectedArtistLocalId: first.artist.localId }
    );

    expect(first.albums).toHaveLength(2);
    expect(first.albums.every((value) => value.resolutionStatus === "ambiguous"))
      .toBe(true);
    expect(new Set(second.albums.map((value) => value.localId))).toEqual(
      new Set(first.albums.map((value) => value.localId))
    );
  });

  it("marks a complete-discography omission missing and restores its ID on reappearance", () => {
    const first = reconcile(resolvedObservation());
    const missing = reconcile(
      resolvedObservation([]),
      [first.artist],
      [...first.albums],
      { selectedArtistLocalId: first.artist.localId }
    );
    const restored = reconcile(
      resolvedObservation(),
      [missing.artist],
      [...missing.albums],
      { selectedArtistLocalId: missing.artist.localId }
    );

    expect(missing.albums).toMatchObject([
      { localId: first.albums[0].localId, resolutionStatus: "missing" },
    ]);
    expect(restored.albums).toMatchObject([
      { localId: first.albums[0].localId, resolutionStatus: "resolved" },
    ]);
  });

  it("fails closed instead of weak-matching conflicting fingerprints or dates", () => {
    const fingerprint = createCatalogTrackTitleFingerprint(["Old"]);
    const previous = album({
      trackTitleFingerprint: fingerprint,
      originalReleaseYear: 1997,
      originalReleaseYearEvidence: {
        sourceContract: CATALOG_RELEASE_EVIDENCE_SOURCE_CONTRACT,
        field: "original-release-date",
        date: "1997",
      },
    });

    const fingerprintConflict = reconcile(
      resolvedObservation([
        observedAlbum({ detail: detail("Selected Album", ["New"]) }),
      ]),
      [artist()],
      [previous]
    );
    expect(fingerprintConflict.albums.map((value) => value.resolutionStatus)).toEqual([
      "ambiguous",
      "missing",
    ]);
    expect(fingerprintConflict.albums[0].localId).not.toBe(ALBUM_ID);

    const dateConflict = reconcile(
      resolvedObservation([
        observedAlbum({
          detail: detail("Selected Album", ["Old"], { original: "1998" }),
        }),
      ]),
      [artist()],
      [previous]
    );
    expect(dateConflict.albums.map((value) => value.resolutionStatus)).toEqual([
      "ambiguous",
      "missing",
    ]);
  });

  it("marks selected artist and bound albums missing or ambiguous without inventing sightings", () => {
    for (const candidateCount of [0, 2]) {
      const observation = {
        sourceContract: CATALOG_SELECTED_ARTIST_OBSERVATION_SOURCE_CONTRACT,
        artist: { exactName: "Selected Artist", candidateCount },
      };
      const result = reconcile(observation, [artist()], [album()]);
      const expected = candidateCount === 0 ? "missing" : "ambiguous";
      expect(result.artist).toMatchObject({
        resolutionStatus: expected,
        lastSeenAt: FIRST_SEEN,
      });
      expect(result.albums).toMatchObject([
        { resolutionStatus: expected, lastSeenAt: FIRST_SEEN },
      ]);
    }
  });

  it("keeps title, artist, and edition years Undated when trusted fields are not exposed", () => {
    const result = reconcile(
      resolvedObservation([
        observedAlbum({
          exactTitle: "1984",
          exactArtist: "The 1975",
          editionText: "2024 Remaster",
          detail: {
            ...detail("1984"),
            headerSubtitle: "The 1975",
          },
        }),
      ], {
        artist: { exactName: "The 1975", candidateCount: 1 },
      })
    );

    expect(result.albums[0].originalReleaseYear).toBeUndefined();
    expect(result.albums[0].editionReleaseYear).toBeUndefined();
    expect(deriveCatalogChronologyPlacement(result.albums[0], 0)?.kind).toBe(
      "undated"
    );
  });

  it("rejects malformed, cross-Core, and caller-authored authority atomically", () => {
    expect(() =>
      reconcile(
        resolvedObservation([
          { ...observedAlbum(), trackTitleFingerprint: "caller-hash" },
        ])
      )
    ).toThrow(CatalogReconciliationError);
    expect(() =>
      reconcile(resolvedObservation(), [artist({ coreId: "core-b" })], [])
    ).toThrow(CatalogReconciliationError);
  });
});

describe("native field carry-forward (Slice 3)", () => {
  it("keeps a prior album's native fields when reconciliation recognizes it", () => {
    const prior = album({
      extendedAlbumId: "4242",
      extendedRoonAlbumId: "9001",
      originalReleaseDate: { year: 1959, month: 8, day: 17 },
      importDate: "2020-01-02T03:04:05.000Z",
      playCount: 7,
      lastPlayedAt: "2026-07-01T00:00:00.000Z",
    });
    const result = reconcile(
      resolvedObservation(),
      [artist()],
      [prior]
    );
    expect(result.albums).toHaveLength(1);
    expect(result.albums[0].localId).toBe(prior.localId);
    expect(result.albums[0]).toMatchObject({
      extendedAlbumId: "4242",
      extendedRoonAlbumId: "9001",
      originalReleaseDate: { year: 1959, month: 8, day: 17 },
      importDate: "2020-01-02T03:04:05.000Z",
      playCount: 7,
      lastPlayedAt: "2026-07-01T00:00:00.000Z",
    });
  });

  it("does not invent native fields for newly observed albums", () => {
    const result = reconcile(resolvedObservation(), [artist()], []);
    expect(result.albums).toHaveLength(1);
    expect(result.albums[0]).not.toHaveProperty("extendedAlbumId");
    expect(result.albums[0]).not.toHaveProperty("playCount");
  });
});
