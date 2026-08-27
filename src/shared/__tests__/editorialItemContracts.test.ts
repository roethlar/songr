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
  EDITORIAL_WIDE_ARTWORK_KEY_MAX_LENGTH,
  EDITORIAL_WIDE_ARTWORK_REFERENCE_PREFIX,
  normalizeEditorialItemCancelRequest,
  normalizeEditorialItemFailedEvent,
  normalizeEditorialItemFollowRequest,
  normalizeEditorialItemOpenAck,
  normalizeEditorialItemOpenRequest,
  normalizeEditorialItemReadyEvent,
  normalizeEditorialItemView,
  salvageEditorialItemView,
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

  it("round-trips legal opaque image keys and rejects invalid ones (q2-2)", () => {
    // Roon image keys legally contain URL-significant characters; the
    // image pipeline encodes and serves them (imageUrl + /api/image).
    for (const key of ["abc/def?x=1", "img#a%25", "a/b?c#d%e"]) {
      const normalized = normalizeEditorialItemView(view({ artworkKey: key }));
      expect(normalized?.artworkKey).toBe(key);
      const withRow = normalizeEditorialItemView(
        view({
          relationshipGroups: [
            { label: "Similar", items: [{ title: "B", artworkKey: key }] },
          ],
        })
      );
      expect(withRow?.relationshipGroups?.[0].items[0].artworkKey).toBe(key);
      // The salvage path applies the same image-key rule.
      expect(salvageEditorialItemView(view({ artworkKey: key }))?.view.artworkKey).toBe(key);
    }
    // Empty, oversized (the /api/image route's 256-char cap), and
    // control-character keys reject; identifier fields keep the strict
    // id alphabet (a `/` in a follow target still fails closed).
    for (const key of ["", "k".repeat(257), "a\u0007b"]) {
      expect(normalizeEditorialItemView(view({ artworkKey: key }))).toBeNull();
      expect(
        normalizeEditorialItemView(
          view({
            relationshipGroups: [
              { label: "Similar", items: [{ title: "B", artworkKey: key }] },
            ],
          })
        )
      ).toBeNull();
    }
    expect(
      normalizeEditorialItemView(
        view({
          relationshipGroups: [
            { label: "Similar", items: [{ title: "B", followTarget: "a/b" }] },
          ],
        })
      )
    ).toBeNull();
  });

  it("holds the wide portrait reference to its own tagged domain", () => {
    const tag = EDITORIAL_WIDE_ARTWORK_REFERENCE_PREFIX;
    const wide = `${tag}wideportrait01`;
    const normalized = normalizeEditorialItemView(
      view({ kind: "artist", artworkKey: "abc/def?x=1", wideArtworkKey: wide })
    );
    expect(normalized?.wideArtworkKey).toBe(wide);
    expect(normalized?.artworkKey).toBe("abc/def?x=1");

    // Every one of these is a PERFECTLY LEGAL artwork key. None of them is
    // a wide portrait reference: the two fields are not interchangeable, so
    // a value that belongs in one is refused in the other's role.
    //
    // The BARE keys are the wh-3 cases. A key with no tag cannot have come
    // from the one producer that mints one, however plausible its shape —
    // and 32 lowercase hex characters is exactly the shape of a real
    // extension-API image key, which the untagged lower-case-alphanumeric
    // rule accepted, sent to a route that could only 404 it, and reported
    // as an artist with no photograph.
    for (const key of [
      "abc/def?x=1",
      "img#a%25",
      "a/b?c#d%e",
      "WIDEPORTRAIT",
      "wide portrait",
      "wide-portrait",
      "wide.portrait",
      "k".repeat(65),
      "",
      "ppcbaaaa",
      // An extension-API artwork key: 32 lowercase hex characters. Built at
      // runtime so no token-shaped literal sits in this public file; the
      // property under test is the shape, not any particular key.
      "0a1b2c3d".repeat(4),
      // The tag alone names no picture at all.
      tag,
      // Behind the tag, the bare key's own alphabet and cap still bite.
      `${tag}WIDEPORTRAIT`,
      `${tag}wide portrait`,
      `${tag}wide-portrait`,
      `${tag}wide.portrait`,
      `${tag}${"k".repeat(65)}`,
      // A tag that is not at the front is not a tag.
      `wide${tag}01`,
    ]) {
      expect(
        normalizeEditorialItemView(view({ kind: "artist", wideArtworkKey: key }))
      ).toBeNull();
      // Salvage costs the page its banner and nothing else — absence, not
      // an error, is what reaches a reader.
      const salvaged = salvageEditorialItemView(
        view({ kind: "artist", title: "Artist", wideArtworkKey: key })
      );
      expect(salvaged?.view.title).toBe("Artist");
      expect(salvaged?.view.wideArtworkKey).toBeUndefined();
    }
  });

  it("admits a reference whose bare key is exactly at the length cap", () => {
    // The cap is the tag plus the bare key's own 64 characters, and it is
    // derived from the tag rather than written down twice — so the boundary
    // is asserted against the exported bound, not against a literal that
    // could drift away from it.
    const atCap = `${EDITORIAL_WIDE_ARTWORK_REFERENCE_PREFIX}${"k".repeat(64)}`;
    expect(atCap).toHaveLength(EDITORIAL_WIDE_ARTWORK_KEY_MAX_LENGTH);
    expect(
      normalizeEditorialItemView(view({ kind: "artist", wideArtworkKey: atCap }))
    ).not.toBeNull();
    expect(
      normalizeEditorialItemView(
        view({
          kind: "artist",
          wideArtworkKey: `${EDITORIAL_WIDE_ARTWORK_REFERENCE_PREFIX}${"k".repeat(65)}`,
        })
      )
    ).toBeNull();
  });

  it("refuses one key standing in both artwork roles", () => {
    // Legal in BOTH domains on its own, so only the collision rejects it. A
    // tagged reference is still a legal ARTWORK key by its alphabet — the
    // tag is a claim about provenance, never a proof that a value is not
    // artwork — which is exactly why this collision rule is still needed.
    const shared = `${EDITORIAL_WIDE_ARTWORK_REFERENCE_PREFIX}abc123`;
    expect(
      normalizeEditorialItemView(view({ kind: "artist", artworkKey: shared }))
    ).not.toBeNull();
    expect(
      normalizeEditorialItemView(view({ kind: "artist", wideArtworkKey: shared }))
    ).not.toBeNull();
    expect(
      normalizeEditorialItemView(
        view({ kind: "artist", artworkKey: shared, wideArtworkKey: shared })
      )
    ).toBeNull();
    // Salvage keeps the artwork key and drops the duplicate wide one.
    const salvaged = salvageEditorialItemView(
      view({ kind: "artist", artworkKey: shared, wideArtworkKey: shared })
    );
    expect(salvaged?.view.artworkKey).toBe(shared);
    expect(salvaged?.view.wideArtworkKey).toBeUndefined();
  });

  it("treats an absent wide portrait key as an ordinary view", () => {
    const normalized = normalizeEditorialItemView(
      view({ kind: "artist", artworkKey: "abc/def?x=1" })
    );
    expect(normalized).not.toBeNull();
    expect(normalized?.wideArtworkKey).toBeUndefined();
    expect("wideArtworkKey" in (normalized as object)).toBe(false);
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
