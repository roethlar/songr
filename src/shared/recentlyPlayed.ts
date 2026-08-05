import type { RecentlyPlayedEntry } from "./types";

/**
 * Identity key for a recently-played entry. Two entries with the same
 * key are treated as the same track for dedup / bubble-to-front.
 *
 * Deliberately excludes `zone_id` and `played_at`: the same track is
 * "the same track" whether it played in a different room or at a
 * different time. Shared between the backend RecentlyPlayedService
 * (which removes a prior occurrence on replay) and the frontend
 * recentlyPlayedStore (which mirrors that on each socket insert) so
 * the two never disagree on what counts as a duplicate.
 *
 * Serialized as a JSON tuple rather than a delimiter-joined string:
 * free-form metadata can contain any delimiter (title "A|B" + artist
 * "C" would collide with title "A" + artist "B|C"), and with
 * move-to-front dedup a collision removes/bubbles the WRONG entry,
 * not just mis-suppresses within a window. JSON escaping makes the
 * key unambiguous.
 */
export function recentlyPlayedDedupeKey(entry: RecentlyPlayedEntry): string {
  return JSON.stringify([
    entry.title ?? null,
    entry.artist ?? null,
    entry.album ?? null,
    entry.duration ?? null,
    entry.image_key ?? null,
  ]);
}

/**
 * Collapse a list to one entry per dedupe key, keeping the first
 * occurrence. Entries are stored newest-first, so this keeps each
 * track's most recent play. Used to clean up legacy persisted files
 * written before move-to-front dedup existed.
 */
export function dedupeRecentlyPlayed(
  entries: RecentlyPlayedEntry[]
): RecentlyPlayedEntry[] {
  const seen = new Set<string>();
  const out: RecentlyPlayedEntry[] = [];
  for (const entry of entries) {
    const key = recentlyPlayedDedupeKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}
