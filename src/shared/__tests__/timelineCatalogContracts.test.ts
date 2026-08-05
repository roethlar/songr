import {
  CATALOG_ARTIST_ALBUMS_MAX_LIMIT,
  CATALOG_ARTIST_SEARCH_MAX_LIMIT,
  CATALOG_RELEASE_EVIDENCE_SOURCE_CONTRACT,
  deriveCatalogTimelinePlacement,
  normalizeAlbumRef,
  normalizeCatalogArtistAlbumsResponse,
  normalizeCatalogArtistSearchResponse,
  normalizeCatalogRefreshAcceptedResponse,
  normalizeCatalogStatus,
  normalizeArtistRef,
  normalizeCatalogText,
  type AlbumRef,
  type ArtistRef,
  type CatalogStatus,
} from "../timelineCatalogContracts";

const ARTIST_ID = "018f0f64-3f31-7a9b-8c2d-8f572cb18a11";
const ALBUM_ID = "018f0f64-3f31-7a9b-8c2d-8f572cb18a12";
const FIRST_SEEN = "2026-07-14T12:00:00.000Z";
const LAST_SEEN = "2026-07-15T12:00:00.000Z";

function artistRef(): ArtistRef {
  return {
    localId: ARTIST_ID,
    coreId: "core-alpha",
    exactName: "Björk",
    normalizedName: "björk",
    imageKeyHint: "image-artist-1",
    firstSeenAt: FIRST_SEEN,
    lastSeenAt: LAST_SEEN,
    resolutionStatus: "resolved",
  };
}

function albumRef(): AlbumRef {
  return {
    localId: ALBUM_ID,
    coreId: "core-alpha",
    artistLocalId: ARTIST_ID,
    exactTitle: "Homogenic",
    exactArtist: "Björk",
    normalizedTitle: "homogenic",
    normalizedArtist: "björk",
    editionText: "Remastered Edition",
    trackTitleFingerprint:
      "7b89c34d48c149f2f64e0b6bc1159bd3f6b52d17f7719d30f8f50e56c5f169a1",
    imageKeyHint: "image-album-1",
    originalReleaseYear: 1997,
    originalReleaseYearEvidence: {
      sourceContract: CATALOG_RELEASE_EVIDENCE_SOURCE_CONTRACT,
      field: "original-release-date",
      date: "1997-09-22",
    },
    editionReleaseYear: 2022,
    editionReleaseYearEvidence: {
      sourceContract: CATALOG_RELEASE_EVIDENCE_SOURCE_CONTRACT,
      field: "edition-release-date",
      date: "2022-03",
    },
    firstSeenAt: FIRST_SEEN,
    lastSeenAt: LAST_SEEN,
    resolutionStatus: "resolved",
  };
}

function catalogStatus(over: Partial<CatalogStatus> = {}): CatalogStatus {
  return {
    coreId: "core-alpha",
    freshness: "fresh",
    persistence: "healthy",
    refresh: "idle",
    available: true,
    complete: true,
    revision: 7,
    artistCount: 1,
    albumCount: 1,
    updatedAt: LAST_SEEN,
    lastCompleteScanAt: LAST_SEEN,
    ...over,
  };
}

function emptyCatalogStatus(over: Partial<CatalogStatus> = {}): CatalogStatus {
  return {
    coreId: "core-alpha",
    freshness: "empty",
    persistence: "healthy",
    refresh: "idle",
    available: false,
    complete: false,
    revision: 0,
    artistCount: 0,
    albumCount: 0,
    ...over,
  };
}

describe("Timeline catalog contracts", () => {
  it("normalizes valid artist and album descriptors into defensive copies", () => {
    const artist = artistRef();
    const album = albumRef();
    const normalizedArtist = normalizeArtistRef(artist);
    const normalizedAlbum = normalizeAlbumRef(album);

    expect(normalizedArtist).toEqual(artist);
    expect(normalizedArtist).not.toBe(artist);
    expect(normalizedAlbum).toEqual(album);
    expect(normalizedAlbum).not.toBe(album);
    expect(normalizedAlbum?.originalReleaseYearEvidence).not.toBe(
      album.originalReleaseYearEvidence
    );

    album.originalReleaseYearEvidence!.date = "1998";
    expect(normalizedAlbum?.originalReleaseYearEvidence?.date).toBe("1997-09-22");
  });

  it("uses canonical NFKC, whitespace, and en-US lowercase comparison text", () => {
    expect(normalizeCatalogText("  BJÖRK\t Guðmundsdóttir  ")).toBe(
      "björk guðmundsdóttir"
    );

    const artist = artistRef() as unknown as Record<string, unknown>;
    artist.normalizedName = "BJÖRK";
    expect(normalizeArtistRef(artist)).toBeNull();
  });

  it("accepts absent release evidence and edition-only evidence without inventing chronology", () => {
    const undated = albumRef() as unknown as Record<string, unknown>;
    delete undated.originalReleaseYear;
    delete undated.originalReleaseYearEvidence;
    delete undated.editionReleaseYear;
    delete undated.editionReleaseYearEvidence;
    expect(normalizeAlbumRef(undated)).toMatchObject({ exactTitle: "Homogenic" });

    const editionOnly = albumRef() as unknown as Record<string, unknown>;
    delete editionOnly.originalReleaseYear;
    delete editionOnly.originalReleaseYearEvidence;
    const normalized = normalizeAlbumRef(editionOnly);
    expect(normalized?.originalReleaseYear).toBeUndefined();
    expect(normalized?.originalReleaseYearEvidence).toBeUndefined();
    expect(normalized?.editionReleaseYear).toBe(2022);
  });

  it.each([
    ["one-sided original year", { originalReleaseYearEvidence: undefined }],
    ["one-sided edition evidence", { editionReleaseYear: undefined }],
    [
      "swapped original evidence field",
      {
        originalReleaseYearEvidence: {
          sourceContract: CATALOG_RELEASE_EVIDENCE_SOURCE_CONTRACT,
          field: "edition-release-date",
          date: "1997",
        },
      },
    ],
    [
      "swapped edition evidence field",
      {
        editionReleaseYearEvidence: {
          sourceContract: CATALOG_RELEASE_EVIDENCE_SOURCE_CONTRACT,
          field: "original-release-date",
          date: "2022",
        },
      },
    ],
    [
      "year/date disagreement",
      {
        originalReleaseYearEvidence: {
          sourceContract: CATALOG_RELEASE_EVIDENCE_SOURCE_CONTRACT,
          field: "original-release-date",
          date: "1998-01-01",
        },
      },
    ],
    [
      "invalid Gregorian date",
      {
        editionReleaseYearEvidence: {
          sourceContract: CATALOG_RELEASE_EVIDENCE_SOURCE_CONTRACT,
          field: "edition-release-date",
          date: "2022-02-29",
        },
      },
    ],
  ])("rejects %s", (_label, patch) => {
    const value = { ...albumRef(), ...patch };
    expect(normalizeAlbumRef(value)).toBeNull();
  });

  it("rejects genuinely one-sided release pairs", () => {
    const originalWithoutEvidence = albumRef() as unknown as Record<string, unknown>;
    delete originalWithoutEvidence.originalReleaseYearEvidence;
    expect(normalizeAlbumRef(originalWithoutEvidence)).toBeNull();

    const editionEvidenceWithoutYear = albumRef() as unknown as Record<string, unknown>;
    delete editionEvidenceWithoutYear.editionReleaseYear;
    expect(normalizeAlbumRef(editionEvidenceWithoutYear)).toBeNull();
  });

  it("does not infer release evidence from title, artist, or edition prose", () => {
    const value = albumRef() as unknown as Record<string, unknown>;
    value.exactTitle = "1984 (2009 Remaster)";
    value.normalizedTitle = "1984 (2009 remaster)";
    value.exactArtist = "The 1975";
    value.normalizedArtist = "the 1975";
    value.editionText = "40th Anniversary Reissue 2024";
    delete value.originalReleaseYear;
    delete value.originalReleaseYearEvidence;
    delete value.editionReleaseYear;
    delete value.editionReleaseYearEvidence;

    const normalized = normalizeAlbumRef(value);
    expect(normalized).not.toBeNull();
    expect(normalized?.originalReleaseYear).toBeUndefined();
    expect(normalized?.editionReleaseYear).toBeUndefined();
    expect(deriveCatalogTimelinePlacement(normalized, 3)).toEqual({
      kind: "undated",
      ordinal: 3,
      label: "Undated",
      reason: "no-proven-original-release-date",
    });
  });

  it("derives calendar placement only from resolved original-release evidence", () => {
    const album = albumRef();

    const placement = deriveCatalogTimelinePlacement(album, 4);

    expect(placement).toEqual({
      kind: "calendar",
      ordinal: 4,
      year: 1997,
      evidence: {
        sourceContract: CATALOG_RELEASE_EVIDENCE_SOURCE_CONTRACT,
        field: "original-release-date",
        date: "1997-09-22",
      },
    });
    expect(placement?.kind === "calendar" ? placement.evidence : null).not.toBe(
      album.originalReleaseYearEvidence
    );
  });

  it("keeps edition-only and unresolved albums explicitly Undated", () => {
    const editionOnly = albumRef() as unknown as Record<string, unknown>;
    delete editionOnly.originalReleaseYear;
    delete editionOnly.originalReleaseYearEvidence;

    expect(deriveCatalogTimelinePlacement(editionOnly, 0)).toEqual({
      kind: "undated",
      ordinal: 0,
      label: "Undated",
      reason: "no-proven-original-release-date",
    });
    expect(
      deriveCatalogTimelinePlacement(
        { ...albumRef(), resolutionStatus: "ambiguous" },
        1
      )
    ).toEqual({
      kind: "undated",
      ordinal: 1,
      label: "Undated",
      reason: "album-not-resolved",
    });
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"])(
    "rejects invalid chronology ordinal %p",
    (ordinal) => {
      expect(deriveCatalogTimelinePlacement(albumRef(), ordinal)).toBeNull();
    }
  );

  it("rejects unknown resolution status", () => {
    expect(
      normalizeArtistRef({ ...artistRef(), resolutionStatus: "descriptor-ambiguous" })
    ).toBeNull();
    expect(
      normalizeAlbumRef({ ...albumRef(), resolutionStatus: "stale" })
    ).toBeNull();
  });

  it.each([
    ["noncanonical local ID", { localId: "ALBUM-1" }],
    ["unknown UUID version", { localId: "018f0f64-3f31-0a9b-8c2d-8f572cb18a12" }],
    ["noncanonical first timestamp", { firstSeenAt: "2026-07-14T12:00:00Z" }],
    ["reversed timestamps", { firstSeenAt: LAST_SEEN, lastSeenAt: FIRST_SEEN }],
    ["bad track fingerprint", { trackTitleFingerprint: "sha256:abc" }],
    ["own undefined optional", { imageKeyHint: undefined }],
  ])("rejects %s", (_label, patch) => {
    expect(normalizeAlbumRef({ ...albumRef(), ...patch })).toBeNull();
  });

  it("rejects sparse, symbolic, accessor, prototype, and hostile inputs", () => {
    expect(normalizeAlbumRef(new Array(3))).toBeNull();

    const symbolic = albumRef() as AlbumRef & Record<PropertyKey, unknown>;
    symbolic[Symbol("itemKey")] = "hidden";
    expect(normalizeAlbumRef(symbolic)).toBeNull();

    const accessor = { ...albumRef() } as Record<string, unknown>;
    Object.defineProperty(accessor, "coreId", { enumerable: true, get: () => "core" });
    expect(normalizeAlbumRef(accessor)).toBeNull();

    expect(normalizeAlbumRef(Object.assign(Object.create({ inherited: true }), albumRef()))).toBeNull();

    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("uninspectable");
        },
      }
    );
    expect(normalizeAlbumRef(hostile)).toBeNull();
  });

  it.each(["itemKey", "multiSessionKey", "actionId", "filesystemPath", "callback"])(
    "rejects authority-like extra field %s",
    (field) => {
      expect(normalizeAlbumRef({ ...albumRef(), [field]: "forbidden" })).toBeNull();
    }
  );

  it("rejects missing required fields and serializes no Roon item key", () => {
    const missing = albumRef() as unknown as Record<string, unknown>;
    delete missing.exactArtist;
    expect(normalizeAlbumRef(missing)).toBeNull();

    const serialized = JSON.stringify(normalizeAlbumRef(albumRef()));
    expect(serialized).not.toContain("itemKey");
    expect(serialized).not.toContain("multiSessionKey");
  });

  it("strictly normalizes bounded artist and album responses without authority", () => {
    const search = {
      status: catalogStatus(),
      query: "Björk",
      limit: 20,
      total: 1,
      truncated: false,
      artists: [artistRef()],
    };
    const albums = {
      status: catalogStatus(),
      artist: artistRef(),
      limit: 200,
      total: 1,
      truncated: false,
      albums: [albumRef()],
    };

    const normalizedSearch = normalizeCatalogArtistSearchResponse(search);
    const normalizedAlbums = normalizeCatalogArtistAlbumsResponse(albums);

    expect(normalizedSearch).toEqual(search);
    expect(normalizedSearch).not.toBe(search);
    expect(normalizedSearch?.artists[0]).not.toBe(search.artists[0]);
    expect(normalizedAlbums).toEqual(albums);
    expect(normalizedAlbums?.albums[0].originalReleaseYearEvidence).toEqual(
      albumRef().originalReleaseYearEvidence
    );
    expect(normalizedAlbums?.albums[0]).not.toBe(albums.albums[0]);
    expect(JSON.stringify({ normalizedSearch, normalizedAlbums })).not.toMatch(
      /itemKey|multiSessionKey|multi_session_key|actionId|filesystemPath/u
    );
  });

  it("strictly normalizes refresh acceptance without scan data or authority", () => {
    const response = { status: catalogStatus() };

    const normalized = normalizeCatalogRefreshAcceptedResponse(response);
    expect(normalized).toEqual(response);
    expect(normalized).not.toBe(response);
    expect(normalized?.status).not.toBe(response.status);
    expect(
      normalizeCatalogRefreshAcceptedResponse({
        ...response,
        snapshot: { itemKey: "forbidden" },
      })
    ).toBeNull();
    expect(
      normalizeCatalogRefreshAcceptedResponse({
        status: { ...response.status, coreId: "" },
      })
    ).toBeNull();
  });

  it.each([
    [
      "stale without a reason",
      { freshness: "stale" },
    ],
    [
      "fresh with a stale reason",
      { freshness: "fresh", staleReason: "restored" },
    ],
    ["fresh with an unknown stale reason", { staleReason: "bogus" }],
    [
      "degraded without a persistence problem",
      { persistence: "degraded" },
    ],
    [
      "noncanonical problem timestamp",
      {
        freshness: "stale",
        staleReason: "scan-failed",
        lastProblem: {
          code: "SCAN_FAILED",
          occurredAt: "2026-07-15T12:00:00Z",
        },
      },
    ],
    [
      "healthy with a persistence problem",
      {
        lastProblem: {
          code: "PERSISTENCE_WRITE_FAILED",
          occurredAt: LAST_SEEN,
        },
      },
    ],
    [
      "scan-failed without a scan problem",
      {
        freshness: "stale",
        staleReason: "scan-failed",
      },
    ],
    [
      "persistence-failed while healthy",
      {
        freshness: "stale",
        staleReason: "persistence-failed",
      },
    ],
  ])("rejects catalog status that is %s", (_label, patch) => {
    expect(normalizeCatalogStatus({ ...catalogStatus(), ...patch })).toBeNull();
  });

  it("accepts every status shape emitted by empty, restored, failed, and disconnected catalogs", () => {
    const statuses: CatalogStatus[] = [
      emptyCatalogStatus(),
      emptyCatalogStatus({
        lastProblem: { code: "SCAN_FAILED", occurredAt: LAST_SEEN },
      }),
      emptyCatalogStatus({
        persistence: "degraded",
        lastProblem: {
          code: "PERSISTENCE_READ_FAILED",
          occurredAt: LAST_SEEN,
        },
      }),
      catalogStatus({ freshness: "stale", staleReason: "restored" }),
      catalogStatus({
        freshness: "stale",
        staleReason: "core-disconnected",
        lastProblem: { code: "SCAN_FAILED", occurredAt: LAST_SEEN },
      }),
      catalogStatus({
        freshness: "stale",
        staleReason: "scan-failed",
        lastProblem: { code: "SCAN_FAILED", occurredAt: LAST_SEEN },
      }),
      catalogStatus({
        freshness: "stale",
        staleReason: "persistence-failed",
        persistence: "degraded",
        lastProblem: {
          code: "PERSISTENCE_WRITE_FAILED",
          occurredAt: LAST_SEEN,
        },
      }),
    ];

    expect(statuses.map(normalizeCatalogStatus)).toEqual(statuses);

    const freshWithoutSnapshot = catalogStatus() as unknown as Record<
      string,
      unknown
    >;
    freshWithoutSnapshot.available = false;
    freshWithoutSnapshot.complete = false;
    freshWithoutSnapshot.revision = 0;
    freshWithoutSnapshot.artistCount = 0;
    freshWithoutSnapshot.albumCount = 0;
    delete freshWithoutSnapshot.updatedAt;
    delete freshWithoutSnapshot.lastCompleteScanAt;
    expect(normalizeCatalogStatus(freshWithoutSnapshot)).toBeNull();

    expect(
      normalizeCatalogStatus({
        ...emptyCatalogStatus(),
        freshness: "stale",
        staleReason: "restored",
      })
    ).toBeNull();
  });

  it("rejects underfilled, over-limit, cross-Core, and authority-bearing search responses", () => {
    const valid = {
      status: catalogStatus({ artistCount: 2 }),
      query: "Björk",
      limit: 20,
      total: 1,
      truncated: false,
      artists: [artistRef()],
    };

    expect(
      normalizeCatalogArtistSearchResponse({
        ...valid,
        total: 2,
        truncated: true,
      })
    ).toBeNull();
    expect(
      normalizeCatalogArtistSearchResponse({
        ...valid,
        limit: CATALOG_ARTIST_SEARCH_MAX_LIMIT + 1,
      })
    ).toBeNull();
    expect(
      normalizeCatalogArtistSearchResponse({
        ...valid,
        artists: [{ ...artistRef(), coreId: "core-beta" }],
      })
    ).toBeNull();
    expect(
      normalizeCatalogArtistSearchResponse({
        ...valid,
        artists: [{ ...artistRef(), itemKey: "forbidden" }],
      })
    ).toBeNull();
    expect(
      normalizeCatalogArtistSearchResponse({
        ...valid,
        query: "",
      })
    ).toBeNull();

    const sparseArtists = new Array<ArtistRef>(1);
    expect(
      normalizeCatalogArtistSearchResponse({
        ...valid,
        artists: sparseArtists,
      })
    ).toBeNull();
    const authorityArtists = [artistRef()] as ArtistRef[] & {
      itemKey?: string;
    };
    authorityArtists.itemKey = "forbidden";
    expect(
      normalizeCatalogArtistSearchResponse({
        ...valid,
        artists: authorityArtists,
      })
    ).toBeNull();

    const substring = {
      ...artistRef(),
      localId: "018f0f64-3f31-7a9b-8c2d-8f572cb18a13",
      exactName: "The Björk Project",
      normalizedName: "the björk project",
    };
    expect(
      normalizeCatalogArtistSearchResponse({
        ...valid,
        status: catalogStatus({ artistCount: 2 }),
        total: 2,
        artists: [substring, artistRef()],
      })
    ).toBeNull();

    expect(
      normalizeCatalogArtistSearchResponse({
        status: emptyCatalogStatus(),
        query: "",
        limit: 20,
        total: 0,
        truncated: false,
        artists: [],
      })
    ).not.toBeNull();
  });

  it("requires every album response row to use the requested exact artist binding", () => {
    const valid = {
      status: catalogStatus({ albumCount: 2 }),
      artist: artistRef(),
      limit: 200,
      total: 1,
      truncated: false,
      albums: [albumRef()],
    };

    const unbound = albumRef() as unknown as Record<string, unknown>;
    delete unbound.artistLocalId;
    expect(
      normalizeCatalogArtistAlbumsResponse({ ...valid, albums: [unbound] })
    ).toBeNull();
    expect(
      normalizeCatalogArtistAlbumsResponse({
        ...valid,
        albums: [
          {
            ...albumRef(),
            artistLocalId: "018f0f64-3f31-7a9b-8c2d-8f572cb18aff",
          },
        ],
      })
    ).toBeNull();
    expect(
      normalizeCatalogArtistAlbumsResponse({
        ...valid,
        total: 2,
        truncated: true,
      })
    ).toBeNull();
    expect(
      normalizeCatalogArtistAlbumsResponse({
        ...valid,
        limit: CATALOG_ARTIST_ALBUMS_MAX_LIMIT + 1,
      })
    ).toBeNull();
    expect(
      normalizeCatalogArtistAlbumsResponse({
        ...valid,
        albums: [{ ...albumRef(), actionId: "forbidden" }],
      })
    ).toBeNull();

    const sparseAlbums = new Array<AlbumRef>(1);
    expect(
      normalizeCatalogArtistAlbumsResponse({
        ...valid,
        albums: sparseAlbums,
      })
    ).toBeNull();
    const authorityAlbums = [albumRef()] as AlbumRef[] & { actionId?: string };
    authorityAlbums.actionId = "forbidden";
    expect(
      normalizeCatalogArtistAlbumsResponse({
        ...valid,
        albums: authorityAlbums,
      })
    ).toBeNull();
  });
});

describe("normalizeAlbumRef native enrichment fields (catalog v3)", () => {
  const NATIVE_FIELDS = {
    extendedAlbumId: "4242",
    extendedRoonAlbumId: "9001",
    originalReleaseDate: { year: 1959, month: 8, day: 17 },
    releaseDate: { year: 1959, month: 0, day: 0 },
    importDate: "2020-01-02T03:04:05.000Z",
    playCount: 7,
    lastPlayedAt: "2026-07-01T00:00:00.000Z",
  } as const;

  it("round-trips a fully enriched album", () => {
    const enriched = { ...albumRef(), ...NATIVE_FIELDS };
    const normalized = normalizeAlbumRef(JSON.parse(JSON.stringify(enriched)));
    expect(normalized).toMatchObject({ ...NATIVE_FIELDS });
    // Native dates are deep-copied, never shared references.
    expect(normalized?.originalReleaseDate).not.toBe(
      enriched.originalReleaseDate
    );
  });

  it.each<[string, (album: Record<string, unknown>) => void]>([
    ["a non-decimal native album id", (a) => (a.extendedAlbumId = "42x")],
    ["an overlong native album id", (a) => (a.extendedAlbumId = "4".repeat(33))],
    [
      "a native date with an out-of-range day",
      (a) => (a.releaseDate = { year: 1959, month: 1, day: 32 }),
    ],
    [
      "a native date missing a part",
      (a) => (a.releaseDate = { year: 1959, month: 1 }),
    ],
    ["a non-canonical import date", (a) => (a.importDate = "2020-01-02")],
    ["a negative play count", (a) => (a.playCount = -1)],
    ["a fractional play count", (a) => (a.playCount = 0.5)],
    ["a non-canonical last-played", (a) => (a.lastPlayedAt = "soon")],
    ["an unknown native-ish key", (a) => (a.nativeTrackCount = 12)],
  ])("rejects %s", (_name, mutate) => {
    const damaged: Record<string, unknown> = {
      ...albumRef(),
      ...NATIVE_FIELDS,
    };
    mutate(damaged);
    expect(normalizeAlbumRef(damaged)).toBeNull();
  });
});
