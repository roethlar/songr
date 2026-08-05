import {
	layoutTimelineAlbums,
	timelineContentBounds,
	timelineEntityBounds
} from './layout';
import {
	TIMELINE_SPATIAL_CELL_SIZE,
	UniformGridSpatialIndex,
	type SpatialItem
} from './spatialIndex';
import type {
	Rect,
	Point,
	TimelineAlbumEntity,
	TimelineAlbumLayoutInput,
	TimelineAxis
} from './types';

export interface IndexedTimelineAlbum extends SpatialItem {
	readonly entity: TimelineAlbumEntity;
}

export interface TimelineCanvasModel {
	readonly entities: readonly TimelineAlbumEntity[];
	readonly entityById: ReadonlyMap<string, TimelineAlbumEntity>;
	readonly index: UniformGridSpatialIndex<IndexedTimelineAlbum>;
	readonly bounds: Rect;
	readonly axis: TimelineAxis;
}

export type TimelineManualOffsetMap = ReadonlyMap<string, Readonly<Point>>;

function buildIndex(
	entities: readonly TimelineAlbumEntity[]
): UniformGridSpatialIndex<IndexedTimelineAlbum> {
	const index = new UniformGridSpatialIndex<IndexedTimelineAlbum>(
		TIMELINE_SPATIAL_CELL_SIZE
	);
	for (const entity of entities) {
		index.insert({
			id: entity.id,
			bounds: timelineEntityBounds(entity),
			entity
		});
	}
	return index;
}

function unionBounds(left: Rect, right: Rect): Rect {
	const x = Math.min(left.x, right.x);
	const y = Math.min(left.y, right.y);
	const rightEdge = Math.max(left.x + left.width, right.x + right.width);
	const bottomEdge = Math.max(left.y + left.height, right.y + right.height);
	return { x, y, width: rightEdge - x, height: bottomEdge - y };
}

function requireFiniteOffset(value: number, label: string): number {
	if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
	return value;
}

/**
 * Project tab-memory offsets over a canonical model. Chronology, anchors, and
 * axis evidence remain canonical; only effective display coordinates, bounds,
 * and the spatial index change.
 */
export function projectTimelineCanvasModel(
	canonical: TimelineCanvasModel,
	offsets: TimelineManualOffsetMap
): TimelineCanvasModel {
	for (const entity of canonical.entities) {
		if (entity.x !== entity.anchorX || entity.y !== entity.anchorY) {
			throw new TypeError('Timeline projection requires a canonical model');
		}
	}
	for (const [albumLocalId, offset] of offsets) {
		if (!canonical.entityById.has(albumLocalId)) {
			throw new RangeError(`manual offset targets unknown Timeline album: ${albumLocalId}`);
		}
		requireFiniteOffset(offset.x, 'manual offset x');
		requireFiniteOffset(offset.y, 'manual offset y');
	}
	if (offsets.size === 0) return canonical;

	const entities = Object.freeze(canonical.entities.map((entity) => {
		const offset = offsets.get(entity.id);
		if (!offset || (offset.x === 0 && offset.y === 0)) return entity;
		return Object.freeze({
			...entity,
			x: requireFiniteOffset(entity.anchorX + offset.x, 'projected album x'),
			y: requireFiniteOffset(entity.anchorY + offset.y, 'projected album y')
		});
	}));
	const entityById = new Map(entities.map((entity) => [entity.id, entity]));
	const projectedBounds = timelineContentBounds(entities);
	return Object.freeze({
		entities,
		entityById,
		index: buildIndex(entities),
		bounds: Object.freeze(unionBounds(canonical.bounds, projectedBounds)),
		axis: canonical.axis
	});
}

export function createTimelineCanvasModel(
	albums: readonly TimelineAlbumLayoutInput[]
): TimelineCanvasModel {
	const layout = layoutTimelineAlbums(albums);
	const entityById = new Map(layout.entities.map((entity) => [entity.id, entity]));
	return Object.freeze({
		entities: layout.entities,
		entityById,
		index: buildIndex(layout.entities),
		bounds: layout.bounds,
		axis: layout.axis
	});
}
