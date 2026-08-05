import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TestNavigation from '../../../test/app-stubs/navigation';

class MemoryStorage implements Storage {
	private readonly values = new Map<string, string>();

	get length(): number {
		return this.values.size;
	}

	clear(): void {
		this.values.clear();
	}

	getItem(key: string): string | null {
		return this.values.get(key) ?? null;
	}

	key(index: number): string | null {
		return [...this.values.keys()][index] ?? null;
	}

	removeItem(key: string): void {
		this.values.delete(key);
	}

	setItem(key: string, value: string): void {
		this.values.set(key, value);
	}
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

async function loadFakeTarget() {
	return (await import('./fixtures/FakeLibraryMode.svelte')).default;
}

async function fakeLifecycleModule() {
	return await import('./fixtures/FakeLibraryMode.svelte');
}

function lifecycleEventTypes(
	events: readonly { readonly type: string; readonly mode: string }[]
): string[] {
	return [...events].map((event) => `${event.type}:${event.mode}`);
}

const classicLoader = vi.fn<() => Promise<unknown>>();
const timelineLoader = vi.fn<() => Promise<unknown>>();
const unifiedLoader = vi.fn<() => Promise<unknown>>();
let allowTimeline = false;
const mountedCleanups: Array<() => Promise<void>> = [];

function mockProductionLoaderModule(): void {
	vi.doMock('../libraryViewLoaders', async () => {
		const [{ createLibraryViewLoaderController }, { resolveAvailableLibraryView }] =
			await Promise.all([
				import('$lib/libraryViewLoaderController'),
				import('$lib/stores/libraryViewStore')
			]);

		return {
			createProductionLibraryViewLoaderController: () =>
				createLibraryViewLoaderController({
					loaders: {
						classic: classicLoader,
						timeline: timelineLoader,
						unified: unifiedLoader
					},
					resolveMode: (preferredMode) =>
						allowTimeline ? preferredMode : resolveAvailableLibraryView(preferredMode)
				})
		};
	});
}

async function importHost() {
	mockProductionLoaderModule();
	return (await import('../+page.svelte')).default;
}

async function navigationStub(): Promise<typeof TestNavigation> {
	return (await import('$app/navigation')) as unknown as typeof TestNavigation;
}

async function mountHost(Host: Awaited<ReturnType<typeof importHost>>): Promise<HTMLElement> {
	const { mount, unmount } = await import('svelte');
	const container = document.createElement('div');
	document.body.append(container);
	const instance = mount(Host, { target: container });
	mountedCleanups.push(async () => {
		await unmount(instance);
		container.remove();
	});
	return container;
}

async function findElement(container: HTMLElement, selector: string): Promise<Element> {
	await vi.waitFor(() => expect(container.querySelector(selector)).not.toBeNull());
	return container.querySelector(selector)!;
}

describe('LibraryViewHost production boundary', () => {
	let storage: MemoryStorage;
	let originalStorageDescriptor: PropertyDescriptor | undefined;

	beforeEach(() => {
		vi.resetModules();
		vi.doUnmock('../libraryViewLoaders');
		classicLoader.mockReset();
		timelineLoader.mockReset();
		unifiedLoader.mockReset();
		allowTimeline = false;
		storage = new MemoryStorage();
		storage.setItem(
			'roon-controller-library-view',
			JSON.stringify({ version: 1, preferred: 'classic' })
		);
		originalStorageDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
		Object.defineProperty(window, 'localStorage', {
			configurable: true,
			value: storage
		});
		window.sessionStorage.clear();
	});

	afterEach(async () => {
		for (const cleanup of mountedCleanups.splice(0)) await cleanup();
		vi.doUnmock('../libraryViewLoaders');
		vi.restoreAllMocks();
		if (originalStorageDescriptor) {
			Object.defineProperty(window, 'localStorage', originalStorageDescriptor);
		} else {
			Reflect.deleteProperty(window, 'localStorage');
		}
	});

	it('stays empty while the lazy Classic target is pending, then mounts exactly one target', async () => {
		const navigation = await navigationStub();
		navigation.__resetNavigation('http://localhost/library');
		const raw = JSON.stringify({ version: 1, preferred: 'timeline' });
		storage.setItem('roon-controller-library-view', raw);
		const write = vi.spyOn(storage, 'setItem');
		const gate = deferred<void>();
		classicLoader.mockImplementation(async () => {
			await gate.promise;
			return await loadFakeTarget();
		});
		const Host = await importHost();

		expect(classicLoader).not.toHaveBeenCalled();
		const container = await mountHost(Host);
		await vi.waitFor(() => expect(classicLoader).toHaveBeenCalledTimes(1));
		const [{ get }, { libraryViewStore }, { libraryViewHostStore }] = await Promise.all([
			import('svelte/store'),
			import('$lib/stores/libraryViewStore'),
			import('$lib/stores/libraryViewHostStore')
		]);
		expect(container.querySelector('[data-testid="library-mode-loading"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="library-mode-target"]')).toBeNull();
		expect(get(libraryViewStore)).toBe('timeline');
		expect(get(libraryViewHostStore)).toEqual({
			activeMode: null,
			pendingMode: 'classic',
			transition: null
		});
		expect(write).not.toHaveBeenCalled();
		expect(navigation.__getNavigationLog()).toEqual([]);

		gate.resolve();
		await findElement(container, '[data-testid="library-mode-target"]');
		expect(get(libraryViewHostStore)).toEqual({
			activeMode: 'classic',
			pendingMode: null,
			transition: null
		});
		expect(storage.getItem('roon-controller-library-view')).toBe(raw);
		expect(write).not.toHaveBeenCalled();
		expect(navigation.__getNavigationLog().map((entry) => entry.operation)).toEqual([
			'replaceState'
		]);
		expect(container.querySelectorAll('[data-testid="library-mode-target"]')).toHaveLength(1);
		expect(container.querySelector('[data-testid="library-mode-loading"]')).toBeNull();
		expect(container.querySelector('[data-testid="library-mode-error"]')).toBeNull();
	});

	it('does not rewrite an already tagged initial Classic entry', async () => {
		const [{ buildClassicRootPageState, buildLibraryPageStateEnvelope }, navigation] =
			await Promise.all([import('$lib/libraryPageState'), navigationStub()]);
		const tagged = buildLibraryPageStateEnvelope(
			buildClassicRootPageState({ hierarchy: 'search', query: 'Bowie' })
		);
		navigation.__resetNavigation('http://localhost/library', tagged);
		storage.setItem(
			'roon-controller-library-view',
			JSON.stringify({ version: 1, preferred: 'timeline' })
		);
		classicLoader.mockImplementation(loadFakeTarget);
		const Host = await importHost();

		const container = await mountHost(Host);
		await findElement(container, '[data-testid="library-mode-target"]');

		expect(navigation.__getNavigationLog()).toEqual([]);
		expect(storage.getItem('roon-controller-library-view')).toBe(
			JSON.stringify({ version: 1, preferred: 'classic' })
		);
		const { getClassicHistorySnapshot } = await import('$lib/stores/browseHistoryStore');
		expect(getClassicHistorySnapshot()).toEqual({
			context: { hierarchy: 'search', query: 'Bowie' },
			history: [],
			forward: []
		});
	});

	it('classifies an SPA goto as a route request and commits preference plus replace', async () => {
		const [{ buildClassicRootPageState, buildLibraryPageStateEnvelope }, navigation] =
			await Promise.all([import('$lib/libraryPageState'), navigationStub()]);
		const tagged = buildLibraryPageStateEnvelope(
			buildClassicRootPageState({ hierarchy: 'search', query: 'Route request' })
		);
		navigation.__resetNavigation('http://localhost/library', tagged);
		navigation.__setInitialNavigationType('goto');
		storage.setItem(
			'roon-controller-library-view',
			JSON.stringify({ version: 1, preferred: 'timeline' })
		);
		classicLoader.mockImplementation(loadFakeTarget);
		const Host = await importHost();

		const container = await mountHost(Host);
		await findElement(container, '[data-testid="library-mode-target"]');

		expect(navigation.__getNavigationLog().map((entry) => entry.operation)).toEqual([
			'replaceState'
		]);
		expect(storage.getItem('roon-controller-library-view')).toBe(
			JSON.stringify({ version: 1, preferred: 'classic' })
		);
	});

	it('preserves retained Timeline state for an off-route settings request', async () => {
		allowTimeline = true;
		classicLoader.mockImplementation(loadFakeTarget);
		timelineLoader.mockImplementation(loadFakeTarget);
		const [pageState, timelineSession, navigation] = await Promise.all([
			import('$lib/libraryPageState'),
			import('$lib/timelinePageSessionState'),
			navigationStub()
		]);
		const retained = pageState.buildTimelineLibraryPageState({
			artistQuery: 'Björk',
			selectedArtistLocalId: 'artist-local-1',
			activeSemanticPath: [{ kind: 'artist', localId: 'artist-local-1' }],
			selectedNode: { kind: 'artist', localId: 'artist-local-1' },
			camera: { x: 320, y: -48, scale: 1.5 },
			displayDepth: 0
		});
		expect(timelineSession.persistTimelineSessionPageState(retained)).toBe(true);
		navigation.__resetNavigation(
			'http://localhost/library',
			pageState.buildLibraryViewRequestPageStateEnvelope('timeline')
		);
		navigation.__setInitialNavigationType('goto');
		const Host = await importHost();

		const container = await mountHost(Host);
		const target = await findElement(container, '[data-testid="library-mode-target"]');

		expect(target).toHaveAttribute('data-activation-mode', 'timeline');
		expect(navigation.__getNavigationLog()).toEqual([
			{
				operation: 'replaceState',
				url: 'http://localhost/library',
				state: pageState.buildLibraryPageStateEnvelope(retained)
			}
		]);
		expect(timelineSession.getTimelineSessionPageState()).toEqual(retained);
	});

	it('preserves retained Classic history for an off-route settings request', async () => {
		allowTimeline = true;
		classicLoader.mockImplementation(loadFakeTarget);
		timelineLoader.mockImplementation(loadFakeTarget);
		storage.setItem(
			'roon-controller-library-view',
			JSON.stringify({ version: 1, preferred: 'timeline' })
		);
		const [pageState, browseHistory, navigation] = await Promise.all([
			import('$lib/libraryPageState'),
			import('$lib/stores/browseHistoryStore'),
			navigationStub()
		]);
		const retained = {
			context: { hierarchy: 'search' as const, query: 'Nina Simone' },
			history: [
				{
					hierarchy: 'search' as const,
					breadcrumb: { title: 'Albums', subtitle: '42 Results', searchCategory: true as const }
				}
			],
			forward: []
		};
		expect(browseHistory.replaceHistory(retained)).toBe(true);
		navigation.__resetNavigation(
			'http://localhost/library',
			pageState.buildLibraryViewRequestPageStateEnvelope('classic')
		);
		navigation.__setInitialNavigationType('goto');
		const Host = await importHost();

		const container = await mountHost(Host);
		const target = await findElement(container, '[data-testid="library-mode-target"]');

		expect(target).toHaveAttribute('data-activation-mode', 'classic');
		expect(storage.getItem('roon-controller-library-view')).toBe(
			JSON.stringify({ version: 1, preferred: 'classic' })
		);
		expect(navigation.__getNavigationLog()).toEqual([
			{
				operation: 'replaceState',
				url: 'http://localhost/library',
				state: pageState.buildLibraryPageStateEnvelope(
					pageState.buildClassicLibraryPageState(retained)
				)
			}
		]);
		expect(browseHistory.getClassicHistorySnapshot()).toEqual(retained);
	});

	it('falls back to Classic for an untagged full-route pop without rewriting history or preference', async () => {
		const navigation = await navigationStub();
		navigation.__resetNavigation('http://localhost/library');
		navigation.__setInitialNavigationType('popstate');
		const raw = JSON.stringify({ version: 1, preferred: 'timeline' });
		storage.setItem('roon-controller-library-view', raw);
		classicLoader.mockImplementation(loadFakeTarget);
		const Host = await importHost();

		const container = await mountHost(Host);
		await findElement(container, '[data-testid="library-mode-target"]');

		expect(timelineLoader).not.toHaveBeenCalled();
		expect(navigation.__getNavigationLog()).toEqual([]);
		expect(storage.getItem('roon-controller-library-view')).toBe(raw);
		expect(container.querySelector('[data-testid="library-mode-error"]')).toBeNull();
	});

	it('commits an explicit same-mode preference without adding an equivalent entry', async () => {
		const raw = JSON.stringify({ version: 1, preferred: 'timeline' });
		storage.setItem('roon-controller-library-view', raw);
		const navigation = await navigationStub();
		navigation.__resetNavigation('http://localhost/library');
		classicLoader.mockImplementation(loadFakeTarget);
		const Host = await importHost();
		const container = await mountHost(Host);
		await findElement(container, '[data-testid="library-mode-target"]');
		const lifecycle = await fakeLifecycleModule();
		lifecycle.resetFakeLibraryModeLifecycleEvents();
		const baseline = navigation.__getNavigationLog().length;
		const { requestLibraryView } = await import('$lib/stores/libraryViewHostStore');

		const activation = requestLibraryView('classic');
		expect(activation).not.toBeNull();
		await vi.waitFor(() =>
			expect(storage.getItem('roon-controller-library-view')).toBe(
				JSON.stringify({ version: 1, preferred: 'classic' })
			)
		);
		await expect(activation!).resolves.toBe('activated');

		expect(navigation.__getNavigationLog()).toHaveLength(baseline);
		expect(classicLoader).toHaveBeenCalledTimes(1);
		expect(lifecycle.getFakeLibraryModeLifecycleEvents()).toEqual([]);
	});

	it('reports a same-mode preference write failure without changing the active view', async () => {
		const raw = JSON.stringify({ version: 1, preferred: 'timeline' });
		storage.setItem('roon-controller-library-view', raw);
		const navigation = await navigationStub();
		navigation.__resetNavigation('http://localhost/library');
		classicLoader.mockImplementation(loadFakeTarget);
		const Host = await importHost();
		const container = await mountHost(Host);
		await findElement(container, '[data-testid="library-mode-target"]');
		const baseline = navigation.__getNavigationLog().length;
		vi.spyOn(storage, 'setItem').mockImplementation(() => {
			throw new Error('storage unavailable');
		});
		const [{ requestLibraryView, libraryViewHostStore }, { get }] = await Promise.all([
			import('$lib/stores/libraryViewHostStore'),
			import('svelte/store')
		]);

		const activation = requestLibraryView('classic');
		expect(activation).not.toBeNull();
		await findElement(container, '[data-testid="library-mode-warm-error"]');
		await expect(activation!).resolves.toBe('failed');

		expect(get(libraryViewHostStore).activeMode).toBe('classic');
		expect(container.querySelector('[data-testid="library-mode-target"]')).not.toBeNull();
		expect(storage.getItem('roon-controller-library-view')).toBe(raw);
		expect(navigation.__getNavigationLog()).toHaveLength(baseline);
		expect(classicLoader).toHaveBeenCalledTimes(1);
	});

	it('pushes exactly one tagged entry after a successful cross-mode user switch', async () => {
		allowTimeline = true;
		classicLoader.mockImplementation(loadFakeTarget);
		timelineLoader.mockImplementation(loadFakeTarget);
		const navigation = await navigationStub();
		navigation.__resetNavigation('http://localhost/library');
		const Host = await importHost();
		const container = await mountHost(Host);
		await findElement(container, '[data-testid="library-mode-target"]');
		const baseline = navigation.__getNavigationLog().length;
		const { requestLibraryView } = await import('$lib/stores/libraryViewHostStore');

		const activation = requestLibraryView('timeline');
		expect(activation).not.toBeNull();
		await vi.waitFor(() => expect(timelineLoader).toHaveBeenCalledTimes(1));
		await vi.waitFor(() =>
			expect(navigation.__getNavigationLog()).toHaveLength(baseline + 1)
		);
		await expect(activation!).resolves.toBe('activated');

		expect(navigation.__getNavigationLog().at(-1)).toMatchObject({
			operation: 'pushState',
			state: { library: { libraryView: 'timeline', schemaVersion: 1 } }
		});
		expect(storage.getItem('roon-controller-library-view')).toBe(
			JSON.stringify({ version: 1, preferred: 'timeline' })
		);
	});

	it('opens a typed Classic destination from a suspended Timeline in one safe-root history step', async () => {
		allowTimeline = true;
		storage.setItem(
			'roon-controller-library-view',
			JSON.stringify({ version: 1, preferred: 'timeline' })
		);
		const classic = deferred<unknown>();
		classicLoader.mockImplementation(() => classic.promise);
		timelineLoader.mockImplementation(loadFakeTarget);
		const navigation = await navigationStub();
		navigation.__resetNavigation('http://localhost/library');
		const Host = await importHost();
		const container = await mountHost(Host);
		await findElement(container, '[data-activation-mode="timeline"]');
		const lifecycle = await fakeLifecycleModule();
		lifecycle.resetFakeLibraryModeLifecycleEvents();
		const [hostStore, intentStore, svelteStore] = await Promise.all([
			import('$lib/stores/libraryViewHostStore'),
			import('$lib/stores/libraryIntentStore'),
			import('svelte/store')
		]);
		const baseline = navigation.__getNavigationLog().length;
		const publicationLifecycleEvents: string[][] = [];
		const publicationNavigationLengths: number[] = [];
		const transitionClearLifecycleEvents: string[][] = [];
		let transitionObserved = false;
		const unsubscribeHost = hostStore.libraryViewHostStore.subscribe((state) => {
			if (
				state.transition?.fromMode === 'timeline' &&
				state.transition.toMode === 'classic'
			) {
				transitionObserved = true;
			} else if (transitionObserved) {
				transitionClearLifecycleEvents.push(
					lifecycleEventTypes(lifecycle.getFakeLibraryModeLifecycleEvents())
				);
				transitionObserved = false;
			}
		});
		const unsubscribe = intentStore.pendingLibraryIntentStore.subscribe((pending) => {
			if (pending) {
				publicationLifecycleEvents.push(
					lifecycleEventTypes(lifecycle.getFakeLibraryModeLifecycleEvents())
				);
				publicationNavigationLengths.push(navigation.__getNavigationLog().length);
			}
		});

		const activation = hostStore.openLibraryIntentInClassic({
			kind: 'album',
			destination: 'search',
			query: 'Homogenic',
			localDescriptorId: 'album-local-id',
			display: { title: 'Homogenic', artist: 'Björk' }
		});
		expect(activation).not.toBeNull();
		await vi.waitFor(() => expect(classicLoader).toHaveBeenCalledTimes(1));
		expect(svelteStore.get(hostStore.libraryViewHostStore)).toEqual({
			activeMode: 'timeline',
			pendingMode: 'classic',
			transition: {
				fromMode: 'timeline',
				toMode: 'classic'
			}
		});
		expect(lifecycle.getFakeLibraryModeLifecycleEvents()).toEqual([]);

		classic.resolve(await loadFakeTarget());
		await expect(activation!).resolves.toBe('activated');
		await vi.waitFor(() => expect(
			svelteStore.get(hostStore.libraryViewHostStore)
		).toEqual({
			activeMode: 'classic',
			pendingMode: null,
			transition: null
		}));
		unsubscribe();
		unsubscribeHost();

		expect(transitionClearLifecycleEvents).toHaveLength(1);
		expect(transitionClearLifecycleEvents[0]).toContain('suspend:timeline');
		expect(publicationLifecycleEvents).toHaveLength(1);
		expect(publicationLifecycleEvents[0]).toContain('suspend:timeline');
		expect(publicationNavigationLengths).toEqual([baseline + 1]);
		expect(navigation.__getNavigationLog()).toHaveLength(baseline + 1);
		expect(navigation.__getNavigationLog().at(-1)).toMatchObject({
			operation: 'pushState',
			state: {
				library: {
					libraryView: 'classic',
					schemaVersion: 1,
					snapshot: {
						context: { hierarchy: 'browse' },
						history: [],
						forward: []
					}
				}
			}
		});
		expect(svelteStore.get(intentStore.pendingLibraryIntentStore)).toMatchObject({
			historyMutation: 'replace',
			intent: {
				kind: 'album',
				destination: 'search',
				query: 'Homogenic',
				localDescriptorId: 'album-local-id'
			}
		});
		expect(storage.getItem('roon-controller-library-view')).toBe(
			JSON.stringify({ version: 1, preferred: 'classic' })
		);
	});

	it('cancels the exact Classic destination when target activation fails', async () => {
		allowTimeline = true;
		storage.setItem(
			'roon-controller-library-view',
			JSON.stringify({ version: 1, preferred: 'timeline' })
		);
		timelineLoader.mockImplementation(loadFakeTarget);
		const classic = deferred<unknown>();
		classicLoader.mockImplementation(() => classic.promise);
		const navigation = await navigationStub();
		navigation.__resetNavigation('http://localhost/library');
		const Host = await importHost();
		const container = await mountHost(Host);
		await findElement(container, '[data-activation-mode="timeline"]');
		const [hostStore, intentStore, svelteStore] = await Promise.all([
			import('$lib/stores/libraryViewHostStore'),
			import('$lib/stores/libraryIntentStore'),
			import('svelte/store')
		]);
		const lifecycle = await fakeLifecycleModule();
		lifecycle.resetFakeLibraryModeLifecycleEvents();
		const baseline = navigation.__getNavigationLog().length;

		const activation = hostStore.openLibraryIntentInClassic({
			kind: 'general',
			destination: 'welcome-section',
			section: 'recently-played'
		});
		expect(activation).not.toBeNull();
		await vi.waitFor(() => expect(classicLoader).toHaveBeenCalledTimes(1));
		expect(svelteStore.get(hostStore.libraryViewHostStore)).toEqual({
			activeMode: 'timeline',
			pendingMode: 'classic',
			transition: {
				fromMode: 'timeline',
				toMode: 'classic'
			}
		});

		classic.reject(new Error('Classic chunk failed'));
		await findElement(container, '[data-testid="library-mode-warm-error"]');
		await expect(activation!).resolves.toBe('failed');

		expect(svelteStore.get(hostStore.libraryViewHostStore)).toEqual({
			activeMode: 'timeline',
			pendingMode: null,
			transition: null
		});
		expect(lifecycle.getFakeLibraryModeLifecycleEvents()).toEqual([]);
		expect(svelteStore.get(intentStore.pendingLibraryIntentStore)).toBeNull();
		expect(navigation.__getNavigationLog()).toHaveLength(baseline);
		expect(storage.getItem('roon-controller-library-view')).toBe(
			JSON.stringify({ version: 1, preferred: 'timeline' })
		);
	});

	it('reports a pending Open in Classic activation superseded by a newer view request', async () => {
		allowTimeline = true;
		storage.setItem(
			'roon-controller-library-view',
			JSON.stringify({ version: 1, preferred: 'timeline' })
		);
		const classic = deferred<unknown>();
		classicLoader.mockImplementation(() => classic.promise);
		timelineLoader.mockImplementation(loadFakeTarget);
		const navigation = await navigationStub();
		navigation.__resetNavigation('http://localhost/library');
		const Host = await importHost();
		const container = await mountHost(Host);
		await findElement(container, '[data-activation-mode="timeline"]');
		const [hostStore, svelteStore] = await Promise.all([
			import('$lib/stores/libraryViewHostStore'),
			import('svelte/store')
		]);
		const baseline = navigation.__getNavigationLog().length;

		const activation = hostStore.openLibraryIntentInClassic({
			kind: 'general',
			destination: 'explore-path',
			labelPath: ['Browse', 'Genres']
		});
		expect(activation).not.toBeNull();
		await vi.waitFor(() => expect(classicLoader).toHaveBeenCalledTimes(1));

		const supersedingActivation = hostStore.requestLibraryView('timeline');
		expect(supersedingActivation).not.toBeNull();
		await expect(supersedingActivation!).resolves.toBe('activated');
		classic.resolve(await loadFakeTarget());
		await expect(activation!).resolves.toBe('superseded');

		expect(svelteStore.get(hostStore.libraryViewHostStore)).toEqual({
			activeMode: 'timeline',
			pendingMode: null,
			transition: null
		});
		expect(navigation.__getNavigationLog()).toHaveLength(baseline);
		expect(storage.getItem('roon-controller-library-view')).toBe(
			JSON.stringify({ version: 1, preferred: 'timeline' })
		);
	});

	it('retains the active lifecycle while a warm load is pending or rejected', async () => {
		allowTimeline = true;
		classicLoader.mockImplementation(loadFakeTarget);
		const timeline = deferred<unknown>();
		timelineLoader.mockImplementation(() => timeline.promise);
		const navigation = await navigationStub();
		navigation.__resetNavigation('http://localhost/library');
		const Host = await importHost();
		const container = await mountHost(Host);
		await findElement(container, '[data-testid="library-mode-target"]');
		const lifecycle = await fakeLifecycleModule();
		lifecycle.resetFakeLibraryModeLifecycleEvents();
		const [{ requestLibraryView, libraryViewHostStore }, { get }] = await Promise.all([
			import('$lib/stores/libraryViewHostStore'),
			import('svelte/store')
		]);

		const activation = requestLibraryView('timeline');
		expect(activation).not.toBeNull();
		expect(get(libraryViewHostStore)).toEqual({
			activeMode: 'classic',
			pendingMode: 'timeline',
			transition: {
				fromMode: 'classic',
				toMode: 'timeline'
			}
		});
		await vi.waitFor(() => expect(timelineLoader).toHaveBeenCalledTimes(1));
		expect(container.querySelectorAll('[data-testid="library-mode-target"]')).toHaveLength(1);
		expect(lifecycle.getFakeLibraryModeLifecycleEvents()).toEqual([]);

		timeline.reject(new Error('Timeline chunk failed'));
		await findElement(container, '[data-testid="library-mode-warm-error"]');
		await expect(activation!).resolves.toBe('failed');
		expect(get(libraryViewHostStore)).toEqual({
			activeMode: 'classic',
			pendingMode: null,
			transition: null
		});
		expect(container.querySelectorAll('[data-testid="library-mode-target"]')).toHaveLength(1);
		expect(lifecycle.getFakeLibraryModeLifecycleEvents()).toEqual([]);
	});

	it('suspends once after a warm target loads, swaps one subtree, then resumes the target', async () => {
		allowTimeline = true;
		classicLoader.mockImplementation(loadFakeTarget);
		const timeline = deferred<unknown>();
		timelineLoader.mockImplementation(() => timeline.promise);
		const navigation = await navigationStub();
		navigation.__resetNavigation('http://localhost/library');
		const Host = await importHost();
		const container = await mountHost(Host);
		await findElement(container, '[data-testid="library-mode-target"]');
		const lifecycle = await fakeLifecycleModule();
		lifecycle.resetFakeLibraryModeLifecycleEvents();
		const { requestLibraryView } = await import('$lib/stores/libraryViewHostStore');

		const activation = requestLibraryView('timeline');
		expect(activation).not.toBeNull();
		await vi.waitFor(() => expect(timelineLoader).toHaveBeenCalledTimes(1));
		expect(lifecycle.getFakeLibraryModeLifecycleEvents()).toEqual([]);
		expect(container.querySelectorAll('[data-testid="library-mode-target"]')).toHaveLength(1);

		timeline.resolve(await loadFakeTarget());
		await vi.waitFor(() =>
			expect(
				container.querySelector('[data-testid="library-mode-target"]')
			).toHaveAttribute('data-activation-mode', 'timeline')
		);
		await expect(activation!).resolves.toBe('activated');
		expect(container.querySelectorAll('[data-testid="library-mode-target"]')).toHaveLength(1);
		expect(lifecycleEventTypes(lifecycle.getFakeLibraryModeLifecycleEvents())).toEqual([
			'suspend:classic',
			'unmount:classic',
			'mount:timeline',
			'resume:timeline'
		]);
	});

	it('hands Classic off to Unified with one suspend, one subtree, one resume', async () => {
		classicLoader.mockImplementation(loadFakeTarget);
		unifiedLoader.mockImplementation(loadFakeTarget);
		const navigation = await navigationStub();
		navigation.__resetNavigation('http://localhost/library');
		const Host = await importHost();
		const container = await mountHost(Host);
		await findElement(container, '[data-testid="library-mode-target"]');
		const lifecycle = await fakeLifecycleModule();
		lifecycle.resetFakeLibraryModeLifecycleEvents();
		const { requestLibraryView } = await import('$lib/stores/libraryViewHostStore');

		// The dev preview resolves Unified without touching gated Timeline.
		const activation = requestLibraryView('unified');
		expect(activation).not.toBeNull();
		await vi.waitFor(() =>
			expect(
				container.querySelector('[data-testid="library-mode-target"]')
			).toHaveAttribute('data-activation-mode', 'unified')
		);
		await expect(activation!).resolves.toBe('activated');
		expect(container.querySelectorAll('[data-testid="library-mode-target"]')).toHaveLength(1);
		expect(lifecycleEventTypes(lifecycle.getFakeLibraryModeLifecycleEvents())).toEqual([
			'suspend:classic',
			'unmount:classic',
			'mount:unified',
			'resume:unified'
		]);
	});

	it('hands Timeline off to Unified with one suspend, one subtree, one resume', async () => {
		allowTimeline = true;
		classicLoader.mockImplementation(loadFakeTarget);
		timelineLoader.mockImplementation(loadFakeTarget);
		unifiedLoader.mockImplementation(loadFakeTarget);
		const navigation = await navigationStub();
		navigation.__resetNavigation('http://localhost/library');
		const Host = await importHost();
		const container = await mountHost(Host);
		await findElement(container, '[data-testid="library-mode-target"]');
		const { requestLibraryView } = await import('$lib/stores/libraryViewHostStore');

		const toTimeline = requestLibraryView('timeline');
		expect(toTimeline).not.toBeNull();
		await expect(toTimeline!).resolves.toBe('activated');
		await vi.waitFor(() =>
			expect(
				container.querySelector('[data-testid="library-mode-target"]')
			).toHaveAttribute('data-activation-mode', 'timeline')
		);
		const lifecycle = await fakeLifecycleModule();
		lifecycle.resetFakeLibraryModeLifecycleEvents();

		const toUnified = requestLibraryView('unified');
		expect(toUnified).not.toBeNull();
		await expect(toUnified!).resolves.toBe('activated');
		await vi.waitFor(() =>
			expect(
				container.querySelector('[data-testid="library-mode-target"]')
			).toHaveAttribute('data-activation-mode', 'unified')
		);
		expect(container.querySelectorAll('[data-testid="library-mode-target"]')).toHaveLength(1);
		expect(lifecycleEventTypes(lifecycle.getFakeLibraryModeLifecycleEvents())).toEqual([
			'suspend:timeline',
			'unmount:timeline',
			'mount:unified',
			'resume:unified'
		]);
	});

	it('settles 20 Classic/Timeline round trips with one subtree and one lifecycle per instance', async () => {
		allowTimeline = true;
		classicLoader.mockImplementation(loadFakeTarget);
		timelineLoader.mockImplementation(loadFakeTarget);
		const navigation = await navigationStub();
		navigation.__resetNavigation('http://localhost/library');
		const Host = await importHost();
		const container = await mountHost(Host);
		await findElement(container, '[data-testid="library-mode-target"]');
		const lifecycle = await fakeLifecycleModule();
		lifecycle.resetFakeLibraryModeLifecycleEvents();
		const [
			{ get },
			{ requestLibraryView, libraryViewHostStore },
			nowPlaying,
			queue,
			selectedZone,
			zones,
			theme,
			connection,
			core,
			health,
			feedback
		] = await Promise.all([
			import('svelte/store'),
			import('$lib/stores/libraryViewHostStore'),
			import('$lib/stores/nowPlayingStore'),
			import('$lib/stores/queueStore'),
			import('$lib/stores/selectedZoneStore'),
			import('$lib/stores/zonesStore'),
			import('$lib/stores/themeStore'),
			import('$lib/stores/socketStatusStore'),
			import('$lib/stores/coreStore'),
			import('$lib/stores/healthStore'),
			import('$lib/stores/commandFeedbackStore')
		]);
		const continuityZone = {
			zone_id: 'continuity-zone',
			display_name: 'Continuity Zone',
			state: 'playing' as const,
			is_play_allowed: true,
			is_pause_allowed: true,
			is_previous_allowed: true,
			is_next_allowed: true,
			is_seek_allowed: true,
			outputs: []
		};
		const continuityPlayback = {
			zone_id: continuityZone.zone_id,
			state: 'playing' as const,
			title: 'Continuity Track',
			artist: 'Continuity Artist',
			album: 'Continuity Album',
			duration: 240,
			seek_position: 80
		};
		const continuityQueue = {
			zone_id: continuityZone.zone_id,
			items: [{ queue_item_id: 26, length: 240 }],
			max_item_count: 100,
			updated_at: '2026-07-16T00:00:00.000Z'
		};
		const originalTheme = get(theme.themeStore);
		const continuityTheme = originalTheme === 'dark' ? 'light' : 'dark';
		const continuityCore = {
			status: 'paired' as const,
			core: {
				id: 'continuity-core',
				displayName: 'Continuity Core',
				displayVersion: '1'
			}
		};
		const continuityHealth = {
			status: 'degraded' as const,
			ready: false,
			timestamp: '2026-07-16T00:00:00.000Z',
			subsystems: {
				favorites: { ready: false, degraded: true, entry_count: 26 }
			}
		};
		zones.setZonesSnapshot([continuityZone]);
		selectedZone.setSelectedZone(continuityZone.zone_id);
		nowPlaying.setNowPlaying(continuityZone.zone_id, continuityPlayback);
		queue.setQueueSnapshot(continuityQueue);
		theme.setTheme(continuityTheme);
		connection.setSocketStatus('disconnected');
		core.setCoreStatus(continuityCore);
		health.setHealth(continuityHealth);
		feedback.pushCommandFeedback({
			source: 'queue',
			command: 'continuity-check',
			message: 'Shared feedback survives mode switches',
			kind: 'success'
		});
		const continuityFeedback = get(feedback.commandFeedbackStore);
		expect(continuityFeedback).toMatchObject({
			source: 'queue',
			command: 'continuity-check',
			message: 'Shared feedback survives mode switches',
			kind: 'success'
		});
		const incomingInstanceIds = new Set<number>();
		let activeInstanceId: number | null = null;

		try {
			for (let cycle = 0; cycle < 20; cycle += 1) {
				for (const targetMode of ['timeline', 'classic'] as const) {
					const outgoingMode = targetMode === 'timeline' ? 'classic' : 'timeline';
					const before = lifecycle.getFakeLibraryModeLifecycleEvents().length;
					const activation = requestLibraryView(targetMode);
					expect(activation).not.toBeNull();
					await expect(activation!).resolves.toBe('activated');
					await vi.waitFor(() =>
						expect(
							container.querySelector('[data-testid="library-mode-target"]')
						).toHaveAttribute('data-activation-mode', targetMode)
					);

					const delta = lifecycle.getFakeLibraryModeLifecycleEvents().slice(before);
					expect(lifecycleEventTypes(delta)).toEqual([
						`suspend:${outgoingMode}`,
						`unmount:${outgoingMode}`,
						`mount:${targetMode}`,
						`resume:${targetMode}`
					]);
					expect(delta[0].instanceId).toBe(delta[1].instanceId);
					expect(delta[2].instanceId).toBe(delta[3].instanceId);
					if (activeInstanceId !== null) expect(delta[0].instanceId).toBe(activeInstanceId);
					expect(incomingInstanceIds.has(delta[2].instanceId)).toBe(false);
					incomingInstanceIds.add(delta[2].instanceId);
					activeInstanceId = delta[2].instanceId;

					expect(get(libraryViewHostStore)).toEqual({
						activeMode: targetMode,
						pendingMode: null,
						transition: null
					});
					expect(get(nowPlaying.nowPlayingStore)).toEqual({
						[continuityZone.zone_id]: continuityPlayback
					});
					expect(get(queue.queueStore)).toEqual({
						[continuityZone.zone_id]: continuityQueue
					});
					expect(get(selectedZone.selectedZoneStore)).toBe(continuityZone.zone_id);
					expect(get(zones.zonesStore)).toEqual([continuityZone]);
					expect(get(theme.themeStore)).toBe(continuityTheme);
					expect(get(connection.socketStatusStore)).toBe('disconnected');
					expect(get(core.coreStore)).toEqual(continuityCore);
					expect(get(health.healthStore)).toEqual(continuityHealth);
					expect(get(feedback.commandFeedbackStore)).toEqual(continuityFeedback);
					expect(container.querySelectorAll('[data-testid="library-mode-target"]')).toHaveLength(1);
					expect(container.querySelector('[data-testid="library-mode-loading"]')).toBeNull();
					expect(container.querySelector('[data-testid="library-mode-error"]')).toBeNull();
					expect(container.querySelector('[data-testid="library-mode-warm-error"]')).toBeNull();
				}
			}

			expect(incomingInstanceIds.size).toBe(40);
			expect(navigation.__getNavigationLog()).toHaveLength(41);
		} finally {
			nowPlaying.resetNowPlaying();
			queue.resetQueue();
			selectedZone.setSelectedZone('');
			zones.setZonesSnapshot([]);
			theme.setTheme(originalTheme);
			connection.setSocketStatus('connecting');
			core.setCoreStatus({ status: 'discovering' });
			health.setHealth(null);
			feedback.clearCommandFeedback();
		}
	});

	it('resumes the retained outgoing lifecycle when a cross-mode commit fails', async () => {
		allowTimeline = true;
		classicLoader.mockImplementation(loadFakeTarget);
		timelineLoader.mockImplementation(loadFakeTarget);
		const navigation = await navigationStub();
		navigation.__resetNavigation('http://localhost/library');
		const Host = await importHost();
		const container = await mountHost(Host);
		await findElement(container, '[data-testid="library-mode-target"]');
		const lifecycle = await fakeLifecycleModule();
		lifecycle.resetFakeLibraryModeLifecycleEvents();
		vi.spyOn(storage, 'setItem').mockImplementation(() => {
			throw new Error('storage unavailable');
		});
		const [{ requestLibraryView, libraryViewHostStore }, { get }] = await Promise.all([
			import('$lib/stores/libraryViewHostStore'),
			import('svelte/store')
		]);

		const activation = requestLibraryView('timeline');
		expect(activation).not.toBeNull();
		await findElement(container, '[data-testid="library-mode-warm-error"]');
		await expect(activation!).resolves.toBe('failed');

		expect(get(libraryViewHostStore).activeMode).toBe('classic');
		expect(container.querySelectorAll('[data-testid="library-mode-target"]')).toHaveLength(1);
		expect(lifecycleEventTypes(lifecycle.getFakeLibraryModeLifecycleEvents())).toEqual([
			'suspend:classic',
			'resume:classic'
		]);
	});

	it('preserves corrupt Timeline session bytes until a valid self-authored Timeline navigation', async () => {
		allowTimeline = true;
		classicLoader.mockImplementation(loadFakeTarget);
		timelineLoader.mockImplementation(loadFakeTarget);
		storage.setItem(
			'roon-controller-library-view',
			JSON.stringify({ version: 1, preferred: 'timeline' })
		);
		const { TIMELINE_PAGE_SESSION_STORAGE_KEY } = await import('$lib/timelinePageSessionState');
		const corrupt = '{"libraryView":"timeline","itemKey":"must-not-move"}';
		window.sessionStorage.setItem(TIMELINE_PAGE_SESSION_STORAGE_KEY, corrupt);
		const navigation = await navigationStub();
		navigation.__resetNavigation('http://localhost/library');
		const Host = await importHost();
		const container = await mountHost(Host);
		const target = await findElement(container, '[data-testid="library-mode-target"]');

		expect(target).toHaveAttribute('data-activation-mode', 'timeline');
		expect(window.sessionStorage.getItem(TIMELINE_PAGE_SESSION_STORAGE_KEY)).toBe(corrupt);
		expect(navigation.__getNavigationLog().at(-1)?.operation).toBe('replaceState');

		const [{ pushLibraryPageState }, { buildTimelineLibraryPageState }] = await Promise.all([
			import('$lib/libraryPageNavigation'),
			import('$lib/libraryPageState')
		]);
		const authored = buildTimelineLibraryPageState({
			artistQuery: 'Björk',
			selectedArtistLocalId: 'artist-local-1',
			activeSemanticPath: [{ kind: 'artist', localId: 'artist-local-1' }],
			selectedNode: { kind: 'artist', localId: 'artist-local-1' },
			camera: { x: 0, y: 0, scale: 1 },
			displayDepth: 0
		});
		expect(pushLibraryPageState(authored)).toBe(true);
		expect(window.sessionStorage.getItem(TIMELINE_PAGE_SESSION_STORAGE_KEY)).toBe(
			JSON.stringify(authored)
		);
	});

	it('keeps the outgoing view visible on a warm failure and retries without an early push', async () => {
		allowTimeline = true;
		classicLoader.mockImplementation(loadFakeTarget);
		timelineLoader
			.mockRejectedValueOnce(new Error('Timeline chunk failed'))
			.mockImplementationOnce(loadFakeTarget);
		const navigation = await navigationStub();
		navigation.__resetNavigation('http://localhost/library');
		const Host = await importHost();
		const container = await mountHost(Host);
		await findElement(container, '[data-testid="library-mode-target"]');
		const baseline = navigation.__getNavigationLog().length;
		const { requestLibraryView } = await import('$lib/stores/libraryViewHostStore');

		const activation = requestLibraryView('timeline');
		expect(activation).not.toBeNull();
		const alert = await findElement(container, '[data-testid="library-mode-warm-error"]');
		await expect(activation!).resolves.toBe('failed');
		expect(container.querySelector('[data-testid="library-mode-target"]')).not.toBeNull();
		expect(navigation.__getNavigationLog()).toHaveLength(baseline);
		expect(storage.getItem('roon-controller-library-view')).toBe(
			JSON.stringify({ version: 1, preferred: 'classic' })
		);

		(alert.querySelector('button') as HTMLButtonElement).click();
		await vi.waitFor(() => expect(timelineLoader).toHaveBeenCalledTimes(2));
		await vi.waitFor(() =>
			expect(navigation.__getNavigationLog()).toHaveLength(baseline + 1)
		);
		expect(container.querySelector('[data-testid="library-mode-warm-error"]')).toBeNull();
	});

	it('applies reactive shallow traversal without authoring another history entry', async () => {
		const navigation = await navigationStub();
		navigation.__resetNavigation('http://localhost/library');
		classicLoader.mockImplementation(loadFakeTarget);
		const Host = await importHost();
		const container = await mountHost(Host);
		await findElement(container, '[data-testid="library-mode-target"]');
		const { buildClassicRootPageState, buildLibraryPageStateEnvelope } =
			await import('$lib/libraryPageState');
		const searchEntry = buildLibraryPageStateEnvelope(
			buildClassicRootPageState({ hierarchy: 'search', query: 'Bowie' })
		);

		navigation.pushState('', searchEntry);
		const afterExternalWrite = navigation.__getNavigationLog().length;
		await vi.waitFor(async () => {
			const { getClassicHistorySnapshot } = await import('$lib/stores/browseHistoryStore');
			expect(getClassicHistorySnapshot().context).toEqual({
				hierarchy: 'search',
				query: 'Bowie'
			});
		});

		expect(navigation.__getNavigationLog()).toHaveLength(afterExternalWrite);
		expect(classicLoader).toHaveBeenCalledTimes(1);
		expect(container.querySelector('[data-testid="library-mode-target"]')).toHaveAttribute(
			'data-classic-truncation-policy',
			'preserve'
		);
		expect(container.querySelector('[data-testid="library-mode-target"]')).toHaveAttribute(
			'data-activation-cause',
			'history-pop'
		);
		expect(container.querySelector('[data-testid="library-mode-target"]')).toHaveAttribute(
			'data-activation-mode',
			'classic'
		);
	});

	it('preserves a gated Timeline preference on an untagged shallow pop', async () => {
		const raw = JSON.stringify({ version: 1, preferred: 'timeline' });
		storage.setItem('roon-controller-library-view', raw);
		const navigation = await navigationStub();
		navigation.__resetNavigation('http://localhost/library');
		classicLoader.mockImplementation(loadFakeTarget);
		const Host = await importHost();
		const container = await mountHost(Host);
		await findElement(container, '[data-testid="library-mode-target"]');
		const baseline = navigation.__getNavigationLog().length;

		navigation.pushState('', {});
		await vi.waitFor(() =>
			expect(container.querySelector('[data-testid="library-mode-target"]')).toHaveAttribute(
				'data-classic-truncation-policy',
				'preserve'
			)
		);

		expect(storage.getItem('roon-controller-library-view')).toBe(raw);
		expect(timelineLoader).not.toHaveBeenCalled();
		expect(navigation.__getNavigationLog()).toHaveLength(baseline + 1);
		expect(navigation.__getNavigationLog().at(-1)).toMatchObject({
			operation: 'pushState',
			state: {}
		});
	});

	it('restores mode and preference across real shallow Back and Forward traversal', async () => {
		allowTimeline = true;
		classicLoader.mockImplementation(loadFakeTarget);
		timelineLoader.mockImplementation(loadFakeTarget);
		const navigation = await navigationStub();
		navigation.__resetNavigation('http://localhost/library');
		const Host = await importHost();
		const container = await mountHost(Host);
		await findElement(container, '[data-testid="library-mode-target"]');
		const [{ requestLibraryView, libraryViewHostStore }, { get }] = await Promise.all([
			import('$lib/stores/libraryViewHostStore'),
			import('svelte/store')
		]);

		const activation = requestLibraryView('timeline');
		expect(activation).not.toBeNull();
		await vi.waitFor(() => expect(get(libraryViewHostStore).activeMode).toBe('timeline'));
		await expect(activation!).resolves.toBe('activated');
		expect(navigation.__back()).toBe(true);
		await vi.waitFor(() => expect(get(libraryViewHostStore).activeMode).toBe('classic'));
		expect(storage.getItem('roon-controller-library-view')).toBe(
			JSON.stringify({ version: 1, preferred: 'classic' })
		);

		expect(navigation.__forward()).toBe(true);
		await vi.waitFor(() => expect(get(libraryViewHostStore).activeMode).toBe('timeline'));
		expect(storage.getItem('roon-controller-library-view')).toBe(
			JSON.stringify({ version: 1, preferred: 'timeline' })
		);
		expect(navigation.__getNavigationLog().map((entry) => entry.operation)).toEqual([
			'replaceState',
			'pushState',
			'popstate',
			'popstate'
		]);
	});

	it('lets the latest of two rapid shallow pops win a pending cross-mode load', async () => {
		allowTimeline = true;
		const timeline = deferred<unknown>();
		classicLoader.mockImplementation(loadFakeTarget);
		timelineLoader.mockImplementation(() => timeline.promise);
		const [{ buildClassicRootPageState, buildLibraryPageStateEnvelope, buildTimelineRootPageState }, navigation] =
			await Promise.all([import('$lib/libraryPageState'), navigationStub()]);
		navigation.__resetNavigation(
			'http://localhost/library',
			buildLibraryPageStateEnvelope(buildClassicRootPageState())
		);
		navigation.pushState(
			'',
			buildLibraryPageStateEnvelope(buildTimelineRootPageState())
		);
		navigation.pushState(
			'',
			buildLibraryPageStateEnvelope(
				buildClassicRootPageState({ hierarchy: 'search', query: 'Newest' })
			)
		);
		const baseline = navigation.__getNavigationLog().length;
		const Host = await importHost();
		const container = await mountHost(Host);
		await findElement(container, '[data-testid="library-mode-target"]');
		const [{ libraryViewHostStore }, { get }, { getClassicHistorySnapshot }] =
			await Promise.all([
				import('$lib/stores/libraryViewHostStore'),
				import('svelte/store'),
				import('$lib/stores/browseHistoryStore')
			]);

		expect(navigation.__back()).toBe(true);
		await vi.waitFor(() => expect(timelineLoader).toHaveBeenCalledTimes(1));
		expect(get(libraryViewHostStore)).toMatchObject({
			activeMode: 'classic',
			pendingMode: 'timeline'
		});
		expect(navigation.__back()).toBe(true);
		await vi.waitFor(() =>
			expect(getClassicHistorySnapshot().context).toEqual({ hierarchy: 'browse' })
		);
		expect(get(libraryViewHostStore).pendingMode).toBeNull();
		timeline.resolve(await loadFakeTarget());
		await timeline.promise;
		await Promise.resolve();

		expect(get(libraryViewHostStore).activeMode).toBe('classic');
		expect(get(libraryViewHostStore).pendingMode).toBeNull();
		expect(getClassicHistorySnapshot().context).toEqual({ hierarchy: 'browse' });
		expect(navigation.__getNavigationLog()).toHaveLength(baseline + 2);
		expect(navigation.__getNavigationLog().slice(-2).map((entry) => entry.operation)).toEqual([
			'popstate',
			'popstate'
		]);
	});

	it('suspends the outgoing lifecycle before a failed history-pop clears the active mode', async () => {
		allowTimeline = true;
		const timeline = deferred<unknown>();
		const [pageState, navigation] = await Promise.all([
			import('$lib/libraryPageState'),
			navigationStub()
		]);
		navigation.__resetNavigation(
			'http://localhost/library',
			pageState.buildLibraryPageStateEnvelope(pageState.buildTimelineRootPageState())
		);
		navigation.pushState(
			'',
			pageState.buildLibraryPageStateEnvelope(pageState.buildClassicRootPageState())
		);
		classicLoader.mockImplementation(loadFakeTarget);
		timelineLoader.mockImplementation(() => timeline.promise);
		const Host = await importHost();
		const container = await mountHost(Host);
		await findElement(container, '[data-testid="library-mode-target"]');
		const lifecycle = await fakeLifecycleModule();
		lifecycle.resetFakeLibraryModeLifecycleEvents();
		const [{ libraryViewHostStore }, { get }] = await Promise.all([
			import('$lib/stores/libraryViewHostStore'),
			import('svelte/store')
		]);
		const activeModesObservedDuringSuspend: Array<string | null> = [];
		lifecycle.observeFakeLibraryModeLifecycle((event) => {
			if (event.type === 'suspend') {
				activeModesObservedDuringSuspend.push(get(libraryViewHostStore).activeMode);
			}
		});

		expect(navigation.__back()).toBe(true);
		await vi.waitFor(() => expect(timelineLoader).toHaveBeenCalledTimes(1));
		expect(get(libraryViewHostStore)).toMatchObject({
			activeMode: 'classic',
			pendingMode: 'timeline'
		});
		timeline.reject(new Error('Timeline chunk failed'));
		await findElement(container, '[data-testid="library-mode-error"]');

		expect(activeModesObservedDuringSuspend).toEqual(['classic']);
		expect(get(libraryViewHostStore).activeMode).toBeNull();
		expect(get(libraryViewHostStore).pendingMode).toBeNull();
		expect(container.querySelector('[data-testid="library-mode-target"]')).toBeNull();
		expect(lifecycleEventTypes(lifecycle.getFakeLibraryModeLifecycleEvents())).toEqual([
			'suspend:classic',
			'unmount:classic'
		]);
	});

	it('preserves Forward across Back, failed Timeline load, successful Retry, and Forward', async () => {
		allowTimeline = true;
		const [pageState, navigation] = await Promise.all([
			import('$lib/libraryPageState'),
			navigationStub()
		]);
		navigation.__resetNavigation(
			'http://localhost/library',
			pageState.buildLibraryPageStateEnvelope(pageState.buildTimelineRootPageState())
		);
		navigation.pushState(
			'',
			pageState.buildLibraryPageStateEnvelope(pageState.buildClassicRootPageState())
		);
		classicLoader.mockImplementation(loadFakeTarget);
		timelineLoader
			.mockRejectedValueOnce(new Error('Timeline chunk failed'))
			.mockImplementationOnce(loadFakeTarget);
		const Host = await importHost();
		const container = await mountHost(Host);
		await findElement(container, '[data-testid="library-mode-target"]');
		const baseline = navigation.__getNavigationLog().length;
		const [{ libraryViewHostStore }, { get }] = await Promise.all([
			import('$lib/stores/libraryViewHostStore'),
			import('svelte/store')
		]);

		expect(navigation.__back()).toBe(true);
		const alert = await findElement(container, '[data-testid="library-mode-error"]');
		expect(alert.textContent).toContain('Library couldn’t load.');
		await vi.waitFor(() => expect(document.activeElement).toBe(alert));
		expect(navigation.__getHistorySnapshot().index).toBe(0);
		expect(navigation.__getNavigationLog()).toHaveLength(baseline + 1);
		expect(storage.getItem('roon-controller-library-view')).toBe(
			JSON.stringify({ version: 1, preferred: 'classic' })
		);
		expect(get(libraryViewHostStore).activeMode).toBeNull();

		const retry = [...alert.querySelectorAll('button')].find(
			(button) => button.textContent === 'Retry'
		);
		retry!.click();
		await vi.waitFor(() => expect(get(libraryViewHostStore).activeMode).toBe('timeline'));
		expect(navigation.__getHistorySnapshot().index).toBe(0);
		expect(navigation.__getNavigationLog()).toHaveLength(baseline + 1);
		expect(container.querySelector('[data-testid="library-mode-error"]')).toBeNull();
		expect(storage.getItem('roon-controller-library-view')).toBe(
			JSON.stringify({ version: 1, preferred: 'timeline' })
		);

		expect(navigation.__forward()).toBe(true);
		await vi.waitFor(() => expect(get(libraryViewHostStore).activeMode).toBe('classic'));
		expect(navigation.__getHistorySnapshot().index).toBe(1);
		expect(navigation.__getNavigationLog()).toHaveLength(baseline + 2);
		expect(navigation.__getNavigationLog().slice(-2).map((entry) => entry.operation)).toEqual([
			'popstate',
			'popstate'
		]);
		expect(classicLoader).toHaveBeenCalledTimes(2);
		expect(timelineLoader).toHaveBeenCalledTimes(2);
		expect(storage.getItem('roon-controller-library-view')).toBe(
			JSON.stringify({ version: 1, preferred: 'classic' })
		);
	});

	it('branches at Classic recovery, drops Forward, and leaves Back on the failed Timeline entry', async () => {
		const [pageState, navigation] = await Promise.all([
			import('$lib/libraryPageState'),
			navigationStub()
		]);
		navigation.__resetNavigation(
			'http://localhost/library',
			pageState.buildLibraryPageStateEnvelope(pageState.buildTimelineRootPageState())
		);
		navigation.pushState(
			'',
			pageState.buildLibraryPageStateEnvelope(pageState.buildClassicRootPageState())
		);
		classicLoader.mockImplementation(loadFakeTarget);
		const Host = await importHost();
		const container = await mountHost(Host);
		await findElement(container, '[data-testid="library-mode-target"]');
		const baseline = navigation.__getNavigationLog().length;

		expect(navigation.__back()).toBe(true);
		const alert = await findElement(container, '[data-testid="library-mode-error"]');
		const recover = [...alert.querySelectorAll('button')].find(
			(button) => button.textContent === 'Open Classic'
		);
		recover!.click();
		await findElement(container, '[data-testid="library-mode-target"]');

		expect(navigation.__getHistorySnapshot()).toMatchObject({ index: 1, entries: [{}, {}] });
		expect(navigation.__getNavigationLog()).toHaveLength(baseline + 2);
		expect(navigation.__getNavigationLog().slice(-2).map((entry) => entry.operation)).toEqual([
			'popstate',
			'pushState'
		]);
		expect(navigation.__forward()).toBe(false);
		expect(storage.getItem('roon-controller-library-view')).toBe(
			JSON.stringify({ version: 1, preferred: 'classic' })
		);

		expect(navigation.__back()).toBe(true);
		await findElement(container, '[data-testid="library-mode-error"]');
		expect(navigation.__getHistorySnapshot().index).toBe(0);
		expect(navigation.__getNavigationLog().at(-1)?.operation).toBe('popstate');
		expect(storage.getItem('roon-controller-library-view')).toBe(
			JSON.stringify({ version: 1, preferred: 'classic' })
		);
		expect(timelineLoader).not.toHaveBeenCalled();
	});

	it.each([
		['missing preference', null],
		['malformed preference', '{not-json'],
		['unknown-version preference', JSON.stringify({ version: 2, preferred: 'timeline' })]
	])('activates Unified for a %s', async (_label, raw) => {
		if (raw === null) {
			storage.removeItem('roon-controller-library-view');
		} else {
			storage.setItem('roon-controller-library-view', raw);
		}
		unifiedLoader.mockImplementation(loadFakeTarget);
		const Host = await importHost();

		const container = await mountHost(Host);
		await findElement(container, '[data-testid="library-mode-target"]');
		expect(unifiedLoader).toHaveBeenCalledTimes(1);
		expect(classicLoader).not.toHaveBeenCalled();
	});

	it('activates Unified when preference storage is unreadable', async () => {
		Object.defineProperty(window, 'localStorage', {
			configurable: true,
			get: () => {
				throw new Error('blocked');
			}
		});
		unifiedLoader.mockImplementation(loadFakeTarget);
		const Host = await importHost();

		const container = await mountHost(Host);
		await findElement(container, '[data-testid="library-mode-target"]');
		expect(unifiedLoader).toHaveBeenCalledTimes(1);
		expect(classicLoader).not.toHaveBeenCalled();
	});

	it('keeps a gated stored Timeline preference unchanged while mounting Classic', async () => {
		const raw = JSON.stringify({ version: 1, preferred: 'timeline' });
		storage.setItem('roon-controller-library-view', raw);
		const write = vi.spyOn(storage, 'setItem');
		classicLoader.mockImplementation(loadFakeTarget);
		const Host = await importHost();

		const container = await mountHost(Host);
		await findElement(container, '[data-testid="library-mode-target"]');
		const [{ libraryViewStore }, { get }, { libraryViewHostStore }] = await Promise.all([
			import('$lib/stores/libraryViewStore'),
			import('svelte/store'),
			import('$lib/stores/libraryViewHostStore')
		]);

		expect(get(libraryViewStore)).toBe('timeline');
		expect(get(libraryViewHostStore)).toEqual({
			activeMode: 'classic',
			pendingMode: null,
			transition: null
		});
		expect(classicLoader).toHaveBeenCalledTimes(1);
		expect(write).not.toHaveBeenCalled();
		expect(storage.getItem('roon-controller-library-view')).toBe(raw);
	});

	it('shows a cold error and retries the same lazy target successfully', async () => {
		const firstLoad = deferred<unknown>();
		classicLoader
			.mockImplementationOnce(() => firstLoad.promise)
			.mockImplementationOnce(loadFakeTarget);
		const Host = await importHost();

		const container = await mountHost(Host);
		const [{ get }, { libraryViewHostStore }] = await Promise.all([
			import('svelte/store'),
			import('$lib/stores/libraryViewHostStore')
		]);
		await vi.waitFor(() => expect(classicLoader).toHaveBeenCalledTimes(1));
		expect(get(libraryViewHostStore)).toEqual({
			activeMode: null,
			pendingMode: 'classic',
			transition: null
		});

		firstLoad.reject(undefined);
		const alert = await findElement(container, '[role="alert"]');
		expect(alert.textContent).toContain('Library couldn’t load.');
		expect(get(libraryViewHostStore)).toEqual({
			activeMode: null,
			pendingMode: null,
			transition: null
		});
		expect(container.querySelector('[data-testid="library-mode-target"]')).toBeNull();

		const retry = container.querySelector('button');
		expect(retry?.textContent).toBe('Retry');
		retry!.click();
		await findElement(container, '[data-testid="library-mode-target"]');
		expect(classicLoader).toHaveBeenCalledTimes(2);
		expect(container.querySelector('[role="alert"]')).toBeNull();
		expect(container.querySelectorAll('[data-testid="library-mode-target"]')).toHaveLength(1);
	});

	it('recovers an already-popped Classic safe root without pushing an equivalent entry', async () => {
		const [{ buildClassicRootPageState, buildLibraryPageStateEnvelope }, navigation] =
			await Promise.all([import('$lib/libraryPageState'), navigationStub()]);
		navigation.__resetNavigation(
			'http://localhost/library',
			buildLibraryPageStateEnvelope(buildClassicRootPageState())
		);
		classicLoader
			.mockRejectedValueOnce(new Error('Classic chunk failed'))
			.mockImplementationOnce(loadFakeTarget);
		const Host = await importHost();
		const container = await mountHost(Host);
		const alert = await findElement(container, '[data-testid="library-mode-error"]');
		const recover = [...alert.querySelectorAll('button')].find(
			(button) => button.textContent === 'Open Classic'
		);

		recover!.click();
		await findElement(container, '[data-testid="library-mode-target"]');

		expect(navigation.__getNavigationLog()).toEqual([]);
		expect(classicLoader).toHaveBeenCalledTimes(2);
	});

	it('releases its committed-mode claim before a late cold load resolves', async () => {
		const navigation = await navigationStub();
		navigation.__resetNavigation('http://localhost/library');
		const preferenceWrite = vi.spyOn(storage, 'setItem');
		const pendingClassic = deferred<unknown>();
		classicLoader.mockImplementation(() => pendingClassic.promise);
		const Host = await importHost();
		await mountHost(Host);
		await vi.waitFor(() => expect(classicLoader).toHaveBeenCalledTimes(1));
		const [{ get }, { libraryViewHostStore }] = await Promise.all([
			import('svelte/store'),
			import('$lib/stores/libraryViewHostStore')
		]);
		expect(get(libraryViewHostStore)).toEqual({
			activeMode: null,
			pendingMode: 'classic',
			transition: null
		});

		const cleanup = mountedCleanups.pop();
		expect(cleanup).toBeDefined();
		await cleanup!();
		const target = await loadFakeTarget();
		pendingClassic.resolve(target);
		await pendingClassic.promise;
		await Promise.resolve();

		expect(get(libraryViewHostStore)).toEqual({
			activeMode: null,
			pendingMode: null,
			transition: null
		});
		expect(navigation.__getNavigationLog()).toEqual([]);
		expect(preferenceWrite).not.toHaveBeenCalled();
		expect(window.sessionStorage.length).toBe(0);
	});
});
