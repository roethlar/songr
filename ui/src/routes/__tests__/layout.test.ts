import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/svelte';
import { writable, get } from 'svelte/store';
import { tick, createRawSnippet } from 'svelte';
import type { BrowseResult, BrowseOptions } from '@shared/types';

const {
	railWritable,
	gotoMock,
	apiBrowse,
	resolveExploreRailMock,
	invalidateExploreRailMock,
	classicSessionWritable,
	classicSessionClaimMock,
	classicSessionReleaseMock,
	classicSessionRecoverMock,
	classicSessionConnectionLostMock,
	classicSessionIsClaimCurrentMock,
	classicClaimReadyQueue,
	resetClassicSessionMock
} = vi.hoisted(() => {
	const { writable: w } = require('svelte/store') as typeof import('svelte/store');
	const rail = w<{
		entries: Array<{
			id: string;
			label: string;
			labelPath: string[];
			isEmpty: boolean;
			cachedKey?: string;
			cachedAncestorKeys?: string[];
		}>;
		loading: boolean;
		error: string | null;
	}>({ entries: [], loading: false, error: null });
	const classicSession = w<{
		phase: 'none' | 'acquiring' | 'live';
		session: { handleId: string; generation: number } | null;
		lifecycleGeneration: number;
		owner: 'inactive' | 'normal-shell' | 'classic-mode';
		ownerEpoch: number;
	}>({
		phase: 'none',
		session: null,
		lifecycleGeneration: 0,
		owner: 'inactive',
		ownerEpoch: 0
	});
	type Owner = 'normal-shell' | 'classic-mode';
	type Session = { handleId: string; generation: number };
	type Claim = { owner: Owner; claimId: number; ready: Promise<Session> };
	const readyQueue: Array<Promise<Session>> = [];
	let activeClaim: Claim | null = null;
	let ownerEpoch = 0;
	let lifecycleGeneration = 0;
	const publishNone = (owner: 'inactive' | Owner, epoch: number) => {
		lifecycleGeneration += 1;
		classicSession.set({
			phase: 'none',
			session: null,
			lifecycleGeneration,
			owner,
			ownerEpoch: epoch
		});
	};
	const startReady = (claim: Omit<Claim, 'ready'>): Promise<Session> => {
		lifecycleGeneration += 1;
		const generation = lifecycleGeneration;
		classicSession.set({
			phase: 'acquiring',
			session: null,
			lifecycleGeneration,
			owner: claim.owner,
			ownerEpoch: claim.claimId
		});
		const ready =
			readyQueue.shift() ??
			Promise.resolve({ handleId: `layout-${claim.owner}-${claim.claimId}`, generation });
		void ready.then(
			(session) => {
				if (activeClaim?.claimId !== claim.claimId) return;
				classicSession.set({
					phase: 'live',
					session,
					lifecycleGeneration: generation,
					owner: claim.owner,
					ownerEpoch: claim.claimId
				});
			},
			() => {
				if (activeClaim?.claimId !== claim.claimId) return;
				classicSession.set({
					phase: 'none',
					session: null,
					lifecycleGeneration: generation,
					owner: claim.owner,
					ownerEpoch: claim.claimId
				});
			}
		);
		return ready;
	};
	const claim = vi.fn((owner: Owner): Claim => {
		ownerEpoch += 1;
		publishNone(owner, ownerEpoch);
		const identity = { owner, claimId: ownerEpoch };
		const next = { ...identity, ready: Promise.resolve({ handleId: '', generation: 0 }) };
		activeClaim = next;
		next.ready = startReady(identity);
		return next;
	});
	const release = vi.fn((candidate: Claim) => {
		if (activeClaim?.claimId !== candidate.claimId) return;
		activeClaim = null;
		ownerEpoch += 1;
		publishNone('inactive', ownerEpoch);
	});
	const connectionLost = vi.fn((candidate: Claim) => {
		if (activeClaim?.claimId !== candidate.claimId) return;
		publishNone(candidate.owner, candidate.claimId);
	});
	const recover = vi.fn((candidate: Claim) => {
		if (activeClaim?.claimId !== candidate.claimId) {
			return Promise.reject(new Error('stale claim'));
		}
		return startReady(candidate);
	});
	const isClaimCurrent = vi.fn(
		(candidate: Claim) => activeClaim?.claimId === candidate.claimId
	);
	const resetClassic = () => {
		activeClaim = null;
		ownerEpoch = 0;
		lifecycleGeneration = 0;
		readyQueue.length = 0;
		classicSession.set({
			phase: 'none',
			session: null,
			lifecycleGeneration: 0,
			owner: 'inactive',
			ownerEpoch: 0
		});
	};
	return {
		railWritable: rail,
		gotoMock: vi.fn(),
		apiBrowse: vi.fn<(_fetch: unknown, opts: BrowseOptions) => Promise<BrowseResult>>(),
		resolveExploreRailMock: vi.fn().mockResolvedValue(undefined),
		invalidateExploreRailMock: vi.fn(),
		classicSessionWritable: classicSession,
		classicSessionClaimMock: claim,
		classicSessionReleaseMock: release,
		classicSessionRecoverMock: recover,
		classicSessionConnectionLostMock: connectionLost,
		classicSessionIsClaimCurrentMock: isClaimCurrent,
		classicClaimReadyQueue: readyQueue,
		resetClassicSessionMock: resetClassic
	};
});

const pageState = writable<{ url: URL; state?: App.PageState }>({
	url: new URL('http://localhost/library')
});

vi.mock('$app/navigation', () => ({
	goto: gotoMock
}));

vi.mock('$app/stores', () => ({
	page: {
		subscribe: (run: (value: { url: URL; state?: App.PageState }) => void) =>
			pageState.subscribe(run)
	}
}));

import { createFakeSocket } from '../../test/fixtures/socket';
const fakeSocket = createFakeSocket();
vi.mock('$lib/socket/client', () => ({
	getSocket: () => fakeSocket,
	disconnectSocket: vi.fn()
}));

vi.mock('$lib/socket/register', () => ({
	registerSocketHandlers: () => () => {}
}));

vi.mock('$lib/stores/classicBrowseSessionStore', () => ({
	classicBrowseSessionClient: {
		subscribe: classicSessionWritable.subscribe,
		claim: classicSessionClaimMock,
		release: classicSessionReleaseMock,
		recover: classicSessionRecoverMock,
		connectionLost: classicSessionConnectionLostMock,
		isClaimCurrent: classicSessionIsClaimCurrentMock
	}
}));

vi.mock('$lib/socket/emit', () => ({
	emitWithAck: vi.fn().mockResolvedValue(undefined),
	emitIfConnected: vi.fn().mockReturnValue(true)
}));

vi.mock('$lib/api/client', () => ({
	browse: (fetchFn: unknown, opts: BrowseOptions) => apiBrowse(fetchFn, opts)
}));

vi.mock('$lib/stores/exploreRailStore', () => ({
	exploreRailStore: railWritable,
	resolveExploreRail: resolveExploreRailMock,
	invalidateExploreRail: invalidateExploreRailMock
}));

// initializeStores fans out to coreStore/zonesStore/recentlyPlayedStore
// REST loaders at mount. Replace it wholesale rather than mocking each
// store's loader individually — the alternative pulls each store's full
// module graph just to spread it and stub one function.
vi.mock('$lib/stores', async (importOriginal) => {
	const mod = await importOriginal<typeof import('$lib/stores')>();
	return { ...mod, initializeStores: vi.fn().mockResolvedValue(undefined) };
});

import Layout from '../+layout.svelte';
import {
	claimLibraryViewHost,
	type LibraryViewHostPublisher
} from '$lib/stores/libraryViewHostStore';
import { setCoreStatus } from '$lib/stores/coreStore';
import { setSocketStatus } from '$lib/stores/socketStatusStore';
import { setHealth } from '$lib/stores/healthStore';
import {
	browseHistoryStore,
	resetHistory,
	pushHistory
} from '$lib/stores/browseHistoryStore';
import {
	pendingLibraryIntentStore,
	resetLibraryIntentStore
} from '$lib/stores/libraryIntentStore';
import { setNowPlaying, resetNowPlaying } from '$lib/stores/nowPlayingStore';
import { selectedZoneStore, setSelectedZone } from '$lib/stores/selectedZoneStore';
import { setZonesSnapshot } from '$lib/stores/zonesStore';
import { themeStore, toggleTheme } from '$lib/stores/themeStore';
import {
	DEFAULT_UNIFIED_LIBRARY_PREFS,
	UNIFIED_LIBRARY_PREFS_STORAGE_KEY,
	UNIFIED_LIBRARY_PREFS_VERSION,
	type UnifiedLibraryDensity
} from '$lib/stores/unifiedLibraryPrefsStore';
import { emitWithAck } from '$lib/socket/emit';
import type { Zone } from '@shared/types';
import {
	resetBrowse,
	browseStore,
	setBrowseResult
} from '$lib/stores/browseStore';

import { listResult, makeItem } from '../../test/fixtures/browse';

// The layout calls `{@render children()}` (non-optional). A trivial
// snippet keeps the mount from throwing; the children aren't inspected.
const childrenSnippet = createRawSnippet(() => ({
	render: () => '<div data-testid="route-child">child</div>'
}));

function renderLayout() {
	return render(Layout, { props: { children: childrenSnippet } });
}

function publishUnifiedDensity(density: UnifiedLibraryDensity): void {
	window.dispatchEvent(
		new StorageEvent('storage', {
			key: UNIFIED_LIBRARY_PREFS_STORAGE_KEY,
			newValue: JSON.stringify({
				version: UNIFIED_LIBRARY_PREFS_VERSION,
				density,
				sorts: DEFAULT_UNIFIED_LIBRARY_PREFS.sorts
			})
		})
	);
}

let libraryViewHost: LibraryViewHostPublisher;

beforeEach(() => {
	apiBrowse.mockReset();
	gotoMock.mockReset();
	fakeSocket.emit.mockReset();
	fakeSocket.connected = true;
	setSocketStatus('connected');
	resetClassicSessionMock();
	classicSessionClaimMock.mockClear();
	classicSessionReleaseMock.mockClear();
	classicSessionRecoverMock.mockClear();
	classicSessionConnectionLostMock.mockClear();
	classicSessionIsClaimCurrentMock.mockClear();
	railWritable.set({ entries: [], loading: false, error: null });
	pageState.set({ url: new URL('http://localhost/library') });
	libraryViewHost = claimLibraryViewHost();
	libraryViewHost.publishActiveMode('classic');
	setCoreStatus({ status: 'discovering' });
	setHealth(null);
	resolveExploreRailMock.mockReset().mockResolvedValue(undefined);
	invalidateExploreRailMock.mockReset();
	resetBrowse();
	resetHistory();
	resetLibraryIntentStore();
	resetNowPlaying();
	setSelectedZone('');
	setZonesSnapshot([]);
	publishUnifiedDensity('normal');
	vi.mocked(emitWithAck).mockReset();
	// AckResponse<T> = { success: true; data?: T } | { success: false; ... }
	// Tests assert on the emit call, not the resolved value, but the
	// mock must return a shape that satisfies the type.
	vi.mocked(emitWithAck).mockResolvedValue({ success: true });
});

/**
 * Minimal Zone with the flags transport buttons read. Overrides win.
 */
function makeZone(over: Partial<Zone> = {}): Zone {
	return {
		zone_id: over.zone_id ?? 'zone-a',
		display_name: over.display_name ?? 'Main Zone',
		state: over.state ?? 'playing',
		seek_position: over.seek_position ?? 0,
		is_play_allowed: over.is_play_allowed ?? true,
		is_pause_allowed: over.is_pause_allowed ?? true,
		is_previous_allowed: over.is_previous_allowed ?? true,
		is_next_allowed: over.is_next_allowed ?? true,
		is_seek_allowed: over.is_seek_allowed ?? true,
		queue_items_remaining: over.queue_items_remaining,
		outputs: over.outputs ?? []
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

describe('Layout — route and committed Library mode shell', () => {
	it('keeps the existing Classic Library chrome and full transport after Classic commits', async () => {
		const { container } = renderLayout();
		await tick();

		expect(container.querySelector('[data-shell-presentation="classic"]')).not.toBeNull();
		expect(container.querySelector('aside.sidebar')).not.toBeNull();
		expect(container.querySelector('header.workspace-header')).not.toBeNull();
		const workspace = container.querySelector('[data-workspace-presentation="contained"]') as HTMLElement;
		expect(workspace).not.toBeNull();
		expect(workspace.style.getPropertyValue('--workspace-content-max-width')).toBe('1440px');
		expect(workspace.style.getPropertyValue('--workspace-content-margin')).toBe('0 auto');
		expect(workspace.style.getPropertyValue('--workspace-content-width')).toBe('auto');
		expect(workspace.style.getPropertyValue('--workspace-content-height')).toBe('auto');
		expect(container.querySelectorAll('[aria-label="Playback controls"]')).toHaveLength(1);
		expect(container.querySelector('[data-transport-presentation="full"]')).not.toBeNull();
		expect(container.querySelectorAll('[data-testid="route-child"]')).toHaveLength(1);
	});

	it('uses full-bleed Timeline chrome with one compact shared transport presentation', async () => {
		libraryViewHost.publishActiveMode('timeline');
		const { container } = renderLayout();
		await tick();

		const mainArea = container.querySelector('.main-area') as HTMLElement;
		const workspace = container.querySelector('.workspace-main') as HTMLElement;
		const compactTransport = container.querySelector('[data-transport-presentation="compact"]') as HTMLElement;
		expect(container.querySelector('[data-shell-presentation="timeline"]')).not.toBeNull();
		expect(container.querySelector('aside.sidebar')).toBeNull();
		expect(container.querySelector('header.workspace-header')).toBeNull();
		expect(screen.queryByLabelText(/Search library/i)).toBeNull();
		expect(mainArea).toHaveStyle({ gridTemplateColumns: '1fr' });
		expect(workspace).toHaveClass('full-bleed');
		expect(workspace).toHaveAttribute('data-workspace-presentation', 'full-bleed');
		expect(workspace).toHaveStyle({ padding: '0', overflow: 'hidden' });
		expect(workspace.style.getPropertyValue('--workspace-content-max-width')).toBe('none');
		expect(workspace.style.getPropertyValue('--workspace-content-margin')).toBe('0');
		expect(workspace.style.getPropertyValue('--workspace-content-width')).toBe('100%');
		expect(workspace.style.getPropertyValue('--workspace-content-height')).toBe('100%');
		expect(container.querySelectorAll('[aria-label="Playback controls"]')).toHaveLength(1);
		expect(compactTransport).not.toBeNull();
		expect(compactTransport.style.position).toBe('fixed');
		expect(compactTransport.style.left).toBe('50%');
		expect(compactTransport.style.bottom).toBe('0.75rem');
		expect(compactTransport.style.transform).toBe('translateX(-50%)');
		expect(compactTransport.style.gridTemplateColumns).toBe('auto minmax(180px, 1fr) auto');
		expect(compactTransport.style.gridTemplateRows).toBe('auto');
		expect(compactTransport.style.width).toBe('calc(100vw - 1.5rem)');
		expect(compactTransport.style.maxWidth).toBe('520px');
		expect(compactTransport.style.margin).toBe('0px');
		expect(compactTransport.style.padding).toBe('0.45rem 0.55rem');
		expect(container.querySelector('[data-transport-presentation="full"]')).toBeNull();
		expect(compactTransport.querySelector('.compact-now-playing .pb-art')).not.toBeNull();
		expect(compactTransport.querySelector('.compact-transport-meta')).not.toBeNull();
		expect(compactTransport.querySelector('.compact-title')).not.toBeNull();
		expect(compactTransport.querySelector('.compact-subtitle')).not.toBeNull();
		expect(compactTransport.querySelector('.compact-progress[role="slider"]')).not.toBeNull();
		expect(compactTransport.querySelector('.pb-controls')).not.toBeNull();
		expect(compactTransport.querySelector('.pb-progress-bar')).toBeNull();
		expect(compactTransport.querySelector('.pb-meta')).toBeNull();
		expect(compactTransport.querySelector('.pb-right')).toBeNull();
		expect(compactTransport.querySelector('#footer-zone')).toBeNull();
		expect(container.querySelectorAll('[data-testid="route-child"]')).toHaveLength(1);
	});

	it('frames Unified with the literal full-width reference transport and unobstructed header', async () => {
		libraryViewHost.publishActiveMode('unified');
		const { container } = renderLayout();
		await tick();

		const transport = container.querySelector(
			'[data-transport-presentation="unified"]'
		) as HTMLElement;
		expect(container.querySelector('[data-shell-presentation="unified"]')).not.toBeNull();
		expect(container.querySelector('aside.sidebar')).toBeNull();
		expect(container.querySelector('header.workspace-header')).toBeNull();
		expect(container.querySelector('[aria-label="Open Controller settings"]')).toBeNull();
		expect(transport).not.toBeNull();
		expect(transport).toHaveClass('unified');
		expect(transport.style.position).toBe('');
		expect(transport.style.left).toBe('');
		expect(transport.style.bottom).toBe('');
		expect(transport.style.transform).toBe('');
		expect(transport.style.width).toBe('');
		expect(transport.style.maxWidth).toBe('');
		expect(transport.style.margin).toBe('');
		expect(transport.querySelector('.unified-now-playing')).not.toBeNull();
		expect(transport.querySelector('.unified-transport-controls')).not.toBeNull();
		expect(transport.querySelector('.unified-volume')).not.toBeNull();
		expect(transport.querySelector('.unified-zone')).not.toBeNull();
		expect((transport.querySelector('.unified-time') as HTMLElement).style.fontFamily).toBe(
			'ui-monospace, "SF Mono", Menlo, Consolas, monospace'
		);
		expect((transport.querySelector('.unified-volume') as HTMLElement).style.fontFamily).toBe(
			'ui-monospace, "SF Mono", Menlo, Consolas, monospace'
		);
		expect(transport.querySelector('.compact-transport-meta')).toBeNull();
		expect(container.querySelectorAll('[data-testid="route-child"]')).toHaveLength(1);
	});

	it('uses the Unified zone label as a working zone selector', async () => {
		libraryViewHost.publishActiveMode('unified');
		setZonesSnapshot([
			makeZone({ zone_id: 'zone-a', display_name: 'Studio' }),
			makeZone({ zone_id: 'zone-b', display_name: 'Kitchen' })
		]);
		setSelectedZone('zone-a');
		renderLayout();
		await tick();

		const trigger = screen.getByRole('button', {
			name: 'Select zone, current zone Studio'
		});
		expect(trigger).toHaveAttribute('aria-expanded', 'false');
		await fireEvent.click(trigger);

		expect(trigger).toHaveAttribute('aria-expanded', 'true');
		const menu = screen.getByRole('menu', { name: 'Roon zones' });
		expect(menu).toBeInTheDocument();
		expect(screen.getByRole('menuitemradio', { name: 'Studio' })).toHaveAttribute(
			'aria-checked',
			'true'
		);

		await fireEvent.click(screen.getByRole('menuitemradio', { name: 'Kitchen' }));

		expect(get(selectedZoneStore)).toBe('zone-b');
		expect(
			screen.getByRole('button', { name: 'Select zone, current zone Kitchen' })
		).toHaveAttribute('aria-expanded', 'false');
		expect(screen.queryByRole('menu', { name: 'Roon zones' })).toBeNull();
	});

	it('expands the Unified transport with the reference Pi density', async () => {
		libraryViewHost.publishActiveMode('unified');
		const { container } = renderLayout();
		await tick();

		const transport = container.querySelector(
			'[data-transport-presentation="unified"]'
		) as HTMLElement;
		expect(transport).not.toHaveClass('pi-density');

		publishUnifiedDensity('pi');
		await tick();

		expect(transport).toHaveClass('pi-density');
	});

	it('uses a focused neutral shell while Library has no committed mode', async () => {
		setCoreStatus({ status: 'paired' });
		libraryViewHost.publishActiveMode(null);
		const { container } = renderLayout();
		await tick();

		expect(container.querySelector('[data-shell-presentation="neutral"]')).not.toBeNull();
		expect(container.querySelector('aside.sidebar')).toBeNull();
		expect(container.querySelector('header.workspace-header')).toBeNull();
		expect(container.querySelector('[aria-label="Playback controls"]')).toBeNull();
		expect(container.querySelectorAll('[data-testid="route-child"]')).toHaveLength(1);
		expect(resolveExploreRailMock).not.toHaveBeenCalled();
		expect(invalidateExploreRailMock).toHaveBeenCalledTimes(1);
	});

	it('forces Queue back to the unchanged normal shell even after Timeline was committed', async () => {
		setCoreStatus({ status: 'paired' });
		libraryViewHost.publishActiveMode('timeline');
		const { container } = renderLayout();
		await tick();
		expect(container.querySelector('[data-shell-presentation="timeline"]')).not.toBeNull();
		expect(resolveExploreRailMock).not.toHaveBeenCalled();

		pageState.set({ url: new URL('http://localhost/queue') });
		await waitFor(() =>
			expect(container.querySelector('[data-shell-presentation="normal"]')).not.toBeNull()
		);

		expect(container.querySelector('aside.sidebar')).not.toBeNull();
		expect(container.querySelector('header.workspace-header')).not.toBeNull();
		expect(screen.queryByLabelText(/Search library/i)).not.toBeNull();
		expect(container.querySelector('[data-workspace-presentation="contained"]')).not.toBeNull();
		expect(container.querySelector('[data-transport-presentation="full"]')).not.toBeNull();
		await waitFor(() => expect(resolveExploreRailMock).toHaveBeenCalledTimes(1));
	});

	it('acquires a Classic generation before resolving the Explore rail on Queue', async () => {
		pageState.set({ url: new URL('http://localhost/queue') });
		libraryViewHost.publishActiveMode('timeline');
		setCoreStatus({ status: 'paired' });
		renderLayout();

		await waitFor(() => expect(classicSessionClaimMock).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(resolveExploreRailMock).toHaveBeenCalledTimes(1));
		expect(classicSessionClaimMock).toHaveBeenCalledWith('normal-shell');
		expect(classicSessionClaimMock.mock.invocationCallOrder[0]).toBeLessThan(
			resolveExploreRailMock.mock.invocationCallOrder[0]!
		);
	});

	it('does not reacquire a component-owned Classic session during suspend-before-Timeline commit', async () => {
		setCoreStatus({ status: 'paired' });
		const componentClaim = classicSessionClaimMock('classic-mode');
		await componentClaim.ready;
		classicSessionClaimMock.mockClear();
		renderLayout();
		await tick();
		expect(resolveExploreRailMock).not.toHaveBeenCalled();

		// LibraryViewHost suspends the outgoing component before it publishes
		// Timeline as active. The still-Classic shell must not undo that release.
		classicSessionReleaseMock(componentClaim);
		await tick();
		expect(classicSessionClaimMock).not.toHaveBeenCalled();

		libraryViewHost.publishActiveMode('timeline');
		await tick();
		expect(classicSessionClaimMock).not.toHaveBeenCalled();
		expect(get(classicSessionWritable).phase).toBe('none');
	});

	it('transfers tokenized ownership with either callback order in both directions', async () => {
		pageState.set({ url: new URL('http://localhost/queue') });
		libraryViewHost.publishActiveMode('timeline');
		setCoreStatus({ status: 'paired' });
		renderLayout();
		await waitFor(() => expect(classicSessionClaimMock).toHaveBeenCalledTimes(1));
		const normalA = classicSessionClaimMock.mock.results[0].value;

		// Normal → Classic, component first: B retires A; the later layout
		// release carries A's stale token and cannot touch B.
		const classicB = classicSessionClaimMock('classic-mode');
		await classicB.ready;
		pageState.set({ url: new URL('http://localhost/library') });
		libraryViewHost.publishActiveMode('classic');
		await tick();
		expect(get(classicSessionWritable)).toMatchObject({
			owner: 'classic-mode',
			ownerEpoch: classicB.claimId,
			phase: 'live'
		});
		expect(classicSessionReleaseMock).toHaveBeenCalledWith(normalA);

		// Classic → normal, shell first: normal C retires B; B's later cleanup
		// is stale and C remains live.
		pageState.set({ url: new URL('http://localhost/queue') });
		await waitFor(() => expect(classicSessionClaimMock).toHaveBeenCalledTimes(3));
		const normalC = classicSessionClaimMock.mock.results[2].value;
		classicSessionReleaseMock(classicB);
		expect(get(classicSessionWritable)).toMatchObject({
			owner: 'normal-shell',
			ownerEpoch: normalC.claimId,
			phase: 'live'
		});

		// Normal → Classic, shell first: the layout releases C to inactive;
		// the component then starts a distinct D generation.
		pageState.set({ url: new URL('http://localhost/library') });
		libraryViewHost.publishActiveMode('classic');
		await tick();
		expect(get(classicSessionWritable).owner).toBe('inactive');
		const classicD = classicSessionClaimMock('classic-mode');
		await classicD.ready;

		// Classic → normal, component first: D releases to inactive, then the
		// route transition starts exactly one normal-shell E claim.
		classicSessionReleaseMock(classicD);
		await tick();
		expect(get(classicSessionWritable).owner).toBe('inactive');
		pageState.set({ url: new URL('http://localhost/queue') });
		await waitFor(() => expect(classicSessionClaimMock).toHaveBeenCalledTimes(5));
		expect(get(classicSessionWritable)).toMatchObject({ owner: 'normal-shell', phase: 'live' });
	});

	it('starts fresh Queue ownership while the pre-Classic normal claim is still deferred', async () => {
		const pendingNormal = deferred<{ handleId: string; generation: number }>();
		classicClaimReadyQueue.push(pendingNormal.promise);
		pageState.set({ url: new URL('http://localhost/queue') });
		libraryViewHost.publishActiveMode('timeline');
		setCoreStatus({ status: 'paired' });
		renderLayout();
		await waitFor(() => expect(classicSessionClaimMock).toHaveBeenCalledTimes(1));
		const normalA = classicSessionClaimMock.mock.results[0].value;

		const classicB = classicSessionClaimMock('classic-mode');
		await classicB.ready;
		pageState.set({ url: new URL('http://localhost/library') });
		libraryViewHost.publishActiveMode('classic');
		await tick();
		classicSessionReleaseMock(classicB);
		pageState.set({ url: new URL('http://localhost/queue') });
		await waitFor(() => expect(classicSessionClaimMock).toHaveBeenCalledTimes(3));
		const normalC = classicSessionClaimMock.mock.results[2].value;
		await normalC.ready;

		pendingNormal.resolve({ handleId: 'late-normal-a', generation: 1 });
		await normalA.ready;
		await tick();
		expect(get(classicSessionWritable)).toMatchObject({
			owner: 'normal-shell',
			ownerEpoch: normalC.claimId,
			phase: 'live'
		});
	});

	it('resolves Explore after a failed Classic claim transfers to normal shell', async () => {
		classicClaimReadyQueue.push(Promise.reject(new Error('Classic acquire failed')));
		const failedClassic = classicSessionClaimMock('classic-mode');
		await expect(failedClassic.ready).rejects.toThrow('Classic acquire failed');
		setCoreStatus({ status: 'paired' });
		renderLayout();

		pageState.set({ url: new URL('http://localhost/queue') });
		await waitFor(() => expect(resolveExploreRailMock).toHaveBeenCalledTimes(1));
		expect(get(classicSessionWritable)).toMatchObject({ owner: 'normal-shell', phase: 'live' });
	});

	it('does not reopen a mobile rail after leaving and returning to Classic chrome', async () => {
		const { container } = renderLayout();
		await fireEvent.click(container.querySelector('button.hamburger')!);
		expect(container.querySelector('aside.sidebar')).toHaveClass('open');

		libraryViewHost.publishActiveMode('timeline');
		await tick();
		expect(container.querySelector('aside.sidebar')).toBeNull();

		libraryViewHost.publishActiveMode('classic');
		await tick();
		expect(container.querySelector('aside.sidebar')).not.toHaveClass('open');
	});

	it('invalidates invisible Classic state and resolves only its normal-shell claim', async () => {
		setCoreStatus({ status: 'paired' });
		libraryViewHost.publishActiveMode('timeline');
		renderLayout();
		await tick();

		expect(resolveExploreRailMock).not.toHaveBeenCalled();
		expect(invalidateExploreRailMock).toHaveBeenCalledTimes(1);

		libraryViewHost.publishActiveMode('classic');
		await classicSessionClaimMock('classic-mode').ready;
		await tick();
		expect(resolveExploreRailMock).not.toHaveBeenCalled();

		libraryViewHost.publishActiveMode('timeline');
		await waitFor(() => expect(invalidateExploreRailMock).toHaveBeenCalledTimes(2));
		expect(resolveExploreRailMock).not.toHaveBeenCalled();

		pageState.set({ url: new URL('http://localhost/queue') });
		await waitFor(() => expect(resolveExploreRailMock).toHaveBeenCalledTimes(1));
		expect(resolveExploreRailMock.mock.calls[0][1]).toMatchObject({ owner: 'normal-shell' });
	});

	it('keeps one transport command path while its presentation changes', async () => {
		setZonesSnapshot([makeZone({ zone_id: 'zone-a', state: 'playing' })]);
		setSelectedZone('zone-a');
		const pendingAck = deferred<{ success: true }>();
		vi.mocked(emitWithAck).mockReturnValueOnce(pendingAck.promise);
		const { container } = renderLayout();
		await tick();

		await fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
		await waitFor(() =>
			expect(emitWithAck).toHaveBeenCalledWith(
				fakeSocket,
				'transport:play-pause',
				{ zone_id: 'zone-a' },
				expect.anything()
			)
		);

		libraryViewHost.publishActiveMode('timeline');
		await tick();
		expect(container.querySelectorAll('[aria-label="Playback controls"]')).toHaveLength(1);
		expect(container.querySelector('[data-transport-presentation="compact"]')).not.toBeNull();
		const compactPause = screen.getByRole('button', { name: 'Pause' });
		expect(compactPause).toBeDisabled();
		await fireEvent.click(compactPause);
		expect(emitWithAck).toHaveBeenCalledTimes(1);

		pendingAck.resolve({ success: true });
		await pendingAck.promise;
		await waitFor(() => expect(compactPause).toBeEnabled());
		vi.mocked(emitWithAck).mockClear();
		await fireEvent.click(compactPause);
		await waitFor(() => expect(emitWithAck).toHaveBeenCalledTimes(1));
		expect(emitWithAck).toHaveBeenLastCalledWith(
			fakeSocket,
			'transport:play-pause',
			{ zone_id: 'zone-a' },
			expect.anything()
		);
	});
});

describe('Layout — selected-zone fallback', () => {
	it('retains a selected zone while live zones are temporarily empty', async () => {
		setSelectedZone('zone-b');
		setZonesSnapshot([]);
		renderLayout();
		await tick();

		expect(get(selectedZoneStore)).toBe('zone-b');

		setZonesSnapshot([
			makeZone({ zone_id: 'zone-a', display_name: 'Zone A' }),
			makeZone({ zone_id: 'zone-b', display_name: 'Zone B' })
		]);
		await tick();

		expect(get(selectedZoneStore)).toBe('zone-b');
	});

	it('falls back to the first live zone when the selected zone is absent', async () => {
		setSelectedZone('missing-zone');
		setZonesSnapshot([
			makeZone({ zone_id: 'zone-b', display_name: 'Zone B' }),
			makeZone({ zone_id: 'zone-a', display_name: 'Zone A' })
		]);
		renderLayout();

		await waitFor(() => expect(get(selectedZoneStore)).toBe('zone-b'));
	});
});

describe('Layout — degraded-health banner', () => {
	it('keeps a Timeline degraded-health banner in flow above the full-bleed workspace', async () => {
		libraryViewHost.publishActiveMode('timeline');
		setHealth({
			status: 'degraded',
			ready: false,
			timestamp: '2026-07-10T00:00:00Z',
			subsystems: {
				recently_played: {
					ready: false,
					degraded: true,
					epoch: 1,
					revision: 2,
					entry_count: 3
				}
			}
		});
		const { container } = renderLayout();
		await tick();

		const banner = screen.getByRole('status');
		const workspace = container.querySelector('.workspace-main') as HTMLElement;
		expect(banner).not.toHaveClass('overlay');
		expect(getComputedStyle(banner).position).toBe('static');
		expect(banner.nextElementSibling).toBe(workspace);
		expect(workspace).toHaveAttribute('data-workspace-presentation', 'full-bleed');
	});

	it('shows which subsystems are degraded when /api/health says not ready', async () => {
		setHealth({
			status: 'degraded',
			ready: false,
			timestamp: '2026-07-10T00:00:00Z',
			subsystems: {
				recently_played: { ready: false, degraded: true, epoch: 1, revision: 2, entry_count: 3 },
				favorites: { ready: true, degraded: false, entry_count: 4 }
			}
		});
		renderLayout();
		await tick();

		const banner = screen.getByRole('status');
		expect(banner.textContent).toMatch(/persistence degraded/i);
		expect(banner.textContent).toMatch(/Recently Played/);
		expect(banner.textContent).not.toMatch(/Favorites/);
		setHealth(null);
	});

	it('renders no banner while healthy or before the first health fetch', async () => {
		setHealth(null);
		renderLayout();
		await tick();
		expect(screen.queryByText(/persistence degraded/i)).toBeNull();

		setHealth({
			status: 'ok',
			ready: true,
			timestamp: '2026-07-10T00:00:00Z',
			subsystems: {
				favorites: { ready: true, degraded: false, entry_count: 4 }
			}
		});
		await tick();
		expect(screen.queryByText(/persistence degraded/i)).toBeNull();
	});
});

describe('Layout — typed Library intent routing', () => {
	it('publishes header free text before goto without mutating Classic browse state', async () => {
		pageState.set({ url: new URL('http://localhost/queue') });
		const priorResult = listResult({
			title: 'Prior',
			level: 1,
			items: [makeItem({ title: 'Still here', itemKey: 'prior-item-key' })]
		});
		setBrowseResult(priorResult, 'browse');
		pushHistory({ hierarchy: 'browse' }, { title: 'Prior' });

		let pendingAtGoto: unknown;
		gotoMock.mockImplementationOnce(() => {
			pendingAtGoto = get(pendingLibraryIntentStore);
			return Promise.resolve();
		});
		renderLayout();

		const input = screen.getByPlaceholderText(/search artists, albums, tracks/i);
		await fireEvent.input(input, { target: { value: 'tori amos' } });
		await fireEvent.keyDown(input, { key: 'Enter' });

		expect(pendingAtGoto).toEqual(
			expect.objectContaining({
				historyMutation: 'replace',
				intent: {
					kind: 'general',
					destination: 'search',
					query: 'tori amos',
					display: { title: 'tori amos' }
				}
			})
		);
		expect(gotoMock).toHaveBeenCalledWith('/library');
		expect(apiBrowse).not.toHaveBeenCalled();
		expect(get(browseHistoryStore).history.map((step) => step.breadcrumb.title)).toEqual([
			'Prior'
		]);
		expect(get(browseStore).current).toBe(priorResult);
	});

	it('cancels only the rejected route request and reports the failure', async () => {
		pageState.set({ url: new URL('http://localhost/queue') });
		let rejectRoute!: (reason: Error) => void;
		gotoMock.mockReturnValueOnce(
			new Promise<void>((_resolve, reject) => {
				rejectRoute = reject;
			})
		);
		renderLayout();

		const input = screen.getByPlaceholderText(/search artists, albums, tracks/i);
		await fireEvent.input(input, { target: { value: 'first request' } });
		await fireEvent.keyDown(input, { key: 'Enter' });
		const routed = get(pendingLibraryIntentStore);
		expect(routed?.intent).toEqual(
			expect.objectContaining({ destination: 'search', query: 'first request' })
		);

		await fireEvent.input(input, { target: { value: 'newer request' } });
		await fireEvent.keyDown(input, { key: 'Enter' });
		const newer = get(pendingLibraryIntentStore);
		expect(newer?.requestId).not.toBe(routed?.requestId);
		expect(newer?.intent).toEqual(
			expect.objectContaining({ destination: 'search', query: 'newer request' })
		);
		expect(gotoMock).toHaveBeenCalledTimes(2);
		rejectRoute(new Error('route failed'));

		const { commandFeedbackStore } = await import('$lib/stores/commandFeedbackStore');
		await waitFor(() => {
			expect(get(commandFeedbackStore)?.message).toMatch(/route failed/i);
		});
		expect(get(pendingLibraryIntentStore)?.requestId).toBe(newer?.requestId);
		expect(apiBrowse).not.toHaveBeenCalled();
	});
});

describe('Layout — mobile hamburger toggle', () => {
	it('opens and closes the sidebar', async () => {
		const { container } = renderLayout();
		await tick();

		const sidebar = container.querySelector('aside.sidebar');
		const hamburger = container.querySelector('button.hamburger');
		expect(sidebar).toBeTruthy();
		expect(hamburger).toBeTruthy();
		expect(sidebar!.classList.contains('open')).toBe(false);

		await fireEvent.click(hamburger!);
		await tick();
		expect(sidebar!.classList.contains('open')).toBe(true);

		const scrim = container.querySelector('.sidebar-scrim');
		expect(scrim).toBeTruthy();
		await fireEvent.click(scrim!);
		await tick();
		expect(sidebar!.classList.contains('open')).toBe(false);
	});
});

describe('Layout — Favorites rail intent', () => {
	it('publishes the keyless welcome destination in the existing rail position', async () => {
		railWritable.set({
			entries: [
				{ id: 'r1', label: 'Artists', labelPath: ['Library', 'Artists'], isEmpty: false },
				{ id: 'r2', label: 'Playlists', labelPath: ['Playlists'], isEmpty: false }
			],
			loading: false,
			error: null
		});
		const priorResult = listResult({
			title: 'Albums',
			level: 2,
			items: [makeItem({ title: 'A', itemKey: 'current-key' })]
		});
		setBrowseResult(priorResult, 'browse');
		pushHistory({ hierarchy: 'browse' }, { title: 'Albums' });

		renderLayout();
		await tick();
		const railLabels = Array.from(document.querySelectorAll('.rail-link')).map((button) =>
			button.textContent?.trim()
		);
		expect(railLabels.indexOf('Favorites')).toBeGreaterThan(railLabels.indexOf('Artists'));
		expect(railLabels.indexOf('Favorites')).toBeLessThan(railLabels.indexOf('Playlists'));

		await fireEvent.click(screen.getByRole('button', { name: 'Favorites' }));
		expect(get(pendingLibraryIntentStore)?.intent).toEqual({
			kind: 'general',
			destination: 'welcome-section',
			section: 'favorites'
		});
		expect(get(pendingLibraryIntentStore)?.historyMutation).toBe('push');
		expect(gotoMock).not.toHaveBeenCalled();
		expect(apiBrowse).not.toHaveBeenCalled();
		expect(get(browseHistoryStore).history.map((step) => step.breadcrumb.title)).toEqual([
			'Albums'
		]);
		expect(get(browseStore).current).toBe(priorResult);
	});

	it('publishes before cross-route goto and leaves Classic state for the consumer', async () => {
		pageState.set({ url: new URL('http://localhost/queue') });
		const priorResult = listResult({ title: 'Prior', level: 1 });
		setBrowseResult(priorResult, 'browse');
		pushHistory({ hierarchy: 'browse' }, { title: 'Prior' });
		let intentAtGoto: unknown;
		gotoMock.mockImplementationOnce(() => {
			intentAtGoto = get(pendingLibraryIntentStore)?.intent;
			return Promise.resolve();
		});

		renderLayout();
		await fireEvent.click(screen.getByRole('button', { name: 'Favorites' }));

		expect(intentAtGoto).toEqual({
			kind: 'general',
			destination: 'welcome-section',
			section: 'favorites'
		});
		expect(get(browseHistoryStore).history.map((step) => step.breadcrumb.title)).toEqual([
			'Prior'
		]);
		expect(get(browseStore).current).toBe(priorResult);
	});
});

describe('Layout — Explore rail intent', () => {
	it('copies only the semantic label path and performs no layout-side Browse work', async () => {
		const labelPath = ['Library', 'Albums'];
		railWritable.set({
			entries: [
				{
					id: 'rail-albums',
					label: 'Albums',
					labelPath,
					isEmpty: false,
					cachedKey: 'forbidden-leaf-key',
					cachedAncestorKeys: ['forbidden-parent-key']
				}
			],
			loading: false,
			error: null
		});
		const priorResult = listResult({
			title: 'Prior',
			level: 1,
			items: [makeItem({ title: 'Prior item', itemKey: 'prior-item-key' })]
		});
		setBrowseResult(priorResult, 'browse');
		pushHistory({ hierarchy: 'browse' }, { title: 'Prior' });

		renderLayout();
		await fireEvent.click(await screen.findByRole('button', { name: 'Albums' }));

		const intent = get(pendingLibraryIntentStore)?.intent;
		expect(intent).toEqual({
			kind: 'general',
			destination: 'explore-path',
			labelPath: ['Library', 'Albums']
		});
		expect(JSON.stringify(intent)).not.toContain('forbidden');
		labelPath[1] = 'Mutated after publish';
		expect(get(pendingLibraryIntentStore)?.intent).toEqual({
			kind: 'general',
			destination: 'explore-path',
			labelPath: ['Library', 'Albums']
		});
		expect(apiBrowse).not.toHaveBeenCalled();
		expect(gotoMock).not.toHaveBeenCalled();
		expect(get(browseHistoryStore).history.map((step) => step.breadcrumb.title)).toEqual([
			'Prior'
		]);
		expect(get(browseStore).current).toBe(priorResult);
	});
});

describe('Layout — play-bar Library intents', () => {
	it('publishes a typed artist search without resolving or persisting a Roon key', async () => {
		setSelectedZone('zone-a');
		setNowPlaying('zone-a', {
			zone_id: 'zone-a',
			state: 'playing',
			title: 'Cornflake Girl',
			artist: 'Tilda Arlen',
			album: 'Under the Pink',
			duration: 300,
			seek_position: 0
		});
		pushHistory({ hierarchy: 'browse' }, { title: 'Prior' });

		renderLayout();
		await fireEvent.click(await screen.findByRole('button', { name: 'Tilda Arlen' }));

		expect(get(pendingLibraryIntentStore)?.intent).toEqual({
			kind: 'artist',
			destination: 'search',
			query: 'Tilda Arlen',
			display: { title: 'Tilda Arlen' }
		});
		expect(apiBrowse).not.toHaveBeenCalled();
		expect(get(browseHistoryStore).history.map((step) => step.breadcrumb.title)).toEqual([
			'Prior'
		]);
	});

	it('keeps multi-artist credits split and publishes only the selected name', async () => {
		setSelectedZone('zone-a');
		setNowPlaying('zone-a', {
			zone_id: 'zone-a',
			state: 'playing',
			title: 'Wait For It',
			artist: 'Leland Orlov, Jr. / Lio-Marcus Mendel'
		});
		renderLayout();
		await tick();

		expect(
			screen.queryByRole('button', { name: 'Leland Orlov, Jr. / Lio-Marcus Mendel' })
		).toBeNull();
		await fireEvent.click(screen.getByRole('button', { name: 'Lio-Marcus Mendel' }));
		expect(get(pendingLibraryIntentStore)?.intent).toEqual({
			kind: 'artist',
			destination: 'search',
			query: 'Lio-Marcus Mendel',
			display: { title: 'Lio-Marcus Mendel' }
		});
		expect(apiBrowse).not.toHaveBeenCalled();
	});

	it('publishes album and artist display evidence from the now-playing overlay', async () => {
		setSelectedZone('zone-a');
		setNowPlaying('zone-a', {
			zone_id: 'zone-a',
			state: 'playing',
			title: 'Cornflake Girl',
			artist: 'Tilda Arlen',
			album: 'Under the Pink',
			duration: 300,
			seek_position: 0
		});
		renderLayout();

		await fireEvent.click(await screen.findByRole('button', { name: 'Open now playing' }));
		await fireEvent.click(await screen.findByRole('button', { name: 'Go to album Under the Pink' }));

		expect(get(pendingLibraryIntentStore)?.intent).toEqual({
			kind: 'album',
			destination: 'search',
			query: 'Under the Pink',
			display: { title: 'Under the Pink', artist: 'Tilda Arlen' }
		});
		expect(apiBrowse).not.toHaveBeenCalled();
	});
});

describe('Layout — transport controls', () => {
	function setupActiveZone() {
		const zone = makeZone({
			zone_id: 'zone-a',
			outputs: [
				{
					output_id: 'out-a',
					display_name: 'Main',
					volume: { type: 'number', min: 0, max: 100, value: 50, step: 1, is_muted: false }
				}
			]
		});
		setZonesSnapshot([zone]);
		setSelectedZone('zone-a');
		setNowPlaying('zone-a', {
			zone_id: 'zone-a',
			state: 'playing',
			title: 'Cornflake Girl',
			artist: 'Tilda Arlen',
			album: 'Under the Pink',
			duration: 300,
			seek_position: 30
		});
	}

	it('Play/Pause button emits transport:play-pause for the active zone', async () => {
		setupActiveZone();
		renderLayout();
		// `aria-label` is "Pause" while state is 'playing'.
		const btn = await screen.findByRole('button', { name: 'Pause' });
		await fireEvent.click(btn);

		await waitFor(() => {
			expect(emitWithAck).toHaveBeenCalledWith(
				fakeSocket,
				'transport:play-pause',
				expect.objectContaining({ zone_id: 'zone-a' }),
				expect.objectContaining({ timeoutMs: 3000 })
			);
		});
	});

	it('Next button emits transport:next', async () => {
		setupActiveZone();
		renderLayout();
		const btn = await screen.findByRole('button', { name: 'Next' });
		await fireEvent.click(btn);

		await waitFor(() => {
			expect(emitWithAck).toHaveBeenCalledWith(
				fakeSocket,
				'transport:next',
				expect.objectContaining({ zone_id: 'zone-a' }),
				expect.any(Object)
			);
		});
	});

	it('Previous button emits transport:previous', async () => {
		setupActiveZone();
		renderLayout();
		const btn = await screen.findByRole('button', { name: 'Previous' });
		await fireEvent.click(btn);

		await waitFor(() => {
			expect(emitWithAck).toHaveBeenCalledWith(
				fakeSocket,
				'transport:previous',
				expect.objectContaining({ zone_id: 'zone-a' }),
				expect.any(Object)
			);
		});
	});

	it('Play/Pause button is rendered but disabled when no zone is selected', async () => {
		// No setupActiveZone — selectedZone is empty. The play-bar
		// transport buttons render unconditionally; canPlay falls to
		// false so the button is disabled. Clicking it is a no-op.
		renderLayout();
		await tick();
		const btn = await screen.findByRole('button', { name: 'Play' });
		expect(btn).toBeDisabled();
		await fireEvent.click(btn);
		expect(emitWithAck).not.toHaveBeenCalled();
	});

	it('Transport buttons disable when the zone forbids the action', async () => {
		// state: 'paused' → aria-label = 'Play' (isPlaying derives from
		// activeZone.state, not nowPlaying.state).
		const zone = makeZone({
			zone_id: 'zone-a',
			state: 'paused',
			is_play_allowed: false,
			is_pause_allowed: false,
			is_next_allowed: false,
			is_previous_allowed: false
		});
		setZonesSnapshot([zone]);
		setSelectedZone('zone-a');
		setNowPlaying('zone-a', {
			zone_id: 'zone-a',
			state: 'paused',
			title: 'X',
			artist: 'Y',
			album: 'Z',
			duration: 0,
			seek_position: 0
		});

		renderLayout();
		const play = await screen.findByRole('button', { name: 'Play' });
		const next = screen.getByRole('button', { name: 'Next' });
		const prev = screen.getByRole('button', { name: 'Previous' });
		expect(play).toBeDisabled();
		expect(next).toBeDisabled();
		expect(prev).toBeDisabled();
	});
});

describe('Layout — volume controls', () => {
	function setupAbsoluteVolumeZone() {
		const zone = makeZone({
			zone_id: 'zone-a',
			outputs: [
				{
					output_id: 'out-a',
					display_name: 'Main',
					volume: { type: 'number', min: 0, max: 100, value: 42, step: 1, is_muted: false }
				}
			]
		});
		setZonesSnapshot([zone]);
		setSelectedZone('zone-a');
		setNowPlaying('zone-a', {
			zone_id: 'zone-a',
			state: 'playing',
			title: 't',
			artist: 'a',
			album: 'al',
			duration: 100,
			seek_position: 0
		});
	}

	it('Volume +/- buttons emit transport:volume directly (no rAF) for incremental zones', async () => {
		// +/- buttons only render when volumeIsIncremental === true.
		// Use an incremental volume control (fixed-step amps/preamps).
		const zone = makeZone({
			zone_id: 'zone-a',
			outputs: [
				{
					output_id: 'out-a',
					display_name: 'Preamp',
					volume: {
						type: 'incremental',
						min: 0,
						max: 0,
						value: 0,
						step: 1,
						is_muted: false
					}
				}
			]
		});
		setZonesSnapshot([zone]);
		setSelectedZone('zone-a');
		setNowPlaying('zone-a', {
			zone_id: 'zone-a',
			state: 'playing',
			title: 't',
			artist: 'a',
			album: 'al',
			duration: 100,
			seek_position: 0
		});

		renderLayout();
		const up = await screen.findByRole('button', { name: 'Volume up' });
		await fireEvent.click(up);

		expect(emitWithAck).toHaveBeenCalledWith(
			fakeSocket,
			'transport:volume',
			expect.objectContaining({ output_id: 'out-a', value: 1 }),
			expect.any(Object)
		);
	});

	it('Volume slider coalesces multiple input events into one emit per animation frame', async () => {
		setupAbsoluteVolumeZone();

		// Stub rAF so we control when the flush fires. Capture the
		// callback so the test can decide when to invoke it.
		const rafCallbacks: FrameRequestCallback[] = [];
		const rafSpy = vi
			.spyOn(window, 'requestAnimationFrame')
			.mockImplementation((cb) => {
				rafCallbacks.push(cb);
				return rafCallbacks.length;
			});

		try {
			renderLayout();
			const slider = (await screen.findByLabelText('Volume')) as HTMLInputElement;

			// Three drag events back-to-back; each calls onVolumeSlide,
			// which sets pendingVolume and schedules ONE rAF (the first
			// time only). Subsequent input events update pendingVolume
			// without scheduling a new rAF.
			slider.value = '60';
			await fireEvent.input(slider);
			slider.value = '65';
			await fireEvent.input(slider);
			slider.value = '70';
			await fireEvent.input(slider);

			// Before the rAF fires: no emit yet.
			expect(emitWithAck).not.toHaveBeenCalled();
			// Only ONE rAF scheduled despite three input events.
			expect(rafCallbacks).toHaveLength(1);

			// Fire the rAF — should emit ONCE with the LATEST value (70).
			rafCallbacks[0](performance.now());
			await tick();
			expect(emitWithAck).toHaveBeenCalledTimes(1);
			expect(emitWithAck).toHaveBeenCalledWith(
				fakeSocket,
				'transport:volume',
				expect.objectContaining({ output_id: 'out-a', value: 70 }),
				expect.any(Object)
			);
		} finally {
			rafSpy.mockRestore();
		}
	});

	it('Volume slider is absent for fixed-volume zones (no volume control on output)', async () => {
		const zone = makeZone({
			zone_id: 'zone-a',
			outputs: [
				{ output_id: 'out-fixed', display_name: 'Fixed DAC' }
				// No volume field → fixed-volume output.
			]
		});
		setZonesSnapshot([zone]);
		setSelectedZone('zone-a');
		setNowPlaying('zone-a', {
			zone_id: 'zone-a',
			state: 'playing',
			title: 't',
			artist: 'a',
			album: 'al',
			duration: 100,
			seek_position: 0
		});

		renderLayout();
		await tick();
		expect(screen.queryByLabelText('Volume')).toBeNull();
		expect(screen.queryByRole('button', { name: 'Volume up' })).toBeNull();
	});
});

describe('Layout — theme toggle', () => {
	it('Controller settings changes the shared themeStore dark ↔ light', async () => {
		// Force a known starting state.
		const initial = get(themeStore);
		const expectedAfterOne = initial === 'dark' ? 'light' : 'dark';

		renderLayout();
		await fireEvent.click(
			await screen.findByRole('button', { name: 'Open Controller settings' })
		);
		const appearance = await screen.findByRole('group', { name: 'Appearance' });
		const expectedRadio = appearance.querySelector<HTMLInputElement>(
			`input[value="${expectedAfterOne}"]`
		)!;

		await fireEvent.click(expectedRadio);
		expect(get(themeStore)).toBe(expectedAfterOne);

		const initialRadio = appearance.querySelector<HTMLInputElement>(
			`input[value="${initial}"]`
		)!;
		await fireEvent.click(initialRadio);
		expect(get(themeStore)).toBe(initial);

		// Restore so subsequent tests see the original.
		if (get(themeStore) !== initial) {
			toggleTheme();
		}
	});
});

describe('Layout — Controller settings', () => {
	it('mounts one shared settings trigger across Classic, Timeline, neutral, and normal shells', async () => {
		const { container } = renderLayout();
		await tick();
		const oneTrigger = () =>
			expect(screen.getAllByRole('button', { name: 'Open Controller settings' })).toHaveLength(1);

		oneTrigger();
		libraryViewHost.publishActiveMode('timeline');
		await waitFor(() =>
			expect(container.querySelector('[data-shell-presentation="timeline"]')).not.toBeNull()
		);
		oneTrigger();
		libraryViewHost.publishActiveMode(null);
		await waitFor(() =>
			expect(container.querySelector('[data-shell-presentation="neutral"]')).not.toBeNull()
		);
		oneTrigger();
		pageState.set({ url: new URL('http://localhost/queue') });
		await waitFor(() =>
			expect(container.querySelector('[data-shell-presentation="normal"]')).not.toBeNull()
		);
		oneTrigger();
	});

	it('offers only reachable views and delegates an on-Library switch to the host', async () => {
		libraryViewHost.publishActiveMode('timeline');
		const onRequest = vi.fn(async () => 'activated' as const);
		libraryViewHost.handleRequests(onRequest);
		renderLayout();

		await fireEvent.click(
			await screen.findByRole('button', { name: 'Open Controller settings' })
		);
		const group = await screen.findByRole('group', { name: 'Library view' });
		const radios = group.querySelectorAll('input[type="radio"]');
		// vitest runs as a dev build: Classic plus the dev-only Unified
		// preview entry. Gated Timeline never appears; the production-false
		// guard for Unified lives in libraryViewStore.test.ts.
		expect(radios).toHaveLength(2);
		expect(screen.queryByRole('radio', { name: /^Timeline canvas/ })).toBeNull();
		expect(screen.getByRole('radio', { name: /^Unified library/ })).not.toBeChecked();
		expect(group).toHaveTextContent('Current view: Timeline canvas');

		await fireEvent.click(screen.getByRole('radio', { name: /^Classic/ }));
		expect(onRequest).toHaveBeenCalledTimes(1);
		expect(onRequest).toHaveBeenCalledWith('classic');
		expect(gotoMock).not.toHaveBeenCalled();
		// Requested radio remains controlled by the committed host mode.
		expect(screen.getByRole('radio', { name: /^Classic/ })).not.toBeChecked();
		expect(group).toHaveTextContent('Current view: Timeline canvas');
	});

	it('keeps a tagged initial Library target selected while its first activation is pending', async () => {
		const { buildClassicRootPageState, buildLibraryPageStateEnvelope } =
			await import('$lib/libraryPageState');
		pageState.set({
			url: new URL('http://localhost/library'),
			state: buildLibraryPageStateEnvelope(
				buildClassicRootPageState({ hierarchy: 'search', query: 'Bowie' })
			)
		});
		libraryViewHost.publishActiveMode(null, null, 'classic');
		const onRequest = vi.fn(async () => 'activated' as const);
		libraryViewHost.handleRequests(onRequest);
		renderLayout();

		await fireEvent.click(
			await screen.findByRole('button', { name: 'Open Controller settings' })
		);
		const group = await screen.findByRole('group', { name: 'Library view' });
		const classic = screen.getByRole('radio', { name: /^Classic/ });
		expect(group).toHaveTextContent('Current view: Classic');
		expect(classic).toBeChecked();

		await fireEvent.click(classic);
		expect(onRequest).not.toHaveBeenCalled();
		expect(gotoMock).not.toHaveBeenCalled();
	});

	it('keeps an explicit pending Timeline target visible while allowing Classic recovery', async () => {
		const { buildLibraryPageStateEnvelope, buildTimelineRootPageState } =
			await import('$lib/libraryPageState');
		pageState.set({
			url: new URL('http://localhost/library'),
			state: buildLibraryPageStateEnvelope(buildTimelineRootPageState())
		});
		libraryViewHost.publishActiveMode(null, null, 'timeline');
		const onRequest = vi.fn(async () => 'activated' as const);
		libraryViewHost.handleRequests(onRequest);
		renderLayout();

		await fireEvent.click(
			await screen.findByRole('button', { name: 'Open Controller settings' })
		);
		const group = await screen.findByRole('group', { name: 'Library view' });
		const classic = screen.getByRole('radio', { name: /^Classic/ });
		expect(group).toHaveTextContent('Current view: Timeline canvas');
		expect(classic).not.toBeChecked();
		expect(screen.queryByRole('radio', { name: /^Timeline canvas/ })).toBeNull();

		await fireEvent.click(classic);
		expect(onRequest).toHaveBeenCalledWith('classic');
		expect(gotoMock).not.toHaveBeenCalled();
	});

	it('does not label a terminally failed tagged target as the current view', async () => {
		const { buildLibraryPageStateEnvelope, buildTimelineRootPageState } =
			await import('$lib/libraryPageState');
		pageState.set({
			url: new URL('http://localhost/library'),
			state: buildLibraryPageStateEnvelope(buildTimelineRootPageState())
		});
		libraryViewHost.publishActiveMode(null);
		const onRequest = vi.fn(async () => 'activated' as const);
		libraryViewHost.handleRequests(onRequest);
		renderLayout();

		await fireEvent.click(
			await screen.findByRole('button', { name: 'Open Controller settings' })
		);
		const group = await screen.findByRole('group', { name: 'Library view' });
		const classic = screen.getByRole('radio', { name: /^Classic/ });
		expect(group).toHaveTextContent('Current view: No active view');
		expect(classic).not.toBeChecked();
		expect(screen.queryByRole('radio', { name: /^Timeline canvas/ })).toBeNull();

		await fireEvent.click(classic);
		expect(onRequest).toHaveBeenCalledWith('classic');
		expect(gotoMock).not.toHaveBeenCalled();
	});

	it('surfaces a failed settings activation above the open modal without changing its controlled view', async () => {
		const activation = deferred<'activated' | 'failed' | 'superseded'>();
		const feedback = await import('$lib/stores/commandFeedbackStore');
		feedback.clearCommandFeedback();
		libraryViewHost.publishActiveMode('timeline');
		libraryViewHost.handleRequests(vi.fn(() => activation.promise));
		renderLayout();

		await fireEvent.click(
			await screen.findByRole('button', { name: 'Open Controller settings' })
		);
		const dialog = await screen.findByRole('dialog', { name: 'Controller settings' });
		const group = await screen.findByRole('group', { name: 'Library view' });
		const classic = screen.getByRole('radio', { name: /^Classic/ });
		await fireEvent.click(classic);
		expect(get(feedback.commandFeedbackStore)).toBeNull();

		activation.resolve('failed');
		await waitFor(() => {
			expect(get(feedback.commandFeedbackStore)).toMatchObject({
				command: 'controller-settings',
				message: 'Could not change Library view. Close Controller settings to retry.'
			});
		});
		expect(dialog).toBeInTheDocument();
		expect(screen.getByText('Could not change Library view. Close Controller settings to retry.'))
			.toBeInTheDocument();
		expect(group).toHaveTextContent('Current view: Timeline canvas');
		expect(classic).not.toBeChecked();
		expect(screen.queryByRole('radio', { name: /^Timeline canvas/ })).toBeNull();
		feedback.clearCommandFeedback();
	});
});

describe('Layout — build revision stamp', () => {
	it('shows the UI build revision in the sidebar footer', async () => {
		renderLayout();
		await tick();
		// The $app/environment stub pins version to 'test'.
		expect(screen.getByText('rev test')).toBeInTheDocument();
	});
});

describe('Layout — seek bar', () => {
	it('click on the seek bar emits transport:seek at the proportional position', async () => {
		const zone = makeZone({
			zone_id: 'zone-a',
			seek_position: 30,
			is_seek_allowed: true
		});
		setZonesSnapshot([zone]);
		setSelectedZone('zone-a');
		setNowPlaying('zone-a', {
			zone_id: 'zone-a',
			state: 'playing',
			title: 't',
			artist: 'a',
			album: 'al',
			duration: 200, // 200s track
			seek_position: 30
		});

		const { container } = renderLayout();
		await tick();
		const bar = container.querySelector('.pb-progress-bar') as HTMLElement;
		expect(bar).toBeTruthy();

		// Stub getBoundingClientRect: bar is 400px wide starting at x=0.
		bar.getBoundingClientRect = () =>
			({
				left: 0,
				right: 400,
				width: 400,
				top: 0,
				bottom: 8,
				height: 8,
				x: 0,
				y: 0,
				toJSON: () => ({})
			}) as DOMRect;

		// Click at 100px = 25% of 400px = 50s of 200s.
		await fireEvent.click(bar, { clientX: 100 });

		expect(emitWithAck).toHaveBeenCalledWith(
			fakeSocket,
			'transport:seek',
			expect.objectContaining({ zone_id: 'zone-a', seconds: 50 }),
			expect.any(Object)
		);
	});

	it('ArrowRight on the focused seek bar emits transport:seek 5s ahead', async () => {
		const zone = makeZone({
			zone_id: 'zone-a',
			seek_position: 30,
			is_seek_allowed: true
		});
		setZonesSnapshot([zone]);
		setSelectedZone('zone-a');
		setNowPlaying('zone-a', {
			zone_id: 'zone-a',
			state: 'playing',
			title: 't',
			artist: 'a',
			album: 'al',
			duration: 200,
			seek_position: 30
		});

		const { container } = renderLayout();
		await tick();
		const bar = container.querySelector('.pb-progress-bar') as HTMLElement;
		expect(bar.getAttribute('role')).toBe('slider');
		expect(bar.getAttribute('tabindex')).toBe('0');

		await fireEvent.keyDown(bar, { key: 'ArrowRight' });

		expect(emitWithAck).toHaveBeenCalledWith(
			fakeSocket,
			'transport:seek',
			expect.objectContaining({ zone_id: 'zone-a', seconds: 35 }),
			expect.any(Object)
		);
	});

	it('repeated ArrowRight inside one server tick steps 35 then 40, not 35 twice (rev-8)', async () => {
		// Roon reports seek position at ~1 Hz and seeks are absolute, so
		// both keydowns here see the same server-fed base (30). Without
		// an optimistic base the second press re-sends 35 and a held key
		// under-seeks (~5s total instead of ~5s per repeat).
		const zone = makeZone({
			zone_id: 'zone-a',
			seek_position: 30,
			is_seek_allowed: true
		});
		setZonesSnapshot([zone]);
		setSelectedZone('zone-a');
		setNowPlaying('zone-a', {
			zone_id: 'zone-a',
			state: 'playing',
			title: 't',
			artist: 'a',
			album: 'al',
			duration: 200,
			seek_position: 30
		});

		const { container } = renderLayout();
		await tick();
		const bar = container.querySelector('.pb-progress-bar') as HTMLElement;

		await fireEvent.keyDown(bar, { key: 'ArrowRight' });
		await fireEvent.keyDown(bar, { key: 'ArrowRight' });

		const seeks = vi
			.mocked(emitWithAck)
			.mock.calls.filter(([, event]) => event === 'transport:seek')
			.map(([, , payload]) => (payload as { seconds: number }).seconds);
		expect(seeks).toEqual([35, 40]);
	});

	it('a track change mid-hold drops the old track’s optimistic base (rev-8 round 2)', async () => {
		// The optimistic base is keyed by zone AND track identity: after
		// the track changes, the next press must compute from the new
		// track's server position, not the previous track's target.
		const zone = makeZone({
			zone_id: 'zone-a',
			seek_position: 30,
			is_seek_allowed: true
		});
		setZonesSnapshot([zone]);
		setSelectedZone('zone-a');
		setNowPlaying('zone-a', {
			zone_id: 'zone-a',
			state: 'playing',
			title: 'Track One',
			artist: 'a',
			album: 'al',
			duration: 200,
			seek_position: 30
		});

		const { container } = renderLayout();
		await tick();
		const bar = container.querySelector('.pb-progress-bar') as HTMLElement;

		await fireEvent.keyDown(bar, { key: 'ArrowRight' }); // 35 from base 30

		setNowPlaying('zone-a', {
			zone_id: 'zone-a',
			state: 'playing',
			title: 'Track Two',
			artist: 'a',
			album: 'al',
			duration: 180,
			seek_position: 30
		});
		await tick();

		await fireEvent.keyDown(bar, { key: 'ArrowRight' });

		const seeks = vi
			.mocked(emitWithAck)
			.mock.calls.filter(([, event]) => event === 'transport:seek')
			.map(([, , payload]) => (payload as { seconds: number }).seconds);
		// Second press bases on the new track's server position (30),
		// not the old track's pending target (35).
		expect(seeks).toEqual([35, 35]);
	});

	it('a failed seek does not leave a phantom optimistic base (rev-8 round 2)', async () => {
		const zone = makeZone({
			zone_id: 'zone-a',
			seek_position: 30,
			is_seek_allowed: true
		});
		setZonesSnapshot([zone]);
		setSelectedZone('zone-a');
		setNowPlaying('zone-a', {
			zone_id: 'zone-a',
			state: 'playing',
			title: 't',
			artist: 'a',
			album: 'al',
			duration: 200,
			seek_position: 30
		});

		const { container } = renderLayout();
		await tick();
		const bar = container.querySelector('.pb-progress-bar') as HTMLElement;

		// The Right press's delivery fails (e.g. dropped connection).
		vi.mocked(emitWithAck).mockResolvedValueOnce({
			success: false,
			error: 'Not connected to server'
		});
		await fireEvent.keyDown(bar, { key: 'ArrowRight' }); // 35, fails
		await tick(); // flush the delivery-result handler

		await fireEvent.keyDown(bar, { key: 'ArrowLeft' });

		const seeks = vi
			.mocked(emitWithAck)
			.mock.calls.filter(([, event]) => event === 'transport:seek')
			.map(([, , payload]) => (payload as { seconds: number }).seconds);
		// Left computes from the server base (30 → 25), not the failed
		// target (35 → 30).
		expect(seeks).toEqual([35, 25]);
	});

	it('play-bar position advances between 1 Hz server ticks (interpolation)', async () => {
		vi.useFakeTimers();
		try {
			const zone = makeZone({
				zone_id: 'zone-a',
				seek_position: 30,
				is_seek_allowed: true,
				state: 'playing'
			});
			setZonesSnapshot([zone]);
			setSelectedZone('zone-a');
			setNowPlaying('zone-a', {
				zone_id: 'zone-a',
				state: 'playing',
				title: 't',
				artist: 'a',
				album: 'al',
				duration: 200,
				seek_position: 30
			});

			const { container } = renderLayout();
			await tick();
			const bar = container.querySelector('.pb-progress-bar') as HTMLElement;
			expect(bar.getAttribute('aria-valuenow')).toBe('30');

			// No server tick arrives — the displayed position must still
			// advance with wall-clock time while the zone is playing.
			vi.advanceTimersByTime(1100);
			await tick();
			expect(Number(bar.getAttribute('aria-valuenow'))).toBeGreaterThanOrEqual(31);
		} finally {
			vi.useRealTimers();
		}
	});

	it('Home on the seek bar seeks to the start; unrelated keys emit nothing', async () => {
		const zone = makeZone({
			zone_id: 'zone-a',
			seek_position: 120,
			is_seek_allowed: true
		});
		setZonesSnapshot([zone]);
		setSelectedZone('zone-a');
		setNowPlaying('zone-a', {
			zone_id: 'zone-a',
			state: 'playing',
			title: 't',
			artist: 'a',
			album: 'al',
			duration: 200,
			seek_position: 120
		});

		const { container } = renderLayout();
		await tick();
		const bar = container.querySelector('.pb-progress-bar') as HTMLElement;

		await fireEvent.keyDown(bar, { key: 'Home' });
		expect(emitWithAck).toHaveBeenCalledWith(
			fakeSocket,
			'transport:seek',
			expect.objectContaining({ zone_id: 'zone-a', seconds: 0 }),
			expect.any(Object)
		);

		vi.mocked(emitWithAck).mockClear();
		await fireEvent.keyDown(bar, { key: 'Enter' });
		expect(emitWithAck).not.toHaveBeenCalled();
	});

	it('keyboard seek does NOT emit when zone forbids seeking', async () => {
		const zone = makeZone({
			zone_id: 'zone-a',
			is_seek_allowed: false
		});
		setZonesSnapshot([zone]);
		setSelectedZone('zone-a');
		setNowPlaying('zone-a', {
			zone_id: 'zone-a',
			state: 'playing',
			title: 't',
			artist: 'a',
			album: 'al',
			duration: 200,
			seek_position: 30
		});

		const { container } = renderLayout();
		await tick();
		const bar = container.querySelector('.pb-progress-bar') as HTMLElement;
		expect(bar.getAttribute('tabindex')).toBe('-1');

		await fireEvent.keyDown(bar, { key: 'ArrowRight' });
		expect(emitWithAck).not.toHaveBeenCalledWith(
			fakeSocket,
			'transport:seek',
			expect.anything(),
			expect.anything()
		);
	});

	it('seek bar does NOT emit when zone forbids seeking', async () => {
		const zone = makeZone({
			zone_id: 'zone-a',
			is_seek_allowed: false
		});
		setZonesSnapshot([zone]);
		setSelectedZone('zone-a');
		setNowPlaying('zone-a', {
			zone_id: 'zone-a',
			state: 'playing',
			title: 't',
			artist: 'a',
			album: 'al',
			duration: 200,
			seek_position: 30
		});

		const { container } = renderLayout();
		await tick();
		const bar = container.querySelector('.pb-progress-bar') as HTMLElement;
		bar.getBoundingClientRect = () =>
			({
				left: 0,
				right: 400,
				width: 400,
				top: 0,
				bottom: 8,
				height: 8,
				x: 0,
				y: 0,
				toJSON: () => ({})
			}) as DOMRect;

		await fireEvent.click(bar, { clientX: 100 });
		expect(emitWithAck).not.toHaveBeenCalledWith(
			fakeSocket,
			'transport:seek',
			expect.anything(),
			expect.anything()
		);
	});
});

describe('Layout — play-bar → now-playing overlay wiring (PR2)', () => {
	// PR2 replaced the play-bar title's "navigate to album" behavior
	// with "open the now-playing overlay" (album navigation now lives
	// inside the overlay as a "Go to album" button). The artwork is
	// also a button for the same purpose.
	it('clicking the play-bar artwork opens the now-playing overlay', async () => {
		setSelectedZone('zone-a');
		setNowPlaying('zone-a', {
			zone_id: 'zone-a',
			state: 'playing',
			title: 'Cornflake Girl',
			artist: 'Tilda Arlen',
			album: 'Under the Pink',
			image_key: 'img-x',
			duration: 200,
			seek_position: 0
		});

		const { nowPlayingOverlayStore, closeNowPlayingOverlay } = await import(
			'$lib/stores/nowPlayingOverlayStore'
		);
		closeNowPlayingOverlay();

		renderLayout();
		const artBtn = await screen.findByRole('button', { name: 'Open now playing' });
		expect(get(nowPlayingOverlayStore)).toBe(false);
		await fireEvent.click(artBtn);
		expect(get(nowPlayingOverlayStore)).toBe(true);
		closeNowPlayingOverlay();
	});

	it('clicking the play-bar title opens the now-playing overlay (no album navigation)', async () => {
		setSelectedZone('zone-a');
		setNowPlaying('zone-a', {
			zone_id: 'zone-a',
			state: 'playing',
			title: 'Cornflake Girl',
			artist: 'Tilda Arlen',
			album: 'Under the Pink',
			duration: 200,
			seek_position: 0
		});

		const { nowPlayingOverlayStore, closeNowPlayingOverlay } = await import(
			'$lib/stores/nowPlayingOverlayStore'
		);
		closeNowPlayingOverlay();

		renderLayout();
		const titleBtn = await screen.findByRole('button', { name: 'Cornflake Girl' });
		await fireEvent.click(titleBtn);
		expect(get(nowPlayingOverlayStore)).toBe(true);
		// Title click no longer triggers apiBrowse — navigation moved
		// into the overlay's "Go to album" button.
		expect(apiBrowse).not.toHaveBeenCalled();
		closeNowPlayingOverlay();
	});

	it('artwork button is disabled when there is no track playing', async () => {
		// No nowPlaying for the selected zone.
		setSelectedZone('zone-a');
		renderLayout();
		const artBtn = await screen.findByRole('button', { name: 'Open now playing' });
		expect(artBtn).toBeDisabled();
	});
});
