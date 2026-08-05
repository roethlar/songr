import { describe, expect, it } from 'vitest';
import { createTimelineCanvasModel } from '../canvasModel';
import {
	MAX_TIMELINE_BRANCH_ALBUMS,
	MAX_TIMELINE_BRANCHES,
	TIMELINE_BRANCH_HEADER_HEIGHT,
	createTimelineBranchAlbumEntityId,
	createTimelineBranchLayout,
	createTimelineBranchRenderPlan,
	type TimelineBranchAlbumInput,
	type TimelineBranchLayoutInput
} from '../branchModel';
import type { Camera, Rect, ScreenViewport } from '../types';
import { calendarAlbum } from './fixtures';

const provenance = {
	provider: 'artist-search',
	providerLabel: 'Artist search',
	attachmentLabel: 'User-attached branch'
} as const;

function branchAlbum(
	branchId: string,
	albumLocalId: string,
	year: number,
	ordinal: number,
	image = true
): TimelineBranchAlbumInput {
	const placement = calendarAlbum(albumLocalId, year, ordinal, { image }).placement;
	return {
		entityId: createTimelineBranchAlbumEntityId(branchId, albumLocalId),
		branchId,
		albumLocalId,
		artistLocalId: `artist-${branchId}`,
		title: `Branch album ${albumLocalId}`,
		artist: `Artist ${branchId}`,
		placement,
		resolutionStatus: 'resolved',
		...(image ? { imageKeyHint: `branch-image-${albumLocalId}` } : {})
	};
}

function readyBranch(
	branchId: string,
	sourceEntityId: string,
	sourceAlbumLocalId: string,
	albums: readonly TimelineBranchAlbumInput[],
	options: {
		depth?: 1 | 2;
		parentBranchId?: string | null;
		catalogTotal?: number;
	} = {}
): TimelineBranchLayoutInput {
	const depth = options.depth ?? 1;
	return {
		branchId,
		depth,
		source: {
			kind: depth === 1 ? 'base-album' : 'branch-album',
			entityId: sourceEntityId,
			albumLocalId: sourceAlbumLocalId,
			parentBranchId: options.parentBranchId ?? null,
			depth: depth - 1 as 0 | 1
		},
		artist: {
			localId: `artist-${branchId}`,
			exactName: `Artist ${branchId}`
		},
		phase: 'ready',
		error: null,
		provenance,
		albums,
		catalogTotal: options.catalogTotal ?? albums.length,
		truncated: (options.catalogTotal ?? albums.length) > albums.length
	};
}

function errorBranch(branchId: string, sourceId: string): TimelineBranchLayoutInput {
	return {
		...readyBranch(branchId, sourceId, sourceId, []),
		phase: 'error',
		error: 'Catalog lookup failed'
	};
}

function contains(container: Rect, candidate: Rect): boolean {
	return (
		candidate.x >= container.x &&
		candidate.y >= container.y &&
		candidate.x + candidate.width <= container.x + container.width &&
		candidate.y + candidate.height <= container.y + container.height
	);
}

function centeredCamera(bounds: Rect, scale: number): Camera {
	return {
		centerX: bounds.x + bounds.width / 2,
		centerY: bounds.y + bounds.height / 2,
		scale
	};
}

describe('Timeline branch model', () => {
	it('lays out deterministic horizontal lanes with stable catalog identity and honest metadata', () => {
		const base = createTimelineCanvasModel([
			calendarAlbum('source', 2000, 0),
			calendarAlbum('other', 2001, 1)
		]);
		const parentAlbums = [
			branchAlbum('parent', 'later', 2010, 1),
			branchAlbum('parent', 'earlier', 1998, 0)
		];
		const parent = readyBranch('parent', 'source', 'source', parentAlbums, {
			catalogTotal: 11
		});
		const childSourceId = createTimelineBranchAlbumEntityId('parent', 'earlier');
		const child = readyBranch(
			'child',
			childSourceId,
			'earlier',
			[branchAlbum('child', 'child-album', 2020, 0)],
			{ depth: 2, parentBranchId: 'parent' }
		);

		const first = createTimelineBranchLayout(base, [child, parent]);
		const second = createTimelineBranchLayout(base, [parent, child]);
		expect(second).toEqual(first);
		expect(first.groups.map(({ branchId }) => branchId)).toEqual(['parent', 'child']);

		const parentGroup = first.groupById.get('parent')!;
		const childGroup = first.groupById.get('child')!;
		expect(parentGroup.entities.map(({ albumLocalId }) => albumLocalId)).toEqual([
			'earlier',
			'later'
		]);
		expect(new Set(parentGroup.entities.map(({ y }) => y))).toEqual(new Set([parentGroup.header.y]));
		expect(parentGroup.entities[0].x).toBeLessThan(parentGroup.entities[1].x);
		expect(Math.abs(childGroup.header.y)).toBeGreaterThan(Math.abs(parentGroup.header.y));
		expect(childGroup.sourceEntityId).toBe(childSourceId);

		const firstEntity = parentGroup.entities[0];
		expect(firstEntity).toMatchObject({
			id: childSourceId,
			albumLocalId: 'earlier',
			artistLocalId: 'artist-parent',
			branchId: 'parent',
			depth: 1,
			resolutionStatus: 'resolved',
			chronologyLabel: '1998'
		});
		expect(parentGroup.header).toMatchObject({
			providerLabel: 'Artist search',
			attachmentLabel: 'User-attached branch',
			displayedAlbumCount: 2,
			catalogTotal: 11,
			truncated: true,
			maximumAlbumCount: MAX_TIMELINE_BRANCH_ALBUMS,
			controlCount: 1
		});
		expect(parentGroup.header.height).toBe(TIMELINE_BRANCH_HEADER_HEIGHT);
		expect(parentGroup.controls.map(({ action }) => action)).toEqual(['close']);
		expect(parentGroup.connector).toMatchObject({
			sourceEntityId: 'source',
			targetHeaderId: parentGroup.header.id,
			strokeWidth: 1,
			interactive: false
		});
		expect(first.entityById.get(childSourceId)).toBe(firstEntity);
		expect(contains(first.bounds, base.bounds)).toBe(true);
		expect(first.branchBounds && contains(first.bounds, first.branchBounds)).toBe(true);
	});

	it('derives close disappearance entirely from the remaining branch inputs', () => {
		const base = createTimelineCanvasModel([calendarAlbum('source', 2000, 0)]);
		const branch = readyBranch(
			'branch',
			'source',
			'source',
			[branchAlbum('branch', 'album', 2002, 0)]
		);
		const open = createTimelineBranchLayout(base, [branch]);
		const closed = createTimelineBranchLayout(base, []);

		expect(open.groups).toHaveLength(1);
		expect(open.entityById.size).toBe(1);
		expect(closed.groups).toHaveLength(0);
		expect(closed.entityById.size).toBe(0);
		expect(closed.branchBounds).toBeNull();
		expect(closed.bounds).toEqual(base.bounds);
	});

	it('counts Retry and Close as separate error controls', () => {
		const base = createTimelineCanvasModel([calendarAlbum('source', 2000, 0)]);
		const layout = createTimelineBranchLayout(base, [errorBranch('failed', 'source')]);
		const group = layout.groups[0];

		expect(group.phase).toBe('error');
		expect(group.error).toBe('Catalog lookup failed');
		expect(group.controls.map(({ action }) => action)).toEqual(['retry', 'close']);
		expect(group.controlCount).toBe(2);
		expect(group.header.controlCount).toBe(2);
	});

	it('fails closed when graph, depth, or publication caps are invalid', () => {
		const base = createTimelineCanvasModel([calendarAlbum('source', 2000, 0)]);
		const branches = Array.from({ length: MAX_TIMELINE_BRANCHES + 1 }, (_, index) =>
			readyBranch(`branch-${index}`, 'source', 'source', [])
		);
		expect(() => createTimelineBranchLayout(base, branches)).toThrow(/at most 3/);

		const tooManyAlbums = Array.from(
			{ length: MAX_TIMELINE_BRANCH_ALBUMS + 1 },
			(_, index) => branchAlbum('wide', `album-${index}`, 2000 + index, index)
		);
		expect(() => createTimelineBranchLayout(base, [
			readyBranch('wide', 'source', 'source', tooManyAlbums)
		])).toThrow(/at most 8/);

		const invalidDepth = {
			...readyBranch('deep', 'source', 'source', []),
			depth: 3
		} as unknown as TimelineBranchLayoutInput;
		expect(() => createTimelineBranchLayout(base, [invalidDepth])).toThrow(/depth/);

		expect(() => createTimelineBranchLayout(base, [
			readyBranch('missing', 'gone', 'gone', [])
		])).toThrow(/invalid base-album source/);
	});

	it('renders every intersecting branch album and reserves exact shared budgets', () => {
		const base = createTimelineCanvasModel([calendarAlbum('source', 2000, 0)]);
		const albums = Array.from({ length: MAX_TIMELINE_BRANCH_ALBUMS }, (_, index) =>
			branchAlbum('branch', `album-${index}`, 2000 + index, index)
		);
		const layout = createTimelineBranchLayout(base, [
			readyBranch('branch', 'source', 'source', albums)
		]);
		const viewport: ScreenViewport = { x: 0, y: 0, width: 6_000, height: 3_000 };
		const plan = createTimelineBranchRenderPlan(
			layout,
			centeredCamera(layout.bounds, 1),
			viewport,
			{ reservedWorldObjects: 1, reservedArtworkImages: 1 }
		);

		expect(plan.counts).toMatchObject({
			intersectingAlbums: 8,
			albumObjects: 8,
			headerObjects: 1,
			controlObjects: 1,
			worldObjects: 10,
			artworkCandidates: 8,
			artworkImages: 8,
			connectors: 1
		});
		expect(plan.accounting).toEqual({
			expectedIntersectingAlbums: 8,
			representedIntersectingAlbums: 8,
			complete: true
		});
		expect(plan.reservations).toMatchObject({
			priorWorldObjects: 1,
			branchWorldObjects: 10,
			sharedWorldObjects: 11,
			remainingWorldObjects: 61,
			priorArtworkImages: 1,
			branchArtworkImages: 8,
			sharedArtworkImages: 9,
			remainingArtworkImages: 31
		});
		expect(() => createTimelineBranchRenderPlan(
			layout,
			centeredCamera(layout.bounds, 1),
			viewport,
			{ reservedWorldObjects: 71 }
		)).toThrow(/were not omitted/);
	});

	it('requests no overview artwork and caps navigation artwork without hiding albums', () => {
		const base = createTimelineCanvasModel([calendarAlbum('source', 2000, 0)]);
		const albums = Array.from({ length: MAX_TIMELINE_BRANCH_ALBUMS }, (_, index) =>
			branchAlbum('branch', `album-${index}`, 2000 + index, index)
		);
		const layout = createTimelineBranchLayout(base, [
			readyBranch('branch', 'source', 'source', albums)
		]);
		const viewport: ScreenViewport = { x: 0, y: 0, width: 6_000, height: 3_000 };
		const overview = createTimelineBranchRenderPlan(
			layout,
			centeredCamera(layout.bounds, 0.5),
			viewport
		);
		const constrained = createTimelineBranchRenderPlan(
			layout,
			centeredCamera(layout.bounds, 1),
			viewport,
			{ reservedArtworkImages: 39 }
		);

		expect(overview.tier).toBe('overview');
		expect(overview.albums).toHaveLength(8);
		expect(overview.artworkIds).toEqual([]);
		expect(constrained.albums).toHaveLength(8);
		expect(constrained.artworkIds).toHaveLength(1);
		expect(constrained.accounting.complete).toBe(true);
	});

	it('pins one branch album outside culling while connectors remain visible-only', () => {
		const base = createTimelineCanvasModel([calendarAlbum('source', 2000, 0)]);
		const branch = readyBranch(
			'branch',
			'source',
			'source',
			[branchAlbum('branch', 'album', 2002, 0)]
		);
		const layout = createTimelineBranchLayout(base, [branch]);
		const group = layout.groups[0];
		const viewport: ScreenViewport = { x: 0, y: 0, width: 100, height: 100 };
		const farCamera: Camera = { centerX: 10_000, centerY: 10_000, scale: 1 };
		const pinned = createTimelineBranchRenderPlan(layout, farCamera, viewport, {
			pinnedId: group.entities[0].id
		});
		expect(pinned.counts).toMatchObject({
			intersectingAlbums: 0,
			pinnedOutsideViewport: 1,
			albumObjects: 1,
			headerObjects: 1,
			controlObjects: 1,
			connectors: 0
		});
		expect(pinned.albums[0].pinned).toBe(true);

		const connectorCamera: Camera = {
			centerX: (group.connector.start.x + group.connector.end.x) / 2,
			centerY: (group.connector.start.y + group.connector.end.y) / 2,
			scale: 1
		};
		const connectorOnly = createTimelineBranchRenderPlan(
			layout,
			connectorCamera,
			viewport
		);
		expect(connectorOnly.connectors).toEqual([group.connector]);
		expect(connectorOnly.headers.map(({ entity }) => entity.branchId)).toEqual(['branch']);
		expect(connectorOnly.controls).toHaveLength(1);
	});
});
