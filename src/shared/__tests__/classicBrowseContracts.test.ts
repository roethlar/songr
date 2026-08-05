import {
	CLASSIC_SEARCH_ACK_TIMEOUT_MS,
	CLASSIC_SEARCH_COORDINATED_CALL_CEILING_MS,
	CLASSIC_SEARCH_EXPANSION_DEADLINE_MS,
  normalizeClassicBrowseCommandAck,
  normalizeClassicBrowseCommandRequest,
  normalizeClassicSessionAcquireAck,
  normalizeClassicSessionAcquireRequest,
  normalizeClassicSessionReleaseRequest,
  type ClassicBrowseCommandRequest,
} from "../classicBrowseContracts";

const session = { handleId: "classic-handle-1", generation: 7 };

describe("classic browse wire contracts", () => {
  it("keeps the grouped-search acknowledgment beyond its worst-case mutation window", () => {
    const latestServerSettlement =
      CLASSIC_SEARCH_EXPANSION_DEADLINE_MS +
      2 * CLASSIC_SEARCH_COORDINATED_CALL_CEILING_MS;
    expect(CLASSIC_SEARCH_ACK_TIMEOUT_MS).toBeGreaterThan(latestServerSettlement);
  });

  it("accepts opaque acquire/release correlation and rejects extra authority", () => {
    const acquire = { requestId: "request-1", tabId: "tab-1" };
    expect(normalizeClassicSessionAcquireRequest(acquire)).toEqual(acquire);
    expect(normalizeClassicSessionAcquireRequest({ ...acquire, multiSessionKey: "raw" })).toBeNull();
    expect(
      normalizeClassicSessionReleaseRequest({ ...acquire, session })
    ).toEqual({ ...acquire, session });
    expect(
      normalizeClassicSessionReleaseRequest({ ...acquire, session, itemKey: "authority" })
    ).toBeNull();
  });

  it("keeps session roles semantic and forbids raw session keys in command options", () => {
    const request: ClassicBrowseCommandRequest = {
      requestId: "request-2",
      tabId: "tab-1",
      session,
      role: "classic-search",
      operation: "browse",
      options: { hierarchy: "search", input: "beatles", popAll: true },
    };
    expect(normalizeClassicBrowseCommandRequest(request)).toEqual(request);
    expect(
      normalizeClassicBrowseCommandRequest({
        ...request,
        options: { ...request.options, multiSessionKey: "client-chosen" },
      })
    ).toBeNull();
	 expect(
	   normalizeClassicBrowseCommandRequest({
		 ...request,
		 role: "classic-browse",
		 options: { hierarchy: "invented-hierarchy" },
	   })
	 ).toBeNull();
    expect(
      normalizeClassicBrowseCommandRequest({ ...request, role: "classic-explore" })
    ).toBeNull();
  });

  it("binds successful acknowledgments to request and generation", () => {
    const acquire = { requestId: "request-3", tabId: "tab-1" };
    expect(
      normalizeClassicSessionAcquireAck(
        { success: true, data: { requestId: acquire.requestId, session } },
        acquire
      )
    ).toEqual({ success: true, data: { requestId: acquire.requestId, session } });
    expect(
      normalizeClassicSessionAcquireAck(
        { success: true, data: { requestId: "late", session } },
        acquire
      )
    ).toBeNull();

    const command = normalizeClassicBrowseCommandRequest({
      ...acquire,
      session,
      role: "classic-browse",
      operation: "browse",
      options: { hierarchy: "browse", popAll: true },
    });
    if (!command) throw new Error("expected command");
    expect(
      normalizeClassicBrowseCommandAck(
        {
          success: true,
          data: {
            requestId: acquire.requestId,
            session,
            result: { level: 0, offset: 0, count: 0, items: [] },
          },
        },
        command
      )
    ).not.toBeNull();
    expect(
      normalizeClassicBrowseCommandAck(
        {
          success: true,
          data: {
            requestId: acquire.requestId,
            session: { ...session, generation: session.generation + 1 },
            result: { level: 0 },
          },
        },
        command
      )
    ).toBeNull();
  });

  it("rejects malformed, oversized, and key-bearing search acknowledgments", () => {
    const command = normalizeClassicBrowseCommandRequest({
      requestId: "request-search",
      tabId: "tab-1",
      session,
      role: "classic-search",
      operation: "search",
      options: { input: "beatles", popAll: true },
    });
    if (!command) throw new Error("expected search command");
    const result = {
      title: "Abbey Road",
      resultType: "album",
      isLoadable: false,
      isPlayable: true,
    };
    const ack = (results: unknown) => ({
      success: true,
      data: { requestId: command.requestId, session, result: results },
    });

    expect(normalizeClassicBrowseCommandAck(ack([result]), command)).not.toBeNull();
    expect(
      normalizeClassicBrowseCommandAck(ack([{ ...result, itemKey: "raw-or-token" }]), command)
    ).toBeNull();
    expect(
      normalizeClassicBrowseCommandAck(
        ack(Array.from({ length: 501 }, (_value, index) => ({ ...result, title: `Album ${index}` }))),
        command
      )
    ).toBeNull();
  });

  it("rejects a BrowseResult acknowledgment without its required paging fields", () => {
    const command = normalizeClassicBrowseCommandRequest({
      requestId: "request-browse",
      tabId: "tab-1",
      session,
      role: "classic-browse",
      operation: "browse",
      options: { hierarchy: "browse", popAll: true },
    });
    if (!command) throw new Error("expected browse command");

    expect(
      normalizeClassicBrowseCommandAck(
        {
          success: true,
          data: {
            requestId: command.requestId,
            session,
            result: { level: 0, count: 0, items: [] },
          },
        },
        command
      )
    ).toBeNull();
  });
});
