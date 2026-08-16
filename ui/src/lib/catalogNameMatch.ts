import type { AlbumRef } from '@shared/catalogContracts';
import { normalizeCatalogText } from '@shared/catalogContracts';
import { librarySortKey, type LibraryAlbumEntry } from '$lib/stores/libraryIndexStore';

/**
 * Folded display-name key for the artist drill's FALLBACK join only.
 *
 * The authoritative artist↔album link is the catalog binding
 * (`album.artistId`) written by the browse-into-artist load; display-name
 * matching is never the primary join (owner ruling 2026-08-08). Folding
 * exists so typographic credit variants — Roon's Artists row says
 * `’Til Tuesday` (U+2019) while its Albums-row credits say `'Til Tuesday`
 * (U+0027) — still join before that binding lands or when it cannot be
 * fetched. NFKC does not fold these punctuation variants, so the table
 * below does.
 */
const FOLDED_CHARS: Readonly<Record<string, string>> = Object.freeze({
	'‘': "'", // ‘
	'’': "'", // ’
	'‚': "'", // ‚
	'‛': "'", // ‛
	'ʼ': "'", // ʼ
	'′': "'", // ′
	'“': '"', // “
	'”': '"', // ”
	'„': '"', // „
	'″': '"', // ″
	'‐': '-', // ‐
	'‑': '-', // ‑
	'‒': '-', // ‒
	'–': '-', // –
	'—': '-', // —
	'−': '-' // −
});

export function foldCatalogNameKey(value: string): string {
	let folded = '';
	for (const ch of value.normalize('NFKC')) {
		folded += FOLDED_CHARS[ch] ?? ch;
	}
	return folded.replace(/\s+/gu, ' ').trim().toLowerCase();
}

/**
 * Maps a shared AlbumRef (the artist-albums load response shape) onto the
 * UI's LibraryAlbumEntry exactly the way prepareCatalogIndex maps index
 * rows, so overlay albums sort, bucket, and render identically to
 * index-sourced ones.
 */
export function libraryAlbumEntryFromAlbumRef(album: AlbumRef): LibraryAlbumEntry {
	return {
		id: album.localId,
		title: album.exactTitle,
		artist: album.exactArtist,
		versionCount: 1,
		memberLocalIds: [album.localId],
		searchKey: `${librarySortKey(album.exactTitle)} ${normalizeCatalogText(album.exactArtist)}`,
		...(album.artistLocalId !== undefined ? { artistId: album.artistLocalId } : {}),
		...(album.imageKeyHint !== undefined ? { imageKey: album.imageKeyHint } : {}),
		catalogLocalId: album.localId,
		resolutionStatus: album.resolutionStatus,
		...(album.originalReleaseDate !== undefined
			? { originalReleaseDate: { ...album.originalReleaseDate } }
			: {}),
		...(album.releaseDate !== undefined ? { releaseDate: { ...album.releaseDate } } : {}),
		...(album.importDate !== undefined ? { importDate: album.importDate } : {})
	};
}
