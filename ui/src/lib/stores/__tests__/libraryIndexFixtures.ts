import type { CatalogIndexResponse } from '@shared/catalogIndexContracts';
import type { CatalogStatus } from '@shared/timelineCatalogContracts';

/**
 * Synthetic library fixtures for scale/responsiveness tests (Unified
 * Library plan §3.2 "Scale independence"). Slice 3 ships the scaffolding;
 * slice 5 reuses it for rail-jump/sort/palette latency assertions.
 */

export function syntheticStatus(over: Partial<CatalogStatus> = {}): CatalogStatus {
	return {
		coreId: 'core-a',
		freshness: 'fresh',
		persistence: 'healthy',
		refresh: 'idle',
		available: true,
		complete: true,
		revision: 1,
		artistCount: 1,
		albumCount: 1,
		updatedAt: '2026-07-15T00:00:00.000Z',
		lastCompleteScanAt: '2026-07-15T00:00:00.000Z',
		...over
	};
}

const WORDS = [
	'Aurora',
	'Bridge',
	'Circles',
	'Delta',
	'Echoes',
	'Fields',
	'Garden',
	'Harbor',
	'Islands',
	'Journey',
	'Kingdom',
	'Lantern',
	'Meadow',
	'North',
	'Orbit',
	'Prism',
	'Quarry',
	'Rivers',
	'Signal',
	'Tundra',
	'Umbra',
	'Valley',
	'Winter',
	'Xenon',
	'Yonder',
	'Zephyr'
] as const;

export interface SyntheticIndexOptions {
	albumCount: number;
	artistCount: number;
	/** Index of one artist that receives `bigArtistAlbums` bindings. */
	bigArtistAlbums?: number;
}

/**
 * Deterministic synthetic catalog index. Albums are distributed
 * round-robin across artists except the first artist, which receives
 * `bigArtistAlbums` consecutive bindings (the 500-album-artist case).
 */
export function makeSyntheticIndex(options: SyntheticIndexOptions): CatalogIndexResponse {
	const { albumCount, artistCount, bigArtistAlbums = 0 } = options;
	const artistIds = Array.from({ length: artistCount }, (_, i) => `art-${i}`);
	const counts = new Map<string, number>();
	const albums = Array.from({ length: albumCount }, (_, i) => {
		const artistIndex =
			i < bigArtistAlbums ? 0 : i % artistCount;
		const artistLocalId = artistIds[artistIndex];
		counts.set(artistLocalId, (counts.get(artistLocalId) ?? 0) + 1);
		return {
			localId: `alb-${i}`,
			artistLocalId,
			resolutionStatus: 'resolved' as const,
			title: `${WORDS[i % WORDS.length]} ${Math.floor(i / WORDS.length)}`,
			artist: `Artist ${WORDS[artistIndex % WORDS.length]} ${artistIndex}`
		};
	});
	const artists = artistIds.map((localId, i) => ({
		localId,
		name: `Artist ${WORDS[i % WORDS.length]} ${i}`,
		knownAlbumCount: counts.get(localId) ?? 0,
		countComplete: true
	}));
	return {
		status: syntheticStatus({
			artistCount,
			albumCount
		}),
		artists,
		albums
	};
}
