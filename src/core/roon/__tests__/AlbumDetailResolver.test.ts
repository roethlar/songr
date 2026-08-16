import {
  AlbumRef,
  ArtistRef,
} from "../../../shared/catalogContracts";
import { BrowseItem, BrowseResult } from "../../../shared/types";
import {
  CATALOG_SELECTED_ARTIST_OBSERVATION_SOURCE_CONTRACT,
  createCatalogTrackTitleFingerprint,
} from "../../catalog/CatalogReconciliation";
import { CoordinatedBrowseSession } from "../BrowseSessionCoordinator";
import {
  AlbumDetailResolver,
} from "../AlbumDetailResolver";
import { ObservedDiscography } from "../DiscographyResolver";

const ARTIST_ID = "10000000-0000-4000-8000-000000000001";
const ALBUM_ID = "20000000-0000-4000-8000-000000000001";
const AT = "2026-07-15T00:00:00.000Z";

function artist(): ArtistRef {
  return {
    localId: ARTIST_ID,
    coreId: "core-a",
    exactName: "Björk",
    normalizedName: "björk",
    firstSeenAt: AT,
    lastSeenAt: AT,
    resolutionStatus: "resolved",
  };
}

function album(
  overrides: {
    readonly editionText?: string;
    readonly trackTitleFingerprint?: string;
    readonly resolutionStatus?: AlbumRef["resolutionStatus"];
  } = {}
): AlbumRef {
  return {
    localId: ALBUM_ID,
    coreId: "core-a",
    artistLocalId: ARTIST_ID,
    exactTitle: "Debut",
    exactArtist: "Björk",
    normalizedTitle: "debut",
    normalizedArtist: "björk",
    editionText: "",
    firstSeenAt: AT,
    lastSeenAt: AT,
    resolutionStatus: "resolved",
    ...overrides,
  };
}

function row(
  title: string,
  itemKey: string,
  overrides: Partial<BrowseItem> = {}
): BrowseItem {
  return {
    title,
    itemKey,
    hint: "action_list",
    isLoadable: true,
    isPlayable: false,
    ...overrides,
  };
}

function detail(
  titles: readonly string[],
  overrides: Partial<BrowseResult> = {}
): BrowseResult {
  const items = [
    ...titles.map((title, index) =>
      row(title, `track-${index}`, {
        subtitle: "Björk",
        itemType: "track",
      })
    ),
    row("Play Album", "play-album"),
  ];
  return {
    title: "Debut",
    subtitle: "Björk",
    level: 2,
    offset: 0,
    count: items.length,
    totalCount: items.length,
    items,
    ...overrides,
  };
}

function observed(
  albums: ObservedDiscography["observation"]["albums"] = [
    { exactTitle: "Debut", exactArtist: "Björk", editionText: "" },
  ],
  itemKeys: readonly string[] = albums.map(
    (_value, observationIndex) => `album-${observationIndex}`
  )
): ObservedDiscography {
  return {
    observation: {
      sourceContract: CATALOG_SELECTED_ARTIST_OBSERVATION_SOURCE_CONTRACT,
      artist: { exactName: "Björk", candidateCount: 1 },
      discographyComplete: true,
      albums,
    },
    liveAlbums: albums.map((_value, observationIndex) => ({
      observationIndex,
      itemKey: itemKeys[observationIndex],
    })),
  };
}

class ScriptedSession implements CoordinatedBrowseSession {
  public readonly browse = jest.fn();
  public readonly load = jest.fn();
  public readonly pop = jest.fn();
}

describe("AlbumDetailResolver", () => {
  it("consumes one fresh live row and emits complete keyless detail evidence", async () => {
    const session = new ScriptedSession();
    session.browse.mockResolvedValueOnce(detail(["1. Human Behaviour", "2. Crying"]));

    const resolved = await new AlbumDetailResolver().resolve(
      session,
      artist(),
      album(),
      observed()
    );

    expect(resolved.orderedTrackTitles).toEqual([
      "1. Human Behaviour",
      "2. Crying",
    ]);
    expect(resolved.observation.albums[0].detail).toMatchObject({
      fieldInventoryComplete: true,
      headerTitle: "Debut",
      headerSubtitle: "Björk",
      returnedTrackCount: 2,
      totalTrackCount: 2,
      originalReleaseDateField: { status: "not-exposed" },
      editionReleaseDateField: { status: "not-exposed" },
    });
    expect(JSON.stringify(resolved)).not.toMatch(/album-0|track-0|play-album/u);
    expect(session.browse).toHaveBeenCalledWith({
      hierarchy: "artists",
      itemKey: "album-0",
      offset: 0,
      pageSize: 532,
    });
  });

  it("fails closed before browsing a duplicate descriptor", async () => {
    const session = new ScriptedSession();
    const duplicate = {
      exactTitle: "Debut",
      exactArtist: "Björk",
      editionText: "",
    };

    await expect(
      new AlbumDetailResolver().resolve(
        session,
        artist(),
        album(),
        observed([duplicate, duplicate])
      )
    ).rejects.toMatchObject({ code: "ALBUM_AMBIGUOUS" });
    expect(session.browse).not.toHaveBeenCalled();
  });

  it("revalidates duplicate descriptors by fingerprint with fresh parent keys", async () => {
    const duplicate = {
      exactTitle: "Debut",
      exactArtist: "Björk",
      editionText: "",
    };
    const initial = observed(
      [duplicate, duplicate],
      ["initial-album-0", "initial-album-1"]
    );
    const refreshed = observed(
      [duplicate, duplicate],
      ["refreshed-album-0", "refreshed-album-1"]
    );
    const finalParent = observed(
      [duplicate, duplicate],
      ["final-album-0", "final-album-1"]
    );
    const observer = {
      observeCurrent: jest
        .fn()
        .mockResolvedValueOnce(refreshed)
        .mockResolvedValueOnce(finalParent),
    };
    const session = new ScriptedSession();
    const parentResult = detail(["Parent placeholder"]);
    session.pop.mockResolvedValue(parentResult);
    session.browse
      .mockResolvedValueOnce(detail(["Different Track"]))
      .mockResolvedValueOnce(detail(["Matching Track"]))
      .mockResolvedValueOnce(detail(["Matching Track"]));

    const resolved = await new AlbumDetailResolver(observer).resolve(
      session,
      artist(),
      album({
        trackTitleFingerprint: createCatalogTrackTitleFingerprint([
          "Matching Track",
        ]),
      }),
      initial
    );

    expect(resolved.orderedTrackTitles).toEqual(["Matching Track"]);
    expect(session.browse.mock.calls.map(([options]) => options.itemKey)).toEqual([
      "initial-album-0",
      "refreshed-album-1",
      "final-album-1",
    ]);
    expect(session.pop).toHaveBeenCalledTimes(2);
    expect(session.pop).toHaveBeenNthCalledWith(1, {
      hierarchy: "artists",
      levels: 1,
      refresh: true,
      pageSize: 100,
    });
    expect(observer.observeCurrent).toHaveBeenNthCalledWith(
      1,
      session,
      expect.objectContaining({ localId: ARTIST_ID }),
      parentResult
    );
    expect(JSON.stringify(resolved)).not.toMatch(
      /initial-album|refreshed-album|final-album/u
    );
  });

  it("rejects zero or multiple duplicate fingerprint matches", async () => {
    const duplicate = {
      exactTitle: "Debut",
      exactArtist: "Björk",
      editionText: "",
    };
    const target = album({
      trackTitleFingerprint: createCatalogTrackTitleFingerprint(["Target"]),
    });

    for (const [tracks, code] of [
      [["Other A", "Other B"], "ALBUM_NOT_FOUND"],
      [["Target", "Target"], "ALBUM_AMBIGUOUS"],
    ] as const) {
      const session = new ScriptedSession();
      session.pop.mockResolvedValue(detail(["Parent placeholder"]));
      session.browse
        .mockResolvedValueOnce(detail([tracks[0]]))
        .mockResolvedValueOnce(detail([tracks[1]]));
      const observer = {
        observeCurrent: jest.fn().mockResolvedValueOnce(
          observed(
            [duplicate, duplicate],
            ["fresh-album-0", "fresh-album-1"]
          )
        ),
      };

      await expect(
        new AlbumDetailResolver(observer).resolve(
          session,
          artist(),
          target,
          observed(
            [duplicate, duplicate],
            ["initial-album-0", "initial-album-1"]
          )
        )
      ).rejects.toMatchObject({ code });
      expect(session.browse).toHaveBeenCalledTimes(2);
      expect(session.pop).toHaveBeenCalledTimes(1);
    }
  });

  it("uses newly observed parent authority even when Roon repeats an opaque key value", async () => {
    const duplicate = {
      exactTitle: "Debut",
      exactArtist: "Björk",
      editionText: "",
    };
    const session = new ScriptedSession();
    session.pop.mockResolvedValue(detail(["Parent placeholder"]));
    session.browse
      .mockResolvedValueOnce(detail(["Different Track"]))
      .mockResolvedValueOnce(detail(["Target"]))
      .mockResolvedValueOnce(detail(["Target"]));
    const observer = {
      observeCurrent: jest
        .fn()
        .mockResolvedValueOnce(
          observed(
            [duplicate, duplicate],
            ["fresh-album-0", "initial-album-0"]
          )
        )
        .mockResolvedValueOnce(
          observed(
            [duplicate, duplicate],
            ["final-album-0", "final-album-1"]
          )
        ),
    };

    await new AlbumDetailResolver(observer).resolve(
      session,
      artist(),
      album({
        trackTitleFingerprint: createCatalogTrackTitleFingerprint(["Target"]),
      }),
      observed(
        [duplicate, duplicate],
        ["initial-album-0", "initial-album-1"]
      )
    );
    expect(session.browse.mock.calls.map(([options]) => options.itemKey)).toEqual([
      "initial-album-0",
      "initial-album-0",
      "final-album-1",
    ]);
  });

  it("does not claim a nonempty catalog edition from unproven detail", async () => {
    const session = new ScriptedSession();
    await expect(
      new AlbumDetailResolver().resolve(
        session,
        artist(),
        album({ editionText: "Deluxe Edition" }),
        observed()
      )
    ).rejects.toMatchObject({ code: "ALBUM_AMBIGUOUS" });
    expect(session.browse).not.toHaveBeenCalled();
  });

  it("rejects incomplete, mixed, and oversized track evidence", async () => {
    const malformed: BrowseResult[] = [
      detail(["Track"], { totalCount: 3 }),
      detail(["Typed"], {
        items: [
          row("Typed", "typed", { subtitle: "Björk", itemType: "track" }),
          row("Untyped", "untyped", { subtitle: "Björk" }),
          row("Play Album", "play-album"),
        ],
        count: 3,
        totalCount: 3,
      }),
      detail(Array.from({ length: 501 }, (_, index) => `Track ${index + 1}`)),
    ];

    for (const value of malformed) {
      const session = new ScriptedSession();
      session.browse.mockResolvedValueOnce(value);
      await expect(
        new AlbumDetailResolver().resolve(
          session,
          artist(),
          album(),
          observed()
        )
      ).rejects.toMatchObject({ code: "DETAIL_INCOMPLETE" });
    }
  });

  it("rejects a changed header or prior track fingerprint", async () => {
    const wrongHeader = new ScriptedSession();
    wrongHeader.browse.mockResolvedValueOnce(
      detail(["Track"], { title: "Not Debut" })
    );
    await expect(
      new AlbumDetailResolver().resolve(
        wrongHeader,
        artist(),
        album(),
        observed()
      )
    ).rejects.toMatchObject({ code: "DETAIL_MISMATCH" });

    const wrongFingerprint = new ScriptedSession();
    wrongFingerprint.browse.mockResolvedValueOnce(detail(["Different Track"]));
    await expect(
      new AlbumDetailResolver().resolve(
        wrongFingerprint,
        artist(),
        album({
          trackTitleFingerprint: createCatalogTrackTitleFingerprint(["Track"]),
        }),
        observed()
      )
    ).rejects.toMatchObject({ code: "DETAIL_MISMATCH" });
  });

  it("lists every matching live edition as a display-only candidate", () => {
    const discography = observed([
      { exactTitle: "Debut", exactArtist: "Björk", editionText: "" },
      { exactTitle: "Debut", exactArtist: "Björk", editionText: "2011 Remaster" },
      { exactTitle: "Post", exactArtist: "Björk", editionText: "" },
    ]);

    const candidates = new AlbumDetailResolver().observeCandidates(
      discography,
      album()
    );

    expect(candidates).toEqual([
      { observationIndex: 0, title: "Debut", artist: "Björk", editionText: "" },
      {
        observationIndex: 1,
        title: "Debut",
        artist: "Björk",
        editionText: "2011 Remaster",
      },
    ]);
    expect(JSON.stringify(candidates)).not.toMatch(/album-\d/u);
  });

  it("opens one exact retained row even when blank-edition rows are identical", async () => {
    const session = new ScriptedSession();
    session.browse.mockResolvedValueOnce(
      detail(["1. Human Behaviour", "2. Crying", "3. Venus as a Boy"])
    );
    const discography = observed([
      { exactTitle: "Debut", exactArtist: "Björk", editionText: "" },
      { exactTitle: "Debut", exactArtist: "Björk", editionText: "" },
    ]);

    const resolved = await new AlbumDetailResolver().resolveObservedCandidate(
      session,
      artist(),
      album({ resolutionStatus: "ambiguous" }),
      discography,
      1
    );

    expect(resolved.orderedTrackTitles).toHaveLength(3);
    expect(session.browse).toHaveBeenCalledWith({
      hierarchy: "artists",
      itemKey: "album-1",
      offset: 0,
      pageSize: 532,
    });
  });

  it("re-binds a chooser descriptor to exactly its edition without a fingerprint proof", async () => {
    const session = new ScriptedSession();
    session.browse.mockResolvedValueOnce(
      detail(["1. Human Behaviour (Remaster)", "2. Crying (Remaster)"])
    );
    const discography = observed([
      { exactTitle: "Debut", exactArtist: "Björk", editionText: "" },
      { exactTitle: "Debut", exactArtist: "Björk", editionText: "2011 Remaster" },
    ]);

    const resolved = await new AlbumDetailResolver().resolveCandidate(
      session,
      artist(),
      // A catalog fingerprint from another edition must not veto the read.
      album({ trackTitleFingerprint: createCatalogTrackTitleFingerprint(["Other"]) }),
      discography,
      { title: "Debut", artist: "Björk", editionText: "2011 Remaster" }
    );

    expect(resolved.orderedTrackTitles).toEqual([
      "1. Human Behaviour (Remaster)",
      "2. Crying (Remaster)",
    ]);
    expect(session.browse).toHaveBeenCalledWith({
      hierarchy: "artists",
      itemKey: "album-1",
      offset: 0,
      pageSize: 532,
    });
  });

  it("fails closed when a descriptor matches zero or multiple live editions", async () => {
    const resolver = new AlbumDetailResolver();
    const gone = observed([
      { exactTitle: "Debut", exactArtist: "Björk", editionText: "" },
    ]);
    await expect(
      resolver.resolveCandidate(new ScriptedSession(), artist(), album(), gone, {
        title: "Debut",
        artist: "Björk",
        editionText: "2011 Remaster",
      })
    ).rejects.toMatchObject({ code: "ALBUM_NOT_FOUND" });

    const duplicated = observed([
      { exactTitle: "Debut", exactArtist: "Björk", editionText: "2011 Remaster" },
      { exactTitle: "Debut", exactArtist: "Björk", editionText: "2011 Remaster" },
    ]);
    await expect(
      resolver.resolveCandidate(
        new ScriptedSession(),
        artist(),
        album(),
        duplicated,
        { title: "Debut", artist: "Björk", editionText: "2011 Remaster" }
      )
    ).rejects.toMatchObject({ code: "ALBUM_AMBIGUOUS" });
  });

  it("keeps header proofs for chooser re-binds", async () => {
    const session = new ScriptedSession();
    session.browse.mockResolvedValueOnce(detail(["Track"], { title: "Not Debut" }));
    await expect(
      new AlbumDetailResolver().resolveCandidate(
        session,
        artist(),
        album(),
        observed(),
        { title: "Debut", artist: "Björk", editionText: "" }
      )
    ).rejects.toMatchObject({ code: "DETAIL_MISMATCH" });
  });
});
