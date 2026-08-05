import { writable, type Readable } from 'svelte/store';

export const CANVAS_WORKSPACE_MAX_ABSOLUTE_OFFSET = 1_000_000;

export interface CanvasWorkspaceScope {
	readonly coreId: string;
	readonly artistLocalId: string;
}

export interface CanvasWorkspaceCanonicalAlbum {
	readonly id: string;
	readonly x: number;
	readonly y: number;
}

export interface CanvasWorkspacePoint {
	readonly x: number;
	readonly y: number;
}

export interface CanvasWorkspaceOffset {
	readonly dx: number;
	readonly dy: number;
}

export interface CanvasWorkspaceOffsetEntry extends CanvasWorkspaceOffset {
	readonly albumLocalId: string;
}

export interface CanvasWorkspaceSnapshot {
	readonly scope: CanvasWorkspaceScope | null;
	readonly workspaceEpoch: number;
	readonly modelGeneration: number;
	readonly modelFingerprint: string | null;
	readonly albumCount: number;
	readonly offsets: readonly CanvasWorkspaceOffsetEntry[];
}

export interface CanvasWorkspacePlacementToken {
	readonly gestureId: number;
	readonly workspaceEpoch: number;
	readonly modelGeneration: number;
	readonly albumLocalId: string;
	readonly preOffset: CanvasWorkspaceOffset | null;
}

export type CanvasWorkspaceMutationRejection =
	| 'inactive-token'
	| 'stale-workspace'
	| 'unknown-album'
	| 'invalid-offset';

export type CanvasWorkspaceCommitResult =
	| {
			readonly status: 'committed';
			readonly changed: boolean;
			readonly offset: CanvasWorkspaceOffset | null;
			readonly position: CanvasWorkspacePoint;
	  }
	| { readonly status: 'rejected'; readonly reason: CanvasWorkspaceMutationRejection };

export type CanvasWorkspaceCancelResult =
	| { readonly status: 'cancelled'; readonly preOffset: CanvasWorkspaceOffset | null }
	| {
			readonly status: 'rejected';
			readonly reason: Exclude<CanvasWorkspaceMutationRejection, 'invalid-offset'>;
	  };

export interface CanvasWorkspaceReconcileResult {
	readonly accepted: boolean;
	readonly scopeChanged: boolean;
	readonly modelChanged: boolean;
	readonly prunedOffsetCount: number;
}

export interface CanvasWorkspaceStore extends Readable<CanvasWorkspaceSnapshot> {
	reconcile(
		scope: CanvasWorkspaceScope,
		albums: readonly CanvasWorkspaceCanonicalAlbum[]
	): CanvasWorkspaceReconcileResult;
	beginPlacement(albumLocalId: string): CanvasWorkspacePlacementToken | null;
	commitPlacement(
		token: CanvasWorkspacePlacementToken,
		offset: CanvasWorkspaceOffset
	): CanvasWorkspaceCommitResult;
	cancelPlacement(token: CanvasWorkspacePlacementToken): CanvasWorkspaceCancelResult;
	offsetFor(albumLocalId: string): CanvasWorkspaceOffset | null;
	canonicalPositionFor(albumLocalId: string): CanvasWorkspacePoint | null;
	positionFor(albumLocalId: string): CanvasWorkspacePoint | null;
	suspendRuntime(): void;
	reset(): void;
}

interface CanonicalModel {
	readonly fingerprint: string;
	readonly byId: ReadonlyMap<string, CanvasWorkspacePoint>;
}

const EMPTY_SNAPSHOT: CanvasWorkspaceSnapshot = Object.freeze({
	scope: null,
	workspaceEpoch: 0,
	modelGeneration: 0,
	modelFingerprint: null,
	albumCount: 0,
	offsets: Object.freeze([])
});

function compareIds(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedNumber(value: number): number {
	return Object.is(value, -0) ? 0 : value;
}

function validIdentity(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}

function normalizedScope(scope: CanvasWorkspaceScope): CanvasWorkspaceScope | null {
	if (!validIdentity(scope?.coreId) || !validIdentity(scope?.artistLocalId)) return null;
	return Object.freeze({ coreId: scope.coreId, artistLocalId: scope.artistLocalId });
}

function sameScope(
	left: CanvasWorkspaceScope | null,
	right: CanvasWorkspaceScope
): boolean {
	return left?.coreId === right.coreId && left.artistLocalId === right.artistLocalId;
}

function buildCanonicalModel(
	albums: readonly CanvasWorkspaceCanonicalAlbum[]
): CanonicalModel | null {
	if (!Array.isArray(albums)) return null;
	const rows: Array<readonly [string, number, number]> = [];
	const byId = new Map<string, CanvasWorkspacePoint>();
	for (const album of albums) {
		if (
			!validIdentity(album?.id) ||
			typeof album.x !== 'number' ||
			!Number.isFinite(album.x) ||
			typeof album.y !== 'number' ||
			!Number.isFinite(album.y) ||
			byId.has(album.id)
		) return null;
		const x = normalizedNumber(album.x);
		const y = normalizedNumber(album.y);
		const point = Object.freeze({ x, y });
		byId.set(album.id, point);
		rows.push(Object.freeze([album.id, x, y] as const));
	}
	rows.sort((left, right) => compareIds(left[0], right[0]));
	return Object.freeze({
		fingerprint: JSON.stringify(rows),
		byId
	});
}

/** Deterministic, input-order-independent placement fingerprint. */
export function fingerprintCanvasWorkspaceModel(
	albums: readonly CanvasWorkspaceCanonicalAlbum[]
): string | null {
	return buildCanonicalModel(albums)?.fingerprint ?? null;
}

function validOffset(offset: CanvasWorkspaceOffset): boolean {
	return (
		typeof offset?.dx === 'number' &&
		Number.isFinite(offset.dx) &&
		Math.abs(offset.dx) <= CANVAS_WORKSPACE_MAX_ABSOLUTE_OFFSET &&
		typeof offset?.dy === 'number' &&
		Number.isFinite(offset.dy) &&
		Math.abs(offset.dy) <= CANVAS_WORKSPACE_MAX_ABSOLUTE_OFFSET
	);
}

function normalizedOffset(offset: CanvasWorkspaceOffset): CanvasWorkspaceOffset | null {
	const dx = normalizedNumber(offset.dx);
	const dy = normalizedNumber(offset.dy);
	return dx === 0 && dy === 0 ? null : Object.freeze({ dx, dy });
}

function sameOffset(
	left: CanvasWorkspaceOffset | null,
	right: CanvasWorkspaceOffset | null
): boolean {
	return left?.dx === right?.dx && left?.dy === right?.dy;
}

function offsetCopy(offset: CanvasWorkspaceOffset | null): CanvasWorkspaceOffset | null {
	return offset ? Object.freeze({ dx: offset.dx, dy: offset.dy }) : null;
}

export function createCanvasWorkspaceStore(): CanvasWorkspaceStore {
	const state = writable<CanvasWorkspaceSnapshot>(EMPTY_SNAPSHOT);
	let snapshot = EMPTY_SNAPSHOT;
	let canonicalById = new Map<string, CanvasWorkspacePoint>();
	let offsetsById = new Map<string, CanvasWorkspaceOffset>();
	let activeToken: CanvasWorkspacePlacementToken | null = null;
	let nextGestureId = 1;

	function publish(): void {
		const offsets = [...offsetsById.entries()]
			.sort(([left], [right]) => compareIds(left, right))
			.map(([albumLocalId, offset]) =>
				Object.freeze({ albumLocalId, dx: offset.dx, dy: offset.dy })
			);
		snapshot = Object.freeze({
			scope: snapshot.scope,
			workspaceEpoch: snapshot.workspaceEpoch,
			modelGeneration: snapshot.modelGeneration,
			modelFingerprint: snapshot.modelFingerprint,
			albumCount: canonicalById.size,
			offsets: Object.freeze(offsets)
		});
		state.set(snapshot);
	}

	function rejectToken(
		token: CanvasWorkspacePlacementToken
	): Exclude<CanvasWorkspaceMutationRejection, 'invalid-offset'> | null {
		if (
			token.workspaceEpoch !== snapshot.workspaceEpoch ||
			token.modelGeneration !== snapshot.modelGeneration
		) return 'stale-workspace';
		if (!canonicalById.has(token.albumLocalId)) return 'unknown-album';
		if (
			token !== activeToken ||
			!sameOffset(token.preOffset, activeToken?.preOffset ?? null)
		) return 'inactive-token';
		const currentOffset = offsetsById.get(token.albumLocalId) ?? null;
		return sameOffset(currentOffset, token.preOffset) ? null : 'stale-workspace';
	}

	function positionFor(albumLocalId: string): CanvasWorkspacePoint | null {
		const canonical = canonicalById.get(albumLocalId);
		if (!canonical) return null;
		const offset = offsetsById.get(albumLocalId);
		return Object.freeze({
			x: canonical.x + (offset?.dx ?? 0),
			y: canonical.y + (offset?.dy ?? 0)
		});
	}

	return {
		subscribe: state.subscribe,
		reconcile(scopeValue, albums): CanvasWorkspaceReconcileResult {
			const scope = normalizedScope(scopeValue);
			const model = buildCanonicalModel(albums);
			if (!scope || !model) {
				return {
					accepted: false,
					scopeChanged: false,
					modelChanged: false,
					prunedOffsetCount: 0
				};
			}

			const scopeChanged = !sameScope(snapshot.scope, scope);
			const modelChanged = scopeChanged || snapshot.modelFingerprint !== model.fingerprint;
			if (!modelChanged) {
				return { accepted: true, scopeChanged: false, modelChanged: false, prunedOffsetCount: 0 };
			}

			const previousOffsetCount = offsetsById.size;
			if (scopeChanged) {
				offsetsById = new Map();
			} else {
				offsetsById = new Map(
					[...offsetsById].filter(([albumLocalId]) => model.byId.has(albumLocalId))
				);
			}
			canonicalById = new Map(model.byId);
			activeToken = null;
			snapshot = Object.freeze({
				scope,
				workspaceEpoch: snapshot.workspaceEpoch + (scopeChanged ? 1 : 0),
				modelGeneration: snapshot.modelGeneration + 1,
				modelFingerprint: model.fingerprint,
				albumCount: canonicalById.size,
				offsets: snapshot.offsets
			});
			publish();
			return {
				accepted: true,
				scopeChanged,
				modelChanged: true,
				prunedOffsetCount: previousOffsetCount - offsetsById.size
			};
		},
		beginPlacement(albumLocalId): CanvasWorkspacePlacementToken | null {
			if (activeToken || !canonicalById.has(albumLocalId)) return null;
			const token = Object.freeze({
				gestureId: nextGestureId++,
				workspaceEpoch: snapshot.workspaceEpoch,
				modelGeneration: snapshot.modelGeneration,
				albumLocalId,
				preOffset: offsetCopy(offsetsById.get(albumLocalId) ?? null)
			});
			activeToken = token;
			return token;
		},
		commitPlacement(token, offset): CanvasWorkspaceCommitResult {
			const rejection = rejectToken(token);
			if (rejection) return { status: 'rejected', reason: rejection };
			activeToken = null;
			if (!validOffset(offset)) return { status: 'rejected', reason: 'invalid-offset' };
			const nextOffset = normalizedOffset(offset);
			const previousOffset = offsetsById.get(token.albumLocalId) ?? null;
			if (nextOffset) offsetsById.set(token.albumLocalId, nextOffset);
			else offsetsById.delete(token.albumLocalId);
			const changed = !sameOffset(previousOffset, nextOffset);
			if (changed) publish();
			const position = positionFor(token.albumLocalId);
			if (!position) return { status: 'rejected', reason: 'unknown-album' };
			return {
				status: 'committed',
				changed,
				offset: offsetCopy(nextOffset),
				position
			};
		},
		cancelPlacement(token): CanvasWorkspaceCancelResult {
			const rejection = rejectToken(token);
			if (rejection) return { status: 'rejected', reason: rejection };
			activeToken = null;
			return { status: 'cancelled', preOffset: offsetCopy(token.preOffset) };
		},
		offsetFor(albumLocalId): CanvasWorkspaceOffset | null {
			return offsetCopy(offsetsById.get(albumLocalId) ?? null);
		},
		canonicalPositionFor(albumLocalId): CanvasWorkspacePoint | null {
			const point = canonicalById.get(albumLocalId);
			return point ? Object.freeze({ x: point.x, y: point.y }) : null;
		},
		positionFor,
		suspendRuntime(): void {
			const hadRuntime =
				snapshot.modelFingerprint !== null || canonicalById.size > 0 || activeToken !== null;
			canonicalById = new Map();
			activeToken = null;
			if (!hadRuntime) return;
			snapshot = Object.freeze({
				scope: snapshot.scope,
				workspaceEpoch: snapshot.workspaceEpoch,
				modelGeneration: snapshot.modelGeneration + 1,
				modelFingerprint: null,
				albumCount: 0,
				offsets: snapshot.offsets
			});
			publish();
		},
		reset(): void {
			const hadState = snapshot.scope !== null || canonicalById.size > 0 || offsetsById.size > 0;
			canonicalById = new Map();
			offsetsById = new Map();
			activeToken = null;
			if (!hadState) return;
			snapshot = Object.freeze({
				scope: null,
				workspaceEpoch: snapshot.workspaceEpoch + 1,
				modelGeneration: snapshot.modelGeneration + 1,
				modelFingerprint: null,
				albumCount: 0,
				offsets: Object.freeze([])
			});
			state.set(snapshot);
		}
	};
}

export const canvasWorkspaceStore = createCanvasWorkspaceStore();

/** Test and lifecycle seam; this clears only tab-memory state. */
export function resetCanvasWorkspaceStore(): void {
	canvasWorkspaceStore.reset();
}
