import {
	createCameraQueryWindow,
	shouldRefreshCameraQuery,
	type CameraQueryWindow
} from './geometry';
import type { TimelineCanvasModel } from './canvasModel';
import type {
	Camera,
	Rect,
	ScreenViewport,
	SemanticZoomTier,
	TimelineAlbumEntity,
	TimelineYearAnchor
} from './types';

export const MAX_TIMELINE_WORLD_OBJECTS = 72;
export const MAX_TIMELINE_ARTWORK_IMAGES = 40;
export const MAX_VISIBLE_TIMELINE_TICKS = 24;
const MAX_OVERVIEW_CLUSTERS = 36;
const OVERVIEW_ALBUMS_PER_CLUSTER = 4;
const TIMELINE_CLUSTER_WIDTH = 112;
const TIMELINE_CLUSTER_HEIGHT = 84;
const TIMELINE_CLUSTER_AXIS_OFFSET = 96;
const TIMELINE_CLUSTER_LANE_GAP = 16;

export interface TimelineAlbumRenderObject {
	readonly id: string;
	readonly kind: 'album';
	readonly entity: TimelineAlbumEntity;
	readonly pinned: boolean;
	readonly memberCount: 1;
	readonly memberIds: readonly [string];
}

export interface TimelineClusterRenderObject {
	readonly id: string;
	readonly kind: 'cluster';
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
	readonly title: string;
	readonly subtitle: string;
	readonly pinned: false;
	readonly memberCount: number;
	readonly memberIds: readonly string[];
}

export type TimelineRenderObject =
	| TimelineAlbumRenderObject
	| TimelineClusterRenderObject;

export interface TimelineRenderPlanCounts {
	readonly intersectingAlbums: number;
	readonly pinnedOutsideViewport: number;
	readonly albumObjects: number;
	readonly clusterObjects: number;
	readonly clusteredAlbums: number;
	readonly worldObjects: number;
	readonly artworkImages: number;
}

export interface TimelineRenderPlan {
	readonly tier: SemanticZoomTier;
	readonly queryBounds: Rect;
	readonly objects: readonly TimelineRenderObject[];
	readonly artworkIds: readonly string[];
	readonly visibleYearAnchors: readonly TimelineYearAnchor[];
	readonly showUndatedAnchor: boolean;
	readonly counts: TimelineRenderPlanCounts;
	readonly accounting: {
		readonly expectedIntersectingAlbums: number;
		readonly representedIntersectingAlbums: number;
		readonly complete: boolean;
	};
}

export interface TimelineRenderPlanOptions {
	readonly pinnedId?: string | null;
	readonly previousTier?: SemanticZoomTier;
	/** World objects rendered beside this plan, such as one attached detail slab. */
	readonly reservedWorldObjects?: number;
	/** Artwork images rendered beside this plan, such as detail-slab artwork. */
	readonly reservedArtworkImages?: number;
}

function distanceSquared(entity: TimelineAlbumEntity, centerX: number, centerY: number): number {
	const deltaX = entity.x - centerX;
	const deltaY = entity.y - centerY;
	return deltaX * deltaX + deltaY * deltaY;
}

function compareIds(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function byViewportPriority(
	entities: readonly TimelineAlbumEntity[],
	bounds: Rect
): TimelineAlbumEntity[] {
	const centerX = bounds.x + bounds.width / 2;
	const centerY = bounds.y + bounds.height / 2;
	return [...entities].sort((left, right) => {
		return (
			distanceSquared(left, centerX, centerY) -
				distanceSquared(right, centerX, centerY) ||
			left.x - right.x ||
			left.y - right.y ||
			compareIds(left.id, right.id)
		);
	});
}

export function compareTimelineChronology(
	left: TimelineAlbumEntity,
	right: TimelineAlbumEntity
): number {
	if (left.year === null && right.year !== null) return 1;
	if (left.year !== null && right.year === null) return -1;
	return (
		(left.year ?? 0) - (right.year ?? 0) ||
		left.ordinal - right.ordinal ||
		compareIds(left.id, right.id)
	);
}

function albumObject(
	entity: TimelineAlbumEntity,
	pinned: boolean
): TimelineAlbumRenderObject {
	return Object.freeze({
		id: entity.id,
		kind: 'album' as const,
		entity,
		pinned,
		memberCount: 1 as const,
		memberIds: Object.freeze([entity.id]) as readonly [string]
	});
}

function clusterSubtitle(members: readonly TimelineAlbumEntity[]): string {
	const years = members
		.map((member) => member.year)
		.filter((year): year is number => year !== null);
	const hasUndated = years.length !== members.length;
	if (years.length === 0) return 'Undated';
	const minimum = Math.min(...years);
	const maximum = Math.max(...years);
	const range = minimum === maximum ? String(minimum) : `${minimum}–${maximum}`;
	return hasUndated ? `${range} + Undated` : range;
}

function clusterObject(
	members: readonly TimelineAlbumEntity[],
	index: number,
	x: number,
	y: number
): TimelineClusterRenderObject {
	const memberIds = Object.freeze(members.map((member) => member.id));
	const first = members[0];
	const last = members[members.length - 1];
	return Object.freeze({
		id: `timeline-cluster-${index + 1}-${first.id}-${last.id}`,
		kind: 'cluster' as const,
		x,
		y,
		width: TIMELINE_CLUSTER_WIDTH,
		height: TIMELINE_CLUSTER_HEIGHT,
		title: `${members.length} ${members.length === 1 ? 'release' : 'releases'}`,
		subtitle: clusterSubtitle(members),
		pinned: false as const,
		memberCount: members.length,
		memberIds
	});
}

function centeredBounds(x: number, y: number, width: number, height: number): Rect {
	return { x: x - width / 2, y: y - height / 2, width, height };
}

function entityBounds(entity: TimelineAlbumEntity): Rect {
	return centeredBounds(entity.x, entity.y, entity.width, entity.height);
}

function overlaps(left: Rect, right: Rect): boolean {
	return !(
		left.x + left.width <= right.x ||
		right.x + right.width <= left.x ||
		left.y + left.height <= right.y ||
		right.y + right.height <= left.y
	);
}

function placeCluster(
	members: readonly TimelineAlbumEntity[],
	index: number,
	occupied: Rect[]
): TimelineClusterRenderObject {
	const x = members.reduce((sum, member) => sum + member.x, 0) / members.length;
	const side = index % 2 === 0 ? -1 : 1;
	for (let lane = 0; lane < 10_000; lane += 1) {
		const y =
			side *
			(TIMELINE_CLUSTER_AXIS_OFFSET +
				lane * (TIMELINE_CLUSTER_HEIGHT + TIMELINE_CLUSTER_LANE_GAP));
		const bounds = centeredBounds(
			x,
			y,
			TIMELINE_CLUSTER_WIDTH,
			TIMELINE_CLUSTER_HEIGHT
		);
		if (!occupied.some((other) => overlaps(bounds, other))) {
			occupied.push(bounds);
			return clusterObject(members, index, x, y);
		}
	}
	throw new RangeError('unable to place Timeline cluster without overlap');
}

function createTemporalClusters(
	entities: readonly TimelineAlbumEntity[],
	budget: number,
	blockedEntities: readonly TimelineAlbumEntity[] = []
): TimelineClusterRenderObject[] {
	if (entities.length === 0) return [];
	if (!Number.isSafeInteger(budget) || budget < 1) {
		throw new RangeError('at least one cluster slot is required');
	}
	const sorted = [...entities].sort(compareTimelineChronology);
	const count = Math.min(sorted.length, budget);
	const occupied = blockedEntities.map(entityBounds);
	return Array.from({ length: count }, (_, index) => {
		const start = Math.floor((index * sorted.length) / count);
		const end = Math.floor(((index + 1) * sorted.length) / count);
		return placeCluster(sorted.slice(start, end), index, occupied);
	});
}

function visibleYearAnchors(
	anchors: readonly TimelineYearAnchor[],
	queryBounds: Rect
): readonly TimelineYearAnchor[] {
	const visible = anchors.filter(
		(anchor) => anchor.x >= queryBounds.x && anchor.x <= queryBounds.x + queryBounds.width
	);
	if (visible.length <= MAX_VISIBLE_TIMELINE_TICKS) return Object.freeze([...visible]);
	const sampled: TimelineYearAnchor[] = [];
	for (let index = 0; index < MAX_VISIBLE_TIMELINE_TICKS; index += 1) {
		const sourceIndex = Math.round(
			(index * (visible.length - 1)) / (MAX_VISIBLE_TIMELINE_TICKS - 1)
		);
		const anchor = visible[sourceIndex];
		if (sampled.at(-1) !== anchor) sampled.push(anchor);
	}
	return Object.freeze(sampled);
}

function buildTimelineRenderPlan(
	model: TimelineCanvasModel,
	queryWindow: CameraQueryWindow,
	intersecting: readonly TimelineAlbumEntity[],
	options: TimelineRenderPlanOptions = {}
): TimelineRenderPlan {
	const intersectingIds = new Set(intersecting.map((entity) => entity.id));
	const pinned = options.pinnedId ? model.entityById.get(options.pinnedId) : undefined;
	const reservedWorldObjects = options.reservedWorldObjects ?? 0;
	if (
		!Number.isSafeInteger(reservedWorldObjects) ||
		reservedWorldObjects < 0 ||
		reservedWorldObjects >= MAX_TIMELINE_WORLD_OBJECTS
	) {
		throw new RangeError('reserved world-object count is invalid');
	}
	const worldObjectBudget = MAX_TIMELINE_WORLD_OBJECTS - reservedWorldObjects;
	const reservedArtworkImages = options.reservedArtworkImages ?? 0;
	if (
		!Number.isSafeInteger(reservedArtworkImages) ||
		reservedArtworkImages < 0 ||
		reservedArtworkImages >= MAX_TIMELINE_ARTWORK_IMAGES
	) {
		throw new RangeError('reserved artwork-image count is invalid');
	}
	const artworkImageBudget = MAX_TIMELINE_ARTWORK_IMAGES - reservedArtworkImages;
	const ordinary = byViewportPriority(
		intersecting.filter((entity) => entity.id !== pinned?.id),
		queryWindow.queryBounds
	);
	const pinnedObjects = pinned ? [albumObject(pinned, true)] : [];
	const availableSlots = worldObjectBudget - pinnedObjects.length;
	let individuals: TimelineAlbumEntity[] = [];
	let clustered: TimelineAlbumEntity[] = [];
	let clusters: TimelineClusterRenderObject[] = [];

	if (
		queryWindow.tier !== 'overview' &&
		ordinary.length + pinnedObjects.length <= worldObjectBudget
	) {
		individuals = ordinary;
	} else if (queryWindow.tier === 'overview') {
		clustered = ordinary;
		if (clustered.length > 0) {
			const clusterBudget = Math.min(
				availableSlots,
				MAX_OVERVIEW_CLUSTERS,
				Math.max(1, Math.ceil(clustered.length / OVERVIEW_ALBUMS_PER_CLUSTER))
			);
			clusters = createTemporalClusters(
				clustered,
				clusterBudget,
				pinned ? [pinned] : []
			);
		}
	} else {
		const pinnedArtwork = pinned?.imageKeyHint ? 1 : 0;
		const individualBudget = Math.max(
			0,
			Math.min(
				ordinary.length,
				artworkImageBudget - pinnedArtwork,
				availableSlots - 1
			)
		);
		individuals = ordinary.slice(0, individualBudget);
		clustered = ordinary.slice(individualBudget);
		clusters = createTemporalClusters(clustered, availableSlots - individuals.length, [
			...(pinned ? [pinned] : []),
			...individuals
		]);
	}

	const individualObjects = individuals.map((entity) => albumObject(entity, false));
	const objects = Object.freeze([...pinnedObjects, ...individualObjects, ...clusters]);
	const artworkIds =
		queryWindow.tier === 'overview'
			? []
			: [...pinnedObjects, ...individualObjects]
					.filter((object) => object.entity.imageKeyHint !== undefined)
					.slice(0, artworkImageBudget)
					.map((object) => object.id);
	const representedIndividualIds = new Set(
		[...(pinned ? [pinned] : []), ...individuals]
			.filter((entity) => intersectingIds.has(entity.id))
			.map((entity) => entity.id)
	);
	const representedIntersectingAlbums =
		representedIndividualIds.size +
		clusters.reduce((sum, cluster) => sum + cluster.memberCount, 0);
	const undatedStartX = model.axis.undatedStartX;

	return Object.freeze({
		tier: queryWindow.tier,
		queryBounds: queryWindow.queryBounds,
		objects,
		artworkIds: Object.freeze(artworkIds),
		visibleYearAnchors: visibleYearAnchors(
			model.axis.yearAnchors,
			queryWindow.queryBounds
		),
		showUndatedAnchor:
			undatedStartX !== null &&
			undatedStartX >= queryWindow.queryBounds.x &&
			undatedStartX <= queryWindow.queryBounds.x + queryWindow.queryBounds.width,
		counts: Object.freeze({
			intersectingAlbums: intersecting.length,
			pinnedOutsideViewport:
				pinned !== undefined && !intersectingIds.has(pinned.id) ? 1 : 0,
			albumObjects: pinnedObjects.length + individualObjects.length,
			clusterObjects: clusters.length,
			clusteredAlbums: clusters.reduce(
				(sum, cluster) => sum + cluster.memberCount,
				0
			),
			worldObjects: objects.length,
			artworkImages: artworkIds.length
		}),
		accounting: Object.freeze({
			expectedIntersectingAlbums: intersecting.length,
			representedIntersectingAlbums,
			complete: representedIntersectingAlbums === intersecting.length
		})
	});
}

export class TimelineRenderPlanner {
	readonly #model: TimelineCanvasModel;
	#queryWindow: CameraQueryWindow | null = null;
	#intersecting: readonly TimelineAlbumEntity[] = Object.freeze([]);

	constructor(model: TimelineCanvasModel) {
		this.#model = model;
	}

	createPlan(
		camera: Camera,
		viewport: ScreenViewport,
		options: TimelineRenderPlanOptions = {}
	): TimelineRenderPlan {
		if (
			this.#queryWindow === null ||
			shouldRefreshCameraQuery(this.#queryWindow, camera, viewport)
		) {
			this.#queryWindow = createCameraQueryWindow(
				camera,
				viewport,
				this.#queryWindow?.tier ?? options.previousTier
			);
			this.#intersecting = Object.freeze(
				this.#model.index
					.query(this.#queryWindow.queryBounds)
					.map((item) => item.entity)
			);
		}

		return buildTimelineRenderPlan(
			this.#model,
			this.#queryWindow,
			this.#intersecting,
			options
		);
	}
}
