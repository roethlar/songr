import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { createRawSnippet, tick } from 'svelte';
import { get, writable } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Zone } from '@shared/types';

const { gotoMock } = vi.hoisted(() => ({ gotoMock: vi.fn() }));
const pageState = writable<{ url: URL; state?: App.PageState }>({
	url: new URL('http://localhost/library')
});

vi.mock('$app/navigation', () => ({ goto: gotoMock }));
vi.mock('$app/stores', () => ({
	page: {
		subscribe: (run: (value: { url: URL; state?: App.PageState }) => void) =>
			pageState.subscribe(run)
	}
}));

import { createFakeSocket } from '../../test/fixtures/socket';
const fakeSocket = createFakeSocket();

vi.mock('$lib/socket/client', () => ({ getSocket: () => fakeSocket }));
vi.mock('$lib/socket/register', () => ({ registerSocketHandlers: vi.fn(() => vi.fn()) }));
vi.mock('$lib/media/mediaSessionBinding', () => ({
	startMediaSessionBinding: vi.fn(() => vi.fn())
}));
const { stopSpacebarMock } = vi.hoisted(() => ({ stopSpacebarMock: vi.fn() }));
vi.mock('$lib/media/spacebarPlayPause', () => ({
	startSpacebarPlayPause: vi.fn(() => stopSpacebarMock)
}));
const { stopDocumentTitleMock } = vi.hoisted(() => ({ stopDocumentTitleMock: vi.fn() }));
vi.mock('$lib/media/documentTitle', () => ({
	startDocumentTitleBinding: vi.fn(() => stopDocumentTitleMock)
}));
vi.mock('$lib/socket/emit', () => ({
	emitWithAck: vi.fn().mockResolvedValue({ success: true })
}));
vi.mock('$lib/stores', async (importOriginal) => {
	const stores = await importOriginal<typeof import('$lib/stores')>();
	return { ...stores, initializeStores: vi.fn().mockResolvedValue(undefined) };
});

import Layout from '../+layout.svelte';
import { startDocumentTitleBinding } from '$lib/media/documentTitle';
import { startSpacebarPlayPause } from '$lib/media/spacebarPlayPause';
import { emitWithAck } from '$lib/socket/emit';
import { setCoreStatus } from '$lib/stores/coreStore';
import { clearCommandFeedback } from '$lib/stores/commandFeedbackStore';
import { setHealth } from '$lib/stores/healthStore';
import {
	claimLibraryViewHost,
	type LibraryViewHostPublisher
} from '$lib/stores/libraryViewHostStore';
import {
	pendingLibraryIntentStore,
	resetLibraryIntentStore
} from '$lib/stores/libraryIntentStore';
import { resetNowPlaying, setNowPlaying } from '$lib/stores/nowPlayingStore';
import { closeNowPlayingOverlay } from '$lib/stores/nowPlayingOverlayStore';
import { resetOnboardingStatus } from '$lib/stores/onboardingStore';
import { resetQueue } from '$lib/stores/queueStore';
import { selectedZoneStore, setSelectedZone } from '$lib/stores/selectedZoneStore';
import { setSocketStatus } from '$lib/stores/socketStatusStore';
import { closeZoneGrouping } from '$lib/stores/zoneGroupingStore';
import { setZonesSnapshot } from '$lib/stores/zonesStore';

const childrenSnippet = createRawSnippet(() => ({
	render: () => '<div data-testid="route-child">child</div>'
}));

function renderLayout() {
	return render(Layout, { props: { children: childrenSnippet } });
}

function makeZone(overrides: Partial<Zone> = {}): Zone {
	return {
		zone_id: overrides.zone_id ?? 'zone-a',
		display_name: overrides.display_name ?? 'Living Room',
		state: overrides.state ?? 'playing',
		seek_position: overrides.seek_position ?? 30,
		is_play_allowed: overrides.is_play_allowed ?? true,
		is_pause_allowed: overrides.is_pause_allowed ?? true,
		is_previous_allowed: overrides.is_previous_allowed ?? true,
		is_next_allowed: overrides.is_next_allowed ?? true,
		is_seek_allowed: overrides.is_seek_allowed ?? true,
		queue_items_remaining: overrides.queue_items_remaining,
		settings: overrides.settings,
		outputs: overrides.outputs ?? []
	};
}

function seedTransport(outputs: Zone['outputs'] = []): void {
	setZonesSnapshot([makeZone({ outputs })]);
	setSelectedZone('zone-a');
	setNowPlaying('zone-a', {
		zone_id: 'zone-a',
		state: 'playing',
		title: 'Song for the Unified Shell',
		artist: 'Alicia Keys / Jay-Z',
		album: 'Unified Record',
		duration: 240,
		seek_position: 30
	});
}

describe('Unified-only layout', () => {
	let libraryHost: LibraryViewHostPublisher;

	beforeEach(() => {
		pageState.set({ url: new URL('http://localhost/library') });
		libraryHost = claimLibraryViewHost();
		libraryHost.publishActiveMode('unified');
		gotoMock.mockReset();
		vi.mocked(startSpacebarPlayPause).mockClear();
		stopSpacebarMock.mockClear();
		vi.mocked(startDocumentTitleBinding).mockClear();
		stopDocumentTitleMock.mockClear();
		fakeSocket.connected = true;
		fakeSocket.emit.mockReset();
		vi.mocked(emitWithAck).mockReset();
		vi.mocked(emitWithAck).mockResolvedValue({ success: true });
		setCoreStatus({
			status: 'paired',
			core: { id: 'core-a', displayName: 'Core Q', displayVersion: '2.0' }
		});
		setSocketStatus('connected');
		setHealth(null);
		setZonesSnapshot([]);
		setSelectedZone('');
		resetNowPlaying();
		resetQueue();
		resetLibraryIntentStore();
		resetOnboardingStatus();
		closeNowPlayingOverlay();
		closeZoneGrouping();
		clearCommandFeedback();
	});

	afterEach(() => {
		cleanup();
		libraryHost.release();
	});

	it('starts one Space play/pause shortcut for the shell and stops it on teardown', async () => {
		const { unmount } = renderLayout();
		await tick();

		expect(startSpacebarPlayPause).toHaveBeenCalledTimes(1);
		expect(stopSpacebarMock).not.toHaveBeenCalled();

		unmount();

		expect(stopSpacebarMock).toHaveBeenCalledTimes(1);
	});

	it('starts one now-playing tab title for the shell and stops it on teardown', async () => {
		const { unmount } = renderLayout();
		await tick();

		expect(startDocumentTitleBinding).toHaveBeenCalledTimes(1);
		expect(stopDocumentTitleMock).not.toHaveBeenCalled();

		unmount();

		expect(stopDocumentTitleMock).toHaveBeenCalledTimes(1);
	});

	it('renders only the Unified full-bleed shell and transport', async () => {
		const { container } = renderLayout();
		await tick();

		expect(container.querySelector('[data-shell-presentation="unified"]')).not.toBeNull();
		const workspace = container.querySelector(
			'[data-workspace-presentation="full-bleed"]'
		) as HTMLElement;
		expect(workspace).not.toBeNull();
		expect(container.querySelector('[data-transport-presentation="unified"]')).not.toBeNull();
		expect(container.querySelector('aside.sidebar')).toBeNull();
		expect(container.querySelector('header.workspace-header')).toBeNull();
		expect(screen.getByTestId('route-child')).toBeInTheDocument();
	});

	it('keeps the Unified workspace literally full bleed in the style contract', async () => {
		const fs = await import('node:fs');
		const path = await import('node:path');
		const source = fs.readFileSync(
			path.resolve(process.cwd(), 'src/routes/+layout.svelte'),
			'utf8'
		);
		expect(source).toMatch(/\.workspace-main\.full-bleed\s*\{[^}]*padding:\s*0;/s);
	});

	it('uses a neutral shell with no transport outside the active Library', async () => {
		pageState.set({ url: new URL('http://localhost/') });
		const { container } = renderLayout();
		await tick();

		expect(container.querySelector('[data-shell-presentation="neutral"]')).not.toBeNull();
		expect(container.querySelector('[aria-label="Playback controls"]')).toBeNull();
	});

	it('publishes a name-addressed Unified artist intent from transport', async () => {
		seedTransport();
		renderLayout();

		await fireEvent.click(screen.getByRole('button', { name: 'Alicia Keys' }));
		expect(get(pendingLibraryIntentStore)).toMatchObject({
			historyMutation: 'push',
			intent: {
				kind: 'artist',
				destination: 'search',
				query: 'Alicia Keys',
				display: { title: 'Alicia Keys' }
			}
		});
		expect(gotoMock).not.toHaveBeenCalled();
	});

	it('keeps play, seek, and incremental volume controls functional', async () => {
		seedTransport([
			{
				output_id: 'out-a',
				display_name: 'DAC',
				volume: { type: 'incremental', min: -1, max: 1, value: 0, step: 1, is_muted: false }
			}
		]);
		const { container } = renderLayout();

		await fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
		await waitFor(() =>
			expect(emitWithAck).toHaveBeenCalledWith(
				fakeSocket,
				'transport:play-pause',
				{ zone_id: 'zone-a' },
				expect.any(Object)
			)
		);

		await fireEvent.click(screen.getByRole('button', { name: 'Volume down' }));
		await waitFor(() =>
			expect(emitWithAck).toHaveBeenCalledWith(
				fakeSocket,
				'transport:volume',
				expect.objectContaining({ output_id: 'out-a', value: -1 }),
				expect.any(Object)
			)
		);

		const seek = container.querySelector('[aria-label="Seek"]') as HTMLElement;
		seek.getBoundingClientRect = () =>
			({ left: 0, width: 100, top: 0, right: 100, bottom: 3, height: 3, x: 0, y: 0, toJSON() {} }) as DOMRect;
		await fireEvent.click(seek, { clientX: 50 });
		await waitFor(() =>
			expect(emitWithAck).toHaveBeenCalledWith(
				fakeSocket,
				'transport:seek',
				{ zone_id: 'zone-a', seconds: 120 },
				expect.any(Object)
			)
		);
	});

	it('opens grouping and ungroups every output after the first', async () => {
		seedTransport([
			{ output_id: 'out-a', display_name: 'Left' },
			{ output_id: 'out-b', display_name: 'Right' }
		]);
		renderLayout();

		await fireEvent.click(screen.getByRole('button', { name: 'Group zones' }));
		expect(await screen.findByRole('dialog', { name: 'Group zones' })).toBeInTheDocument();
		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

		await fireEvent.click(screen.getByRole('button', { name: 'Ungroup current zone' }));
		await waitFor(() =>
			expect(emitWithAck).toHaveBeenCalledWith(
				fakeSocket,
				'transport:ungroup',
				{ output_ids: ['out-b'] },
				expect.any(Object)
			)
		);
	});

	it('selects zones from the Unified popup menu', async () => {
		setZonesSnapshot([
			makeZone({ zone_id: 'zone-a', display_name: 'Living Room' }),
			makeZone({ zone_id: 'zone-b', display_name: 'Kitchen' })
		]);
		setSelectedZone('zone-a');
		renderLayout();

		await fireEvent.click(
			screen.getByRole('button', { name: 'Select zone, current zone Living Room' })
		);
		await fireEvent.click(screen.getByRole('menuitemradio', { name: 'Kitchen' }));
		expect(get(selectedZoneStore)).toBe('zone-b');
	});

	it('opens and closes the in-surface Queue panel', async () => {
		seedTransport();
		renderLayout();

		await fireEvent.click(screen.getByRole('button', { name: 'Queue' }));
		expect(await screen.findByRole('dialog', { name: 'Queue' })).toBeInTheDocument();
		await fireEvent.click(screen.getByRole('button', { name: 'Close Queue' }));
		expect(screen.queryByRole('dialog', { name: 'Queue' })).toBeNull();
	});
});
