import type { SearchResult } from "./types";

/**
 * Map a Roon-facing type token — an item_type, a hint, or a search
 * category title like "Albums" / "Stations" — to a SearchResult type.
 *
 * Single source of truth shared by the backend's search typing
 * (BrowseService.inferSearchType / category expansion) and the UI's
 * category-stub rematching (freshenSearchItem), so the two sides can
 * never disagree. rev-6: the server mapped "Stations" → 'radio' while
 * the client used a strip-the-trailing-s heuristic that produced
 * 'station', making radio results impossible to freshen.
 */
export function searchTypeForToken(token: string): SearchResult["resultType"] {
	switch (token.trim().toLowerCase()) {
		case "artist":
		case "artists":
			return "artist";
		case "album":
		case "albums":
			return "album";
		case "track":
		case "tracks":
			return "track";
		case "playlist":
		case "playlists":
			return "playlist";
		case "genre":
		case "genres":
			return "genre";
		case "composer":
		case "composers":
			return "composer";
		case "label":
		case "labels":
			return "label";
		case "radio":
		case "stations":
			return "radio";
		default:
			return "unknown";
	}
}
