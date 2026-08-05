import { get, writable } from 'svelte/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	pushLibraryPageState,
	replaceLibraryPageState
} from '$lib/libraryPageNavigation';
import {
	buildTimelineLibraryPageState,
	type TimelineLibraryPageState
} from '$lib/libraryPageState';
import { createTimelineBrowseSessionStore } from '$lib/stores/timelineBrowseSessionStore';
import type { TimelineBrowseSessionStore } from '$lib/stores/timelineBrowseSessionStore';
import { createCanvasNavigationCoordinator } from '../CanvasNavigationCoordinator';
import { createTimelineCanvasModel } from '../canvasModel';
import type { Camera } from '../types';
import { calendarAlbum } from './fixtures';

vi.mock('$lib/libraryPageNavigation', () => ({
	pushLibraryPageState: vi.fn(() => true),
	replaceLibraryPageState: vi.fn(() => true)
}));

const viewport = { x: 0, y: 0, width: 1_400, height: 900 };
const model = createTimelineCanvasModel([calendarAlbum('album-1', 2001, 0)]);
const initialCamera: Camera = { centerX: 0, centerY: 0, scale: 1 };

function timelinePageState(camera = { x: 10, y: -20, scale: 1.25 }): TimelineLibraryPageState {
	return buildTimelineLibraryPageState({
		artistQuery: 'Current artist query',
		selectedArtistLocalId: 'artist-current',
		activeSemanticPath: [
			{ kind: 'artist', localId: 'artist-current' },
			{ kind: 'auxiliary-artist', localId: 'artist-related' },
			{ kind: 'album', localId: 'album-current' }
		],
		selectedNode: { kind: 'album', localId: 'album-current' },
		camera,
		displayDepth: 2
	});
}

function coordinatorFor(
	currentPageState: () => TimelineLibraryPageState | null,
	browseStore: TimelineBrowseSessionStore = createTimelineBrowseSessionStore({ isReady: () => false }),
	overrides: Partial<Parameters<typeof createCanvasNavigationCoordinator>[0]> = {}
) {
	return createCanvasNavigationCoordinator({
		browseStore,
		viewport: () => viewport,
		camera: () => initialCamera,
		model: () => model,
		currentPageState,
		beforeSemanticCommit: () => {},
		applyCamera: () => {},
		focusAlbum: () => {},
		...overrides
	});
}

function selectedBrowseStore(openAlbum = vi.fn()): TimelineBrowseSessionStore {
	const base = createTimelineBrowseSessionStore({ isReady: () => false });
	const state = writable({
		...get(base),
		query: 'Base artist query',
		selectedArtist: {
			localId: 'artist-current',
			coreId: 'core-current',
			exactName: 'Current artist',
			normalizedName: 'current artist',
			firstSeenAt: '2026-01-01T00:00:00.000Z',
			lastSeenAt: '2026-01-01T00:00:00.000Z',
			resolutionStatus: 'resolved' as const
		}
	});
	return {
		...base,
		subscribe: state.subscribe,
		openAlbum
	} as TimelineBrowseSessionStore;
}

describe('CanvasNavigationCoordinator camera history', () => {
	beforeEach(() => {
		vi.mocked(pushLibraryPageState).mockClear();
		vi.mocked(replaceLibraryPageState).mockClear();
	});

	it('replaces only the camera in the exact current Timeline page state', () => {
		const staleState = timelinePageState();
		const currentState = buildTimelineLibraryPageState({
			...staleState.snapshot,
			artistQuery: 'Latest query',
			selectedArtistLocalId: 'artist-latest',
			activeSemanticPath: [{ kind: 'artist', localId: 'artist-latest' }],
			selectedNode: { kind: 'artist', localId: 'artist-latest' },
			displayDepth: 0
		});
		let pageState = staleState;
		const coordinator = coordinatorFor(() => pageState);
		pageState = currentState;

		expect(
			coordinator.replaceCameraPageState({ centerX: 320, centerY: -140, scale: 0.82 })
		).toBe(true);
		expect(replaceLibraryPageState).toHaveBeenCalledTimes(1);
		expect(replaceLibraryPageState).toHaveBeenCalledWith(
			buildTimelineLibraryPageState({
				...currentState.snapshot,
				camera: { x: 320, y: -140, scale: 0.82 }
			})
		);
		expect(currentState.snapshot).toEqual({
			artistQuery: 'Latest query',
			selectedArtistLocalId: 'artist-latest',
			activeSemanticPath: [{ kind: 'artist', localId: 'artist-latest' }],
			selectedNode: { kind: 'artist', localId: 'artist-latest' },
			camera: { x: 10, y: -20, scale: 1.25 },
			displayDepth: 0
		});
	});

	it('does not write without a current Timeline entry or when its camera is unchanged', () => {
		let pageState: TimelineLibraryPageState | null = null;
		const coordinator = coordinatorFor(() => pageState);

		expect(coordinator.replaceCameraPageState(initialCamera)).toBe(false);
		pageState = timelinePageState({ x: 0, y: 0, scale: 1 });
		expect(coordinator.replaceCameraPageState(initialCamera)).toBe(false);
		expect(replaceLibraryPageState).not.toHaveBeenCalled();
	});
});

describe('CanvasNavigationCoordinator auxiliary branch history', () => {
	beforeEach(() => {
		vi.mocked(pushLibraryPageState).mockClear();
		vi.mocked(replaceLibraryPageState).mockClear();
	});

	it('pushes one stable-ID-only auxiliary artist entry without selecting the base artist again', () => {
		const browseStore = selectedBrowseStore();
		const applyCamera = vi.fn();
		const beforeSemanticCommit = vi.fn();
		const branchCamera = { centerX: 440, centerY: -260, scale: 0.9 };
		const coordinator = coordinatorFor(() => null, browseStore, {
			applyCamera,
			beforeSemanticCommit
		});

		expect(coordinator.commitAuxiliaryArtist('artist-related', branchCamera)).toBe(true);
		expect(beforeSemanticCommit).toHaveBeenCalledTimes(1);
		expect(applyCamera).toHaveBeenCalledWith(branchCamera);
		expect(pushLibraryPageState).toHaveBeenCalledTimes(1);
		expect(pushLibraryPageState).toHaveBeenCalledWith(
			buildTimelineLibraryPageState({
				artistQuery: 'Base artist query',
				selectedArtistLocalId: 'artist-current',
				activeSemanticPath: [
					{ kind: 'artist', localId: 'artist-current' },
					{ kind: 'auxiliary-artist', localId: 'artist-related' }
				],
				selectedNode: { kind: 'auxiliary-artist', localId: 'artist-related' },
				camera: { x: 440, y: -260, scale: 0.9 },
				displayDepth: 1
			})
		);
	});

	it('does not duplicate the current auxiliary artist history entry', () => {
		const current = buildTimelineLibraryPageState({
			artistQuery: 'Base artist query',
			selectedArtistLocalId: 'artist-current',
			activeSemanticPath: [
				{ kind: 'artist', localId: 'artist-current' },
				{ kind: 'auxiliary-artist', localId: 'artist-related' }
			],
			selectedNode: { kind: 'auxiliary-artist', localId: 'artist-related' },
			camera: { x: 0, y: 0, scale: 1 },
			displayDepth: 1
		});
		const coordinator = coordinatorFor(() => current, selectedBrowseStore());

		expect(coordinator.commitAuxiliaryArtist('artist-related', initialCamera)).toBe(false);
		expect(pushLibraryPageState).not.toHaveBeenCalled();
	});

	it('replaces a closed auxiliary path with the stable base-artist root', () => {
		const applyCamera = vi.fn();
		const beforeSemanticCommit = vi.fn();
		const rootCamera = { centerX: 20, centerY: -30, scale: 0.85 };
		const coordinator = coordinatorFor(() => timelinePageState(), selectedBrowseStore(), {
			applyCamera,
			beforeSemanticCommit
		});

		expect(coordinator.replaceBaseArtist(rootCamera)).toBe(true);
		expect(beforeSemanticCommit).toHaveBeenCalledTimes(1);
		expect(replaceLibraryPageState).toHaveBeenCalledWith(
			buildTimelineLibraryPageState({
				artistQuery: 'Base artist query',
				selectedArtistLocalId: 'artist-current',
				activeSemanticPath: [{ kind: 'artist', localId: 'artist-current' }],
				selectedNode: { kind: 'artist', localId: 'artist-current' },
				camera: { x: 20, y: -30, scale: 0.85 },
				displayDepth: 0
			})
		);
		expect(applyCamera).toHaveBeenCalledWith(rootCamera);
	});

	it('opens an auxiliary album through its artist and pushes depth-two history', async () => {
		const openAlbum = vi.fn(async (
			_albumLocalId: string,
			onPublished?: () => void,
			_detailArtistLocalId?: string
		) => {
			onPublished?.();
			return { success: true, publication: {} };
		});
		const browseStore = selectedBrowseStore(openAlbum);
		const applyCamera = vi.fn();
		const coordinator = coordinatorFor(() => null, browseStore, { applyCamera });

		await expect(coordinator.openAlbum({
			albumLocalId: 'album-related',
			detailArtistLocalId: 'artist-related',
			anchor: { x: 620, y: -280, width: 64, height: 112 }
		})).resolves.toBe(true);

		expect(openAlbum).toHaveBeenCalledTimes(1);
		expect(openAlbum.mock.calls[0]?.[0]).toBe('album-related');
		expect(openAlbum.mock.calls[0]?.[2]).toBe('artist-related');
		expect(pushLibraryPageState).toHaveBeenCalledTimes(1);
		const published = vi.mocked(pushLibraryPageState).mock.calls[0]?.[0];
		expect(published?.snapshot).toMatchObject({
			selectedArtistLocalId: 'artist-current',
			activeSemanticPath: [
				{ kind: 'artist', localId: 'artist-current' },
				{ kind: 'auxiliary-artist', localId: 'artist-related' },
				{ kind: 'album', localId: 'album-related' }
			],
			selectedNode: { kind: 'album', localId: 'album-related' },
			displayDepth: 2
		});
		expect(applyCamera).toHaveBeenCalledTimes(1);
	});

	it('lets a superseding operation reject stale auxiliary publication without history or camera writes', async () => {
		let publish: (() => void) | undefined;
		let settle: ((value: { success: true; publication: object }) => void) | undefined;
		const openAlbum = vi.fn((
			_albumLocalId: string,
			onPublished?: () => void
		) => {
			publish = onPublished;
			return new Promise<{ success: true; publication: object }>((resolve) => {
				settle = resolve;
			});
		});
		const applyCamera = vi.fn();
		const coordinator = coordinatorFor(() => null, selectedBrowseStore(openAlbum), {
			applyCamera
		});
		const pending = coordinator.openAlbum({
			albumLocalId: 'album-related',
			detailArtistLocalId: 'artist-related',
			anchor: { x: 620, y: -280, width: 64, height: 112 }
		});

		coordinator.quiesce();
		expect(() => publish?.()).toThrow('Timeline detail was superseded');
		settle?.({ success: true, publication: {} });
		await expect(pending).resolves.toBe(false);
		expect(pushLibraryPageState).not.toHaveBeenCalled();
		expect(applyCamera).not.toHaveBeenCalled();
	});
});
