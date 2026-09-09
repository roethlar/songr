import { activeLibraryScreen } from '../../../test/activeLibraryQueries';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { get, writable } from 'svelte/store';
import { tick } from 'svelte';
import * as pageNavigation from '$lib/libraryPageNavigation';
import * as creditModel from '$lib/albumArtistGroups';
import { encodeLibraryRoute, type LibraryRoute } from '$lib/libraryRoute';
import { LIBRARY_OPEN_CONTRACT, type LibraryOpenResponse } from '@shared/libraryOpenContracts';
import { libraryPageStateFromRoute } from '$lib/libraryRouteState';
import type { PaletteSearchState } from '$lib/stores/unifiedPaletteSearchStore';
import { __getNavigationLog, __resetNavigation } from '../../../test/app-stubs/navigation';
import { deferred, fakeConnectionSocket, fakeNamedCountsStore, harnessAlbum, liveOpenResponder, liveRootsState, mountMode, type HarnessLiveLibrary } from './unifiedLibraryModeHarness';

const library: HarnessLiveLibrary = {
	generation: 'gen-1',
	artists: [
		{ name: 'Lead', albums: [harnessAlbum('Not the Albums-root row', 'Someone else')], albumCount: 1 },
		{ name: 'Contributor only', albums: [], albumCount: 1 }
	],
	albums: [harnessAlbum('Actual album', 'Lead'), harnessAlbum('Shared one', 'Shared'),
		harnessAlbum('Shared two', 'Shared'), harnessAlbum('Collaboration', 'A / B'),
		harnessAlbum('No credit', ''), harnessAlbum('Named unknown', 'Unknown album artist')]
};

function mountCredit(options: Parameters<typeof mountMode>[0] = {}) {
	const socket = fakeConnectionSocket();
	socket.connected = true;
	return { socket, ...mountMode({ artistViewPreference: null, liveLibrary: library,
		getSocketClient: () => socket, ...options }) };
}

function group(label: string): HTMLElement {
	return activeLibraryScreen.getAllByTestId('unified-credit-artist').find(row =>
		row.querySelector('.an')?.textContent === label)!;
}

async function ready(): Promise<void> {
	await waitFor(() => expect(activeLibraryScreen.getAllByTestId('unified-credit-artist')).toHaveLength(5));
}

function restore(harness: ReturnType<typeof mountCredit>, route: LibraryRoute) {
	harness.registered.lifecycle!.resume({ cause: 'initial', pageState: libraryPageStateFromRoute(route) });
}

beforeEach(() => {
	__resetNavigation('http://localhost/library/album-artists');
	pageNavigation.clearPendingLibraryPageStateWrite();
});
afterEach(() => { vi.restoreAllMocks(); });

function coldRoots() {
	return { ...liveRootsState(library), phase: 'loading' as const, generation: null,
		artists: [], albums: [], artistRows: [], albumRows: [] };
}

function creditRoute(uncredited = false, track = false): LibraryRoute {
	const selector = uncredited ? { kind: 'uncredited' as const } : { kind: 'credit' as const, credit: 'Lead' };
	const album = { title: uncredited ? 'No credit' : 'Actual album', credit: uncredited ? '' : 'Lead', edition: '' };
	return track ? { kind: 'credit-album-track', selector, album, track: 'Track two' }
		: { kind: 'credit-album', selector, album };
}

const leadRoute: LibraryRoute = { kind: 'credit-group', selector: { kind: 'credit', credit: 'Lead' } };
const sharedRoute: LibraryRoute = { kind: 'credit-group', selector: { kind: 'credit', credit: 'Shared' } };

function composerLevel(root = false): LibraryOpenResponse {
	return { contract: LIBRARY_OPEN_CONTRACT, kind: 'level', generation: 'gen-1',
		title: root ? 'Composers' : 'Philip Glass', count: 1,
		rows: [{ ref: { generation: 'gen-1', token: root ? 'composer:glass' : 'composition:glassworks' },
			title: root ? 'Philip Glass' : 'Glassworks', kind: root ? 'composer' : 'composition' }] };
}

function mountPalette(options: Parameters<typeof mountCredit>[0] = {}) {
	return mountCredit({ withContext: true, loadRoots: vi.fn(async () => {}),
		composersStore: fakeNamedCountsStore([{ label: 'Philip Glass', albumCount: 1, itemKey: 'glass', imageKey: null }]),
		openLiveRoot: async () => composerLevel(true),
		openLiveRef: async (_fetch, ref) => ref.token === 'composer:glass' ? composerLevel() : liveOpenResponder(library)(ref),
		...options });
}

async function enterComposer() {
	await fireEvent.click(screen.getByTestId('unified-find'));
	await fireEvent.input(screen.getByTestId('unified-palette-input'), { target: { value: 'philip glass' } });
	const row = (await activeLibraryScreen.findByText('Composer: Philip Glass')).closest('button')!;
	await fireEvent.mouseMove(row);
	await fireEvent.click(row);
	await waitFor(() => expect(screen.getByTestId('unified-live-collection-page')).toHaveAttribute('data-level-kind', 'composer'));
}

async function searchResults() {
	await fireEvent.click(screen.getByRole('button', { name: '← Search results' }));
	expect(screen.getByTestId('unified-palette-input')).toHaveValue('philip glass');
	expect(activeLibraryScreen.getByText('Composer: Philip Glass').closest('button')).toHaveClass('sel');
}

async function dismissFind() {
	await fireEvent.keyDown(window, { key: 'Escape' });
	expect(screen.queryByTestId('unified-palette')).toBeNull();
}

describe('palette artist-list return context', () => {
	it.each([
		{ name: 'named credit', route: leadRoute, tiles: ['Actual album'], groups: 0, artists: 0 },
		{ name: 'uncredited', route: { kind: 'credit-group', selector: { kind: 'uncredited' } } as LibraryRoute, tiles: ['No credit'], groups: 0, artists: 0 },
		{ name: 'Album artists', route: { kind: 'album-artists-root' } as LibraryRoute, tiles: [], groups: 5, artists: 0 },
		{ name: 'All artists', route: { kind: 'root', scope: 'artists' } as LibraryRoute, tiles: [], groups: 0, artists: 2 }
	])('restores the exact $name list after an excursion without history or preference writes', async ({ route, tiles, groups, artists }) => {
		__resetNavigation(`http://localhost${encodeLibraryRoute(route)}`);
		const harness = mountPalette({ artistViewPreference: 'all-artists' });
		restore(harness, route);
		await enterComposer();
		await searchResults();
		expect(harness.clearPaletteSearchData).not.toHaveBeenCalled();
		expect(harness.resetPaletteSearchData).not.toHaveBeenCalled();
		await dismissFind();
		expect(activeLibraryScreen.queryAllByTestId('unified-tile')).toHaveLength(tiles.length);
		for (const title of tiles) expect(activeLibraryScreen.getByTestId('unified-tile')).toHaveTextContent(title);
		expect(activeLibraryScreen.queryAllByTestId('unified-credit-artist')).toHaveLength(groups);
		expect(activeLibraryScreen.queryAllByTestId('unified-row')).toHaveLength(artists);
		expect(__getNavigationLog()).toEqual([]);
		expect(get(harness.prefsStore).artistView).toBe('all-artists');
		expect(harness.openLiveRef.mock.calls.map(call => call[1].token)).toEqual(['composer:glass']);
	});

	it('repeated excursions and Find reseeding retain the original group', async () => {
		const harness = mountPalette();
		restore(harness, leadRoute);
		await enterComposer();
		await searchResults();
		await fireEvent.click(activeLibraryScreen.getByText('Composer: Philip Glass').closest('button')!);
		await waitFor(() => expect(screen.getByRole('button', { name: '← Search results' })).toBeInTheDocument());
		await fireEvent.click(screen.getByTestId('unified-find'));
		expect(screen.getByTestId('unified-palette-input')).toHaveValue('');
		await dismissFind();
		expect(screen.queryByTestId('unified-live-collection-page')).toBeNull();
		expect(screen.getByTestId('unified-list-heading')).toHaveTextContent('Lead');
		expect(activeLibraryScreen.getByTestId('unified-tile')).toHaveTextContent('Actual album');
		expect(__getNavigationLog()).toEqual([]);
	});

	it.each([false, true])('preserves the credit parent relationship (pushed=%s)', async pushed => {
		const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
		const harness = mountPalette();
		restore(harness, pushed ? { kind: 'album-artists-root' } : leadRoute);
		if (pushed) { await ready(); await fireEvent.click(group('Lead')); }
		await enterComposer();
		await searchResults();
		await dismissFind();
		await fireEvent.click(screen.getByTestId('unified-credit-back'));
		expect(back).toHaveBeenCalledTimes(pushed ? 1 : 0);
		if (!pushed) expect(__getNavigationLog()).toEqual([{ operation: 'replaceState', url: 'http://localhost/library/album-artists', state: {} }]);
	});

	it('restores current roots and not stale membership or a changed preference', async () => {
		const harness = mountPalette();
		restore(harness, leadRoute);
		await enterComposer();
		harness.rootsStore.set(liveRootsState({ ...library, generation: 'gen-2', albums: [harnessAlbum('New credit', 'Changed')] }));
		harness.prefsStore.setArtistView('all-artists');
		await tick();
		await fireEvent.click(screen.getByRole('button', { name: '← Search results' }));
		await dismissFind();
		expect(screen.getByTestId('unified-list-heading')).toHaveTextContent('Lead');
		expect(screen.getByTestId('unified-credit-missing')).toBeInTheDocument();
		expect(activeLibraryScreen.queryAllByTestId('unified-tile')).toHaveLength(0);
		expect(activeLibraryScreen.queryAllByTestId('unified-row')).toHaveLength(0);
		expect(__getNavigationLog()).toEqual([]);
	});

	it.each(['scope', 'suspend'] as const)('discards the old origin on %s replacement before a new excursion', async leave => {
		const harness = mountPalette();
		restore(harness, leadRoute);
		await enterComposer();
		if (leave === 'suspend') {
			harness.registered.lifecycle!.suspend();
			restore(harness, sharedRoute);
		} else {
			await fireEvent.click(screen.getByTestId('unified-scope-albums'));
			await fireEvent.click(screen.getByTestId('unified-scope-artists'));
			await ready();
			await fireEvent.click(group('Shared'));
		}
		await enterComposer();
		await searchResults();
		await dismissFind();
		expect(screen.getByTestId('unified-list-heading')).toHaveTextContent('Shared');
		expect(activeLibraryScreen.getAllByTestId('unified-tile')).toHaveLength(2);
	});

	it('a refused scope write retains the excursion origin for Back', async () => {
		const harness = mountPalette();
		restore(harness, leadRoute);
		await enterComposer();
		vi.spyOn(pageNavigation, 'pushLibraryPageState').mockReturnValue('refused');
		await fireEvent.click(screen.getByTestId('unified-scope-albums'));
		await searchResults();
		await dismissFind();
		expect(screen.getByTestId('unified-list-heading')).toHaveTextContent('Lead');
		expect(__getNavigationLog()).toEqual([]);
	});

	it.each(['return', 'scope', 'suspend'] as const)('late composer read cannot replace the list after %s', async leave => {
		const pending = deferred<LibraryOpenResponse>();
		const harness = mountPalette({ openLiveRef: async () => pending.promise });
		restore(harness, leadRoute);
		await enterComposer();
		await waitFor(() => expect(harness.openLiveRef).toHaveBeenCalledTimes(1));
		if (leave === 'return') { await searchResults(); await dismissFind(); }
		else if (leave === 'scope') await fireEvent.click(screen.getByTestId('unified-scope-albums'));
		else { harness.registered.lifecycle!.suspend(); restore(harness, sharedRoute); }
		pending.resolve(composerLevel());
		await pending.promise;
		await tick();
		expect(screen.queryByTestId('unified-live-collection-page')).toBeNull();
		expect(screen.getByTestId('unified-list-heading')).toHaveTextContent(leave === 'return' ? 'Lead' : leave === 'scope' ? 'Albums' : 'Shared');
		expect(harness.openLiveRef).toHaveBeenCalledTimes(1);
	});

	it('a permanent palette album choice retires the old group context', async () => {
		const harness = mountPalette();
		restore(harness, leadRoute);
		await enterComposer();
		await searchResults();
		await fireEvent.input(screen.getByTestId('unified-palette-input'), { target: { value: 'Shared one' } });
		await fireEvent.click((await activeLibraryScreen.findByText('Shared one')).closest('button')!);
		await waitFor(() => expect(screen.getByTestId('unified-album-tracks')).toBeInTheDocument());
		expect(__getNavigationLog().at(-1)?.url).toContain('/library/albums/');
		await fireEvent.click(screen.getByTestId('unified-find'));
		await dismissFind();
		expect(screen.getByTestId('unified-album-title')).toHaveTextContent('Shared one');
		expect(screen.queryByTestId('unified-credit-back')).toBeNull();
	});

	it('the song-panel composer entry uses the same group return owner', async () => {
		const harness = mountPalette({ paletteSearchStore: writable<PaletteSearchState>({
			phase: 'ready', query: 'opening', error: null,
			groups: [{ title: 'Tracks', rows: [{ resultId: 'opening', title: 'Opening', subtitle: 'Philip Glass', imageKey: null }] }]
		}), songRelationshipClient: { relationship: vi.fn(async () => ({ songTitle: 'Opening', albums: [], composerLabels: ['Philip Glass'] })) } });
		restore(harness, leadRoute);
		await fireEvent.click(screen.getByTestId('unified-find'));
		await fireEvent.input(screen.getByTestId('unified-palette-input'), { target: { value: 'opening' } });
		await fireEvent.click((await activeLibraryScreen.findByText('Opening')).closest('button')!);
		await fireEvent.click(await screen.findByRole('button', { name: 'Philip Glass' }));
		await waitFor(() => expect(screen.getByRole('button', { name: '← Search results' })).toBeInTheDocument());
		await fireEvent.click(screen.getByRole('button', { name: '← Search results' }));
		await dismissFind();
		expect(screen.getByTestId('unified-list-heading')).toHaveTextContent('Lead');
		expect(__getNavigationLog()).toEqual([]);
	});
});

describe('cold credit restoration', () => {
	it.each([
		{ uncredited: false, track: false, rootsFirst: false },
		{ uncredited: false, track: true, rootsFirst: true },
		{ uncredited: true, track: false, rootsFirst: true },
		{ uncredited: true, track: true, rootsFirst: false }
	])('retains the addressed item through delayed roots: %j', async ({ uncredited, track, rootsFirst }) => {
		const route = creditRoute(uncredited, track);
		__resetNavigation(`http://localhost${encodeLibraryRoute(route)}`);
		const harness = mountCredit({ withContext: true, rootsState: coldRoots(),
			artistViewPreference: 'all-artists', loadRoots: vi.fn(async () => {}) });
		harness.socket.connected = false;
		restore(harness, route);
		await tick();
		expect(screen.getByTestId('unified-album-back')).toHaveTextContent(uncredited ? 'Unknown album artist' : 'Lead');
		expect(harness.openLiveRef).not.toHaveBeenCalled();
		const connect = () => { harness.socket.connected = true; harness.socket.emit('connect'); };
		if (!rootsFirst) { connect(); await tick(); }
		harness.rootsStore.set(liveRootsState(library));
		await waitFor(() => expect(screen.getByTestId('unified-album-title')).toHaveTextContent(uncredited ? 'No credit' : 'Actual album'));
		await waitFor(() => expect(screen.getByTestId('unified-album-tracks')).toBeInTheDocument());
		if (track) await waitFor(() => expect(screen.getByTestId('unified-album-track-info')).toHaveTextContent('Track two'));
		else expect(screen.queryByTestId('unified-album-track-info')).toBeNull();
		connect();
		harness.rootsStore.update(state => ({ ...state, readAt: 'confirmed' }));
		await tick();
		await tick();
		const row = liveRootsState(library).albumRows.find(row => row.title === (uncredited ? 'No credit' : 'Actual album'))!;
		expect(harness.openLiveRef.mock.calls.map(call => call[1])).toEqual([row.ref]);
		expect(__getNavigationLog()).toEqual([]);
		expect(get(harness.prefsStore).artistView).toBe('all-artists');
	});

	it('uses ready HTTP-backed roots before socket connect without reopening the track child', async () => {
		const harness = mountCredit({ withContext: true });
		harness.socket.connected = false;
		restore(harness, creditRoute(false, true));
		await waitFor(() => expect(screen.getByTestId('unified-album-track-info')).toHaveTextContent('Track two'));
		expect(harness.socket.connected).toBe(false);
		harness.socket.connected = true;
		harness.socket.emit('connect');
		harness.rootsStore.update(state => ({ ...state, readAt: 'confirmed' }));
		await tick();
		await tick();
		expect(harness.openLiveRef).toHaveBeenCalledTimes(1);
		expect(screen.getByTestId('unified-album-track-info')).toHaveTextContent('Track two');
		expect(__getNavigationLog()).toEqual([]);
	});

	it('keeps missing and unavailable reads explicit instead of showing the parent', async () => {
		const harness = mountCredit({ withContext: true, rootsState: coldRoots(),
			loadRoots: vi.fn(async () => {}), openLiveRef: async () => ({
				contract: LIBRARY_OPEN_CONTRACT, kind: 'unavailable', reason: 'no-core', message: 'Core is unavailable.'
			}) });
		harness.socket.connected = false;
		restore(harness, creditRoute());
		harness.rootsStore.set(liveRootsState(library));
		await waitFor(() => expect(screen.getByTestId('unified-album-error')).toBeInTheDocument());
		expect(screen.getByTestId('unified-album-error')).toHaveTextContent('Core is unavailable.');
		harness.rootsStore.set(liveRootsState({ ...library, generation: 'gen-2', albums: [] }));
		await waitFor(() => expect(screen.getByTestId('unified-album-error')).toHaveTextContent('Roon no longer lists “Actual album”.'));
		expect(harness.openLiveRef).toHaveBeenCalledTimes(1);
	});

	it('Back before roots arrive cancels the retained album address', async () => {
		const harness = mountCredit({ withContext: true, rootsState: coldRoots(), loadRoots: vi.fn(async () => {}) });
		harness.socket.connected = false;
		restore(harness, creditRoute());
		await tick();
		await fireEvent.click(screen.getByTestId('unified-album-back'));
		harness.socket.connected = true;
		harness.socket.emit('connect');
		harness.rootsStore.set(liveRootsState(library));
		await waitFor(() => expect(activeLibraryScreen.getByTestId('unified-tile')).toHaveTextContent('Actual album'));
		expect(screen.getByTestId('unified-list-heading')).toHaveTextContent('Lead');
		expect(harness.openLiveRef).not.toHaveBeenCalled();
		expect(__getNavigationLog().at(-1)).toMatchObject({ operation: 'replaceState', url: 'http://localhost/library/album-artists/credit/Lead' });
	});

	it('suspension retires a pending restore before late roots can issue a read', async () => {
		const harness = mountCredit({ withContext: true, rootsState: coldRoots(), loadRoots: vi.fn(async () => {}) });
		harness.socket.connected = false;
		restore(harness, creditRoute(false, true));
		await tick();
		harness.registered.lifecycle!.suspend();
		await tick();
		harness.rootsStore.set(liveRootsState(library));
		await tick();
		await tick();
		expect(harness.openLiveRef).not.toHaveBeenCalled();
		restore(harness, { kind: 'root', scope: 'albums' });
		await waitFor(() => expect(activeLibraryScreen.getAllByTestId('unified-tile')).toHaveLength(6));
		expect(screen.queryByTestId('unified-album-track-info')).toBeNull();
		expect(__getNavigationLog()).toEqual([]);
	});

	it.each(['suspension', 'scope change'] as const)('a late restored read cannot revive after %s and another destination', async leave => {
		const oldRead = deferred<LibraryOpenResponse>();
		const respond = liveOpenResponder(library);
		const harness = mountCredit({ withContext: true, loadRoots: vi.fn(async () => {}),
			openLiveRef: async (_fetch, ref) => ref.token.includes('Actual album') ? oldRead.promise : respond(ref) });
		harness.socket.connected = false;
		restore(harness, creditRoute(false, true));
		await waitFor(() => expect(harness.openLiveRef).toHaveBeenCalledTimes(1));
		const oldRef = harness.openLiveRef.mock.calls[0][1];
		if (leave === 'suspension') {
			harness.registered.lifecycle!.suspend();
			restore(harness, creditRoute(true));
		} else {
			await fireEvent.click(screen.getByTestId('unified-scope-albums'));
			harness.socket.connected = true;
			harness.socket.emit('connect');
			const tile = activeLibraryScreen.getAllByTestId('unified-tile').find(tile => tile.textContent?.includes('No credit'))!;
			await fireEvent.click(tile);
		}
		await waitFor(() => expect(screen.getByTestId('unified-album-tracks')).toBeInTheDocument());
		const history = [...__getNavigationLog()];
		oldRead.resolve(respond(oldRef));
		await oldRead.promise;
		await tick();
		expect(screen.getByTestId('unified-album-title')).toHaveTextContent('No credit');
		expect(screen.queryByTestId('unified-album-track-info')).toBeNull();
		expect(harness.openLiveRef).toHaveBeenCalledTimes(2);
		expect(__getNavigationLog()).toEqual(history);
	});

	it.each(['group', 'album'] as const)('disconnected interactive %s clicks are not queued', async operation => {
		const harness = mountCredit();
		await ready();
		if (operation === 'album') await fireEvent.click(group('Lead'));
		const history = [...__getNavigationLog()];
		const preference = get(harness.prefsStore).artistView;
		harness.socket.connected = false;
		await fireEvent.click(operation === 'group' ? group('Lead') : activeLibraryScreen.getByTestId('unified-tile'));
		expect(__getNavigationLog()).toEqual(history);
		expect(harness.openLiveRef).not.toHaveBeenCalled();
		expect(get(harness.prefsStore).artistView).toBe(preference);
		harness.socket.connected = true;
		harness.socket.emit('connect');
		harness.rootsStore.set(liveRootsState(library));
		await tick();
		await tick();
		expect(harness.openLiveRef).not.toHaveBeenCalled();
		if (operation === 'album') expect(screen.getByTestId('unified-list-heading')).toHaveTextContent('Lead');
		else await ready();
	});
});

describe('Album artists / All artists', () => {
	it('defaults to album credits, keeps one-release artists, and excludes a contributor-only Roon row', async () => {
		mountCredit();
		await ready();
		expect(screen.getByTestId('unified-artist-view-album-artists')).toHaveAttribute('aria-pressed', 'true');
		expect(screen.getByTestId('unified-summary')).toHaveTextContent('5 GROUPS');
		expect(within(group('Lead')).getByText('1')).toBeInTheDocument();
		expect(group('Contributor only')).toBeUndefined();
		expect(group('A / B')).toBeInTheDocument();
		expect(activeLibraryScreen.getByText('Albums without an artist credit')).toBeInTheDocument();
		expect(activeLibraryScreen.getAllByText('Unknown album artist')).toHaveLength(2);
	});

	it('switches visibly with keyboard activation and remembers only the explicit choice', async () => {
		const harness = mountCredit();
		await ready();
		const user = userEvent.setup();
		screen.getByTestId('unified-artist-view-all-artists').focus();
		await user.keyboard('{Enter}');
		expect(activeLibraryScreen.getAllByTestId('unified-row')).toHaveLength(2);
		expect(screen.getByTestId('unified-summary')).toHaveTextContent('2 TOTAL');
		expect(activeLibraryScreen.getByText('Contributor only')).toBeInTheDocument();
		expect(get(harness.prefsStore).artistView).toBe('all-artists');
		expect(__getNavigationLog().at(-1)?.url).toBe('http://localhost/library/artists');
		await fireEvent.click(screen.getByTestId('unified-artist-view-album-artists'));
		await ready();
		expect(get(harness.prefsStore).artistView).toBe('album-artists');
		await fireEvent.click(screen.getByTestId('unified-scope-albums'));
		await fireEvent.click(screen.getByTestId('unified-scope-artists'));
		await ready();
	});

	it('keeps the missing-credit page distinct from the literal Unknown album artist group', async () => {
		const harness = mountCredit({ withContext: true });
		restore(harness, { kind: 'credit-group', selector: { kind: 'uncredited' } });
		await waitFor(() => expect(activeLibraryScreen.getByTestId('unified-tile')).toHaveTextContent('No credit'));
		expect(screen.getByTestId('unified-credit-description')).toHaveTextContent('Albums without an artist credit');
		harness.registered.lifecycle!.suspend();
		restore(harness, { kind: 'credit-group', selector: { kind: 'credit', credit: 'Unknown album artist' } });
		await waitFor(() => expect(activeLibraryScreen.getByTestId('unified-tile')).toHaveTextContent('Named unknown'));
		expect(screen.queryByTestId('unified-credit-description')).toBeNull();
	});

	it('does not regroup unchanged snapshots for sorts, density, or root confirmation metadata', async () => {
		const regroup = vi.spyOn(creditModel, 'groupAlbumArtists');
		const harness = mountCredit();
		await ready();
		const count = regroup.mock.calls.length;
		harness.prefsStore.setSort('artists', 'most-albums');
		harness.prefsStore.setDensity('pi');
		harness.rootsStore.update(state => ({ ...state, readAt: 'new confirmation' }));
		await waitFor(() => expect(activeLibraryScreen.getAllByTestId('unified-credit-artist')[0]).toHaveTextContent('Shared'));
		expect(regroup).toHaveBeenCalledTimes(count);
	});

	it('opens the exact Albums-root row without joining the same-name Artist', async () => {
		const harness = mountCredit();
		await ready();
		await fireEvent.click(group('Lead'));
		expect(screen.getByTestId('unified-list-heading')).toHaveTextContent('Lead');
		expect(screen.getByTestId('unified-summary')).toHaveTextContent('1 ALBUMS');
		expect(screen.queryByTestId('unified-artist-page')).toBeNull();
		expect(harness.openLiveRef).not.toHaveBeenCalled();
		const tile = activeLibraryScreen.getByTestId('unified-tile');
		expect(tile).toHaveTextContent('Actual album');
		expect(tile.getAttribute('href')).toBe('/library/album-artists/credit/Lead/album/Actual%20album;Lead;');
		const original = get(harness.rootsStore).albumRows.find(row => row.title === 'Actual album')!.ref;
		await fireEvent.click(tile);
		await waitFor(() => expect(screen.getByTestId('unified-album-tracks')).toBeInTheDocument());
		expect(harness.openLiveRef.mock.calls.map(call => call[1])).toEqual([original]);
		expect(screen.getByTestId('unified-album-back')).toHaveTextContent('Lead');
		expect(__getNavigationLog().at(-1)?.url).toContain('/album-artists/credit/Lead/album/');
	});

	it('restores group albums and replaces an unknown history parent back to Album artists', async () => {
		const harness = mountCredit({ withContext: true, artistViewPreference: 'all-artists' });
		restore(harness, { kind: 'credit-group', selector: { kind: 'credit', credit: 'Shared' } });
		await waitFor(() => expect(activeLibraryScreen.getAllByTestId('unified-tile')).toHaveLength(2));
		expect(get(harness.prefsStore).artistView).toBe('all-artists');
		await fireEvent.click(screen.getByTestId('unified-credit-back'));
		await ready();
		expect(__getNavigationLog().at(-1)).toMatchObject({ operation: 'replaceState', url: 'http://localhost/library/album-artists' });
	});

	it('keeps an explicit All-artists page despite the default or a cross-tab preference update', async () => {
		const harness = mountCredit({ withContext: true });
		restore(harness, { kind: 'root', scope: 'artists' });
		await waitFor(() => expect(activeLibraryScreen.getAllByTestId('unified-row')).toHaveLength(2));
		harness.prefsStore.setArtistView('all-artists');
		harness.prefsStore.setArtistView('album-artists');
		await waitFor(() => expect(screen.getByTestId('unified-artist-view-all-artists')).toHaveAttribute('aria-pressed', 'true'));
		expect(__getNavigationLog()).toEqual([]);
	});

	it('distinguishes pending roots from a missing group and never falls through to a same-name Artist', async () => {
		const harness = mountCredit({ withContext: true, loadRoots: vi.fn(async () => {}) });
		restore(harness, { kind: 'credit-group', selector: { kind: 'credit', credit: 'Contributor only' } });
		await waitFor(() => expect(screen.getByTestId('unified-credit-missing')).toBeInTheDocument());
		harness.rootsStore.update(state => ({ ...state, phase: 'loading', albums: [], albumRows: [] }));
		await waitFor(() => expect(screen.queryByTestId('unified-credit-missing')).toBeNull());
		harness.rootsStore.set(liveRootsState(library));
		await waitFor(() => expect(screen.getByTestId('unified-credit-missing')).toBeInTheDocument());
		expect(harness.openLiveRef).not.toHaveBeenCalled();
	});

	it('replaces group membership with the new generation and drops a vanished credit', async () => {
		const harness = mountCredit({ withContext: true });
		restore(harness, { kind: 'credit-group', selector: { kind: 'credit', credit: 'Lead' } });
		await waitFor(() => expect(activeLibraryScreen.getByTestId('unified-tile')).toHaveTextContent('Actual album'));
		harness.rootsStore.set(liveRootsState({ ...library, generation: 'gen-2', albums: [harnessAlbum('Replacement', 'Lead')] }));
		await waitFor(() => expect(activeLibraryScreen.getByTestId('unified-tile')).toHaveTextContent('Replacement'));
		harness.rootsStore.set(liveRootsState({ ...library, generation: 'gen-3', albums: [harnessAlbum('Replacement', 'Changed credit')] }));
		await waitFor(() => expect(screen.getByTestId('unified-credit-missing')).toBeInTheDocument());
		expect(harness.openLiveRef).not.toHaveBeenCalled();
	});

	it('refuses a stale reference even when a tile still carries it', async () => {
		const harness = mountCredit({ withContext: true });
		restore(harness, { kind: 'credit-group', selector: { kind: 'credit', credit: 'Lead' } });
		await waitFor(() => expect(activeLibraryScreen.getByTestId('unified-tile')).toBeInTheDocument());
		harness.rootsStore.update(state => ({ ...state, generation: 'replacement' }));
		await fireEvent.click(activeLibraryScreen.getByTestId('unified-tile'));
		expect(harness.openLiveRef).not.toHaveBeenCalled();
		expect(__getNavigationLog()).toEqual([]);
		expect(screen.getByTestId('unified-list-heading')).toHaveTextContent('Lead');
	});

	it.each(['switch', 'group', 'album'] as const)('refused %s navigation leaves the visible context and preference unchanged', async operation => {
		const harness = mountCredit();
		await ready();
		if (operation === 'album') await fireEvent.click(group('Lead'));
		const address = __getNavigationLog().at(-1)?.url;
		const save = vi.spyOn(harness.prefsStore, 'setArtistView');
		vi.spyOn(pageNavigation, 'pushLibraryPageState').mockReturnValue('refused');
		if (operation === 'switch') await fireEvent.click(screen.getByTestId('unified-artist-view-all-artists'));
		else if (operation === 'group') await fireEvent.click(group('Lead'));
		else await fireEvent.click(activeLibraryScreen.getByTestId('unified-tile'));
		expect(__getNavigationLog().at(-1)?.url).toBe(address);
		expect(save).not.toHaveBeenCalled();
		expect(harness.openLiveRef).not.toHaveBeenCalled();
		if (operation === 'album') expect(screen.getByTestId('unified-list-heading')).toHaveTextContent('Lead');
		else await ready();
	});
});
