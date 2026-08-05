/**
 * Slice-7 guards for the playlist wire contracts: strict normalization of
 * both playlist endpoints, opaque on-demand row authority, and an honest
 * truncated marker only below the Core-reported total.
 */
import { CatalogStatus } from "../timelineCatalogContracts";
import {
  normalizePlaylistContentsResponse,
  normalizePlaylistsResponse,
  PlaylistContentsResponse,
  PlaylistsResponse,
  PLAYLIST_CONTENTS_MAX_ITEMS,
} from "../playlistContracts";

const STATUS: CatalogStatus = {
  coreId: "core-a",
  freshness: "fresh",
  persistence: "healthy",
  refresh: "idle",
  available: true,
  complete: true,
  revision: 3,
  artistCount: 1,
  albumCount: 2,
  updatedAt: "2026-07-26T12:00:00.000Z",
  lastCompleteScanAt: "2026-07-26T11:00:00.000Z",
};

function playlists(): PlaylistsResponse {
  return {
    status: STATUS,
    pulledAt: "2026-07-26T12:00:00.000Z",
    playlists: [
      {
        playlistId: "aa".repeat(20),
        name: "Last Year",
        kind: "smart",
        trackCount: 481,
        openable: true,
        actions: {
          editCriteria: true,
          rename: false,
          setDescription: false,
          manageItems: false,
        },
      },
      {
        playlistId: "bb".repeat(20),
        name: "Tidal Picks",
        kind: "manual",
        trackCount: null,
        openable: false,
        unopenableReason: "streaming-service playlists are not supported",
        actions: {
          editCriteria: false,
          rename: false,
          setDescription: false,
          manageItems: false,
        },
      },
    ],
    writes: { available: true },
  };
}

function contents(): PlaylistContentsResponse {
  return {
    status: STATUS,
    playlistId: "aa".repeat(20),
    name: "Last Year",
    kind: "smart",
    totalCount: 481,
    truncated: true,
    items: [
      {
        position: 0,
        title: "Defying Gravity",
        artist: "Orlando Ballet Chorus",
        albumTitle: "Wicked",
        lengthSeconds: 305,
        authority: {
          state: "resolver-capable",
          selectionId: "playlist-selection-1",
        },
      },
      {
        position: 1,
        title: "Off Catalog",
        artist: "Someone",
        albumTitle: "",
        lengthSeconds: null,
        authority: {
          state: "unavailable",
          reason: {
            code: "source-unavailable",
            message: "this track is not available in the current source",
          },
        },
      },
    ],
  };
}

function wireCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("normalizePlaylistsResponse", () => {
  it("round-trips a valid response", () => {
    const value = playlists();
    expect(normalizePlaylistsResponse(wireCopy(value))).toEqual(value);
  });

  it("rejects an openable playlist carrying a reason and vice versa", () => {
    const withReason = wireCopy(playlists()) as any;
    withReason.playlists[0].unopenableReason = "contradiction";
    expect(normalizePlaylistsResponse(withReason)).toBeNull();
    const noReason = wireCopy(playlists()) as any;
    delete noReason.playlists[1].unopenableReason;
    expect(normalizePlaylistsResponse(noReason)).toBeNull();
  });

  it("rejects duplicate ids, bad kinds, and malformed ids", () => {
    const dup = wireCopy(playlists()) as any;
    dup.playlists[1] = { ...dup.playlists[0] };
    expect(normalizePlaylistsResponse(dup)).toBeNull();
    const badKind = wireCopy(playlists()) as any;
    badKind.playlists[0].kind = "curated";
    expect(normalizePlaylistsResponse(badKind)).toBeNull();
    const badId = wireCopy(playlists()) as any;
    badId.playlists[0].playlistId = "XYZ";
    expect(normalizePlaylistsResponse(badId)).toBeNull();
  });

  it("enforces the Slice-11 writes/actions honesty invariants", () => {
    // Actions present while writes are unavailable: dishonest.
    const hiddenWrites = wireCopy(playlists()) as any;
    hiddenWrites.writes = { available: false, unavailableReason: "pin mismatch" };
    expect(normalizePlaylistsResponse(hiddenWrites)).toBeNull();
    // Writes available but a playlist carries no actions: dishonest.
    const missingActions = wireCopy(playlists()) as any;
    delete missingActions.playlists[0].actions;
    expect(normalizePlaylistsResponse(missingActions)).toBeNull();
    // Unavailable without its reason (and vice versa): dishonest.
    const noReason = wireCopy(playlists()) as any;
    noReason.writes = { available: false };
    expect(normalizePlaylistsResponse(noReason)).toBeNull();
    const strayReason = wireCopy(playlists()) as any;
    strayReason.writes = { available: true, unavailableReason: "contradiction" };
    expect(normalizePlaylistsResponse(strayReason)).toBeNull();
    // The removed browser deletion action is an unknown key, not a
    // compatibility alias.
    const staleDeleteAction = wireCopy(playlists()) as any;
    staleDeleteAction.playlists[0].actions.delete = false;
    expect(normalizePlaylistsResponse(staleDeleteAction)).toBeNull();
    // The unavailable shape without actions round-trips.
    const unavailable = wireCopy(playlists()) as any;
    unavailable.writes = { available: false, unavailableReason: "pin mismatch" };
    for (const entry of unavailable.playlists) delete entry.actions;
    expect(normalizePlaylistsResponse(unavailable)).not.toBeNull();
  });
});

describe("normalizePlaylistContentsResponse", () => {
  it("round-trips a valid response", () => {
    const value = contents();
    expect(normalizePlaylistContentsResponse(wireCopy(value))).toEqual(value);
  });

  it("accepts only opaque initial row authority and rejects raw identities", () => {
    const missing = wireCopy(contents()) as any;
    delete missing.items[0].authority;
    expect(normalizePlaylistContentsResponse(missing)).toBeNull();
    const publicAuthorized = wireCopy(contents()) as any;
    publicAuthorized.items[0].authority = {
      state: "public-authorized",
      selectionId: "playlist-selection-1",
      candidate: {
        candidateId: "candidate-1",
        title: "Defying Gravity",
        subtitle: "Orlando Ballet Chorus",
        imageKey: null,
      },
    };
    expect(normalizePlaylistContentsResponse(publicAuthorized)).toBeNull();
    const rawNativeId = wireCopy(contents()) as any;
    rawNativeId.items[0].nativeTrackId = "7001";
    expect(normalizePlaylistContentsResponse(rawNativeId)).toBeNull();
    const wrongReason = wireCopy(contents()) as any;
    wrongReason.items[1].authority.reason.message = "album not found";
    expect(normalizePlaylistContentsResponse(wrongReason)).toBeNull();
  });

  it("rejects a dishonest truncated marker", () => {
    const value = wireCopy(contents()) as any;
    value.totalCount = 2; // items.length >= total → truncated is a lie
    expect(normalizePlaylistContentsResponse(value)).toBeNull();
    const nullTotal = wireCopy(contents()) as any;
    nullTotal.totalCount = null;
    expect(normalizePlaylistContentsResponse(nullTotal)).toBeNull();
  });

  it("accepts an untruncated page and rejects oversized pages", () => {
    const value = wireCopy(contents()) as any;
    value.truncated = false;
    value.totalCount = 2;
    expect(normalizePlaylistContentsResponse(value)).not.toBeNull();
    const oversized = wireCopy(contents()) as any;
    oversized.items = Array.from({ length: PLAYLIST_CONTENTS_MAX_ITEMS + 1 }, (_, i) => ({
      position: i,
      title: `T${i}`,
      artist: "",
      albumTitle: "",
      lengthSeconds: null,
      authority: {
        state: "unavailable",
        reason: {
          code: "source-unavailable",
          message: "this track is not available in the current source",
        },
      },
    }));
    oversized.totalCount = oversized.items.length;
    oversized.truncated = false;
    expect(normalizePlaylistContentsResponse(oversized)).toBeNull();
  });
});
