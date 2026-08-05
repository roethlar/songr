/**
 * Repair for the UTF-8-read-as-Windows-1252 mojibake class: text whose
 * UTF-8 bytes were decoded as Windows-1252 (or Latin-1) somewhere
 * upstream, turning "–" into "â€“", "é" into "Ã©", and NBSP into "Â ".
 * Live Core metadata exhibits this (e.g. "French Suites - Italian
 * Concerto â€" Fantasia and Fugue").
 *
 * Conservative by construction: a repair is attempted only when a
 * telltale UTF-8-lead-byte character is present, every character must
 * map back to a single byte, the byte sequence must decode as strict
 * UTF-8, and the decoded result must be shorter than the input. Any
 * failed gate returns the input unchanged, so legitimate text that
 * merely contains "Â"/"Ã"/"â" survives — its neighbours will not form
 * valid UTF-8 continuation bytes.
 */

// Windows-1252 differs from Latin-1 only in 0x80-0x9F. These are the 27
// defined code points there; the five undefined bytes (0x81, 0x8D, 0x8F,
// 0x90, 0x9D) come through decoders as C1 controls and are covered by
// the code-point <= 0xFF identity mapping below.
const CP1252_TO_BYTE: ReadonlyMap<number, number> = new Map([
  [0x20ac, 0x80],
  [0x201a, 0x82],
  [0x0192, 0x83],
  [0x201e, 0x84],
  [0x2026, 0x85],
  [0x2020, 0x86],
  [0x2021, 0x87],
  [0x02c6, 0x88],
  [0x2030, 0x89],
  [0x0160, 0x8a],
  [0x2039, 0x8b],
  [0x0152, 0x8c],
  [0x017d, 0x8e],
  [0x2018, 0x91],
  [0x2019, 0x92],
  [0x201c, 0x93],
  [0x201d, 0x94],
  [0x2022, 0x95],
  [0x2013, 0x96],
  [0x2014, 0x97],
  [0x02dc, 0x98],
  [0x2122, 0x99],
  [0x0161, 0x9a],
  [0x203a, 0x9b],
  [0x0153, 0x9c],
  [0x017e, 0x9e],
  [0x0178, 0x9f],
]);

// UTF-8 lead bytes (0xC2-0xF4) decoded as Windows-1252/Latin-1 land on
// these characters. At least one must be present to attempt a repair.
const TELLTALE = /[Â-ô]/;

// Available as a global in Node >= 18 and in every supported browser.
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

function reverseToBytes(value: string): Uint8Array | null {
  const bytes = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0xff) {
      bytes[i] = code;
      continue;
    }
    const mapped = CP1252_TO_BYTE.get(code);
    if (mapped === undefined) return null;
    bytes[i] = mapped;
  }
  return bytes;
}

function repairOnce(value: string): string {
  if (!TELLTALE.test(value)) return value;
  const bytes = reverseToBytes(value);
  if (!bytes) return value;
  let decoded: string;
  try {
    decoded = strictUtf8.decode(bytes);
  } catch {
    return value;
  }
  // A genuine reverse transform always shrinks (multi-byte sequences
  // collapse to one character). Equal or longer means it was not
  // mojibake.
  if (decoded.length >= value.length) return value;
  return decoded;
}

/** Double-encoded text exists in the wild; deeper nesting does not. */
const MAX_PASSES = 2;

export function repairEncoding(value: string): string {
  let current = value;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const next = repairOnce(current);
    if (next === current) break;
    current = next;
  }
  return current;
}

export function repairOptionalEncoding(
  value: string | undefined
): string | undefined {
  return value === undefined ? undefined : repairEncoding(value);
}
