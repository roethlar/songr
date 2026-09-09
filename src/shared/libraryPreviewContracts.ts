/** A bounded prefix is not a complete level and cannot establish uniqueness. */
import {
  LIBRARY_LEVEL_ROWS_MAX,
  libraryImpliedChildKind,
  normalizeLibraryLevelRow,
  normalizeLibraryRowReference,
  type LibraryLevelRow,
  type LibraryNodeKind,
  type LibraryOpenUnavailableReason,
} from "./libraryOpenContracts";
import {
  LIBRARY_OPAQUE_MAX_LENGTH,
  LIBRARY_TEXT_MAX_LENGTH,
  type LibraryRowReference,
} from "./libraryRootsContracts";

export const LIBRARY_PREVIEW_CONTRACT = "library-preview-v1" as const;
export const LIBRARY_PREVIEW_LIMIT_MAX = 100;
export type LibraryPreviewItemKind = "artist" | "album";

/** Classification shared with complete opens; only published genre sections. */
export function libraryGenrePreviewKind(node: {
  readonly hierarchy: string;
  readonly kind: LibraryNodeKind;
  readonly title: string;
}): LibraryPreviewItemKind | null {
  if (node.hierarchy !== "genres" || node.kind !== "section") return null;
  const kind = libraryImpliedChildKind(node);
  return kind === "artist" || kind === "album" ? kind : null;
}

export interface LibraryPreviewRequest {
  readonly ref: LibraryRowReference;
  readonly limit: number;
}

export interface LibraryPreview {
  readonly contract: typeof LIBRARY_PREVIEW_CONTRACT;
  readonly kind: "preview";
  readonly generation: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly totalCount: number;
  readonly limit: number;
  readonly rows: readonly LibraryLevelRow[];
}

export type LibraryPreviewResponse = LibraryPreview
  | { readonly contract: typeof LIBRARY_PREVIEW_CONTRACT; readonly kind: "stale" }
  | { readonly contract: typeof LIBRARY_PREVIEW_CONTRACT; readonly kind: "unavailable";
      readonly reason: LibraryOpenUnavailableReason; readonly message: string };

export function isLibraryPreviewLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= 1 && value <= LIBRARY_PREVIEW_LIMIT_MAX;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeLibraryPreviewRequest(value: unknown): LibraryPreviewRequest | null {
  if (!record(value) || Object.keys(value).length !== 2 ||
      !record(value.ref) || Object.keys(value.ref).length !== 2 ||
      !isLibraryPreviewLimit(value.limit)) return null;
  const ref = normalizeLibraryRowReference(value.ref);
  return ref === null ? null : { ref, limit: value.limit };
}

/** A caller must bind the response to the capacity it actually requested. */
export function normalizeLibraryPreviewResponse(
  value: unknown, requestedLimit: number
): LibraryPreviewResponse | null {
  if (!isLibraryPreviewLimit(requestedLimit) || !record(value) ||
      value.contract !== LIBRARY_PREVIEW_CONTRACT) return null;
  const contract = LIBRARY_PREVIEW_CONTRACT;
  if (value.kind === "stale") return { contract, kind: "stale" };
  if (value.kind === "unavailable") {
    if ((value.reason !== "no-core" && value.reason !== "core-under-pressure" && value.reason !== "read-failed") ||
        typeof value.message !== "string" || value.message.length === 0 ||
        value.message.length > LIBRARY_TEXT_MAX_LENGTH) return null;
    return { contract, kind: "unavailable", reason: value.reason as LibraryOpenUnavailableReason,
      message: value.message };
  }
  if (value.kind !== "preview" || value.limit !== requestedLimit ||
      typeof value.generation !== "string" || !value.generation.length ||
      value.generation.length > LIBRARY_OPAQUE_MAX_LENGTH ||
      typeof value.title !== "string" || value.title.length > LIBRARY_TEXT_MAX_LENGTH ||
      (value.subtitle !== undefined && (typeof value.subtitle !== "string" || value.subtitle.length > LIBRARY_TEXT_MAX_LENGTH)) ||
      typeof value.totalCount !== "number" || !Number.isSafeInteger(value.totalCount) ||
      value.totalCount < 0 || value.totalCount > LIBRARY_LEVEL_ROWS_MAX ||
      !Array.isArray(value.rows) || value.rows.length !== Math.min(requestedLimit, value.totalCount)) return null;
  const rows: LibraryLevelRow[] = [];
  const tokens = new Set<string>();
  for (const entry of value.rows) {
    const row = normalizeLibraryLevelRow(entry, value.generation);
    if (row === null || (row.kind !== "artist" && row.kind !== "album") ||
        (rows.length > 0 && row.kind !== rows[0].kind) || tokens.has(row.ref.token)) return null;
    tokens.add(row.ref.token);
    rows.push(row);
  }
  return { contract, kind: "preview", generation: value.generation, title: value.title,
    totalCount: value.totalCount, limit: requestedLimit, rows,
    ...(typeof value.subtitle === "string" ? { subtitle: value.subtitle } : {}) };
}
