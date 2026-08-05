import type {
	CatalogResolutionStatus,
	CatalogTimelinePlacement
} from '@shared/timelineCatalogContracts';
import type { TimelineCanvasModel } from './canvasModel';
import { createCameraQueryWindow } from './geometry';
import {
	TIMELINE_ALBUM_HEIGHT,
	TIMELINE_ALBUM_WIDTH,
	layoutTimelineAlbums
} from './layout';
import {
	MAX_TIMELINE_ARTWORK_IMAGES,
	MAX_TIMELINE_WORLD_OBJECTS,
	compareTimelineChronology
} from './renderPlan';
import type {
	Camera,
	Point,
	Rect,
	ScreenViewport,
	SemanticZoomTier
} from './types';

export const MAX_TIMELINE_BRANCHES = 3;
export const MAX_TIMELINE_BRANCH_ALBUMS = 8;
export const MAX_TIMELINE_BRANCH_DEPTH = 2;

export const TIMELINE_BRANCH_HEADER_WIDTH = 264;
export const TIMELINE_BRANCH_HEADER_HEIGHT = 132;
export const TIMELINE_BRANCH_LANE_GAP = 252;

const TIMELINE_BRANCH_LANE_CLEARANCE = 144;
const TIMELINE_BRANCH_ITEM_GAP = 36;
const TIMELINE_BRANCH_HEADER_ALBUM_GAP = 48;
const TIMELINE_BRANCH_CONTROL_WIDTH = 64;
const TIMELINE_BRANCH_CONTROL_HEIGHT = 30;
const TIMELINE_BRANCH_CONTROL_GAP = 8;
const TIMELINE_BRANCH_CONTROL_INSET = 12;
const TIMELINE_BRANCH_CONNECTOR_WIDTH = 1;

export type TimelineBranchDepth = 1 | 2;
export type TimelineBranchPhase = 'loading' | 'ready' | 'error';

export interface TimelineBranchSourceInput {
	readonly kind: 'base-album' | 'branch-album';
	readonly entityId: string;
	readonly albumLocalId: string;
	readonly parentBranchId: string | null;
	readonly depth: 0 | 1 | 2;
}

export interface TimelineBranchArtistInput {
	readonly localId: string;
	readonly exactName: string;
}

export interface TimelineBranchProvenanceInput {
	readonly provider: 'artist-search';
	readonly providerLabel: 'Artist search';
	readonly attachmentLabel: 'User-attached branch';
}

export interface TimelineBranchAlbumInput {
	/** Composite render identity. Stable catalog identity remains separate below. */
	readonly entityId: string;
	readonly branchId: string;
	readonly albumLocalId: string;
	readonly artistLocalId: string;
	readonly title: string;
	readonly artist: string;
	readonly placement: CatalogTimelinePlacement;
	readonly resolutionStatus: CatalogResolutionStatus;
	readonly imageKeyHint?: string;
}

/**
 * Structural publication boundary for the tab-memory branch store. It carries
 * only keyless catalog descriptors; generation/session authority stays outside
 * this pure layout layer.
 */
export interface TimelineBranchLayoutInput {
	readonly branchId: string;
	readonly depth: TimelineBranchDepth;
	readonly source: TimelineBranchSourceInput;
	readonly artist: TimelineBranchArtistInput;
	readonly phase: TimelineBranchPhase;
	readonly error: string | null;
	readonly provenance: TimelineBranchProvenanceInput;
	readonly albums: readonly TimelineBranchAlbumInput[];
	readonly catalogTotal: number;
	readonly truncated: boolean;
}

export interface TimelineBranchAlbumEntity {
	readonly id: string;
	readonly kind: 'branch-album';
	readonly branchId: string;
	readonly depth: TimelineBranchDepth;
	readonly sourceEntityId: string;
	readonly albumLocalId: string;
	readonly artistLocalId: string;
	readonly anchorX: number;
	readonly anchorY: number;
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
	readonly title: string;
	readonly artist: string;
	readonly chronologyLabel: string;
	readonly year: number | null;
	readonly ordinal: number;
	readonly resolutionStatus: CatalogResolutionStatus;
	readonly imageKeyHint?: string;
}

export type TimelineBranchControlAction = 'retry' | 'close';

export interface TimelineBranchControlEntity {
	readonly id: string;
	readonly kind: 'branch-control';
	readonly branchId: string;
	readonly action: TimelineBranchControlAction;
	readonly label: 'Retry' | 'Close';
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

export interface TimelineBranchHeaderEntity {
	readonly id: string;
	readonly kind: 'branch-header';
	readonly branchId: string;
	readonly depth: TimelineBranchDepth;
	readonly sourceEntityId: string;
	readonly artistLocalId: string;
	readonly artistName: string;
	readonly providerLabel: 'Artist search';
	readonly attachmentLabel: 'User-attached branch';
	readonly phase: TimelineBranchPhase;
	readonly error: string | null;
	readonly displayedAlbumCount: number;
	readonly catalogTotal: number;
	readonly truncated: boolean;
	readonly maximumAlbumCount: typeof MAX_TIMELINE_BRANCH_ALBUMS;
	readonly controlCount: number;
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

export interface TimelineBranchConnector {
	readonly id: string;
	readonly kind: 'branch-connector';
	readonly branchId: string;
	readonly sourceEntityId: string;
	readonly targetHeaderId: string;
	readonly start: Readonly<Point>;
	readonly end: Readonly<Point>;
	readonly strokeWidth: typeof TIMELINE_BRANCH_CONNECTOR_WIDTH;
	readonly interactive: false;
}

export interface TimelineBranchSourceGeometry {
	readonly entityId: string;
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

export interface TimelineBranchLayoutGroup {
	readonly branchId: string;
	readonly depth: TimelineBranchDepth;
	readonly sourceEntityId: string;
	readonly source: TimelineBranchSourceGeometry;
	readonly side: -1 | 1;
	readonly laneIndex: number;
	readonly phase: TimelineBranchPhase;
	readonly error: string | null;
	readonly header: TimelineBranchHeaderEntity;
	readonly controls: readonly TimelineBranchControlEntity[];
	readonly controlCount: number;
	readonly entities: readonly TimelineBranchAlbumEntity[];
	readonly connector: TimelineBranchConnector;
}

export interface TimelineBranchLayout {
	readonly groups: readonly TimelineBranchLayoutGroup[];
	readonly entities: readonly TimelineBranchAlbumEntity[];
	readonly headers: readonly TimelineBranchHeaderEntity[];
	readonly controls: readonly TimelineBranchControlEntity[];
	readonly connectors: readonly TimelineBranchConnector[];
	readonly entityById: ReadonlyMap<string, TimelineBranchAlbumEntity>;
	readonly groupById: ReadonlyMap<string, TimelineBranchLayoutGroup>;
	readonly branchBounds: Rect | null;
	/** Union of the canonical base model and every branch/header/connector bound. */
	readonly bounds: Rect;
}

export interface TimelineBranchAlbumRenderObject {
	readonly id: string;
	readonly kind: 'branch-album';
	readonly entity: TimelineBranchAlbumEntity;
	readonly pinned: boolean;
}

export interface TimelineBranchHeaderRenderObject {
	readonly id: string;
	readonly kind: 'branch-header';
	readonly entity: TimelineBranchHeaderEntity;
}

export interface TimelineBranchControlRenderObject {
	readonly id: string;
	readonly kind: 'branch-control';
	readonly entity: TimelineBranchControlEntity;
}

export type TimelineBranchRenderObject =
	| TimelineBranchAlbumRenderObject
	| TimelineBranchHeaderRenderObject
	| TimelineBranchControlRenderObject;

export interface TimelineBranchRenderPlanOptions {
	readonly pinnedId?: string | null;
	readonly previousTier?: SemanticZoomTier;
	/** Already-mounted objects such as the attached detail slab. */
	readonly reservedWorldObjects?: number;
	/** Already-mounted artwork such as the attached detail slab artwork. */
	readonly reservedArtworkImages?: number;
}

export interface TimelineBranchRenderPlan {
	readonly tier: SemanticZoomTier;
	readonly queryBounds: Rect;
	readonly objects: readonly TimelineBranchRenderObject[];
	readonly albums: readonly TimelineBranchAlbumRenderObject[];
	readonly headers: readonly TimelineBranchHeaderRenderObject[];
	readonly controls: readonly TimelineBranchControlRenderObject[];
	readonly connectors: readonly TimelineBranchConnector[];
	readonly artworkIds: readonly string[];
	readonly counts: {
		readonly intersectingAlbums: number;
		readonly pinnedOutsideViewport: number;
		readonly albumObjects: number;
		readonly headerObjects: number;
		readonly controlObjects: number;
		readonly worldObjects: number;
		readonly artworkCandidates: number;
		readonly artworkImages: number;
		readonly connectors: number;
	};
	readonly accounting: {
		readonly expectedIntersectingAlbums: number;
		readonly representedIntersectingAlbums: number;
		readonly complete: boolean;
	};
	readonly reservations: {
		readonly priorWorldObjects: number;
		readonly branchWorldObjects: number;
		readonly sharedWorldObjects: number;
		readonly remainingWorldObjects: number;
		readonly priorArtworkImages: number;
		readonly branchArtworkImages: number;
		readonly sharedArtworkImages: number;
		readonly remainingArtworkImages: number;
	};
}

function compareIds(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function requireText(value: string, label: string): void {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new TypeError(`${label} must be non-empty`);
	}
}

function requireCount(value: number, label: string): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new RangeError(`${label} must be a non-negative safe integer`);
	}
}

function requireResolutionStatus(status: CatalogResolutionStatus): void {
	if (!['unresolved', 'resolved', 'ambiguous', 'missing'].includes(status)) {
		throw new TypeError('branch album resolution status is invalid');
	}
}

export function createTimelineBranchAlbumEntityId(
	branchId: string,
	albumLocalId: string
): string {
	requireText(branchId, 'branch id');
	requireText(albumLocalId, 'branch album local id');
	return `${branchId}:${albumLocalId}`;
}

function branchHeaderId(branchId: string): string {
	return `timeline-branch-header:${branchId}`;
}

function branchControlId(branchId: string, action: TimelineBranchControlAction): string {
	return `timeline-branch-control:${branchId}:${action}`;
}

function branchConnectorId(branchId: string): string {
	return `timeline-branch-connector:${branchId}`;
}

function centeredRect(
	x: number,
	y: number,
	width: number,
	height: number
): Rect {
	return { x: x - width / 2, y: y - height / 2, width, height };
}

export function timelineBranchEntityBounds(
	entity: Pick<TimelineBranchAlbumEntity, 'x' | 'y' | 'width' | 'height'>
): Rect {
	return centeredRect(entity.x, entity.y, entity.width, entity.height);
}

function unionBounds(left: Rect, right: Rect): Rect {
	const x = Math.min(left.x, right.x);
	const y = Math.min(left.y, right.y);
	const rightEdge = Math.max(left.x + left.width, right.x + right.width);
	const bottomEdge = Math.max(left.y + left.height, right.y + right.height);
	return { x, y, width: rightEdge - x, height: bottomEdge - y };
}

function connectorBounds(connector: TimelineBranchConnector): Rect {
	const halfStroke = connector.strokeWidth / 2;
	const x = Math.min(connector.start.x, connector.end.x) - halfStroke;
	const y = Math.min(connector.start.y, connector.end.y) - halfStroke;
	return {
		x,
		y,
		width: Math.max(connector.strokeWidth, Math.abs(connector.end.x - connector.start.x) + connector.strokeWidth),
		height: Math.max(connector.strokeWidth, Math.abs(connector.end.y - connector.start.y) + connector.strokeWidth)
	};
}

function compareBranches(
	left: TimelineBranchLayoutInput,
	right: TimelineBranchLayoutInput
): number {
	return left.depth - right.depth || compareIds(left.branchId, right.branchId);
}

function controlActionsFor(phase: TimelineBranchPhase): readonly TimelineBranchControlAction[] {
	return phase === 'error' ? ['retry', 'close'] : ['close'];
}

function controlsFor(
	branchId: string,
	phase: TimelineBranchPhase,
	headerX: number,
	headerY: number
): readonly TimelineBranchControlEntity[] {
	const actions = controlActionsFor(phase);
	const rightEdge = headerX + TIMELINE_BRANCH_HEADER_WIDTH / 2 - TIMELINE_BRANCH_CONTROL_INSET;
	const totalWidth =
		actions.length * TIMELINE_BRANCH_CONTROL_WIDTH +
		(actions.length - 1) * TIMELINE_BRANCH_CONTROL_GAP;
	const startX = rightEdge - totalWidth;
	const y =
		headerY +
		TIMELINE_BRANCH_HEADER_HEIGHT / 2 -
		TIMELINE_BRANCH_CONTROL_INSET -
		TIMELINE_BRANCH_CONTROL_HEIGHT / 2;
	return Object.freeze(actions.map((action, index) => Object.freeze({
		id: branchControlId(branchId, action),
		kind: 'branch-control' as const,
		branchId,
		action,
		label: action === 'retry' ? 'Retry' as const : 'Close' as const,
		x:
			startX +
			TIMELINE_BRANCH_CONTROL_WIDTH / 2 +
			index * (TIMELINE_BRANCH_CONTROL_WIDTH + TIMELINE_BRANCH_CONTROL_GAP),
		y,
		width: TIMELINE_BRANCH_CONTROL_WIDTH,
		height: TIMELINE_BRANCH_CONTROL_HEIGHT
	})));
}

function validateBranchInputs(
	baseModel: TimelineCanvasModel,
	branches: readonly TimelineBranchLayoutInput[]
): readonly TimelineBranchLayoutInput[] {
	if (branches.length > MAX_TIMELINE_BRANCHES) {
		throw new RangeError(`Timeline supports at most ${MAX_TIMELINE_BRANCHES} open branches`);
	}
	const branchById = new Map<string, TimelineBranchLayoutInput>();
	const entityIds = new Set(baseModel.entities.map((entity) => entity.id));
	for (const branch of branches) {
		requireText(branch.branchId, 'branch id');
		if (branchById.has(branch.branchId)) {
			throw new Error(`duplicate Timeline branch id: ${branch.branchId}`);
		}
		if (branch.depth !== 1 && branch.depth !== MAX_TIMELINE_BRANCH_DEPTH) {
			throw new RangeError(`Timeline branch depth is invalid: ${branch.depth}`);
		}
		requireText(branch.source.entityId, 'branch source entity id');
		requireText(branch.source.albumLocalId, 'branch source album local id');
		requireText(branch.artist.localId, 'branch artist local id');
		requireText(branch.artist.exactName, 'branch artist name');
		if (
			branch.provenance.provider !== 'artist-search' ||
			branch.provenance.providerLabel !== 'Artist search' ||
			branch.provenance.attachmentLabel !== 'User-attached branch'
		) {
			throw new TypeError('Timeline branch provenance is unsupported');
		}
		if (!['loading', 'ready', 'error'].includes(branch.phase)) {
			throw new TypeError('Timeline branch phase is invalid');
		}
		if (branch.phase === 'error') {
			requireText(branch.error ?? '', 'branch error');
		} else if (branch.error !== null) {
			throw new TypeError('only an error branch may carry an error message');
		}
		if (branch.phase !== 'ready' && branch.albums.length !== 0) {
			throw new TypeError('only a ready branch may publish album entities');
		}
		if (branch.albums.length > MAX_TIMELINE_BRANCH_ALBUMS) {
			throw new RangeError(
				`Timeline branch supports at most ${MAX_TIMELINE_BRANCH_ALBUMS} albums`
			);
		}
		requireCount(branch.catalogTotal, 'branch catalog total');
		if (branch.catalogTotal < branch.albums.length) {
			throw new RangeError('branch catalog total cannot be smaller than its published albums');
		}

		const albumIds = new Set<string>();
		for (const album of branch.albums) {
			requireText(album.entityId, 'branch album entity id');
			requireText(album.albumLocalId, 'branch album local id');
			requireText(album.artistLocalId, 'branch album artist local id');
			requireText(album.title, 'branch album title');
			requireText(album.artist, 'branch album artist');
			if (album.branchId !== branch.branchId) {
				throw new TypeError('branch album branch id does not match its owner');
			}
			if (album.artistLocalId !== branch.artist.localId) {
				throw new TypeError('branch album artist id does not match its owner');
			}
			if (
				album.entityId !==
				createTimelineBranchAlbumEntityId(branch.branchId, album.albumLocalId)
			) {
				throw new TypeError('branch album entity id is not the canonical composite id');
			}
			if (albumIds.has(album.albumLocalId) || entityIds.has(album.entityId)) {
				throw new Error(`duplicate Timeline branch album identity: ${album.entityId}`);
			}
			requireResolutionStatus(album.resolutionStatus);
			albumIds.add(album.albumLocalId);
			entityIds.add(album.entityId);
		}
		branchById.set(branch.branchId, branch);
	}

	for (const branch of branches) {
		if (branch.source.kind === 'base-album') {
			const source = baseModel.entityById.get(branch.source.entityId);
			if (
				branch.depth !== 1 ||
				branch.source.depth !== 0 ||
				branch.source.parentBranchId !== null ||
				!source ||
				source.id !== branch.source.albumLocalId
			) {
				throw new TypeError('depth-one branch has an invalid base-album source');
			}
			continue;
		}

		const parentId = branch.source.parentBranchId;
		const parent = parentId ? branchById.get(parentId) : undefined;
		if (
			branch.depth !== 2 ||
			branch.source.depth !== 1 ||
			!parent ||
			parent.depth !== 1 ||
			!parent.albums.some((album) =>
				album.entityId === branch.source.entityId &&
				album.albumLocalId === branch.source.albumLocalId
			)
		) {
			throw new TypeError('depth-two branch has an invalid branch-album source');
		}
	}

	return Object.freeze([...branches].sort(compareBranches));
}

function sourceGeometry(
	entityId: string,
	baseModel: TimelineCanvasModel,
	branchEntities: ReadonlyMap<string, TimelineBranchAlbumEntity>
): TimelineBranchSourceGeometry {
	const base = baseModel.entityById.get(entityId);
	if (base) {
		return Object.freeze({
			entityId: base.id,
			x: base.x,
			y: base.y,
			width: base.width,
			height: base.height
		});
	}
	const branch = branchEntities.get(entityId);
	if (!branch) throw new Error(`Timeline branch source was not laid out: ${entityId}`);
	return Object.freeze({
		entityId: branch.id,
		x: branch.x,
		y: branch.y,
		width: branch.width,
		height: branch.height
	});
}

function sourceSide(
	branch: TimelineBranchLayoutInput,
	source: TimelineBranchSourceGeometry,
	groups: ReadonlyMap<string, TimelineBranchLayoutGroup>
): -1 | 1 {
	if (branch.source.kind === 'branch-album') {
		const parent = branch.source.parentBranchId
			? groups.get(branch.source.parentBranchId)
			: undefined;
		if (!parent) throw new Error('Timeline branch parent was not laid out');
		return parent.side;
	}
	return source.y <= 0 ? -1 : 1;
}

function laneCenterY(
	baseBounds: Rect,
	side: -1 | 1,
	laneIndex: number
): number {
	const halfHeight = TIMELINE_ALBUM_HEIGHT / 2;
	return side < 0
		? baseBounds.y - TIMELINE_BRANCH_LANE_CLEARANCE - halfHeight - laneIndex * TIMELINE_BRANCH_LANE_GAP
		: baseBounds.y + baseBounds.height + TIMELINE_BRANCH_LANE_CLEARANCE + halfHeight + laneIndex * TIMELINE_BRANCH_LANE_GAP;
}

function connectorFor(
	branchId: string,
	source: TimelineBranchSourceGeometry,
	header: TimelineBranchHeaderEntity
): TimelineBranchConnector {
	return Object.freeze({
		id: branchConnectorId(branchId),
		kind: 'branch-connector' as const,
		branchId,
		sourceEntityId: source.entityId,
		targetHeaderId: header.id,
		start: Object.freeze({ x: source.x, y: source.y }),
		end: Object.freeze({ x: header.x, y: header.y }),
		strokeWidth: TIMELINE_BRANCH_CONNECTOR_WIDTH,
		interactive: false as const
	});
}

export function createTimelineBranchLayout(
	baseModel: TimelineCanvasModel,
	branches: readonly TimelineBranchLayoutInput[]
): TimelineBranchLayout {
	const sorted = validateBranchInputs(baseModel, branches);
	const groupById = new Map<string, TimelineBranchLayoutGroup>();
	const entityById = new Map<string, TimelineBranchAlbumEntity>();
	const nextLaneBySide = new Map<-1 | 1, number>([[-1, 0], [1, 0]]);
	const groups: TimelineBranchLayoutGroup[] = [];
	const headers: TimelineBranchHeaderEntity[] = [];
	const controls: TimelineBranchControlEntity[] = [];
	const entities: TimelineBranchAlbumEntity[] = [];
	const connectors: TimelineBranchConnector[] = [];
	let branchBounds: Rect | null = null;

	for (const branch of sorted) {
		const source = sourceGeometry(branch.source.entityId, baseModel, entityById);
		const side = sourceSide(branch, source, groupById);
		const laneIndex = nextLaneBySide.get(side) ?? 0;
		nextLaneBySide.set(side, laneIndex + 1);
		const y = laneCenterY(baseModel.bounds, side, laneIndex);
		const canonical = [...layoutTimelineAlbums(branch.albums.map((album) => ({
			localId: album.albumLocalId,
			title: album.title,
			artist: album.artist,
			placement: album.placement,
			...(album.imageKeyHint ? { imageKeyHint: album.imageKeyHint } : {})
		}))).entities].sort(compareTimelineChronology);
		const albumsByLocalId = new Map(branch.albums.map((album) => [album.albumLocalId, album]));
		const albumWidth =
			canonical.length * TIMELINE_ALBUM_WIDTH +
			Math.max(0, canonical.length - 1) * TIMELINE_BRANCH_ITEM_GAP;
		const headerAlbumGap = canonical.length > 0 ? TIMELINE_BRANCH_HEADER_ALBUM_GAP : 0;
		const laneWidth = TIMELINE_BRANCH_HEADER_WIDTH + headerAlbumGap + albumWidth;
		const laneStartX = source.x - laneWidth / 2;
		const headerX = laneStartX + TIMELINE_BRANCH_HEADER_WIDTH / 2;
		const branchControls = controlsFor(branch.branchId, branch.phase, headerX, y);
		const header = Object.freeze({
			id: branchHeaderId(branch.branchId),
			kind: 'branch-header' as const,
			branchId: branch.branchId,
			depth: branch.depth,
			sourceEntityId: source.entityId,
			artistLocalId: branch.artist.localId,
			artistName: branch.artist.exactName,
			providerLabel: branch.provenance.providerLabel,
			attachmentLabel: branch.provenance.attachmentLabel,
			phase: branch.phase,
			error: branch.error,
			displayedAlbumCount: canonical.length,
			catalogTotal: branch.catalogTotal,
			truncated: branch.truncated,
			maximumAlbumCount: MAX_TIMELINE_BRANCH_ALBUMS,
			controlCount: branchControls.length,
			x: headerX,
			y,
			width: TIMELINE_BRANCH_HEADER_WIDTH,
			height: TIMELINE_BRANCH_HEADER_HEIGHT
		} satisfies TimelineBranchHeaderEntity);
		const branchEntities = Object.freeze(canonical.map((album, index) => {
			const input = albumsByLocalId.get(album.id);
			if (!input) throw new Error(`Timeline branch album input disappeared: ${album.id}`);
			const x =
				laneStartX +
				TIMELINE_BRANCH_HEADER_WIDTH +
				headerAlbumGap +
				TIMELINE_ALBUM_WIDTH / 2 +
				index * (TIMELINE_ALBUM_WIDTH + TIMELINE_BRANCH_ITEM_GAP);
			return Object.freeze({
				id: input.entityId,
				kind: 'branch-album' as const,
				branchId: branch.branchId,
				depth: branch.depth,
				sourceEntityId: source.entityId,
				albumLocalId: input.albumLocalId,
				artistLocalId: input.artistLocalId,
				anchorX: x,
				anchorY: y,
				x,
				y,
				width: TIMELINE_ALBUM_WIDTH,
				height: TIMELINE_ALBUM_HEIGHT,
				title: album.title,
				artist: album.artist,
				chronologyLabel: album.chronologyLabel,
				year: album.year,
				ordinal: album.ordinal,
				resolutionStatus: input.resolutionStatus,
				...(album.imageKeyHint ? { imageKeyHint: album.imageKeyHint } : {})
			} satisfies TimelineBranchAlbumEntity);
		}));
		const connector = connectorFor(branch.branchId, source, header);
		const group = Object.freeze({
			branchId: branch.branchId,
			depth: branch.depth,
			sourceEntityId: source.entityId,
			source,
			side,
			laneIndex,
			phase: branch.phase,
			error: branch.error,
			header,
			controls: branchControls,
			controlCount: branchControls.length,
			entities: branchEntities,
			connector
		} satisfies TimelineBranchLayoutGroup);

		groups.push(group);
		groupById.set(group.branchId, group);
		headers.push(header);
		controls.push(...branchControls);
		connectors.push(connector);
		for (const entity of branchEntities) {
			entities.push(entity);
			entityById.set(entity.id, entity);
		}
		for (const bounds of [
			centeredRect(header.x, header.y, header.width, header.height),
			...branchEntities.map(timelineBranchEntityBounds),
			connectorBounds(connector)
		]) {
			branchBounds = branchBounds ? unionBounds(branchBounds, bounds) : bounds;
		}
	}

	return Object.freeze({
		groups: Object.freeze(groups),
		entities: Object.freeze(entities),
		headers: Object.freeze(headers),
		controls: Object.freeze(controls),
		connectors: Object.freeze(connectors),
		entityById,
		groupById,
		branchBounds: branchBounds ? Object.freeze(branchBounds) : null,
		bounds: Object.freeze(branchBounds ? unionBounds(baseModel.bounds, branchBounds) : baseModel.bounds)
	});
}

function intersects(left: Rect, right: Rect): boolean {
	return !(
		left.x + left.width < right.x ||
		right.x + right.width < left.x ||
		left.y + left.height < right.y ||
		right.y + right.height < left.y
	);
}

function pointInRect(point: Readonly<Point>, rect: Rect): boolean {
	return (
		point.x >= rect.x &&
		point.x <= rect.x + rect.width &&
		point.y >= rect.y &&
		point.y <= rect.y + rect.height
	);
}

function connectorIntersectsRect(connector: TimelineBranchConnector, rect: Rect): boolean {
	if (pointInRect(connector.start, rect) || pointInRect(connector.end, rect)) return true;

	const deltaX = connector.end.x - connector.start.x;
	const deltaY = connector.end.y - connector.start.y;
	let minimum = 0;
	let maximum = 1;
	for (const [edgeDelta, edgeDistance] of [
		[-deltaX, connector.start.x - rect.x],
		[deltaX, rect.x + rect.width - connector.start.x],
		[-deltaY, connector.start.y - rect.y],
		[deltaY, rect.y + rect.height - connector.start.y]
	] as const) {
		if (edgeDelta === 0) {
			if (edgeDistance < 0) return false;
			continue;
		}
		const ratio = edgeDistance / edgeDelta;
		if (edgeDelta < 0) minimum = Math.max(minimum, ratio);
		else maximum = Math.min(maximum, ratio);
		if (minimum > maximum) return false;
	}
	return true;
}

function validateReservation(value: number, maximum: number, label: string): void {
	if (!Number.isSafeInteger(value) || value < 0 || value >= maximum) {
		throw new RangeError(`${label} is invalid`);
	}
}

function albumRenderObject(
	entity: TimelineBranchAlbumEntity,
	pinned: boolean
): TimelineBranchAlbumRenderObject {
	return Object.freeze({
		id: entity.id,
		kind: 'branch-album' as const,
		entity,
		pinned
	});
}

export function createTimelineBranchRenderPlan(
	layout: TimelineBranchLayout,
	camera: Camera,
	viewport: ScreenViewport,
	options: TimelineBranchRenderPlanOptions = {}
): TimelineBranchRenderPlan {
	const queryWindow = createCameraQueryWindow(camera, viewport, options.previousTier);
	const reservedWorldObjects = options.reservedWorldObjects ?? 0;
	const reservedArtworkImages = options.reservedArtworkImages ?? 0;
	validateReservation(
		reservedWorldObjects,
		MAX_TIMELINE_WORLD_OBJECTS,
		'reserved world-object count'
	);
	validateReservation(
		reservedArtworkImages,
		MAX_TIMELINE_ARTWORK_IMAGES,
		'reserved artwork-image count'
	);

	const intersectingEntities = layout.entities.filter((entity) =>
		intersects(timelineBranchEntityBounds(entity), queryWindow.queryBounds)
	);
	const intersectingIds = new Set(intersectingEntities.map((entity) => entity.id));
	const pinned = options.pinnedId ? layout.entityById.get(options.pinnedId) : undefined;
	const albumObjects = Object.freeze([
		...(pinned && !intersectingIds.has(pinned.id) ? [albumRenderObject(pinned, true)] : []),
		...intersectingEntities.map((entity) =>
			albumRenderObject(entity, entity.id === pinned?.id)
		)
	]);
	const renderedAlbumBranchIds = new Set(
		albumObjects.map((object) => object.entity.branchId)
	);
	const connectors = Object.freeze(layout.connectors.filter((connector) =>
		connectorIntersectsRect(connector, queryWindow.queryBounds)
	));
	const visibleConnectorBranchIds = new Set(
		connectors.map((connector) => connector.branchId)
	);
	const visibleGroups = layout.groups.filter((group) =>
		renderedAlbumBranchIds.has(group.branchId) ||
		visibleConnectorBranchIds.has(group.branchId) ||
		intersects(
			centeredRect(
				group.header.x,
				group.header.y,
				group.header.width,
				group.header.height
			),
			queryWindow.queryBounds
		)
	);
	const headerObjects = Object.freeze(visibleGroups.map((group) => Object.freeze({
		id: group.header.id,
		kind: 'branch-header' as const,
		entity: group.header
	})));
	const controlObjects = Object.freeze(visibleGroups.flatMap((group) =>
		group.controls.map((control) => Object.freeze({
			id: control.id,
			kind: 'branch-control' as const,
			entity: control
		}))
	));
	const objects = Object.freeze([
		...headerObjects,
		...controlObjects,
		...albumObjects
	]);
	const sharedWorldObjects = reservedWorldObjects + objects.length;
	if (sharedWorldObjects > MAX_TIMELINE_WORLD_OBJECTS) {
		throw new RangeError(
			'Timeline branch world-object budget exceeded; intersecting branch albums were not omitted'
		);
	}

	const artworkCandidates = albumObjects.filter(
		(object) => object.entity.imageKeyHint !== undefined
	);
	const availableArtworkImages =
		MAX_TIMELINE_ARTWORK_IMAGES - reservedArtworkImages;
	const artworkIds = queryWindow.tier === 'overview'
		? []
		: artworkCandidates
			.slice(0, availableArtworkImages)
			.map((object) => object.id);
	const sharedArtworkImages = reservedArtworkImages + artworkIds.length;

	return Object.freeze({
		tier: queryWindow.tier,
		queryBounds: queryWindow.queryBounds,
		objects,
		albums: albumObjects,
		headers: headerObjects,
		controls: controlObjects,
		connectors,
		artworkIds: Object.freeze(artworkIds),
		counts: Object.freeze({
			intersectingAlbums: intersectingEntities.length,
			pinnedOutsideViewport: pinned && !intersectingIds.has(pinned.id) ? 1 : 0,
			albumObjects: albumObjects.length,
			headerObjects: headerObjects.length,
			controlObjects: controlObjects.length,
			worldObjects: objects.length,
			artworkCandidates: artworkCandidates.length,
			artworkImages: artworkIds.length,
			connectors: connectors.length
		}),
		accounting: Object.freeze({
			expectedIntersectingAlbums: intersectingEntities.length,
			representedIntersectingAlbums: intersectingEntities.length,
			complete: true
		}),
		reservations: Object.freeze({
			priorWorldObjects: reservedWorldObjects,
			branchWorldObjects: objects.length,
			sharedWorldObjects,
			remainingWorldObjects: MAX_TIMELINE_WORLD_OBJECTS - sharedWorldObjects,
			priorArtworkImages: reservedArtworkImages,
			branchArtworkImages: artworkIds.length,
			sharedArtworkImages,
			remainingArtworkImages:
				MAX_TIMELINE_ARTWORK_IMAGES - sharedArtworkImages
		})
	});
}
