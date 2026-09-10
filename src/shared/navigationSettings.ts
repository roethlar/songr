/** Server-owned Library navigation preferences. Screen layout never changes this document. */
export const NAVIGATION_DESTINATIONS = [
  { id: "artists", label: "Artists" },
  { id: "albums", label: "Albums" },
  { id: "genres", label: "Genres" },
  { id: "tracks", label: "Tracks" },
  { id: "composers", label: "Composers" },
  { id: "playlists", label: "Playlists" },
  { id: "internet-radio", label: "Live radio" },
  { id: "favorites", label: "Favorites" },
  { id: "recently-played", label: "Recently played" },
  { id: "surprise", label: "Surprise me" },
  { id: "tags", label: "Tags" },
  { id: "browse", label: "Browse" },
  { id: "recently-added", label: "Recently added" },
] as const;

export type BuiltinNavigationDestinationId = (typeof NAVIGATION_DESTINATIONS)[number]["id"];
export type PublicNavigationDestinationId = `public:${string}`;
export type NavigationDestinationId = BuiltinNavigationDestinationId | PublicNavigationDestinationId;
export interface NavigationPathSegment {
  title: string;
  subtitle?: string;
  itemType?: string;
}
export const MAX_CUSTOM_NAVIGATION_DESTINATIONS = 64;
export const MAX_NAVIGATION_DESTINATIONS = NAVIGATION_DESTINATIONS.length + MAX_CUSTOM_NAVIGATION_DESTINATIONS;
const MAX_PUBLIC_DESTINATION_ID_LENGTH = 4096;

function normalizePublicPath(value: unknown): NavigationPathSegment[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) return null;
  const result: NavigationPathSegment[] = [];
  for (const segment of value) {
    if (!isRecord(segment) || Object.keys(segment).some(key => !["title", "subtitle", "itemType"].includes(key)) ||
        typeof segment.title !== "string" || !segment.title.trim() || segment.title.length > 256) return null;
    if (segment.subtitle !== undefined && (typeof segment.subtitle !== "string" || !segment.subtitle.trim() || segment.subtitle.length > 256)) return null;
    if (segment.itemType !== undefined && (typeof segment.itemType !== "string" || !segment.itemType.trim() || segment.itemType.length > 64)) return null;
    result.push({ title: segment.title,
      ...(segment.subtitle !== undefined ? { subtitle: segment.subtitle } : {}),
      ...(segment.itemType !== undefined ? { itemType: segment.itemType } : {}) });
  }
  return result;
}

/** Stable public path identity contains display breadcrumbs, never live item keys. */
export function createPublicNavigationDestinationId(path: readonly NavigationPathSegment[]): PublicNavigationDestinationId {
  const normalized = normalizePublicPath(path);
  if (!normalized) throw new TypeError("Invalid public navigation path");
  const id: PublicNavigationDestinationId = `public:${encodeURIComponent(JSON.stringify(normalized))}`;
  if (id.length > MAX_PUBLIC_DESTINATION_ID_LENGTH) throw new RangeError("Public navigation path is too long");
  return id;
}

export function parsePublicNavigationDestinationId(value: unknown): NavigationPathSegment[] | null {
  if (typeof value !== "string" || !value.startsWith("public:") || value.length > MAX_PUBLIC_DESTINATION_ID_LENGTH) return null;
  try {
    const path = normalizePublicPath(JSON.parse(decodeURIComponent(value.slice(7))));
    return path && createPublicNavigationDestinationId(path) === value ? path : null;
  } catch { return null; }
}

export function getNavigationDestinationLabel(id: NavigationDestinationId): string {
  const path = parsePublicNavigationDestinationId(id);
  const builtin = NAVIGATION_DESTINATIONS.find(destination => destination.id === id);
  if (builtin) return builtin.label;
  if (!path) return "Library page";
  const leaf = path[path.length - 1];
  const detail = leaf.subtitle ?? leaf.itemType;
  return detail ? `${leaf.title} (${detail})` : leaf.title;
}
export const NAVIGATION_DESTINATION_IDS: readonly NavigationDestinationId[] =
  Object.freeze(NAVIGATION_DESTINATIONS.map(({ id }) => id));
export const NAVIGATION_SETTINGS_VERSION = 1 as const;
export const NAVIGATION_SETTINGS_EVENT = "navigation-settings-updated" as const;

export interface NavigationSettingsSnapshot {
  readonly version: typeof NAVIGATION_SETTINGS_VERSION;
  readonly revision: number;
  readonly order: readonly NavigationDestinationId[];
  readonly pinned: readonly NavigationDestinationId[];
}

export interface NavigationSettingsUpdate {
  readonly expectedRevision: number;
  readonly order: readonly NavigationDestinationId[];
  readonly pinned: readonly NavigationDestinationId[];
}

export interface NavigationSettingsErrorResponse {
  readonly error: string;
  readonly current?: NavigationSettingsSnapshot;
}

/** The registry may include unavailable pages. Availability never deletes saved choices. */
export const DEFAULT_NAVIGATION_SETTINGS: NavigationSettingsSnapshot = Object.freeze({
  version: NAVIGATION_SETTINGS_VERSION,
  revision: 0,
  order: NAVIGATION_DESTINATION_IDS,
  pinned: Object.freeze(["artists", "albums", "genres"] as NavigationDestinationId[]),
});

export function isNavigationDestinationId(value: unknown): value is NavigationDestinationId {
  return typeof value === "string" && (NAVIGATION_DESTINATION_IDS.some((id) => id === value) ||
    parsePublicNavigationDestinationId(value) !== null);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseIds(value: unknown): NavigationDestinationId[] | null {
  if (!Array.isArray(value) || value.length > MAX_NAVIGATION_DESTINATIONS ||
      !value.every(isNavigationDestinationId) || new Set(value).size !== value.length) return null;
  return [...value];
}

function parseChoices(value: Record<string, unknown>): {
  order: NavigationDestinationId[]; pinned: NavigationDestinationId[];
} | null {
  const order = parseIds(value.order);
  const pinned = parseIds(value.pinned);
  // Existing v1 files keep every built-in position. Discovered public paths append
  // bounded semantic IDs, so pin/order choices also survive server restarts.
  if (!order || !pinned || !NAVIGATION_DESTINATION_IDS.every(id => order.includes(id)) ||
      pinned.some(id => !order.includes(id))) return null;
  return { order, pinned };
}

export function parseNavigationSettingsSnapshot(value: unknown): NavigationSettingsSnapshot | null {
  if (!isRecord(value) || !hasKeys(value, ["version", "revision", "order", "pinned"]) ||
      value.version !== NAVIGATION_SETTINGS_VERSION || !isRevision(value.revision)) return null;
  const choices = parseChoices(value);
  return choices ? { version: NAVIGATION_SETTINGS_VERSION, revision: value.revision, ...choices } : null;
}

export function parseNavigationSettingsUpdate(value: unknown): NavigationSettingsUpdate | null {
  if (!isRecord(value) || !hasKeys(value, ["expectedRevision", "order", "pinned"]) ||
      !isRevision(value.expectedRevision)) return null;
  const choices = parseChoices(value);
  return choices ? { expectedRevision: value.expectedRevision, ...choices } : null;
}