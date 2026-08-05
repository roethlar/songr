import {
  repairEncoding,
  repairOptionalEncoding,
} from "../repairEncoding";

// Damaged fixtures are constructed programmatically and expectations use
// \u escapes: mojibake glyph sequences are visually ambiguous (the
// damaged en dash ends in U+201C, some forms contain invisible C1
// controls), so hand-typed literals would be unreviewable.

/** Latin-1 variant: UTF-8 bytes read as ISO-8859-1 (yields C1 controls). */
const latin1Mojibake = (value: string): string =>
  Buffer.from(value, "utf8").toString("latin1");

/** Windows-1252 variant: UTF-8 bytes read as CP1252 (yields glyphs). */
const CP1252_FROM_BYTE = new Map<number, string>([
  [0x80, "€"],
  [0x82, "‚"],
  [0x83, "ƒ"],
  [0x84, "„"],
  [0x85, "…"],
  [0x86, "†"],
  [0x87, "‡"],
  [0x88, "ˆ"],
  [0x89, "‰"],
  [0x8a, "Š"],
  [0x8b, "‹"],
  [0x8c, "Œ"],
  [0x8e, "Ž"],
  [0x91, "‘"],
  [0x92, "’"],
  [0x93, "“"],
  [0x94, "”"],
  [0x95, "•"],
  [0x96, "–"],
  [0x97, "—"],
  [0x98, "˜"],
  [0x99, "™"],
  [0x9a, "š"],
  [0x9b, "›"],
  [0x9c, "œ"],
  [0x9e, "ž"],
  [0x9f, "Ÿ"],
]);
const cp1252Mojibake = (value: string): string =>
  Array.from(Buffer.from(value, "utf8"))
    .map((byte) => CP1252_FROM_BYTE.get(byte) ?? String.fromCharCode(byte))
    .join("");

const SPECIALS = [
  "– en dash",
  "— em dash",
  "’ apostrophe",
  "“quotes”",
  "… ellipsis",
  "€1,99",
  "Œuvre",
  "Škoda",
  "žal",
  "Ÿ",
  "™ mark",
  "Café Tacvba",
  "non breaking",
];

describe("repairEncoding", () => {
  it("repairs the CP1252-glyph variant of every special", () => {
    for (const original of SPECIALS) {
      const damaged = cp1252Mojibake(original);
      expect(damaged).not.toBe(original);
      expect(repairEncoding(damaged)).toBe(original);
    }
  });

  it("repairs the Latin-1/C1-control variant of every special", () => {
    for (const original of SPECIALS) {
      const damaged = latin1Mojibake(original);
      expect(damaged).not.toBe(original);
      expect(repairEncoding(damaged)).toBe(original);
    }
  });

  it("repairs the captured live-Core title shape", () => {
    const original =
      "French Suites - Italian Concerto – Fantasia and Fugue";
    expect(repairEncoding(cp1252Mojibake(original))).toBe(original);
  });

  it("repairs double-encoded text in bounded passes", () => {
    const twice = latin1Mojibake(latin1Mojibake("A – B"));
    expect(repairEncoding(twice)).toBe("A – B");
  });

  it("is idempotent on repaired output", () => {
    const repaired = repairEncoding(
      cp1252Mojibake("’—“…")
    );
    expect(repairEncoding(repaired)).toBe(repaired);
  });

  it("leaves clean unicode text alone", () => {
    for (const clean of [
      "Björk",
      "Sigur Rós",
      "Café",
      "Motörhead",
      "AC/DC",
      "純情",
      "…already – proper — text’",
      "",
    ]) {
      expect(repairEncoding(clean)).toBe(clean);
    }
  });

  it("leaves telltale-bearing text that is not valid UTF-8 alone", () => {
    // A telltale followed by a plain letter can never be a UTF-8
    // continuation byte, so these must pass through untouched.
    for (const untouched of [
      "Âber cool",
      "Ã la carte",
      "â plain",
    ]) {
      expect(repairEncoding(untouched)).toBe(untouched);
    }
  });

  it("leaves text containing unmappable characters alone", () => {
    const mixed = cp1252Mojibake("–") + " plus 日本語";
    expect(repairEncoding(mixed)).toBe(mixed);
  });

  it("handles optional values", () => {
    expect(repairOptionalEncoding(undefined)).toBeUndefined();
    expect(repairOptionalEncoding(latin1Mojibake("é"))).toBe("é");
  });
});
