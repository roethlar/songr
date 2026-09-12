import { classifyBrowseActionOutcome } from "../browseActionOutcome";

describe("classifyBrowseActionOutcome", () => {
  it.each(["none", "list", "message", "replace_item", "remove_item"])(
    "accepts the public %s response when its optional error flag is absent or false",
    (action) => {
      expect(classifyBrowseActionOutcome({ action })).toEqual({ kind: "executed" });
      expect(classifyBrowseActionOutcome({ action, isError: false })).toEqual({ kind: "executed" });
    }
  );

  it("preserves a definitive refusal even when the action is absent or unfamiliar", () => {
    for (const action of [undefined, "message", "future_action"]) {
      expect(classifyBrowseActionOutcome({ action, isError: true, message: "Track unavailable" }))
        .toEqual({ kind: "refused", message: "Track unavailable" });
    }
  });

  it("fits refusal text into existing action-error contracts without losing the explanation", () => {
    expect(classifyBrowseActionOutcome({ isError: true, message: "  Track\nunavailable  " }))
      .toEqual({ kind: "refused", message: "Track unavailable" });
    expect(classifyBrowseActionOutcome({ isError: true, message: "x".repeat(1025) }))
      .toEqual({ kind: "refused", message: "x".repeat(1024) });
    expect(classifyBrowseActionOutcome({ isError: true, message: "\n " }))
      .toEqual({ kind: "refused", message: "Roon refused this action." });
  });

  it.each([undefined, "", "future_action"])(
    "does not claim success when the mandatory action is %s",
    (action) => expect(classifyBrowseActionOutcome({ action, isError: false }))
      .toEqual({ kind: "unknown" })
  );
});
