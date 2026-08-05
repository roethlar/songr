import { searchTypeForToken } from "../searchTypes";

describe("searchTypeForToken", () => {
  it("maps singular and plural tokens to their type", () => {
    expect(searchTypeForToken("Albums")).toBe("album");
    expect(searchTypeForToken("artist")).toBe("artist");
    expect(searchTypeForToken("Tracks")).toBe("track");
    expect(searchTypeForToken("Composers")).toBe("composer");
  });

  it("maps the Stations category title to 'radio' (rev-6)", () => {
    expect(searchTypeForToken("Stations")).toBe("radio");
    expect(searchTypeForToken("radio")).toBe("radio");
  });

  it("returns 'unknown' for unrecognized tokens", () => {
    expect(searchTypeForToken("list")).toBe("unknown");
    expect(searchTypeForToken("")).toBe("unknown");
    expect(searchTypeForToken("Radio Stations")).toBe("unknown");
  });
});
