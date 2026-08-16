import { describe, expect, it } from 'vitest';
import {
	UNIFIED_FILTER_TEXT_MAX_LENGTH,
	UNIFIED_BROWSE_RESTORE_COUNT_MAX,
	UNIFIED_LIBRARY_PAGE_STATE_VERSION,
	buildLibraryPageStateEnvelope,
	buildUnifiedLibraryPageState,
	buildUnifiedRootPageState,
	normalizeBrowseHistorySnapshot,
	normalizeLibraryPageState,
	normalizeLibraryPageStateEnvelope,
	type BrowseHistorySnapshot,
	type UnifiedLibrarySnapshot
} from '$lib/libraryPageState';

function browseSnapshot(): BrowseHistorySnapshot {
	return {
		context: { hierarchy: 'search', query: 'Miles Davis' },
		history: [
			{
				hierarchy: 'search',
				breadcrumb: { title: 'Albums', subtitle: '12 Results', searchCategory: true }
			}
		],
		forward: []
	};
}

function unifiedSnapshot(): UnifiedLibrarySnapshot {
	return {
		scope: 'genres',
		collectionDrill: { kind: 'genre', label: 'Ambient' },
		itemTarget: { kind: 'album', localId: 'album-local-9' },
		itemDetail: null,
		composition: null,
		filterText: 'brian',
		surpriseSeed: 42,
		density: 'compact',
		browseHistory: browseSnapshot()
	};
}

/** The v6 snapshot shape (item split, no child/composition surfaces). */
function legacyV6Snapshot(): Record<string, unknown> {
	const { itemDetail, composition, ...rest } = unifiedSnapshot();
	void itemDetail;
	void composition;
	return rest as unknown as Record<string, unknown>;
}

/** The v5-and-earlier snapshot shape (one drill union + openAlbumLocalId). */
function legacySnapshot(): Record<string, unknown> {
	return {
		scope: 'genres',
		drill: { kind: 'genre', label: 'Ambient' },
		filterText: 'brian',
		openAlbumLocalId: 'album-local-9',
		surpriseSeed: 42,
		density: 'compact',
		browseHistory: browseSnapshot()
	};
}

describe('Unified Browse history page state', () => {
	it('normalizes the exact keyless semantic shape into a defensive copy', () => {
		const source = browseSnapshot();
		const normalized = normalizeBrowseHistorySnapshot(source);

		expect(normalized).toEqual(source);
		expect(normalized).not.toBe(source);
		expect(normalized?.history).not.toBe(source.history);
		expect(normalized?.history[0].breadcrumb).not.toBe(source.history[0].breadcrumb);

		source.history[0].breadcrumb.title = 'Changed';
		expect(normalized?.history[0].breadcrumb.title).toBe('Albums');
	});

	it('rejects authority-bearing, sparse, or mixed-hierarchy paths', () => {
		const unsafe = browseSnapshot() as unknown as Record<string, unknown>;
		((unsafe.history as Array<Record<string, unknown>>)[0] as Record<string, unknown>).itemKey =
			'volatile-roon-key';
		expect(normalizeBrowseHistorySnapshot(unsafe)).toBeNull();

		const sparse = browseSnapshot();
		(sparse.history[0].breadcrumb as { title?: string }).title = undefined;
		expect(normalizeBrowseHistorySnapshot(sparse)).toBeNull();

		const mixed = browseSnapshot();
		mixed.forward.push({ hierarchy: 'browse', breadcrumb: { title: 'Genres' } });
		expect(normalizeBrowseHistorySnapshot(mixed)).toBeNull();

		const oversized = browseSnapshot() as BrowseHistorySnapshot & {
			history: Array<BrowseHistorySnapshot['history'][number] & { restoreCount: number }>;
		};
		oversized.history[0].restoreCount = UNIFIED_BROWSE_RESTORE_COUNT_MAX + 1;
		expect(normalizeBrowseHistorySnapshot(oversized)).toBeNull();
	});

	it('retains a bounded visible-row count without persisting Browse authority', () => {
		const source = browseSnapshot();
		source.history[0].restoreCount = 200;

		expect(normalizeBrowseHistorySnapshot(source)?.history[0]).toEqual({
			hierarchy: 'search',
			breadcrumb: { title: 'Albums', subtitle: '12 Results', searchCategory: true },
			restoreCount: 200
		});
	});
});

describe('Unified Library page state', () => {
	it('normalizes the exact semantic shape into a defensive copy', () => {
		const source = unifiedSnapshot();
		const state = buildUnifiedLibraryPageState(source);

		expect(state).toEqual({
			libraryView: 'unified',
			schemaVersion: UNIFIED_LIBRARY_PAGE_STATE_VERSION,
			snapshot: source
		});
		expect(state.snapshot).not.toBe(source);
		expect(state.snapshot.collectionDrill).not.toBe(source.collectionDrill);
		expect(state.snapshot.itemTarget).not.toBe(source.itemTarget);
		expect(state.snapshot.browseHistory).not.toBe(source.browseHistory);
	});

	it('normalizes v5 drills forward: item targets split from collection drills', () => {
		// A genre drill with an open album normalizes into BOTH v6 fields, so
		// restoring the album entry restores its parent context with it.
		expect(
			normalizeLibraryPageState({
				libraryView: 'unified',
				schemaVersion: 5,
				snapshot: legacySnapshot()
			})
		).toEqual({
			libraryView: 'unified',
			schemaVersion: UNIFIED_LIBRARY_PAGE_STATE_VERSION,
			snapshot: unifiedSnapshot()
		});

		for (const kind of ['artist', 'album'] as const) {
			expect(
				normalizeLibraryPageState({
					libraryView: 'unified',
					schemaVersion: 5,
					snapshot: {
						...legacySnapshot(),
						drill: { kind, localId: 'local-1' },
						openAlbumLocalId: null
					}
				})?.snapshot
			).toMatchObject({
				collectionDrill: null,
				itemTarget: { kind, localId: 'local-1' }
			});
		}
		expect(
			normalizeLibraryPageState({
				libraryView: 'unified',
				schemaVersion: 5,
				snapshot: {
					...legacySnapshot(),
					drill: { kind: 'composer', label: 'Philip Glass' },
					openAlbumLocalId: null
				}
			})?.snapshot
		).toMatchObject({
			collectionDrill: { kind: 'composer', label: 'Philip Glass' },
			itemTarget: null
		});
	});

	it('promotes v6 state with no child or composition surface (Slice 8)', () => {
		expect(
			normalizeLibraryPageState({
				libraryView: 'unified',
				schemaVersion: 6,
				snapshot: legacyV6Snapshot()
			})
		).toEqual({
			libraryView: 'unified',
			schemaVersion: UNIFIED_LIBRARY_PAGE_STATE_VERSION,
			snapshot: unifiedSnapshot()
		});
		// A v6 payload that smuggles the v7 keys is not v6: reject.
		expect(
			normalizeLibraryPageState({
				libraryView: 'unified',
				schemaVersion: 6,
				snapshot: { ...legacyV6Snapshot(), itemDetail: null }
			})
		).toBeNull();
	});

	it('binds the exact-track child to its album parent context (Slice 8)', () => {
		const withTrack = {
			...unifiedSnapshot(),
			itemDetail: { kind: 'track', trackIndex: 3 }
		};
		expect(
			normalizeLibraryPageState({
				libraryView: 'unified',
				schemaVersion: UNIFIED_LIBRARY_PAGE_STATE_VERSION,
				snapshot: withTrack
			})?.snapshot.itemDetail
		).toEqual({ kind: 'track', trackIndex: 3 });
		// No album parent → the child is not reconstructible: reject.
		for (const itemTarget of [null, { kind: 'artist', localId: 'a-1' }]) {
			expect(
				normalizeLibraryPageState({
					libraryView: 'unified',
					schemaVersion: UNIFIED_LIBRARY_PAGE_STATE_VERSION,
					snapshot: { ...withTrack, itemTarget }
				})
			).toBeNull();
		}
		// Bounds and shape are strict.
		for (const itemDetail of [
			{ kind: 'track', trackIndex: -1 },
			{ kind: 'track', trackIndex: 500 },
			{ kind: 'track', trackIndex: 1.5 },
			{ kind: 'track', trackIndex: 1, extra: true },
			{ kind: 'follow', trackIndex: 1 }
		]) {
			expect(
				normalizeLibraryPageState({
					libraryView: 'unified',
					schemaVersion: UNIFIED_LIBRARY_PAGE_STATE_VERSION,
					snapshot: { ...unifiedSnapshot(), itemDetail }
				})
			).toBeNull();
		}
	});

	it('binds the composition surface to its composer drill context (Slice 8)', () => {
		const composerContext = {
			...unifiedSnapshot(),
			collectionDrill: { kind: 'composer', label: 'Philip Glass' },
			itemTarget: null
		};
		expect(
			normalizeLibraryPageState({
				libraryView: 'unified',
				schemaVersion: UNIFIED_LIBRARY_PAGE_STATE_VERSION,
				snapshot: { ...composerContext, composition: { title: 'Glassworks' } }
			})?.snapshot.composition
		).toEqual({ title: 'Glassworks' });
		expect(
			normalizeLibraryPageState({
				libraryView: 'unified',
				schemaVersion: UNIFIED_LIBRARY_PAGE_STATE_VERSION,
				snapshot: { ...composerContext, composition: { title: null } }
			})?.snapshot.composition
		).toEqual({ title: null });
		// A composition surface without its composer drill is rejected.
		expect(
			normalizeLibraryPageState({
				libraryView: 'unified',
				schemaVersion: UNIFIED_LIBRARY_PAGE_STATE_VERSION,
				snapshot: { ...unifiedSnapshot(), composition: { title: 'Glassworks' } }
			})
		).toBeNull();
	});

	it('promotes strict v3 state to the current version with a safe Browse root', () => {
		const { browseHistory: _browseHistory, ...withoutBrowse } = legacySnapshot();
		expect(
			normalizeLibraryPageState({
				libraryView: 'unified',
				schemaVersion: 3,
				snapshot: withoutBrowse
			})
		).toEqual({
			libraryView: 'unified',
			schemaVersion: UNIFIED_LIBRARY_PAGE_STATE_VERSION,
			snapshot: {
				...unifiedSnapshot(),
				browseHistory: { context: { hierarchy: 'browse' }, history: [], forward: [] }
			}
		});
	});

	it('promotes v4 state and accepts the Favorites scope', () => {
		expect(
			normalizeLibraryPageState({
				libraryView: 'unified',
				schemaVersion: 4,
				snapshot: { ...legacySnapshot(), scope: 'favorites' }
			})
		).toEqual({
			libraryView: 'unified',
			schemaVersion: UNIFIED_LIBRARY_PAGE_STATE_VERSION,
			snapshot: { ...unifiedSnapshot(), scope: 'favorites' }
		});
		expect(buildUnifiedRootPageState('favorites').snapshot.scope).toBe('favorites');
	});

	it('restores item targets by localId and collection drills by label', () => {
		for (const kind of ['artist', 'album'] as const) {
			const state = buildUnifiedLibraryPageState({
				...unifiedSnapshot(),
				scope: kind === 'artist' ? 'artists' : 'albums',
				collectionDrill: null,
				itemTarget: { kind, localId: 'local-1' }
			});
			expect(normalizeLibraryPageState(state)).toEqual(state);
		}
		for (const kind of ['genre', 'composer'] as const) {
			const state = buildUnifiedLibraryPageState({
				...unifiedSnapshot(),
				collectionDrill: { kind, label: 'Philip Glass' },
				itemTarget: null
			});
			expect(normalizeLibraryPageState(state)).toEqual(state);
		}
	});

	it('rejects Classic, unknown, hostile, or out-of-bounds state', () => {
		const base = buildUnifiedLibraryPageState(unifiedSnapshot());
		const withSnapshot = (snapshot: unknown): unknown => ({
			libraryView: 'unified',
			schemaVersion: UNIFIED_LIBRARY_PAGE_STATE_VERSION,
			snapshot
		});

		expect(normalizeLibraryPageState({ ...base, libraryView: 'classic' })).toBeNull();
		expect(normalizeLibraryPageState({ ...base, schemaVersion: 999 })).toBeNull();
		expect(normalizeLibraryPageState(withSnapshot({ ...unifiedSnapshot(), extra: 1 }))).toBeNull();
		expect(normalizeLibraryPageState(withSnapshot({ ...unifiedSnapshot(), scope: 'tracks' }))).toBeNull();
		expect(
			normalizeLibraryPageState(
				withSnapshot({
					...unifiedSnapshot(),
					filterText: 'x'.repeat(UNIFIED_FILTER_TEXT_MAX_LENGTH + 1)
				})
			)
		).toBeNull();
		expect(normalizeLibraryPageState(withSnapshot({ ...unifiedSnapshot(), density: 'huge' }))).toBeNull();
		expect(
			normalizeLibraryPageState(
				withSnapshot({
					...unifiedSnapshot(),
					collectionDrill: { kind: 'genre', label: 'Ambient', itemKey: 'forbidden' }
				})
			)
		).toBeNull();
		expect(
			normalizeLibraryPageState(
				withSnapshot({
					...unifiedSnapshot(),
					itemTarget: { kind: 'genre', label: 'Ambient' }
				})
			)
		).toBeNull();
		// A v6-shaped snapshot smuggled under the v5 version tag is rejected:
		// each version normalizes exactly its own shape.
		expect(
			normalizeLibraryPageState({
				libraryView: 'unified',
				schemaVersion: 5,
				snapshot: unifiedSnapshot()
			})
		).toBeNull();
	});

	it('provides the stable Unified root and exact App.PageState envelope', () => {
		const root = buildUnifiedRootPageState();
		expect(root.snapshot).toEqual({
			scope: 'artists',
			collectionDrill: null,
			itemTarget: null,
			itemDetail: null,
			composition: null,
			filterText: '',
			surpriseSeed: null,
			density: null,
			browseHistory: { context: { hierarchy: 'browse' }, history: [], forward: [] }
		});
		expect(buildUnifiedRootPageState('browse').snapshot.scope).toBe('browse');

		const envelope = buildLibraryPageStateEnvelope(root);
		expect(normalizeLibraryPageStateEnvelope(envelope)).toEqual(root);
		expect(normalizeLibraryPageStateEnvelope({ ...envelope, unrelated: true })).toBeNull();
	});

	it('fails closed when a hostile envelope cannot be inspected', () => {
		const hostile = new Proxy({}, {
			getPrototypeOf() {
				throw new Error('uninspectable');
			}
		});
		expect(normalizeLibraryPageStateEnvelope(hostile)).toBeNull();
	});
});
