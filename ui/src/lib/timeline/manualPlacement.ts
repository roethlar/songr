import { assertRect } from './geometry';
import type { Rect, ScreenViewport, TimelineAlbumEntity } from './types';

export const TIMELINE_FLOAT_OFFSET_X = 46;
export const TIMELINE_FLOAT_OFFSET_Y = 42;
export const TIMELINE_MANUAL_NEIGHBOR_GAP = 24;
export const TIMELINE_MANUAL_SNAP_SCREEN_PX = 18;

export interface TimelineManualOffset {
	readonly dx: number;
	readonly dy: number;
}

export type TimelineManualPlacementCommand =
	| { readonly type: 'place'; readonly offset: TimelineManualOffset }
	| { readonly type: 'float' }
	| { readonly type: 'return' }
	| { readonly type: 'move'; readonly direction: 'before' | 'after' };

export interface TimelineManualPlacementContext {
	readonly albumLocalId: string;
	readonly albums: readonly TimelineAlbumEntity[];
	readonly canonicalBounds: Rect;
	readonly viewport: ScreenViewport;
	readonly scale: number;
}

function requireFinite(value: number, label: string): number {
	if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
	return value;
}

function requirePositive(value: number, label: string): number {
	requireFinite(value, label);
	if (value <= 0) throw new RangeError(`${label} must be positive`);
	return value;
}

function requireOffset(offset: TimelineManualOffset, label: string): TimelineManualOffset {
	if (offset === null || typeof offset !== 'object' || Array.isArray(offset)) {
		throw new TypeError(`${label} must be an offset`);
	}
	return {
		dx: requireFinite(offset.dx, `${label} dx`),
		dy: requireFinite(offset.dy, `${label} dy`)
	};
}

function validateAlbum(entity: TimelineAlbumEntity): void {
	if (typeof entity.id !== 'string' || entity.id.length === 0) {
		throw new TypeError('Timeline album id must be non-empty');
	}
	requireFinite(entity.anchorX, `Timeline album ${entity.id} anchorX`);
	requireFinite(entity.anchorY, `Timeline album ${entity.id} anchorY`);
	requireFinite(entity.x, `Timeline album ${entity.id} x`);
	requireFinite(entity.y, `Timeline album ${entity.id} y`);
	requirePositive(entity.width, `Timeline album ${entity.id} width`);
	requirePositive(entity.height, `Timeline album ${entity.id} height`);
	if (!Number.isSafeInteger(entity.ordinal) || entity.ordinal < 0) {
		throw new RangeError(`Timeline album ${entity.id} ordinal must be a non-negative safe integer`);
	}
	if (
		entity.year !== null &&
		(!Number.isSafeInteger(entity.year) || entity.year < 1_000 || entity.year > 9_999)
	) {
		throw new RangeError(`Timeline album ${entity.id} year is invalid`);
	}
}

function canonicalAlbumBounds(entity: TimelineAlbumEntity): Rect {
	return {
		x: entity.anchorX - entity.width / 2,
		y: entity.anchorY - entity.height / 2,
		width: entity.width,
		height: entity.height
	};
}

function contains(outer: Rect, inner: Rect): boolean {
	return (
		inner.x >= outer.x &&
		inner.y >= outer.y &&
		inner.x + inner.width <= outer.x + outer.width &&
		inner.y + inner.height <= outer.y + outer.height
	);
}

interface ValidatedPlacementContext {
	readonly album: TimelineAlbumEntity;
	readonly orderedAlbums: readonly TimelineAlbumEntity[];
	readonly placementBounds: Rect;
	readonly scale: number;
}

function compareManualPlacementChronology(
	left: TimelineAlbumEntity,
	right: TimelineAlbumEntity
): number {
	if (left.year === null && right.year !== null) return 1;
	if (left.year !== null && right.year === null) return -1;
	return (
		(left.year ?? 0) - (right.year ?? 0) ||
		left.ordinal - right.ordinal ||
		(left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
	);
}

/**
 * The movable workspace is the canonical content rectangle plus one complete
 * viewport margin on every side, converted to world units at the current scale.
 */
export function timelineManualPlacementBounds(
	canonicalBounds: Rect,
	viewport: ScreenViewport,
	scale: number
): Rect {
	assertRect(canonicalBounds, 'Timeline canonical content');
	assertRect(viewport, 'Timeline viewport');
	if (viewport.width <= 0 || viewport.height <= 0) {
		throw new RangeError('Timeline viewport dimensions must be positive');
	}
	const validatedScale = requirePositive(scale, 'Timeline placement scale');
	const marginX = requireFinite(viewport.width / validatedScale, 'Timeline horizontal margin');
	const marginY = requireFinite(viewport.height / validatedScale, 'Timeline vertical margin');
	const right = requireFinite(
		canonicalBounds.x + canonicalBounds.width + marginX,
		'Timeline placement right edge'
	);
	const bottom = requireFinite(
		canonicalBounds.y + canonicalBounds.height + marginY,
		'Timeline placement bottom edge'
	);
	const x = requireFinite(canonicalBounds.x - marginX, 'Timeline placement x');
	const y = requireFinite(canonicalBounds.y - marginY, 'Timeline placement y');
	const bounds = {
		x,
		y,
		width: requireFinite(right - x, 'Timeline placement width'),
		height: requireFinite(bottom - y, 'Timeline placement height')
	};
	assertRect(bounds, 'Timeline placement');
	return Object.freeze(bounds);
}

function validateContext(context: TimelineManualPlacementContext): ValidatedPlacementContext {
	if (typeof context.albumLocalId !== 'string' || context.albumLocalId.length === 0) {
		throw new TypeError('Timeline placement albumLocalId must be non-empty');
	}
	assertRect(context.canonicalBounds, 'Timeline canonical content');
	const seen = new Set<string>();
	let album: TimelineAlbumEntity | null = null;
	for (const entity of context.albums) {
		validateAlbum(entity);
		if (seen.has(entity.id)) throw new Error(`duplicate Timeline album id: ${entity.id}`);
		seen.add(entity.id);
		if (!contains(context.canonicalBounds, canonicalAlbumBounds(entity))) {
			throw new RangeError(`Timeline album ${entity.id} lies outside canonical content bounds`);
		}
		if (entity.id === context.albumLocalId) album = entity;
	}
	if (!album) throw new RangeError('Timeline placement album is not in the canonical working set');
	return {
		album,
		orderedAlbums: Object.freeze([...context.albums].sort(compareManualPlacementChronology)),
		placementBounds: timelineManualPlacementBounds(
			context.canonicalBounds,
			context.viewport,
			context.scale
		),
		scale: context.scale
	};
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}

function clampOffset(
	entity: TimelineAlbumEntity,
	offset: TimelineManualOffset,
	placementBounds: Rect
): TimelineManualOffset {
	const minimumX = placementBounds.x + entity.width / 2;
	const maximumX = placementBounds.x + placementBounds.width - entity.width / 2;
	const minimumY = placementBounds.y + entity.height / 2;
	const maximumY = placementBounds.y + placementBounds.height - entity.height / 2;
	if (minimumX > maximumX || minimumY > maximumY) {
		throw new RangeError('Timeline placement bounds cannot contain the album marker');
	}
	const targetX = requireFinite(entity.anchorX + offset.dx, 'Timeline placement target x');
	const targetY = requireFinite(entity.anchorY + offset.dy, 'Timeline placement target y');
	const clampedX = clamp(targetX, minimumX, maximumX);
	const clampedY = clamp(targetY, minimumY, maximumY);
	return {
		dx: clampedX === targetX ? offset.dx : clampedX - entity.anchorX,
		dy: clampedY === targetY ? offset.dy : clampedY - entity.anchorY
	};
}

function normalizeOffset(
	entity: TimelineAlbumEntity,
	offset: TimelineManualOffset,
	placementBounds: Rect,
	scale: number
): TimelineManualOffset | null {
	const clamped = clampOffset(entity, offset, placementBounds);
	if (Math.hypot(clamped.dx, clamped.dy) * scale <= TIMELINE_MANUAL_SNAP_SCREEN_PX) {
		return null;
	}
	return Object.freeze({
		dx: Object.is(clamped.dx, -0) ? 0 : clamped.dx,
		dy: Object.is(clamped.dy, -0) ? 0 : clamped.dy
	});
}

function moveBesideChronologicalNeighbor(
	current: TimelineManualOffset | null,
	direction: 'before' | 'after',
	context: ValidatedPlacementContext
): TimelineManualOffset | null {
	const index = context.orderedAlbums.findIndex((entity) => entity.id === context.album.id);
	const neighbor = context.orderedAlbums[index + (direction === 'before' ? -1 : 1)];
	if (!neighbor) {
		return current
			? normalizeOffset(context.album, current, context.placementBounds, context.scale)
			: null;
	}
	const targetX =
		direction === 'before'
			? neighbor.anchorX - neighbor.width / 2 - TIMELINE_MANUAL_NEIGHBOR_GAP - context.album.width / 2
			: neighbor.anchorX + neighbor.width / 2 + TIMELINE_MANUAL_NEIGHBOR_GAP + context.album.width / 2;
	return normalizeOffset(
		context.album,
		{
			dx: targetX - context.album.anchorX,
			dy: neighbor.anchorY - context.album.anchorY
		},
		context.placementBounds,
		context.scale
	);
}

/**
 * Resolve one settled, session-only visual placement. The returned value is an
 * offset from immutable chronology; null is the canonical Timeline position.
 */
export function reduceTimelineManualPlacement(
	currentValue: TimelineManualOffset | null,
	command: TimelineManualPlacementCommand,
	placementContext: TimelineManualPlacementContext
): TimelineManualOffset | null {
	const current = currentValue === null ? null : requireOffset(currentValue, 'Timeline current offset');
	const context = validateContext(placementContext);
	if (command === null || typeof command !== 'object' || Array.isArray(command)) {
		throw new TypeError('Timeline placement command is invalid');
	}
	switch (command.type) {
		case 'place':
			return normalizeOffset(
				context.album,
				requireOffset(command.offset, 'Timeline placement offset'),
				context.placementBounds,
				context.scale
			);
		case 'float':
			return normalizeOffset(
				context.album,
				{
					dx: TIMELINE_FLOAT_OFFSET_X,
					dy:
						context.album.anchorY <= 0
							? -TIMELINE_FLOAT_OFFSET_Y
							: TIMELINE_FLOAT_OFFSET_Y
				},
				context.placementBounds,
				context.scale
			);
		case 'return':
			return null;
		case 'move':
			if (command.direction !== 'before' && command.direction !== 'after') {
				throw new TypeError('Timeline move direction is invalid');
			}
			return moveBesideChronologicalNeighbor(current, command.direction, context);
		default:
			throw new TypeError('Timeline placement command is unknown');
	}
}
