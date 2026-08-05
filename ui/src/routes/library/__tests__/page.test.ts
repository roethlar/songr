import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { get } from 'svelte/store';
import type { BrowseResult, BrowseItem } from '@shared/types';
import type {
	ClassicBrowseOperation,
	ClassicBrowseRole
} from '@shared/classicBrowseContracts';

// ---------------- Mocks ----------------
//
// The Library page is a wide integration: it pulls in the API client,
// the socket client, several stores, and the Search component. We mock
// the network surfaces (REST + socket) so tests stay deterministic and
// fast, and let the real stores run.

const apiBrowse = vi.fn<(_fetch: unknown, opts: any) => Promise<BrowseResult>>();
const apiBrowseSearch = vi.fn<(_fetch: unknown, opts: any) => Promise<import('@shared/types').SearchResult[]>>();
const apiBrowseLoad = vi.fn<(_fetch: unknown, opts: any) => Promise<BrowseResult>>();
const apiBrowsePop = vi.fn<(_fetch: unknown, opts: any) => Promise<BrowseResult>>();
const apiClearRecentlyPlayed = vi.fn<(_fetch: unknown) => Promise<import('@shared/types').RecentlyPlayedSnapshot>>();
const apiFetchFavorites = vi.fn<(_fetch: unknown) => Promise<import('@shared/types').FavoritesResponse>>();
const apiAddFavorite = vi.fn<(_fetch: unknown, payload: any) => Promise<import('@shared/types').FavoritesResponse>>();
const apiRemoveFavorite = vi.fn<(_fetch: unknown, id: string) => Promise<import('@shared/types').FavoritesResponse>>();
type ClassicCommandRecord = {
	operation: ClassicBrowseOperation;
	role: ClassicBrowseRole;
	options: Record<string, unknown>;
};
const classicCommand = vi.fn<(record: ClassicCommandRecord) => void>();
let classicTransactionCompletionHook:
	| ((role: ClassicBrowseRole) => void | Promise<void>)
	| null = null;
const { pushStateMock, replaceStateMock } = vi.hoisted(() => ({
	pushStateMock: vi.fn(),
	replaceStateMock: vi.fn()
}));

function browseRole(options: any, role?: ClassicBrowseRole): ClassicBrowseRole {
	return role ?? (options?.hierarchy === 'search' ? 'classic-search' : 'classic-browse');
}

function recordClassicCommand(
	operation: ClassicBrowseOperation,
	role: ClassicBrowseRole,
	options: Record<string, unknown>
): void {
	classicCommand({ operation, role, options });
}

function classicCommandRecords(
	operation?: ClassicBrowseOperation,
	role?: ClassicBrowseRole
): ClassicCommandRecord[] {
	return classicCommand.mock.calls
		.map(([record]) => record)
		.filter(
			(record) =>
				(operation === undefined || record.operation === operation) &&
				(role === undefined || record.role === role)
		);
}

function expectClassicCommand(
	operation: ClassicBrowseOperation,
	role: ClassicBrowseRole,
	options: Record<string, unknown>
): void {
	expect(classicCommand).toHaveBeenCalledWith(
		expect.objectContaining({
			operation,
			role,
			options: expect.objectContaining(options)
		})
	);
}

function expectNoClassicCommand(
	operation: ClassicBrowseOperation,
	role: ClassicBrowseRole,
	options: Record<string, unknown> = {}
): void {
	expect(classicCommand).not.toHaveBeenCalledWith(
		expect.objectContaining({
			operation,
			role,
			options: expect.objectContaining(options)
		})
	);
}

vi.mock('$lib/api/client', () => ({
	browse: (...args: any[]) => {
		const role = browseRole(args[1], args[3]);
		recordClassicCommand('browse', role, args[1]);
		return (apiBrowse as unknown as (...values: [unknown, any]) => Promise<BrowseResult>)(
			args[0],
			args[1]
		);
	},
	browseSearch: (...args: any[]) => {
		const role = (args[3] ?? 'classic-search') as ClassicBrowseRole;
		recordClassicCommand('search', role, args[1]);
		return (apiBrowseSearch as unknown as (...values: [unknown, any]) => Promise<import('@shared/types').SearchResult[]>)(
			args[0],
			args[1]
		);
	},
	browseLoad: (...args: any[]) => {
		const role = browseRole(args[1], args[3]);
		recordClassicCommand('load', role, args[1]);
		return (apiBrowseLoad as unknown as (...values: [unknown, any]) => Promise<BrowseResult>)(
			args[0],
			args[1]
		);
	},
	browsePop: (...args: any[]) => {
		const role = browseRole(args[1], args[3]);
		recordClassicCommand('pop', role, args[1]);
		return (apiBrowsePop as unknown as (...values: [unknown, any]) => Promise<BrowseResult>)(
			args[0],
			args[1]
		);
	},
	clearRecentlyPlayed: (...args: any[]) => apiClearRecentlyPlayed(...(args as [unknown])),
	fetchFavorites: (...args: any[]) => apiFetchFavorites(...(args as [unknown])),
	addFavorite: (...args: any[]) => apiAddFavorite(...(args as [unknown, any])),
	removeFavorite: (...args: any[]) => apiRemoveFavorite(...(args as [unknown, string])),
	withClassicBrowseRoleTransaction: async (
		role: ClassicBrowseRole,
		_claim: unknown,
		work: (transaction: {
			browse: (options: any) => Promise<BrowseResult>;
			browseSearch: (options: any) => Promise<import('@shared/types').SearchResult[]>;
			browseLoad: (options: any) => Promise<BrowseResult>;
			browsePop: (options: any) => Promise<BrowseResult>;
		}) => Promise<unknown>
	) => {
		const result = await work({
			browse: (options) => {
				recordClassicCommand('browse', role, options);
				if (role === 'classic-explore') {
					return Promise.resolve({
						level: 0,
						offset: 0,
						count: 0,
						totalCount: 0,
						items: []
					});
				}
				return apiBrowse(fetch, options);
			},
			browseSearch: (options) => {
				recordClassicCommand('search', role, options);
				return apiBrowseSearch(fetch, options);
			},
			browseLoad: (options) => {
				recordClassicCommand('load', role, options);
				return apiBrowseLoad(fetch, options);
			},
			browsePop: (options) => {
				recordClassicCommand('pop', role, options);
				return apiBrowsePop(fetch, options);
			}
		});
		await classicTransactionCompletionHook?.(role);
		return result;
	}
}));

import { createFakeSocket } from '../../../test/fixtures/socket';
const fakeSocket = createFakeSocket();
let classicAcquireGeneration = 0;
vi.mock('$lib/socket/client', () => ({
	getSocket: () => fakeSocket,
	disconnectSocket: vi.fn()
}));

// $app/navigation isn't used by Library directly, but the Search child
// component imports nothing from it. Provide a stub anyway so any
// transitive import resolves.
vi.mock('$app/navigation', () => ({
	goto: vi.fn(),
	afterNavigate: vi.fn((callback: (navigation: { type: string }) => void) => {
		callback({ type: 'enter' });
	}),
	pushState: pushStateMock,
	replaceState: replaceStateMock
}));

// Import after mocks so the extracted Classic mode picks them up.
// Keep the existing local name so the behavioral suite remains otherwise unchanged.
import LibraryPage from '../ClassicLibraryMode.svelte';
import PreserveClassicHistoryHost from './fixtures/PreserveClassicHistoryHost.svelte';
import { browseHistoryStore, resetHistory, pushHistory, popHistory } from '$lib/stores/browseHistoryStore';
import {
	browseStore,
	resetBrowse,
	setBrowseResult,
	setSearchLoading,
	setSearchResults
} from '$lib/stores/browseStore';
import { setSelectedZone } from '$lib/stores/selectedZoneStore';
import { favoritesStore, resetFavorites, loadFavorites } from '$lib/stores/favoritesStore';
import { resetRecentlyPlayed } from '$lib/stores/recentlyPlayedStore';
import {
	pendingLibraryIntentStore,
	publishLibraryIntent,
	resetLibraryIntentStore
} from '$lib/stores/libraryIntentStore';
import { claimLibraryViewHost } from '$lib/stores/libraryViewHostStore';
import {
	ClassicBrowseSupersededError,
	classicBrowseSessionClient
} from '$lib/stores/classicBrowseSessionStore';
import {
	LIBRARY_MODE_ACTIVATION_CONTEXT,
	type LibraryModeActivationContext,
	type LibraryModeLifecycle
} from '$lib/libraryModeActivationContext';

// ---------------- Helpers ----------------

import { listResult, makeItem, makeSearchResult } from '../../../test/fixtures/browse';

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function renderClassic(options: { restoreOnMount?: boolean } = {}) {
	return render(LibraryPage, {
		props: { restoreOnMount: options.restoreOnMount ?? false }
	});
}

function renderClassicWithLifecycle() {
	let lifecycle: LibraryModeLifecycle | null = null;
	const activationContext: LibraryModeActivationContext = {
		classicTruncationHistoryPolicy: () => 'replace',
		registerLifecycle: (_mode, registered) => {
			lifecycle = registered;
			registered.resume(undefined as never);
			return () => undefined;
		}
	};
	const view = render(LibraryPage, {
		props: { restoreOnMount: false },
		context: new Map([[LIBRARY_MODE_ACTIVATION_CONTEXT, activationContext]])
	});
	const requireLifecycle = (): LibraryModeLifecycle => {
		if (!lifecycle) throw new Error('Classic lifecycle was not registered.');
		return lifecycle;
	};
	return {
		view,
		suspend: () => requireLifecycle().suspend(),
		resume: () => requireLifecycle().resume(undefined as never)
	};
}

beforeEach(() => {
	classicCommand.mockReset();
	classicTransactionCompletionHook = null;
	apiBrowse.mockReset();
	apiBrowseSearch.mockReset();
	apiBrowseSearch.mockResolvedValue([]);
	apiBrowseLoad.mockReset();
	apiBrowsePop.mockReset();
	apiBrowsePop.mockResolvedValue(listResult({ level: 2 }));
	apiClearRecentlyPlayed.mockReset();
	apiFetchFavorites.mockReset();
	apiFetchFavorites.mockResolvedValue({ entries: [] });
	apiAddFavorite.mockReset();
	apiAddFavorite.mockResolvedValue({ entries: [] });
	apiRemoveFavorite.mockReset();
	apiRemoveFavorite.mockResolvedValue({ entries: [] });
	pushStateMock.mockReset();
	replaceStateMock.mockReset();
	fakeSocket.emit.mockReset();
	fakeSocket.on.mockReset();
	fakeSocket.off.mockReset();
	fakeSocket.emit.mockImplementation((event, payload, ack) => {
		if (typeof ack !== 'function') return;
		if (event === 'classic-session:acquire') {
			classicAcquireGeneration += 1;
			ack({
				success: true,
				data: {
					requestId: payload.requestId,
					session: {
						handleId: `classic-test-${classicAcquireGeneration}`,
						generation: classicAcquireGeneration
					}
				}
			});
			return;
		}
		if (event === 'classic-session:release') {
			ack({ success: true, data: { requestId: payload.requestId } });
		}
	});
	// Restore the connected flag — disconnect-path tests flip this to
	// false, and an assertion failure before the test's own restore
	// would otherwise leak the disconnected state into later tests.
	fakeSocket.connected = true;
	resetBrowse();
	resetHistory();
	resetFavorites();
	resetRecentlyPlayed();
	resetLibraryIntentStore();
	setSelectedZone('');
	// Default: any apiBrowse call returns an empty browse root.
	apiBrowse.mockResolvedValue(listResult({ level: 0 }));
	apiClearRecentlyPlayed.mockResolvedValue({ entries: [], revision: 1_000_000, epoch: 1 });
});

afterEach(() => {
	expect(
		fakeSocket.emit.mock.calls.filter(
			([event]) => typeof event === 'string' && event.startsWith('browse:')
		)
	).toEqual([]);
	for (const record of classicCommandRecords()) {
		expect(record.options).not.toHaveProperty('multiSessionKey');
	}
});

describe('Library page — typed Library intents', () => {
	it('activates the Classic intent consumer after a normal-shell claim fails', async () => {
		let acquireAttempt = 0;
		fakeSocket.emit.mockImplementation((event, payload, ack) => {
			if (typeof ack !== 'function') return;
			if (event === 'classic-session:acquire') {
				acquireAttempt += 1;
				if (acquireAttempt === 1) {
					ack({ success: false, error: 'normal acquire failed', code: 'SESSION_LOST' });
					return;
				}
				ack({
					success: true,
					data: {
						requestId: payload.requestId,
						session: { handleId: 'classic-after-normal-failure', generation: 2 }
					}
				});
				return;
			}
			if (event === 'classic-session:release') {
				ack({ success: true, data: { requestId: payload.requestId } });
			}
		});
		const failedNormal = classicBrowseSessionClient.claim('normal-shell');
		await expect(failedNormal.ready).rejects.toThrow('normal acquire failed');
		publishLibraryIntent({
			kind: 'general',
			destination: 'search',
			query: 'Recovered Classic consumer'
		});

		renderClassic();
		await waitFor(() =>
			expectClassicCommand('search', 'classic-search', {
				input: 'Recovered Classic consumer'
			})
		);
		expect(get(pendingLibraryIntentStore)).toBeNull();
		expect(get(classicBrowseSessionClient)).toMatchObject({
			owner: 'classic-mode',
			phase: 'live'
		});
	});

	it('claims a search intent once and does not replay it after remount', async () => {
		const pending = publishLibraryIntent({
			kind: 'general',
			destination: 'search',
			query: 'Tilda Arlen',
			display: { title: 'Tilda Arlen' }
		});
		expect(pending).not.toBeNull();

		const first = renderClassic();
		await waitFor(() => {
			expectClassicCommand('search', 'classic-search', {
				input: 'Tilda Arlen',
				popAll: true
			});
		});
		expect(get(pendingLibraryIntentStore)).toBeNull();

		first.unmount();
		classicCommand.mockClear();
		renderClassic();
		await tick();
		expect(classicCommandRecords('search', 'classic-search')).toHaveLength(0);
	});

	it('lets a pre-mounted intent supersede persisted Classic restoration', async () => {
		pushHistory({ hierarchy: 'browse' }, { title: 'Saved destination' });
		publishLibraryIntent({
			kind: 'artist',
			destination: 'search',
			query: 'Newest destination',
			display: { title: 'Newest destination' }
		});

		renderClassic({ restoreOnMount: true });
		await waitFor(() => {
			expectClassicCommand('search', 'classic-search', {
				input: 'Newest destination'
			});
		});

		const restoreCalls = apiBrowse.mock.calls;
		expect(restoreCalls).toHaveLength(0);
		expect(get(browseHistoryStore).history).toEqual([]);
		expect(get(browseStore).lastSearchQuery).toBe('Newest destination');
	});

	it('keeps a local intent parked while outgoing Classic is transitioning', async () => {
		const host = claimLibraryViewHost();
		host.publishActiveMode('classic', {
			fromMode: 'classic',
			toMode: 'timeline'
		});
		try {
			renderClassic();
			await tick();

			const pending = publishLibraryIntent({
				kind: 'general',
				destination: 'welcome-section',
				section: 'favorites'
			});
			expect(pending).not.toBeNull();
			await tick();

			expect(get(pendingLibraryIntentStore)?.requestId).toBe(pending?.requestId);
			expect(document.activeElement?.id).not.toBe('favorites-section');

			host.publishActiveMode('classic');
			await waitFor(() => expect(get(pendingLibraryIntentStore)).toBeNull());
			await waitFor(() => expect(document.activeElement?.id).toBe('favorites-section'));
		} finally {
			host.release();
		}
	});

	it('keeps a network intent parked when Classic session readiness settles mid-transition', async () => {
		const host = claimLibraryViewHost();
		host.publishActiveMode('classic', {
			fromMode: 'classic',
			toMode: 'timeline'
		});
		const pendingAcquires: Array<{
			payload: { requestId: string };
			ack: (value: unknown) => void;
		}> = [];
		fakeSocket.emit.mockImplementation((event, payload, ack) => {
			if (typeof ack !== 'function') return;
			if (event === 'classic-session:acquire') {
				pendingAcquires.push({ payload, ack });
				return;
			}
			if (event === 'classic-session:release') {
				ack({ success: true, data: { requestId: payload.requestId } });
			}
		});

		try {
			const pending = publishLibraryIntent({
				kind: 'general',
				destination: 'search',
				query: 'Parked until incoming mode'
			});
			expect(pending).not.toBeNull();
			renderClassic();
			await waitFor(() => expect(pendingAcquires).toHaveLength(1));
			const acquire = pendingAcquires[0];
			if (!acquire) throw new Error('Classic acquire was not captured');
			acquire.ack({
				success: true,
				data: {
					requestId: acquire.payload.requestId,
					session: { handleId: 'transition-acquire', generation: 501 }
				}
			});
			await waitFor(() => expect(get(classicBrowseSessionClient).phase).toBe('live'));
			await tick();

			expect(get(pendingLibraryIntentStore)?.requestId).toBe(pending?.requestId);
			expectNoClassicCommand('search', 'classic-search', {
				input: 'Parked until incoming mode'
			});

			host.publishActiveMode('classic');
			await waitFor(() => expect(get(pendingLibraryIntentStore)).toBeNull());
			await waitFor(() =>
				expectClassicCommand('search', 'classic-search', {
					input: 'Parked until incoming mode'
				})
			);
		} finally {
			host.release();
		}
	});

	it('serializes mounted search intents and publishes only the latest result', async () => {
		renderClassic();
		await tick();
		const first = deferred<import('@shared/types').SearchResult[]>();
		const second = deferred<import('@shared/types').SearchResult[]>();
		apiBrowseSearch.mockReset();
		apiBrowseSearch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

		publishLibraryIntent({ kind: 'general', destination: 'search', query: 'First' });
		await waitFor(() => expect(apiBrowseSearch).toHaveBeenCalledTimes(1));
		publishLibraryIntent({ kind: 'general', destination: 'search', query: 'Second' });
		await waitFor(() => expect(get(pendingLibraryIntentStore)).toBeNull());
		expect(apiBrowseSearch.mock.calls.map(([, options]) => options.input)).toEqual(['First']);

		first.resolve([makeSearchResult({ resultType: 'artist', title: 'First result' })]);
		await waitFor(() => expect(apiBrowseSearch).toHaveBeenCalledTimes(2));
		expect(get(browseStore).lastSearch).toBeNull();
		expect(get(browseStore).lastSearchQuery).toBe('Second');

		second.resolve([makeSearchResult({ resultType: 'artist', title: 'Second result' })]);
		await waitFor(() => {
			expect(get(browseStore).lastSearch?.map((result) => result.title)).toEqual([
				'Second result'
			]);
		});
	});

	it('keeps a disconnected network intent pending until a fresh acquire', async () => {
		renderClassic();
		await waitFor(() => {
			expect(
				fakeSocket.emit.mock.calls.some(([event]) => event === 'classic-session:acquire')
			).toBe(true);
		});
		fakeSocket.emit.mockClear();
		fakeSocket.connected = false;
		const disconnect = fakeSocket.on.mock.calls
			.filter(([event]) => event === 'disconnect')
			.at(-1)?.[1] as (() => void) | undefined;
		disconnect?.();

		const pending = publishLibraryIntent({
			kind: 'artist',
			destination: 'search',
			query: 'Tilda Arlen',
			display: { title: 'Tilda Arlen' }
		});
		expect(pending).not.toBeNull();
		await tick();
		expect(get(pendingLibraryIntentStore)?.requestId).toBe(pending?.requestId);
		expectNoClassicCommand('search', 'classic-search', { input: 'Tilda Arlen' });

		fakeSocket.connected = true;
		const connect = fakeSocket.on.mock.calls
			.filter(([event]) => event === 'connect')
			.at(-1)?.[1] as (() => void) | undefined;
		connect?.();
		await waitFor(() => expect(get(pendingLibraryIntentStore)).toBeNull());
		await waitFor(() =>
			expectClassicCommand('search', 'classic-search', { input: 'Tilda Arlen' })
		);
		const acquireIndex = fakeSocket.emit.mock.calls.findIndex(
			([event]) => event === 'classic-session:acquire'
		);
		const searchIndex = classicCommand.mock.calls.findIndex(
			([record]) =>
				record.operation === 'search' &&
				record.role === 'classic-search' &&
				record.options.input === 'Tilda Arlen'
		);
		expect(acquireIndex).toBeGreaterThanOrEqual(0);
		expect(searchIndex).toBeGreaterThanOrEqual(0);
		expect(fakeSocket.emit.mock.invocationCallOrder[acquireIndex]).toBeLessThan(
			classicCommand.mock.invocationCallOrder[searchIndex]
		);
	});

	it('recovers a second connection generation while the first acquire remains pending', async () => {
		renderClassic();
		await waitFor(() => expect(get(classicBrowseSessionClient).phase).toBe('live'));

		const disconnect = fakeSocket.on.mock.calls
			.filter(([event]) => event === 'disconnect')
			.at(-1)?.[1] as (() => void) | undefined;
		const connect = fakeSocket.on.mock.calls
			.filter(([event]) => event === 'connect')
			.at(-1)?.[1] as (() => void) | undefined;
		const pendingAcquires: Array<{
			payload: { requestId: string };
			ack: (value: unknown) => void;
		}> = [];

		fakeSocket.emit.mockClear();
		fakeSocket.emit.mockImplementation((event, payload, ack) => {
			if (typeof ack !== 'function') return;
			if (event === 'classic-session:acquire') {
				pendingAcquires.push({ payload, ack });
				if (pendingAcquires.length === 2) {
					ack({
						success: true,
						data: {
							requestId: payload.requestId,
							session: { handleId: 'recovery-b', generation: 202 }
						}
					});
				}
				return;
			}
			if (event === 'classic-session:release') {
				ack({ success: true, data: { requestId: payload.requestId } });
			}
		});

		fakeSocket.connected = false;
		disconnect?.();
		fakeSocket.connected = true;
		connect?.();
		await waitFor(() => expect(pendingAcquires).toHaveLength(1));

		fakeSocket.connected = false;
		disconnect?.();
		publishLibraryIntent({
			kind: 'general',
			destination: 'search',
			query: 'Recovered on B'
		});
		fakeSocket.connected = true;
		connect?.();

		await waitFor(() => expect(pendingAcquires).toHaveLength(2));
		await waitFor(() =>
			expectClassicCommand('search', 'classic-search', { input: 'Recovered on B' })
		);
		expect(get(classicBrowseSessionClient).session?.handleId).toBe('recovery-b');

		const stale = pendingAcquires[0];
		stale.ack({
			success: true,
			data: {
				requestId: stale.payload.requestId,
				session: { handleId: 'stale-recovery-a', generation: 101 }
			}
		});
		await tick();
		await Promise.resolve();
		expect(get(classicBrowseSessionClient).session?.handleId).toBe('recovery-b');

		publishLibraryIntent({
			kind: 'general',
			destination: 'search',
			query: 'Still live on B'
		});
		await waitFor(() =>
			expectClassicCommand('search', 'classic-search', { input: 'Still live on B' })
		);
	});

	it('retires actionable rows across a batched live → acquiring → live generation change', async () => {
		const originalClaim = classicBrowseSessionClient.claim;
		let componentClaim: ReturnType<typeof originalClaim> | null = null;
		const claimSpy = vi
			.spyOn(classicBrowseSessionClient, 'claim')
			.mockImplementation((owner) => {
				const claim = originalClaim(owner);
				componentClaim = claim;
				return claim;
			});

		renderClassic();
		await waitFor(() => expect(get(classicBrowseSessionClient).phase).toBe('live'));
		claimSpy.mockRestore();
		const claim = componentClaim;
		if (!claim) throw new Error('Classic component did not claim its session');
		await tick(); // record the live phase/generation in the component effect

		setBrowseResult(
			listResult({
				level: 1,
				items: [makeItem({ title: 'Retired action', itemKey: 'retired-action-key' })]
			}),
			'browse'
		);
		expect(get(browseStore).current?.items[0]?.itemKey).toBe('retired-action-key');

		const priorGeneration = get(classicBrowseSessionClient).lifecycleGeneration;
		classicBrowseSessionClient.connectionLost(claim);
		const recovered = classicBrowseSessionClient.recover(claim);
		// No render flush occurs between retirement and reacquisition: the
		// component can observe acquiring (or live), but never phase none.
		expect(get(classicBrowseSessionClient)).toMatchObject({ phase: 'acquiring' });
		expect(get(classicBrowseSessionClient).lifecycleGeneration).toBeGreaterThan(
			priorGeneration
		);

		await recovered;
		await waitFor(() =>
			expect(
				get(browseStore).current?.items.some(
					(item) => item.itemKey === 'retired-action-key'
				) ?? false
			).toBe(false)
		);
		expect(get(classicBrowseSessionClient).phase).toBe('live');
	});

	it('opens and focuses the stable empty Recently Played landing while disconnected', async () => {
		const scrollIntoView = vi.fn();
		Element.prototype.scrollIntoView = scrollIntoView;
		fakeSocket.connected = false;
		renderClassic();
		await tick();
		apiBrowse.mockClear();
		fakeSocket.emit.mockClear();

		publishLibraryIntent({
			kind: 'general',
			destination: 'welcome-section',
			section: 'recently-played'
		});

		await waitFor(() => expect(document.activeElement?.id).toBe('recently-played-section'));
		const landing = screen.getByRole('region', { name: 'Recently played' });
		expect(landing).toHaveAttribute('id', 'recently-played-section');
		expect(landing).toHaveAttribute('tabindex', '-1');
		expect(landing).toHaveTextContent(/No recently played music has been observed/i);
		expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
		expect(apiBrowse).not.toHaveBeenCalled();
		expect(fakeSocket.emit).not.toHaveBeenCalled();
	});

	it('maps the Favorites welcome intent to its fixed local anchor', async () => {
		const scrollIntoView = vi.fn();
		Element.prototype.scrollIntoView = scrollIntoView;
		fakeSocket.connected = false;
		renderClassic();
		await tick();
		apiBrowse.mockClear();

		publishLibraryIntent({
			kind: 'general',
			destination: 'welcome-section',
			section: 'favorites'
		});

		await waitFor(() => expect(document.activeElement?.id).toBe('favorites-section'));
		const landing = screen.getByRole('region', { name: 'Favorites' });
		expect(landing).toHaveAttribute('id', 'favorites-section');
		expect(landing).toHaveAttribute('tabindex', '-1');
		expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
		expect(apiBrowse).not.toHaveBeenCalled();
	});

	it('re-resolves an Explore path from fresh labels and records only semantic breadcrumbs', async () => {
		renderClassic();
		await tick();
		apiBrowse.mockReset();
		apiBrowse.mockImplementation(async (_fetch, opts) => {
			if (opts.popAll) {
				return listResult({
					level: 0,
					items: [makeItem({ title: 'Library', itemKey: 'fresh-library-key' })]
				});
			}
			if (opts.itemKey === 'fresh-library-key') {
				return listResult({
					level: 1,
					items: [makeItem({ title: 'Albums', itemKey: 'fresh-albums-key' })]
				});
			}
			return listResult({
				level: 2,
				title: 'Albums',
				items: [makeItem({ title: 'Blue', itemKey: 'fresh-album-key' })]
			});
		});

		publishLibraryIntent({
			kind: 'general',
			destination: 'explore-path',
			labelPath: ['Library', 'Albums']
		});

		await waitFor(() => expect(get(browseStore).current?.level).toBe(2));
		const navCalls = apiBrowse.mock.calls;
		expect(navCalls.map(([, opts]) => opts.itemKey ?? 'root')).toEqual([
			'root',
			'fresh-library-key',
			'fresh-albums-key'
		]);
		expect(get(browseHistoryStore).history.map((step) => step.breadcrumb.title)).toEqual([
			'Library',
			'Albums'
		]);
		expect(JSON.stringify(get(browseHistoryStore))).not.toContain('fresh-library-key');
	});

	it('fails an ambiguous Explore segment closed on the fresh safe root', async () => {
		renderClassic();
		await tick();
		apiBrowse.mockReset();
		apiBrowse.mockResolvedValue(
			listResult({
				level: 0,
				title: 'Browse',
				items: [
					makeItem({ title: 'Albums', itemKey: 'albums-a' }),
					makeItem({ title: 'Albums', itemKey: 'albums-b' })
				]
			})
		);

		publishLibraryIntent({
			kind: 'general',
			destination: 'explore-path',
			labelPath: ['Albums']
		});

		await waitFor(async () => {
			const { commandFeedbackStore } = await import('$lib/stores/commandFeedbackStore');
			expect(get(commandFeedbackStore)?.message).toMatch(/ambiguous/i);
		});
		expect(get(browseStore).current?.title).toBe('Browse');
		expect(get(browseHistoryStore).history).toHaveLength(0);
		expect(apiBrowse).toHaveBeenCalledTimes(1);
	});

	it('hides stale rows during an Explore walk and ignores its result after unmount', async () => {
		const view = renderClassic();
		await tick();
		const prior = listResult({
			level: 1,
			title: 'Prior page',
			items: [makeItem({ title: 'Prior item', itemKey: 'prior-key' })]
		});
		setBrowseResult(prior, 'browse');
		pushHistory({ hierarchy: 'browse' }, { title: 'Prior page' });

		const freshRoot = deferred<BrowseResult>();
		apiBrowse.mockReset();
		apiBrowse.mockImplementation(async (_fetch, opts) => {
			if (opts.popAll) return freshRoot.promise;
			return listResult({ level: 1, title: 'Old resolver result' });
		});
		publishLibraryIntent({
			kind: 'general',
			destination: 'explore-path',
			labelPath: ['Library']
		});

		await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(1));
		expect(get(browseStore).current).toBeNull();
		expect(get(browseHistoryStore).history).toEqual([]);
		expect(screen.queryByText('Prior item')).toBeNull();
		expect(
			screen.getByRole('region', { name: 'Opening Library destination' })
		).toHaveAttribute('aria-busy', 'true');
		expect(screen.queryAllByRole('button')).toHaveLength(0);

		view.unmount();
		const survivor = listResult({ level: 0, title: 'New owner surface' });
		setBrowseResult(survivor, 'browse');
		freshRoot.resolve(
			listResult({
				level: 0,
				items: [makeItem({ title: 'Library', itemKey: 'fresh-library-key' })]
			})
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(apiBrowse).toHaveBeenCalledTimes(1);
		expect(get(browseStore).current).toBe(survivor);
	});

	it('uses one zone snapshot for every Explore hop without persisting it', async () => {
		renderClassic();
		await tick();
		setSelectedZone('zone-a');
		const freshRoot = deferred<BrowseResult>();
		apiBrowse.mockReset();
		apiBrowse.mockImplementation(async (_fetch, opts) => {
			if (opts.popAll) return freshRoot.promise;
			return listResult({ level: 1, title: 'Fresh Library' });
		});
		publishLibraryIntent({
			kind: 'general',
			destination: 'explore-path',
			labelPath: ['Library']
		});

		await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(1));
		setSelectedZone('zone-b');
		freshRoot.resolve(
			listResult({
				level: 0,
				items: [makeItem({ title: 'Library', itemKey: 'fresh-library-key' })]
			})
		);

		await waitFor(() => expect(get(browseStore).current?.title).toBe('Fresh Library'));
		expect(apiBrowse.mock.calls.map(([, opts]) => opts.zoneId)).toEqual(['zone-a', 'zone-a']);
		expect(get(browseHistoryStore).history[0]?.breadcrumb.title).toBe('Library');
		expect(JSON.stringify(get(browseHistoryStore))).not.toContain('zone-a');
	});

	it('re-seeds the intent query and drills only the uniquely-shaped search category', async () => {
		const grouped = [
			makeSearchResult({
				title: 'Wait for It',
				itemKey: 'side-session-track',
				resultType: 'track'
			})
		];
		apiBrowseSearch.mockResolvedValue(grouped);
		renderClassic();
		await tick();
		apiBrowse.mockReset();
		apiBrowse.mockImplementation(async (_fetch, opts) => {
			if (opts.input === 'hamilton') {
				return listResult({
					level: 0,
					items: [
						makeItem({ title: 'Tracks', itemKey: 'decoy', hint: 'action' }),
						makeItem({
							title: 'Tracks',
							itemKey: 'fresh-tracks-stub',
							hint: 'list',
							subtitle: '80 Results'
						})
					]
				});
			}
			return listResult({
				level: 1,
				title: 'Tracks',
				items: [makeItem({ title: 'Wait for It', itemKey: 'fresh-track' })]
			});
		});

		publishLibraryIntent({
			kind: 'general',
			destination: 'search-category',
			query: 'hamilton',
			categoryTitle: 'Tracks'
		});

		await waitFor(() => expect(get(browseStore).current?.title).toBe('Tracks'));
		expect(apiBrowseSearch).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ input: 'hamilton', popAll: true })
		);
		expect(apiBrowse.mock.calls[0][1]).toEqual(
			expect.objectContaining({ input: 'hamilton', popAll: true })
		);
		expect(apiBrowse.mock.calls[1][1]).toEqual(
			expect.objectContaining({ itemKey: 'fresh-tracks-stub' })
		);
		expect(get(browseStore).lastSearch).toEqual(grouped);
		expect(get(browseHistoryStore).context).toEqual({ hierarchy: 'search', query: 'hamilton' });
		expect(get(browseHistoryStore).history[0]?.breadcrumb).toEqual({
			title: 'Tracks',
			searchCategory: true
		});
	});

	it('keeps the fresh grouped-search root when a category destination is ambiguous', async () => {
		const grouped = [
			makeSearchResult({
				title: 'My Shot',
				itemKey: 'side-session-track',
				resultType: 'track'
			})
		];
		apiBrowseSearch.mockResolvedValue(grouped);
		renderClassic();
		await tick();
		apiBrowse.mockReset();
		apiBrowse.mockResolvedValue(
			listResult({
				level: 0,
				items: [
					makeItem({
						title: 'Tracks',
						itemKey: 'tracks-a',
						hint: 'list',
						subtitle: '80 Results'
					}),
					makeItem({
						title: 'Tracks',
						itemKey: 'tracks-b',
						hint: 'list',
						subtitle: '81 Results'
					})
				]
			})
		);

		publishLibraryIntent({
			kind: 'general',
			destination: 'search-category',
			query: 'hamilton',
			categoryTitle: 'Tracks'
		});

		await waitFor(async () => {
			const { commandFeedbackStore } = await import('$lib/stores/commandFeedbackStore');
			expect(get(commandFeedbackStore)?.message).toMatch(/ambiguous/i);
		});
		expect(get(browseStore).lastSearch).toEqual(grouped);
		expect(get(browseStore).current).toBeNull();
		expect(get(browseHistoryStore).history).toHaveLength(0);
		expect(apiBrowse).toHaveBeenCalledTimes(1);
	});

	it('keeps a category resolver inert and returns to the safe root after disconnect', async () => {
		const grouped = [
			makeSearchResult({
				title: 'My Shot',
				itemKey: 'side-session-track',
				resultType: 'track'
			})
		];
		apiBrowseSearch.mockResolvedValue(grouped);
		renderClassic();
		await tick();
		setBrowseResult(
			listResult({
				level: 1,
				title: 'Prior page',
				items: [makeItem({ title: 'Prior item', itemKey: 'prior-key' })]
			}),
			'browse'
		);
		setSearchLoading('prior');
		setSearchResults([
			makeSearchResult({ resultType: 'artist', title: 'Prior search result' })
		]);

		const freshRoot = deferred<BrowseResult>();
		apiBrowse.mockReset();
		apiBrowse.mockImplementation(async (_fetch, opts) => {
			if (opts.popAll) return freshRoot.promise;
			return listResult({ level: 1, title: 'Tracks' });
		});
		publishLibraryIntent({
			kind: 'general',
			destination: 'search-category',
			query: 'hamilton',
			categoryTitle: 'Tracks'
		});

		await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(1));
		expect(get(browseStore).current).toBeNull();
		expect(get(browseStore).lastSearch).toBeNull();
		expect(
			screen.getByRole('region', { name: 'Opening Library destination' })
		).toHaveAttribute('aria-busy', 'true');
		expect(screen.queryAllByRole('button')).toHaveLength(0);

		fakeSocket.connected = false;
		freshRoot.reject(new Error('Core disconnected'));
		await waitFor(async () => {
			const { commandFeedbackStore } = await import('$lib/stores/commandFeedbackStore');
			expect(get(commandFeedbackStore)?.message).toMatch(/Core disconnected/i);
		});
		expect(get(browseStore).current).toBeNull();
		expect(get(browseStore).lastSearch).toBeNull();
		expect(screen.queryByRole('region', { name: 'Opening Library destination' })).toBeNull();
	});
});

describe('Library page — mount restore', () => {
	it('retires keyed rows from the replaced Classic instance while offline', async () => {
		pushHistory({ hierarchy: 'browse' }, { title: 'Albums' });
		setBrowseResult(
			listResult({
				level: 1,
				items: [makeItem({ title: 'Stale offline row', itemKey: 'stale-offline-key' })]
			}),
			'browse'
		);
		fakeSocket.connected = false;

		renderClassic({ restoreOnMount: true });
		await tick();

		expect(get(browseStore).current).toBeNull();
		expect(get(browseHistoryStore).history).toEqual([
			{ hierarchy: 'browse', breadcrumb: { title: 'Albums' } }
		]);
		expect(apiBrowse.mock.calls).toEqual([]);
	});

	it('ignores stale cleanup from an overlapping keyed Classic instance', async () => {
		const first = renderClassic();
		await waitFor(() => expect(get(classicBrowseSessionClient).phase).toBe('live'));
		const firstHandle = get(classicBrowseSessionClient).session?.handleId;

		renderClassic();
		await waitFor(() =>
			expect(get(classicBrowseSessionClient).session?.handleId).not.toBe(firstHandle)
		);
		const successor = get(classicBrowseSessionClient).session;
		setBrowseResult(
			listResult({
				level: 1,
				items: [makeItem({ title: 'Successor row', itemKey: 'successor-key' })]
			}),
			'browse'
		);

		first.unmount();
		await tick();
		expect(get(classicBrowseSessionClient)).toMatchObject({
			owner: 'classic-mode',
			phase: 'live',
			session: successor
		});
		expect(get(browseStore).current?.items[0]?.title).toBe('Successor row');
	});

	it('hides old actions during restore and ignores a late root after unmount', async () => {
		pushHistory({ hierarchy: 'browse' }, { title: 'Albums' });
		const prior = listResult({
			level: 1,
			items: [makeItem({ title: 'Stale actionable row', itemKey: 'stale-live-key' })]
		});
		setBrowseResult(prior, 'browse');
		const root = deferred<BrowseResult>();
		apiBrowse.mockImplementation(() => root.promise);

		const view = renderClassic({ restoreOnMount: true });
		await waitFor(() =>
			expect(
				screen.getByRole('region', { name: 'Opening Library destination' })
			).toHaveAttribute('aria-busy', 'true')
		);
		await waitFor(() => {
			expect(apiBrowse.mock.calls).toHaveLength(1);
		});
		expect(screen.queryByRole('button', { name: /Stale actionable row/ })).toBeNull();

		view.unmount();
		root.resolve(
			listResult({
				level: 0,
				items: [makeItem({ title: 'Albums', itemKey: 'fresh-after-unmount' })]
			})
		);
		await root.promise;
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(get(browseStore).current).toBeNull();
		expect(get(browseHistoryStore).history).toEqual([
			{ hierarchy: 'browse', breadcrumb: { title: 'Albums' } }
		]);
	});

	it('ignores an abandoned drill while a fresh reconnect restore proceeds', async () => {
		pushHistory({ hierarchy: 'browse' }, { title: 'Albums' });
		const abandonedDrill = deferred<BrowseResult>();
		apiBrowse
			.mockResolvedValueOnce(
				listResult({
					level: 0,
					items: [makeItem({ title: 'Albums', itemKey: 'abandoned-albums-key' })]
				})
			)
			.mockImplementationOnce(() => abandonedDrill.promise);

		renderClassic({ restoreOnMount: true });
		await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(2));

		const disconnect = fakeSocket.on.mock.calls
			.filter(([event]) => event === 'disconnect')
			.at(-1)?.[1] as (() => void) | undefined;
		const connect = fakeSocket.on.mock.calls
			.filter(([event]) => event === 'connect')
			.at(-1)?.[1] as (() => void) | undefined;
		fakeSocket.connected = false;
		disconnect?.();
		expect(get(browseStore).current).toBeNull();

		apiBrowse
			.mockResolvedValueOnce(
				listResult({
					level: 0,
					items: [makeItem({ title: 'Albums', itemKey: 'recovered-albums-key' })]
				})
			)
			.mockResolvedValueOnce(
				listResult({
					level: 1,
					title: 'Recovered Albums',
					items: [makeItem({ title: 'Fresh recovered row', itemKey: 'fresh-row-key' })]
				})
			);
		fakeSocket.connected = true;
		connect?.();

		await waitFor(() => {
			expect(apiBrowse).toHaveBeenCalledTimes(4);
			expect(get(browseStore).current?.title).toBe('Recovered Albums');
		});
		expect(screen.getByRole('button', { name: /Fresh recovered row/ })).toBeInTheDocument();

		abandonedDrill.reject(new Error('late abandoned drill'));
		await abandonedDrill.promise.catch(() => undefined);
		await tick();
		await Promise.resolve();

		expect(get(browseStore).current?.title).toBe('Recovered Albums');
		expect(screen.getByRole('button', { name: /Fresh recovered row/ })).toBeInTheDocument();
		expect(screen.queryByText(/abandoned/i)).toBeNull();
		expect(get(browseHistoryStore).history).toEqual([
			{ hierarchy: 'browse', breadcrumb: { title: 'Albums' } }
		]);
	});

	it('restores an explicit zero-step browse root through a fresh popAll', async () => {
		apiBrowse.mockResolvedValueOnce(
			listResult({ items: [makeItem({ title: 'Fresh root item', itemKey: 'fresh-root-key' })] })
		);
		renderClassic({ restoreOnMount: true });
		await screen.findByText('Fresh root item');

		const navCalls = apiBrowse.mock.calls;
		expect(navCalls).toHaveLength(1);
		expect(navCalls[0][1]).toEqual(
			expect.objectContaining({ hierarchy: 'browse', popAll: true })
		);
	});

	it('with browse-rooted history, pops to root then walks each step', async () => {
		pushHistory({ hierarchy: 'browse' }, { title: 'One' });
		pushHistory({ hierarchy: 'browse' }, { title: 'Two' });

		// Three calls expected: popAll + step1 + step2.
		apiBrowse.mockResolvedValueOnce(
			listResult({ level: 0, items: [makeItem({ title: 'One', itemKey: 'fresh-one' })] })
		);
		apiBrowse.mockResolvedValueOnce(
			listResult({ level: 1, items: [makeItem({ title: 'Two', itemKey: 'fresh-two' })] })
		);
		apiBrowse.mockResolvedValueOnce(listResult({ level: 2 }));

		renderClassic({ restoreOnMount: true });

		await waitFor(() => {
			expect(apiBrowse).toHaveBeenCalledTimes(3);
		});

		expect(apiBrowse.mock.calls[0][1]).toEqual(
			expect.objectContaining({ hierarchy: 'browse', popAll: true })
		);
		expect(apiBrowse.mock.calls[1][1]).toEqual(
			expect.objectContaining({ hierarchy: 'browse', itemKey: 'fresh-one' })
		);
		expect(apiBrowse.mock.calls[2][1]).toEqual(
			expect.objectContaining({ hierarchy: 'browse', itemKey: 'fresh-two' })
		);
	});

	it('re-runs an explicit zero-step search root', async () => {
		resetHistory({ hierarchy: 'search', query: 'beatles' });

		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				title: 'Search',
				items: [makeItem({ title: 'Artists', itemKey: 'fresh-artists' })]
			})
		); // re-seed

		renderClassic({ restoreOnMount: true });

		await waitFor(() => {
			expect(apiBrowse).toHaveBeenCalledTimes(1);
		});

		expect(apiBrowse.mock.calls[0][1]).toEqual(
			expect.objectContaining({
				hierarchy: 'search',
				input: 'beatles',
				popAll: true,
			})
		);
		expect(await screen.findByText('Artists')).toBeInTheDocument();
		expect(get(browseHistoryStore).history).toEqual([]);
		expect(get(browseHistoryStore).context).toEqual({ hierarchy: 'search', query: 'beatles' });
	});

	it('forwards the selected zone into both the popAll and the replay step', async () => {
		setSelectedZone('zone-living-room');
		// Saved step has no zoneId of its own — restoreBrowse must inject
		// the active selection so the Roon session lands on the right
		// zone-or-output context for the replay.
		pushHistory({ hierarchy: 'browse' }, { title: 'Albums' });

		apiBrowse.mockResolvedValueOnce(
			listResult({ level: 0, items: [makeItem({ title: 'Albums', itemKey: 'fresh-albums' })] })
		);
		apiBrowse.mockResolvedValueOnce(listResult({ level: 1 }));

		renderClassic({ restoreOnMount: true });
		await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(2));

		// popAll call
		expect(apiBrowse.mock.calls[0][1]).toEqual(
			expect.objectContaining({ hierarchy: 'browse', popAll: true, zoneId: 'zone-living-room' })
		);
		// replay step
		expect(apiBrowse.mock.calls[1][1]).toEqual(
			expect.objectContaining({
				hierarchy: 'browse',
				itemKey: 'fresh-albums',
				zoneId: 'zone-living-room'
			})
		);
	});

	it('renders the items returned by the restore', async () => {
		// Push a history anchor so restoreBrowse runs the popAll + walk
		// path (empty history would render welcome instead).
		pushHistory({ hierarchy: 'browse' }, { title: 'Anchor' });
		apiBrowse.mockResolvedValueOnce(
			listResult({ level: 0, items: [makeItem({ title: 'Anchor', itemKey: 'fresh-anchor' })] })
		); // popAll
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 1,
				items: [
					makeItem({ title: 'Albums', itemKey: 'albums' }),
					makeItem({ title: 'Artists', itemKey: 'artists' })
				]
			})
		); // walk

		renderClassic({ restoreOnMount: true });

		expect(await screen.findByText('Albums')).toBeInTheDocument();
		expect(await screen.findByText('Artists')).toBeInTheDocument();
	});

	describe('search-rooted history with breadcrumbs', () => {
		// Re-walks a deep search drill after re-seed by matching saved
		// breadcrumbs against the freshly-loaded results at each level.
		// Persisted itemKeys are stale (Roon mints new ones on every search
		// re-seed), so each successful drill must use the FRESH key from
		// the just-loaded result list — not the persisted one.

		it('replays a one-step search drill via breadcrumb match using the FRESH itemKey', async () => {
			pushHistory(
				{ hierarchy: 'search', query: 'beatles' },
				{ title: 'Abbey Road', subtitle: 'The Beatles', itemType: 'album' }
			);

			// 1st apiBrowse: re-seed search; returns the same album under a
			// fresh itemKey.
			apiBrowse.mockResolvedValueOnce(
				listResult({
					level: 0,
					title: 'Search',
					items: [
						makeItem({
							title: 'Abbey Road',
							subtitle: 'The Beatles',
							itemKey: 'fresh-album-key',
							itemType: 'album'
						}),
						makeItem({
							title: 'Other Album',
							subtitle: 'The Beatles',
							itemKey: 'fresh-other-key',
							itemType: 'album'
						})
					]
				})
			);
			// 2nd apiBrowse: drill into the album (after breadcrumb match).
			apiBrowse.mockResolvedValueOnce(
				listResult({
					level: 1,
					title: 'Abbey Road',
					items: [makeItem({ title: '1. Come Together', itemKey: 't1', hint: 'action_list' })]
				})
			);

			renderClassic({ restoreOnMount: true });
			await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(2));

			// Re-seed used the saved query.
			expect(apiBrowse.mock.calls[0][1]).toEqual(
				expect.objectContaining({ hierarchy: 'search', input: 'beatles', popAll: true })
			);
			// Drill used the FRESH itemKey, not the persisted stale one.
			expect(apiBrowse.mock.calls[1][1]).toEqual(
				expect.objectContaining({ itemKey: 'fresh-album-key' })
			);
			expect(
				apiBrowse.mock.calls.some(([, opts]) => opts.itemKey === 'stale-album-key')
			).toBe(false);

			// The semantic breadcrumb remains keyless after resolution.
			await tick();
			const persisted = get(browseHistoryStore).history;
			expect(persisted).toHaveLength(1);
			expect(persisted[0].breadcrumb.title).toBe('Abbey Road');
			expect(JSON.stringify(persisted)).not.toContain('fresh-album-key');
		});

		it('walks two drill levels in sequence', async () => {
			pushHistory(
				{ hierarchy: 'search', query: 'beatles' },
				{ title: 'Abbey Road', subtitle: 'The Beatles', itemType: 'album' }
			);
			pushHistory(
				{ hierarchy: 'search', query: 'beatles' },
				{ title: '1. Come Together', itemType: 'track' }
			);

			apiBrowse.mockResolvedValueOnce(
				listResult({
					level: 0,
					items: [
						makeItem({
							title: 'Abbey Road',
							subtitle: 'The Beatles',
							itemKey: 'fresh-album-key',
							itemType: 'album'
						})
					]
				})
			);
			apiBrowse.mockResolvedValueOnce(
				listResult({
					level: 1,
					items: [
						makeItem({
							title: '1. Come Together',
							itemKey: 'fresh-track-key',
							itemType: 'track',
							hint: 'action_list'
						})
					]
				})
			);
			apiBrowse.mockResolvedValueOnce(
				listResult({
					level: 2,
					items: [makeItem({ title: 'Play Now', itemKey: 'pn', hint: 'action' })]
				})
			);

			renderClassic({ restoreOnMount: true });
			await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(3));

			expect(apiBrowse.mock.calls[1][1]).toEqual(
				expect.objectContaining({ itemKey: 'fresh-album-key' })
			);
			expect(apiBrowse.mock.calls[2][1]).toEqual(
				expect.objectContaining({ itemKey: 'fresh-track-key' })
			);

			await tick();
			const persisted = get(browseHistoryStore).history;
			expect(persisted.map((s) => s.breadcrumb.title)).toEqual([
				'Abbey Road',
				'1. Come Together'
			]);
			expect(JSON.stringify(persisted)).not.toContain('fresh-track-key');
		});

		it('stops walking when a breadcrumb no longer matches any current item', async () => {
			pushHistory(
				{ hierarchy: 'search', query: 'beatles' },
				{ title: 'Abbey Road', subtitle: 'The Beatles', itemType: 'album' }
			);

			// Re-seed returns a different album — breadcrumb won't match.
			apiBrowse.mockResolvedValueOnce(
				listResult({
					level: 0,
					items: [
						makeItem({
							title: 'Let It Be',
							subtitle: 'The Beatles',
							itemKey: 'fresh-let-it-be',
							itemType: 'album'
						})
					]
				})
			);

			renderClassic({ restoreOnMount: true });
			await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(1));

			// No drill call, history truncated, feedback toast pushed.
			expect(apiBrowse).toHaveBeenCalledTimes(1);
			expect(get(browseHistoryStore).history).toEqual([]);
			await waitFor(() =>
				expect(replaceStateMock).toHaveBeenCalledWith('', {
					library: {
						libraryView: 'classic',
						schemaVersion: 1,
						snapshot: {
							context: { hierarchy: 'search', query: 'beatles' },
							history: [],
							forward: []
						}
					}
				})
			);
			const { commandFeedbackStore } = await import('$lib/stores/commandFeedbackStore');
			expect(get(commandFeedbackStore)?.message).toMatch(/Abbey Road.*no longer/);
		});

		it('does not rewrite a popped browser entry when its path truncates', async () => {
			pushHistory(
				{ hierarchy: 'search', query: 'beatles' },
				{ title: 'Missing Album', itemType: 'album' }
			);
			apiBrowse.mockResolvedValueOnce(
				listResult({
					level: 0,
					items: [makeItem({ title: 'Different Album', itemKey: 'fresh-different' })]
				})
			);

			render(PreserveClassicHistoryHost);
			await waitFor(() => expect(get(browseHistoryStore).history).toEqual([]));

			expect(replaceStateMock).not.toHaveBeenCalled();
			expect(pushStateMock).not.toHaveBeenCalled();
		});

		it('stops at the deepest matched step when a later breadcrumb fails', async () => {
			pushHistory(
				{ hierarchy: 'search', query: 'beatles' },
				{ title: 'Abbey Road', subtitle: 'The Beatles', itemType: 'album' }
			);
			pushHistory(
				{ hierarchy: 'search', query: 'beatles' },
				{ title: '1. Come Together', itemType: 'track' }
			);

			// Re-seed returns Abbey Road (first breadcrumb matches).
			apiBrowse.mockResolvedValueOnce(
				listResult({
					level: 0,
					items: [
						makeItem({
							title: 'Abbey Road',
							subtitle: 'The Beatles',
							itemKey: 'fresh-a',
							itemType: 'album'
						})
					]
				})
			);
			// Drill into album returns DIFFERENT tracks (second breadcrumb fails).
			apiBrowse.mockResolvedValueOnce(
				listResult({
					level: 1,
					items: [
						makeItem({
							title: '1. Something Else',
							itemKey: 'wrong-track',
							itemType: 'track',
							hint: 'action_list'
						})
					]
				})
			);

			renderClassic({ restoreOnMount: true });
			await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(2));
			await tick();

			// History truncated to just the album (the deepest successful step).
			const persisted = get(browseHistoryStore).history;
			expect(persisted).toHaveLength(1);
			expect(persisted[0].breadcrumb.title).toBe('Abbey Road');
			const { commandFeedbackStore } = await import('$lib/stores/commandFeedbackStore');
			expect(get(commandFeedbackStore)?.message).toMatch(/Come Together.*no longer/);
		});

		it('refuses to choose between duplicate exact breadcrumb matches', async () => {
			pushHistory(
				{ hierarchy: 'search', query: 'beatles' },
				{ title: 'Abbey Road', subtitle: 'The Beatles', itemType: 'album' }
			);

			apiBrowse.mockResolvedValueOnce(
				listResult({
					level: 0,
					items: [
						makeItem({
							title: 'Abbey Road',
							subtitle: 'The Beatles',
							itemType: 'album',
							itemKey: 'duplicate-a'
						}),
						makeItem({
							title: 'Abbey Road',
							subtitle: 'The Beatles',
							itemType: 'album',
							itemKey: 'duplicate-b'
						})
					]
				})
			);

			const { commandFeedbackStore } = await import('$lib/stores/commandFeedbackStore');
			renderClassic({ restoreOnMount: true });
			await waitFor(() => {
				expect(apiBrowse.mock.calls).toHaveLength(1);
				expect(get(commandFeedbackStore)?.message).toMatch(/ambiguous/);
			});

			expect(get(browseHistoryStore).history).toEqual([]);
			expect(apiBrowse.mock.calls.some(([, options]) => options.itemKey)).toBe(false);
		});

		it('matches breadcrumb across singular/plural and case differences in itemType', async () => {
			// Persisted breadcrumb has the singular `'album'` (e.g. from
			// the play-bar resolver storing the expected type, or from a
			// prior session that recorded a different casing). Live
			// search returns the same album with `itemType: 'Albums'`.
			// Match should still succeed.
			pushHistory(
				{ hierarchy: 'search', query: 'abbey road' },
				{ title: 'Abbey Road', subtitle: 'The Beatles', itemType: 'album' }
			);

			apiBrowse.mockResolvedValueOnce(
				listResult({
					level: 0,
					items: [
						makeItem({
							title: 'Abbey Road',
							subtitle: 'The Beatles',
							itemKey: 'fresh-album-key',
							itemType: 'Albums' // ← capitalized plural
						})
					]
				})
			);
			apiBrowse.mockResolvedValueOnce(
				listResult({
					level: 1,
					items: [makeItem({ title: 'Come Together', itemKey: 't1', hint: 'action_list' })]
				})
			);

			renderClassic({ restoreOnMount: true });
			await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(2));

			// Drill used the FRESH itemKey — the normalizer accepted the
			// plural/case variant during the breadcrumb compare.
			expect(apiBrowse.mock.calls[1][1]).toEqual(
				expect.objectContaining({ itemKey: 'fresh-album-key' })
			);
		});
	});
});

describe('Library page — navigation actions', () => {
	it('clicking a list item browses the item key and records history', async () => {
		// Bypass mount restore — page renders these items directly.
		setBrowseResult(
			listResult({
				level: 0,
				items: [makeItem({ title: 'Albums', itemKey: 'albums' })]
			}),
			'browse'
		);

		renderClassic();
		const albums = await screen.findByText('Albums');
		albums.closest('button')?.click();
		await tick();

		expectClassicCommand('browse', 'classic-browse', {
			hierarchy: 'browse',
			itemKey: 'albums'
		});
		expect(get(browseHistoryStore).history.map((s) => s.breadcrumb.title)).toEqual(['Albums']);
	});

	it('clicking a search result re-seeds search and browses the fresh item key', async () => {
		renderClassic();
		await tick();

		setSearchLoading('tori amos');
		setSearchResults([
			makeSearchResult({
				resultType: 'album',
				itemType: 'album',
				title: 'Little Aftershocks',
				subtitle: 'Tilda Arlen',
				itemKey: 'old-search-key'
			})
		]);
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [
					makeItem({
						title: 'Little Aftershocks',
						subtitle: 'Tilda Arlen',
						itemType: 'album',
						itemKey: 'fresh-search-key'
					})
				]
			})
		);
		await tick();

		screen.getByText('Little Aftershocks').closest('button')?.click();

		await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(1));
		expect(apiBrowse.mock.calls[0][1]).toEqual(
			expect.objectContaining({
				hierarchy: 'search',
				input: 'tori amos',
				popAll: true,
			})
		);
		await waitFor(() => {
			expectClassicCommand('browse', 'classic-search', {
				hierarchy: 'search',
				itemKey: 'fresh-search-key'
			});
		});
		expectNoClassicCommand('browse', 'classic-search', { itemKey: 'old-search-key' });
		expect(get(browseHistoryStore).history.map((s) => s.breadcrumb.title)).toEqual([
			'Little Aftershocks'
		]);
		expect(JSON.stringify(get(browseHistoryStore))).not.toContain('fresh-search-key');
	});

	it('clears provisional loading when search-result navigation is superseded', async () => {
		renderClassic();
		await tick();
		setSearchLoading('tori amos');
		setSearchResults([
			makeSearchResult({
				resultType: 'album',
				itemType: 'album',
				title: 'Little Aftershocks',
				subtitle: 'Tilda Arlen',
				itemKey: 'stale-search-key'
			})
		]);
		apiBrowse.mockRejectedValueOnce(new ClassicBrowseSupersededError());
		await tick();

		screen.getByText('Little Aftershocks').closest('button')?.click();
		await waitFor(() => {
			expect(apiBrowse).toHaveBeenCalledTimes(1);
			expect(get(browseStore).loading).toBe(false);
		});

		expectClassicCommand('browse', 'classic-search', {
			hierarchy: 'search',
			input: 'tori amos',
			popAll: true
		});
		expect(classicCommandRecords('browse', 'classic-search')).toHaveLength(1);
		expectNoClassicCommand('browse', 'classic-search', { itemKey: 'stale-search-key' });
		expect(get(browseHistoryStore).history).toEqual([]);
	});

	it('search track quickPlay re-seeds search before action lookup', async () => {
		setSelectedZone('zone-living-room');
		renderClassic();
		await tick();

		setSearchLoading('tori amos');
		setSearchResults([
			makeSearchResult({
				resultType: 'track',
				itemType: 'track',
				title: 'Cornflake Girl',
				subtitle: 'Tilda Arlen',
				itemKey: 'old-track-key',
				hint: 'action_list'
			})
		]);
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [
					makeItem({
						title: 'Cornflake Girl',
						subtitle: 'Tilda Arlen',
						itemType: 'track',
						itemKey: 'fresh-track-key',
						hint: 'action_list'
					})
				]
			})
		);
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 1,
				items: [makeItem({ title: 'Play Now', itemKey: 'play-now-key', hint: 'action', isPlayable: true })]
			})
		);
		apiBrowse.mockResolvedValueOnce(listResult({ level: 1 }));
		await tick();

		screen.getByText('Cornflake Girl').closest('button')?.click();

		await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(3));
		expect(apiBrowse.mock.calls[1][1]).toEqual(
			expect.objectContaining({
				hierarchy: 'search',
				itemKey: 'fresh-track-key',
				zoneId: 'zone-living-room',
			})
		);
		expect(apiBrowse.mock.calls[1][1]).not.toEqual(
			expect.objectContaining({ itemKey: 'old-track-key' })
		);
	});

	it('search track quickPlay pushes a success toast after the play action executes', async () => {
		setSelectedZone('zone-living-room');
		renderClassic();
		await tick();

		setSearchLoading('tori amos');
		setSearchResults([
			makeSearchResult({
				resultType: 'track',
				itemType: 'track',
				title: 'Cornflake Girl',
				subtitle: 'Tilda Arlen',
				itemKey: 'old-track-key',
				hint: 'action_list'
			})
		]);
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [
					makeItem({
						title: 'Cornflake Girl',
						subtitle: 'Tilda Arlen',
						itemType: 'track',
						itemKey: 'fresh-track-key',
						hint: 'action_list'
					})
				]
			})
		);
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 1,
				items: [makeItem({ title: 'Play Now', itemKey: 'play-now-key', hint: 'action', isPlayable: true })]
			})
		);
		apiBrowse.mockResolvedValueOnce(listResult({ level: 1 }));
		await tick();

		screen.getByText('Cornflake Girl').closest('button')?.click();

		await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(3));
		const { commandFeedbackStore } = await import('$lib/stores/commandFeedbackStore');
		await waitFor(() => {
			const toast = get(commandFeedbackStore);
			expect(toast?.kind).toBe('success');
			expect(toast?.message).toMatch(/Playing "Cornflake Girl"/);
		});
	});

	it('navigates non-track action_list search results instead of quick-playing them', async () => {
		renderClassic();
		await tick();

		setSearchLoading('tori amos');
		setSearchResults([
			makeSearchResult({
				resultType: 'album',
				itemType: 'album',
				title: 'Boys for Pele',
				subtitle: 'Tilda Arlen',
				itemKey: 'old-album-key',
				hint: 'action_list'
			})
		]);
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [
					makeItem({
						title: 'Boys for Pele',
						subtitle: 'Tilda Arlen',
						itemType: 'album',
						itemKey: 'fresh-album-key',
						hint: 'action_list'
					})
				]
			})
		);
		await tick();

		screen.getByText('Boys for Pele').closest('button')?.click();

		await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(2));
		await waitFor(() => {
			expectClassicCommand('browse', 'classic-search', {
				hierarchy: 'search',
				itemKey: 'fresh-album-key'
			});
		});
	});

	it('freshens a server-expanded category result by drilling its category stub (live bug 2026-07-09)', async () => {
		// The clicked album came from the server's category expansion —
		// its itemKey belongs to a side session and the album does NOT
		// exist at the fresh top level, only the "Albums — 1 Result"
		// stub does.
		renderClassic();
		await tick();

		setSearchLoading('hamilton');
		setSearchResults([
			makeSearchResult({
				resultType: 'album',
				title: 'Hamilton: An American Musical',
				subtitle: 'Lio-Marcus Mendel',
				itemKey: 'side-session-key',
				hint: 'list'
			})
		]);
		// Freshen pass 1: fresh top level has only the category stub.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [
					makeItem({ title: 'Albums', subtitle: '1 Result', itemKey: 'cat-albums', hint: 'list' })
				]
			})
		);
		// Freshen pass 2: drilling the stub reveals the album with a
		// main-session key.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 1,
				items: [
					makeItem({
						title: 'Hamilton: An American Musical',
						subtitle: 'Lio-Marcus Mendel',
						itemKey: 'fresh-album-key',
						hint: 'list'
					})
				]
			})
		);
		await tick();

		screen.getByText('Hamilton: An American Musical').closest('button')?.click();

		await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(3));
		expect(apiBrowse.mock.calls[1][1]).toEqual(
			expect.objectContaining({
				hierarchy: 'search',
				itemKey: 'cat-albums',
			})
		);
		await waitFor(() => {
			expectClassicCommand('browse', 'classic-search', {
				hierarchy: 'search',
				itemKey: 'fresh-album-key'
			});
		});
		const { commandFeedbackStore } = await import('$lib/stores/commandFeedbackStore');
		expect(get(commandFeedbackStore)?.message ?? '').not.toMatch(/no longer available/);
	});

	it('freshens a radio result through the Stations category stub (rev-6)', async () => {
		renderClassic();
		await tick();

		setSearchLoading('jazz radio');
		setSearchResults([
			makeSearchResult({
				resultType: 'radio',
				title: 'Jazz24',
				subtitle: 'Internet Radio',
				itemKey: 'side-session-radio-key',
				hint: 'list'
			})
		]);
		// Fresh top level: only the Stations stub (server maps its title
		// to resultType 'radio').
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [
					makeItem({ title: 'Stations', subtitle: '2 Results', itemKey: 'cat-stations', hint: 'list' })
				]
			})
		);
		// Drilling the stub reveals the station with a main-session key.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 1,
				items: [
					makeItem({
						title: 'Jazz24',
						subtitle: 'Internet Radio',
						itemKey: 'fresh-radio-key',
						hint: 'list'
					})
				]
			})
		);
		await tick();

		screen.getByText('Jazz24').closest('button')?.click();

		await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(3));
		expect(apiBrowse.mock.calls[1][1]).toEqual(
			expect.objectContaining({ hierarchy: 'search', itemKey: 'cat-stations' })
		);
		await waitFor(() => {
			expectClassicCommand('browse', 'classic-search', {
				hierarchy: 'search',
				itemKey: 'fresh-radio-key'
			});
		});
		const { commandFeedbackStore } = await import('$lib/stores/commandFeedbackStore');
		expect(get(commandFeedbackStore)?.message ?? '').not.toMatch(/no longer available/);
	});

	it('freshening prefers the concrete-field match over a metadata-sparse duplicate (rev-5)', async () => {
		renderClassic();
		await tick();

		setSearchLoading('greatest hits');
		// The user clicked the version WITH the artist subtitle.
		setSearchResults([
			makeSearchResult({
				resultType: 'album',
				title: 'Greatest Hits',
				subtitle: 'Queen',
				itemKey: 'side-session-key',
				hint: 'list'
			})
		]);
		// Fresh top level: a same-title, subtitle-less duplicate comes
		// FIRST; the exact match is second. Wildcard matching alone would
		// pick the first.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [
					makeItem({ title: 'Greatest Hits', itemKey: 'wrong-sparse-key', hint: 'list' }),
					makeItem({
						title: 'Greatest Hits',
						subtitle: 'Queen',
						itemKey: 'right-key',
						hint: 'list'
					})
				]
			})
		);
		await tick();

		screen.getByText('Greatest Hits').closest('button')?.click();

		await waitFor(() => {
			expectClassicCommand('browse', 'classic-search', {
				hierarchy: 'search',
				itemKey: 'right-key'
			});
		});
		expectNoClassicCommand('browse', 'classic-search', { itemKey: 'wrong-sparse-key' });
	});

	it('"See all" on a truncated category navigates into the category stub (rev-4)', async () => {
		renderClassic();
		await tick();

		setSearchLoading('hamilton');
		const grouped = [
			makeSearchResult({
				resultType: 'track',
				title: 'My Shot',
				itemKey: 't1',
				hint: 'action_list',
				categoryTitle: 'Tracks',
				categoryTotal: 80
			})
		];
		setSearchResults(grouped);
		apiBrowseSearch.mockResolvedValueOnce(grouped);
		// Freshen: the fresh top level carries a DECOY content row named
		// like the category (rev-4 reopen) ahead of the real stub — only
		// the "N Results" subtitle shape identifies the stub.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [
					makeItem({ title: 'Tracks', subtitle: 'Some Artist', itemKey: 'decoy-key', hint: 'list' }),
					makeItem({ title: 'Tracks', subtitle: '80 Results', itemKey: 'cat-key', hint: 'list' })
				]
			})
		);
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 1,
				title: 'Tracks',
				items: [makeItem({ title: 'My Shot', itemKey: 'fresh-track-key' })]
			})
		);
		await tick();

		screen.getByRole('button', { name: /See all 80 tracks/i }).click();

		await waitFor(() => expect(get(browseStore).current?.title).toBe('Tracks'));
		expect(apiBrowseSearch).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ input: 'hamilton', popAll: true })
		);
		expect(apiBrowse.mock.calls.some(([, opts]) => opts.itemKey === 'cat-key')).toBe(true);
		expect(apiBrowse.mock.calls.some(([, opts]) => opts.itemKey === 'decoy-key')).toBe(false);
		const { commandFeedbackStore } = await import('$lib/stores/commandFeedbackStore');
		expect(get(commandFeedbackStore)?.message ?? '').not.toMatch(/no longer available/);
		// The recorded breadcrumb must be category-shaped: searchCategory
		// flag set and NO volatile "N Results" subtitle — an exact count
		// in the crumb breaks history restoration when the library count
		// changes between sessions (rev-4 round 3).
		expect(get(browseHistoryStore).history[0]?.breadcrumb).toEqual({
			title: 'Tracks',
			searchCategory: true
		});
	});

	it('disconnected "See all" bails before re-rooting the search session (rev-4 round 3)', async () => {
		renderClassic();
		await tick();

		setSearchLoading('hamilton');
		setSearchResults([
			makeSearchResult({
				resultType: 'track',
				title: 'My Shot',
				itemKey: 't1',
				hint: 'action_list',
				categoryTitle: 'Tracks',
				categoryTotal: 80
			})
		]);
		await tick();

		fakeSocket.connected = false;
		screen.getByRole('button', { name: /See all 80 tracks/i }).click();

		const { commandFeedbackStore } = await import('$lib/stores/commandFeedbackStore');
		await waitFor(() => {
			expect(get(commandFeedbackStore)?.message).toMatch(/Not connected/i);
		});
		// The REST search re-seed must NOT have run: it re-roots the
		// shared Roon search session server-side, which would leave the
		// displayed rows' item keys stale after the bail.
		const navCalls = apiBrowse.mock.calls;
		expect(navCalls).toHaveLength(0);
		expect(apiBrowseSearch).not.toHaveBeenCalled();
		expect(classicCommandRecords('browse', 'classic-search')).toHaveLength(0);
		expect(get(browseHistoryStore).history).toEqual([]);
	});

	it('restores a "See all" category step whose result count changed, skipping same-title decoys (rev-4 round 3)', async () => {
		// The category breadcrumb written by navigateSearchCategory carries
		// no subtitle — restoration must match the stub by SHAPE, so a
		// count that changed between sessions ("80 Results" → "82
		// Results") still restores, while a content row that merely
		// shares the category's title is skipped.
		pushHistory(
			{ hierarchy: 'search', query: 'hamilton' },
			{ title: 'Tracks', searchCategory: true }
		);

		// Re-seed: decoy content row ahead of the real stub, new count.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				title: 'Search',
				items: [
					makeItem({ title: 'Tracks', subtitle: 'Some Artist', itemKey: 'decoy-key', hint: 'list' }),
					makeItem({ title: 'Tracks', subtitle: '82 Results', itemKey: 'fresh-cat-key', hint: 'list' })
				]
			})
		);
		// Drill into the matched stub.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 1,
				items: [makeItem({ title: 'My Shot', itemKey: 'track-1' })]
			})
		);

		renderClassic({ restoreOnMount: true });

		await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(2));
		expect(apiBrowse.mock.calls[1][1]).toEqual(
			expect.objectContaining({
				hierarchy: 'search',
				itemKey: 'fresh-cat-key',
			})
		);
		expect(apiBrowse.mock.calls.some(([, opts]) => opts.itemKey === 'decoy-key')).toBe(false);
		// The restored step remains semantic-only.
		expect(get(browseHistoryStore).history[0]?.breadcrumb).toEqual({
			title: 'Tracks',
			searchCategory: true
		});
		expect(JSON.stringify(get(browseHistoryStore))).not.toContain('fresh-cat-key');
	});

	it('⋮ on a search track opens the actions menu in the SEARCH session and never pops (rev backlog: search track actions)', async () => {
		renderClassic();
		await tick();

		setSearchLoading('hamilton');
		setSearchResults([
			makeSearchResult({
				resultType: 'track',
				title: 'My Shot',
				subtitle: 'Lio-Marcus Mendel',
				itemKey: 'stale-key',
				hint: 'action_list'
			})
		]);
		await tick();

		// Freshen re-seed: the fresh top level carries the track under a
		// new key.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [
					makeItem({
						title: 'My Shot',
						subtitle: 'Lio-Marcus Mendel',
						itemKey: 'fresh-track-key',
						hint: 'action_list'
					})
				]
			})
		);
		// Drilling the fresh key yields the Roon action list.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 1,
				items: [
					makeItem({ title: 'Play Now', itemKey: 'act-play', hint: 'action' }),
					makeItem({ title: 'Add Next', itemKey: 'act-next', hint: 'action' })
				]
			})
		);

		screen.getByRole('button', { name: /More options for My Shot/i }).click();

		// Menu shows Roon's actions plus the favorites extra.
		const menu = await screen.findByRole('dialog', { name: /Track actions/i });
		expect(menu).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Add Next' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Add to Favorites' })).toBeInTheDocument();

		// Both REST calls ran in the shared search session.
		expect(apiBrowse.mock.calls[1][1]).toEqual(
			expect.objectContaining({
				hierarchy: 'search',
				itemKey: 'fresh-track-key',
			})
		);

		setSelectedZone('zone-a');
		apiBrowse.mockResolvedValueOnce(listResult({ level: 2, items: [] })); // action execution
		screen.getByRole('button', { name: 'Add Next' }).click();

		await waitFor(() => {
			expect(apiBrowse.mock.calls[2][1]).toEqual(
				expect.objectContaining({
					hierarchy: 'search',
					itemKey: 'act-next',
				})
			);
		});
		// Search-origin menus never pop: the search session re-seeds
		// with popAll on every interaction, and the browse pane's
		// session was never touched.
		expect(apiBrowsePop).not.toHaveBeenCalled();
		// Menu closed after the action.
		await waitFor(() => {
			expect(screen.queryByRole('dialog', { name: /Track actions/i })).toBeNull();
		});
	});

	it('closing a search-origin ⋮ menu never pops the browse session', async () => {
		renderClassic();
		await tick();

		setSearchLoading('hamilton');
		setSearchResults([
			makeSearchResult({
				resultType: 'track',
				title: 'My Shot',
				subtitle: 'Lio-Marcus Mendel',
				itemKey: 'stale-key',
				hint: 'action_list'
			})
		]);
		await tick();

		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [
					makeItem({
						title: 'My Shot',
						subtitle: 'Lio-Marcus Mendel',
						itemKey: 'fresh-track-key',
						hint: 'action_list'
					})
				]
			})
		);
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 1,
				items: [makeItem({ title: 'Play Now', itemKey: 'act-play', hint: 'action' })]
			})
		);

		screen.getByRole('button', { name: /More options for My Shot/i }).click();
		await screen.findByRole('dialog', { name: /Track actions/i });

		screen.getByRole('button', { name: 'Cancel' }).click();
		await tick();

		expect(screen.queryByRole('dialog', { name: /Track actions/i })).toBeNull();
		expect(apiBrowsePop).not.toHaveBeenCalled();
	});

	it('navigates a track search result that is NOT an action_list (no quickPlay)', async () => {
		// handleSearchResultClick only quick-plays tracks with
		// hint === 'action_list'. A track result with a different
		// hint must drill via navigateSearchResult instead — and
		// because Search renders every result type through ItemGrid
		// (a plain card, no "Play" button), the click affordance
		// doesn't misrepresent the action.
		renderClassic();
		await tick();

		setSearchLoading('tori amos');
		setSearchResults([
			makeSearchResult({
				resultType: 'track',
				itemType: 'track',
				title: 'Winter',
				subtitle: 'Tilda Arlen',
				itemKey: 'old-track-key',
				hint: 'list'
			})
		]);
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [
					makeItem({
						title: 'Winter',
						subtitle: 'Tilda Arlen',
						itemType: 'track',
						itemKey: 'fresh-track-key',
						hint: 'list'
					})
				]
			})
		);
		await tick();

		screen.getByText('Winter').closest('button')?.click();

		// Two browse commands — the search re-seed/freshen and the final
		// navigation. quickPlay would add an action-list lookup.
		await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(2));
		await waitFor(() => {
			expectClassicCommand('browse', 'classic-search', {
				hierarchy: 'search',
				itemKey: 'fresh-track-key'
			});
		});
	});

	it('Home (browseNavStore.home) resets history and renders the welcome view', async () => {
		// Seed prior history so we can confirm it gets cleared.
		pushHistory({ hierarchy: 'browse' }, { title: 'Deep' });
		apiBrowse.mockResolvedValueOnce(
			listResult({ level: 0, items: [makeItem({ title: 'Deep', itemKey: 'fresh-deep' })] })
		); // mount popAll
		apiBrowse.mockResolvedValueOnce(listResult({ level: 1 })); // mount step

		renderClassic({ restoreOnMount: true });
		await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(2));

		// Home no longer pops the Roon browse root (the rail already
		// shows it). Resets history + clears browseStore so the welcome
		// view renders.
		const { browseNavStore } = await import('$lib/stores/browseNavStore');
		const nav = get(browseNavStore);

		const commandCountBefore = classicCommand.mock.calls.length;
		nav.home();
		await tick();

		// History cleared, no Classic command issued, welcome renders.
		expect(get(browseHistoryStore).history).toEqual([]);
		expect(get(browseHistoryStore).forward).toEqual([]);
		expect(classicCommand).toHaveBeenCalledTimes(commandCountBefore);
		expect(screen.getByText(/Pick something from/i)).toBeInTheDocument();
		await waitFor(() => expect(pushStateMock).toHaveBeenCalledTimes(1));
	});

	it('Home at the existing safe root does not create an equivalent shallow entry', async () => {
		renderClassic();
		await tick();
		pushStateMock.mockClear();
		const { browseNavStore } = await import('$lib/stores/browseNavStore');

		get(browseNavStore).home();
		await tick();

		expect(pushStateMock).not.toHaveBeenCalled();
	});

	it('Back (browseNavStore.back) pops the browse role and moves the step to forward', async () => {
		renderClassic();
		await tick();

		// Simulate the user clicking into one item so there's something
		// to back out of.
		pushHistory({ hierarchy: 'browse' }, { title: 'Albums' });

		const { browseNavStore } = await import('$lib/stores/browseNavStore');
		const nav = get(browseNavStore);
		nav.back();
		await tick();

		expectClassicCommand('pop', 'classic-browse', {
			hierarchy: expect.any(String)
		});
		const state = get(browseHistoryStore);
		expect(state.history).toEqual([]);
		expect(state.forward.map((s) => s.breadcrumb.title)).toEqual(['Albums']);
	});

	it('searchLoading hides the result panel and shows the loading text', async () => {
		renderClassic();
		await tick();

		// Direct loading toggle covers what setBrowseLoading does on the
		// browse panel — the Library page's results-panel switches to the
		// "Loading library data..." copy.
		const { setBrowseLoading } = await import('$lib/stores/browseStore');
		setBrowseLoading('browse');
		await tick();

		expect(await screen.findByText(/loading library data/i)).toBeInTheDocument();
	});

	it('disconnected click on a search result preserves prior browse hierarchy and history', async () => {
		// Reproduces R6 finding #1: a search-result click resets
		// history and commits hierarchy='search' before the actual
		// browse emit. If the socket is disconnected when the emit
		// would fire, prior browse history must NOT be cleared and
		// hierarchy must NOT switch — otherwise subsequent clicks
		// send browse-session itemKeys against the search session.

		// Mount first so restoreBrowse runs against empty history
		// (early-return). Then set up "prior browse state" via direct
		// store mutations — avoids racing the mount restore.
		renderClassic();
		await tick();

		pushHistory({ hierarchy: 'browse' }, { title: 'Albums' });
		setBrowseResult(
			listResult({
				level: 1,
				items: [makeItem({ title: 'Some Album', itemKey: 'album-1' })]
			}),
			'browse'
		);

		// Stage a search result + disconnect.
		setSearchLoading('beatles');
		setSearchResults([
			makeSearchResult({
				resultType: 'album',
				itemType: 'album',
				title: 'Abbey Road',
				subtitle: 'The Beatles',
				itemKey: 'fresh-search-key'
			})
		]);
		fakeSocket.connected = false;
		await tick();

		const tile = await screen.findByText('Abbey Road');
		tile.closest('button')?.click();
		// The pre-REST readiness check bails synchronously: the freshen
		// REST call must never run (it re-roots the shared Roon search
		// session server-side while the socket is down, leaving every
		// rendered row's item key stale — rev-4 round-2 hardening,
		// applied to the generic path 2026-07-10).
		const { commandFeedbackStore: feedbackStore } = await import(
			'$lib/stores/commandFeedbackStore'
		);
		await waitFor(() => {
			expect(get(feedbackStore)?.message).toMatch(/Not connected/i);
		});
		const navCalls = apiBrowse.mock.calls;
		expect(navCalls).toHaveLength(0);
		expect(get(browseStore).loading).toBe(false);

		// The readiness check rejected the navigation command.
		expectNoClassicCommand('browse', 'classic-search', {
			itemKey: 'fresh-search-key'
		});

		// Prior browse history preserved — not reset.
		expect(get(browseHistoryStore).history.map((s) => s.breadcrumb.title)).toEqual([
			'Albums'
		]);

		// Hierarchy did NOT switch to 'search'.
		expect(get(browseStore).hierarchy).toBe('browse');

		const { commandFeedbackStore } = await import('$lib/stores/commandFeedbackStore');
		expect(get(commandFeedbackStore)?.message).toMatch(/Not connected/i);
	});

	it('disconnected search-track quickPlay preserves history and issues no fallback', async () => {
		// R8 finding #1: quickPlay's no-play-action fallback runs
		// `if (options.resetSearch) resetHistory()` BEFORE the fallback
		// browse(). With resetSearch=true (search-track click) and a
		// socket that drops between the REST action lookup and the
		// fallback emit, the old code wiped the prior history while
		// browse() bailed on its own readiness check — losing user
		// state for navigation that never happened.

		// Mount, then seed prior browse history + a search result.
		renderClassic();
		await tick();

		pushHistory({ hierarchy: 'browse' }, { title: 'Albums' });
		setSelectedZone('zone-a');
		setSearchLoading('tori amos');
		setSearchResults([
			makeSearchResult({
				resultType: 'track',
				itemType: 'track',
				title: 'Cornflake Girl',
				subtitle: 'Tilda Arlen',
				itemKey: 'stale-track-key',
				hint: 'action_list'
			})
		]);
		// freshenSearchItem REST call → fresh track itemKey.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [
					makeItem({
						title: 'Cornflake Girl',
						subtitle: 'Tilda Arlen',
						itemType: 'track',
						itemKey: 'fresh-track-key',
						hint: 'action_list'
					})
				]
			})
		);
		// Action lookup returns no playable action → fallback path.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 1,
				items: [makeItem({ title: 'Metadata only', itemKey: 'm', hint: 'list', isPlayable: false })]
			})
		);

		fakeSocket.connected = false;
		await tick();

		screen.getByText('Cornflake Girl').closest('button')?.click();

		await tick();
		expect(apiBrowse).not.toHaveBeenCalled();

		// Correlated Classic commands cannot begin without a live socket claim;
		// neither freshening nor the browse-role fallback is attempted.
		expect(classicCommandRecords('browse', 'classic-search')).toHaveLength(0);
		expect(classicCommandRecords('browse', 'classic-browse')).toHaveLength(0);
		// Prior history preserved — resetHistory did NOT run.
		expect(get(browseHistoryStore).history.map((s) => s.breadcrumb.title)).toEqual([
			'Albums'
		]);

		const { commandFeedbackStore } = await import('$lib/stores/commandFeedbackStore');
		expect(get(commandFeedbackStore)?.message).toMatch(/Not connected/i);
	});

	it('clicking a list item while disconnected clears loading and does NOT record history', async () => {
		// Simulate the socket dropping (object exists, .connected = false).
		// emitIfConnected's path: skip emit, push feedback toast, return
		// false. browse() must clear the optimistic loading flag and
		// skip pushHistory so the user doesn't end up with a ghost
		// history entry for navigation that never happened.
		fakeSocket.connected = false;

		setBrowseResult(
			listResult({
				level: 0,
				items: [makeItem({ title: 'Albums', itemKey: 'albums' })]
			}),
			'browse'
		);

		renderClassic();
		const albums = await screen.findByText('Albums');
		albums.closest('button')?.click();
		await tick();

		// The disconnected guard rejected the navigation command.
		expectNoClassicCommand('browse', 'classic-browse', { itemKey: 'albums' });

		// browseStore is no longer in loading state.
		expect(get(browseStore).loading).toBe(false);

		// History was NOT mutated — no ghost entry.
		expect(get(browseHistoryStore).history).toEqual([]);

		// Feedback toast surfaced the disconnect.
		const { commandFeedbackStore } = await import('$lib/stores/commandFeedbackStore');
		expect(get(commandFeedbackStore)?.message).toMatch(/Not connected/i);
	});

	it('disconnected Back with empty history + non-empty forward does NOT pull stale forward into history', async () => {
		// Reproduces R6 finding #2 (now-resolved by the readiness-first
		// pattern in pop()): if Back is somehow triggered while history
		// is empty (defensive — nav store usually disables the button)
		// and forward has a stale entry, the disconnected click must
		// not "rollback" by popping that stale forward into history.
		//
		// Set up: empty history, populated forward stack. We push +
		// pop to land in this state.
		pushHistory({ hierarchy: 'browse' }, { title: 'A' });
		popHistory(); // moves k1 from history → forward
		expect(get(browseHistoryStore).history).toEqual([]);
		expect(get(browseHistoryStore).forward.map((s) => s.breadcrumb.title)).toEqual(['A']);

		fakeSocket.connected = false;
		renderClassic();
		await tick();

		// Drive Back directly via the nav store — simulates the
		// "somehow triggered" path.
		const { browseNavStore } = await import('$lib/stores/browseNavStore');
		const nav = get(browseNavStore);
		nav.back();
		await tick();

		// Connection check rejected the click before any mutation.
		expect(classicCommandRecords('pop', 'classic-browse')).toHaveLength(0);
		// History still empty, forward stack untouched (stale entry
		// did NOT get promoted into history).
		expect(get(browseHistoryStore).history).toEqual([]);
		expect(get(browseHistoryStore).forward.map((s) => s.breadcrumb.title)).toEqual(['A']);
	});

	it('disconnected Forward with non-empty forward stack preserves both stacks and emits nothing', async () => {
		// R7 finding #1: forward() must not move an entry from the
		// forward stack to history if the emit will be rejected. The
		// readiness check has to run BEFORE popForward(), otherwise a
		// disconnected click leaves a ghost history entry pointing at
		// a destination the user never reached.
		//
		// Set up: empty history, populated forward stack (push + pop
		// puts the entry on the forward side).
		pushHistory({ hierarchy: 'browse' }, { title: 'Forward Target' });
		popHistory();
		expect(get(browseHistoryStore).history).toEqual([]);
		expect(get(browseHistoryStore).forward.map((s) => s.breadcrumb.title)).toEqual([
			'Forward Target'
		]);

		fakeSocket.connected = false;
		renderClassic();
		await tick();

		// Drive Forward through the nav store the same way the play
		// bar's Forward button does.
		const { browseNavStore } = await import('$lib/stores/browseNavStore');
		get(browseNavStore).forward();
		await tick();

		// Readiness check rejected the click — no navigation command issued.
		expect(classicCommandRecords('browse', 'classic-browse')).toHaveLength(0);
		// Both stacks unchanged — the forward entry was NOT promoted
		// into history.
		expect(get(browseHistoryStore).history).toEqual([]);
		expect(get(browseHistoryStore).forward.map((s) => s.breadcrumb.title)).toEqual([
			'Forward Target'
		]);
	});

	it('connected Forward re-roots and follows only the freshly resolved key', async () => {
		pushHistory({ hierarchy: 'browse' }, { title: 'Forward Target' });
		popHistory();
		apiBrowse
			.mockResolvedValueOnce(
				listResult({
					level: 0,
					items: [makeItem({ title: 'Forward Target', itemKey: 'fresh-forward-key' })]
				})
			)
			.mockResolvedValueOnce(listResult({ title: 'Forward Target', level: 1 }));
		renderClassic();
		await tick();
		pushStateMock.mockClear();

		const { browseNavStore } = await import('$lib/stores/browseNavStore');
		get(browseNavStore).forward();
		await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(2));

		expect(apiBrowse.mock.calls[0][1]).toEqual(
			expect.objectContaining({ hierarchy: 'browse', popAll: true })
		);
		expect(apiBrowse.mock.calls[0][1]).not.toHaveProperty('itemKey');
		expect(apiBrowse.mock.calls[1][1]).toEqual(
			expect.objectContaining({ hierarchy: 'browse', itemKey: 'fresh-forward-key' })
		);
		expect(get(browseHistoryStore).history).toEqual([
			{ hierarchy: 'browse', breadcrumb: { title: 'Forward Target' } }
		]);
		expect(get(browseHistoryStore).forward).toEqual([]);
		expect(pushStateMock).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(pushStateMock.mock.calls)).not.toMatch(/itemKey|zoneId|multiSessionKey/);
	});
});

describe('Library page — input-prompt items (Library > Search)', () => {
	it('clicking an input-prompt item opens the search panel instead of drilling into it', async () => {
		setSelectedZone('zone-a');
		setBrowseResult(
			listResult({
				title: 'Library',
				level: 1,
				items: [
					makeItem({
						title: 'Search',
						itemKey: 'key-search',
						hint: 'list',
						inputPrompt: 'Search'
					}),
					makeItem({ title: 'Artists', itemKey: 'key-artists', hint: 'list' })
				]
			})
		);

		renderClassic();
		await tick();

		const searchRow = screen.getByRole('button', { name: /^Search$/ });
		searchRow.click();
		await tick();

		// No drill command ran — Roon would answer with an empty
		// "No results" list (the BUGS.md 2026-06-09 complaint).
		expectNoClassicCommand('browse', 'classic-browse', { itemKey: 'key-search' });

		// The search interface (panel with its own input) is open.
		const inputs = screen.getAllByPlaceholderText('Search artists, albums, tracks');
		expect(inputs.length).toBeGreaterThan(0);

		// The browse pane still shows the Library listing untouched.
		expect(get(browseStore).current?.title).toBe('Library');
		expect(get(browseStore).searchOpen).toBe(true);
	});

	it('tags a successful full-search submit as one keyless search-root entry', async () => {
		setBrowseResult(
			listResult({
				title: 'Library',
				level: 1,
				items: [
					makeItem({
						title: 'Search',
						itemKey: 'live-search-prompt',
						hint: 'list',
						inputPrompt: 'Search'
					})
				]
			})
		);
		renderClassic();
		await tick();
		screen.getByRole('button', { name: /^Search$/ }).click();
		await tick();
		pushStateMock.mockClear();

		const input = screen.getByPlaceholderText(
			'Search artists, albums, tracks'
		) as HTMLInputElement;
		input.value = '  Bowie  ';
		input.dispatchEvent(new InputEvent('input', { bubbles: true }));
		await tick();
		(input.closest('.search-row')?.querySelector('button') as HTMLButtonElement).click();
		await waitFor(() => {
			expect(get(browseHistoryStore)).toEqual({
				context: { hierarchy: 'search', query: 'Bowie' },
				history: [],
				forward: []
			});
		});
		await waitFor(() => expect(pushStateMock).toHaveBeenCalledTimes(1));
		expect(pushStateMock).toHaveBeenCalledWith('', {
			library: {
				libraryView: 'classic',
				schemaVersion: 1,
				snapshot: {
					context: { hierarchy: 'search', query: 'Bowie' },
					history: [],
					forward: []
				}
			}
		});
		expect(JSON.stringify(pushStateMock.mock.calls)).not.toMatch(
			/itemKey|zoneId|multiSessionKey/
		);

		pushStateMock.mockClear();
		(input.closest('.search-row')?.querySelector('button') as HTMLButtonElement).click();
		await tick();
		expect(pushStateMock).not.toHaveBeenCalled();
	});
});

describe('Library page — track ⋮ inline action menu', () => {
	function albumPageResult() {
		return listResult({
			title: 'Abbey Road',
			subtitle: 'The Beatles · 1969',
			level: 3,
			items: [
				makeItem({ title: 'Play Album', itemKey: 'pa', hint: 'action_list' }),
				makeItem({ title: '1. Come Together', itemKey: 't1', hint: 'action_list', itemType: 'track' }),
				makeItem({ title: '2. Something', itemKey: 't2', hint: 'action_list', itemType: 'track' })
			]
		});
	}

	function roonActions() {
		return listResult({
			level: 4,
			items: [
				makeItem({ title: 'Play Now', itemKey: 'a-play-now', hint: 'action', isPlayable: true }),
				makeItem({ title: 'Play From Here', itemKey: 'a-pfh', hint: 'action', isPlayable: true }),
				makeItem({ title: 'Add Next', itemKey: 'a-add-next', hint: 'action', isPlayable: true }),
				makeItem({ title: 'Queue', itemKey: 'a-queue', hint: 'action', isPlayable: true }),
				makeItem({ title: 'Start Radio', itemKey: 'a-radio', hint: 'action', isPlayable: true })
			]
		});
	}

	const navCalls = () =>
		apiBrowse.mock.calls;

	it('⋮ opens an inline popup with the Roon actions — no page transition (BUGS.md #3)', async () => {
		setBrowseResult(albumPageResult(), 'browse');
		setSelectedZone('zone-a');
		apiBrowse.mockResolvedValueOnce(roonActions());

		renderClassic();
		const more = await screen.findByRole('button', { name: 'More options for Come Together' });
		more.click();

		// Menu rendered with the Roon actions.
		await screen.findByRole('dialog', { name: 'Track actions' });
		expect(screen.getByRole('button', { name: 'Add Next' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Start Radio' })).toBeInTheDocument();

		// Action list was fetched through the browse role from the track's key…
		expectClassicCommand('browse', 'classic-browse', {
			hierarchy: 'browse',
			itemKey: 't1'
		});
		// …and the visible browse pane never transitioned.
		expect(get(browseStore).current?.title).toBe('Abbey Road');
	});

	it('waits for an in-flight track-menu lookup before resolving a newer Library intent', async () => {
		setBrowseResult(albumPageResult(), 'browse');
		setSelectedZone('zone-a');

		renderClassic();
		const more = await screen.findByRole('button', { name: 'More options for Come Together' });
		apiBrowse.mockReset();
		const menuLookup = deferred<BrowseResult>();
		apiBrowse.mockImplementationOnce(() => menuLookup.promise);

		more.click();
		await waitFor(() => {
			expect(apiBrowse).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ hierarchy: 'browse', itemKey: 't1' })
			);
		});
		classicCommand.mockClear();

		publishLibraryIntent({
			kind: 'general',
			destination: 'search',
			query: 'Replacement destination'
		});

		await waitFor(() => {
			expect(
				screen.getByRole('region', { name: 'Opening Library destination' })
			).toBeInTheDocument();
		});
		expect(classicCommandRecords('search', 'classic-search')).toHaveLength(0);
		expect(screen.queryByRole('dialog', { name: 'Track actions' })).toBeNull();

		menuLookup.resolve(roonActions());
		await waitFor(() => {
			expectClassicCommand('search', 'classic-search', {
				input: 'Replacement destination',
				popAll: true
			});
		});
		await waitFor(() => {
			expect(screen.queryByRole('region', { name: 'Opening Library destination' })).toBeNull();
		});
		expect(get(browseStore).lastSearchQuery).toBe('Replacement destination');
		expect(screen.queryByRole('dialog', { name: 'Track actions' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Add Next' })).toBeNull();
	});

	it('closes a resolved menu for a newer intent and allows a fresh menu request', async () => {
		setBrowseResult(albumPageResult(), 'browse');
		setSelectedZone('zone-a');
		apiBrowse.mockResolvedValueOnce(roonActions());

		renderClassic();
		const firstMore = await screen.findByRole('button', {
			name: 'More options for Come Together'
		});
		firstMore.click();
		await screen.findByRole('dialog', { name: 'Track actions' });

		publishLibraryIntent({
			kind: 'general',
			destination: 'search',
			query: 'Replacement destination'
		});

		await waitFor(() => {
			expect(screen.queryByRole('dialog', { name: 'Track actions' })).toBeNull();
			expectClassicCommand('search', 'classic-search', {
				input: 'Replacement destination'
			});
		});

		setBrowseResult(albumPageResult(), 'browse');
		apiBrowse.mockResolvedValueOnce(roonActions());
		const secondMore = await screen.findByRole('button', {
			name: 'More options for Something'
		});
		secondMore.click();
		await screen.findByRole('dialog', { name: 'Track actions' });
		expectClassicCommand('browse', 'classic-browse', { itemKey: 't2' });
	});

	it('cancels a resolved menu on disconnect and permits a fresh request after reconnect', async () => {
		setBrowseResult(albumPageResult(), 'browse');
		setSelectedZone('zone-a');
		apiBrowse.mockResolvedValueOnce(roonActions());

		renderClassic();
		const firstMore = await screen.findByRole('button', {
			name: 'More options for Come Together'
		});
		firstMore.click();
		await screen.findByRole('dialog', { name: 'Track actions' });

		const disconnect = fakeSocket.on.mock.calls
			.filter(([event]) => event === 'disconnect')
			.at(-1)?.[1] as (() => void) | undefined;
		const connect = fakeSocket.on.mock.calls
			.filter(([event]) => event === 'connect')
			.at(-1)?.[1] as (() => void) | undefined;
		const acquireCount = fakeSocket.emit.mock.calls.filter(
			([event]) => event === 'classic-session:acquire'
		).length;

		fakeSocket.connected = false;
		disconnect?.();
		await waitFor(() => {
			expect(screen.queryByRole('dialog', { name: 'Track actions' })).toBeNull();
		});

		apiBrowse.mockResolvedValueOnce(albumPageResult());
		fakeSocket.connected = true;
		connect?.();
		await waitFor(() => {
			expect(
				fakeSocket.emit.mock.calls.filter(([event]) => event === 'classic-session:acquire')
			).toHaveLength(acquireCount + 1);
			expect(get(browseStore).current?.title).toBe('Abbey Road');
		});

		apiBrowse.mockResolvedValueOnce(roonActions());
		const secondMore = await screen.findByRole('button', {
			name: 'More options for Something'
		});
		secondMore.click();
		await screen.findByRole('dialog', { name: 'Track actions' });
		expectClassicCommand('browse', 'classic-browse', { itemKey: 't2' });
	});

	it('does not let a pre-disconnect menu lookup block a pending reconnect intent', async () => {
		setBrowseResult(albumPageResult(), 'browse');
		setSelectedZone('zone-a');
		renderClassic();

		apiBrowse.mockReset();
		const staleMenuLookup = deferred<BrowseResult>();
		apiBrowse.mockImplementationOnce(() => staleMenuLookup.promise);
		const more = await screen.findByRole('button', { name: 'More options for Come Together' });
		more.click();
		await waitFor(() =>
			expectClassicCommand('browse', 'classic-browse', { itemKey: 't1' })
		);

		const disconnect = fakeSocket.on.mock.calls
			.filter(([event]) => event === 'disconnect')
			.at(-1)?.[1] as (() => void) | undefined;
		const connect = fakeSocket.on.mock.calls
			.filter(([event]) => event === 'connect')
			.at(-1)?.[1] as (() => void) | undefined;
		fakeSocket.connected = false;
		disconnect?.();
		publishLibraryIntent({
			kind: 'general',
			destination: 'search',
			query: 'Recovered destination'
		});

		fakeSocket.connected = true;
		connect?.();
		await waitFor(() =>
			expectClassicCommand('search', 'classic-search', { input: 'Recovered destination' })
		);
		expect(get(pendingLibraryIntentStore)).toBeNull();

		staleMenuLookup.resolve(roonActions());
		await staleMenuLookup.promise;
		await tick();
		expect(screen.queryByRole('dialog', { name: 'Track actions' })).toBeNull();
	});

	it('choosing an action executes it, closes the menu, and restores the stack (pop 2)', async () => {
		setBrowseResult(albumPageResult(), 'browse');
		setSelectedZone('zone-a');
		apiBrowse.mockResolvedValueOnce(roonActions());

		renderClassic();
		const more = await screen.findByRole('button', { name: 'More options for Come Together' });
		more.click();
		const addNext = await screen.findByRole('button', { name: 'Add Next' });
		apiBrowse.mockResolvedValueOnce(listResult({ level: 4 }));
		addNext.click();

		await waitFor(() => {
			expect(apiBrowsePop).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ hierarchy: 'browse', levels: 2 })
			);
		});
		expect(navCalls()[1][1]).toEqual(expect.objectContaining({ itemKey: 'a-add-next' }));
		expect(screen.queryByRole('dialog', { name: 'Track actions' })).toBeNull();
	});

	it('dismissing the menu executes nothing and pops one level', async () => {
		setBrowseResult(albumPageResult(), 'browse');
		setSelectedZone('zone-a');
		apiBrowse.mockResolvedValueOnce(roonActions());

		renderClassic();
		const more = await screen.findByRole('button', { name: 'More options for Come Together' });
		more.click();
		const cancel = await screen.findByRole('button', { name: 'Cancel' });
		cancel.click();

		await waitFor(() => {
			expect(apiBrowsePop).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ hierarchy: 'browse', levels: 1 })
			);
		});
		// Only the action-list lookup ran — nothing was executed.
		expect(navCalls()).toHaveLength(1);
		expect(screen.queryByRole('dialog', { name: 'Track actions' })).toBeNull();
	});
});

describe('Library page — metadata search links (BUGS.md #7)', () => {
	it('track-row subtitle renders each artist and the album as individual search links', async () => {
		setSelectedZone('zone-a');
		setBrowseResult(
			listResult({
				title: 'Tracks',
				level: 2,
				items: [
					makeItem({
						title: 'Wait For It',
						// Multi-artist credit + album, as Roon joins them.
						subtitle: 'Leland Orlov, Jr. / Lio-Marcus Mendel · Hamilton',
						itemKey: 't1',
						hint: 'action_list',
						itemType: 'track'
					})
				]
			}),
			'browse'
		);

		renderClassic();
		await tick();

		// The combined string is NOT one link…
		expect(
			screen.queryByRole('button', {
				name: 'Leland Orlov, Jr. / Lio-Marcus Mendel · Hamilton'
			})
		).toBeNull();

		// …each segment is. Clicking the second artist searches just them.
		screen.getByRole('button', { name: 'Lio-Marcus Mendel' }).click();
		await waitFor(() => expect(get(browseStore).lastSearchQuery).toBe('Lio-Marcus Mendel'));
		expectClassicCommand('search', 'classic-search', { input: 'Lio-Marcus Mendel' });

		// The album segment is independently searchable too.
		setBrowseResult(
			listResult({
				title: 'Tracks',
				level: 2,
				items: [
					makeItem({
						title: 'Wait For It',
						subtitle: 'Leland Orlov, Jr. / Lio-Marcus Mendel · Hamilton',
						itemKey: 't1',
						hint: 'action_list',
						itemType: 'track'
					})
				]
			}),
			'browse'
		);
		await tick();
		screen.getByRole('button', { name: 'Hamilton' }).click();
		await waitFor(() => expect(get(browseStore).lastSearchQuery).toBe('Hamilton'));
		expectClassicCommand('search', 'classic-search', { input: 'Hamilton' });
	});
});

describe('Library page — favorites (BUGS.md #4)', () => {
	const FAVS = [
		{
			id: 'fav-1',
			type: 'track' as const,
			title: 'Hey Jude',
			artist: 'The Beatles',
			added_at: '2026-06-09T00:00:00.000Z'
		},
		{
			id: 'fav-2',
			type: 'artist' as const,
			title: 'Tilda Arlen',
			added_at: '2026-06-09T00:00:00.000Z'
		}
	];

	it('renders the welcome Favorites section from the store', async () => {
		apiFetchFavorites.mockResolvedValue({ entries: FAVS });
		await loadFavorites(fetch);

		renderClassic();
		await tick();

		expect(screen.getByRole('button', { name: /Play favorite 'Hey Jude'/ })).toBeInTheDocument();
		expect(
			screen.getByRole('button', { name: /Search favorite 'Tilda Arlen'/ })
		).toBeInTheDocument();
	});

	it('clicking an artist favorite runs a library search for the name', async () => {
		apiFetchFavorites.mockResolvedValue({ entries: FAVS });
		await loadFavorites(fetch);

		renderClassic();
		await tick();

		screen.getByRole('button', { name: /Search favorite 'Tilda Arlen'/ }).click();
		await waitFor(() => expect(get(browseStore).lastSearchQuery).toBe('Tilda Arlen'));
		expectClassicCommand('search', 'classic-search', { input: 'Tilda Arlen' });
	});

	it('an artist favorite click scrolls the search panel into view (live bug 2026-07-10)', async () => {
		// The favorites section sits far down the welcome view while the
		// search panel renders at the top — without the scroll the click
		// looked like it did nothing.
		const scrollSpy = vi.fn();
		Element.prototype.scrollIntoView = scrollSpy;

		apiFetchFavorites.mockResolvedValue({ entries: FAVS });
		await loadFavorites(fetch);

		renderClassic();
		await tick();

		screen.getByRole('button', { name: /Search favorite 'Tilda Arlen'/ }).click();
		await waitFor(() => expect(scrollSpy).toHaveBeenCalled());
	});

	it('a track favorite click acknowledges immediately, before resolution finishes (live bug 2026-07-10)', async () => {
		apiFetchFavorites.mockResolvedValue({ entries: FAVS });
		await loadFavorites(fetch);
		setSelectedZone('zone-a');

		// Hold the resolver's first Roon call open so we can observe the
		// pre-resolution state: on a real Core this chain takes seconds.
		let releaseSearch!: (v: BrowseResult) => void;
		apiBrowse.mockImplementationOnce(
			() => new Promise<BrowseResult>((resolve) => (releaseSearch = resolve))
		);

		renderClassic();
		await tick();

		screen.getByRole('button', { name: /Play favorite 'Hey Jude'/ }).click();
		const { commandFeedbackStore } = await import('$lib/stores/commandFeedbackStore');
		await waitFor(() => {
			expect(get(commandFeedbackStore)?.message).toMatch(/Finding "Hey Jude"/);
		});

		// Let the held search resolve (empty results → "couldn't find"
		// path) so the test doesn't leak a pending promise.
		releaseSearch(listResult({ level: 0, items: [] }));
	});

	it('suppresses a late favorite failure after suspend and accepts a fresh click after resume', async () => {
		apiFetchFavorites.mockResolvedValue({ entries: FAVS });
		await loadFavorites(fetch);
		setSelectedZone('zone-a');
		const staleSearch = deferred<BrowseResult>();
		apiBrowse.mockImplementationOnce(() => staleSearch.promise);
		const { commandFeedbackStore, clearCommandFeedback } = await import(
			'$lib/stores/commandFeedbackStore'
		);
		clearCommandFeedback();

		const controlled = renderClassicWithLifecycle();
		const firstFavorite = await screen.findByRole('button', {
			name: /Play favorite 'Hey Jude'/
		});
		firstFavorite.click();
		await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(1));

		controlled.suspend();
		clearCommandFeedback();
		staleSearch.reject(new Error('late favorite resolver failure'));
		await staleSearch.promise.catch(() => undefined);
		await tick();
		await Promise.resolve();
		expect(get(commandFeedbackStore)).toBeNull();

		publishLibraryIntent({
			kind: 'general',
			destination: 'welcome-section',
			section: 'favorites'
		});
		controlled.resume();
		const freshFavorite = await screen.findByRole('button', {
			name: /Play favorite 'Hey Jude'/
		});
		await waitFor(() => expect(freshFavorite).not.toBeDisabled());

		const freshSearch = deferred<BrowseResult>();
		apiBrowse.mockImplementationOnce(() => freshSearch.promise);
		freshFavorite.click();
		await waitFor(() => {
			expect(apiBrowse).toHaveBeenCalledTimes(2);
			expect(get(commandFeedbackStore)?.message).toMatch(/Finding "Hey Jude"/);
		});
		freshSearch.resolve(listResult({ level: 0, items: [] }));
		await freshSearch.promise;
		controlled.view.unmount();
	});

	it("plays a track favorite whose stored title kept a multi-disc 'D-T ' prefix (live bug 2026-07-09)", async () => {
		apiFetchFavorites.mockResolvedValue({
			entries: [
				{
					id: 'fav-ham',
					type: 'track' as const,
					title: '1-22 Harlington: Dear Thea',
					artist: 'Leslie Odom Jr.',
					added_at: '2026-06-09T00:00:00.000Z'
				}
			]
		});
		await loadFavorites(fetch);
		setSelectedZone('zone-a');

		// Fresh search returns the track under its bare tagged title.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [
					makeItem({
						title: 'Harlington: Dear Thea',
						subtitle: 'Leslie Odom Jr.',
						itemKey: 'fresh-theodosia',
						itemType: 'track',
						hint: 'action_list'
					})
				]
			})
		);
		// quickPlay action-list lookup → Play Now.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 1,
				items: [makeItem({ title: 'Play Now', itemKey: 'pn', hint: 'action', isPlayable: true })]
			})
		);
		// Execute Play Now.
		apiBrowse.mockResolvedValueOnce(listResult({ level: 1 }));

		renderClassic();
		await tick();

		screen
			.getByRole('button', { name: "Play favorite '1-22 Harlington: Dear Thea'" })
			.click();

		await waitFor(() => {
			const navCalls = apiBrowse.mock.calls;
			expect(navCalls).toHaveLength(3);
		});

		const navCalls = apiBrowse.mock.calls;
		// Search input is the stripped title, not the raw stored one.
		expect(navCalls[0][1]).toEqual(
			expect.objectContaining({ hierarchy: 'search', input: 'Harlington: Dear Thea' })
		);
		expect(navCalls[2][1]).toEqual(expect.objectContaining({ itemKey: 'pn' }));

		const { commandFeedbackStore } = await import('$lib/stores/commandFeedbackStore');
		expect(get(commandFeedbackStore)?.message ?? '').not.toMatch(/Couldn't find/);
	});

	it('remove (×) calls the DELETE endpoint and applies the response', async () => {
		apiFetchFavorites.mockResolvedValue({ entries: FAVS });
		await loadFavorites(fetch);
		apiRemoveFavorite.mockResolvedValue({ entries: [FAVS[1]] });

		renderClassic();
		await tick();

		screen.getByRole('button', { name: /Remove 'Hey Jude' from favorites/ }).click();

		await waitFor(() => {
			expect(apiRemoveFavorite).toHaveBeenCalledWith(expect.anything(), 'fav-1');
		});
		await waitFor(() => {
			expect(get(favoritesStore).entries).toHaveLength(1);
		});
	});

	it('track ⋮ menu offers "Add to Favorites" and posts the favorite with album context', async () => {
		setSelectedZone('zone-a');
		setBrowseResult(
			listResult({
				title: 'Abbey Road',
				subtitle: 'The Beatles · 1969 · FLAC',
				level: 3,
				items: [
					makeItem({ title: 'Play Album', itemKey: 'pa', hint: 'action_list' }),
					makeItem({
						title: '1. Come Together',
						itemKey: 't1',
						hint: 'action_list',
						itemType: 'track'
					})
				]
			}),
			'browse'
		);
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 4,
				items: [makeItem({ title: 'Play Now', itemKey: 'pn', hint: 'action', isPlayable: true })]
			})
		);

		renderClassic();
		const more = await screen.findByRole('button', { name: 'More options for Come Together' });
		more.click();

		const addFav = await screen.findByRole('button', { name: 'Add to Favorites' });
		addFav.click();

		await waitFor(() => {
			expect(apiAddFavorite).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					type: 'track',
					title: 'Come Together',
					album: 'Abbey Road'
				})
			);
		});
		// Menu closed and the session stack restored by one level.
		expect(screen.queryByRole('dialog', { name: 'Track actions' })).toBeNull();
		await waitFor(() => {
			expect(apiBrowsePop).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ levels: 1 })
			);
		});
	});

	it('album page header offers ☆ Album / ☆ Artist favorites', async () => {
		setSelectedZone('zone-a');
		setBrowseResult(
			listResult({
				title: 'Abbey Road',
				subtitle: 'The Beatles · 1969',
				level: 3,
				items: [
					makeItem({ title: 'Play Album', itemKey: 'pa', hint: 'action_list' }),
					makeItem({
						title: '1. Come Together',
						itemKey: 't1',
						hint: 'action_list',
						itemType: 'track'
					})
				]
			}),
			'browse'
		);

		renderClassic();
		await tick();

		const albumBtn = screen.getByRole('button', { name: '☆ Album' });
		albumBtn.click();
		await waitFor(() => {
			expect(apiAddFavorite).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ type: 'album', title: 'Abbey Road', artist: 'The Beatles' })
			);
		});

		// The first add disables both buttons until its round-trip
		// settles; wait for re-enable before the second click.
		await waitFor(() => {
			expect(screen.getByRole('button', { name: '☆ Artist' })).toBeEnabled();
		});
		screen.getByRole('button', { name: '☆ Artist' }).click();
		await waitFor(() => {
			expect(apiAddFavorite).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ type: 'artist', title: 'The Beatles' })
			);
		});
	});
});

describe('Library page — quickPlay', () => {
	function setUpRoot(items: BrowseItem[] = []) {
		// The Library page no longer pops to root on empty-history mount
		// (renders welcome instead). Bypass the mount restore by setting
		// the browse result directly — `apiBrowse` then starts at index
		// [0] for whatever the test's first user action emits.
		setBrowseResult(listResult({ level: 0, items }), 'browse');
	}

	it('looks up the action list, executes the play action, then pops the album view back', async () => {
		const track = makeItem({ title: 'Play Album', itemKey: 'track-key', hint: 'action_list' });
		setUpRoot([track]);
		// Action-list lookup returns Play Now as a playable action.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 1,
				items: [makeItem({ title: 'Play Now', itemKey: 'play-now-key', hint: 'action', isPlayable: true })]
			})
		);
		// Execute call returns nothing meaningful — quickPlay ignores its result.
		apiBrowse.mockResolvedValueOnce(listResult({ level: 1 }));

		setSelectedZone('zone-living-room');
		renderClassic();
		const btn = await screen.findByRole('button', { name: 'Play Album' });
		btn.click();

		// Wait for the action lookup + execute calls.
		await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(2));

		expect(apiBrowse.mock.calls[0][1]).toEqual(
			expect.objectContaining({
				hierarchy: 'browse',
				itemKey: 'track-key',
				zoneId: 'zone-living-room'
			})
		);
		expect(apiBrowse.mock.calls[1][1]).toEqual(
			expect.objectContaining({
				hierarchy: 'browse',
				itemKey: 'play-now-key',
				zoneId: 'zone-living-room'
			})
		);
		// In browse hierarchy, quickPlay restores the album view through the browse role.
		await waitFor(() => {
			expectClassicCommand('pop', 'classic-browse', {
				hierarchy: expect.any(String)
			});
		});
	});

	it('falls back to navigate when no play action is found', async () => {
		const track = makeItem({ title: 'Play Album', itemKey: 'track-key', hint: 'action_list' });
		setUpRoot([track]);
		// Action lookup returns no playable action — only loadable items.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 1,
				items: [makeItem({ title: 'Some metadata', itemKey: 'meta', hint: 'list', isPlayable: false })]
			})
		);

		setSelectedZone('zone-living-room');
		renderClassic();
		const btn = await screen.findByRole('button', { name: 'Play Album' });
		btn.click();

		// The fresh action surface is committed after the role transaction
		// releases, and its semantic breadcrumb is persisted.
		await waitFor(() => {
			expect(get(browseHistoryStore).history.map((s) => s.breadcrumb.title)).toEqual([
				'Play Album'
			]);
		});
		expect(apiBrowse).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ itemKey: 'track-key' })
		);
	});

	it('does not publish a quick-play fallback from a replaced session generation', async () => {
		const track = makeItem({ title: 'Play Album', itemKey: 'track-key', hint: 'action_list' });
		setUpRoot([track]);
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 1,
				items: [
					makeItem({ title: 'Retired metadata', itemKey: 'retired-key', hint: 'list' })
				]
			})
		);
		classicTransactionCompletionHook = async (role) => {
			if (role !== 'classic-browse') return;
			classicTransactionCompletionHook = null;
			await classicBrowseSessionClient.claim('classic-mode').ready;
		};

		setSelectedZone('zone-living-room');
		renderClassic();
		const btn = await screen.findByRole('button', { name: 'Play Album' });
		btn.click();

		await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(get(browseStore).current).toBeNull());
		expect(get(browseHistoryStore).history).toEqual([]);
		expect(screen.queryByText('Retired metadata')).toBeNull();
	});

	it('falls back to action-menu navigation when the album resolver finds no match', async () => {
		const playWork = makeItem({ title: 'Play Work', itemKey: 'play-work-key', hint: 'action_list' });
		const albumRef = makeItem({
			title: 'On Ocean to Ocean by Tilda Arlen',
			subtitle: 'Tilda Arlen',
			itemKey: 'album-ref-key',
			hint: 'action_list'
		});
		// Resolver search returns no album match — fallback path triggers.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [makeItem({ title: 'Unrelated', itemType: 'album', itemKey: 'other' })]
			})
		);

		// Leave zone unselected. If this path accidentally uses quickPlay,
		// it will bail before emitting because quickPlay requires a zone.
		setSelectedZone('');
		renderClassic();
		await waitFor(() => expect(get(classicBrowseSessionClient).phase).toBe('live'));
		setUpRoot([playWork, albumRef]);
		const btn = await screen.findByRole('button', { name: 'On Ocean to Ocean by Tilda Arlen' });
		btn.click();
		await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(2));

		// The first browse command is the resolver search.
		expect(apiBrowse.mock.calls[0][1]).toEqual(
			expect.objectContaining({ hierarchy: 'search', input: 'On Ocean to Ocean' })
		);
		// Resolver missed; the browse role opens the contextual row's action menu.
		expectClassicCommand('browse', 'classic-browse', {
			hierarchy: 'browse',
			itemKey: 'album-ref-key'
		});
		await waitFor(() => {
			expect(get(browseHistoryStore).history.map((s) => s.breadcrumb.title)).toEqual([
				'On Ocean to Ocean by Tilda Arlen'
			]);
		});
	});

	it('does not follow a contextual album key after its session generation is replaced', async () => {
		const albumRef = makeItem({
			title: 'On Ocean to Ocean by Tilda Arlen',
			itemKey: 'album-ref-key',
			hint: 'action_list'
		});
		setUpRoot([albumRef]);
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [makeItem({ title: 'Unrelated', itemType: 'album', itemKey: 'other' })]
			})
		);
		classicTransactionCompletionHook = async (role) => {
			if (role !== 'classic-search') return;
			classicTransactionCompletionHook = null;
			await classicBrowseSessionClient.claim('classic-mode').ready;
		};

		setSelectedZone('zone-a');
		renderClassic();
		const btn = await screen.findByRole('button', { name: 'On Ocean to Ocean by Tilda Arlen' });
		btn.click();

		await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(get(browseStore).current).toBeNull());
		expectNoClassicCommand('browse', 'classic-browse', { itemKey: 'album-ref-key' });
		expect(get(browseHistoryStore).history).toEqual([]);
	});

	it('a superseded "album by artist" resolver clears loading without a fallback', async () => {
		const albumRef = makeItem({
			title: 'On Ocean to Ocean by Tilda Arlen',
			subtitle: 'Tilda Arlen',
			itemKey: 'album-ref-key',
			hint: 'action_list'
		});
		apiBrowse.mockRejectedValueOnce(new ClassicBrowseSupersededError());

		setSelectedZone('zone-a');
		renderClassic();
		await waitFor(() => expect(get(classicBrowseSessionClient).phase).toBe('live'));
		setUpRoot([albumRef]);
		const btn = await screen.findByRole('button', { name: 'On Ocean to Ocean by Tilda Arlen' });
		btn.click();

		// A superseded search must retire its provisional loading surface.
		await waitFor(() => {
			expect(apiBrowse).toHaveBeenCalledTimes(1);
			expect(get(browseStore).loading).toBe(false);
		});

		expectClassicCommand('browse', 'classic-search', {
			hierarchy: 'search',
			input: 'On Ocean to Ocean'
		});
		expect(classicCommandRecords('browse', 'classic-browse')).toHaveLength(0);
		// No ghost history entry from the failed fallback.
		expect(get(browseHistoryStore).history).toEqual([]);
	});

	it('jumps to the resolved album when the search match is a real album result', async () => {
		const albumRef = makeItem({
			title: 'On Ocean to Ocean by Tilda Arlen',
			itemKey: 'stale-context-key',
			hint: 'action_list'
		});
		setUpRoot([albumRef]);
		// Resolver search returns the album under a fresh search itemKey.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [
					makeItem({
						title: 'On Ocean to Ocean',
						subtitle: 'Tilda Arlen',
						itemKey: 'fresh-album-key',
						itemType: 'album'
					})
				]
			})
		);

		setSelectedZone('zone-a');
		renderClassic();
		const btn = await screen.findByRole('button', { name: 'On Ocean to Ocean by Tilda Arlen' });
		btn.click();
		await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(2));

		// Resolver re-seeded the main search session with the album title.
		expect(apiBrowse.mock.calls[0][1]).toEqual(
			expect.objectContaining({
				hierarchy: 'search',
				input: 'On Ocean to Ocean',
			})
		);
		// Navigation goes through search hierarchy with the fresh key.
		expectClassicCommand('browse', 'classic-search', {
			hierarchy: 'search',
			itemKey: 'fresh-album-key'
		});
		// History records the album step with its breadcrumb (so a future
		// remount can re-walk via breadcrumb).
		await waitFor(() => expect(get(browseHistoryStore).history).toHaveLength(1));
		const persisted = get(browseHistoryStore).history;
		expect(persisted).toHaveLength(1);
		expect(persisted[0].breadcrumb).toEqual(
			expect.objectContaining({ title: 'On Ocean to Ocean', subtitle: 'Tilda Arlen', itemType: 'album' })
		);
		expect(JSON.stringify(persisted)).not.toContain('fresh-album-key');
	});

	it('rejects an album match whose subtitle does not contain the parsed artist', async () => {
		// Same album title, different artist — must not be confused.
		const albumRef = makeItem({
			title: 'Greatest Hits by Tilda Arlen',
			itemKey: 'stale',
			hint: 'action_list'
		});
		setUpRoot([albumRef]);
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [
					makeItem({
						title: 'Greatest Hits',
						subtitle: 'Queen',
						itemKey: 'wrong-album',
						itemType: 'album'
					})
				]
			})
		);

		setSelectedZone('zone-a');
		renderClassic();
		const btn = await screen.findByRole('button', { name: 'Greatest Hits by Tilda Arlen' });
		btn.click();
		await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(2));

		// Wrong-artist match was rejected → fallback to the browse role.
		expectClassicCommand('browse', 'classic-browse', {
			hierarchy: 'browse',
			itemKey: 'stale'
		});
	});

	it('skips the resolver entirely for non-parseable titles (no "by")', async () => {
		const row = makeItem({
			title: 'Some Bonus Track',
			itemKey: 'bonus-key',
			hint: 'action_list'
		});
		setUpRoot([row]);

		setSelectedZone('zone-a');
		renderClassic();
		const btn = await screen.findByRole('button', { name: 'Some Bonus Track' });
		btn.click();
		await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(1));

		// Title isn't parseable — the album resolver is skipped and the row
		// is sent directly through the normal browse-role command.
		expect(apiBrowse).toHaveBeenCalledTimes(1);
		expect(apiBrowse.mock.calls[0][1]).toEqual(
			expect.objectContaining({ hierarchy: 'browse', itemKey: 'bonus-key' })
		);
		expectClassicCommand('browse', 'classic-browse', { itemKey: 'bonus-key' });
	});

	it('pushes a feedback toast and skips REST calls when no zone is selected', async () => {
		const track = makeItem({ title: 'Play Album', itemKey: 'track-key', hint: 'action_list' });
		setUpRoot([track]);

		setSelectedZone('');
		renderClassic();
		await tick();

		const btn = await screen.findByRole('button', { name: 'Play Album' });
		btn.click();
		await tick();

		// No apiBrowse calls — quickPlay bails before REST due to no zone.
		expect(apiBrowse).not.toHaveBeenCalled();

		const { commandFeedbackStore } = await import('$lib/stores/commandFeedbackStore');
		expect(get(commandFeedbackStore)?.message).toMatch(/select a zone/i);
	});

	it('does not pop the album view after quickPlay from a search result', async () => {
		setSelectedZone('zone-living-room');
		renderClassic();
		await tick();

		setSearchLoading('beatles');
		setSearchResults([
			makeSearchResult({
				resultType: 'track',
				itemType: 'track',
				title: 'Play Album',
				subtitle: 'The Beatles',
				itemKey: 'old-track-key',
				hint: 'action_list'
			})
		]);
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [
					makeItem({
						title: 'Play Album',
						subtitle: 'The Beatles',
						itemType: 'track',
						itemKey: 'fresh-track-key',
						hint: 'action_list'
					})
				]
			})
		);
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 1,
				items: [makeItem({ title: 'Play Now', itemKey: 'pn', hint: 'action', isPlayable: true })]
			})
		);
		apiBrowse.mockResolvedValueOnce(listResult({ level: 1 }));

		await tick();
		screen.getByText('Play Album').closest('button')?.click();
		await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(3));
		await tick();

		// Search context does not restore the browse stack.
		expect(classicCommandRecords('pop', 'classic-search')).toHaveLength(0);
	});

	it('pushes a feedback toast when the action lookup REST call fails', async () => {
		const track = makeItem({ title: 'Play Album', itemKey: 'track-key', hint: 'action_list' });
		setUpRoot([track]);
		apiBrowse.mockRejectedValueOnce(new Error('Roon timed out'));

		setSelectedZone('zone-living-room');
		renderClassic();
		const btn = await screen.findByRole('button', { name: 'Play Album' });
		btn.click();
		await tick();
		// 

		const { commandFeedbackStore } = await import('$lib/stores/commandFeedbackStore');
		expect(get(commandFeedbackStore)?.message).toMatch(/Roon timed out/);
	});

	it('quick-plays explicit "Play …" rows even when Roon supplies a non-track itemType', async () => {
		// Regression for the C-5 follow-up: shouldQuickPlayActionList must
		// not block on a non-track itemType when the title is an explicit
		// play action. Roon may label `Play Work` with itemType `work` or
		// `action`; either should still trigger the action lookup +
		// Play Now flow, not fall through to navigate().
		const playWork = makeItem({
			title: 'Play Work',
			itemKey: 'work-key',
			hint: 'action_list',
			itemType: 'work'
		});
		setUpRoot([playWork]);
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 1,
				items: [
					makeItem({ title: 'Play Now', itemKey: 'pn', hint: 'action', isPlayable: true })
				]
			})
		);
		apiBrowse.mockResolvedValueOnce(listResult({ level: 1 }));

		setSelectedZone('zone-living-room');
		renderClassic();
		const btn = await screen.findByRole('button', { name: 'Play Work' });
		btn.click();

		// Two calls = action lookup + Play Now execute. A plain navigation
		// command here would expose the regression.
		await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(2));
		expect(apiBrowse.mock.calls[0][1]).toEqual(
			expect.objectContaining({ itemKey: 'work-key' })
		);
		expect(apiBrowse.mock.calls[1][1]).toEqual(
			expect.objectContaining({ itemKey: 'pn' })
		);
	});
});

describe('Library page — alphabetic jump bar', () => {
	function makeBrowseList(letters: string[]): BrowseItem[] {
		return letters.map((letter, i) =>
			makeItem({ title: `${letter}-Title-${i}`, itemKey: `k${i}`, hint: 'list' })
		);
	}

	beforeEach(() => {
		// jsdom doesn't implement scrollIntoView; stub it on the prototype
		// so the jump-bar handler doesn't throw.
		(Element.prototype as any).scrollIntoView = vi.fn();
	});

	it('renders a jump bar with one button per unique first letter (above 20-item threshold)', async () => {
		// 21 items spanning A-D so jumpLetters fires (threshold is >20)
		// and there are multiple distinct letters to verify.
		const items: BrowseItem[] = [];
		for (let i = 0; i < 6; i++) items.push(makeItem({ title: `A item ${i}`, itemKey: `a${i}` }));
		for (let i = 0; i < 6; i++) items.push(makeItem({ title: `B item ${i}`, itemKey: `b${i}` }));
		for (let i = 0; i < 6; i++) items.push(makeItem({ title: `C item ${i}`, itemKey: `c${i}` }));
		for (let i = 0; i < 3; i++) items.push(makeItem({ title: `D item ${i}`, itemKey: `d${i}` }));
		// Force level >= 2 so isContentList renders the grid path.
		setBrowseResult(listResult({ level: 2, items }), 'browse');

		renderClassic();
		await tick();

		const jumpBar = await screen.findByLabelText(/alphabetic index/i);
		const letterButtons = jumpBar.querySelectorAll('button.jump-letter');
		const labels = Array.from(letterButtons).map((b) => b.textContent?.trim());
		expect(labels).toEqual(['A', 'B', 'C', 'D']);
	});

	it('does not render a jump bar for short lists (≤20 items)', async () => {
		const items = Array.from({ length: 10 }, (_, i) =>
			makeItem({ title: `Item ${i}`, itemKey: `k${i}` })
		);
		setBrowseResult(listResult({ level: 2, items }), 'browse');

		renderClassic();
		await tick();

		expect(screen.queryByLabelText(/alphabetic index/i)).toBeNull();
	});

	it('clicking a letter scrolls to the section anchor when it is loaded', async () => {
		const items: BrowseItem[] = [];
		for (let i = 0; i < 6; i++) items.push(makeItem({ title: `A${i}`, itemKey: `a${i}` }));
		for (let i = 0; i < 6; i++) items.push(makeItem({ title: `B${i}`, itemKey: `b${i}` }));
		for (let i = 0; i < 9; i++) items.push(makeItem({ title: `C${i}`, itemKey: `c${i}` }));
		setBrowseResult(listResult({ level: 2, items }), 'browse');

		renderClassic();
		await tick();

		const bButton = screen.getAllByRole('button').find((b) => b.textContent?.trim() === 'B');
		expect(bButton).toBeDefined();

		const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView');
		bButton!.click();
		// The handler is async — wait a microtask for the scroll call.
		await tick();
		await Promise.resolve();
		expect(scrollSpy).toHaveBeenCalled();
	});

	it('derives jump letters from the sort key — leading "The " is skipped (BUGS.md #8)', async () => {
		// Roon sorts "The Beatles" under B; the jump letter must match.
		const items: BrowseItem[] = [];
		for (let i = 0; i < 7; i++) items.push(makeItem({ title: `Aerosmith ${i}`, itemKey: `a${i}` }));
		for (let i = 0; i < 7; i++) items.push(makeItem({ title: `The Beatles ${i}`, itemKey: `b${i}` }));
		for (let i = 0; i < 7; i++) items.push(makeItem({ title: `The Cure ${i}`, itemKey: `c${i}` }));
		setBrowseResult(listResult({ level: 2, items }), 'browse');

		renderClassic();
		await tick();

		const jumpBar = await screen.findByLabelText(/alphabetic index/i);
		const labels = Array.from(jumpBar.querySelectorAll('button.jump-letter')).map((b) =>
			b.textContent?.trim()
		);
		expect(labels).toEqual(['A', 'B', 'C']);
	});

	it('partially loaded list shows the full A–Z jump bar (BUGS.md #9)', async () => {
		// Only "A" artists are loaded (first batch of a big library),
		// but the jump list must span the whole library.
		const items = Array.from({ length: 21 }, (_, i) =>
			makeItem({ title: `A item ${i}`, itemKey: `a${i}` })
		);
		setBrowseResult(listResult({ level: 2, items, totalCount: 500, count: 500 }), 'browse');

		renderClassic();
		await tick();

		const jumpBar = await screen.findByLabelText(/alphabetic index/i);
		const labels = Array.from(jumpBar.querySelectorAll('button.jump-letter')).map((b) =>
			b.textContent?.trim()
		);
		expect(labels).toEqual([...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '#']);
	});

	it('clicking an unloaded letter loads the rest, then scrolls to it', async () => {
		const items = Array.from({ length: 21 }, (_, i) =>
			makeItem({ title: `A item ${i}`, itemKey: `a${i}` })
		);
		setBrowseResult(listResult({ level: 2, items, totalCount: 23, count: 23 }), 'browse');
		apiBrowseLoad.mockResolvedValueOnce(
			listResult({
				level: 2,
				items: [
					makeItem({ title: 'Zebra', itemKey: 'z1' }),
					makeItem({ title: 'Zoo', itemKey: 'z2' })
				]
			})
		);

		renderClassic();
		await tick();

		const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView');
		const jumpBar = await screen.findByLabelText(/alphabetic index/i);
		const zButton = Array.from(jumpBar.querySelectorAll('button.jump-letter')).find(
			(b) => b.textContent?.trim() === 'Z'
		) as HTMLButtonElement;
		expect(zButton).toBeDefined();
		zButton.click();

		await waitFor(() => expect(apiBrowseLoad).toHaveBeenCalled());
		await waitFor(() => expect(scrollSpy).toHaveBeenCalled());
	});

	it('infinite scroll: reaching the list end auto-loads the next page (BUGS.md #10)', async () => {
		const observed: { cb: IntersectionObserverCallback | null } = { cb: null };
		class FakeIO {
			constructor(cb: IntersectionObserverCallback) {
				observed.cb = cb;
			}
			observe() {}
			unobserve() {}
			disconnect() {}
		}
		vi.stubGlobal('IntersectionObserver', FakeIO);
		try {
			const items = Array.from({ length: 21 }, (_, i) =>
				makeItem({ title: `Item ${i}`, itemKey: `k${i}` })
			);
			setBrowseResult(listResult({ level: 2, items, totalCount: 100, count: 100 }), 'browse');
			apiBrowseLoad.mockResolvedValueOnce(
				listResult({
					level: 2,
					items: Array.from({ length: 79 }, (_, i) =>
						makeItem({ title: `Extra ${i}`, itemKey: `x${i}` })
					)
				})
			);

			renderClassic();
			await tick();
			expect(observed.cb).not.toBeNull();

			// Simulate the sentinel entering the viewport.
			observed.cb!(
				[{ isIntersecting: true } as IntersectionObserverEntry],
				null as unknown as IntersectionObserver
			);

			await waitFor(() => expect(apiBrowseLoad).toHaveBeenCalled());
			expect(apiBrowseLoad.mock.calls[0][1]).toEqual(
				expect.objectContaining({ offset: 21 })
			);
			expect(await screen.findByText('Extra 78')).toBeInTheDocument();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('owns Classic socket listeners, lazy-load observers, and sessions across 20 lifecycle cycles', async () => {
		type SocketHandler = (...values: unknown[]) => void;
		const listeners = new Map<string, Set<SocketHandler>>();
		const listenersFor = (event: string): Set<SocketHandler> => {
			const existing = listeners.get(event);
			if (existing) return existing;
			const created = new Set<SocketHandler>();
			listeners.set(event, created);
			return created;
		};
		fakeSocket.on.mockImplementation((event: string, handler: SocketHandler) => {
			listenersFor(event).add(handler);
			return fakeSocket;
		});
		fakeSocket.off.mockImplementation((event: string, handler: SocketHandler) => {
			listenersFor(event).delete(handler);
			return fakeSocket;
		});

		let activeObservers = 0;
		const observerCallbacks: IntersectionObserverCallback[] = [];
		class TrackingIntersectionObserver {
			private active = false;

			constructor(callback: IntersectionObserverCallback) {
				observerCallbacks.push(callback);
			}

			observe(): void {
				if (this.active) return;
				this.active = true;
				activeObservers += 1;
			}

			unobserve(): void {}

			disconnect(): void {
				if (!this.active) return;
				this.active = false;
				activeObservers -= 1;
			}
		}
		vi.stubGlobal('IntersectionObserver', TrackingIntersectionObserver);

		const partialResult = () =>
			listResult({
				level: 2,
				items: Array.from({ length: 21 }, (_, index) =>
					makeItem({ title: `Cycle item ${index}`, itemKey: `cycle-${index}` })
				),
				totalCount: 100,
				count: 100
			});
		setBrowseResult(partialResult(), 'browse');
		const controlled = renderClassicWithLifecycle();
		let unmounted = false;

		try {
			await waitFor(() => expect(get(classicBrowseSessionClient).phase).toBe('live'));
			await tick();
			expect(listenersFor('connect').size).toBe(1);
			expect(listenersFor('disconnect').size).toBe(1);
			expect(activeObservers).toBe(1);

			for (let cycle = 0; cycle < 20; cycle += 1) {
				controlled.suspend();
				expect(listenersFor('connect').size).toBe(0);
				expect(listenersFor('disconnect').size).toBe(0);
				expect(activeObservers).toBe(0);
				expect(get(classicBrowseSessionClient)).toMatchObject({
					phase: 'none',
					session: null,
					owner: 'inactive'
				});

				apiBrowseLoad.mockClear();
				observerCallbacks.at(-1)?.(
					[{ isIntersecting: true } as IntersectionObserverEntry],
					null as unknown as IntersectionObserver
				);
				await tick();
				expect(apiBrowseLoad).not.toHaveBeenCalled();

				controlled.resume();
				await waitFor(() => expect(get(classicBrowseSessionClient).phase).toBe('live'));
				setBrowseResult(partialResult(), 'browse');
				await tick();
				expect(listenersFor('connect').size).toBe(1);
				expect(listenersFor('disconnect').size).toBe(1);
				expect(activeObservers).toBe(1);
				expect(document.querySelectorAll('.library-shell')).toHaveLength(1);
			}

			controlled.view.unmount();
			unmounted = true;
			expect(listenersFor('connect').size).toBe(0);
			expect(listenersFor('disconnect').size).toBe(0);
			expect(activeObservers).toBe(0);
			expect(get(classicBrowseSessionClient)).toMatchObject({
				phase: 'none',
				session: null,
				owner: 'inactive'
			});
			expect(
				fakeSocket.emit.mock.calls.filter(([event]) => event === 'classic-session:acquire')
			).toHaveLength(21);
			expect(
				fakeSocket.emit.mock.calls.filter(([event]) => event === 'classic-session:release')
			).toHaveLength(21);
		} finally {
			if (!unmounted) controlled.view.unmount();
			vi.unstubAllGlobals();
		}
	});

	it('renders a Load more bar when loaded items < totalCount', async () => {
		const items = Array.from({ length: 21 }, (_, i) =>
			makeItem({ title: `Item ${i}`, itemKey: `k${i}` })
		);
		setBrowseResult(
			listResult({ level: 2, items, totalCount: 30, count: 30 }),
			'browse'
		);

		renderClassic();
		await tick();

		expect(await screen.findByText(/showing 21 of 30/i)).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /load more/i })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /load all/i })).toBeInTheDocument();
	});

	it('"Load more" calls apiBrowseLoad with the right offset/count and appends items', async () => {
		const initial = Array.from({ length: 21 }, (_, i) =>
			makeItem({ title: `Item ${i}`, itemKey: `k${i}` })
		);
		setBrowseResult(
			listResult({ level: 2, items: initial, totalCount: 100, count: 100 }),
			'browse'
		);
		const more = Array.from({ length: 79 }, (_, i) =>
			makeItem({ title: `Extra ${i}`, itemKey: `extra${i}` })
		);
		apiBrowseLoad.mockResolvedValueOnce(listResult({ level: 2, items: more.slice(0, 79) }));

		renderClassic();
		await tick();

		screen.getByRole('button', { name: /^load more$/i }).click();
		await waitFor(() => expect(apiBrowseLoad).toHaveBeenCalled());

		expect(apiBrowseLoad.mock.calls[0][1]).toEqual(
			expect.objectContaining({
				hierarchy: 'browse',
				offset: 21,
				// "Load more" caps each batch at 100; remaining (79) is smaller, so count = 79.
				count: 79
			})
		);

		// Verify the appended items actually reach the DOM. Without this
		// assertion, a regression that removed the `appendBrowseItems(...)`
		// call after the fetch would still pass the args check above.
		expect(await screen.findByText('Extra 78')).toBeInTheDocument();
		// And the "Showing X of Y" footer should disappear once everything
		// is loaded (21 + 79 = 100, matches totalCount).
		await waitFor(() => {
			expect(screen.queryByText(/showing \d+ of \d+/i)).toBeNull();
		});
	});
});

describe('Library page — restore robustness', () => {
	it('records but does not crash when a replay step fails', async () => {
		pushHistory({ hierarchy: 'browse' }, { title: 'Good' });
		pushHistory({ hierarchy: 'browse' }, { title: 'Stale' });

		apiBrowse.mockResolvedValueOnce(
			listResult({ level: 0, items: [makeItem({ title: 'Good', itemKey: 'fresh-good' })] })
		); // popAll
		apiBrowse.mockResolvedValueOnce(
			listResult({ level: 1, items: [makeItem({ title: 'Stale', itemKey: 'fresh-stale' })] })
		); // good step
		apiBrowse.mockRejectedValueOnce(new Error('item_key not found')); // stale step

		renderClassic({ restoreOnMount: true });
		await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(3));

		// The page should not be in an error-banner state — it just stops
		// at the deepest successful step. The browseStore should hold the
		// last successful result (level 1), not the failed one.
		await tick();
		const current = get(browseStore).current;
		expect(current?.level).toBe(1);
	});

	it('walks browse-rooted history via breadcrumb when persisted itemKeys are stale (Roon Core restart)', async () => {
		// Persisted itemKeys minted before the Core restart are now
		// stale — drilling them returns "[BrowseService] browse failed".
		// Breadcrumb-walk path finds the same items by title against
		// the freshly-loaded results at each level.
		pushHistory({ hierarchy: 'browse' }, { title: 'Library' });
		pushHistory({ hierarchy: 'browse' }, { title: 'Albums' });

		// popAll returns fresh root.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [makeItem({ title: 'Library', itemKey: 'fresh-library' })]
			})
		);
		// Fresh-library drill returns Library children incl. Albums.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 1,
				items: [makeItem({ title: 'Albums', itemKey: 'fresh-albums' })]
			})
		);
		// Fresh-albums drill returns the album grid.
		apiBrowse.mockResolvedValueOnce(
			listResult({ level: 2, items: [makeItem({ title: 'Some Album' })] })
		);

		renderClassic({ restoreOnMount: true });
		await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(3));
		await tick();

		// Walk used FRESH keys, never stale ones.
		expect(apiBrowse.mock.calls[1][1]).toEqual(
			expect.objectContaining({ itemKey: 'fresh-library' })
		);
		expect(apiBrowse.mock.calls[2][1]).toEqual(
			expect.objectContaining({ itemKey: 'fresh-albums' })
		);
		expect(
			apiBrowse.mock.calls.some(
				([, opts]) =>
					opts.itemKey === 'stale-library' || opts.itemKey === 'stale-albums'
			)
		).toBe(false);

		// Persisted history remains semantic and never receives fresh keys.
		const persisted = get(browseHistoryStore).history;
		expect(persisted.map((s) => s.breadcrumb.title)).toEqual(['Library', 'Albums']);
		expect(JSON.stringify(persisted)).not.toContain('fresh-library');
	});

	it('truncates to the fresh browse root when the first semantic step is absent', async () => {
		pushHistory({ hierarchy: 'browse' }, { title: 'Missing' });

		apiBrowse.mockResolvedValueOnce(listResult({ level: 0, title: 'Fresh root' }));

		renderClassic({ restoreOnMount: true });
		await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(1));
		await tick();

		expect(get(browseHistoryStore).history).toEqual([]);
		expect(get(browseStore).current?.title).toBe('Fresh root');
		expect(apiBrowse.mock.calls.some(([, opts]) => opts.itemKey)).toBe(false);
	});
});

describe('Library page — track-list classification', () => {
	function setUpRoot(items: BrowseItem[]) {
		// Bypass the mount restore (which now renders welcome on empty
		// history) and inject the test result directly.
		setBrowseResult(listResult({ level: 2, items }), 'browse');
	}

	it('renders itemType=track items as a track list even without numeric prefixes', async () => {
		// Classical movements with no leading digit. Pre-itemType code
		// classified these as page actions because the regex saw no digit.
		const items = [
			makeItem({
				title: 'Allegro',
				itemKey: 't1',
				hint: 'action_list',
				itemType: 'track'
			}),
			makeItem({
				title: 'Andante',
				itemKey: 't2',
				hint: 'action_list',
				itemType: 'track'
			}),
			makeItem({
				title: 'Play Album',
				itemKey: 'pa',
				hint: 'action_list'
			})
		];
		setUpRoot(items);

		renderClassic();
		await tick();
		// 

		// Tracks rendered in an <ol class="track-list">
		const trackList = document.querySelector('ol.track-list');
		expect(trackList).not.toBeNull();
		expect(trackList!.querySelectorAll('li.track-row')).toHaveLength(2);

		// "Play Album" rendered as a page action pill, not a track.
		expect(screen.getByRole('button', { name: 'Play Album' })).toBeTruthy();
		expect(screen.queryByText('Allegro')).toBeTruthy();
	});

	it('falls back to leading-digit regex when items omit itemType', async () => {
		// Legacy fixture: action_list rows whose only signal of "track-ness"
		// is a numbered title. The fallback path must still render them in
		// the track list.
		const items = [
			makeItem({ title: '1. First Song', itemKey: 't1', hint: 'action_list' }),
			makeItem({ title: '2. Second Song', itemKey: 't2', hint: 'action_list' }),
			makeItem({ title: 'Play Album', itemKey: 'pa', hint: 'action_list' })
		];
		setUpRoot(items);

		renderClassic();
		await tick();
		// 

		const trackList = document.querySelector('ol.track-list');
		expect(trackList).not.toBeNull();
		expect(trackList!.querySelectorAll('li.track-row')).toHaveLength(2);
		expect(screen.getByRole('button', { name: 'Play Album' })).toBeTruthy();
	});

	it('does NOT treat a Work page (action_list-only, no tracks) as a track list', async () => {
		// Live regression: Composers → Tilda Arlen → 29 Years returns a Work
		// page where every item is action_list but none is a real track.
		// The contextual nav row "On Ocean to Ocean by Tilda Arlen" must not
		// be force-numbered into a track row.
		const items = [
			makeItem({
				title: 'Play Work',
				itemKey: 'pw',
				hint: 'action_list'
			}),
			makeItem({
				title: 'On Ocean to Ocean by Tilda Arlen',
				itemKey: 'al',
				hint: 'action_list'
			})
		];
		setUpRoot(items);

		renderClassic();
		await tick();
		// 

		// No track list rendered; both items are page actions.
		expect(document.querySelector('ol.track-list')).toBeNull();
		expect(screen.getByRole('button', { name: 'Play Work' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'On Ocean to Ocean by Tilda Arlen' })).toBeTruthy();
	});

	it('classifies itemType case-insensitively (Track / TRACKS still render as tracks)', async () => {
		// Defensive: BrowseService passes Roon's `item_type` through raw,
		// and `inferSearchType` already lowercases for comparison. Mirror
		// that style so a non-canonical casing doesn't silently demote a
		// track row into a pill button.
		const items = [
			makeItem({
				title: 'First Movement',
				itemKey: 't1',
				hint: 'action_list',
				itemType: 'Track'
			}),
			makeItem({
				title: 'Second Movement',
				itemKey: 't2',
				hint: 'action_list',
				itemType: 'TRACKS'
			})
		];
		setUpRoot(items);

		renderClassic();
		await tick();
		// 

		const trackList = document.querySelector('ol.track-list');
		expect(trackList).not.toBeNull();
		expect(trackList!.querySelectorAll('li.track-row')).toHaveLength(2);
	});

	it('infers a track list from a large pure-action_list page even when items have no itemType and no leading digit', async () => {
		// Live shape from Library/Tracks and playlist contents: 100s of
		// action_list rows with no itemType and non-numeric titles. Prior
		// classifier left every row in pageActions with an empty <ol>;
		// inferred-mode now puts every row in trackItems.
		const items: BrowseItem[] = [
			'Bohemian Rhapsody',
			'Something',
			'Hey Jude',
			'Imagine',
			'Yesterday',
			'Let It Be',
			'Come Together'
		].map((title, i) =>
			makeItem({
				title,
				itemKey: `t${i}`,
				hint: 'action_list',
				subtitle: 'Some Artist'
			})
		);
		setUpRoot(items);

		renderClassic();
		await tick();

		// Track list rendered with all 7 rows, no page-action pills.
		const trackList = document.querySelector('ol.track-list');
		expect(trackList).not.toBeNull();
		expect(trackList!.querySelectorAll('li.track-row')).toHaveLength(7);
		expect(document.querySelector('.page-actions')).toBeNull();
	});

	it('itemType wins over leading-digit regex (numbered title with non-track itemType is a page action)', async () => {
		// Hypothetical: a page action with a numbered label like "1 hour
		// continuous mix" that Roon flags as a non-track item. Pre-refactor
		// the regex would have promoted it into the track list.
		const items = [
			makeItem({
				title: '1. Track One',
				itemKey: 't1',
				hint: 'action_list',
				itemType: 'track'
			}),
			makeItem({
				title: '1 Hour Continuous Mix',
				itemKey: 'mix',
				hint: 'action_list',
				itemType: 'action'
			})
		];
		setUpRoot(items);

		renderClassic();
		await tick();
		// 

		const trackList = document.querySelector('ol.track-list');
		expect(trackList).not.toBeNull();
		expect(trackList!.querySelectorAll('li.track-row')).toHaveLength(1);
		// The non-track itemType row is a page action, not a track row.
		expect(screen.getByRole('button', { name: '1 Hour Continuous Mix' })).toBeTruthy();
	});
});

describe('Library page — Recently Played tile click', () => {
	const RECENT = {
		title: 'Hey Jude',
		artist: 'The Beatles',
		album: '1',
		duration: 431,
		image_key: 'img-x',
		zone_id: 'zone-a',
		zone_name: 'Living Room',
		played_at: '2026-05-08T00:00:00.000Z'
	};

	beforeEach(async () => {
		const { resetRecentlyPlayed, applyRecentlyPlayedInserted } = await import(
			'$lib/stores/recentlyPlayedStore'
		);
		resetRecentlyPlayed();
		applyRecentlyPlayedInserted({ entry: RECENT, revision: 1, epoch: 1 });
	});

	it('shows a feedback toast and skips REST when no zone is selected', async () => {
		setSelectedZone('');
		renderClassic();
		await tick();

		const tile = await screen.findByRole('button', {
			name: /Play 'Hey Jude'/i
		});
		tile.click();
		await tick();

		// Filter out the welcome-stats fetches; the click path should
		// not have triggered any nav-related apiBrowse calls.
		const navCalls = apiBrowse.mock.calls;
		expect(navCalls).toHaveLength(0);

		const { commandFeedbackStore } = await import('$lib/stores/commandFeedbackStore');
		expect(get(commandFeedbackStore)?.message).toMatch(/select a zone/i);
	});

	it('suppresses a late play failure after suspend and accepts a fresh click after resume', async () => {
		setSelectedZone('zone-a');
		const staleSearch = deferred<BrowseResult>();
		apiBrowse.mockImplementationOnce(() => staleSearch.promise);
		const { commandFeedbackStore, clearCommandFeedback } = await import(
			'$lib/stores/commandFeedbackStore'
		);
		clearCommandFeedback();

		const controlled = renderClassicWithLifecycle();
		const firstTile = await screen.findByRole('button', { name: /Play 'Hey Jude'/i });
		firstTile.click();
		await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(1));

		controlled.suspend();
		clearCommandFeedback();
		staleSearch.reject(new Error('late resolver failure'));
		await staleSearch.promise.catch(() => undefined);
		await tick();
		await Promise.resolve();
		expect(get(commandFeedbackStore)).toBeNull();

		publishLibraryIntent({
			kind: 'general',
			destination: 'welcome-section',
			section: 'recently-played'
		});
		controlled.resume();
		const freshTile = await screen.findByRole('button', { name: /Play 'Hey Jude'/i });
		await waitFor(() => expect(freshTile).not.toBeDisabled());

		const freshSearch = deferred<BrowseResult>();
		apiBrowse.mockImplementationOnce(() => freshSearch.promise);
		freshTile.click();
		await waitFor(() => {
			expect(apiBrowse).toHaveBeenCalledTimes(2);
			expect(get(commandFeedbackStore)?.message).toMatch(/Finding "Hey Jude"/);
		});
		freshSearch.resolve(listResult({ level: 0, items: [] }));
		await freshSearch.promise;
		controlled.view.unmount();
	});

	it('searches for the title, matches by track + artist, and runs quickPlay', async () => {
		setSelectedZone('zone-a');

		// Search returns the track under a fresh search itemKey.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [
					makeItem({
						title: 'Hey Jude',
						subtitle: 'The Beatles',
						itemKey: 'fresh-track-key',
						itemType: 'track',
						hint: 'action_list'
					})
				]
			})
		);
		// quickPlay action-list lookup → finds Play Now.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 1,
				items: [
					makeItem({ title: 'Play Now', itemKey: 'pn', hint: 'action', isPlayable: true })
				]
			})
		);
		// Execute Play Now.
		apiBrowse.mockResolvedValueOnce(listResult({ level: 1 }));

		renderClassic();
		await tick();

		const tile = await screen.findByRole('button', { name: /Play 'Hey Jude'/i });
		tile.click();

		await waitFor(() => {
			const navCalls = apiBrowse.mock.calls;
			expect(navCalls).toHaveLength(3);
		});

		const navCalls = apiBrowse.mock.calls;
		// First nav call: search the title in main search session.
		expect(navCalls[0][1]).toEqual(
			expect.objectContaining({
				hierarchy: 'search',
				input: 'Hey Jude',
			})
		);
		// Second: drill the matched fresh itemKey for its action list.
		expect(navCalls[1][1]).toEqual(
			expect.objectContaining({ hierarchy: 'search', itemKey: 'fresh-track-key' })
		);
		// Third: execute Play Now.
		expect(navCalls[2][1]).toEqual(
			expect.objectContaining({ itemKey: 'pn' })
		);
	});

	it("strict artist match folds U+2010 hyphens (live: Roon subtitles render 'Lin‐Manuel' with U+2010)", async () => {
		const { applyRecentlyPlayedInserted } = await import('$lib/stores/recentlyPlayedStore');
		applyRecentlyPlayedInserted({
			entry: {
				title: 'Dear Theodosia',
				artist: 'Lio-Marcus Mendel',
				duration: 180,
				image_key: 'img-t',
				zone_id: 'zone-a',
				zone_name: 'Living Room',
				played_at: '2026-05-08T00:00:01.000Z'
			},
			revision: 2,
			epoch: 1
		});
		setSelectedZone('zone-a');

		// TWO rows share the title, so the title-only fallback refuses;
		// only the artist-strict pass can pick — and the fresh subtitle
		// spells the artist with U+2010, not ASCII '-'.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [
					makeItem({
						title: 'Dear Theodosia',
						subtitle: 'Lio‐Marcus Mendel, Leslie Odom Jr.',
						itemKey: 'right-key',
						hint: 'action_list'
					}),
					makeItem({
						title: 'Dear Theodosia',
						subtitle: 'Somebody Else',
						itemKey: 'wrong-key',
						hint: 'action_list'
					})
				]
			})
		);
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 1,
				items: [makeItem({ title: 'Play Now', itemKey: 'pn', hint: 'action', isPlayable: true })]
			})
		);
		apiBrowse.mockResolvedValueOnce(listResult({ level: 1 }));

		renderClassic();
		await tick();

		const tile = await screen.findByRole('button', { name: /Play 'Dear Theodosia'/i });
		tile.click();

		await waitFor(() => {
			const navCalls = apiBrowse.mock.calls;
			expect(navCalls).toHaveLength(3);
		});
		const navCalls = apiBrowse.mock.calls;
		expect(navCalls[1][1]).toEqual(expect.objectContaining({ itemKey: 'right-key' }));
	});

	it('follows a nested single-row action_list before finding actions (live: search drills are one level deeper, 2026-07-09)', async () => {
		setSelectedZone('zone-a');

		// Top-level search: the track as an untyped action_list row.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [
					makeItem({
						title: 'Hey Jude',
						subtitle: 'The Beatles',
						itemKey: 'fresh-track-key',
						hint: 'action_list'
					})
				]
			})
		);
		// Drilling the hit returns the track AGAIN as a lone action_list
		// row — not the actions (Roon Core 2.67 search shape).
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 1,
				items: [
					makeItem({
						title: 'Hey Jude',
						subtitle: 'The Beatles',
						itemKey: 'nested-track-key',
						hint: 'action_list'
					})
				]
			})
		);
		// Only the second drill yields the real action list.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 2,
				items: [
					makeItem({ title: 'Play Now', itemKey: 'pn', hint: 'action', isPlayable: true })
				]
			})
		);
		// Execute Play Now.
		apiBrowse.mockResolvedValueOnce(listResult({ level: 2 }));

		renderClassic();
		await tick();

		const tile = await screen.findByRole('button', { name: /Play 'Hey Jude'/i });
		tile.click();

		await waitFor(() => {
			const navCalls = apiBrowse.mock.calls;
			expect(navCalls).toHaveLength(4);
		});

		const navCalls = apiBrowse.mock.calls;
		// Hop through the nested row, then execute Play Now.
		expect(navCalls[2][1]).toEqual(
			expect.objectContaining({ hierarchy: 'search', itemKey: 'nested-track-key' })
		);
		expect(navCalls[3][1]).toEqual(expect.objectContaining({ itemKey: 'pn' }));

		const { commandFeedbackStore } = await import('$lib/stores/commandFeedbackStore');
		expect(get(commandFeedbackStore)?.message ?? '').not.toMatch(/Couldn't play/);
	});

	it('matches an UNTYPED action_list row at the top level (live: Roon search may omit item_type)', async () => {
		setSelectedZone('zone-a');

		// Top-level search result carries the track but with NO itemType —
		// only the structural hint. The resolver must still treat it as a
		// track candidate (albums/artists come back as hint 'list').
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [
					makeItem({
						title: 'Hey Jude',
						subtitle: 'The Beatles',
						itemKey: 'untyped-track-key',
						hint: 'action_list'
					})
				]
			})
		);
		// quickPlay action-list lookup → Play Now.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 1,
				items: [makeItem({ title: 'Play Now', itemKey: 'pn', hint: 'action', isPlayable: true })]
			})
		);
		// Execute Play Now.
		apiBrowse.mockResolvedValueOnce(listResult({ level: 1 }));

		renderClassic();
		await tick();

		const tile = await screen.findByRole('button', { name: /Play 'Hey Jude'/i });
		tile.click();

		await waitFor(() => {
			const navCalls = apiBrowse.mock.calls;
			expect(navCalls).toHaveLength(3);
		});

		const navCalls = apiBrowse.mock.calls;
		expect(navCalls[1][1]).toEqual(
			expect.objectContaining({ hierarchy: 'search', itemKey: 'untyped-track-key' })
		);
	});

	it('drills the "Tracks" category when no top-level row matches (live: track only listed under category)', async () => {
		setSelectedZone('zone-a');

		// Top level: only category rows — no direct track hit.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [
					makeItem({ title: 'Artists', itemKey: 'cat-artists', hint: 'list' }),
					makeItem({ title: 'Tracks', itemKey: 'cat-tracks', hint: 'list' })
				]
			})
		);
		// Category drill: full track list, numbered titles, untyped rows.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 1,
				items: [
					makeItem({
						title: '1. Hey Jude',
						subtitle: 'The Beatles',
						itemKey: 'cat-track-key',
						hint: 'action_list'
					}),
					makeItem({
						title: 'Hey Jude (Karaoke Version)',
						subtitle: 'Backing Band',
						itemKey: 'other',
						hint: 'action_list'
					})
				]
			})
		);
		// quickPlay action-list lookup → Play Now.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 2,
				items: [makeItem({ title: 'Play Now', itemKey: 'pn', hint: 'action', isPlayable: true })]
			})
		);
		// Execute Play Now.
		apiBrowse.mockResolvedValueOnce(listResult({ level: 2 }));

		renderClassic();
		await tick();

		const tile = await screen.findByRole('button', { name: /Play 'Hey Jude'/i });
		tile.click();

		await waitFor(() => {
			const navCalls = apiBrowse.mock.calls;
			expect(navCalls).toHaveLength(4);
		});

		const navCalls = apiBrowse.mock.calls;
		// Second call drills the Tracks category in the search session.
		expect(navCalls[1][1]).toEqual(
			expect.objectContaining({ hierarchy: 'search', itemKey: 'cat-tracks' })
		);
		// Third call drills the matched track row from the category page.
		expect(navCalls[2][1]).toEqual(
			expect.objectContaining({ hierarchy: 'search', itemKey: 'cat-track-key' })
		);
		// Fourth executes Play Now.
		expect(navCalls[3][1]).toEqual(expect.objectContaining({ itemKey: 'pn' }));

		// No "Couldn't find" toast.
		const { commandFeedbackStore } = await import('$lib/stores/commandFeedbackStore');
		expect(get(commandFeedbackStore)?.message ?? '').not.toMatch(/Couldn't find/);
	});

	it('still toasts when neither top level nor the Tracks category contains the track', async () => {
		setSelectedZone('zone-a');

		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [makeItem({ title: 'Tracks', itemKey: 'cat-tracks', hint: 'list' })]
			})
		);
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 1,
				items: [
					makeItem({
						title: 'Something Else',
						subtitle: 'Someone',
						itemKey: 'x',
						hint: 'action_list'
					})
				]
			})
		);

		renderClassic();
		await tick();

		const tile = await screen.findByRole('button', { name: /Play 'Hey Jude'/i });
		tile.click();

		await waitFor(async () => {
			const { commandFeedbackStore } = await import('$lib/stores/commandFeedbackStore');
			expect(get(commandFeedbackStore)?.message).toMatch(/Couldn't find "Hey Jude"/);
		});

		const navCalls = apiBrowse.mock.calls;
		expect(navCalls).toHaveLength(2); // search seed + category drill only
	});

	it('preserves prior search-panel state on no-match (does not relabel old results)', async () => {
		// R9 finding: handleRecentlyPlayedClick must not touch
		// browseStore's search panel state. The function re-seeds
		// Roon's server-side search session with the title, but
		// lastSearch / lastSearchQuery / searchLoading are user-facing
		// state for the Search UI — clobbering lastSearchQuery while
		// leaving stale lastSearch in place would mislabel the prior
		// "beatles" results as results for "Hey Jude".
		setSelectedZone('zone-a');

		// Seed prior search state — the user previously searched
		// "beatles" and the panel is showing those results.
		setSearchLoading('beatles');
		const priorResults = [
			makeSearchResult({
				resultType: 'album',
				itemType: 'album',
				title: 'Abbey Road',
				subtitle: 'The Beatles',
				itemKey: 'prior-album-key'
			})
		];
		setSearchResults(priorResults);

		// Recently Played click resolver: search returns nothing matching.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [
					makeItem({
						title: 'Different Track',
						subtitle: 'Other Artist',
						itemKey: 'wrong',
						itemType: 'track',
						hint: 'action_list'
					})
				]
			})
		);

		renderClassic();
		await tick();

		const tile = await screen.findByRole('button', { name: /Play 'Hey Jude'/i });
		tile.click();
		await tick();

		await waitFor(async () => {
			const { commandFeedbackStore } = await import('$lib/stores/commandFeedbackStore');
			expect(get(commandFeedbackStore)?.message).toMatch(/Couldn't find "Hey Jude"/);
		});

		// No quickPlay drill calls fired.
		const navCalls = apiBrowse.mock.calls;
		expect(navCalls).toHaveLength(1); // just the search seed

		// Prior search panel state preserved exactly.
		const store = get(browseStore);
		expect(store.lastSearchQuery).toBe('beatles');
		expect(store.lastSearch).toBe(priorResults);
		// setSearchResults above sets searchLoading=false. Recently
		// Played must not flip it back to true.
		expect(store.searchLoading).toBe(false);
	});

	it('matched track with no play action: toast + no fallback browse + prior search preserved', async () => {
		// R10 finding: quickPlay's no-play-action fallback would
		// browse to an action menu and call pushHistory under the
		// current $browseStore.lastSearchQuery. After R9 that query
		// is deliberately preserved as the user's prior visible
		// search (e.g. "beatles"), so a Recently Played fallback
		// would land in history labeled with the wrong query and
		// let a future restore re-seed the wrong search session.
		// playOnly:true makes the no-play-action path a feedback
		// toast instead, preserving search state and avoiding the
		// corrupt history entry.
		setSelectedZone('zone-a');

		// Prior search state visible.
		setSearchLoading('beatles');
		const priorResults = [
			makeSearchResult({
				resultType: 'album',
				itemType: 'album',
				title: 'Abbey Road',
				subtitle: 'The Beatles',
				itemKey: 'prior-album-key'
			})
		];
		setSearchResults(priorResults);

		// Search returns a matching track.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [
					makeItem({
						title: 'Hey Jude',
						subtitle: 'The Beatles',
						itemKey: 'fresh-track-key',
						itemType: 'track',
						hint: 'action_list'
					})
				]
			})
		);
		// Action-list lookup returns no playable action.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 1,
				items: [
					makeItem({ title: 'Metadata', itemKey: 'meta', hint: 'list', isPlayable: false })
				]
			})
		);

		renderClassic();
		await tick();

		const tile = await screen.findByRole('button', { name: /Play 'Hey Jude'/i });
		tile.click();

		// Wait for both REST calls (search seed + action lookup).
		await waitFor(() => {
			const navCalls = apiBrowse.mock.calls;
			expect(navCalls).toHaveLength(2);
		});

		// Search-role commands ran, but playOnly never issued a browse-role
		// fallback and therefore never recorded navigation history.
		expect(classicCommandRecords('browse', 'classic-search')).toHaveLength(2);
		expect(classicCommandRecords('browse', 'classic-browse')).toHaveLength(0);
		expect(get(browseHistoryStore).history).toEqual([]);

		// Prior search panel state preserved exactly.
		const store = get(browseStore);
		expect(store.lastSearchQuery).toBe('beatles');
		expect(store.lastSearch).toBe(priorResults);
		expect(store.searchLoading).toBe(false);

		// Toast surfaced the failure.
		const { commandFeedbackStore } = await import('$lib/stores/commandFeedbackStore');
		expect(get(commandFeedbackStore)?.message).toMatch(/Couldn't play "Hey Jude"/);
	});

	it('preserves prior search-panel state on successful quickPlay (does not relabel old results)', async () => {
		// R9 finding (success path): even a successful Recently Played
		// match → Play Now must not touch the search panel state.
		setSelectedZone('zone-a');

		// Seed prior search state.
		setSearchLoading('beatles');
		const priorResults = [
			makeSearchResult({
				resultType: 'album',
				itemType: 'album',
				title: 'Abbey Road',
				subtitle: 'The Beatles',
				itemKey: 'prior-album-key'
			})
		];
		setSearchResults(priorResults);

		// Search returns a matching track.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [
					makeItem({
						title: 'Hey Jude',
						subtitle: 'The Beatles',
						itemKey: 'fresh-track-key',
						itemType: 'track',
						hint: 'action_list'
					})
				]
			})
		);
		// quickPlay action-list lookup → Play Now found.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 1,
				items: [makeItem({ title: 'Play Now', itemKey: 'pn', hint: 'action', isPlayable: true })]
			})
		);
		// Execute Play Now.
		apiBrowse.mockResolvedValueOnce(listResult({ level: 1 }));

		renderClassic();
		await tick();

		const tile = await screen.findByRole('button', { name: /Play 'Hey Jude'/i });
		tile.click();

		// Wait until the full chain has run.
		await waitFor(() => {
			const navCalls = apiBrowse.mock.calls;
			expect(navCalls).toHaveLength(3);
		});

		// Prior search panel state preserved exactly — Play Now did
		// not relabel the user's "beatles" results as "Hey Jude".
		const store = get(browseStore);
		expect(store.lastSearchQuery).toBe('beatles');
		expect(store.lastSearch).toBe(priorResults);
		// setSearchResults above sets searchLoading=false. Recently
		// Played must not flip it back to true.
		expect(store.searchLoading).toBe(false);
	});

	it('title-only fallback: plays a matching track even when the subtitle does not contain the recorded artist', async () => {
		// Verified live (2026-05-17): a "Sons of 3rd Bass" / "Love in
		// a Vacuum" RP entry failed to resolve because Roon's search
		// subtitle didn't surface the artist verbatim (multi-artist
		// tracks, abbreviated names, "feat." additions, Unicode-quote
		// differences in artist names like "'Til Tuesday" vs "'Til
		// Tuesday"). The resolver now falls back to a title-only match
		// when strict title+artist doesn't find anything. Better to
		// play SOMETHING the user explicitly asked for than to insist
		// on artist-subtitle equality.
		setSelectedZone('zone-a');

		// The classic-explore role is isolated by the transaction mock, so
		// this queue belongs only to the click path.
		const searchResponse = listResult({
			level: 0,
			items: [
				makeItem({
					title: 'Hey Jude',
					subtitle: 'A Different Cover Artist',
					itemKey: 'wrong',
					itemType: 'track',
					hint: 'action_list'
				})
			]
		});
		const lookupResponse = listResult({
			level: 1,
			items: [
				makeItem({ title: 'Play Now', itemKey: 'play-now', hint: 'action', isPlayable: true })
			]
		});
		const executeResponse = listResult({ level: 1 });
		const rpQueue = [searchResponse, lookupResponse, executeResponse];
		let rpIdx = 0;
		apiBrowse.mockImplementation(async () => {
			return rpQueue[rpIdx++] ?? executeResponse;
		});

		renderClassic();
		await tick();

		const tile = await screen.findByRole('button', { name: /Play 'Hey Jude'/i });
		tile.click();

		// Should NOT surface "Couldn't find" — the title-only fallback
		// resolves the candidate even with mismatched artist.
		await waitFor(() => {
			const navCalls = apiBrowse.mock.calls;
			expect(navCalls).toHaveLength(3); // search seed + lookup + execute
		});
		const { commandFeedbackStore } = await import('$lib/stores/commandFeedbackStore');
		expect(get(commandFeedbackStore)?.message ?? '').not.toMatch(/Couldn't find/);
	});

	it('Unicode-quote tolerance: matches "Til Tuesday" subtitle when entry has curly-quote "Til Tuesday"', async () => {
		// Live regression: artist "'Til Tuesday" stored with U+2019
		// (curly right single quotation mark) failed to match Roon's
		// search response that used U+0027 (straight apostrophe) — or
		// vice versa. normalizeText now folds curly/straight quotes,
		// en/em dashes, and stray whitespace so a single character
		// difference doesn't hide a real track.
		setSelectedZone('zone-a');

		// Re-seed the recently-played store with an entry whose artist
		// uses the curly variant.
		const { resetRecentlyPlayed, applyRecentlyPlayedInserted } = await import(
			'$lib/stores/recentlyPlayedStore'
		);
		resetRecentlyPlayed();
		applyRecentlyPlayedInserted({
			entry: {
				title: 'Love in a Vacuum',
				artist: '’Til Tuesday', // U+2019 curly
				album: 'Coming Up Close',
				zone_id: 'zone-a',
				played_at: '2026-05-17T23:09:00Z'
			},
			revision: 1,
			epoch: 1
		});
		await tick();

		// The classic-explore role is isolated by the transaction mock.
		const searchResponse = listResult({
			level: 0,
			items: [
				makeItem({
					title: 'Love in a Vacuum',
					subtitle: "'Til Tuesday", // straight U+0027
					itemKey: 'real-key',
					itemType: 'track',
					hint: 'action_list'
				})
			]
		});
		const lookupResponse = listResult({
			level: 1,
			items: [
				makeItem({ title: 'Play Now', itemKey: 'play-now', hint: 'action', isPlayable: true })
			]
		});
		const executeResponse = listResult({ level: 1 });
		const rpQueue = [searchResponse, lookupResponse, executeResponse];
		let rpIdx = 0;
		apiBrowse.mockImplementation(async () => {
			return rpQueue[rpIdx++] ?? executeResponse;
		});

		renderClassic();
		await tick();

		const tile = await screen.findByRole('button', { name: /Play 'Love in a Vacuum'/i });
		tile.click();

		await waitFor(() => {
			const navCalls = apiBrowse.mock.calls;
			expect(navCalls).toHaveLength(3);
		});
		const { commandFeedbackStore } = await import('$lib/stores/commandFeedbackStore');
		expect(get(commandFeedbackStore)?.message ?? '').not.toMatch(/Couldn't find/);
	});

	it('reopen P1: ambiguous title-only fallback (multiple same-title tracks) surfaces "Couldn\'t find" rather than playing the wrong one', async () => {
		// Reviewer caught: previous fallback would play the first
		// title-matching track even when several existed (covers,
		// remasters, live versions, unrelated songs sharing a title).
		// Tightened: title-only fallback now requires EXACTLY ONE
		// title match. Multiple candidates → "Couldn't find".
		setSelectedZone('zone-a');

		// Custom entry with distinctive album so the album-evidence
		// pass doesn't accidentally rescue the ambiguity test (the
		// default RECENT.album = '1' would trivially substring-match
		// subtitles like "Live in 1971").
		const { resetRecentlyPlayed, applyRecentlyPlayedInserted } = await import(
			'$lib/stores/recentlyPlayedStore'
		);
		resetRecentlyPlayed();
		applyRecentlyPlayedInserted({
			entry: {
				title: 'Hey Jude',
				artist: 'The Beatles',
				album: 'Past Masters Volume Two',
				zone_id: 'zone-a',
				played_at: '2026-05-17T23:09:00Z'
			},
			revision: 1,
			epoch: 1
		});
		await tick();

		const searchResponse = listResult({
			level: 0,
			items: [
				// All title-match "Hey Jude" — none with The Beatles
				// in subtitle. Three different unrelated tracks.
				makeItem({
					title: 'Hey Jude',
					subtitle: 'Tribute Cover Band',
					itemKey: 'cover1',
					itemType: 'track',
					hint: 'action_list'
				}),
				makeItem({
					title: 'Hey Jude',
					subtitle: 'Live in 1971',
					itemKey: 'live',
					itemType: 'track',
					hint: 'action_list'
				}),
				makeItem({
					title: 'Hey Jude',
					subtitle: 'Unrelated Indie Band',
					itemKey: 'unrelated',
					itemType: 'track',
					hint: 'action_list'
				})
			]
		});
		apiBrowse.mockImplementation(async () => {
			return searchResponse;
		});

		renderClassic();
		await tick();

		const tile = await screen.findByRole('button', { name: /Play 'Hey Jude'/i });
		tile.click();

		await waitFor(async () => {
			const { commandFeedbackStore } = await import('$lib/stores/commandFeedbackStore');
			expect(get(commandFeedbackStore)?.message ?? '').toMatch(/Couldn't find "Hey Jude"/);
		});

		// Crucially: NO lookup/execute call fired — we refused to
		// play any of the same-title candidates.
		const navCalls = apiBrowse.mock.calls;
		expect(navCalls).toHaveLength(1); // just the search seed
	});

	it('reopen P1: album-evidence fallback — matching album in subtitle is enough when artist string differs', async () => {
		// "Artist • Album" subtitles where the artist string in our
		// recently-played entry doesn't appear verbatim (collab
		// formatting, "feat." additions, etc.) should still resolve
		// when the album DOES appear. RECENT.album === '1', so a
		// subtitle containing "1" anywhere should match — but to
		// avoid trivial confusion, use a more distinctive album for
		// the test.
		setSelectedZone('zone-a');

		// Clear any stale feedback message from prior tests so the
		// final "no Couldn't find" assertion isn't fooled by an
		// earlier test's "Couldn't find Hey Jude" toast still sitting
		// in the store.
		const { clearCommandFeedback } = await import('$lib/stores/commandFeedbackStore');
		clearCommandFeedback();

		const { resetRecentlyPlayed, applyRecentlyPlayedInserted } = await import(
			'$lib/stores/recentlyPlayedStore'
		);
		resetRecentlyPlayed();
		applyRecentlyPlayedInserted({
			entry: {
				title: 'Some Song',
				artist: 'Original Recording Artist',
				album: 'Distinctive Album Name',
				zone_id: 'zone-a',
				played_at: '2026-05-17T23:09:00Z'
			},
			revision: 1,
			epoch: 1
		});
		await tick();

		const searchResponse = listResult({
			level: 0,
			items: [
				// Artist string doesn't match RECENT artist, BUT
				// the album name does appear in subtitle.
				makeItem({
					title: 'Some Song',
					subtitle: 'Different Performer · Distinctive Album Name',
					itemKey: 'right',
					itemType: 'track',
					hint: 'action_list'
				})
			]
		});
		const lookupResponse = listResult({
			level: 1,
			items: [
				makeItem({ title: 'Play Now', itemKey: 'play-now', hint: 'action', isPlayable: true })
			]
		});
		const executeResponse = listResult({ level: 1 });
		const rpQueue = [searchResponse, lookupResponse, executeResponse];
		let rpIdx = 0;
		apiBrowse.mockImplementation(async () => {
			return rpQueue[rpIdx++] ?? executeResponse;
		});

		renderClassic();
		await tick();

		const tile = await screen.findByRole('button', { name: /Play 'Some Song'/i });
		tile.click();

		await waitFor(() => {
			const navCalls = apiBrowse.mock.calls;
			expect(navCalls).toHaveLength(3); // search + lookup + execute
		});
		const { commandFeedbackStore } = await import('$lib/stores/commandFeedbackStore');
		expect(get(commandFeedbackStore)?.message ?? '').not.toMatch(/Couldn't find/);
	});

	it('reopen P1: short-album false positive — album "1" must not substring-match "1971" in subtitle', async () => {
		// Reviewer's exact case: RECENT.album === "1" (The Beatles
		// compilation). An ambiguous search with subtitles like
		// "Live in 1971" would previously hit the album-evidence
		// pass via `.includes('1')` and silently play the live
		// version. Word-boundary matching prevents this — "1"
		// has no word boundary inside "1971".
		setSelectedZone('zone-a');

		const { clearCommandFeedback } = await import('$lib/stores/commandFeedbackStore');
		clearCommandFeedback();

		// Default RECENT entry: title="Hey Jude", artist="The Beatles",
		// album="1". Multiple title-only candidates with no real
		// artist or album-token evidence — must refuse.
		const searchResponse = listResult({
			level: 0,
			items: [
				makeItem({
					title: 'Hey Jude',
					subtitle: 'Live in 1971',
					itemKey: 'live',
					itemType: 'track',
					hint: 'action_list'
				}),
				makeItem({
					title: 'Hey Jude',
					subtitle: 'Tribute Cover Band, 2019',
					itemKey: 'cover',
					itemType: 'track',
					hint: 'action_list'
				})
			]
		});
		apiBrowse.mockImplementation(async () => {
			return searchResponse;
		});

		renderClassic();
		await tick();

		const tile = await screen.findByRole('button', { name: /Play 'Hey Jude'/i });
		tile.click();

		await waitFor(async () => {
			const { commandFeedbackStore } = await import('$lib/stores/commandFeedbackStore');
			expect(get(commandFeedbackStore)?.message ?? '').toMatch(/Couldn't find/);
		});

		// Refused — no lookup/execute call fired.
		const navCalls = apiBrowse.mock.calls;
		expect(navCalls).toHaveLength(1); // just the search seed
	});

	it('reopen P1: album-evidence refuses when multiple candidates match title+album', async () => {
		// Same track appearing on N compilations would have multiple
		// title+album matches. Refuse rather than picking the first
		// arbitrarily.
		setSelectedZone('zone-a');

		const { clearCommandFeedback } = await import('$lib/stores/commandFeedbackStore');
		clearCommandFeedback();

		const { resetRecentlyPlayed, applyRecentlyPlayedInserted } = await import(
			'$lib/stores/recentlyPlayedStore'
		);
		resetRecentlyPlayed();
		applyRecentlyPlayedInserted({
			entry: {
				title: 'Some Song',
				artist: 'Original Artist',
				album: 'Greatest Hits',
				zone_id: 'zone-a',
				played_at: '2026-05-17T23:09:00Z'
			},
			revision: 1,
			epoch: 1
		});
		await tick();

		const searchResponse = listResult({
			level: 0,
			items: [
				makeItem({
					title: 'Some Song',
					subtitle: 'Different Artist · Greatest Hits',
					itemKey: 'compilation-1',
					itemType: 'track',
					hint: 'action_list'
				}),
				makeItem({
					title: 'Some Song',
					subtitle: 'Yet Another Artist · Greatest Hits',
					itemKey: 'compilation-2',
					itemType: 'track',
					hint: 'action_list'
				})
			]
		});
		apiBrowse.mockImplementation(async () => {
			return searchResponse;
		});

		renderClassic();
		await tick();

		const tile = await screen.findByRole('button', { name: /Play 'Some Song'/i });
		tile.click();

		await waitFor(async () => {
			const { commandFeedbackStore } = await import('$lib/stores/commandFeedbackStore');
			expect(get(commandFeedbackStore)?.message ?? '').toMatch(/Couldn't find/);
		});

		// Refused — no lookup/execute.
		const navCalls = apiBrowse.mock.calls;
		expect(navCalls).toHaveLength(1);
	});

	it('L-2: album with trailing punctuation ("Help!") matches via token equality (album-evidence is load-bearing)', async () => {
		// Reviewer (L-2): the prior `\b<album>\b` regex couldn't
		// handle albums whose boundaries weren't ASCII-word chars.
		// "Help!" against "The Beatles · Help!" with `\bHelp!\b`
		// fails because `\b` requires a word-char on one side of
		// the boundary. Tokenize-and-compare handles it cleanly.
		//
		// Test makes album-evidence LOAD-BEARING by adding a second
		// same-title candidate whose subtitle does NOT contain the
		// album token. With two title-matches, the title-only
		// single-candidate guard would REFUSE — so the only way for
		// the test to play the right row is for album-evidence to
		// successfully select it. If subtitleHasAlbumToken regresses
		// to false, the test fails.
		setSelectedZone('zone-a');

		const { clearCommandFeedback } = await import('$lib/stores/commandFeedbackStore');
		clearCommandFeedback();

		const { resetRecentlyPlayed, applyRecentlyPlayedInserted } = await import(
			'$lib/stores/recentlyPlayedStore'
		);
		resetRecentlyPlayed();
		applyRecentlyPlayedInserted({
			entry: {
				title: 'Yesterday',
				artist: 'Renamed Performer',
				album: 'Help!',
				zone_id: 'zone-a',
				played_at: '2026-05-17T23:09:00Z'
			},
			revision: 1,
			epoch: 1
		});
		await tick();

		const searchResponse = listResult({
			level: 0,
			items: [
				// The right row: subtitle contains "Help!" album token.
				makeItem({
					title: 'Yesterday',
					subtitle: 'The Beatles · Help!',
					itemKey: 'right',
					itemType: 'track',
					hint: 'action_list'
				}),
				// Decoy: same title, NO album token in subtitle.
				makeItem({
					title: 'Yesterday',
					subtitle: 'Cover Band Live, Various Artists',
					itemKey: 'decoy',
					itemType: 'track',
					hint: 'action_list'
				})
			]
		});
		const lookupResponse = listResult({
			level: 1,
			items: [
				makeItem({ title: 'Play Now', itemKey: 'play-now', hint: 'action', isPlayable: true })
			]
		});
		const executeResponse = listResult({ level: 1 });
		const rpQueue = [searchResponse, lookupResponse, executeResponse];
		let rpIdx = 0;
		apiBrowse.mockImplementation(async () => {
			return rpQueue[rpIdx++] ?? executeResponse;
		});

		renderClassic();
		await tick();
		const tile = await screen.findByRole('button', { name: /Play 'Yesterday'/i });
		tile.click();

		await waitFor(() => {
			const navCalls = apiBrowse.mock.calls;
			expect(navCalls).toHaveLength(3); // album-evidence pass selected 'right' → played
		});
		// Lookup call hit itemKey='right', not 'decoy'.
		const lookupCall = apiBrowse.mock.calls[1];
		expect(lookupCall?.[1].itemKey).toBe('right');
		const { commandFeedbackStore } = await import('$lib/stores/commandFeedbackStore');
		expect(get(commandFeedbackStore)?.message ?? '').not.toMatch(/Couldn't find/);
	});

	it('L-2: album with Unicode chars ("Beyoncé") matches via token equality (album-evidence is load-bearing)', async () => {
		setSelectedZone('zone-a');

		const { clearCommandFeedback } = await import('$lib/stores/commandFeedbackStore');
		clearCommandFeedback();

		const { resetRecentlyPlayed, applyRecentlyPlayedInserted } = await import(
			'$lib/stores/recentlyPlayedStore'
		);
		resetRecentlyPlayed();
		applyRecentlyPlayedInserted({
			entry: {
				title: 'Halo',
				artist: 'Renamed Performer',
				album: 'Beyoncé',
				zone_id: 'zone-a',
				played_at: '2026-05-17T23:09:00Z'
			},
			revision: 1,
			epoch: 1
		});
		await tick();

		const searchResponse = listResult({
			level: 0,
			items: [
				makeItem({
					title: 'Halo',
					subtitle: 'Beyoncé · 2008',
					itemKey: 'right',
					itemType: 'track',
					hint: 'action_list'
				}),
				// Decoy: same title, NO album token in subtitle.
				makeItem({
					title: 'Halo',
					subtitle: 'Texas, A Capella Cover',
					itemKey: 'decoy',
					itemType: 'track',
					hint: 'action_list'
				})
			]
		});
		const lookupResponse = listResult({
			level: 1,
			items: [
				makeItem({ title: 'Play Now', itemKey: 'play-now', hint: 'action', isPlayable: true })
			]
		});
		const executeResponse = listResult({ level: 1 });
		const rpQueue = [searchResponse, lookupResponse, executeResponse];
		let rpIdx = 0;
		apiBrowse.mockImplementation(async () => {
			return rpQueue[rpIdx++] ?? executeResponse;
		});

		renderClassic();
		await tick();
		const tile = await screen.findByRole('button', { name: /Play 'Halo'/i });
		tile.click();

		await waitFor(() => {
			const navCalls = apiBrowse.mock.calls;
			expect(navCalls).toHaveLength(3);
		});
		const { commandFeedbackStore } = await import('$lib/stores/commandFeedbackStore');
		expect(get(commandFeedbackStore)?.message ?? '').not.toMatch(/Couldn't find/);
	});

	it('L-2: multi-token album with mixed punctuation matches as a contiguous run', async () => {
		// "(What's the Story) Morning Glory?" tokenizes to
		// ["what's","the","story","morning","glory"]. Must match a
		// subtitle containing those tokens in that order.
		setSelectedZone('zone-a');

		const { clearCommandFeedback } = await import('$lib/stores/commandFeedbackStore');
		clearCommandFeedback();

		const { resetRecentlyPlayed, applyRecentlyPlayedInserted } = await import(
			'$lib/stores/recentlyPlayedStore'
		);
		resetRecentlyPlayed();
		applyRecentlyPlayedInserted({
			entry: {
				title: 'Wonderwall',
				artist: 'Renamed Performer',
				album: "(What's the Story) Morning Glory?",
				zone_id: 'zone-a',
				played_at: '2026-05-17T23:09:00Z'
			},
			revision: 1,
			epoch: 1
		});
		await tick();

		const searchResponse = listResult({
			level: 0,
			items: [
				makeItem({
					title: 'Wonderwall',
					subtitle: "Oasis · (What's the Story) Morning Glory?",
					itemKey: 'right',
					itemType: 'track',
					hint: 'action_list'
				}),
				// Decoy: same title, NO album token in subtitle.
				makeItem({
					title: 'Wonderwall',
					subtitle: 'Ryan Adams · Love Is Hell',
					itemKey: 'decoy',
					itemType: 'track',
					hint: 'action_list'
				})
			]
		});
		const lookupResponse = listResult({
			level: 1,
			items: [
				makeItem({ title: 'Play Now', itemKey: 'play-now', hint: 'action', isPlayable: true })
			]
		});
		const executeResponse = listResult({ level: 1 });
		const rpQueue = [searchResponse, lookupResponse, executeResponse];
		let rpIdx = 0;
		apiBrowse.mockImplementation(async () => {
			return rpQueue[rpIdx++] ?? executeResponse;
		});

		renderClassic();
		await tick();
		const tile = await screen.findByRole('button', { name: /Play 'Wonderwall'/i });
		tile.click();

		await waitFor(() => {
			const navCalls = apiBrowse.mock.calls;
			expect(navCalls).toHaveLength(3);
		});
		const { commandFeedbackStore } = await import('$lib/stores/commandFeedbackStore');
		expect(get(commandFeedbackStore)?.message ?? '').not.toMatch(/Couldn't find/);
	});

	it('L-2 (NFC): precomposed entry album matches decomposed subtitle (Beyoncé)', async () => {
		// Reviewer's nonblocking note: NFC normalization. The entry
		// album "Beyoncé" stored as precomposed (U+00E9) must match
		// a search subtitle that contains decomposed (U+0301 combining
		// acute) form, and vice versa. Without NFC, the token strip
		// can drop the trailing combining mark and produce "beyonce"
		// vs "beyoncé" — silent false-negative.
		setSelectedZone('zone-a');

		const { clearCommandFeedback } = await import('$lib/stores/commandFeedbackStore');
		clearCommandFeedback();

		const { resetRecentlyPlayed, applyRecentlyPlayedInserted } = await import(
			'$lib/stores/recentlyPlayedStore'
		);
		resetRecentlyPlayed();
		applyRecentlyPlayedInserted({
			entry: {
				title: 'Halo',
				artist: 'Renamed Performer',
				album: 'Beyoncé', // precomposed
				zone_id: 'zone-a',
				played_at: '2026-05-17T23:09:00Z'
			},
			revision: 1,
			epoch: 1
		});
		await tick();

		const searchResponse = listResult({
			level: 0,
			items: [
				makeItem({
					title: 'Halo',
					subtitle: 'Beyoncé · 2008', // decomposed
					itemKey: 'right',
					itemType: 'track',
					hint: 'action_list'
				}),
				makeItem({
					title: 'Halo',
					subtitle: 'Texas, A Capella Cover',
					itemKey: 'decoy',
					itemType: 'track',
					hint: 'action_list'
				})
			]
		});
		const lookupResponse = listResult({
			level: 1,
			items: [
				makeItem({ title: 'Play Now', itemKey: 'play-now', hint: 'action', isPlayable: true })
			]
		});
		const executeResponse = listResult({ level: 1 });
		const rpQueue = [searchResponse, lookupResponse, executeResponse];
		let rpIdx = 0;
		apiBrowse.mockImplementation(async () => {
			return rpQueue[rpIdx++] ?? executeResponse;
		});

		renderClassic();
		await tick();
		const tile = await screen.findByRole('button', { name: /Play 'Halo'/i });
		tile.click();

		await waitFor(() => {
			const navCalls = apiBrowse.mock.calls;
			expect(navCalls).toHaveLength(3);
		});
		const lookupCall = apiBrowse.mock.calls[1];
		expect(lookupCall?.[1].itemKey).toBe('right');
	});

	it('L-2: token match still rejects short-album false positive (album "1" vs subtitle "1971")', async () => {
		// Regression guard: the original substring-bug fix must
		// survive the switch from regex to tokenization. RECENT.album
		// is "1" by default; subtitle "Live in 1971" must NOT match
		// because tokens ["1"] and ["live","in","1971"] have no
		// equal token.
		//
		// Decoy subtitle deliberately contains NO "1" anywhere — so
		// the OLD `.includes("1")` substring matcher would have
		// matched ONLY "Live in 1971" (a single album candidate),
		// silently selected the live version, and the test would
		// fail. The current token matcher rejects both → title-only
		// single-candidate guard refuses → expected.
		setSelectedZone('zone-a');

		const { clearCommandFeedback } = await import('$lib/stores/commandFeedbackStore');
		clearCommandFeedback();

		const searchResponse = listResult({
			level: 0,
			items: [
				makeItem({
					title: 'Hey Jude',
					subtitle: 'Live in 1971',
					itemKey: 'live',
					itemType: 'track',
					hint: 'action_list'
				}),
				makeItem({
					title: 'Hey Jude',
					subtitle: 'Tribute Cover Band, 2020',
					itemKey: 'cover',
					itemType: 'track',
					hint: 'action_list'
				})
			]
		});
		apiBrowse.mockImplementation(async () => {
			return searchResponse;
		});

		renderClassic();
		await tick();
		const tile = await screen.findByRole('button', { name: /Play 'Hey Jude'/i });
		tile.click();

		await waitFor(async () => {
			const { commandFeedbackStore } = await import('$lib/stores/commandFeedbackStore');
			expect(get(commandFeedbackStore)?.message ?? '').toMatch(/Couldn't find/);
		});

		const navCalls = apiBrowse.mock.calls;
		expect(navCalls).toHaveLength(1); // refused before lookup/execute
	});

	it('Clear button issues DELETE and applies the empty response', async () => {
		// The server returns its post-drain entries. In the common
		// case (no concurrent now-playing during clear), that's [].
		renderClassic();
		await tick();

		expect(screen.queryByRole('button', { name: /Play 'Hey Jude'/i })).not.toBeNull();

		const clearBtn = await screen.findByRole('button', { name: 'Clear' });
		clearBtn.click();

		await waitFor(() => {
			expect(apiClearRecentlyPlayed).toHaveBeenCalledTimes(1);
		});

		const { recentlyPlayedStore } = await import('$lib/stores/recentlyPlayedStore');
		await waitFor(() => {
			expect(get(recentlyPlayedStore).entries).toEqual([]);
		});
		expect(screen.queryByRole('button', { name: /Play 'Hey Jude'/i })).toBeNull();
		const landing = screen.getByRole('region', { name: 'Recently played' });
		expect(landing).toHaveAttribute('id', 'recently-played-section');
		expect(landing).toHaveTextContent(/No recently played music has been observed/i);
		expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
	});

	it('Clear button: stale DELETE response is discarded if a newer socket insert arrived first (revision guard)', async () => {
		// The race: a post-clear now-playing event fires after the
		// server snapshotted the DELETE response. The socket insert
		// (revision N+1) reaches the client first; the slower HTTP
		// response (revision N, the older snapshot) arrives later.
		// Revision filtering ensures the response is discarded so it
		// doesn't wipe the legitimate post-snapshot insert.
		let resolveDelete!: (snapshot: import('@shared/types').RecentlyPlayedSnapshot) => void;
		apiClearRecentlyPlayed.mockImplementationOnce(
			() => new Promise((r) => (resolveDelete = r))
		);

		renderClassic();
		await tick();

		const clearBtn = await screen.findByRole('button', { name: 'Clear' });
		clearBtn.click();
		await tick();
		expect(apiClearRecentlyPlayed).toHaveBeenCalledTimes(1);

		// Simulate a post-clear socket insert arriving mid-flight at a
		// higher revision than the (still pending) DELETE response.
		const { applyRecentlyPlayedInserted, recentlyPlayedStore } = await import(
			'$lib/stores/recentlyPlayedStore'
		);
		const newTrack: import('@shared/types').RecentlyPlayedEntry = {
			title: 'NewTrack',
			artist: 'Live Artist',
			album: 'Live Album',
			duration: 200,
			image_key: 'img-n',
			zone_id: 'zone-a',
			zone_name: 'Living Room',
			played_at: '2026-05-16T08:00:00.000Z'
		};
		applyRecentlyPlayedInserted({ entry: newTrack, revision: 100, epoch: 1 });
		expect(get(recentlyPlayedStore).entries.map((e) => e.title)).toEqual([
			'NewTrack',
			'Hey Jude'
		]);

		// Now the slower HTTP response resolves with the (now stale)
		// snapshot — revision 99 < 100, so it's discarded. If it
		// weren't, the store would get wiped to [].
		resolveDelete({ entries: [], revision: 99, epoch: 1 });

		// Give the await chain a chance to complete; nothing should
		// change because the response was discarded as stale.
		await new Promise((r) => setTimeout(r, 10));
		expect(get(recentlyPlayedStore).entries.map((e) => e.title)).toEqual([
			'NewTrack',
			'Hey Jude'
		]);
	});

	it('Clear button applies post-drain entries from the DELETE response', async () => {
		// If a now-playing event landed during the server's clear
		// window, clear() drains it onto the empty list before
		// resolving — getEntries() then returns the drained insert.
		// The UI applies the response unconditionally, so the
		// initiator's view matches server/disk regardless of whether
		// the socket events arrived first, last, or were dropped.
		const drainedEntry: import('@shared/types').RecentlyPlayedEntry = {
			title: 'Drained Mid-Clear',
			artist: 'Some Artist',
			album: 'Some Album',
			duration: 200,
			image_key: 'img-d',
			zone_id: 'zone-a',
			zone_name: 'Living Room',
			played_at: '2026-05-15T12:00:00.000Z'
		};
		apiClearRecentlyPlayed.mockResolvedValueOnce({
			entries: [drainedEntry],
			revision: 999_999,
			epoch: 1
		});

		renderClassic();
		await tick();

		const clearBtn = await screen.findByRole('button', { name: 'Clear' });
		clearBtn.click();

		await waitFor(() => {
			expect(apiClearRecentlyPlayed).toHaveBeenCalledTimes(1);
		});

		const { recentlyPlayedStore } = await import('$lib/stores/recentlyPlayedStore');
		await waitFor(() => {
			expect(get(recentlyPlayedStore).entries.map((e) => e.title)).toEqual([
				'Drained Mid-Clear'
			]);
		});
	});

	it('Clear button surfaces a feedback toast when the DELETE fails', async () => {
		apiClearRecentlyPlayed.mockRejectedValueOnce(new Error('network down'));
		renderClassic();
		await tick();

		const clearBtn = await screen.findByRole('button', { name: 'Clear' });
		clearBtn.click();

		await waitFor(async () => {
			const { commandFeedbackStore } = await import('$lib/stores/commandFeedbackStore');
			expect(get(commandFeedbackStore)?.message).toMatch(/Couldn't clear recently played/);
		});
		// List left intact — the failed clear didn't touch the store.
		const { recentlyPlayedStore } = await import('$lib/stores/recentlyPlayedStore');
		expect(get(recentlyPlayedStore).entries).toHaveLength(1);
	});
});

describe('Library page — album chips (PR2 album-page polish)', () => {
	function albumPageResult(subtitle: string | undefined) {
		// Build a level-2 track list (6 action_list rows with `track`
		// itemType) so `isTrackList` is true and `isAlbumPage` returns
		// true. Subtitle drives chip extraction.
		const trackRows: BrowseItem[] = [];
		for (let i = 1; i <= 6; i++) {
			trackRows.push(
				makeItem({
					title: `${i}. Track ${i}`,
					itemKey: `t${i}`,
					hint: 'action_list',
					itemType: 'track'
				})
			);
		}
		return listResult({
			level: 2,
			title: 'Under the Pink',
			subtitle,
			items: trackRows
		});
	}

	it('renders year + format chips on an album page with subtitle "Artist · 1994 · FLAC"', async () => {
		setBrowseResult(albumPageResult('Tilda Arlen · 1994 · FLAC'), 'browse');

		renderClassic();
		await tick();

		const chips = await screen.findByLabelText('Album metadata');
		expect(chips.textContent).toContain('1994');
		expect(chips.textContent).toContain('FLAC');
	});

	it('renders nothing when subtitle is just an artist name (no year, no format)', async () => {
		setBrowseResult(albumPageResult('Tilda Arlen'), 'browse');
		renderClassic();
		await tick();

		expect(screen.queryByLabelText('Album metadata')).toBeNull();
	});

	it('does not render chips on non-album pages (level 0–1, artist listings, etc.)', async () => {
		// Level 0 navigation menu with subtitle that LOOKS like an
		// album subtitle ("Tilda Arlen · 1994"). isAlbumPage gates on
		// level ≥ 2 AND isTrackList — neither is true here.
		setBrowseResult(
			listResult({
				level: 0,
				title: 'Library',
				subtitle: 'Tilda Arlen · 1994',
				items: [makeItem({ title: 'Albums', itemKey: 'albums' })]
			}),
			'browse'
		);
		renderClassic();
		await tick();

		expect(screen.queryByLabelText('Album metadata')).toBeNull();
	});

	it('renders only the year chip when subtitle has a year but no format tag', async () => {
		setBrowseResult(albumPageResult('Tilda Arlen · 1994'), 'browse');
		renderClassic();
		await tick();

		const chips = await screen.findByLabelText('Album metadata');
		expect(chips.textContent).toContain('1994');
		// No format tag present.
		expect(chips.textContent).not.toMatch(/FLAC|MQA|DSD|Hi-Res/);
	});

	it('P1 reopen: "Search for this artist" link text is the artist portion only, not the raw chip-laden subtitle', async () => {
		setBrowseResult(albumPageResult('Tilda Arlen · 1994 · FLAC'), 'browse');
		renderClassic();
		await tick();

		// The artist-link button reads "Tilda Arlen", not the full
		// subtitle. The previous behavior set the button label (and
		// search query) to the full string. Find by visible text
		// (the button's text content is the accessible name).
		const link = await screen.findByRole('button', { name: 'Tilda Arlen' });
		expect(link.textContent?.trim()).toBe('Tilda Arlen');
		expect(link.textContent?.trim()).not.toContain('1994');
		expect(link.textContent?.trim()).not.toContain('FLAC');
	});

	it('playlist contents: subtitle "453 tracks" renders as static text, not as a search-this-artist button', async () => {
		// Live regression: a large playlist hits isTrackList=true via
		// the size threshold (inferredAllTracks=true). Roon's subtitle
		// on the page is "N tracks · duration" — metadata, NOT an
		// artist. The prior code rendered any non-empty subtitle as a
		// clickable button that called searchArtist("453 tracks"),
		// which routed through the search hierarchy and returned
		// "no results". Fix: gate the artist-link on isAlbumPage
		// (which excludes inferredAllTracks), fall through to static
		// text.
		const trackRows: BrowseItem[] = [];
		for (let i = 1; i <= 10; i++) {
			trackRows.push(
				makeItem({
					title: `Song Title ${i}`, // no number prefix, no itemType
					itemKey: `t${i}`,
					hint: 'action_list'
				})
			);
		}
		setBrowseResult(
			listResult({
				level: 2,
				title: 'My Playlist',
				subtitle: '453 tracks',
				items: trackRows
			}),
			'browse'
		);
		renderClassic();
		await tick();

		// "453 tracks" appears as static text inside the album-header
		// region, not as a button.
		expect(screen.queryByRole('button', { name: '453 tracks' })).toBeNull();
		// And the page IS classified as a track list (inferredAllTracks
		// path); the subtitle is rendered as the static fallback.
		expect(screen.getByText('453 tracks')).toBeInTheDocument();
	});

	it('non-tracklist page: subtitle like "12 albums" renders as static text, not as a search button', async () => {
		// E.g. an artist page that shows their albums. Subtitle is
		// informational metadata. Prior code made any non-empty
		// subtitle on a non-tracklist page into a clickable
		// "search this artist" button, which would search Roon for
		// "12 albums" — wrong.
		setBrowseResult(
			listResult({
				level: 1,
				title: 'Tilda Arlen',
				subtitle: '12 albums',
				items: [makeItem({ title: 'Under the Pink', itemKey: 'a1' })]
			}),
			'browse'
		);
		renderClassic();
		await tick();

		expect(screen.queryByRole('button', { name: '12 albums' })).toBeNull();
		expect(screen.getByText('12 albums')).toBeInTheDocument();
	});

	it('P2 reopen: no chips render on a non-album track list (Library/Tracks-style inferred-all-tracks page)', async () => {
		// Same shape as albumPageResult — level 2, every row is an
		// action_list — but NO `itemType: track` AND no numeric-
		// prefix titles (which would trigger the title-regex
		// fallback in isTrackItem). isTrackList kicks in via the
		// size heuristic alone → inferredAllTracks becomes true →
		// isAlbumPage returns false → no chips.
		const trackRows: BrowseItem[] = [];
		for (let i = 1; i <= 6; i++) {
			trackRows.push(
				makeItem({
					title: `Some Track ${i}`, // No numeric prefix → not flagged by isTrackItem regex
					itemKey: `t${i}`,
					hint: 'action_list'
					// no itemType
				})
			);
		}
		setBrowseResult(
			listResult({
				level: 2,
				title: 'Tracks',
				subtitle: '12345 tracks · 2024',
				items: trackRows
			}),
			'browse'
		);

		renderClassic();
		await tick();
		expect(screen.queryByLabelText('Album metadata')).toBeNull();
	});
});

describe('Library page — playlist contents (fix-2)', () => {
	function playlistPageResult(numTracks: number, opts: { withMetadataRow?: boolean } = {}): BrowseResult {
		const items: BrowseItem[] = [
			// Page-level play action that Roon mixes into the same
			// action_list stream as the track rows.
			makeItem({ title: 'Play Playlist', itemKey: 'play-pl', hint: 'action_list' })
		];
		for (let i = 1; i <= numTracks; i++) {
			items.push(
				makeItem({
					// Real-world shape: no numeric prefix, no itemType=track.
					title: `Song Title ${i}`,
					itemKey: `t${i}`,
					hint: 'action_list'
				})
			);
		}
		if (opts.withMetadataRow !== false) {
			// Roon-style metadata header that breaks every(action_list).
			items.push(
				makeItem({
					title: `${numTracks} Tracks`,
					itemKey: 'meta',
					hint: 'list',
					isPlayable: false
				})
			);
		}
		return listResult({
			level: 2,
			title: 'My Playlist',
			subtitle: `${numTracks} Tracks`,
			items
		});
	}

	it('classifies a playlist with a metadata header row as a track list (not blue-pill page actions)', async () => {
		// Pre-fix: the one `hint: 'list'` metadata row broke
		// `every(action_list)`, sending all track rows into pageActions
		// as blue-pill .album-action-btn buttons.
		setBrowseResult(playlistPageResult(10), 'browse');
		renderClassic();
		await tick();

		// No "Song Title N" should appear as an .album-action-btn /
		// page-action pill. They should be track rows. Searching by
		// the exact play-button label is unambiguous.
		const playButton = await screen.findByRole('button', { name: 'Play Song Title 1' });
		expect(playButton).toBeInTheDocument();
	});

	it('routes the "Play Playlist" row to page-actions, not track rows', async () => {
		setBrowseResult(playlistPageResult(10), 'browse');
		renderClassic();
		await tick();

		// "Play Playlist" still renders, but NOT as a track row (a
		// track row would have an aria-label "Play Play Playlist" via
		// TrackList's per-row play button). It's a pageAction pill.
		expect(screen.queryByRole('button', { name: 'Play Play Playlist' })).toBeNull();
		// And it's still clickable as a page-level action.
		expect(screen.getByRole('button', { name: 'Play Playlist' })).toBeInTheDocument();
	});

	it('track-row ▶ click goes through quickPlay (not navigate / drill into action menu)', async () => {
		setBrowseResult(playlistPageResult(10), 'browse');
		setSelectedZone('zone-living-room');

		// quickPlay needs an action-list lookup that contains a play
		// action; mirror the existing "looks up the action list,
		// executes the play action" test setup.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 3,
				items: [makeItem({ title: 'Play Now', itemKey: 'play-now-key', hint: 'action', isPlayable: true })]
			})
		);
		apiBrowse.mockResolvedValueOnce(listResult({ level: 3 }));

		renderClassic();
		const playBtn = await screen.findByRole('button', { name: 'Play Song Title 1' });
		playBtn.click();

		// Two apiBrowse calls — lookup + execute, exactly the quickPlay
		// shape. If the click had gone through the default
		// handleItemClick (which would `navigate(item)` since
		// shouldQuickPlayActionList returns false without itemType=track),
		// we'd see one socket browse call and zero apiBrowse calls.
		await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(2));
		expect(apiBrowse.mock.calls[0][1]).toEqual(
			expect.objectContaining({ hierarchy: 'browse', itemKey: 't1' })
		);
		expect(apiBrowse.mock.calls[1][1]).toEqual(
			expect.objectContaining({ hierarchy: 'browse', itemKey: 'play-now-key' })
		);
	});

	it('album-page ▶ prefers "Play From Here" over "Play Now" when Roon offers it (BUGS.md #6)', async () => {
		// A real album page: Play Album action + typed tracks + artist
		// subtitle (isAlbumPage = true).
		setBrowseResult(
			listResult({
				title: 'Abbey Road',
				subtitle: 'The Beatles · 1969',
				level: 3,
				items: [
					makeItem({ title: 'Play Album', itemKey: 'pa', hint: 'action_list' }),
					makeItem({
						title: '1. Come Together',
						itemKey: 't1',
						hint: 'action_list',
						itemType: 'track'
					})
				]
			}),
			'browse'
		);
		setSelectedZone('zone-living-room');

		// Action list offers the full Roon track menu. The default ▶
		// must pick "Play From Here" (continues to the end of the
		// album), not the first action.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 4,
				items: [
					makeItem({ title: 'Play Now', itemKey: 'play-now-key', hint: 'action', isPlayable: true }),
					makeItem({
						title: 'Play From Here',
						itemKey: 'play-from-here-key',
						hint: 'action',
						isPlayable: true
					}),
					makeItem({ title: 'Add Next', itemKey: 'add-next-key', hint: 'action', isPlayable: true })
				]
			})
		);
		apiBrowse.mockResolvedValueOnce(listResult({ level: 4 }));

		renderClassic();
		const playBtn = await screen.findByRole('button', { name: 'Play Come Together' });
		playBtn.click();

		// Filter out welcome-stats fetches so the test is order-independent.
		const navCalls = () =>
			apiBrowse.mock.calls;
		await waitFor(() => expect(navCalls()).toHaveLength(2));
		expect(navCalls()[1][1]).toEqual(
			expect.objectContaining({ itemKey: 'play-from-here-key' })
		);
	});

	it('playlist ▶ also prefers "Play From Here" — continue through the list is the default everywhere (BUGS.md #6, owner clarification)', async () => {
		// Owner (2026-06-10): "playlists should play the list by
		// default, same as albums. kinda the point." The preference is
		// NOT album-gated.
		setBrowseResult(playlistPageResult(10), 'browse');
		setSelectedZone('zone-living-room');

		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 3,
				items: [
					makeItem({ title: 'Play Now', itemKey: 'play-now-key', hint: 'action', isPlayable: true }),
					makeItem({
						title: 'Play From Here',
						itemKey: 'play-from-here-key',
						hint: 'action',
						isPlayable: true
					})
				]
			})
		);
		apiBrowse.mockResolvedValueOnce(listResult({ level: 3 }));

		renderClassic();
		const playBtn = await screen.findByRole('button', { name: 'Play Song Title 1' });
		playBtn.click();

		const navCalls = () =>
			apiBrowse.mock.calls;
		await waitFor(() => expect(navCalls()).toHaveLength(2));
		expect(navCalls()[1][1]).toEqual(
			expect.objectContaining({ itemKey: 'play-from-here-key' })
		);
	});

	it('reopen P1: real track titles starting with "Play" stay as tracks, not page actions', async () => {
		// Reviewer caught: prior `/^play\b/i` prefix match would
		// route "Play Dead", "Play With Fire", "Play That Funky Music"
		// into pageActions instead of trackItems, hiding real songs
		// behind the bug we were trying to fix.
		const items: BrowseItem[] = [
			makeItem({ title: 'Play Playlist', itemKey: 'pa-pl', hint: 'action_list' }),
			makeItem({ title: 'Play Dead', itemKey: 't1', hint: 'action_list' }),
			makeItem({ title: 'Play With Fire', itemKey: 't2', hint: 'action_list' }),
			makeItem({ title: 'Play That Funky Music', itemKey: 't3', hint: 'action_list' }),
			makeItem({ title: 'Play Crack the Sky', itemKey: 't4', hint: 'action_list' }),
			makeItem({ title: 'Other Song', itemKey: 't5', hint: 'action_list' }),
			makeItem({ title: '6 Tracks', itemKey: 'meta', hint: 'list', isPlayable: false })
		];
		setBrowseResult(
			listResult({ level: 2, title: 'Songs Starting With Play', items }),
			'browse'
		);
		renderClassic();
		await tick();

		// "Play Playlist" is the only known page-action title; it goes
		// to pageActions and has no per-track play button.
		expect(screen.queryByRole('button', { name: 'Play Play Playlist' })).toBeNull();
		expect(screen.getByRole('button', { name: 'Play Playlist' })).toBeInTheDocument();

		// Every real song title starting with "Play" is a track row
		// (rendered with TrackList's per-row ▶ button labelled
		// "Play <song>").
		expect(screen.getByRole('button', { name: 'Play Play Dead' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Play Play With Fire' })).toBeInTheDocument();
		expect(
			screen.getByRole('button', { name: 'Play Play That Funky Music' })
		).toBeInTheDocument();
		expect(
			screen.getByRole('button', { name: 'Play Play Crack the Sky' })
		).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Play Other Song' })).toBeInTheDocument();
	});

	it('reopen P1: page-action match is case-insensitive and trims whitespace, but title-only', async () => {
		// Both " Play Album " (extra whitespace) and "PLAY GENRE" (case)
		// match. A track titled "Play Album Tonight" should not match —
		// only exact whole-string equality after trim+lowercase.
		const items: BrowseItem[] = [
			makeItem({ title: ' Play Album ', itemKey: 'pa-album', hint: 'action_list' }),
			makeItem({ title: 'PLAY GENRE', itemKey: 'pa-genre', hint: 'action_list' }),
			makeItem({ title: 'Play Album Tonight', itemKey: 't-album-tonight', hint: 'action_list' }),
			makeItem({ title: 'Some Track', itemKey: 't2', hint: 'action_list' }),
			makeItem({ title: 'Another Track', itemKey: 't3', hint: 'action_list' }),
			makeItem({ title: '5 Tracks', itemKey: 'meta', hint: 'list', isPlayable: false })
		];
		setBrowseResult(
			listResult({ level: 2, title: 'Mixed', items }),
			'browse'
		);
		renderClassic();
		await tick();

		// "Play Album Tonight" — a track title that contains "Play Album"
		// as a prefix — must NOT be misclassified as a page action.
		expect(
			screen.getByRole('button', { name: 'Play Play Album Tonight' })
		).toBeInTheDocument();
	});

	it('reopen P2: small playlist (3 tracks + Play Playlist) renders as track list, not pills', async () => {
		// Reviewer caught: the size-threshold of 5 was the only path
		// to inferredAllTracks for untyped tracks. A small playlist
		// (1–4 tracks) has the same shape as a larger one — action_list
		// rows with no itemType, plus a Play Playlist row — but didn't
		// hit the threshold and reverted to the blue-pill rendering.
		// The collection-page-action signal (presence of "Play Playlist")
		// now triggers track-list classification at any size.
		const items: BrowseItem[] = [
			makeItem({ title: 'Play Playlist', itemKey: 'pa', hint: 'action_list' }),
			makeItem({ title: 'First Song', itemKey: 't1', hint: 'action_list' }),
			makeItem({ title: 'Second Song', itemKey: 't2', hint: 'action_list' }),
			makeItem({ title: 'Third Song', itemKey: 't3', hint: 'action_list' }),
			makeItem({ title: '3 Tracks', itemKey: 'meta', hint: 'list', isPlayable: false })
		];
		setBrowseResult(
			listResult({ level: 2, title: 'Tiny Playlist', items }),
			'browse'
		);
		renderClassic();
		await tick();

		expect(screen.getByRole('button', { name: 'Play First Song' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Play Second Song' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Play Third Song' })).toBeInTheDocument();
		// Play Playlist still the page-level action.
		expect(screen.getByRole('button', { name: 'Play Playlist' })).toBeInTheDocument();
	});

	it('reopen P2: single-track playlist also renders as track list (size = 1)', async () => {
		const items: BrowseItem[] = [
			makeItem({ title: 'Play Playlist', itemKey: 'pa', hint: 'action_list' }),
			makeItem({ title: 'Only Song', itemKey: 't1', hint: 'action_list' })
		];
		setBrowseResult(
			listResult({ level: 2, title: 'One-Song Playlist', items }),
			'browse'
		);
		renderClassic();
		await tick();

		expect(screen.getByRole('button', { name: 'Play Only Song' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Play Playlist' })).toBeInTheDocument();
	});

	it('reopen P2: small album with Play Album + 2 untyped tracks also classifies as track list', async () => {
		// Same shape as small playlist but with Play Album as the
		// collection action. Roon EP / single albums (< 5 tracks) hit
		// this path.
		const items: BrowseItem[] = [
			makeItem({ title: 'Play Album', itemKey: 'pa', hint: 'action_list' }),
			makeItem({ title: 'Intro', itemKey: 't1', hint: 'action_list' }),
			makeItem({ title: 'Outro', itemKey: 't2', hint: 'action_list' })
		];
		setBrowseResult(
			listResult({ level: 2, title: 'Short EP', items }),
			'browse'
		);
		renderClassic();
		await tick();

		expect(screen.getByRole('button', { name: 'Play Intro' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Play Outro' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Play Album' })).toBeInTheDocument();
	});

	it('reopen P1: mixed-typing playlist with "N Tracks" subtitle does NOT reintroduce search-this-artist bug', async () => {
		// Reviewer caught: inferredAllTracks was defined as
		// `isTrackList && !actionListRows.some(isTrackItem)`. One
		// itemType=track sibling flipped it to false, isAlbumPage()
		// then returned true, and the subtitle ("321 Tracks") became
		// a clickable search-this-artist button — re-triggering the
		// original cascade bug. Fix: NON_ALBUM_COLLECTION_TITLES
		// signal forces inferredAllTracks=true on playlist/tag/mix
		// pages regardless of any one sibling's itemType.
		const items: BrowseItem[] = [
			makeItem({ title: 'Play Playlist', itemKey: 'pa', hint: 'action_list' }),
			makeItem({ title: 'Typed Track', itemKey: 't1', hint: 'action_list', itemType: 'track' }),
			makeItem({ title: 'Hey Jude', itemKey: 't2', hint: 'action_list' }),
			makeItem({ title: 'Imagine', itemKey: 't3', hint: 'action_list' }),
			makeItem({ title: 'Yesterday', itemKey: 't4', hint: 'action_list' }),
			makeItem({ title: 'Let It Be', itemKey: 't5', hint: 'action_list' })
		];
		setBrowseResult(
			listResult({
				level: 2,
				title: 'Mixed Playlist',
				subtitle: '321 Tracks',
				items
			}),
			'browse'
		);
		renderClassic();
		await tick();

		// Subtitle stays as static text — NO clickable search button.
		expect(screen.queryByRole('button', { name: '321 Tracks' })).toBeNull();
		expect(screen.getByText('321 Tracks')).toBeInTheDocument();
		// No album chips either (this is not an album).
		expect(screen.queryByLabelText('Album metadata')).toBeNull();
		// Tracks still render correctly.
		expect(screen.getByRole('button', { name: 'Play Typed Track' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Play Hey Jude' })).toBeInTheDocument();
	});

	it('reopen P1: real album page (Play Album + all typed tracks + artist subtitle) STILL renders artist link + chips', async () => {
		// Regression guard: "Play Album" is intentionally NOT in
		// NON_ALBUM_COLLECTION_TITLES, so a real album page keeps
		// isAlbumPage=true and the artist-link / chips still render.
		const items: BrowseItem[] = [
			makeItem({ title: 'Play Album', itemKey: 'pa', hint: 'action_list' }),
			makeItem({ title: '1. Pretty Good Year', itemKey: 't1', hint: 'action_list', itemType: 'track' }),
			makeItem({ title: '2. God', itemKey: 't2', hint: 'action_list', itemType: 'track' }),
			makeItem({ title: '3. Bells for Her', itemKey: 't3', hint: 'action_list', itemType: 'track' }),
			makeItem({ title: '4. Past the Mission', itemKey: 't4', hint: 'action_list', itemType: 'track' }),
			makeItem({ title: '5. Baker Baker', itemKey: 't5', hint: 'action_list', itemType: 'track' })
		];
		setBrowseResult(
			listResult({
				level: 2,
				title: 'Under the Pink',
				subtitle: 'Tilda Arlen · 1994 · FLAC',
				items
			}),
			'browse'
		);
		renderClassic();
		await tick();

		// Artist link still renders.
		expect(screen.getByRole('button', { name: 'Tilda Arlen' })).toBeInTheDocument();
		// Album chips still render.
		expect(screen.getByLabelText('Album metadata')).toBeInTheDocument();
	});

	it('live regression: untyped track rows stay as tracks even when one sibling has itemType=track', async () => {
		// Observed shape from a 321-track user playlist that rendered
		// every row as a blue-pill: most rows were untyped action_list
		// with non-numeric song titles, but ONE row happened to be
		// typed `track` (or had a numeric prefix). Pre-fix the
		// pageActions/trackItems split used !isTrackItem to mean "page
		// action" — that one typed row flipped inferredAllTracks=false
		// and sent every untyped sibling into pageActions as pills.
		const items: BrowseItem[] = [
			makeItem({ title: 'Play Playlist', itemKey: 'pa', hint: 'action_list' }),
			// One row Roon happens to type as `track`:
			makeItem({ title: 'Properly Typed Track', itemKey: 't1', hint: 'action_list', itemType: 'track' }),
			// All siblings: untyped action_list, normal song titles.
			makeItem({ title: 'Hey Jude', itemKey: 't2', hint: 'action_list' }),
			makeItem({ title: 'Imagine', itemKey: 't3', hint: 'action_list' }),
			makeItem({ title: 'Yesterday', itemKey: 't4', hint: 'action_list' }),
			makeItem({ title: 'Let It Be', itemKey: 't5', hint: 'action_list' }),
			makeItem({ title: '321 Tracks', itemKey: 'meta', hint: 'list', isPlayable: false })
		];
		setBrowseResult(
			listResult({ level: 2, title: 'Mixed Playlist', items }),
			'browse'
		);
		renderClassic();
		await tick();

		// All real songs render as track rows (per-row Play <title> button),
		// regardless of itemType inconsistency between siblings.
		expect(screen.getByRole('button', { name: 'Play Properly Typed Track' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Play Hey Jude' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Play Imagine' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Play Yesterday' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Play Let It Be' })).toBeInTheDocument();
		// Page-level Play Playlist still a pill.
		expect(screen.getByRole('button', { name: 'Play Playlist' })).toBeInTheDocument();
		// No untyped sibling should appear as an .album-action-btn pill.
		const pills = document.querySelectorAll('.album-action-btn');
		expect(pills).toHaveLength(1); // just Play Playlist
		expect(pills[0].textContent?.trim()).toBe('Play Playlist');
	});

	it('reopen P2: Work page (Play Work + contextual "X by Y" row) STAYS as pills, not tracks', async () => {
		// Regression guard: "Play Work" is intentionally NOT in
		// COLLECTION_PAGE_ACTION_TITLES because its siblings on a
		// Work page are contextual recordings, not tracks. This
		// preserves the existing comment's "Work-style page" exclusion.
		const items: BrowseItem[] = [
			makeItem({ title: 'Play Work', itemKey: 'pw', hint: 'action_list' }),
			makeItem({
				title: 'On Ocean to Ocean by Tilda Arlen',
				itemKey: 'contextual',
				hint: 'action_list'
			})
		];
		setBrowseResult(
			listResult({ level: 2, title: 'Some Work', items }),
			'browse'
		);
		renderClassic();
		await tick();

		// Both rows render as pageAction pills.
		expect(screen.getByRole('button', { name: 'Play Work' })).toBeInTheDocument();
		expect(
			screen.getByRole('button', { name: 'On Ocean to Ocean by Tilda Arlen' })
		).toBeInTheDocument();
		// And no per-track play button.
		expect(screen.queryByRole('button', { name: /^Play On Ocean/ })).toBeNull();
	});

	it('roon "Not Found" placeholder: shows friendly explanation, not the confusing card', async () => {
		// Verified live from server logs (2026-05-17): clicking a smart
		// playlist returned action='list' / count=1 with a single item:
		//   {title:"Not Found", subtitle:null, image_key:null,
		//    item_key:"836:0"}  // no hint, no isPlayable, no isLoadable
		// Replicate the EXACT placeholder shape (no hint, no subtitle,
		// no image) so the tightened detector matches.
		setBrowseResult(
			listResult({
				level: 2,
				title: 'Last Year',
				subtitle: '453 Tracks',
				items: [
					{
						title: 'Not Found',
						itemKey: '836:0',
						isLoadable: false,
						isPlayable: false
						// no hint, no subtitle, no imageKey, no itemType
					}
				]
			}),
			'browse'
		);
		renderClassic();
		await tick();

		// The friendly message renders.
		expect(screen.getByText("Couldn't load this playlist's contents")).toBeInTheDocument();
		// The mention of smart playlists is the most helpful hint.
		expect(screen.getByText(/smart playlist/i)).toBeInTheDocument();
		// And NO ItemGrid card titled "Not Found" — that's the bug we
		// were replacing.
		expect(document.querySelector('.item-card')).toBeNull();
	});

	it('roon "Not Found" trim-tolerant: matches " Not Found " too', async () => {
		// Defensive: if Roon's payload has padding, still match.
		setBrowseResult(
			listResult({
				level: 2,
				title: 'Last Year',
				items: [
					{
						title: '  Not Found  ',
						itemKey: 'x',
						isLoadable: false,
						isPlayable: false
					}
				]
			}),
			'browse'
		);
		renderClassic();
		await tick();
		expect(screen.getByText("Couldn't load this playlist's contents")).toBeInTheDocument();
	});

	it('roon "Not Found" only triggers on exactly-one-item lists (regression guard)', async () => {
		// Don't pattern-match every list that contains a "Not Found"
		// row alongside real items — that could be valid content like
		// a song titled "Not Found" or an Albums list including a
		// genuinely-named album. Only trigger when the list is a
		// single-item placeholder.
		setBrowseResult(
			listResult({
				level: 2,
				title: 'Some Album',
				items: [
					makeItem({ title: 'Not Found', itemKey: '1', hint: 'list' }),
					makeItem({ title: 'Track 2', itemKey: '2', hint: 'list' })
				]
			}),
			'browse'
		);
		renderClassic();
		await tick();
		// Should NOT show the placeholder message.
		expect(screen.queryByText("Couldn't load this playlist's contents")).toBeNull();
	});

	it('reopen P1: legitimate single-item list with a track titled "Not Found" does NOT trigger placeholder', async () => {
		// Reviewer caught: the title-only detector would hide a real
		// album / playlist whose only track is legitimately titled
		// "Not Found" (Yusuf Islam single, a Nico song, etc.).
		// Tightened to require the full placeholder shape: no hint, no
		// subtitle, no image. A real track row has all three.
		setBrowseResult(
			listResult({
				level: 2,
				title: 'My Demos',
				items: [
					makeItem({
						title: 'Not Found',
						itemKey: 't1',
						hint: 'action_list',           // real track row
						subtitle: 'Some Indie Band',   // real artist
						imageKey: 'art-123'            // real artwork
					})
				]
			}),
			'browse'
		);
		renderClassic();
		await tick();

		// Placeholder UI must NOT render — this is legitimate content.
		expect(screen.queryByText("Couldn't load this playlist's contents")).toBeNull();
		// Real song row is still reachable (rendered via the track-list
		// path; ▶ button is labelled "Play Not Found").
		// (Note: a single action_list row may not pass isTrackList
		// thresholds — we just assert the placeholder didn't hijack.)
	});

	it('reopen P1: single item with subtitle but no hint does NOT trigger placeholder', async () => {
		// Edge case: an item titled "Not Found" with an artist subtitle
		// is presumably a real track Roon couldn't find artwork for —
		// still legitimate content, not the placeholder.
		setBrowseResult(
			listResult({
				level: 2,
				title: 'Something',
				items: [
					{
						title: 'Not Found',
						subtitle: 'Some Band',  // disqualifying signal
						itemKey: 't1',
						isLoadable: true,
						isPlayable: false
					}
				]
			}),
			'browse'
		);
		renderClassic();
		await tick();
		expect(screen.queryByText("Couldn't load this playlist's contents")).toBeNull();
	});

	it('reopen P1: single item with image but no hint does NOT trigger placeholder', async () => {
		setBrowseResult(
			listResult({
				level: 2,
				items: [
					{
						title: 'Not Found',
						imageKey: 'art-id',  // disqualifying signal
						itemKey: 't1',
						isLoadable: true,
						isPlayable: false
					}
				]
			}),
			'browse'
		);
		renderClassic();
		await tick();
		expect(screen.queryByText("Couldn't load this playlist's contents")).toBeNull();
	});

	it('still classifies a small action_list-only page (< size threshold, no isTrackItem matches) as NOT a track list', async () => {
		// Regression guard: the relaxation of every(action_list) must
		// not also relax the "Work" page heuristic. Two action_list
		// rows that aren't tracks should stay as pageActions, not
		// trigger inferredAllTracks.
		setBrowseResult(
			listResult({
				level: 2,
				title: 'On Ocean to Ocean',
				items: [
					makeItem({ title: 'Play Work', itemKey: 'pw', hint: 'action_list' }),
					makeItem({
						title: 'On Ocean to Ocean by Tilda Arlen',
						itemKey: 'contextual',
						hint: 'action_list'
					})
				]
			}),
			'browse'
		);
		renderClassic();
		await tick();

		// Both render as page-action pills, not as track rows.
		expect(screen.getByRole('button', { name: 'Play Work' })).toBeInTheDocument();
		expect(
			screen.getByRole('button', { name: 'On Ocean to Ocean by Tilda Arlen' })
		).toBeInTheDocument();
		// No per-track play button.
		expect(screen.queryByRole('button', { name: /^Play On Ocean/ })).toBeNull();
	});
});
