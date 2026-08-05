import { inverseViewportBounds, semanticZoomTier } from './camera';
import { SPATIAL_INDEX_CELL_SIZE } from './spatial-index';
import type { TimelineWorkspace } from './workspace';
import type {
	Camera,
	Rect,
	RenderObject,
	ScreenViewport,
	SemanticZoomTier,
	WorkspaceEntity
} from './types';

export const MAX_RENDERED_WORLD_OBJECTS = 72;
export const MAX_RENDERED_ARTWORK_IMAGES = 40;
export const MAX_PINNED_OBJECTS = 1;

export interface RenderPlanCounts {
	intersectingEntities: number;
	pinnedOutsideViewport: number;
	individualObjects: number;
	clusterObjects: number;
	clusteredEntities: number;
	worldObjects: number;
	artworkImages: number;
}

export interface RenderPlanAccounting {
	expectedIntersectingEntities: number;
	representedIntersectingEntities: number;
	complete: boolean;
}

export interface RenderPlan {
	tier: SemanticZoomTier;
	queryBounds: Rect;
	objects: readonly RenderObject[];
	artworkIds: readonly string[];
	counts: RenderPlanCounts;
	accounting: RenderPlanAccounting;
}

function entityToRenderObject(entity: WorkspaceEntity, pinned: boolean): RenderObject {
	return {
		id: entity.id,
		kind: entity.kind,
		x: entity.x,
		y: entity.y,
		width: entity.width,
		height: entity.height,
		title: entity.title,
		subtitle: entity.subtitle,
		year: entity.year,
		artworkIndex: entity.artworkIndex,
		memberCount: 1,
		pinned,
		memberIds: [entity.id]
	};
}

function distanceSquared(entity: WorkspaceEntity, centerX: number, centerY: number): number {
	const dx = entity.x - centerX;
	const dy = entity.y - centerY;
	return dx * dx + dy * dy;
}

function sortByPriority(entities: WorkspaceEntity[], bounds: Rect): WorkspaceEntity[] {
	const centerX = bounds.x + bounds.width / 2;
	const centerY = bounds.y + bounds.height / 2;
	return entities.sort((a, b) => {
		const distance = distanceSquared(a, centerX, centerY) - distanceSquared(b, centerX, centerY);
		return distance || a.x - b.x || a.y - b.y || a.id.localeCompare(b.id);
	});
}

function groupByGrid(entities: readonly WorkspaceEntity[]): WorkspaceEntity[][] {
	const groups = new Map<string, WorkspaceEntity[]>();
	for (const entity of entities) {
		const key = `${Math.floor(entity.x / SPATIAL_INDEX_CELL_SIZE)}:${Math.floor(entity.y / SPATIAL_INDEX_CELL_SIZE)}`;
		const group = groups.get(key) ?? [];
		group.push(entity);
		groups.set(key, group);
	}
	return [...groups.entries()]
		.sort(([a], [b]) => {
			const [ax, ay] = a.split(':').map(Number);
			const [bx, by] = b.split(':').map(Number);
			return ax - bx || ay - by;
		})
		.map(([, group]) => group.sort((a, b) => a.x - b.x || a.y - b.y || a.id.localeCompare(b.id)));
}

function mergeGroupsToBudget(groups: WorkspaceEntity[][], budget: number): WorkspaceEntity[][] {
	if (groups.length <= budget) return groups;
	return Array.from({ length: budget }, (_, index) => {
		const start = Math.floor((index * groups.length) / budget);
		const end = Math.floor(((index + 1) * groups.length) / budget);
		return groups.slice(start, end).flat();
	});
}

function clusterSubtitle(members: readonly WorkspaceEntity[]): string {
	const years = members.map((member) => member.year).filter((year): year is number => year !== null);
	const hasUndated = years.length !== members.length;
	if (years.length === 0) return 'Undated group';
	const min = Math.min(...years);
	const max = Math.max(...years);
	const range = min === max ? String(min) : `${min}–${max}`;
	return hasUndated ? `${range} + Undated` : range;
}

function createCluster(members: WorkspaceEntity[], index: number): RenderObject {
	const memberIds = members.map((member) => member.id).sort();
	const x = members.reduce((sum, member) => sum + member.x, 0) / members.length;
	const y = members.reduce((sum, member) => sum + member.y, 0) / members.length;
	const minX = Math.min(...members.map((member) => member.x - member.width / 2));
	const maxX = Math.max(...members.map((member) => member.x + member.width / 2));
	const minY = Math.min(...members.map((member) => member.y - member.height / 2));
	const maxY = Math.max(...members.map((member) => member.y + member.height / 2));
	const years = members.map((member) => member.year);
	const firstYear = years[0];
	const sharedYear = years.every((year) => year === firstYear) ? firstYear : null;
	return {
		id: `synthetic-cluster-${index + 1}-${memberIds[0]}`,
		kind: 'cluster',
		x,
		y,
		width: Math.max(96, maxX - minX),
		height: Math.max(72, maxY - minY),
		title: `${members.length} releases`,
		subtitle: clusterSubtitle(members),
		year: sharedYear,
		artworkIndex: null,
		memberCount: members.length,
		pinned: false,
		memberIds
	};
}

function createClusters(entities: readonly WorkspaceEntity[], budget: number): RenderObject[] {
	if (entities.length === 0) return [];
	if (budget <= 0) throw new Error('At least one cluster object is required to conserve culled entities');
	return mergeGroupsToBudget(groupByGrid(entities), budget).map(createCluster);
}

function uniquePinnedIds(pinnedIds: Iterable<string>): string[] {
	const ids = [...new Set(pinnedIds)].sort();
	if (ids.length > MAX_PINNED_OBJECTS) {
		throw new RangeError(`At most ${MAX_PINNED_OBJECTS} selected/focused/dragged id may be pinned`);
	}
	return ids;
}

export function createRenderPlan(
	workspace: TimelineWorkspace,
	camera: Camera,
	viewport: ScreenViewport,
	pinnedIds: Iterable<string> = []
): RenderPlan {
	const queryBounds = inverseViewportBounds(camera, viewport, 0.5);
	const tier = semanticZoomTier(camera.scale);
	const intersecting = workspace.index.query(queryBounds).map((item) => item.entity);
	const intersectingIds = new Set(intersecting.map((entity) => entity.id));
	const pinned = uniquePinnedIds(pinnedIds)
		.map((id) => workspace.entityById.get(id))
		.filter((entity): entity is WorkspaceEntity => entity !== undefined);
	const pinnedIdSet = new Set(pinned.map((entity) => entity.id));
	const pinnedOutside = pinned.filter((entity) => !intersectingIds.has(entity.id));
	const ordinaryIntersecting = sortByPriority(
		intersecting.filter((entity) => !pinnedIdSet.has(entity.id)),
		queryBounds
	);
	const pinnedObjects = pinned.map((entity) => entityToRenderObject(entity, true));
	const totalDistinctCandidates = ordinaryIntersecting.length + pinned.length;
	let individualEntities: WorkspaceEntity[] = [];
	let clusteredEntities: WorkspaceEntity[] = [];
	let clusters: RenderObject[] = [];

	if (tier !== 'overview' && totalDistinctCandidates <= MAX_RENDERED_WORLD_OBJECTS) {
		individualEntities = ordinaryIntersecting;
	} else {
		const availableAfterPins = MAX_RENDERED_WORLD_OBJECTS - pinnedObjects.length;
		const ordinaryIndividualBudget =
			tier === 'overview'
				? 0
				: Math.max(0, Math.min(MAX_RENDERED_ARTWORK_IMAGES - pinnedObjects.length, availableAfterPins - 1));
		individualEntities = ordinaryIntersecting.slice(0, ordinaryIndividualBudget);
		clusteredEntities = ordinaryIntersecting.slice(ordinaryIndividualBudget);
		const clusterBudget = availableAfterPins - individualEntities.length;
		clusters = createClusters(clusteredEntities, clusterBudget);
	}

	const individualObjects = individualEntities.map((entity) => entityToRenderObject(entity, false));
	const objects = [...pinnedObjects, ...individualObjects, ...clusters];
	const artworkIds =
		tier === 'overview'
			? []
			: [...pinnedObjects, ...individualObjects]
					.filter((object) => object.artworkIndex !== null)
					.slice(0, MAX_RENDERED_ARTWORK_IMAGES)
					.map((object) => object.id);
	const intersectingIndividualIds = new Set(
		[...pinned, ...individualEntities]
			.filter((entity) => intersectingIds.has(entity.id))
			.map((entity) => entity.id)
	);
	const representedIntersectingEntities =
		intersectingIndividualIds.size + clusters.reduce((sum, cluster) => sum + cluster.memberCount, 0);

	return {
		tier,
		queryBounds,
		objects,
		artworkIds,
		counts: {
			intersectingEntities: intersecting.length,
			pinnedOutsideViewport: pinnedOutside.length,
			individualObjects: pinnedObjects.length + individualObjects.length,
			clusterObjects: clusters.length,
			clusteredEntities: clusters.reduce((sum, cluster) => sum + cluster.memberCount, 0),
			worldObjects: objects.length,
			artworkImages: artworkIds.length
		},
		accounting: {
			expectedIntersectingEntities: intersecting.length,
			representedIntersectingEntities,
			complete: representedIntersectingEntities === intersecting.length
		}
	};
}
