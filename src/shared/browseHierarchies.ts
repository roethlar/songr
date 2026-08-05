/** Public Roon browse hierarchies accepted at every controller boundary. */
export const ALLOWED_BROWSE_HIERARCHY_VALUES = [
  "browse",
  "search",
  "playlists",
  "settings",
  "internet_radio",
  "albums",
  "artists",
  "genres",
  "composers",
  // Undocumented, but intentionally probed by welcome stats.
  "tracks",
] as const;

export type AllowedBrowseHierarchy =
  (typeof ALLOWED_BROWSE_HIERARCHY_VALUES)[number];

export const ALLOWED_BROWSE_HIERARCHIES: ReadonlySet<string> = new Set(
  ALLOWED_BROWSE_HIERARCHY_VALUES
);

export function isAllowedBrowseHierarchy(
  hierarchy: unknown
): hierarchy is AllowedBrowseHierarchy {
  return (
    typeof hierarchy === "string" &&
    ALLOWED_BROWSE_HIERARCHIES.has(hierarchy)
  );
}
