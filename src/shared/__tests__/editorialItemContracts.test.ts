/**
 * Contract strictness for the editorial item protocol (rich-item plan
 * §5.3/§5.4): exact keys, bounded text, unknown enums, duplicate follow
 * targets, oversized prose/lists, URL scheme allowlist, and correlation
 * echo pinning. Synthetic values only.
 */
import {
  EDITORIAL_MAX_CREDITS,
  EDITORIAL_MAX_RELATIONSHIP_ROWS,
  EDITORIAL_TEXT_MAX_LENGTH,
  normalizeEditorialItemCancelRequest,
  normalizeEditorialItemFailedEvent,
  normalizeEditorialItemFollowRequest,
  normalizeEditorialItemOpenAck,
  normalizeEditorialItemOpenRequest,
  normalizeEditorialItemReadyEvent,
  normalizeEditorialItemView,
} from "../editorialItemContracts";

const REQUEST_ID = "req-1";
const SESSION_ID = "ses-1";

function view(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "album",
    title: "Album Title",
    sections: {
      review: {
        text: "A review.\nWith a second line.",
        source: "Provider",
        language: "en",
      },
    },
    ...overrides,
  };
}

describe("editorial requests", () => {
  it("normalizes exact-shaped open/follow/cancel requests", () => {
    expect(
      normalizeEditorialItemOpenRequest({
        requestId: REQUEST_ID,
        tabId: "tab-1",
        generation: 3,
        anchor: { kind: "album", albumLocalId: "alb-1" },
      })
    ).toEqual({
      requestId: REQUEST_ID,
      tabId: "tab-1",
      generation: 3,
      anchor: { kind: "album", albumLocalId: "alb-1" },
    });
    expect(
      normalizeEditorialItemFollowRequest({
        requestId: REQUEST_ID,
        tabId: "tab-1",
        generation: 3,
        sessionId: SESSION_ID,
        target: "tgt-1",
      })
    ).not.toBeNull();
    expect(
      normalizeEditorialItemCancelRequest({ sessionId: SESSION_ID, tabId: "tab-1" })
    ).not.toBeNull();
  });

  it("normalizes the exact-track anchor and rejects inexact indexes", () => {
    const open = (anchor: unknown) =>
      normalizeEditorialItemOpenRequest({
        requestId: REQUEST_ID,
        tabId: "tab-1",
        generation: 3,
        anchor,
      });
    expect(
      open({ kind: "track", albumLocalId: "alb-1", trackIndex: 0 })?.anchor
    ).toEqual({ kind: "track", albumLocalId: "alb-1", trackIndex: 0 });
    // The index is a bounded zero-based integer — nothing fuzzy passes.
    expect(open({ kind: "track", albumLocalId: "alb-1", trackIndex: -1 })).toBeNull();
    expect(open({ kind: "track", albumLocalId: "alb-1", trackIndex: 1.5 })).toBeNull();
    expect(open({ kind: "track", albumLocalId: "alb-1", trackIndex: 500 })).toBeNull();
    expect(open({ kind: "track", albumLocalId: "alb-1" })).toBeNull();
    expect(
      open({ kind: "track", albumLocalId: "alb-1", trackIndex: 0, itemKey: "x" })
    ).toBeNull();
  });

  it("rejects extra keys, unknown anchors, and hostile records", () => {
    expect(
      normalizeEditorialItemOpenRequest({
        requestId: REQUEST_ID,
        tabId: "tab-1",
        generation: 3,
        anchor: { kind: "album", albumLocalId: "alb-1" },
        extra: 1,
      })
    ).toBeNull();
    expect(
      normalizeEditorialItemOpenRequest({
        requestId: REQUEST_ID,
        tabId: "tab-1",
        generation: 3,
        anchor: { kind: "genre", label: "Jazz" },
      })
    ).toBeNull();
    expect(
      normalizeEditorialItemOpenRequest({
        requestId: REQUEST_ID,
        tabId: "tab-1",
        generation: 3,
        anchor: { kind: "album", albumLocalId: "alb-1", itemKey: "forbidden" },
      })
    ).toBeNull();
    const hostile = Object.create({ polluted: true }) as Record<string, unknown>;
    hostile.sessionId = SESSION_ID;
    hostile.tabId = "tab-1";
    expect(normalizeEditorialItemCancelRequest(hostile)).toBeNull();
  });
});

describe("editorial acks", () => {
  it("pins the request id on success and bounds failure text", () => {
    expect(
      normalizeEditorialItemOpenAck(
        { ok: true, data: { requestId: REQUEST_ID, sessionId: SESSION_ID, deadlineAt: 100 } },
        REQUEST_ID
      )
    ).toEqual({
      ok: true,
      data: { requestId: REQUEST_ID, sessionId: SESSION_ID, deadlineAt: 100 },
    });
    expect(
      normalizeEditorialItemOpenAck(
        { ok: true, data: { requestId: "someone-else", sessionId: SESSION_ID, deadlineAt: 100 } },
        REQUEST_ID
      )
    ).toBeNull();
    expect(
      normalizeEditorialItemOpenAck(
        { ok: false, code: "FEATURE_UNAVAILABLE", error: "Not in this build." },
        REQUEST_ID
      )
    ).toMatchObject({ ok: false, code: "FEATURE_UNAVAILABLE" });
    expect(
      normalizeEditorialItemOpenAck(
        { ok: false, code: "NOT_A_CODE", error: "nope" },
        REQUEST_ID
      )
    ).toBeNull();
  });
});

describe("the browser-safe editorial view (§5.4)", () => {
  it("normalizes optional sections and keeps absent fields absent", () => {
    const normalized = normalizeEditorialItemView(view());
    expect(normalized).not.toBeNull();
    expect(normalized?.sections.review?.source).toBe("Provider");
    expect("creditGroups" in (normalized ?? {})).toBe(false);
  });

  it("rejects unknown kinds, unknown sections, and extra keys", () => {
    expect(normalizeEditorialItemView(view({ kind: "playlist" }))).toBeNull();
    expect(
      normalizeEditorialItemView(
        view({ sections: { lyrics: { text: "x", source: "s", language: "en" } } })
      )
    ).toBeNull();
    expect(normalizeEditorialItemView(view({ surprise: true }))).toBeNull();
  });

  it("enforces the prose bound", () => {
    expect(
      normalizeEditorialItemView(
        view({
          sections: {
            review: {
              text: "x".repeat(EDITORIAL_TEXT_MAX_LENGTH + 1),
              source: "Provider",
              language: "en",
            },
          },
        })
      )
    ).toBeNull();
  });

  it("enforces the credit and relationship row bounds", () => {
    const credits = Array.from({ length: EDITORIAL_MAX_CREDITS + 1 }, (_v, i) => ({
      role: "Performer",
      name: `Name ${i}`,
    }));
    expect(
      normalizeEditorialItemView(
        view({ creditGroups: [{ label: "By role", credits }] })
      )
    ).toBeNull();
    const items = Array.from(
      { length: EDITORIAL_MAX_RELATIONSHIP_ROWS + 1 },
      (_v, i) => ({ title: `Row ${i}` })
    );
    expect(
      normalizeEditorialItemView(
        view({ relationshipGroups: [{ label: "Similar", items }] })
      )
    ).toBeNull();
  });

  it("rejects duplicate follow targets across groups", () => {
    expect(
      normalizeEditorialItemView(
        view({
          creditGroups: [
            {
              label: "By role",
              credits: [{ role: "Performer", name: "A", followTarget: "tgt-1" }],
            },
          ],
          relationshipGroups: [
            { label: "Similar", items: [{ title: "B", followTarget: "tgt-1" }] },
          ],
        })
      )
    ).toBeNull();
  });

  it("allows only http(s) attribution and source URLs", () => {
    expect(
      normalizeEditorialItemView(
        view({ attribution: [{ text: "Provider", url: "https://example.invalid/a" }] })
      )
    ).not.toBeNull();
    expect(
      normalizeEditorialItemView(
        view({ attribution: [{ text: "Provider", url: "javascript:alert(1)" }] })
      )
    ).toBeNull();
    expect(
      normalizeEditorialItemView(
        view({
          sections: {
            review: {
              text: "ok",
              source: "Provider",
              language: "en",
              sourceUrl: "file:///etc/passwd",
            },
          },
        })
      )
    ).toBeNull();
  });

  it("requires every external link row to carry a valid http(s) url", () => {
    const normalized = normalizeEditorialItemView(
      view({ links: [{ text: "en.wikipedia.org", url: "https://en.wikipedia.org/a" }] })
    );
    expect(normalized?.links).toEqual([
      { text: "en.wikipedia.org", url: "https://en.wikipedia.org/a" },
    ]);
    // A link without a destination is not a link (stricter than
    // attribution, where the url is optional).
    expect(
      normalizeEditorialItemView(view({ links: [{ text: "provider" }] }))
    ).toBeNull();
    expect(
      normalizeEditorialItemView(
        view({ links: [{ text: "provider", url: "javascript:alert(1)" }] })
      )
    ).toBeNull();
  });
});

describe("editorial events", () => {
  const expected = { requestId: REQUEST_ID, sessionId: SESSION_ID };

  it("accepts only the exact expected correlation", () => {
    expect(
      normalizeEditorialItemReadyEvent(
        { requestId: REQUEST_ID, sessionId: SESSION_ID, view: view() },
        expected
      )
    ).not.toBeNull();
    expect(
      normalizeEditorialItemReadyEvent(
        { requestId: REQUEST_ID, sessionId: "foreign", view: view() },
        expected
      )
    ).toBeNull();
    expect(
      normalizeEditorialItemFailedEvent(
        {
          requestId: "foreign",
          sessionId: SESSION_ID,
          code: "READ_TIMEOUT",
          section: null,
          retryable: true,
          error: "Timed out.",
        },
        expected
      )
    ).toBeNull();
  });

  it("bounds failure events to known codes and sections", () => {
    expect(
      normalizeEditorialItemFailedEvent(
        {
          requestId: REQUEST_ID,
          sessionId: SESSION_ID,
          code: "SECTION_UNSUPPORTED",
          section: "biography",
          retryable: false,
          error: "Unsupported.",
        },
        expected
      )
    ).toMatchObject({ code: "SECTION_UNSUPPORTED", section: "biography" });
    expect(
      normalizeEditorialItemFailedEvent(
        {
          requestId: REQUEST_ID,
          sessionId: SESSION_ID,
          code: "SECTION_UNSUPPORTED",
          section: "lyrics",
          retryable: false,
          error: "Unsupported.",
        },
        expected
      )
    ).toBeNull();
  });
});
