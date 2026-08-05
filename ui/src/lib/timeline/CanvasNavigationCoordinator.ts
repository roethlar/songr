import { get } from 'svelte/store';

import {
	buildTimelineLibraryPageState,
	type TimelineCameraSnapshot,
	type TimelineLibraryPageState
} from '$lib/libraryPageState';
import {
	pushLibraryPageState,
	replaceLibraryPageState
} from '$lib/libraryPageNavigation';
import type {
	TimelineBrowseSessionStore,
	TimelineSelectionPublication
} from '$lib/stores/timelineBrowseSessionStore';
import { persistTimelineSessionPageState } from '$lib/timelinePageSessionState';
import {
	createTimelineCanvasModel,
	fitCamera,
	type Camera,
	type ScreenViewport,
	type TimelineCanvasModel
} from '$lib/timeline';

const DETAIL_SLAB_WIDTH = 360;
const DETAIL_SLAB_HEIGHT = 440;
const DETAIL_GAP = 64;
const INITIAL_MAX_SCALE = 1.18;

export interface CanvasNavigationCoordinatorDependencies {
	readonly browseStore: TimelineBrowseSessionStore;
	readonly viewport: () => ScreenViewport;
	readonly camera: () => Camera;
	readonly model: () => TimelineCanvasModel;
	readonly currentPageState: () => TimelineLibraryPageState | null;
	readonly beforeSemanticCommit: () => void;
	readonly applyCamera: (camera: Camera) => void;
	readonly focusAlbum: (albumLocalId: string) => Promise<void> | void;
}

export interface TimelineAlbumNavigationTarget {
	readonly albumLocalId: string;
	/** Omitted for the selected base artist; present for a manual artist branch. */
	readonly detailArtistLocalId?: string;
	/** Current world-space marker geometry, including auxiliary branch markers. */
	readonly anchor?: {
		readonly x: number;
		readonly y: number;
		readonly width: number;
		readonly height: number;
	};
}

export interface CanvasNavigationCoordinator {
	selectArtist(localId: string): Promise<boolean>;
	commitAuxiliaryArtist(artistLocalId: string, camera: Camera): boolean;
	openAlbum(target: string | TimelineAlbumNavigationTarget): Promise<boolean>;
	replaceBaseArtist(camera: Camera): boolean;
	restore(pageState: TimelineLibraryPageState): Promise<boolean>;
	replaceCameraPageState(camera: Camera): boolean;
	quiesce(): void;
}

function cameraSnapshot(camera: Camera): TimelineCameraSnapshot {
	return { x: camera.centerX, y: camera.centerY, scale: camera.scale };
}

function cameraFromSnapshot(snapshot: TimelineCameraSnapshot): Camera {
	return { centerX: snapshot.x, centerY: snapshot.y, scale: snapshot.scale };
}

function camerasMatch(left: TimelineCameraSnapshot, right: TimelineCameraSnapshot): boolean {
	return left.x === right.x && left.y === right.y && left.scale === right.scale;
}

export function createCanvasNavigationCoordinator(
	dependencies: CanvasNavigationCoordinatorDependencies
): CanvasNavigationCoordinator {
	const { browseStore } = dependencies;
	let generation = 0;

	function fittedArtistCamera(publication: TimelineSelectionPublication): Camera {
		const model = createTimelineCanvasModel(publication.albums);
		return fitCamera(model.bounds, dependencies.viewport(), {
			padding: publication.albums.length <= 1 ? 250 : 120,
			maxScale: INITIAL_MAX_SCALE
		});
	}

	function attachedDetailCamera(target: TimelineAlbumNavigationTarget): Camera {
		const entity =
			target.anchor ?? dependencies.model().entityById.get(target.albumLocalId);
		if (!entity) return dependencies.camera();
		const detailBounds = {
			x: entity.x - entity.width / 2,
			y: Math.min(entity.y - entity.height / 2, entity.y - DETAIL_SLAB_HEIGHT / 2),
			width: entity.width + DETAIL_GAP + DETAIL_SLAB_WIDTH,
			height: Math.max(entity.height, DETAIL_SLAB_HEIGHT)
		};
		return fitCamera(detailBounds, dependencies.viewport(), {
			padding: 72,
			maxScale: Math.min(dependencies.camera().scale, INITIAL_MAX_SCALE)
		});
	}

	async function selectArtist(localId: string): Promise<boolean> {
		const operation = ++generation;
		const candidate = get(browseStore).candidates.find((artist) => artist.localId === localId);
		if (!candidate) return false;
		const result = await browseStore.selectArtist(candidate, (publication) => {
			if (operation !== generation) throw new Error('Timeline selection was superseded');
			const camera = fittedArtistCamera(publication);
			dependencies.beforeSemanticCommit();
			pushLibraryPageState(
				buildTimelineLibraryPageState({
					artistQuery: publication.query,
					selectedArtistLocalId: publication.artist.localId,
					activeSemanticPath: [{ kind: 'artist', localId: publication.artist.localId }],
					selectedNode: { kind: 'artist', localId: publication.artist.localId },
					camera: cameraSnapshot(camera),
					displayDepth: 0
				})
			);
			dependencies.applyCamera(camera);
		});
		return operation === generation && result.success;
	}

	function commitAuxiliaryArtist(artistLocalId: string, camera: Camera): boolean {
		const before = get(browseStore);
		const baseArtistLocalId = before.selectedArtist?.localId;
		if (!baseArtistLocalId || artistLocalId === baseArtistLocalId) return false;
		const current = dependencies.currentPageState();
		if (
			current?.libraryView === 'timeline' &&
			current.snapshot.activeSemanticPath.length === 2 &&
			current.snapshot.activeSemanticPath[0]?.kind === 'artist' &&
			current.snapshot.activeSemanticPath[0].localId === baseArtistLocalId &&
			current.snapshot.activeSemanticPath[1]?.kind === 'auxiliary-artist' &&
			current.snapshot.activeSemanticPath[1].localId === artistLocalId &&
			current.snapshot.selectedNode?.kind === 'auxiliary-artist' &&
			current.snapshot.selectedNode.localId === artistLocalId
		) return false;
		generation += 1;
		dependencies.beforeSemanticCommit();
		pushLibraryPageState(
			buildTimelineLibraryPageState({
				artistQuery: before.query,
				selectedArtistLocalId: baseArtistLocalId,
				activeSemanticPath: [
					{ kind: 'artist', localId: baseArtistLocalId },
					{ kind: 'auxiliary-artist', localId: artistLocalId }
				],
				selectedNode: { kind: 'auxiliary-artist', localId: artistLocalId },
				camera: cameraSnapshot(camera),
				displayDepth: 1
			})
		);
		dependencies.applyCamera(camera);
		return true;
	}

	async function openAlbum(
		targetValue: string | TimelineAlbumNavigationTarget
	): Promise<boolean> {
		const target = typeof targetValue === 'string'
			? { albumLocalId: targetValue }
			: targetValue;
		const { albumLocalId, detailArtistLocalId } = target;
		const operation = ++generation;
		const before = get(browseStore);
		const baseArtistLocalId = before.selectedArtist?.localId;
		if (!baseArtistLocalId) return false;
		const auxiliaryArtistLocalId =
			detailArtistLocalId && detailArtistLocalId !== baseArtistLocalId
				? detailArtistLocalId
				: null;
		const camera = attachedDetailCamera(target);
		let historyPublished = false;
		const publishTarget = () => {
			if (historyPublished) return;
			if (operation !== generation) throw new Error('Timeline detail was superseded');
			dependencies.beforeSemanticCommit();
			pushLibraryPageState(
				buildTimelineLibraryPageState({
					artistQuery: get(browseStore).query,
					selectedArtistLocalId: baseArtistLocalId,
					activeSemanticPath: auxiliaryArtistLocalId
						? [
							{ kind: 'artist', localId: baseArtistLocalId },
							{ kind: 'auxiliary-artist', localId: auxiliaryArtistLocalId },
							{ kind: 'album', localId: albumLocalId }
						]
						: [
							{ kind: 'artist', localId: baseArtistLocalId },
							{ kind: 'album', localId: albumLocalId }
						],
					selectedNode: { kind: 'album', localId: albumLocalId },
					camera: cameraSnapshot(camera),
					displayDepth: auxiliaryArtistLocalId ? 2 : 1
				})
			);
			dependencies.applyCamera(camera);
			historyPublished = true;
		};
		const result = auxiliaryArtistLocalId
			? await browseStore.openAlbum(
				albumLocalId,
				publishTarget,
				auxiliaryArtistLocalId
			)
			: await browseStore.openAlbum(albumLocalId, publishTarget);
		if (operation !== generation) return false;
		if (
			!result.success &&
			(result.code === 'ALBUM_NOT_FOUND' || result.code === 'ALBUM_AMBIGUOUS')
		) {
			publishTarget();
		}
		return result.success || historyPublished;
	}

	async function restore(pageState: TimelineLibraryPageState): Promise<boolean> {
		const operation = ++generation;
		const previousDetailId = get(browseStore).selectedAlbumLocalId;
		dependencies.beforeSemanticCommit();
		dependencies.applyCamera(cameraFromSnapshot(pageState.snapshot.camera));
		const restored = await browseStore.restoreSnapshot(pageState.snapshot);
		if (operation !== generation) return false;
		if (pageState.snapshot.selectedNode?.kind !== 'album' && previousDetailId) {
			await dependencies.focusAlbum(previousDetailId);
		}
		if (!restored && get(browseStore).selectedArtist === null) {
			persistTimelineSessionPageState(
				buildTimelineLibraryPageState({
					artistQuery: pageState.snapshot.artistQuery,
					selectedArtistLocalId: null,
					activeSemanticPath: [],
					selectedNode: null,
					camera: pageState.snapshot.camera,
					displayDepth: 0
				})
			);
		}
		return restored;
	}

	function replaceCameraPageState(camera: Camera): boolean {
		const currentPageState = dependencies.currentPageState();
		if (!currentPageState || currentPageState.libraryView !== 'timeline') return false;
		const nextCamera = cameraSnapshot(camera);
		if (camerasMatch(currentPageState.snapshot.camera, nextCamera)) return false;
		return replaceLibraryPageState(
			buildTimelineLibraryPageState({
				...currentPageState.snapshot,
				camera: nextCamera
			})
		);
	}

	function replaceBaseArtist(camera: Camera): boolean {
		const before = get(browseStore);
		const baseArtistLocalId = before.selectedArtist?.localId;
		if (!baseArtistLocalId) return false;
		generation += 1;
		dependencies.beforeSemanticCommit();
		const replaced = replaceLibraryPageState(
			buildTimelineLibraryPageState({
				artistQuery: before.query,
				selectedArtistLocalId: baseArtistLocalId,
				activeSemanticPath: [{ kind: 'artist', localId: baseArtistLocalId }],
				selectedNode: { kind: 'artist', localId: baseArtistLocalId },
				camera: cameraSnapshot(camera),
				displayDepth: 0
			})
		);
		if (replaced) dependencies.applyCamera(camera);
		return replaced;
	}

	return {
		selectArtist,
		commitAuxiliaryArtist,
		openAlbum,
		restore,
		replaceCameraPageState,
		replaceBaseArtist,
		quiesce() {
			generation += 1;
		}
	};
}
