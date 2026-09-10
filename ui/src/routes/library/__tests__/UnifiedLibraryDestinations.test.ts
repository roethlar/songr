import { fireEvent, screen, waitFor, within } from '@testing-library/svelte';
import { get, writable } from 'svelte/store';
import { describe, expect, it, vi } from 'vitest';
import { buildUnifiedLibraryPageState, type BrowseHistorySnapshot } from '$lib/libraryPageState';
import type { CommittedLibraryModeActivation } from '$lib/libraryModeActivationContext';
import { createUnifiedBrowseActionController, type UnifiedBrowseState, type UnifiedBrowseController, type UnifiedBrowseActionController } from '$lib/library/UnifiedBrowseController';
import type { ClassicBrowseApiTransaction } from '$lib/api/client';
import type { BrowseItem, BrowseResult } from '@shared/types';
import { setSelectedZone } from '$lib/stores/selectedZoneStore';
import { setZonesSnapshot } from '$lib/stores/zonesStore';
import type { LibraryDestinationInventory } from '$lib/library/LibraryDestinations';
import type { libraryDestinationsStore } from '$lib/stores/libraryDestinationsStore';
import { createNavigationSettingsStore } from '$lib/stores/navigationSettingsStore';
import { DEFAULT_NAVIGATION_SETTINGS } from '@shared/navigationSettings';
import { harnessLibrary, mountMode, fakeConnectionSocket } from './unifiedLibraryModeHarness';

const snapshot: BrowseHistorySnapshot = { context: { hierarchy: 'browse' }, history: [
	{ hierarchy: 'browse', breadcrumb: { title: 'Library' } },
	{ hierarchy: 'browse', breadcrumb: { title: 'Tracks' } }
], forward: [] };
const inventory: LibraryDestinationInventory = { destinations: [{ id: 'tracks', label: 'Tracks', snapshot }],
	fallback: { id: 'browse', label: 'Browse', snapshot: { context: { hierarchy: 'browse' }, history: [], forward: [] } }, diagnostics: [] };
function fixture(disconnected = false, discovered = true, id: 'tracks' | 'composers' | 'tags' = 'tracks', withContext = false, browseActionController?: UnifiedBrowseActionController) {
	const label = id[0].toUpperCase() + id.slice(1);
	const targetSnapshot: BrowseHistorySnapshot = { ...snapshot, history: [snapshot.history[0], { hierarchy: 'browse', breadcrumb: { title: label } }] };
	const items: BrowseItem[] = Array.from({ length: 275 }, (_, index) => ({ title: `Track ${String(index).padStart(3, '0')}`, subtitle: index === 274 ? 'Needle artist' : 'Artist', isLoadable: true, isPlayable: false }));
	const state = writable<UnifiedBrowseState>({ phase: 'idle', result: null,
		snapshot: inventory.fallback.snapshot, notice: null, error: null });
	const restore = vi.fn<UnifiedBrowseController['restore']>(async (_claim, target) => { state.set({ phase: 'ready', snapshot: target,
		result: { title: label, level: 2, offset: 0, count: items.length, totalCount: items.length, items }, notice: null, error: null }); return true; });
	const controller = { subscribe: state.subscribe, restore, reset: vi.fn((target = inventory.fallback.snapshot) => state.set({ phase: 'idle', snapshot: target, result: null, notice: null, error: null })), openItem: vi.fn(async () => true),
		openSearchCategory: vi.fn(), openSearchResult: vi.fn(), back: vi.fn(), forward: vi.fn(), loadMore: vi.fn() } as unknown as UnifiedBrowseController;
	const destinations = writable<{ inventory: LibraryDestinationInventory | null; loading: boolean; error: string | null }>({ inventory: discovered ? inventory : null, loading: !discovered, error: null });
	const destinationsStore = { subscribe: destinations.subscribe, load: vi.fn(async () => {}), reset: vi.fn() } as typeof libraryDestinationsStore;
	const navigationPrefsStore = createNavigationSettingsStore();
	navigationPrefsStore.applySnapshot({ ...DEFAULT_NAVIGATION_SETTINGS, pinned: [...DEFAULT_NAVIGATION_SETTINGS.pinned, id] });
	const socket = fakeConnectionSocket(); socket.connected = !disconnected;
	const mounted = mountMode({ withContext, liveLibrary: harnessLibrary(), browseController: controller, browseActionController, destinationsStore, navigationPrefsStore, getSocketClient: () => socket });
	return { ...mounted, items, state, restore, controller, destinations, navigationPrefsStore, targetSnapshot, socket };
}

describe('Library public destinations integration', () => {
	it('preserves an addressed Tags page and its tools when resume and reconnect return a Roon message', async () => {
		const harness = fixture(false, false, 'tags', true);
		harness.restore.mockImplementation(async (_claim, target, _zone, options) => {
			harness.state.set({ phase: 'ready', snapshot: options?.complete ? target : inventory.fallback.snapshot,
				result: { action: 'message', message: 'Temporarily unavailable', level: 0, offset: 0, count: 0, totalCount: 0, items: [] }, notice: null, error: null });
			return true;
		});
		harness.registered.lifecycle!.resume({ cause: 'history-pop', pageState: buildUnifiedLibraryPageState({
			scope: 'browse', collectionDrill: null, itemTarget: null, filterText: '', surpriseSeed: null,
			browseHistory: harness.targetSnapshot
		}) } as CommittedLibraryModeActivation);
		await waitFor(() => expect(screen.getByLabelText('Filter Tags')).toBeDisabled());
		expect(get(harness.state).snapshot).toEqual(harness.targetSnapshot);
		expect(harness.restore).toHaveBeenLastCalledWith(expect.anything(), harness.targetSnapshot, undefined, { complete: true });
		harness.socket.connected = false; harness.socket.emit('disconnect');
		harness.socket.connected = true; harness.socket.emit('connect');
		await waitFor(() => expect(harness.restore).toHaveBeenCalledTimes(2));
		expect(harness.restore).toHaveBeenLastCalledWith(expect.anything(), harness.targetSnapshot, undefined, { complete: true });
		expect(screen.getByLabelText('Sort Tags')).toBeDisabled();
		expect(screen.getByTestId('unified-browse-message')).toHaveTextContent('Temporarily unavailable');
	});

	it.each(['tracks', 'composers', 'tags'] as const)('keeps %s pinnable before discovery with complete-list tools', async (id) => {
		const harness = fixture(false, false, id);
		const label = id[0].toUpperCase() + id.slice(1);
		await waitFor(() => expect(get(harness.navigationPrefsStore).availableDestinations).toEqual(expect.arrayContaining(['tracks', 'composers', 'tags', 'internet-radio'])));
		expect(get(harness.navigationPrefsStore).availableDestinations).not.toContain('browse');
		await fireEvent.click(screen.getByTestId(`unified-scope-${id}`));
		await waitFor(() => expect(screen.getByLabelText(`Filter ${label}`)).toBeEnabled());
		expect(harness.restore).toHaveBeenCalledWith(expect.anything(), harness.targetSnapshot, undefined, { complete: true });
		await fireEvent.input(screen.getByLabelText(`Filter ${label}`), { target: { value: 'Needle artist' } });
		expect(screen.getByTestId('unified-browse-list')).toHaveTextContent('Track 274');
		expect(screen.getAllByTestId('unified-browse-row')).toHaveLength(1);
		await fireEvent.input(screen.getByLabelText(`Filter ${label}`), { target: { value: '' } });
		await fireEvent.change(screen.getByLabelText(`Sort ${label}`), { target: { value: 'name-desc' } });
		expect(screen.getAllByTestId('unified-browse-row')[0]).toHaveTextContent('Track 274');
		const full = get(harness.state);
		harness.state.set({ ...full, result: { ...full.result!, count: 0, totalCount: 0, items: [] } });
		await waitFor(() => expect(screen.getByLabelText(`Filter ${label}`)).toBeEnabled());
		expect(screen.getByTestId('unified-browse-empty')).toHaveTextContent('Nothing is available here.');
		harness.state.set({ ...full, phase: 'error', result: null, error: 'Core disconnected' });
		await waitFor(() => expect(screen.getByLabelText(`Filter ${label}`)).toBeDisabled());
		expect(screen.getByRole('button', { name: `Retry ${label}` })).toBeVisible();
		expect(screen.getByTestId(`unified-scope-${id}`)).toHaveAttribute('aria-pressed', 'true');
	});

	it.each([['queue', 'Queue', 'Queued'], ['play-now', 'Play', 'Playing'], ['add-next', 'Add Next', 'Added next']] as const)('executes %s for the exact second duplicate without a row-click popup', async (semantic, button, status) => {
		const openedRows: string[] = [];
		const executedLeaves: string[] = [];
		let liveRows: BrowseItem[] = [];
		const page = (items: BrowseItem[], title: string, level: number, offset = 0, total = items.length): BrowseResult => ({
			action: 'list', title, level, offset, count: total, totalCount: total, items
		});
		const folder = (title: string, itemKey: string): BrowseItem => ({ title, itemKey, hint: 'list', isLoadable: true, isPlayable: false });
		const transaction: ClassicBrowseApiTransaction = {
			async browse(options) {
				const key = options.itemKey;
				if (!key) return page([folder('Library', 'library-key')], 'Browse', 0);
				if (key === 'library-key') return page([folder('Tracks', 'tracks-key')], 'Library', 1);
				if (key === 'tracks-key') return page(liveRows.slice(0, 100), 'Tracks', 2, 0, liveRows.length);
				if (/^track-key-\d+$/.test(key)) {
					openedRows.push(key);
					return page(['Play Now', 'Add Next', 'Queue'].map(title => ({
						title, itemKey: `${key}:${title}`, hint: 'action', isLoadable: false, isPlayable: true
					})), 'Actions', 3);
				}
				if ([':Queue', ':Play Now', ':Add Next'].some(suffix => key.endsWith(suffix))) {
					executedLeaves.push(key);
					return page([], 'Done', 3);
				}
				throw new Error(`Unexpected offline action: ${key}`);
			},
			async browseLoad(options) {
				const offset = options.offset ?? 0;
				return page(liveRows.slice(offset, offset + 100), 'Tracks', 2, offset, liveRows.length);
			},
			async browsePop() { throw new Error('Unexpected pop'); },
			async browseSearch() { throw new Error('Unexpected search'); }
		};
		const actions = createUnifiedBrowseActionController({ transaction: async (_role, _claim, work) => work(transaction), isClaimCurrent: () => true });
		setZonesSnapshot([{ zone_id: 'zone-duplicate', display_name: 'Offline test zone', state: 'paused',
			is_play_allowed: true, is_pause_allowed: true, is_previous_allowed: true, is_next_allowed: true,
			is_seek_allowed: true, outputs: [] }]);
		setSelectedZone('zone-duplicate');
		try {
			const harness = fixture(false, true, 'tracks', false, actions);
			for (let index = 0; index < harness.items.length; index++) {
				Object.assign(harness.items[index], { itemKey: `track-key-${index}`, hint: 'action_list', isLoadable: false });
			}
			for (const index of [37, 274]) Object.assign(harness.items[index], { title: 'I Swear', subtitle: 'All-4-One' });
			liveRows = harness.items;
			await fireEvent.click(screen.getByTestId('unified-scope-tracks'));
			await waitFor(() => expect(screen.getByLabelText('Sort Tracks')).toBeEnabled());
			await fireEvent.change(screen.getByLabelText('Sort Tracks'), { target: { value: 'artist-desc' } });
			await fireEvent.input(screen.getByLabelText('Filter Tracks'), { target: { value: 'All-4-One' } });
			expect(screen.getAllByTestId('unified-browse-row')).toHaveLength(2);
			expect(screen.getByTestId('unified-browse-summary')).toHaveTextContent('2 OF 275');
			const selectedRow = screen.getAllByTestId('unified-browse-row')[1];
			await fireEvent.click(selectedRow);
			expect(screen.queryByTestId('unified-browse-action-sheet')).toBeNull();
			expect(openedRows).toEqual([]);
			expect(executedLeaves).toEqual([]);
			if (semantic === 'add-next') await fireEvent.click(within(selectedRow).getByLabelText('More actions for I Swear'));
			expect(within(selectedRow).getByRole('button', { name: button })).toBeEnabled();
			await fireEvent.click(within(selectedRow).getByRole('button', { name: button }));
			await waitFor(() => expect(executedLeaves).toEqual([`track-key-274:${semantic === 'play-now' ? 'Play Now' : button}`]));
			expect(openedRows).toEqual(['track-key-274']);
			expect(screen.queryByTestId('unified-browse-action-sheet')).toBeNull();
			expect(screen.getByTestId('unified-track-status')).toHaveTextContent('I Swear');
			await waitFor(() => expect(screen.getByTestId('unified-track-status')).toHaveTextContent(status));
			expect(harness.restore).toHaveBeenCalledTimes(1);

		} finally {
			setZonesSnapshot([]);
			setSelectedZone('');
		}
	});

	it('sorts Tracks by artist across all 275 rows and retains the choice when returning', async () => {
		const harness = fixture();
		harness.items[0].subtitle = 'ZZZ Artist';
		harness.items[274].subtitle = 'AAA Artist';
		await fireEvent.click(screen.getByTestId('unified-scope-tracks'));
		await waitFor(() => expect(screen.getByLabelText('Sort Tracks')).toBeEnabled());
		expect(screen.getByRole('option', { name: 'Artist A–Z' })).toHaveValue('artist-asc');
		expect(screen.getByRole('option', { name: 'Artist Z–A' })).toHaveValue('artist-desc');
		await fireEvent.change(screen.getByLabelText('Sort Tracks'), { target: { value: 'artist-asc' } });
		expect(screen.getAllByTestId('unified-browse-row')).toHaveLength(275);
		expect(screen.getAllByTestId('unified-browse-row')[0]).toHaveTextContent('Track 274');
		expect(screen.getAllByTestId('unified-browse-row')[0]).toHaveTextContent('AAA Artist');
		expect(screen.getByTestId('unified-browse-summary')).toHaveTextContent('275');
		await fireEvent.change(screen.getByLabelText('Sort Tracks'), { target: { value: 'artist-desc' } });
		expect(screen.getAllByTestId('unified-browse-row')[0]).toHaveTextContent('Track 000');
		expect(screen.getAllByTestId('unified-browse-row')[0]).toHaveTextContent('ZZZ Artist');
		expect(harness.restore).toHaveBeenCalledTimes(1);
		await fireEvent.click(screen.getByTestId('unified-scope-artists'));
		await fireEvent.click(screen.getByTestId('unified-scope-tracks'));
		await waitFor(() => expect(screen.getByLabelText('Sort Tracks')).toHaveValue('artist-desc'));
		expect(screen.getAllByTestId('unified-browse-row')[0]).toHaveTextContent('Track 000');
	});

	it.each(['composers', 'tags'] as const)('keeps artist sorts out of %s', async id => {
		fixture(false, false, id);
		const label = id[0].toUpperCase() + id.slice(1);
		await fireEvent.click(screen.getByTestId(`unified-scope-${id}`));
		await waitFor(() => expect(screen.getByLabelText(`Sort ${label}`)).toBeEnabled());
		expect(screen.queryByRole('option', { name: 'Artist A–Z' })).toBeNull();
		expect(screen.queryByRole('option', { name: 'Artist Z–A' })).toBeNull();
		expect(screen.getByRole('option', { name: 'Name A–Z' })).toHaveValue('name-asc');
		expect(screen.getByRole('option', { name: 'Name Z–A' })).toHaveValue('name-desc');
	});

	it('filters/sorts one complete continuous collection', async () => {
		const harness = fixture();
		await fireEvent.click(screen.getByTestId('unified-scope-tracks'));
		await waitFor(() => expect(screen.getByLabelText('Filter Tracks')).toBeEnabled());
		expect(harness.restore).toHaveBeenCalledWith(expect.anything(), snapshot, undefined, { complete: true });
		expect(screen.getAllByTestId('unified-browse-row')).toHaveLength(275);
		await fireEvent.input(screen.getByLabelText('Filter Tracks'), { target: { value: 'Needle artist' } });
		expect(screen.getAllByTestId('unified-browse-row')).toHaveLength(1);
		expect(screen.getByTestId('unified-browse-list')).toHaveTextContent('Track 274');
		expect(screen.getByTestId('unified-browse-summary')).toHaveTextContent('1 OF 275');
		await fireEvent.input(screen.getByLabelText('Filter Tracks'), { target: { value: '' } });
		await fireEvent.change(screen.getByLabelText('Sort Tracks'), { target: { value: 'name-desc' } });
		expect(screen.getAllByTestId('unified-browse-row')[0]).toHaveTextContent('Track 274');
		expect(screen.queryByRole('button', { name: /Show next/ })).toBeNull();
		expect(screen.getAllByTestId('unified-browse-row')).toHaveLength(275);
		expect(harness.restore).toHaveBeenCalledTimes(1);
		await fireEvent.click(screen.getByTestId('unified-scope-artists'));
		await fireEvent.click(screen.getByTestId('unified-scope-tracks'));
		await waitFor(() => expect(screen.getByLabelText('Sort Tracks')).toHaveValue('name-desc'));
		expect(screen.getAllByTestId('unified-browse-row')).toHaveLength(275);
		expect(get(harness.navigationPrefsStore).availableDestinations).toContain('tracks');
		expect(get(harness.navigationPrefsStore).availableDestinations).not.toContain('playlists');
	});
	it('refuses partial injected state without silently starting another read', async () => {
		const harness = fixture();
		await fireEvent.click(screen.getByTestId('unified-scope-tracks'));
		await waitFor(() => expect(harness.restore).toHaveBeenCalledTimes(1));
		const full = get(harness.state);
		harness.state.set({ ...full, result: { ...full.result!, items: full.result!.items.slice(0, 100) } });
		await waitFor(() => expect(screen.getByLabelText('Filter Tracks')).toBeDisabled());
		expect(harness.restore).toHaveBeenCalledTimes(1);
		expect(screen.getByRole('button', { name: 'Retry Tracks' })).toBeEnabled();
	});
	it('does not mutate the page or start a read when disconnected', async () => {
		const harness = fixture(true);
		await fireEvent.click(screen.getByTestId('unified-scope-tracks'));
		expect(harness.restore).not.toHaveBeenCalled();
		expect(screen.getByTestId('unified-scope-artists')).toHaveAttribute('aria-pressed', 'true');
	});
	it('temporary inventory loss keeps the page available and its saved pin intact', async () => {
		const harness = fixture();
		harness.destinations.set({ inventory: { ...inventory, destinations: [] }, loading: false, error: null });
		await waitFor(() => expect(screen.getByTestId('unified-scope-tracks')).toBeVisible());
		expect(get(harness.navigationPrefsStore).snapshot?.pinned).toContain('tracks');
		harness.destinations.set({ inventory, loading: false, error: null });
		await waitFor(() => expect(screen.getByTestId('unified-scope-tracks')).toBeVisible());
	});
});


describe('inline track action cancellation', () => {
	it.each(['zone', 'navigation', 'disconnect', 'replacement'] as const)('does not execute after %s changes during action discovery', async (change) => {
		let finishProbe!: (page: BrowseResult) => void;
		const probe = new Promise<BrowseResult>(resolve => { finishProbe = resolve; });
		const browse = vi.fn<ClassicBrowseApiTransaction['browse']>(async () => probe);
		const transaction = { browse } as unknown as ClassicBrowseApiTransaction;
		const actions = createUnifiedBrowseActionController({ transaction: async (_role, _claim, work) => work(transaction), isClaimCurrent: () => true });
		const zone = (id: string) => ({ zone_id: id, display_name: id, state: 'paused' as const,
			is_play_allowed: true, is_pause_allowed: true, is_previous_allowed: true, is_next_allowed: true,
			is_seek_allowed: true, outputs: [] });
		setZonesSnapshot([zone('zone-a'), zone('zone-b')]);
		setSelectedZone('zone-a');
		try {
			const harness = fixture(false, true, 'tracks', false, actions);
			Object.assign(harness.items[0], { itemKey: 'selected-track', hint: 'action_list', isLoadable: false });
			await fireEvent.click(screen.getByTestId('unified-scope-tracks'));
			await waitFor(() => expect(screen.getByLabelText('Filter Tracks')).toBeEnabled());
			await fireEvent.click(within(screen.getAllByTestId('unified-browse-row')[0]).getByRole('button', { name: 'Queue' }));
			await waitFor(() => expect(browse).toHaveBeenCalledTimes(1));
			if (change === 'zone') setSelectedZone('zone-b');
			else if (change === 'navigation') await fireEvent.click(screen.getByTestId('unified-scope-artists'));
			else if (change === 'disconnect') { harness.socket.connected = false; harness.socket.emit('disconnect'); }
			else harness.state.update(state => ({ ...state, result: { ...state.result!, items: [...state.result!.items] } }));
			await waitFor(() => expect(get(actions).phase).toBe('idle'));
			finishProbe({ title: 'Actions', level: 3, offset: 0, count: 1, totalCount: 1,
				items: [{ title: 'Queue', itemKey: 'selected-track:Queue', hint: 'action', isPlayable: true, isLoadable: false }] });
			await Promise.resolve();
			await Promise.resolve();
			expect(browse).toHaveBeenCalledTimes(1);
			expect(screen.queryByTestId('unified-browse-action-sheet')).toBeNull();
		} finally { setZonesSnapshot([]); setSelectedZone(''); }
	});

	it('reports an expired selected token inline without replay or execution', async () => {
		const browse = vi.fn<ClassicBrowseApiTransaction['browse']>(async () => { throw new Error('Selected track expired'); });
		const actions = createUnifiedBrowseActionController({ transaction: async (_role, _claim, work) => work({ browse } as unknown as ClassicBrowseApiTransaction), isClaimCurrent: () => true });
		setZonesSnapshot([{ zone_id: 'zone-a', display_name: 'Zone', state: 'paused', outputs: [], is_play_allowed: true,
			is_pause_allowed: true, is_previous_allowed: true, is_next_allowed: true, is_seek_allowed: true }]);
		setSelectedZone('zone-a');
		try {
			const harness = fixture(false, true, 'tracks', false, actions);
			Object.assign(harness.items[0], { itemKey: 'expired-track', hint: 'action_list', isLoadable: false });
			await fireEvent.click(screen.getByTestId('unified-scope-tracks'));
			await waitFor(() => expect(screen.getByLabelText('Filter Tracks')).toBeEnabled());
			await fireEvent.click(within(screen.getAllByTestId('unified-browse-row')[0]).getByRole('button', { name: 'Queue' }));
			await waitFor(() => expect(screen.getByTestId('unified-track-status')).toHaveTextContent('expired'));
			expect(screen.getByTestId('unified-track-status')).toHaveAttribute('role', 'alert');
			expect(browse).toHaveBeenCalledTimes(1);
			expect(browse).toHaveBeenCalledWith(expect.objectContaining({ itemKey: 'expired-track' }));
			expect(harness.restore).toHaveBeenCalledTimes(1);
			expect(screen.queryByTestId('unified-browse-action-sheet')).toBeNull();
		} finally { setZonesSnapshot([]); setSelectedZone(''); }
	});
});
