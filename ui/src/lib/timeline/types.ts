import type { CatalogTimelinePlacement } from '@shared/timelineCatalogContracts';

export interface Point {
	x: number;
	y: number;
}

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface ScreenViewport extends Rect {}

export interface Camera {
	centerX: number;
	centerY: number;
	scale: number;
}

export type SemanticZoomTier = 'overview' | 'navigation' | 'detail';

/**
 * Keyless input accepted by the deterministic production layout. The
 * chronology arm is already narrowed by the shared catalog contract, so an
 * edition/reissue year cannot accidentally become a calendar anchor here.
 */
export interface TimelineAlbumLayoutInput {
	localId: string;
	title: string;
	artist: string;
	placement: CatalogTimelinePlacement;
	imageKeyHint?: string;
}

export interface TimelineAlbumEntity {
	id: string;
	kind: 'album';
	/** Immutable chronology-derived anchor. Manual placement never rewrites it. */
	anchorX: number;
	anchorY: number;
	/** Effective display position: anchor plus the current tab-memory offset. */
	x: number;
	y: number;
	width: number;
	height: number;
	title: string;
	artist: string;
	chronologyLabel: string;
	year: number | null;
	ordinal: number;
	imageKeyHint?: string;
}

export interface TimelineYearAnchor {
	year: number;
	x: number;
}

export interface TimelineAxis {
	startX: number;
	endX: number;
	yearAnchors: readonly TimelineYearAnchor[];
	undatedStartX: number | null;
}

export interface TimelineLayout {
	entities: readonly TimelineAlbumEntity[];
	bounds: Rect;
	axis: TimelineAxis;
}
