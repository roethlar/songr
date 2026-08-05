import {
	CATALOG_RELEASE_EVIDENCE_SOURCE_CONTRACT,
	isCanonicalCatalogEvidenceDate
} from '@shared/timelineCatalogContracts';
import type {
	Rect,
	TimelineAlbumEntity,
	TimelineAlbumLayoutInput,
	TimelineLayout,
	TimelineYearAnchor
} from './types';

export const TIMELINE_ALBUM_WIDTH = 156;
export const TIMELINE_ALBUM_HEIGHT = 132;
export const TIMELINE_YEAR_SPACING = 160;
export const TIMELINE_AXIS_OFFSET = 132;
export const MAX_TIMELINE_CALENDAR_SPAN = 1_800;

const COLLISION_STACK_GAP = 18;
const UNDATED_SECTION_GAP = 176;
const UNDATED_MARKER_SPACING = TIMELINE_ALBUM_WIDTH + 48;
const AXIS_END_MARGIN = 128;

interface ValidatedAlbum extends TimelineAlbumLayoutInput {
	ordinal: number;
	year: number | null;
}

function compareCodePoints(left: string, right: string): number {
	const leftPoints = [...left];
	const rightPoints = [...right];
	const length = Math.min(leftPoints.length, rightPoints.length);
	for (let index = 0; index < length; index += 1) {
		const leftPoint = leftPoints[index].codePointAt(0) ?? 0;
		const rightPoint = rightPoints[index].codePointAt(0) ?? 0;
		if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;
	}
	return leftPoints.length - rightPoints.length;
}

function requireDisplayText(value: string, label: string): void {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new TypeError(`${label} must be non-empty`);
	}
}

function validateAlbum(input: TimelineAlbumLayoutInput): ValidatedAlbum {
	requireDisplayText(input.localId, 'album localId');
	requireDisplayText(input.title, 'album title');
	requireDisplayText(input.artist, 'album artist');
	const ordinal = input.placement.ordinal;
	if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
		throw new RangeError('album ordinal must be a non-negative safe integer');
	}

	if (input.placement.kind === 'calendar') {
		const { year, evidence } = input.placement;
		if (!Number.isSafeInteger(year) || year < 1_000 || year > 9_999) {
			throw new RangeError('calendar year must be between 1000 and 9999');
		}
		if (
			evidence.sourceContract !== CATALOG_RELEASE_EVIDENCE_SOURCE_CONTRACT ||
			evidence.field !== 'original-release-date' ||
			!isCanonicalCatalogEvidenceDate(evidence.date) ||
			Number(evidence.date.slice(0, 4)) !== year
		) {
			throw new TypeError('calendar placement requires matching original-release evidence');
		}
		return { ...input, ordinal, year };
	}

	if (
		input.placement.label !== 'Undated' ||
		(input.placement.reason !== 'no-proven-original-release-date' &&
			input.placement.reason !== 'album-not-resolved')
	) {
		throw new TypeError('undated placement is invalid');
	}
	return { ...input, ordinal, year: null };
}

function compareCalendarAlbums(left: ValidatedAlbum, right: ValidatedAlbum): number {
	return (
		(left.year ?? 0) - (right.year ?? 0) ||
		left.ordinal - right.ordinal ||
		compareCodePoints(left.localId, right.localId)
	);
}

function compareUndatedAlbums(left: ValidatedAlbum, right: ValidatedAlbum): number {
	return left.ordinal - right.ordinal || compareCodePoints(left.localId, right.localId);
}

function entityFor(
	album: ValidatedAlbum,
	x: number,
	y: number
): TimelineAlbumEntity {
	const chronologyLabel = album.year === null ? `Undated · #${album.ordinal + 1}` : String(album.year);
	return Object.freeze({
		id: album.localId,
		kind: 'album' as const,
		anchorX: x,
		anchorY: y,
		x,
		y,
		width: TIMELINE_ALBUM_WIDTH,
		height: TIMELINE_ALBUM_HEIGHT,
		title: album.title,
		artist: album.artist,
		chronologyLabel,
		year: album.year,
		ordinal: album.ordinal,
		...(album.imageKeyHint ? { imageKeyHint: album.imageKeyHint } : {})
	});
}

function takeVerticalLane(lastCenterByLane: number[], x: number): number {
	const minimumCenterGap = TIMELINE_ALBUM_WIDTH + COLLISION_STACK_GAP;
	const reusableLane = lastCenterByLane.findIndex(
		(lastCenterX) => x - lastCenterX >= minimumCenterGap
	);
	if (reusableLane >= 0) {
		lastCenterByLane[reusableLane] = x;
		return reusableLane;
	}
	lastCenterByLane.push(x);
	return lastCenterByLane.length - 1;
}

export function timelineEntityBounds(entity: TimelineAlbumEntity): Rect {
	return {
		x: entity.x - entity.width / 2,
		y: entity.y - entity.height / 2,
		width: entity.width,
		height: entity.height
	};
}

export function timelineContentBounds(entities: readonly TimelineAlbumEntity[]): Rect {
	if (entities.length === 0) return { x: -1, y: -1, width: 2, height: 2 };
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const entity of entities) {
		const bounds = timelineEntityBounds(entity);
		minX = Math.min(minX, bounds.x);
		minY = Math.min(minY, bounds.y);
		maxX = Math.max(maxX, bounds.x + bounds.width);
		maxY = Math.max(maxY, bounds.y + bounds.height);
	}
	return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function layoutTimelineAlbums(
	inputs: readonly TimelineAlbumLayoutInput[]
): TimelineLayout {
	const seenIds = new Set<string>();
	const albums = inputs.map((input) => {
		const album = validateAlbum(input);
		if (seenIds.has(album.localId)) {
			throw new Error(`duplicate Timeline album localId: ${album.localId}`);
		}
		seenIds.add(album.localId);
		return album;
	});
	const calendar = albums.filter((album) => album.year !== null).sort(compareCalendarAlbums);
	const undated = albums.filter((album) => album.year === null).sort(compareUndatedAlbums);
	const entities: TimelineAlbumEntity[] = [];
	const yearAnchors: TimelineYearAnchor[] = [];
	let placedCount = 0;
	let knownRightEdge = Number.NEGATIVE_INFINITY;
	const aboveLaneLastX: number[] = [];
	const belowLaneLastX: number[] = [];

	if (calendar.length > 0) {
		const minYear = calendar[0].year as number;
		const maxYear = calendar.at(-1)?.year as number;
		const calendarRange = maxYear - minYear;
		const yearSpacing =
			calendarRange === 0
				? TIMELINE_YEAR_SPACING
				: Math.min(TIMELINE_YEAR_SPACING, MAX_TIMELINE_CALENDAR_SPAN / calendarRange);
		const byYear = new Map<number, ValidatedAlbum[]>();
		for (const album of calendar) {
			const year = album.year as number;
			const group = byYear.get(year) ?? [];
			group.push(album);
			byYear.set(year, group);
		}

		for (const [year, group] of [...byYear.entries()].sort(([left], [right]) => left - right)) {
			const anchorX = (year - minYear) * yearSpacing;
			yearAnchors.push(Object.freeze({ year, x: anchorX }));
			for (const album of group) {
				const side = placedCount % 2 === 0 ? -1 : 1;
				const lane = takeVerticalLane(
					side < 0 ? aboveLaneLastX : belowLaneLastX,
					anchorX
				);
				const y =
					side *
					(TIMELINE_AXIS_OFFSET + lane * (TIMELINE_ALBUM_HEIGHT + COLLISION_STACK_GAP));
				const entity = entityFor(album, anchorX, y);
				entities.push(entity);
				knownRightEdge = Math.max(
					knownRightEdge,
					anchorX + TIMELINE_ALBUM_WIDTH / 2
				);
				placedCount += 1;
			}
		}
	}

	const undatedStartX =
		undated.length === 0
			? null
			: Number.isFinite(knownRightEdge)
				? knownRightEdge + UNDATED_SECTION_GAP + TIMELINE_ALBUM_WIDTH / 2
				: 0;
	for (let index = 0; index < undated.length; index += 1) {
		const side = placedCount % 2 === 0 ? -1 : 1;
		entities.push(
			entityFor(
				undated[index],
				(undatedStartX ?? 0) + index * UNDATED_MARKER_SPACING,
				side * TIMELINE_AXIS_OFFSET
			)
		);
		placedCount += 1;
	}

	const bounds = Object.freeze(timelineContentBounds(entities));
	const axisStartX = entities.length === 0 ? -160 : bounds.x - AXIS_END_MARGIN;
	const axisEndX =
		entities.length === 0 ? 160 : bounds.x + bounds.width + AXIS_END_MARGIN;
	return Object.freeze({
		entities: Object.freeze(entities),
		bounds,
		axis: Object.freeze({
			startX: axisStartX,
			endX: axisEndX,
			yearAnchors: Object.freeze(yearAnchors),
			undatedStartX
		})
	});
}
