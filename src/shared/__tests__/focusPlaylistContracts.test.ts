import {
  DEFAULT_TRACK_FOCUS_ORDERING,
  type SmartPlaylistEditorState,
} from "../smartPlaylistFocusContracts";
import {
  FOCUS_PLAYLIST_UNEDITABLE_REASON_CODES,
  normalizeFocusPlaylistAdoptionHttpRequest,
  normalizeFocusPlaylistAdoptionResponse,
  normalizeFocusPlaylistBootstrapResponse,
  normalizeFocusPlaylistCloseResponse,
  normalizeFocusPlaylistCreateBootstrapRequest,
  normalizeFocusPlaylistCreateRequest,
  normalizeFocusPlaylistEditBootstrapRequest,
  normalizeFocusPlaylistManageSmartInfo,
  normalizeFocusPlaylistPickerHttpRequest,
  normalizeFocusPlaylistPickerResponse,
  normalizeFocusPlaylistStateRequest,
  normalizeFocusPlaylistUpdateRequest,
} from "../focusPlaylistContracts";

const STATUS = {
  coreId: "core-a",
  freshness: "fresh" as const,
  persistence: "healthy" as const,
  refresh: "idle" as const,
  available: true,
  complete: true,
  revision: 1,
  artistCount: 1,
  albumCount: 1,
  updatedAt: "2026-07-28T12:00:00.000Z",
  lastCompleteScanAt: "2026-07-28T12:00:00.000Z",
};
const EDITOR_ID = "e".repeat(32);
const BASELINE = "b".repeat(32);
const CANDIDATE_ID = "c".repeat(32);
const SELECTION_ID = "s".repeat(32);

function state(edit = false): SmartPlaylistEditorState {
  return {
    editorId: EDITOR_ID,
    generation: 3,
    ...(edit ? { baselineRevision: BASELINE } : {}),
    document: {
      version: 1,
      scope: "tracks",
      criteria: [],
      ordering: { ...DEFAULT_TRACK_FOCUS_ORDERING },
    },
  };
}

describe("Focus playlist HTTP contracts", () => {
  test("normalizes strict manage capability and refusal shapes", () => {
    const capabilities = {
      tracks: { fullEditor: true, filteredCount: true },
      albums: {
        fullEditor: false,
        filteredCount: false,
        unavailableReason: "Album Focus unavailable",
      },
    };
    expect(
      normalizeFocusPlaylistManageSmartInfo({
        scope: "tracks",
        summary: "Tracks: matches all",
        editable: true,
        capabilities,
      })
    ).not.toBeNull();
    for (const uneditableReasonCode of FOCUS_PLAYLIST_UNEDITABLE_REASON_CODES) {
      expect(
        normalizeFocusPlaylistManageSmartInfo({
          scope: "tracks",
          summary: "Rules unavailable",
          editable: false,
          uneditableReasonCode,
          capabilities,
        })
      ).not.toBeNull();
    }
    expect(
      normalizeFocusPlaylistManageSmartInfo({
        scope: "tracks",
        summary: "Tracks",
        editable: true,
        uneditableReasonCode: "criteria-unreadable",
        capabilities,
      })
    ).toBeNull();
    expect(
      normalizeFocusPlaylistManageSmartInfo({
        scope: "albums",
        summary: "Albums",
        editable: true,
        capabilities,
      })
    ).toBeNull();
  });

  test("binds create/edit/state/save requests to strict editor envelopes", () => {
    expect(
      normalizeFocusPlaylistCreateBootstrapRequest({
        scope: "tracks",
        confirmedTakeover: true,
      })
    ).toEqual({ scope: "tracks", confirmedTakeover: true });
    expect(normalizeFocusPlaylistEditBootstrapRequest({})).toEqual({});
    expect(
      normalizeFocusPlaylistCreateBootstrapRequest({
        scope: "tracks",
        extra: true,
      })
    ).toBeNull();
    expect(normalizeFocusPlaylistStateRequest({ state: state() })).not.toBeNull();
    expect(
      normalizeFocusPlaylistCreateRequest({
        name: "Track Focus",
        state: state(),
      })
    ).not.toBeNull();
    expect(
      normalizeFocusPlaylistCreateRequest({
        name: "Track Focus",
        state: state(true),
      })
    ).toBeNull();
    expect(
      normalizeFocusPlaylistUpdateRequest({ state: state(true) })
    ).not.toBeNull();
    expect(normalizeFocusPlaylistUpdateRequest({ state: state() })).toBeNull();
  });

  test("fences picker and adoption requests to the current generation, scope, and axis", () => {
    expect(
      normalizeFocusPlaylistPickerHttpRequest({
        state: state(),
        request: {
          generation: 3,
          axis: "track.performers",
          textFilter: "Miles",
        },
      })
    ).not.toBeNull();
    expect(
      normalizeFocusPlaylistPickerHttpRequest({
        state: state(),
        request: {
          generation: 2,
          axis: "track.performers",
          textFilter: "Miles",
        },
      })
    ).toBeNull();
    expect(
      normalizeFocusPlaylistPickerHttpRequest({
        state: state(),
        request: {
          generation: 3,
          axis: "album.performers",
          textFilter: "Miles",
        },
      })
    ).toBeNull();
    expect(
      normalizeFocusPlaylistAdoptionHttpRequest({
        state: state(),
        request: {
          generation: 3,
          axis: "track.performers",
          candidates: [
            {
              candidateId: CANDIDATE_ID,
              displayLabel: "Miles Davis",
            },
          ],
        },
      })
    ).not.toBeNull();
    expect(
      normalizeFocusPlaylistAdoptionHttpRequest({
        state: state(),
        request: {
          generation: 3,
          axis: "track.performers",
          candidates: [
            {
              candidateId: CANDIDATE_ID,
              displayLabel: "Miles Davis",
            },
            {
              candidateId: CANDIDATE_ID,
              displayLabel: "Substituted",
            },
          ],
        },
      })
    ).toBeNull();
  });

  test("normalizes bootstrap, picker, adoption, and close responses exactly", () => {
    expect(
      normalizeFocusPlaylistBootstrapResponse({
        status: STATUS,
        state: state(),
        previewCount: 481,
        selections: [],
      })
    ).not.toBeNull();
    expect(
      normalizeFocusPlaylistBootstrapResponse({
        status: STATUS,
        state: state(),
        previewCount: 481,
        selections: [],
        nativeId: "must-not-cross-http",
      })
    ).toBeNull();
    expect(
      normalizeFocusPlaylistPickerResponse({
        status: STATUS,
        generation: 3,
        axis: "track.performers",
        textFilter: "Miles",
        candidates: [
          {
            candidateId: CANDIDATE_ID,
            displayLabel: "Miles Davis",
          },
        ],
        totalCount: 1,
        truncated: false,
      })
    ).not.toBeNull();
    expect(
      normalizeFocusPlaylistAdoptionResponse({
        status: STATUS,
        selections: [
          {
            selectionId: SELECTION_ID,
            displayLabel: "Miles Davis",
          },
        ],
      })
    ).not.toBeNull();
    expect(
      normalizeFocusPlaylistCloseResponse({
        status: STATUS,
        closed: true,
      })
    ).not.toBeNull();
    expect(
      normalizeFocusPlaylistCloseResponse({
        status: STATUS,
        closed: false,
      })
    ).toBeNull();
  });
});
