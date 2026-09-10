import { normalizeLibraryText } from "../libraryText";

describe("Library comparison text", () => {
  it("preserves Unicode and whitespace matching when locators are re-resolved", () => {
    expect(normalizeLibraryText("  BJÖRK\t Guðmundsdóttir  ")).toBe("björk guðmundsdóttir");
    expect(normalizeLibraryText("ＢＪＯＲＫ\u00a0Album")).toBe("bjork album");
    expect(normalizeLibraryText("I")).toBe("i");
  });
});
