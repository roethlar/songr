/** Shared bound for display text used in public Library locators. */
export const LIBRARY_DISPLAY_TEXT_MAX_LENGTH = 512;

/** Comparison text only; preserve Roon's original text for display. */
export function normalizeLibraryText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}
