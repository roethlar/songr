import {
  normalizeUnifiedSearchClearAck,
  normalizeUnifiedSearchClearRequest,
  normalizeUnifiedSongActionAck,
  normalizeUnifiedSongActionRequest,
  normalizeUnifiedSongSearchAck,
  normalizeUnifiedSongSearchRequest,
} from "../unifiedSearchContracts";

describe("unified search contracts", () => {
  const request = {
    requestId: "request-1",
    tabId: "tab-1",
    session: { handleId: "handle-1", generation: 3 },
    query: "hamilton",
  };

  it("canonicalizes a bounded non-empty query", () => {
    expect(
      normalizeUnifiedSongSearchRequest({
        ...request,
        query: "  hamilton  ",
      })
    ).toEqual(request);
  });

  it("accepts an exact correlated result with opaque authority", () => {
    const normalizedRequest = normalizeUnifiedSongSearchRequest(request)!;
    expect(
      normalizeUnifiedSongSearchAck(
        {
          success: true,
          data: {
            requestId: "request-1",
            session: { handleId: "handle-1", generation: 3 },
            query: "hamilton",
            results: [
              {
                resultId: "song-result-1",
                title: "Dear Theodosia",
                subtitle: "Orlando Ballet Chorus",
                imageKey: null,
              },
            ],
          },
        },
        normalizedRequest
      )
    ).toEqual(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          results: [
            expect.objectContaining({ resultId: "song-result-1" }),
          ],
        }),
      })
    );
  });

  it("rejects raw item keys and duplicate opaque ids", () => {
    const normalizedRequest = normalizeUnifiedSongSearchRequest(request)!;
    const result = {
      resultId: "song-result-1",
      title: "Dear Theodosia",
      subtitle: "Orlando Ballet Chorus",
      imageKey: null,
    };
    expect(
      normalizeUnifiedSongSearchAck(
        {
          success: true,
          data: {
            requestId: "request-1",
            session: request.session,
            query: "hamilton",
            results: [{ ...result, itemKey: "raw-roon-key" }],
          },
        },
        normalizedRequest
      )
    ).toBeNull();
    expect(
      normalizeUnifiedSongSearchAck(
        {
          success: true,
          data: {
            requestId: "request-1",
            session: request.session,
            query: "hamilton",
            results: [result, result],
          },
        },
        normalizedRequest
      )
    ).toBeNull();
  });

  it("accepts only an exact correlated semantic song action", () => {
    const action = normalizeUnifiedSongActionRequest({
      requestId: "action-request-1",
      tabId: "tab-1",
      session: request.session,
      resultId: "song-result-1",
      zoneId: "zone-1",
      semantic: "add-next",
    })!;

    expect(
      normalizeUnifiedSongActionAck(
        {
          success: true,
          data: {
            requestId: "action-request-1",
            session: request.session,
            resultId: "song-result-1",
            semantic: "add-next",
            outcome: "executed",
            authorityRetired: false,
          },
        },
        action
      )
    ).toEqual(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          semantic: "add-next",
          outcome: "executed",
        }),
      })
    );
    expect(
      normalizeUnifiedSongActionAck(
        {
          success: true,
          data: {
            requestId: "action-request-1",
            session: request.session,
            resultId: "different-result",
            semantic: "add-next",
            outcome: "executed",
            authorityRetired: false,
          },
        },
        action
      )
    ).toBeNull();
  });

  it("preserves a public Roon refusal through song action normalization", () => {
    const action = normalizeUnifiedSongActionRequest({
      requestId: "action-request-1",
      tabId: "tab-1",
      session: request.session,
      resultId: "song-result-1",
      zoneId: "zone-1",
      semantic: "play-now",
    })!;
    const refusal = {
      success: false,
      code: "ROON_REJECTED",
      error: "This track is unavailable",
    };
    expect(normalizeUnifiedSongActionAck(refusal, action)).toEqual(refusal);
  });

  it("rejects invented song semantics and extra action authority", () => {
    expect(
      normalizeUnifiedSongActionRequest({
        requestId: "action-request-1",
        tabId: "tab-1",
        session: request.session,
        resultId: "song-result-1",
        zoneId: "zone-1",
        semantic: "play-something",
      })
    ).toBeNull();
    expect(
      normalizeUnifiedSongActionRequest({
        requestId: "action-request-1",
        tabId: "tab-1",
        session: request.session,
        resultId: "song-result-1",
        zoneId: "zone-1",
        semantic: "queue",
        itemKey: "raw-roon-key",
      })
    ).toBeNull();
  });

  it("normalizes an exact correlated search-authority clear", () => {
    const clear = normalizeUnifiedSearchClearRequest({
      requestId: "clear-request-1",
      tabId: "tab-1",
      session: request.session,
    })!;

    expect(
      normalizeUnifiedSearchClearAck(
        {
          success: true,
          data: {
            requestId: "clear-request-1",
            session: request.session,
          },
        },
        clear
      )
    ).toEqual({
      success: true,
      data: {
        requestId: "clear-request-1",
        session: request.session,
      },
    });
  });
});
