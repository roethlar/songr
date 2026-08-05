import {
  normalizePublicSongActionAck,
  normalizePublicSongActionRequest,
  normalizePublicSongResolveAck,
  normalizePublicSongResolveRequest,
  normalizePublicSongRowAuthority,
  PUBLIC_SONG_UNAVAILABLE_MESSAGES,
  PublicSongActionRequest,
  PublicSongResolveRequest,
} from "../publicSongResolverContracts";

function resolveRequest(): PublicSongResolveRequest {
  return {
    requestId: "request-1",
    tabId: "tab-1",
    session: { handleId: "mode-1", generation: 2 },
    selectionId: "selection-1",
  };
}

function actionRequest(): PublicSongActionRequest {
  return {
    ...resolveRequest(),
    candidateId: "candidate-1",
    zoneId: "zone-1",
    semantic: "play-now",
  };
}

const candidate = {
  candidateId: "candidate-1",
  title: "Seven Nation Army",
  subtitle: "The White Stripes, Jack White",
  imageKey: null,
};

describe("public song row authority", () => {
  it("accepts the three explicit authority states", () => {
    expect(
      normalizePublicSongRowAuthority({
        state: "unavailable",
        reason: {
          code: "no-exact-match",
          message: PUBLIC_SONG_UNAVAILABLE_MESSAGES["no-exact-match"],
        },
      })
    ).not.toBeNull();
    expect(
      normalizePublicSongRowAuthority({
        state: "resolver-capable",
        selectionId: "selection-1",
      })
    ).not.toBeNull();
    expect(
      normalizePublicSongRowAuthority({
        state: "public-authorized",
        selectionId: "selection-1",
        candidate,
      })
    ).not.toBeNull();
  });

  it("rejects contradictory fields and rewritten honest reasons", () => {
    expect(
      normalizePublicSongRowAuthority({
        state: "resolver-capable",
        selectionId: "selection-1",
        reason: {
          code: "selection-expired",
          message: PUBLIC_SONG_UNAVAILABLE_MESSAGES["selection-expired"],
        },
      })
    ).toBeNull();
    expect(
      normalizePublicSongRowAuthority({
        state: "unavailable",
        reason: {
          code: "search-incomplete",
          message: "try again",
        },
      })
    ).toBeNull();
  });
});

describe("public song resolver wire contracts", () => {
  it("round-trips strict resolve requests and authorized/choice outcomes", () => {
    const request = resolveRequest();
    expect(normalizePublicSongResolveRequest(request)).toEqual(request);
    expect(
      normalizePublicSongResolveAck(
        {
          success: true,
          data: {
            requestId: request.requestId,
            session: request.session,
            selectionId: request.selectionId,
            resolution: { kind: "authorized", candidate },
          },
        },
        request
      )
    ).not.toBeNull();
    expect(
      normalizePublicSongResolveAck(
        {
          success: true,
          data: {
            requestId: request.requestId,
            session: request.session,
            selectionId: request.selectionId,
            resolution: {
              kind: "choice-required",
              candidates: [
                candidate,
                { ...candidate, candidateId: "candidate-2" },
              ],
            },
          },
        },
        request
      )
    ).not.toBeNull();
  });

  it("rejects stale correlation, duplicate candidates, and one-item choosers", () => {
    const request = resolveRequest();
    const ack = {
      success: true,
      data: {
        requestId: "older-request",
        session: request.session,
        selectionId: request.selectionId,
        resolution: { kind: "authorized", candidate },
      },
    };
    expect(normalizePublicSongResolveAck(ack, request)).toBeNull();
    ack.data.requestId = request.requestId;
    ack.data.resolution = {
      kind: "choice-required",
      candidates: [candidate, candidate],
    } as never;
    expect(normalizePublicSongResolveAck(ack, request)).toBeNull();
    ack.data.resolution = {
      kind: "choice-required",
      candidates: [candidate],
    } as never;
    expect(normalizePublicSongResolveAck(ack, request)).toBeNull();
  });

  it("accepts bounded error acknowledgements and rejects unknown codes", () => {
    const request = resolveRequest();
    expect(
      normalizePublicSongResolveAck(
        {
          success: false,
          error: "stale",
          code: "STALE_SELECTION",
        },
        request
      )
    ).not.toBeNull();
    expect(
      normalizePublicSongResolveAck(
        { success: false, error: "bad", code: "DELETE_EVERYTHING" },
        request
      )
    ).toBeNull();
  });
});

describe("public song action wire contracts", () => {
  it("round-trips a strict request and executed acknowledgement", () => {
    const request = actionRequest();
    expect(normalizePublicSongActionRequest(request)).toEqual(request);
    expect(
      normalizePublicSongActionAck(
        {
          success: true,
          data: {
            requestId: request.requestId,
            session: request.session,
            selectionId: request.selectionId,
            candidateId: request.candidateId,
            semantic: request.semantic,
            outcome: "executed",
            authorityRetired: true,
          },
        },
        request
      )
    ).not.toBeNull();
  });

  it("rejects extra request fields, mismatched candidates, and non-retired success", () => {
    const request = actionRequest();
    expect(
      normalizePublicSongActionRequest({ ...request, rawItemKey: "secret" })
    ).toBeNull();
    const success = {
      success: true,
      data: {
        requestId: request.requestId,
        session: request.session,
        selectionId: request.selectionId,
        candidateId: "candidate-2",
        semantic: request.semantic,
        outcome: "executed",
        authorityRetired: true,
      },
    };
    expect(normalizePublicSongActionAck(success, request)).toBeNull();
    success.data.candidateId = request.candidateId;
    success.data.authorityRetired = false;
    expect(normalizePublicSongActionAck(success, request)).toBeNull();
  });
});
