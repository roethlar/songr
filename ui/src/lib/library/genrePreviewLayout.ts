import { LIBRARY_PREVIEW_LIMIT_MAX } from '@shared/libraryPreviewContracts';

/** Zero means layout is not measured yet, not a request for an arbitrary N. */
export function genrePreviewCapacity(width: number, tile: number, gap: number): number {
	if (![width, tile, gap].every(Number.isFinite) || width <= 0 || tile <= 0 || gap < 0) return 0;
	return Math.min(LIBRARY_PREVIEW_LIMIT_MAX, Math.max(1, Math.floor((width + gap) / (tile + gap))));
}
