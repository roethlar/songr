import {
  MostPlayedPerformerDrillResponse,
  MostPlayedReleaseDrillResponse,
  MostPlayedResponse,
  normalizeMostPlayedPerformerDrillResponse,
  normalizeMostPlayedReleaseDrillResponse,
  normalizeMostPlayedResponse,
} from "../mostPlayedContracts";
import { PUBLIC_SONG_UNAVAILABLE_MESSAGES } from "../publicSongResolverContracts";
import type { CatalogStatus } from "../catalogContracts";

const STATUS: CatalogStatus = {
  coreId: "core-a",
  freshness: "fresh",
  persistence: "healthy",
  refresh: "idle",
  available: true,
  complete: true,
  revision: 1,
  artistCount: 1,
  albumCount: 1,
  updatedAt: "2026-07-26T09:00:00.000Z",
  lastCompleteScanAt: "2026-07-26T09:00:00.000Z",
};

function valid(): MostPlayedResponse {
  return {
    status: STATUS,
    pulledAt: "2026-07-26T12:00:00.000Z",
    topPerformers: [
      {
        name: "Lio-Marcus Mendel",
        minutes: 72,
        selectionId: "performer-selection-1",
      },
      {
        name: "Ghost Artist",
        minutes: 45,
        selectionId: "performer-selection-2",
      },
    ],
    topReleases: [
      {
        title: "In the Hollows",
        artist: "Lio-Marcus Mendel",
        version: "Orlando Ballet Chorus",
        minutes: 72,
        selectionId: "release-selection-1",
        albumLocalId: "20000000-0000-4000-8000-000000000001",
        imageKeyHint: "abc123",
      },
      {
        title: "Ghost Album",
        artist: "Nobody",
        version: "",
        minutes: 30,
        selectionId: "release-selection-2",
      },
    ],
    topTracks: [
      {
        title: "Breathe",
        albumTitle: "In the Hollows",
        artist: "Mara Guzman",
        mediaNumber: 1,
        trackNumber: 4,
        available: true,
        playCount: 19,
        authority: {
          state: "resolver-capable",
          selectionId: "track-selection-1",
        },
        albumLocalId: "20000000-0000-4000-8000-000000000001",
        imageKeyHint: "abc123",
      },
      {
        title: "When You're Home",
        albumTitle: "In the Hollows",
        artist: "Mara Guzman",
        mediaNumber: 1,
        trackNumber: 6,
        available: false,
        playCount: 12,
        authority: {
          state: "unavailable",
          reason: {
            code: "source-unavailable",
            message: PUBLIC_SONG_UNAVAILABLE_MESSAGES["source-unavailable"],
          },
        },
      },
    ],
  };
}

function wireCopy(value: unknown): any {
  return JSON.parse(JSON.stringify(value));
}

describe("normalizeMostPlayedResponse", () => {
  it("round-trips a valid all-time response", () => {
    const response = valid();
    expect(normalizeMostPlayedResponse(wireCopy(response))).toEqual(response);
  });

  it.each<[string, (value: any) => void]>([
    [
      "performer minutes ascending",
      (value) => {
        value.topPerformers = [
          { name: "B", minutes: 10, selectionId: "performer-b" },
          { name: "A", minutes: 90, selectionId: "performer-a" },
        ];
      },
    ],
    [
      "release tie-break descending",
      (value) => {
        value.topReleases = [
          {
            title: "Zulu",
            artist: "",
            version: "",
            minutes: 10,
            selectionId: "release-z",
          },
          {
            title: "alpha",
            artist: "",
            version: "",
            minutes: 10,
            selectionId: "release-a",
          },
        ];
      },
    ],
    [
      "track counts ascending",
      (value) => {
        value.topTracks = [
          { ...value.topTracks[0], title: "A", playCount: 1 },
          { ...value.topTracks[1], title: "B", playCount: 2 },
        ];
      },
    ],
    [
      "zero minutes",
      (value) => {
        value.topPerformers[1].minutes = 0;
      },
    ],
    [
      "a generic performer label",
      (value) => {
        value.topPerformers[0].name = "VARIOUS ARTISTS";
      },
    ],
    [
      "an invalid album localId",
      (value) => {
        value.topReleases[0].albumLocalId = "not-a-local-id";
      },
    ],
    [
      "an invalid opaque performer selection",
      (value) => {
        value.topPerformers[0].selectionId = "spaces are forbidden";
      },
    ],
    [
      "an authority that contradicts track availability",
      (value) => {
        value.topTracks[0].available = false;
      },
    ],
    [
      "a duplicated opaque authority",
      (value) => {
        value.topReleases[0].selectionId =
          value.topPerformers[0].selectionId;
      },
    ],
    [
      "a raw native identity field",
      (value) => {
        value.topTracks[0].trackId = "7001";
      },
    ],
    [
      "an empty track title",
      (value) => {
        value.topTracks[0].title = "";
      },
    ],
    [
      "an extra entry key",
      (value) => {
        value.topReleases[0].playCount = 7;
      },
    ],
    [
      "legacy periods",
      (value) => {
        value.periods = [];
      },
    ],
    [
      "a non-canonical pulledAt",
      (value) => {
        value.pulledAt = "yesterday";
      },
    ],
  ])("rejects %s", (_name, mutate) => {
    const damaged = wireCopy(valid());
    mutate(damaged);
    expect(normalizeMostPlayedResponse(damaged)).toBeNull();
  });

  it("rejects non-record values", () => {
    expect(normalizeMostPlayedResponse(null)).toBeNull();
    expect(normalizeMostPlayedResponse([])).toBeNull();
    expect(normalizeMostPlayedResponse("most-played")).toBeNull();
  });
});

function drillTrack(
  over: Partial<
    MostPlayedPerformerDrillResponse["releases"][number]["tracks"][number]
  > = {}
) {
  return {
    title: "Breathe",
    artist: "Mara Guzman",
    albumTitle: "In the Hollows",
    lengthSeconds: 253,
    mediaNumber: 1,
    trackNumber: 4,
    available: true,
    authority: {
      state: "resolver-capable" as const,
      selectionId: "drill-track-selection-1",
    },
    ...over,
  };
}

function performerDrill(): MostPlayedPerformerDrillResponse {
  return {
    snapshotPulledAt: "2026-07-26T12:00:00.000Z",
    name: "Lio-Marcus Mendel",
    releases: [
      {
        title: "In the Hollows",
        artist: "Various Artists",
        version: "Orlando Ballet Chorus",
        albumLocalId: "20000000-0000-4000-8000-000000000001",
        imageKeyHint: "abc123",
        tracks: [
          drillTrack({ trackNumber: 1, title: "In the Hollows" }),
          drillTrack({
            trackNumber: 4,
            title: "Breathe",
            authority: {
              state: "resolver-capable",
              selectionId: "drill-track-selection-2",
            },
          }),
        ],
      },
    ],
  };
}

function releaseDrill(): MostPlayedReleaseDrillResponse {
  const group = performerDrill().releases[0];
  return {
    snapshotPulledAt: "2026-07-26T12:00:00.000Z",
    title: group.title,
    artist: group.artist,
    version: group.version,
    albumLocalId: group.albumLocalId,
    imageKeyHint: group.imageKeyHint,
    tracks: group.tracks,
  };
}

describe("Most Played drill contracts", () => {
  it("round-trips strict performer and release drill responses", () => {
    expect(
      normalizeMostPlayedPerformerDrillResponse(wireCopy(performerDrill()))
    ).toEqual(performerDrill());
    expect(
      normalizeMostPlayedReleaseDrillResponse(wireCopy(releaseDrill()))
    ).toEqual(releaseDrill());
  });

  it.each<[string, (value: any) => void]>([
    [
      "a raw performer ID",
      (value) => {
        value.performerId = "777";
      },
    ],
    [
      "a raw album ID",
      (value) => {
        value.releases[0].albumId = "4242";
      },
    ],
    [
      "a raw track ID",
      (value) => {
        value.releases[0].tracks[0].trackId = "7001";
      },
    ],
    [
      "out-of-order native track numbers",
      (value) => {
        value.releases[0].tracks.reverse();
      },
    ],
    [
      "an availability/authority contradiction",
      (value) => {
        value.releases[0].tracks[0].available = false;
      },
    ],
    [
      "an extra nested field",
      (value) => {
        value.releases[0].tracks[0].profileSooid = "11";
      },
    ],
    [
      "a duplicated drill-track authority",
      (value) => {
        value.releases[0].tracks[1].authority =
          value.releases[0].tracks[0].authority;
      },
    ],
  ])("rejects performer drill %s", (_name, mutate) => {
    const damaged = wireCopy(performerDrill());
    mutate(damaged);
    expect(normalizeMostPlayedPerformerDrillResponse(damaged)).toBeNull();
  });

  it("rejects raw identity and extra fields in a release drill", () => {
    const damaged = wireCopy(releaseDrill());
    damaged.extendedAlbumId = "4242";
    expect(normalizeMostPlayedReleaseDrillResponse(damaged)).toBeNull();
  });
});
