import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { writable, type Writable } from 'svelte/store';

import UnifiedAlbumSheet from '../UnifiedAlbumSheet.svelte';
import type { LibraryAlbumController, LibraryAlbumState } from '$lib/library/LibraryAlbumController';
import type { TimelineAlbumActionController } from '$lib/timeline/TimelineAlbumActionController';

type ActionState = {
	readonly phase: string;
	readonly actions: readonly { actionId: string; label: string }[];
	readonly error: string | null;
};

function sheetState(overrides: Partial<LibraryAlbumState> = {}): LibraryAlbumState {
	return {
		phase: 'resolving',
		albumLocalId: '20000000-0000-4000-8000-000000000001',
		generation: 4,
		requestId: '30000000-0000-4000-8000-000000000001',
		operationId: null,
		resolvingDeadlineAt: null,
		artist: null,
		title: null,
		actionsAvailable: false,
		orderedTracks: [],
		candidates: [],
		code: null,
		error: null,
		transitionedAt: 1,
		...overrides
	} as LibraryAlbumState;
}

function resolvedState(trackCount = 2): LibraryAlbumState {
	return sheetState({
		phase: 'resolved',
		artist: 'Björk',
		title: 'Debut',
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
	focusSongTitle: string | null = null
) {
	const sheetStore: Writable<LibraryAlbumState> = writable(initialSheet);
	const actionStore: Writable<ActionState> = writable(initialAction);
	const execute = vi.fn().mockReturnValue(true);
	const cancel = vi.fn();
	const callbacks = {
		onClose: vi.fn(),
		onRetry: vi.fn(),
		onChooseCandidate: vi.fn(),
		onBeginAction: vi.fn(),
		onOpenArtist: vi.fn()
	};
	const controller = {
		subscribe: sheetStore.subscribe
	} as unknown as LibraryAlbumController;
	const actionController = {
		subscribe: actionStore.subscribe,
		execute,
		cancel
	} as unknown as TimelineAlbumActionController;
	const rendered = render(UnifiedAlbumSheet, {
		props: { controller, actionController, zones, focusSongTitle, ...callbacks }
	});
	return { ...rendered, sheetStore, actionStore, execute, cancel, ...callbacks };
}

describe('UnifiedAlbumSheet', () => {
	it('shows the resolving state and closes from it', async () => {
		const harness = makeHarness(sheetState());
		const sheet = screen.getByTestId('unified-album-sheet');
		expect(sheet).toHaveClass('sheet', 'open');
		expect(sheet.querySelector(':scope > .panel')).not.toBeNull();
		expect(sheet.querySelector('.pleft > .art')).not.toBeNull();
		expect(sheet.querySelector('.pleft > .pb')).not.toBeNull();
		expect(sheet.querySelector('.pright')).not.toBeNull();
		expect(screen.getByTestId('unified-album-loading')).toBeInTheDocument();
		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(harness.onClose).toHaveBeenCalledTimes(1);
	});

	it('offers every ambiguous edition to the chooser verbatim', async () => {
		const candidates = [
			{ title: 'Debut', artist: 'Björk', editionText: '' },
			{ title: 'Debut', artist: 'Björk', editionText: '2011 Remaster' }
		];
		const harness = makeHarness(
			sheetState({ phase: 'failed', code: 'ALBUM_AMBIGUOUS', candidates })
		);

		expect(screen.getByTestId('unified-album-ambiguous')).toBeInTheDocument();
		const options = screen
			.getByTestId('unified-album-candidates')
			.querySelectorAll('button.candidate');
		expect(options).toHaveLength(2);
		await fireEvent.click(options[1]);
		expect(harness.onChooseCandidate).toHaveBeenCalledWith(candidates[1]);
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
				phase: 'resolved',
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
				phase: 'resolved',
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
				phase: 'resolved',
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
});
