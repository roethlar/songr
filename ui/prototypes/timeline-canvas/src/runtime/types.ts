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

export type WorkspaceEntityKind = 'album' | 'branch-album';

export interface WorkspaceEntity {
	id: string;
	kind: WorkspaceEntityKind;
	x: number;
	y: number;
	width: number;
	height: number;
	title: string;
	subtitle: string;
	year: number | null;
	artworkIndex: number | null;
	ordinal: number;
	branchId: string | null;
	branchDepth: 0 | 1 | 2;
}

export interface RenderObject {
	id: string;
	kind: WorkspaceEntityKind | 'cluster';
	x: number;
	y: number;
	width: number;
	height: number;
	title: string;
	subtitle: string;
	year: number | null;
	artworkIndex: number | null;
	memberCount: number;
	pinned: boolean;
	memberIds: readonly string[];
}

export interface ZoneTarget {
	id: string;
	name: string;
	rect: Rect;
}
