import type { LibraryLevelRow } from '@shared/libraryOpenContracts';
import { LIBRARY_PREVIEW_CONTRACT, type LibraryPreview, type LibraryPreviewItemKind } from '@shared/libraryPreviewContracts';
import type { LiveLibraryPageState } from '$lib/library/LiveLibraryPageController';

export function genreRow(token: string, title: string, kind: LibraryLevelRow['kind'], generation = 'gen-1'): LibraryLevelRow {
	return { ref: { generation, token }, title, kind };
}
export function genrePage(rows = [genreRow('albums', 'Albums', 'section'),
	genreRow('play', 'Play Genre', 'action'), genreRow('artists', 'Artists', 'section')], generation = 'gen-1'): LiveLibraryPageState {
	return { phase: 'ready', path: { origin: 'genres', steps: [{ kind: 'genre', title: 'Alt. Rock' }] },
		target: { ...genreRow('genre', 'Alt. Rock', 'genre', generation), subtitle: null, imageKey: null },
		level: { contract: 'library-open-v1', kind: 'level', generation, title: 'Alt. Rock', count: rows.length, rows },
		message: null, group: null, stale: false, generation: 1 };
}
export function genrePrefix(kind: LibraryPreviewItemKind, limit: number, totalCount = 17, generation = 'gen-1', suffix = ''): LibraryPreview {
	return { contract: LIBRARY_PREVIEW_CONTRACT, kind: 'preview', generation, title: `${kind}s`, limit, totalCount,
		rows: Array.from({ length: Math.min(limit, totalCount) }, (_, i) => ({
			...genreRow(`${kind}-${i}${suffix}`, `${kind} ${i}${suffix}`, kind, generation),
			...(kind === 'album' ? { subtitle: 'Exact Credit' } : {})
		})) };
}
