import {
  normalizePlaylistManageResponse,
} from "../playlistMutationContracts";
import {
  FOCUS_PLAYLIST_UNEDITABLE_REASON_CODES,
} from "../focusPlaylistContracts";

const STATUS = {
  coreId: "core-a",
  freshness: "fresh",
  persistence: "healthy",
  refresh: "idle",
  available: true,
  complete: true,
  revision: 1,
  artistCount: 1,
  albumCount: 1,
  updatedAt: "2026-07-27T12:00:00.000Z",
  lastCompleteScanAt: "2026-07-27T12:00:00.000Z",
} as const;

function uneditableManage(smart: unknown): unknown {
  return {
    status: STATUS,
    playlistId: "aa".repeat(20),
    kind: "smart",
    name: "Smart playlist",
    description: null,
    actions: {
      editCriteria: true,
      rename: false,
      setDescription: false,
      manageItems: false,
    },
    smart,
  };
}

describe("playlist manage smart refusal reasons", () => {
  const capabilities = {
    tracks: { fullEditor: true, filteredCount: true },
    albums: { fullEditor: true, filteredCount: true },
  } as const;

  it.each(FOCUS_PLAYLIST_UNEDITABLE_REASON_CODES)(
    "accepts the stable %s code",
    (uneditableReasonCode) => {
      expect(
        normalizePlaylistManageResponse(
          uneditableManage({
            scope: "tracks",
            summary: "Tracks: Played in the last N days",
            editable: false,
            uneditableReasonCode,
            capabilities,
          })
        )
      ).not.toBeNull();
    }
  );

  it("rejects server prose, unknown codes, and mixed editable/refusal states", () => {
    expect(
      normalizePlaylistManageResponse(
        uneditableManage({
          scope: "tracks",
          summary: "Tracks: one rule",
          editable: false,
          uneditableReason:
            "the stored criteria carry more than the supported rule",
          capabilities,
        })
      )
    ).toBeNull();
    expect(
      normalizePlaylistManageResponse(
        uneditableManage({
          scope: "tracks",
          summary: "Tracks: one rule",
          editable: false,
          uneditableReasonCode: "future-server-reason",
          capabilities,
        })
      )
    ).toBeNull();
    expect(
      normalizePlaylistManageResponse(
        uneditableManage({
          scope: "tracks",
          summary: "Tracks: one rule",
          editable: true,
          uneditableReasonCode: "criteria-unreadable",
          capabilities,
        })
      )
    ).toBeNull();
    const staleDeleteAction = uneditableManage({
      scope: "tracks",
      summary: "Tracks: one rule",
      editable: false,
      uneditableReasonCode: "criteria-unreadable",
      capabilities,
    }) as { actions: Record<string, unknown> };
    staleDeleteAction.actions.delete = true;
    expect(normalizePlaylistManageResponse(staleDeleteAction)).toBeNull();
  });
});
