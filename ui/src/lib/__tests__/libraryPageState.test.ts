import { describe, expect, it } from 'vitest';
import {
	UNIFIED_FILTER_TEXT_MAX_LENGTH,
	UNIFIED_BROWSE_RESTORE_COUNT_MAX,
	UNIFIED_LABEL_MAX_LENGTH,
	UNIFIED_ITEM_ORIGIN_NAME_MAX_LENGTH,
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
import { COLLECTION_DRILL_SOURCE_CONTRACT } from '@shared/collectionDrillContracts';

const COLLECTION_LOCATOR = {
	sourceContract: COLLECTION_DRILL_SOURCE_CONTRACT,
	hierarchy: 'genres' as const,
	collectionExactName: 'Bright Machinery',
	rendering: { exactTitle: 'Harbour Lantern', exactCredit: 'The Paper Fleet' }
};

/** A live address whose last step names an album page. */
const LIVE_ALBUM_PATH = {
	origin: 'artists' as const,
	steps: [
		{ kind: 'artist' as const, title: 'The Paper Fleet' },
		{ kind: 'album' as const, title: 'Harbour Lantern', credit: 'The Paper Fleet' }
	]
};

/** A live address whose last step names an artist page, not an album. */
const LIVE_ARTIST_PATH = {
	origin: 'artists' as const,
	steps: [{ kind: 'artist' as const, title: 'The Paper Fleet' }]
};

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

/**
 * The shared current-shape snapshot. It carries NO item target on purpose: the
 * legacy-promotion tests replay this same body under the v5–v8 version tags,
 * and the only item targets those tiers could carry were the catalog `artist`
 * and `album` arms, which Slice 4 deleted. `null` is the one item-target value
 * legal in every tier, so one fixture still serves them all.
 *
 * Tests that need an open album page use `albumPageSnapshot()` below.
 */
function unifiedSnapshot(): UnifiedLibrarySnapshot {
	return {
		scope: 'genres',
		collectionDrill: { kind: 'genre', label: 'Ambient' },
		itemTarget: null,
		itemDetail: null,
		composition: null,
		itemOriginName: null,
		filterText: 'brian',
		surpriseSeed: 42,
		density: 'compact',
		browseHistory: browseSnapshot()
	};
}

/**
 * An open album page in the current shape. Since Slice 4 the only album page
 * named by a durable, re-findable identity is one opened from a collection
 * drill, so the collection locator is what an "album parent context" now is.
 */
function albumPageSnapshot(): UnifiedLibrarySnapshot {
	return {
		...unifiedSnapshot(),
		collectionDrill: { kind: 'genre', label: 'Bright Machinery' },
		itemTarget: { kind: 'collection', locator: COLLECTION_LOCATOR }
	};
}

/** The v6 snapshot shape (item split, no child/composition surfaces). */
function legacyV6Snapshot(): Record<string, unknown> {
	const { itemDetail, composition, itemOriginName, ...rest } = unifiedSnapshot();
	void itemDetail;
	void composition;
	void itemOriginName;
	return rest as unknown as Record<string, unknown>;
}

/** The v7 snapshot shape (item origin name not yet introduced, issue #6). */
function legacyV7Snapshot(): Record<string, unknown> {
	const { itemOriginName, ...rest } = unifiedSnapshot();
	void itemOriginName;
	return rest as unknown as Record<string, unknown>;
}

/** The v5-and-earlier snapshot shape (one drill union + openAlbumLocalId). */
function legacySnapshot(): Record<string, unknown> {
	return {
		scope: 'genres',
		drill: { kind: 'genre', label: 'Ambient' },
		filterText: 'brian',
		// A v5 payload that named a catalog album is now refused outright, so the
		// promotable v5 body is the one that named none. The refusal itself is
		// asserted in 'refuses a v5 catalog drill or open album…' below.
		openAlbumLocalId: null,
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
		// An open album page, so the item-target copy assertion below has a
		// non-null object to bite on.
		const source = albumPageSnapshot();
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

	it('normalizes v5 drills forward: collection drills survive the split', () => {
		// The v5 single `drill` union splits into the v6 pair; a genre drill
		// lands in `collectionDrill` and leaves `itemTarget` empty.
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

	it('refuses a v5 catalog drill or open album, which name nothing that exists', () => {
		// v5's artist and album drill arms, and its `openAlbumLocalId`, all named
		// a saved catalog record by controller-minted local id. The catalog is
		// gone, so there is nothing such an id could resolve to. These are
		// REFUSED rather than migrated: the caller then restores the scope the
		// state belonged to, which beats opening a page for a record that is not
		// there.
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
				})
			).toBeNull();
		}
		expect(
			normalizeLibraryPageState({
				libraryView: 'unified',
				schemaVersion: 5,
				snapshot: { ...legacySnapshot(), openAlbumLocalId: 'album-local-9' }
			})
		).toBeNull();
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

	it('promotes v7 state with no item origin name (issue #6)', () => {
		expect(
			normalizeLibraryPageState({
				libraryView: 'unified',
				schemaVersion: 7,
				snapshot: legacyV7Snapshot()
			})
		).toEqual({
			libraryView: 'unified',
			schemaVersion: UNIFIED_LIBRARY_PAGE_STATE_VERSION,
			snapshot: unifiedSnapshot()
		});
		// A v7 payload that smuggles the v8 key is not v7: reject.
		expect(
			normalizeLibraryPageState({
				libraryView: 'unified',
				schemaVersion: 7,
				snapshot: { ...legacyV7Snapshot(), itemOriginName: null }
			})
		).toBeNull();
	});

	it('promotes v8 state, which could not carry a collection item target', () => {
		expect(
			normalizeLibraryPageState({
				libraryView: 'unified',
				schemaVersion: 8,
				snapshot: unifiedSnapshot()
			})
		).toEqual({
			libraryView: 'unified',
			schemaVersion: UNIFIED_LIBRARY_PAGE_STATE_VERSION,
			snapshot: unifiedSnapshot()
		});
		// A v8 payload carrying a v9 item target is not v8: it was written by
		// something that did not know the rules of the version it claims, and
		// restoring it would be restoring a guess.
		expect(
			normalizeLibraryPageState({
				libraryView: 'unified',
				schemaVersion: 8,
				snapshot: {
					...unifiedSnapshot(),
					itemTarget: { kind: 'collection', locator: COLLECTION_LOCATOR }
				}
			})
		).toBeNull();
	});

	it('restores an album opened from a genre drill by its own locator (Slice 8d)', () => {
		const snapshot = {
			...unifiedSnapshot(),
			collectionDrill: { kind: 'genre' as const, label: 'Bright Machinery' },
			itemTarget: { kind: 'collection' as const, locator: COLLECTION_LOCATOR }
		};
		const restored = normalizeLibraryPageState({
			libraryView: 'unified',
			schemaVersion: UNIFIED_LIBRARY_PAGE_STATE_VERSION,
			snapshot
		});
		expect(restored?.snapshot.itemTarget).toEqual({
			kind: 'collection',
			locator: COLLECTION_LOCATOR
		});
	});

	it('refuses a collection item target whose locator does not hold up', () => {
		for (const locator of [
			{ ...COLLECTION_LOCATOR, hierarchy: 'albums' },
			{ ...COLLECTION_LOCATOR, collectionExactName: '' },
			{ ...COLLECTION_LOCATOR, rendering: { exactTitle: '' , exactCredit: '' } },
			{ ...COLLECTION_LOCATOR, extra: true }
		]) {
			expect(
				normalizeLibraryPageState({
					libraryView: 'unified',
					schemaVersion: UNIFIED_LIBRARY_PAGE_STATE_VERSION,
					snapshot: {
						...unifiedSnapshot(),
						itemTarget: { kind: 'collection', locator }
					}
				})
			).toBeNull();
		}
	});

	it('binds the item origin name to its album parent context (issue #6)', () => {
		const albumContext = { ...albumPageSnapshot(), itemOriginName: 'Brian Eno' };
		expect(
			normalizeLibraryPageState({
				libraryView: 'unified',
				schemaVersion: UNIFIED_LIBRARY_PAGE_STATE_VERSION,
				snapshot: albumContext
			})?.snapshot.itemOriginName
		).toBe('Brian Eno');
		// No collection-opened album parent → the origin label is not a
		// reconstructible back target: reject. A live album page is rejected too:
		// the rule is `collection` strictly, because the origin label describes
		// the drill a row was reached through, and a live path already carries
		// its own route back in its steps.
		for (const itemTarget of [
			null,
			{ kind: 'live', path: LIVE_ALBUM_PATH },
			{ kind: 'live', path: LIVE_ARTIST_PATH }
		]) {
			expect(
				normalizeLibraryPageState({
					libraryView: 'unified',
					schemaVersion: UNIFIED_LIBRARY_PAGE_STATE_VERSION,
					snapshot: { ...albumContext, itemTarget }
				})
			).toBeNull();
		}
		// Bounds and shape are strict. Built over the album-page snapshot, so a
		// rejection here is the origin name's own doing and not a missing parent.
		for (const itemOriginName of [
			'',
			'x'.repeat(UNIFIED_ITEM_ORIGIN_NAME_MAX_LENGTH + 1),
			42,
			{}
		]) {
			expect(
				normalizeLibraryPageState({
					libraryView: 'unified',
					schemaVersion: UNIFIED_LIBRARY_PAGE_STATE_VERSION,
					snapshot: { ...albumPageSnapshot(), itemOriginName }
				})
			).toBeNull();
		}
	});

	it('accepts an origin name longer than the generic label cap (gh6-1)', () => {
		// The display-text domain (512) exceeds the generic label cap (256); a
		// name in between must survive a persisted round-trip.
		const longName = 'x'.repeat(UNIFIED_LABEL_MAX_LENGTH + 1);
		const restored = normalizeLibraryPageState({
			libraryView: 'unified',
			schemaVersion: UNIFIED_LIBRARY_PAGE_STATE_VERSION,
			snapshot: { ...albumPageSnapshot(), itemOriginName: longName }
		});
		expect(restored?.snapshot.itemOriginName).toBe(longName);
	});

	it('binds the exact-track child to its album parent context (Slice 8)', () => {
		const withTrack = {
			...albumPageSnapshot(),
			itemDetail: { kind: 'track', title: 'Third movement' }
		};
		expect(
			normalizeLibraryPageState({
				libraryView: 'unified',
				schemaVersion: UNIFIED_LIBRARY_PAGE_STATE_VERSION,
				snapshot: withTrack
			})?.snapshot.itemDetail
		).toEqual({ kind: 'track', title: 'Third movement' });
		// A live album page is the other album parent a track child may hang from.
		expect(
			normalizeLibraryPageState({
				libraryView: 'unified',
				schemaVersion: UNIFIED_LIBRARY_PAGE_STATE_VERSION,
				snapshot: {
					...unifiedSnapshot(),
					collectionDrill: null,
					itemTarget: { kind: 'live', path: LIVE_ALBUM_PATH },
					itemDetail: { kind: 'track', title: 'Third movement' }
				}
			})?.snapshot.itemDetail
		).toEqual({ kind: 'track', title: 'Third movement' });
		// No album parent → the child is not reconstructible: reject. A live
		// path ending on an ARTIST page is not an album parent either, however
		// live it is.
		for (const itemTarget of [null, { kind: 'live', path: LIVE_ARTIST_PATH }]) {
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
			{ kind: 'track', title: '' },
			{ kind: 'track', title: 'x'.repeat(1_025) },
			{ kind: 'track', title: 1 },
			{ kind: 'track', title: 'Track', extra: true },
			{ kind: 'follow', title: 'Track' }
		]) {
			expect(
				normalizeLibraryPageState({
					libraryView: 'unified',
					schemaVersion: UNIFIED_LIBRARY_PAGE_STATE_VERSION,
					// Album-page parent, so each rejection is the child's own doing.
					snapshot: { ...albumPageSnapshot(), itemDetail }
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

	it('restores collection drills by label', () => {
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
			itemOriginName: null,
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

describe('the live view arm (library-live-view Slice 2, v10)', () => {
	const livePath = {
		origin: 'artists' as const,
		steps: [
			{ kind: 'artist' as const, title: '’Til Tuesday' },
			{ kind: 'album' as const, title: 'Voices Carry', credit: '’Til Tuesday' }
		]
	};

	function unified(itemTarget: unknown) {
		return {
			libraryView: 'unified',
			schemaVersion: UNIFIED_LIBRARY_PAGE_STATE_VERSION,
			snapshot: { ...unifiedSnapshot(), collectionDrill: null, itemTarget }
		};
	}

	it('carries a page address made of renderings, and hands it back unchanged', () => {
		const restored = normalizeLibraryPageState(unified({ kind: 'live', path: livePath }));
		expect(restored?.snapshot.itemTarget).toEqual({ kind: 'live', path: livePath });
	});

	it('refuses an address carrying anything but renderings', () => {
		// A reference is worth one generation; page state outlives generations.
		// One written down here would be a dead handle calling itself an address.
		expect(
			normalizeLibraryPageState(
				unified({ kind: 'live', path: livePath, ref: { generation: 'g', token: 't' } })
			)
		).toBeNull();
	});

	it('refuses an address with no steps, an empty title, or an unknown origin', () => {
		expect(
			normalizeLibraryPageState(unified({ kind: 'live', path: { origin: 'artists', steps: [] } }))
		).toBeNull();
		expect(
			normalizeLibraryPageState(
				unified({ kind: 'live', path: { origin: 'artists', steps: [{ kind: 'artist', title: '' }] } })
			)
		).toBeNull();
		expect(
			normalizeLibraryPageState(
				unified({
					kind: 'live',
					path: { origin: 'playlists', steps: [{ kind: 'artist', title: 'X' }] }
				})
			)
		).toBeNull();
	});

	it('keeps an empty credit, which is a real thing for Roon to have rendered', () => {
		const path = { origin: 'albums' as const, steps: [{ kind: 'album' as const, title: 'Untitled', credit: '' }] };
		const restored = normalizeLibraryPageState(unified({ kind: 'live', path }));
		expect(restored?.snapshot.itemTarget).toEqual({ kind: 'live', path });
	});

	it('refuses a live address in a v9 state, which could never have written one', () => {
		const v9 = { ...unified({ kind: 'live', path: livePath }), schemaVersion: 9 };
		expect(normalizeLibraryPageState(v9)).toBeNull();
	});

	it('normalizes a v9 state without a live address forward unchanged', () => {
		// v9's own item target was the collection locator, which survives; a v9
		// state carrying one still promotes to the current version untouched.
		const target = { kind: 'collection', locator: COLLECTION_LOCATOR };
		const v9 = { ...unified(target), schemaVersion: 9 };
		const restored = normalizeLibraryPageState(v9);
		expect(restored?.schemaVersion).toBe(UNIFIED_LIBRARY_PAGE_STATE_VERSION);
		expect(restored?.snapshot.itemTarget).toEqual(target);
	});
});
