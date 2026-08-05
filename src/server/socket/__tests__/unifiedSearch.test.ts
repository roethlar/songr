import { BrowseSessionCoordinatorError } from "../../../core/roon/BrowseSessionCoordinator";
import type {
  UnifiedSongActionRequest,
  UnifiedSongRelationshipRequest,
} from "../../../shared/unifiedSearchContracts";
import { registerUnifiedSearchSocket } from "../unifiedSearch";

class FakeSocket {
  public readonly id = "socket-1";
  public readonly handlers = new Map<
    string,
    (...args: unknown[]) => unknown
  >();

  on(event: string, handler: (...args: unknown[]) => unknown): void {
    this.handlers.set(event, handler);
  }

  trigger(event: string, ...args: unknown[]): unknown {
    const handler = this.handlers.get(event);
    if (!handler) throw new Error(`missing handler ${event}`);
    return handler(...args);
  }
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

const logger = {
  error: jest.fn(),
};

const rawSong = {
  title: "Dear Theodosia",
  subtitle: "Orlando Ballet Chorus",
  itemKey: "raw-song-key",
  imageKey: "image-key",
  hint: "action_list",
  resultType: "track",
  isLoadable: true,
  isPlayable: false,
};

const emptyResult = {
  level: 2,
  offset: 0,
  count: 0,
  items: [],
};

const restoredTracks = {
  title: "Tracks",
  level: 1,
  offset: 0,
  count: 1,
  totalCount: 1,
  items: [rawSong],
};

const zone = {
  zone_id: "zone-1",
  display_name: "Living Room",
  state: "paused",
  is_play_allowed: true,
  is_pause_allowed: true,
  is_previous_allowed: true,
  is_next_allowed: true,
  is_seek_allowed: true,
  outputs: [{ output_id: "output-1", display_name: "Living Room" }],
};

function searchRequest() {
  return {
    requestId: "search-request-1",
    tabId: "tab-1",
    session: { handleId: "handle-1", generation: 7 },
    query: "dear theodosia",
  };
}

function actionRequest(
  overrides: Partial<ReturnType<typeof actionRequestBase>> = {}
) {
  return { ...actionRequestBase(), ...overrides };
}

function actionRequestBase(): UnifiedSongActionRequest {
  return {
    requestId: "action-request-1",
    tabId: "tab-1",
    session: { handleId: "handle-1", generation: 7 },
    resultId: "opaque-song-key",
    zoneId: "zone-1",
    semantic: "play-now" as const,
  };
}

function clearRequest() {
  return {
    requestId: "clear-request-1",
    tabId: "tab-1",
    session: { handleId: "handle-1", generation: 7 },
  };
}

function relationshipRequest(): UnifiedSongRelationshipRequest {
  return {
    requestId: "relationship-request-1",
    tabId: "tab-1",
    session: { handleId: "handle-1", generation: 7 },
    resultId: "opaque-song-key",
  };
}

describe("Unified search socket adapter", () => {
  let socket: FakeSocket;
  let coordinator: {
    beginClassicPublishedItems: jest.Mock;
    runMode: jest.Mock;
    replaceClassicPublishedItems: jest.Mock;
    resolveClassicPublishedItemBinding: jest.Mock;
    runModeAction: jest.Mock;
    retainClassicPublishedItemsAfterRestore: jest.Mock;
    retireClassicPublishedItems: jest.Mock;
    clearClassicPublishedItems: jest.Mock;
  };
  let browseService: {
    searchTracksCoordinated: jest.Mock;
  };
  let actionSession: {
    browse: jest.Mock;
    load: jest.Mock;
    pop: jest.Mock;
    executeAction: jest.Mock;
  };
  let resolver: {
    resolve: jest.Mock;
  };
  let zones: {
    getZone: jest.Mock;
  };
  let songRelationships: {
    resolve: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    socket = new FakeSocket();
    actionSession = {
      browse: jest.fn(),
      load: jest.fn(),
      pop: jest.fn().mockResolvedValue(restoredTracks),
      executeAction: jest.fn(
        async (
          _options: unknown,
          assertBeforeIssue: () => void,
          onIssued: () => void
        ) => {
          assertBeforeIssue();
          onIssued();
          return emptyResult;
        }
      ),
    };
    coordinator = {
      beginClassicPublishedItems: jest.fn(() => 11),
      runMode: jest.fn(async (_access, _role, work) =>
        work({ browse: jest.fn() })
      ),
      replaceClassicPublishedItems: jest.fn((_access, _role, _generation, songs) =>
        songs.map((song: typeof rawSong) => ({
          token: "opaque-song-key",
          item: {
            title: song.title,
            subtitle: song.subtitle,
            imageKey: song.imageKey,
            hint: song.hint,
            isLoadable: song.isLoadable,
            isPlayable: song.isPlayable,
          },
        }))
      ),
      resolveClassicPublishedItemBinding: jest.fn(() => ({
        authorityGeneration: 11,
        item: rawSong,
      })),
      runModeAction: jest.fn(async (_access, _role, work) =>
        work(actionSession)
      ),
      retainClassicPublishedItemsAfterRestore: jest.fn(() => true),
      retireClassicPublishedItems: jest.fn(() => true),
      clearClassicPublishedItems: jest.fn(),
    };
    browseService = {
      searchTracksCoordinated: jest.fn().mockResolvedValue({
        page: restoredTracks,
        songs: [rawSong],
      }),
    };
    resolver = {
      resolve: jest.fn(
        async (
          _session: unknown,
          _song: unknown,
          _zoneId: string,
          semantic: string
        ) => ({
          itemKey: `raw-${semantic}`,
          navigationDepth: 1,
        })
      ),
    };
    zones = {
      getZone: jest.fn(() => zone),
    };
    songRelationships = {
      resolve: jest.fn().mockResolvedValue({
        songTitle: "Dear Theodosia",
        albums: [
          {
            albumLocalId: "album-1",
            artistLocalId: "artist-1",
            title: "Hamilton",
            artist: "Orlando Ballet Chorus",
            editionText: "",
          },
        ],
        composerLabels: [],
      }),
    };
    registerUnifiedSearchSocket(socket as never, {
      coordinator: coordinator as never,
      browseService: browseService as never,
      zones: zones as never,
      songActionResolver: resolver,
      songRelationships,
      getCoreId: () => "core-1",
      logger: logger as never,
    });
  });

  it("looks up relationships from the retained server title and rechecks the result", async () => {
    const ack = jest.fn();

    await socket.trigger(
      "unified-search:relationship",
      relationshipRequest(),
      ack
    );

    expect(songRelationships.resolve).toHaveBeenCalledWith(
      "core-1",
      "Dear Theodosia",
      "Orlando Ballet Chorus"
    );
    expect(coordinator.resolveClassicPublishedItemBinding).toHaveBeenCalledTimes(
      2
    );
    expect(ack).toHaveBeenCalledWith({
      success: true,
      data: {
        requestId: "relationship-request-1",
        session: { handleId: "handle-1", generation: 7 },
        resultId: "opaque-song-key",
        songTitle: "Dear Theodosia",
        albums: [
          {
            albumLocalId: "album-1",
            artistLocalId: "artist-1",
            title: "Hamilton",
            artist: "Orlando Ballet Chorus",
            editionText: "",
          },
        ],
        composerLabels: [],
      },
    });
  });

  it("drops a relationship result when the retained song changes during lookup", async () => {
    const ack = jest.fn();
    coordinator.resolveClassicPublishedItemBinding
      .mockReturnValueOnce({
        authorityGeneration: 11,
        item: rawSong,
      })
      .mockReturnValueOnce({
        authorityGeneration: 12,
        item: { ...rawSong, itemKey: "replacement-key" },
      });

    await socket.trigger(
      "unified-search:relationship",
      relationshipRequest(),
      ack
    );

    expect(ack).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        code: "STALE_RESULT",
      })
    );
  });

  it("clears the old authority before searching and publishes opaque song IDs", async () => {
    const ack = jest.fn();
    const order: string[] = [];
    coordinator.beginClassicPublishedItems.mockImplementation(() => {
      order.push("clear");
      return 11;
    });
    coordinator.runMode.mockImplementation(async (_access, _role, work) => {
      order.push("search");
      return work({ browse: jest.fn() });
    });

    await socket.trigger("unified-search:search", searchRequest(), ack);

    expect(order).toEqual(["clear", "search"]);
    expect(browseService.searchTracksCoordinated).toHaveBeenCalledWith(
      expect.any(Object),
      { input: "dear theodosia", popAll: true }
    );
    expect(coordinator.replaceClassicPublishedItems).toHaveBeenCalledWith(
      expect.any(Object),
      "classic-search",
      11,
      [rawSong],
      restoredTracks
    );
    const payload = ack.mock.calls[0]?.[0];
    expect(payload).toEqual({
      success: true,
      data: {
        requestId: "search-request-1",
        session: { handleId: "handle-1", generation: 7 },
        query: "dear theodosia",
        results: [
          {
            resultId: "opaque-song-key",
            title: "Dear Theodosia",
            subtitle: "Orlando Ballet Chorus",
            imageKey: "image-key",
          },
        ],
      },
    });
    expect(JSON.stringify(payload)).not.toContain("\"itemKey\"");
  });

  it("rejects malformed searches before touching the coordinator", async () => {
    const ack = jest.fn();

    await socket.trigger(
      "unified-search:search",
      { ...searchRequest(), query: " " },
      ack
    );

    expect(coordinator.beginClassicPublishedItems).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        code: "INVALID_REQUEST",
      })
    );
  });

  it("executes the requested semantic from the retained row without searching again", async () => {
    const ack = jest.fn();

    await socket.trigger(
      "unified-search:action",
      actionRequest({ semantic: "add-next" }),
      ack
    );

    expect(browseService.searchTracksCoordinated).not.toHaveBeenCalled();
    expect(resolver.resolve).toHaveBeenCalledWith(
      actionSession,
      rawSong,
      "zone-1",
      "add-next"
    );
    expect(actionSession.executeAction).toHaveBeenCalledWith(
      {
        hierarchy: "search",
        zoneId: "zone-1",
        itemKey: "raw-add-next",
      },
      expect.any(Function),
      expect.any(Function)
    );
    expect(actionSession.pop).toHaveBeenCalledWith({
      hierarchy: "search",
      zoneId: "zone-1",
      levels: 1,
      pageSize: 50,
    });
    expect(ack).toHaveBeenCalledWith({
      success: true,
      data: {
        requestId: "action-request-1",
        session: { handleId: "handle-1", generation: 7 },
        resultId: "opaque-song-key",
        semantic: "add-next",
        outcome: "executed",
        authorityRetired: false,
      },
    });
  });

  it("allows only one in-flight action for a song", async () => {
    const gate = deferred<void>();
    actionSession.executeAction.mockImplementationOnce(
      async (
        _options: unknown,
        assertBeforeIssue: () => void,
        onIssued: () => void
      ) => {
        assertBeforeIssue();
        onIssued();
        await gate.promise;
        return emptyResult;
      }
    );
    const firstAck = jest.fn();
    const secondAck = jest.fn();

    const first = socket.trigger(
      "unified-search:action",
      actionRequest(),
      firstAck
    ) as Promise<void>;
    await flushPromises();
    await socket.trigger(
      "unified-search:action",
      actionRequest({ requestId: "action-request-2" }),
      secondAck
    );

    expect(secondAck).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        code: "BACKPRESSURE",
      })
    );
    expect(actionSession.executeAction).toHaveBeenCalledTimes(1);
    gate.resolve();
    await first;
    expect(firstAck).toHaveBeenCalledWith(
      expect.objectContaining({ success: true })
    );
  });

  it("fails before issue when the zone grouping changes", async () => {
    zones.getZone
      .mockReturnValueOnce(zone)
      .mockReturnValueOnce({
        ...zone,
        outputs: [{ output_id: "output-2", display_name: "Office" }],
      });
    const ack = jest.fn();
    const reusedAck = jest.fn();
    const freshAck = jest.fn();

    await socket.trigger("unified-search:action", actionRequest(), ack);
    await socket.trigger(
      "unified-search:action",
      actionRequest(),
      reusedAck
    );
    await socket.trigger(
      "unified-search:action",
      actionRequest({ requestId: "action-request-2" }),
      freshAck
    );

    expect(ack).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        code: "ZONE_CHANGED",
      })
    );
    expect(reusedAck).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        code: "REQUEST_ID_CONFLICT",
      })
    );
    expect(freshAck).toHaveBeenCalledWith(
      expect.objectContaining({ success: true })
    );
    expect(actionSession.executeAction).toHaveBeenCalledTimes(2);
    expect(coordinator.retainClassicPublishedItemsAfterRestore).toHaveBeenCalled();
  });

  it("reports an issued failure as outcome unknown and never reuses its request ID", async () => {
    actionSession.executeAction.mockImplementationOnce(
      async (
        _options: unknown,
        assertBeforeIssue: () => void,
        onIssued: () => void
      ) => {
        assertBeforeIssue();
        onIssued();
        throw new Error("Core acknowledgment timed out");
      }
    );
    const firstAck = jest.fn();
    const retryAck = jest.fn();

    await socket.trigger(
      "unified-search:action",
      actionRequest(),
      firstAck
    );
    await socket.trigger(
      "unified-search:action",
      actionRequest(),
      retryAck
    );

    expect(firstAck).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        code: "OUTCOME_UNKNOWN",
      })
    );
    expect(retryAck).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        code: "REQUEST_ID_CONFLICT",
      })
    );
    expect(actionSession.executeAction).toHaveBeenCalledTimes(1);
    expect(coordinator.retireClassicPublishedItems).toHaveBeenCalled();
  });

  it("fails closed for a stale opaque result", async () => {
    coordinator.resolveClassicPublishedItemBinding.mockImplementationOnce(() => {
      throw new BrowseSessionCoordinatorError(
        "STALE_GENERATION",
        "The result was replaced"
      );
    });
    const ack = jest.fn();

    await socket.trigger("unified-search:action", actionRequest(), ack);

    expect(ack).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        code: "STALE_RESULT",
      })
    );
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it("explicitly clears retained result authority when search closes", () => {
    const ack = jest.fn();

    socket.trigger("unified-search:clear", clearRequest(), ack);

    expect(coordinator.clearClassicPublishedItems).toHaveBeenCalledWith(
      expect.objectContaining({
        coreId: "core-1",
        socketId: "socket-1",
        tabId: "tab-1",
      }),
      "classic-search"
    );
    expect(ack).toHaveBeenCalledWith({
      success: true,
      data: {
        requestId: "clear-request-1",
        session: { handleId: "handle-1", generation: 7 },
      },
    });
  });
});
