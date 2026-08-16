import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { writable, type Writable } from 'svelte/store';

import UnifiedAlbumPage from '../UnifiedAlbumPage.svelte';
import type { LibraryAlbumController, LibraryAlbumState } from '$lib/library/LibraryAlbumController';
import type { AlbumActionController } from '$lib/library/AlbumActionController';

const VERSION_A = 'version-a';
const VERSION_B = 'version-b';

type ActionState = {
	readonly phase: string;
	readonly actions: readonly { actionId: string; label: string }[];
	readonly error: string | null;
};

function sheetState(overrides: Partial<LibraryAlbumState> = {}): LibraryAlbumState {
	return {
		phase: 'opening',
		activeTab: 'details',
		albumLocalId: '20000000-0000-4000-8000-000000000001',
		generation: 4,
		requestId: '30000000-0000-4000-8000-000000000001',
		operationId: null,
		resolvingDeadlineAt: null,
		artist: null,
		title: null,
		versions: [],
		selectedVersionId: null,
		actionsAvailable: false,
		orderedTracks: [],
		code: null,
		error: null,
		transitionedAt: 1,
		...overrides
	} as LibraryAlbumState;
}

function resolvedState(trackCount = 2): LibraryAlbumState {
	return sheetState({
		phase: 'details',
		activeTab: 'details',
		artist: 'Björk',
		title: 'Debut',
		versions: [
			{
				versionId: VERSION_A,
				editionText: '',
				phase: 'loaded',
				trackCount,
				code: null,
				error: null
			}
		],
		selectedVersionId: VERSION_A,
		actionsAvailable: true,
		orderedTracks: Array.from({ length: trackCount }, (_value, index) => ({
			index,
			title: `Track ${index + 1}`
		}))
	});
}

function actionState(overrides: Partial<ActionState> = {}): ActionState {
	return { phase: 'idle', actions: [], error: null, ...overrides };
}

function makeHarness(
	initialSheet: LibraryAlbumState,
	initialAction: ActionState = actionState(),
	zones: readonly { zoneId: string; name: string }[] = [{ zoneId: 'zone-1', name: 'Kitchen' }],
	focusSongTitle: string | null = null,
	extraProps: Record<string, unknown> = {}
) {
	const sheetStore: Writable<LibraryAlbumState> = writable(initialSheet);
	const actionStore: Writable<ActionState> = writable(initialAction);
	const execute = vi.fn().mockReturnValue(true);
	const cancel = vi.fn();
	const reset = vi.fn();
	const callbacks = {
		onBack: vi.fn(),
		onRetry: vi.fn(),
		onBeginAction: vi.fn(),
		onOpenArtist: vi.fn()
	};
	const select = vi.fn((versionId: string) => {
		sheetStore.update((state) => ({
			...state,
			phase: 'loading-detail',
			activeTab: 'details',
			selectedVersionId: versionId,
			versions: state.versions.map((version) =>
				version.versionId === versionId ? { ...version, phase: 'loading' as const } : version
			)
		}));
		return { started: true, versionId };
	});
	const showVersions = vi.fn(() =>
		sheetStore.update((state) => ({ ...state, activeTab: 'versions' }))
	);
	const showDetails = vi.fn(() =>
		sheetStore.update((state) => ({ ...state, activeTab: 'details' }))
	);
	const controller = {
		subscribe: sheetStore.subscribe,
		select,
		showVersions,
		showDetails
	} as unknown as LibraryAlbumController;
	const actionController = {
		subscribe: actionStore.subscribe,
		execute,
		cancel,
		reset
	} as unknown as AlbumActionController;
	const rendered = render(UnifiedAlbumPage, {
		props: {
			controller,
			actionController,
			zones,
			focusSongTitle,
			backLabel: 'Albums',
			...callbacks,
			...extraProps
		}
	});
	return {
		...rendered,
		sheetStore,
		actionStore,
		execute,
		cancel,
		reset,
		select,
		showVersions,
		showDetails,
		...callbacks
	};
}

describe('UnifiedAlbumPage', () => {
	it('renders as a page (no modal) and leaves through the back control', async () => {
		const harness = makeHarness(sheetState());
		const page = screen.getByTestId('unified-album-page');
		expect(page.querySelector('.pleft > .art')).not.toBeNull();
		expect(page.querySelector('.pleft > .pb')).not.toBeNull();
		expect(page.querySelector('.pright')).not.toBeNull();
		// The entity owns the content pane: no dialog role, no scrim.
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(document.querySelector('[aria-modal="true"]')).toBeNull();
		expect(screen.getByTestId('unified-album-loading')).toBeInTheDocument();
		const back = screen.getByTestId('unified-album-back');
		expect(back).toHaveTextContent('Albums');
		await fireEvent.click(back);
		expect(harness.onBack).toHaveBeenCalledTimes(1);
	});

	it('moves focus to the page heading on open', async () => {
		makeHarness(resolvedState());
		await waitFor(() => {
			expect(document.activeElement).toBe(screen.getByTestId('unified-album-title'));
		});
	});

	it('lists every version with honest fallback labels and selects the exact row', async () => {
		const harness = makeHarness(
			sheetState({
				phase: 'versions',
				activeTab: 'versions',
				artist: 'Björk',
				title: 'Debut',
				versions: [
					{
						versionId: VERSION_A,
						editionText: '',
						imageKeyHint: 'same-artwork',
						phase: 'idle',
						trackCount: null,
						code: null,
						error: null
					},
					{
						versionId: VERSION_B,
						editionText: '2011 Remaster',
						imageKeyHint: 'same-artwork',
						phase: 'idle',
						trackCount: null,
						code: null,
						error: null
					}
				]
			})
		);

		expect(screen.getByTestId('unified-album-tab-versions')).toHaveTextContent('Versions (2)');
		expect(screen.getByTestId('unified-album-version-0')).toHaveTextContent('Version 1');
		expect(screen.getByTestId('unified-album-version-1')).toHaveTextContent('2011 Remaster');
		await fireEvent.click(screen.getByTestId('unified-album-version-1'));
		expect(harness.cancel).toHaveBeenCalledTimes(1);
		expect(harness.reset).toHaveBeenCalledTimes(1);
		expect(harness.select).toHaveBeenCalledWith(VERSION_B);
		expect(screen.getByTestId('unified-album-detail-loading')).toHaveTextContent(
			'Loading 2011 Remaster'
		);
		expect(screen.getByTestId('unified-album-tab-details')).toHaveClass('on');
	});

	it('renders source, date, duration, availability, and play-state metadata on the shared page', async () => {
		const base = resolvedState();
		const version = {
			...base.versions[0],
			editionText: 'Deluxe',
			sourceLabel: 'Local',
			releaseDate: '1993-07-05',
			durationSeconds: 401,
			available: false,
			playCount: 4,
			lastPlayedAt: '2026-08-01T12:30:00.000Z',
			isFavorite: true,
			isListenLater: true
		};
		makeHarness({ ...base, versions: [version] });

		expect(screen.getByTestId('unified-album-selected-version')).toHaveTextContent('Deluxe');
		expect(screen.getByTestId('unified-album-selected-version')).toHaveTextContent(
			'2 tracks · 6:41 · 1993-07-05 · Local · Unavailable · Favorite · Listen Later · 4 plays · Last played 2026-08-01'
		);

		await fireEvent.click(screen.getByRole('button', { name: /Versions/u }));
		expect(screen.getByTestId('unified-album-version-0')).toHaveTextContent('Deluxe');
		expect(screen.getByTestId('unified-album-version-0')).toHaveTextContent('1993-07-05');
	});

	it('keeps failed rows retryable while other versions remain available', async () => {
		const harness = makeHarness(
			sheetState({
				phase: 'versions',
				activeTab: 'versions',
				artist: 'Björk',
				title: 'Debut',
				versions: [
					{
						versionId: VERSION_A,
						editionText: '',
						phase: 'failed',
						trackCount: null,
						code: 'DETAIL_INCOMPLETE',
						error: 'That version could not be read'
					},
					{
						versionId: VERSION_B,
						editionText: '',
						phase: 'loaded',
						trackCount: 11,
						code: null,
						error: null
					}
				]
			})
		);

		expect(screen.getByTestId('unified-album-version-0')).toHaveTextContent(
			'That version could not be read'
		);
		expect(screen.getByTestId('unified-album-version-0')).toHaveTextContent('Retry');
		expect(screen.getByTestId('unified-album-version-1')).toHaveTextContent('11 tracks');
		await fireEvent.click(screen.getByTestId('unified-album-version-0'));
		expect(harness.select).toHaveBeenCalledWith(VERSION_A);
	});

	it('switches tabs without discarding the selected version tracks', async () => {
		const harness = makeHarness(resolvedState());
		await fireEvent.click(screen.getByTestId('unified-album-tab-versions'));
		expect(harness.showVersions).toHaveBeenCalledTimes(1);
		expect(screen.getByTestId('unified-album-version-0')).toHaveClass('selected');
		await fireEvent.click(screen.getByTestId('unified-album-tab-details'));
		expect(harness.showDetails).toHaveBeenCalledTimes(1);
		expect(screen.getByTestId('unified-album-tracks')).toHaveTextContent('Track 2');
	});

	it('surfaces failures with a retry affordance', async () => {
		const harness = makeHarness(
			sheetState({ phase: 'failed', code: 'OPEN_FAILED', error: 'The album read failed' })
		);
		expect(screen.getByTestId('unified-album-error')).toHaveTextContent(
			'The album read failed'
		);
		await fireEvent.click(screen.getByTestId('unified-album-retry'));
		expect(harness.onRetry).toHaveBeenCalledTimes(1);
	});

	it('renders the resolved album and starts single-zone actions directly', async () => {
		const harness = makeHarness(resolvedState());

		expect(screen.getByTestId('unified-album-title')).toHaveTextContent('Debut');
		expect(screen.getByTestId('unified-album-artist')).toHaveTextContent('Björk');
		expect(screen.queryByTestId('unified-album-zone-picker')).toBeNull();

		await fireEvent.click(screen.getByTestId('unified-album-artist-link'));
		expect(harness.onOpenArtist).toHaveBeenCalledTimes(1);

		await fireEvent.click(screen.getByTestId('unified-album-play'));
		expect(harness.onBeginAction).toHaveBeenNthCalledWith(
			1,
			null,
			'zone-1',
			'play-now'
		);

		await fireEvent.click(screen.getByTestId('unified-album-queue'));
		expect(harness.onBeginAction).toHaveBeenNthCalledWith(2, null, 'zone-1', 'queue');

		await fireEvent.click(screen.getByTestId('unified-track-action-1'));
		expect(harness.onBeginAction).toHaveBeenNthCalledWith(
			3,
			{ index: 1, title: 'Track 2' },
			'zone-1',
			'play-now'
		);
		await fireEvent.click(screen.getByTestId('unified-track-queue-1'));
		expect(harness.onBeginAction).toHaveBeenNthCalledWith(
			4,
			{ index: 1, title: 'Track 2' },
			'zone-1',
			'queue'
		);
		expect(screen.queryByTestId('unified-album-zone-picker')).toBeNull();
	});

	it('renders fallback tracks while disabling actions without public authority', async () => {
		const harness = makeHarness(
			sheetState({
				phase: 'details',
				artist: 'Lio-Marcus Mendel',
				title: 'Hamilton',
				actionsAvailable: false,
				orderedTracks: [
					{ index: 0, title: 'Alexander Hamilton' },
					{ index: 1, title: 'Satisfied' }
				]
			})
		);

		expect(screen.getByTestId('unified-album-tracks')).toHaveTextContent('Satisfied');
		expect(screen.getByTestId('unified-album-play')).toBeDisabled();
		expect(screen.getByTestId('unified-album-queue')).toBeDisabled();
		expect(screen.getByTestId('unified-track-action-1')).toBeDisabled();
		expect(screen.getByTestId('unified-track-queue-1')).toBeDisabled();

		await fireEvent.click(screen.getByTestId('unified-album-play'));
		await fireEvent.click(screen.getByTestId('unified-track-action-1'));
		expect(harness.onBeginAction).not.toHaveBeenCalled();
	});

	it('routes multi-zone actions through the zone picker', async () => {
		const harness = makeHarness(resolvedState(), actionState(), [
			{ zoneId: 'zone-1', name: 'Kitchen' },
			{ zoneId: 'zone-2', name: 'Office' }
		]);

		await fireEvent.click(screen.getByTestId('unified-track-queue-0'));
		expect(harness.onBeginAction).not.toHaveBeenCalled();
		const picker = screen.getByTestId('unified-album-zone-picker');
		expect(picker).toHaveTextContent('Queue “Track 1” on');

		await fireEvent.click(screen.getByRole('button', { name: 'Office' }));
		expect(harness.onBeginAction).toHaveBeenCalledWith(
			{ index: 0, title: 'Track 1' },
			'zone-2',
			'queue'
		);
		expect(screen.queryByTestId('unified-album-zone-picker')).toBeNull();
	});

	it('pages long track lists and resets paging when a new album resolves', async () => {
		const harness = makeHarness(resolvedState(250));

		const pager = screen.getByTestId('unified-album-pager');
		expect(pager).toHaveTextContent('Page 1 of 3');
		expect(screen.getByTestId('unified-album-tracks')).toHaveAttribute('start', '1');
		expect(screen.queryByTestId('unified-track-action-100')).toBeNull();

		await fireEvent.click(screen.getByRole('button', { name: 'Next' }));
		expect(pager).toHaveTextContent('Page 2 of 3');
		expect(screen.getByTestId('unified-album-tracks')).toHaveAttribute('start', '101');
		expect(screen.getByTestId('unified-track-action-100')).toBeInTheDocument();

		// A different (shorter) resolution cannot inherit a stale page index.
		harness.sheetStore.set(resolvedState(1));
		await screen.findByText('Track 1');
		expect(screen.queryByTestId('unified-album-pager')).toBeNull();
		expect(screen.getByTestId('unified-track-action-0')).toBeInTheDocument();
	});

	it('opens the containing page and highlights one normalized song-title match', async () => {
		const scrollIntoView = vi.fn();
		const originalScrollIntoView = Object.getOwnPropertyDescriptor(
			HTMLElement.prototype,
			'scrollIntoView'
		);
		Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
			configurable: true,
			value: scrollIntoView
		});
		makeHarness(
			resolvedState(250),
			actionState(),
			[{ zoneId: 'zone-1', name: 'Kitchen' }],
			'  TRACK   151 '
		);

		const row = await screen.findByTestId('unified-track-row-150');
		expect(screen.getByTestId('unified-album-pager')).toHaveTextContent('Page 2 of 3');
		expect(row).toHaveClass('song-focus');
		expect(row).toHaveAttribute('data-song-highlight', 'true');
		await waitFor(() => {
			expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
		});
		if (originalScrollIntoView) {
			Object.defineProperty(
				HTMLElement.prototype,
				'scrollIntoView',
				originalScrollIntoView
			);
		} else {
			delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
		}
	});

	it('leaves ambiguous normalized song-title matches unhighlighted', async () => {
		const state = resolvedState(250);
		const tracks = [...state.orderedTracks];
		tracks[0] = { index: 0, title: 'Home' };
		tracks[150] = { index: 150, title: '  HOME  ' };
		makeHarness(
			{ ...state, orderedTracks: tracks },
			actionState(),
			[{ zoneId: 'zone-1', name: 'Kitchen' }],
			'Home'
		);

		expect(screen.getByTestId('unified-album-pager')).toHaveTextContent('Page 1 of 3');
		expect(screen.getByTestId('unified-track-row-0')).not.toHaveClass('song-focus');
		expect(document.querySelector('[data-song-highlight="true"]')).toBeNull();
	});

	it('highlights one live ordinal-prefixed track title when no exact title exists', async () => {
		const state = resolvedState();
		const tracks = [...state.orderedTracks];
		tracks[0] = { index: 0, title: '1. So What' };
		tracks[1] = { index: 1, title: '2. Freddie Freeloader' };
		makeHarness(
			{ ...state, orderedTracks: tracks },
			actionState(),
			[{ zoneId: 'zone-1', name: 'Kitchen' }],
			'So What'
		);

		expect(screen.getByTestId('unified-track-row-0')).toHaveClass('song-focus');
		expect(screen.getByTestId('unified-track-row-0')).toHaveAttribute(
			'data-song-highlight',
			'true'
		);
	});

	it('prefers one exact title over an ordinal-prefixed fallback', async () => {
		const state = resolvedState();
		const tracks = [...state.orderedTracks];
		tracks[0] = { index: 0, title: 'So What' };
		tracks[1] = { index: 1, title: '1. So What' };
		makeHarness(
			{ ...state, orderedTracks: tracks },
			actionState(),
			[{ zoneId: 'zone-1', name: 'Kitchen' }],
			'So What'
		);

		expect(screen.getByTestId('unified-track-row-0')).toHaveClass('song-focus');
		expect(screen.getByTestId('unified-track-row-1')).not.toHaveClass('song-focus');
	});

	it('leaves ambiguous ordinal-prefixed title matches unhighlighted', async () => {
		const state = resolvedState();
		const tracks = [...state.orderedTracks];
		tracks[0] = { index: 0, title: '1. Home' };
		tracks[1] = { index: 1, title: '2. Home' };
		makeHarness(
			{ ...state, orderedTracks: tracks },
			actionState(),
			[{ zoneId: 'zone-1', name: 'Kitchen' }],
			'Home'
		);

		expect(document.querySelector('[data-song-highlight="true"]')).toBeNull();
	});

	it('delegates action choices to the action controller and blocks re-entry while busy', async () => {
		const harness = makeHarness(
			resolvedState(),
			actionState({
				phase: 'choosing',
				actions: [
					{ actionId: 'action-play', label: 'Play Now' },
					{ actionId: 'action-queue', label: 'Queue' }
				]
			})
		);

		await fireEvent.click(
			screen
				.getByTestId('unified-album-action-choices')
				.querySelector('button:nth-of-type(2)')!
		);
		expect(harness.execute).toHaveBeenCalledWith('action-queue');
		await fireEvent.click(
			screen.getByTestId('unified-album-action-choices').querySelector('button.ghost')!
		);
		expect(harness.cancel).toHaveBeenCalledTimes(1);

		expect(screen.getByTestId('unified-album-play')).toBeDisabled();
		await fireEvent.click(screen.getByTestId('unified-track-action-0'));
		expect(harness.onBeginAction).not.toHaveBeenCalled();

		harness.actionStore.set(
			actionState({ phase: 'failed', error: 'The zone rejected the action' })
		);
		expect(await screen.findByTestId('unified-album-action-error')).toHaveTextContent(
			'The zone rejected the action'
		);
	});

	it('suppresses the row index when every track on the page carries its own ordinal', () => {
		makeHarness(
			sheetState({
				phase: 'details',
				artist: 'Miles Davis',
				title: "'Round About Midnight",
				actionsAvailable: true,
				orderedTracks: [
					{ index: 0, title: "1. 'Round Midnight" },
					{ index: 1, title: '2. Ah-Leu-Cha' }
				]
			})
		);
		const list = screen.getByTestId('unified-album-tracks');
		expect(list.querySelectorAll('.tn')).toHaveLength(0);
		// Roon's title renders byte-for-byte in both branches.
		expect(screen.getByText("1. 'Round Midnight")).toBeInTheDocument();
		expect(screen.getByText('2. Ah-Leu-Cha')).toBeInTheDocument();
	});

	it('keeps the row index on every row when one title on the page lacks an ordinal', () => {
		makeHarness(
			sheetState({
				phase: 'details',
				artist: 'Miles Davis',
				title: "'Round About Midnight",
				actionsAvailable: true,
				orderedTracks: [
					{ index: 0, title: "1. 'Round Midnight" },
					{ index: 1, title: 'A Plain Title' }
				]
			})
		);
		// Per-page, never per-row: a mixed page keeps the index on ALL rows,
		// including the ordinal-carrying one, so the title column cannot jag.
		expect(screen.getByTestId('unified-album-tracks').querySelectorAll('.tn')).toHaveLength(2);
	});

	it('keeps the row index when no titles carry ordinals', () => {
		makeHarness(resolvedState(3));
		expect(screen.getByTestId('unified-album-tracks').querySelectorAll('.tn')).toHaveLength(3);
	});

	it('hides the editorial review on multi-version pages', () => {
		const ready = {
			phase: 'ready',
			requestId: 'r-1',
			sessionId: 's-1',
			generation: 4,
			view: {
				kind: 'album',
				title: 'Debut',
				subtitle: 'Björk',
				sections: {
					review: { text: 'A confident debut.', source: 'AllMusic', language: 'en' }
				}
			},
			code: null,
			section: null,
			retryable: false,
			error: null
		};
		const multi = resolvedState();
		makeHarness(
			{
				...multi,
				versions: [
					...multi.versions,
					{
						versionId: VERSION_B,
						editionText: 'Deluxe Edition',
						phase: 'idle',
						trackCount: null,
						code: null,
						error: null
					}
				]
			},
			actionState(),
			[],
			null,
			{ editorial: ready }
		);
		// The prose was resolved from the anchor identity only (ri3-1): a
		// page with more than one version renders no editorial surface.
		expect(screen.queryByTestId('unified-album-review')).toBeNull();
		expect(screen.queryByTestId('unified-album-review-failed')).toBeNull();
		expect(screen.queryByTestId('unified-album-credits')).toBeNull();
	});

	it('offers exact-track info only on single-version pages and reports the zero-based position', async () => {
		const onOpenTrackInfo = vi.fn();
		const first = makeHarness(resolvedState(3), actionState(), [], null, { onOpenTrackInfo });
		await fireEvent.click(screen.getByTestId('unified-track-info-2'));
		expect(onOpenTrackInfo).toHaveBeenCalledWith(2);
		first.unmount();
		// A multi-version page has no exact album/version/index binding.
		const multi = resolvedState();
		makeHarness(
			{
				...multi,
				versions: [
					...multi.versions,
					{
						versionId: VERSION_B,
						editionText: 'Deluxe Edition',
						phase: 'idle',
						trackCount: null,
						code: null,
						error: null
					}
				]
			},
			actionState(),
			[],
			null,
			{ onOpenTrackInfo }
		);
		expect(screen.queryByTestId('unified-track-info-0')).toBeNull();
	});

	it('opens the track child view from public data alone', async () => {
		const onOpenTrackInfo = vi.fn();
		const onEditorialBack = vi.fn();
		makeHarness(resolvedState(3), actionState(), [], null, {
			onOpenTrackInfo,
			onEditorialBack
		});
		// No editorial at all (public build): the child still opens with
		// the page's own exact track title (ri5-2).
		await fireEvent.click(screen.getByTestId('unified-track-info-1'));
		expect(screen.getByTestId('unified-album-track-info').textContent).toContain('Track 2');
		expect(screen.queryByTestId('unified-album-track-credits')).toBeNull();
		await fireEvent.click(screen.getByTestId('unified-album-track-info-back'));
		expect(onEditorialBack).toHaveBeenCalledTimes(1);
		expect(screen.queryByTestId('unified-album-track-info')).toBeNull();
	});

	it('layers exact-track credits onto the public child view', async () => {
		const trackView = {
			phase: 'ready',
			requestId: 'r-3',
			sessionId: 's-1',
			generation: 4,
			view: {
				kind: 'track',
				title: 'Track 2',
				subtitle: 'Debut',
				sections: {
					description: {
						text: 'A three-part suite for piano.',
						source: 'Rovi',
						language: 'en'
					}
				},
				creditGroups: [
					{
						label: 'Composer',
						credits: [{ role: '', name: 'Björk', followTarget: 'bt-9' }]
					}
				]
			},
			code: null,
			section: null,
			retryable: false,
			error: null
		};
		makeHarness(resolvedState(3), actionState(), [], null, {
			editorial: trackView,
			onOpenTrackInfo: vi.fn()
		});
		await fireEvent.click(screen.getByTestId('unified-track-info-1'));
		expect(screen.getByTestId('unified-album-track-info').textContent).toContain('Track 2');
		expect(
			screen.getByTestId('unified-album-track-credits-group-0').textContent
		).toContain('Björk');
		// The Work description rides the same exact track (Slice 6).
		expect(screen.getByTestId('unified-album-track-description-text').textContent).toBe(
			'A three-part suite for piano.'
		);
		// The album's own sections make way for the track child view.
		expect(screen.queryByTestId('unified-album-review')).toBeNull();
		expect(screen.queryByTestId('unified-album-credits')).toBeNull();
	});

	it('names the performer back destination from the live child context', async () => {
		const followed = {
			phase: 'ready',
			requestId: 'r-4',
			sessionId: 's-1',
			generation: 4,
			view: {
				kind: 'artist',
				title: 'Björk',
				sections: {}
			},
			code: null,
			section: null,
			retryable: false,
			error: null
		};
		makeHarness(resolvedState(3), actionState(), [], null, {
			editorial: followed,
			onOpenTrackInfo: vi.fn()
		});
		// Follow context: the performer was reached from a live track child.
		await fireEvent.click(screen.getByTestId('unified-track-info-0'));
		expect(
			screen.getByTestId('unified-album-credit-performer-back').textContent?.trim()
		).toBe('Back to track credits');
	});

	it('shows a followed credit performer with a way back to the album view', async () => {
		const followed = {
			phase: 'ready',
			requestId: 'r-2',
			sessionId: 's-1',
			generation: 4,
			view: {
				kind: 'artist',
				title: 'Olaf Otto Becker',
				sections: {
					biography: { text: 'A recording engineer.', source: 'AllMusic', language: 'en' }
				}
			},
			code: null,
			section: null,
			retryable: false,
			error: null
		};
		const onEditorialBack = vi.fn();
		makeHarness(resolvedState(), actionState(), [], null, {
			editorial: followed,
			onEditorialBack
		});
		expect(screen.getByTestId('unified-album-credit-performer').textContent).toContain(
			'Olaf Otto Becker'
		);
		expect(
			screen.getByTestId('unified-album-performer-biography-text').textContent
		).toBe('A recording engineer.');
		// The album's own sections make way for the followed performer.
		expect(screen.queryByTestId('unified-album-review')).toBeNull();
		expect(screen.queryByTestId('unified-album-credits')).toBeNull();
		await fireEvent.click(screen.getByTestId('unified-album-credit-performer-back'));
		expect(onEditorialBack).toHaveBeenCalledTimes(1);
	});

	it('shows the editorial review inside Details and nothing without one', () => {
		const ready = {
			phase: 'ready',
			requestId: 'r-1',
			sessionId: 's-1',
			generation: 4,
			view: {
				kind: 'album',
				title: 'Debut',
				subtitle: 'Björk',
				sections: {
					review: { text: 'A confident debut.', source: 'AllMusic', language: 'en' }
				},
				attribution: [{ text: 'AllMusic' }]
			},
			code: null,
			section: null,
			retryable: false,
			error: null
		};
		const first = makeHarness(resolvedState(), actionState(), [], null, { editorial: ready });
		expect(screen.getByTestId('unified-album-review-text').textContent).toBe(
			'A confident debut.'
		);
		first.unmount();
		// No enrichment: the Details tab renders no editorial surface at all.
		makeHarness(resolvedState());
		expect(screen.queryByTestId('unified-album-review')).toBeNull();
		expect(screen.queryByTestId('unified-album-review-failed')).toBeNull();
	});
});
