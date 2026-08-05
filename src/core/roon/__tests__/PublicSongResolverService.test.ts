import type { BrowseService } from "../BrowseService";
import {
  BrowseSessionCoordinator,
  ModeSessionAccess,
} from "../BrowseSessionCoordinator";
import {
  PublicSongResolverError,
  PublicSongResolverService,
  PublicSongSourceVerifier,
} from "../PublicSongResolverService";
import {
  PublicSongSelection,
  PublicSongSelectionRegistry,
} from "../PublicSongSelectionRegistry";
import {
  SongActionResolutionError,
  SongActionResolverPort,
} from "../SongActionResolver";

function selection(
  overrides: Partial<PublicSongSelection> = {}
): PublicSongSelection {
  return {
    coreId: "core-1",
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

function row(
  itemKey: string,
  title = "Seven Nation Army",
  subtitle = "The White Stripes, Jack White"
) {
  return {
    title,
    subtitle,
    itemKey,
    hint: "action_list",
    isLoadable: true,
    isPlayable: false,
    resultType: "track" as const,
    categoryTitle: "Tracks",
    categoryTotal: 1,
  };
}

function searchResult(
  rows: ReturnType<typeof row>[],
  totalCount = rows.length
): Awaited<ReturnType<BrowseService["searchTracksCoordinated"]>> {
  return {
    page: {
      title: "Tracks",
      level: 1,
      offset: 0,
      count: totalCount,
      totalCount,
      items: rows,
    },
    songs: rows,
  };
}

function zone(outputId = "output-1") {
  return {
    zone_id: "zone-1",
    display_name: "Office",
    outputs: [{ output_id: outputId }],
  };
}

function expectResolverCode(
  promise: Promise<unknown>,
  code: PublicSongResolverError["code"]
): Promise<void> {
  return expect(promise).rejects.toMatchObject({
    name: "PublicSongResolverError",
    code,
  });
}

describe("PublicSongResolverService", () => {
  let coordinator: BrowseSessionCoordinator;
  let registry: PublicSongSelectionRegistry;
  let access: ModeSessionAccess;
  let searchTracks: jest.MockedFunction<
    BrowseService["searchTracksCoordinated"]
  >;
  let baseBrowse: jest.Mock;
  let sourceVerifier: jest.Mocked<PublicSongSourceVerifier>;
  let songActionResolver: jest.Mocked<SongActionResolverPort>;
  let currentZone: ReturnType<typeof zone> | undefined;

  beforeEach(() => {
    baseBrowse = jest.fn(async (_options, lifecycle) => {
      lifecycle?.onIssued?.();
      return {
        title: "Action",
        level: 2,
        offset: 0,
        count: 0,
        totalCount: 0,
        items: [],
      };
    });
    const coordinatorBrowse = {
      browse: baseBrowse,
      load: jest.fn(),
      pop: jest.fn(),
    } as unknown as BrowseService;
    coordinator = new BrowseSessionCoordinator(coordinatorBrowse, {
      randomId: (() => {
        let id = 0;
        return () => `id-${(id += 1)}`;
      })(),
    });
    const handle = coordinator.acquireMode({
      coreId: "core-1",
      socketId: "socket-1",
      tabId: "tab-1",
      mode: "classic",
    });
    access = {
      coreId: "core-1",
      socketId: "socket-1",
      tabId: "tab-1",
      handle,
    };
    registry = new PublicSongSelectionRegistry({
      randomId: (() => {
        let id = 0;
        return () => `selection-${(id += 1)}`;
      })(),
    });
    searchTracks = jest.fn();
    sourceVerifier = {
      verify: jest.fn(async (_selection) => ({ state: "current" as const })),
    };
    songActionResolver = {
      resolve: jest.fn(
        async (_session, _song, _zoneId, _semantic) => ({
          itemKey: "raw-action",
          navigationDepth: 0,
        })
      ),
    };
    currentZone = zone();
  });

  afterEach(() => coordinator.shutdown());

  function service(): PublicSongResolverService {
    return new PublicSongResolverService({
      coordinator,
      browseService: { searchTracksCoordinated: searchTracks },
      selectionRegistry: registry,
      sourceVerifier,
      zones: { getZone: () => currentZone as never },
      songActionResolver,
    });
  }

  async function resolveOne(
    source = selection(),
    rows = [row("raw-song")]
  ) {
    const selectionId = registry.publish(source);
    searchTracks.mockResolvedValueOnce(searchResult(rows));
    const result = await service().resolve({ access, selectionId });
    if (result.kind !== "authorized") {
      throw new Error(`expected authorized result, got ${result.kind}`);
    }
    return { selectionId, candidateId: result.candidate.candidateId };
  }

  it("publishes one exact candidate by replacing Unified palette authority", async () => {
    const paletteGeneration = coordinator.beginClassicPublishedItems(
      access,
      "classic-search"
    );
    const palette = coordinator.replaceClassicPublishedItems(
      access,
      "classic-search",
      paletteGeneration,
      [row("raw-palette", "Palette Song", "Palette Artist")],
      { title: "Tracks", level: 1 }
    )[0]!;
    const { candidateId } = await resolveOne();

    expect(() =>
      coordinator.resolveClassicPublishedItem(
        access,
        "classic-search",
        palette.token
      )
    ).toThrow(expect.objectContaining({ code: "STALE_GENERATION" }));
    expect(
      coordinator.resolveClassicPublishedItem(
        access,
        "classic-search",
        candidateId
      ).itemKey
    ).toBe("raw-song");
  });

  it("fails closed on incomplete search and never publishes partial candidates", async () => {
    const selectionId = registry.publish(selection());
    searchTracks.mockResolvedValueOnce(searchResult([row("partial")], 2));
    await expect(
      service().resolve({ access, selectionId })
    ).resolves.toEqual({
      kind: "unavailable",
      reason: {
        code: "search-incomplete",
        message: "Roon returned an incomplete song search; no action was taken",
      },
    });
  });

  it("requires exact normalized title and a complete source-artist label", async () => {
    const selectionId = registry.publish(selection());
    searchTracks.mockResolvedValueOnce(
      searchResult([
        row("wrong-title", "Seven Nation Army (Live)"),
        row("wrong-artist", "Seven Nation Army", "2CELLOS, Jack White"),
        row("first", "Seven Nation Army", "The White Stripes, Jack White"),
        row("second", "Seven Nation Army", "The White Stripes; Jack White"),
      ])
    );
    const result = await service().resolve({ access, selectionId });

    expect(result).toMatchObject({
      kind: "choice-required",
      candidates: [
        { title: "Seven Nation Army" },
        { title: "Seven Nation Army" },
      ],
    });
  });

  it.each([
    "Various Artists",
    "Various Performers",
    "Unknown Artist",
    "Unknown Artists",
  ])(
    "keeps the aggregate artist label %s chooser-only",
    async (artist) => {
      const selectionId = registry.publish(selection({ artist }));
      searchTracks.mockResolvedValueOnce(
        searchResult([
          row("first", "Seven Nation Army", "The White Stripes, Jack White"),
        ])
      );

      await expect(
        service().resolve({ access, selectionId })
      ).resolves.toMatchObject({
        kind: "choice-required",
        candidates: [{ title: "Seven Nation Army" }],
      });
    }
  );

  it("invalidates a source that the fresh verification says changed", async () => {
    const selectionId = registry.publish(selection());
    sourceVerifier.verify.mockResolvedValueOnce({ state: "changed" });
    await expect(
      service().resolve({ access, selectionId })
    ).resolves.toMatchObject({
      kind: "unavailable",
      reason: { code: "source-changed" },
    });
    expect(() => registry.resolve(selectionId, "core-1")).toThrow(
      "expired"
    );
    expect(searchTracks).not.toHaveBeenCalled();
  });

  it("executes through the exact resolver authority and retires the source on success", async () => {
    const resolved = await resolveOne();
    const result = await service().execute({
      access,
      ...resolved,
      zoneId: "zone-1",
      semantic: "play-now",
    });

    expect(result).toEqual({ authorityRetired: true });
    expect(songActionResolver.resolve).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ itemKey: "raw-song" }),
      "zone-1",
      "play-now"
    );
    expect(() => registry.resolve(resolved.selectionId, "core-1")).toThrow(
      "expired"
    );
  });

  it("allows only one action in flight for a selection", async () => {
    const resolved = await resolveOne();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    sourceVerifier.verify.mockImplementationOnce(async () => {
      await gate;
      return { state: "current" };
    });
    const first = service().execute({
      access,
      ...resolved,
      zoneId: "zone-1",
      semantic: "queue",
    });
    await Promise.resolve();
    await expectResolverCode(
      service().execute({
        access,
        ...resolved,
        zoneId: "zone-1",
        semantic: "queue",
      }),
      "IN_FLIGHT"
    );
    release();
    await expect(first).resolves.toEqual({ authorityRetired: true });
  });

  it("restores the selection after a pre-issue action-resolution failure", async () => {
    const resolved = await resolveOne();
    songActionResolver.resolve.mockRejectedValueOnce(
      new SongActionResolutionError("no action", 0)
    );

    await expectResolverCode(
      service().execute({
        access,
        ...resolved,
        zoneId: "zone-1",
        semantic: "add-next",
      }),
      "ACTION_UNAVAILABLE"
    );
    expect(registry.resolve(resolved.selectionId, "core-1")).toBeDefined();
  });

  it("retires a freshly changed source before any action can issue", async () => {
    const resolved = await resolveOne();
    sourceVerifier.verify.mockResolvedValueOnce({ state: "changed" });

    await expectResolverCode(
      service().execute({
        access,
        ...resolved,
        zoneId: "zone-1",
        semantic: "play-now",
      }),
      "SOURCE_CHANGED"
    );
    expect(baseBrowse).not.toHaveBeenCalled();
    expect(() => registry.resolve(resolved.selectionId, "core-1")).toThrow(
      "expired"
    );
  });

  it("retires source and public authority when an issued action has unknown outcome", async () => {
    const resolved = await resolveOne();
    baseBrowse.mockImplementationOnce(async (_options, lifecycle) => {
      lifecycle?.onIssued?.();
      throw new Error("connection lost after issue");
    });

    await expectResolverCode(
      service().execute({
        access,
        ...resolved,
        zoneId: "zone-1",
        semantic: "play-now",
      }),
      "OUTCOME_UNKNOWN"
    );
    expect(() => registry.resolve(resolved.selectionId, "core-1")).toThrow(
      "expired"
    );
    expect(() =>
      coordinator.resolveClassicPublishedItem(
        access,
        "classic-search",
        resolved.candidateId
      )
    ).toThrow(expect.objectContaining({ code: "STALE_GENERATION" }));
  });

  it("rechecks zone topology at the exact handoff and restores on pre-issue refusal", async () => {
    const resolved = await resolveOne();
    baseBrowse.mockImplementationOnce(async (_options, lifecycle) => {
      currentZone = zone("regrouped-output");
      lifecycle?.onIssued?.();
      throw new Error("should not issue");
    });

    await expectResolverCode(
      service().execute({
        access,
        ...resolved,
        zoneId: "zone-1",
        semantic: "play-now",
      }),
      "ZONE_CHANGED"
    );
    expect(registry.resolve(resolved.selectionId, "core-1")).toBeDefined();
  });
});
