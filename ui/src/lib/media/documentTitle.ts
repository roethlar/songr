/**
 * Mirrors the selected zone's now-playing state into the browser tab title.
 *
 * Started once by the shell, alongside the media session binding, and torn
 * down with it. Playback status is read through the same `mapPlaybackStatus`
 * the OS media session uses, so the tab and the system panel can never
 * disagree about whether something is playing.
 *
 * The tab must never keep a track name that is no longer true, so anything
 * short of "this zone is playing this track" — paused, stopped, zone gone,
 * Core unpaired, teardown — puts the default title back.
 */
import { derived } from 'svelte/store';
import type { NowPlaying, Zone } from '@shared/types';
import { isCorePaired } from '$lib/stores/coreStore';
import { nowPlayingStore } from '$lib/stores/nowPlayingStore';
import { selectedZoneStore } from '$lib/stores/selectedZoneStore';
import { zoneMapStore } from '$lib/stores/zonesStore';
import { mapPlaybackStatus } from './mediaSessionState';

/** Fallback for a document that shipped without a title of its own. */
export const APP_TITLE = 'Songr';

export interface DocumentTitleInput {
	/** False while the Roon Core is unpaired or still being discovered. */
	readonly corePaired: boolean;
	readonly zone: Zone | undefined;
	readonly nowPlaying: NowPlaying | undefined;
}

/**
 * `Track – Artist · Songr` while playing, the default title otherwise. The
 * artist half is dropped rather than left empty when the track has neither an
 * artist nor an album artist.
 */
export function formatDocumentTitle(input: DocumentTitleInput, defaultTitle: string): string {
	if (!input.corePaired) return defaultTitle;

	// The zone record is the same source the on-screen transport reads for its
	// play/pause glyph; the now-playing payload covers the gap before the zone
	// list catches up.
	if (mapPlaybackStatus(input.zone?.state ?? input.nowPlaying?.state) !== 'playing') {
		return defaultTitle;
	}

	const title = input.nowPlaying?.title?.trim() ?? '';
	if (!title) return defaultTitle;

	const artist = (input.nowPlaying?.artist ?? input.nowPlaying?.album_artist ?? '').trim();
	return artist ? `${title} – ${artist} · ${APP_TITLE}` : `${title} · ${APP_TITLE}`;
}

/**
 * Start following now-playing into `document.title`. Returns the teardown,
 * which unsubscribes and restores the default title. A no-op without a
 * document, which covers SSR.
 */
export function startDocumentTitleBinding(): () => void {
	if (typeof document === 'undefined') return () => {};

	// Whatever the page loaded with is what "default" means here; a document
	// with no title of its own falls back to the product name.
	const defaultTitle = document.title.trim() || APP_TITLE;
	let written: string | null = null;

	const write = (next: string): void => {
		if (next === written) return;
		written = next;
		document.title = next;
	};

	const source = derived(
		[selectedZoneStore, zoneMapStore, nowPlayingStore, isCorePaired],
		([$zoneId, $zoneMap, $nowPlaying, $corePaired]) => ({
			corePaired: $corePaired,
			zone: $zoneId ? $zoneMap.get($zoneId) : undefined,
			nowPlaying: $zoneId ? $nowPlaying[$zoneId] : undefined
		})
	);

	const unsubscribe = source.subscribe((input) => {
		write(formatDocumentTitle(input, defaultTitle));
	});

	return () => {
		unsubscribe();
		// Store traffic stops here, so the restore cannot be left to the
		// subscription: put the default back by hand.
		written = defaultTitle;
		document.title = defaultTitle;
	};
}
