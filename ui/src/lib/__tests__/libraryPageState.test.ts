import { describe, expect, it } from 'vitest';
import {
	CLASSIC_LIBRARY_PAGE_STATE_VERSION,
	TIMELINE_CAMERA_MAX_SCALE,
	TIMELINE_DISPLAY_DEPTH_MAX,
	TIMELINE_SEMANTIC_PATH_MAX_LENGTH,
	UNIFIED_FILTER_TEXT_MAX_LENGTH,
	UNIFIED_LIBRARY_PAGE_STATE_VERSION,
	buildClassicLibraryPageState,
	buildClassicRootPageState,
	buildLibraryPageStateEnvelope,
	buildLibraryViewRequestPageStateEnvelope,
	buildTimelineLibraryPageState,
	buildTimelineRootPageState,
	buildUnifiedLibraryPageState,
	buildUnifiedRootPageState,
	normalizeClassicHistorySnapshot,
	normalizeLibraryPageState,
	normalizeLibraryPageStateEnvelope,
	normalizeLibraryViewRequestPageStateEnvelope,
	pageStateForLibraryView,
	type ClassicHistorySnapshot,
	type TimelineLibrarySnapshot,
	type UnifiedLibrarySnapshot
} from '$lib/libraryPageState';

function classicSnapshot(): ClassicHistorySnapshot {
	return {
		context: { hierarchy: 'search', query: 'Miles Davis' },
		history: [
			{
				hierarchy: 'search',
				breadcrumb: {
					title: 'Albums',
					subtitle: '12 Results',
					searchCategory: true
				}
			}
		],
		forward: []
	};
}

function timelineSnapshot(): TimelineLibrarySnapshot {
	return {
		artistQuery: 'Björk',
		selectedArtistLocalId: 'artist-local-1',
		activeSemanticPath: [
			{ kind: 'artist', localId: 'artist-local-1' },
			{ kind: 'album', localId: 'album-local-2' }
		],
		selectedNode: { kind: 'album', localId: 'album-local-2' },
		camera: { x: 120.5, y: -48, scale: 1.5 },
		displayDepth: 1
	};
}

describe('Classic Library page state', () => {
	it('normalizes the exact keyless semantic shape into a defensive copy', () => {
		const source = classicSnapshot();
		const normalized = normalizeClassicHistorySnapshot(source);

		expect(normalized).toEqual(source);
		expect(normalized).not.toBe(source);
		expect(normalized?.history).not.toBe(source.history);
		expect(normalized?.history[0].breadcrumb).not.toBe(source.history[0].breadcrumb);

		source.history[0].breadcrumb.title = 'Changed';
		expect(normalized?.history[0].breadcrumb.title).toBe('Albums');
	});

	it('rejects authority-bearing or sparse breadcrumb paths', () => {
		const unsafe = classicSnapshot() as unknown as Record<string, unknown>;
		(
			(unsafe.history as Array<Record<string, unknown>>)[0] as Record<string, unknown>
		).itemKey = 'volatile-roon-key';
		expect(normalizeClassicHistorySnapshot(unsafe)).toBeNull();

		const sparse = classicSnapshot();
		(sparse.history[0].breadcrumb as { title?: string }).title = undefined;
		expect(normalizeClassicHistorySnapshot(sparse)).toBeNull();
	});

	it('rejects steps from a hierarchy other than the active context', () => {
		const mixed = classicSnapshot();
		mixed.forward.push({ hierarchy: 'browse', breadcrumb: { title: 'Genres' } });

		expect(normalizeClassicHistorySnapshot(mixed)).toBeNull();
	});

	it('builds browse-root and search-root states without live keys', () => {
		expect(buildClassicRootPageState()).toEqual({
			libraryView: 'classic',
			schemaVersion: CLASSIC_LIBRARY_PAGE_STATE_VERSION,
			snapshot: { context: { hierarchy: 'browse' }, history: [], forward: [] }
		});
		expect(buildClassicRootPageState({ hierarchy: 'search', query: 'Ambient' }).snapshot).toEqual({
			context: { hierarchy: 'search', query: 'Ambient' },
			history: [],
			forward: []
		});
	});

	it('keeps Classic and Timeline schema variants disjoint', () => {
		const state = buildClassicLibraryPageState(classicSnapshot());
		expect(normalizeLibraryPageState({ ...state, libraryView: 'timeline' })).toBeNull();
		expect(normalizeLibraryPageState({ ...state, schemaVersion: 999 })).toBeNull();
		expect(normalizeLibraryPageState({ ...state, itemKey: 'forbidden' })).toBeNull();
	});
});

describe('Timeline Library page state', () => {
	it('normalizes bounded stable IDs, path, camera, and display depth defensively', () => {
		const source = timelineSnapshot();
		const state = buildTimelineLibraryPageState(source);

		expect(normalizeLibraryPageState(state)).toEqual(state);
		expect(state.snapshot).not.toBe(source);
		expect(state.snapshot.activeSemanticPath).not.toBe(source.activeSemanticPath);
		expect(state.snapshot.camera).not.toBe(source.camera);

		source.activeSemanticPath[0].localId = 'changed';
		source.camera.x = 999;
		expect(state.snapshot.activeSemanticPath[0].localId).toBe('artist-local-1');
		expect(state.snapshot.camera.x).toBe(120.5);
	});

	it('provides a complete stable root', () => {
		expect(buildTimelineRootPageState().snapshot).toEqual({
			artistQuery: '',
			selectedArtistLocalId: null,
			activeSemanticPath: [],
			selectedNode: null,
			camera: { x: 0, y: 0, scale: 1 },
			displayDepth: 0
		});
	});

	it.each([
		['non-finite camera', { camera: { x: Number.NaN, y: 0, scale: 1 } }],
		['out-of-range scale', { camera: { x: 0, y: 0, scale: TIMELINE_CAMERA_MAX_SCALE + 1 } }],
		['fractional depth', { displayDepth: 1.5 }],
		['out-of-range depth', { displayDepth: TIMELINE_DISPLAY_DEPTH_MAX + 1 }],
		[
			'overlong path',
			{
				activeSemanticPath: Array.from(
					{ length: TIMELINE_SEMANTIC_PATH_MAX_LENGTH + 1 },
					(_, index) => ({ kind: 'album', localId: `album-${index}` })
				)
			}
		]
	])('rejects %s', (_label, patch) => {
		const snapshot = { ...timelineSnapshot(), ...patch };
		const raw = {
			libraryView: 'timeline',
			schemaVersion: 1,
			snapshot
		};
		expect(normalizeLibraryPageState(raw)).toBeNull();
	});

	it.each([
		[
			'root carrying a semantic path',
			{
				selectedArtistLocalId: null,
				activeSemanticPath: [{ kind: 'artist', localId: 'artist-local-1' }],
				selectedNode: { kind: 'artist', localId: 'artist-local-1' }
			}
		],
		['root carrying display depth', { selectedArtistLocalId: null, activeSemanticPath: [], selectedNode: null }],
		[
			'path rooted at a different artist',
			{ activeSemanticPath: [{ kind: 'artist', localId: 'artist-local-other' }] }
		],
		[
			'path not rooted at an artist',
			{ activeSemanticPath: [{ kind: 'album', localId: 'album-local-2' }] }
		],
		[
			'selected node outside the semantic path',
			{ selectedNode: { kind: 'album', localId: 'album-local-other' } }
		],
		[
			'repeated album path',
			{
				activeSemanticPath: [
					{ kind: 'artist', localId: 'artist-local-1' },
					{ kind: 'album', localId: 'album-local-1' },
					{ kind: 'album', localId: 'album-local-2' }
				],
				displayDepth: 2
			}
		],
		[
			'wrong primary-detail depth',
			{ displayDepth: 2 }
		]
	])('rejects a contradictory %s', (_label, patch) => {
		const snapshot = { ...timelineSnapshot(), ...patch };
		if (_label === 'root carrying display depth') snapshot.displayDepth = 2;
		expect(
			normalizeLibraryPageState({
				libraryView: 'timeline',
				schemaVersion: 1,
				snapshot
			})
		).toBeNull();
	});
});

describe('Unified Library page state', () => {
	function unifiedSnapshot(): UnifiedLibrarySnapshot {
		return {
			scope: 'genres',
			drill: { kind: 'genre', label: 'Ambient' },
			filterText: 'brian',
			openAlbumLocalId: 'album-local-9',
			surpriseSeed: 42,
			density: 'compact'
		};
	}

	it('normalizes the exact semantic shape into a defensive copy', () => {
		const source = unifiedSnapshot();
		const state = buildUnifiedLibraryPageState(source);

		expect(state).toEqual({
			libraryView: 'unified',
			schemaVersion: UNIFIED_LIBRARY_PAGE_STATE_VERSION,
			snapshot: source
		});
		expect(state.snapshot).not.toBe(source);
		expect(state.snapshot.drill).not.toBe(source.drill);

		source.drill = { kind: 'genre', label: 'Changed' };
		expect(state.snapshot.drill).toEqual({ kind: 'genre', label: 'Ambient' });
	});

	it('restores artists and albums by localId and genres and composers by label', () => {
		for (const kind of ['artist', 'album'] as const) {
			const byLocalId = buildUnifiedLibraryPageState({
				...unifiedSnapshot(),
				scope: 'artists',
				drill: { kind, localId: 'local-1' }
			});
			expect(normalizeLibraryPageState(byLocalId)).toEqual(byLocalId);
			expect(() =>
				buildUnifiedLibraryPageState({
					...unifiedSnapshot(),
					drill: { kind, label: 'no labels for catalog kinds' } as never
				})
			).toThrow(TypeError);
		}
		expect(() =>
			buildUnifiedLibraryPageState({
				...unifiedSnapshot(),
				drill: { kind: 'genre', localId: 'no ids for label kinds' } as never
			})
		).toThrow(TypeError);
		for (const kind of ['genre', 'composer'] as const) {
			const byLabel = buildUnifiedLibraryPageState({
				...unifiedSnapshot(),
				drill: { kind, label: 'Philip Glass' }
			});
			expect(normalizeLibraryPageState(byLabel)).toEqual(byLabel);
		}
		expect(() =>
			buildUnifiedLibraryPageState({
				...unifiedSnapshot(),
				scope: 'composers'
			} as never)
		).toThrow(TypeError);
	});

	it('rejects hostile, sparse, or out-of-bounds snapshots', () => {
		const base = buildUnifiedLibraryPageState(unifiedSnapshot());
		const withSnapshot = (snapshot: unknown): unknown => ({
			libraryView: 'unified',
			schemaVersion: UNIFIED_LIBRARY_PAGE_STATE_VERSION,
			snapshot
		});

		expect(normalizeLibraryPageState(base)).toEqual(base);
		expect(
			normalizeLibraryPageState(withSnapshot({ ...unifiedSnapshot(), extra: 1 }))
		).toBeNull();
		expect(
			normalizeLibraryPageState(withSnapshot({ ...unifiedSnapshot(), scope: 'tracks' }))
		).toBeNull();
		expect(
			normalizeLibraryPageState(
				withSnapshot({
					...unifiedSnapshot(),
					filterText: 'x'.repeat(UNIFIED_FILTER_TEXT_MAX_LENGTH + 1)
				})
			)
		).toBeNull();
		expect(
			normalizeLibraryPageState(withSnapshot({ ...unifiedSnapshot(), surpriseSeed: -1 }))
		).toBeNull();
		expect(
			normalizeLibraryPageState(withSnapshot({ ...unifiedSnapshot(), surpriseSeed: 1.5 }))
		).toBeNull();
		expect(
			normalizeLibraryPageState(withSnapshot({ ...unifiedSnapshot(), density: 'huge' }))
		).toBeNull();
		expect(
			normalizeLibraryPageState(withSnapshot({ ...unifiedSnapshot(), openAlbumLocalId: '' }))
		).toBeNull();
		expect(
			normalizeLibraryPageState(
				withSnapshot({
					...unifiedSnapshot(),
					drill: { kind: 'genre', label: 'Ambient', itemKey: 'forbidden' }
				})
			)
		).toBeNull();
	});

	it('provides a stable root for every scope and the view resolver', () => {
		expect(buildUnifiedRootPageState()).toEqual({
			libraryView: 'unified',
			schemaVersion: UNIFIED_LIBRARY_PAGE_STATE_VERSION,
			snapshot: {
				scope: 'artists',
				drill: null,
				filterText: '',
				openAlbumLocalId: null,
				surpriseSeed: null,
				density: null
			}
		});
		expect(buildUnifiedRootPageState('recently-played').snapshot.scope).toBe(
			'recently-played'
		);
		expect(buildUnifiedRootPageState('recently-added').snapshot.scope).toBe('recently-added');
		expect(buildUnifiedRootPageState('playlists').snapshot.scope).toBe('playlists');
		expect(pageStateForLibraryView('unified')).toEqual(buildUnifiedRootPageState());
	});

	it('keeps Unified schema variants disjoint from Classic and Timeline', () => {
		const state = buildUnifiedLibraryPageState(unifiedSnapshot());
		expect(normalizeLibraryPageState({ ...state, libraryView: 'classic' })).toBeNull();
		expect(normalizeLibraryPageState({ ...state, libraryView: 'timeline' })).toBeNull();
		expect(normalizeLibraryPageState({ ...state, schemaVersion: 999 })).toBeNull();
	});

	it('accepts a Unified view request envelope', () => {
		const envelope = buildLibraryViewRequestPageStateEnvelope('unified');
		expect(normalizeLibraryViewRequestPageStateEnvelope(envelope)).toEqual(
			envelope.libraryRequest
		);
		expect(
			normalizeLibraryPageStateEnvelope(
				buildLibraryPageStateEnvelope(buildUnifiedLibraryPageState(unifiedSnapshot()))
			)
		).toEqual(buildUnifiedLibraryPageState(unifiedSnapshot()));
	});
});

describe('App.PageState Library envelope', () => {
	it('normalizes only the exact envelope and returns defensive state', () => {
		const state = buildClassicLibraryPageState(classicSnapshot());
		const envelope = buildLibraryPageStateEnvelope(state);
		const normalized = normalizeLibraryPageStateEnvelope(envelope);

		expect(normalized).toEqual(state);
		expect(normalized).not.toBe(state);
		expect(normalizeLibraryPageStateEnvelope({ ...envelope, unrelated: true })).toBeNull();
	});

	it('fails closed when a hostile object cannot be inspected', () => {
		const hostile = new Proxy(
			{},
			{
				getPrototypeOf() {
					throw new Error('uninspectable');
				}
			}
		);

		expect(normalizeLibraryPageStateEnvelope(hostile)).toBeNull();
	});
});

describe('App.PageState Library view request envelope', () => {
	it('keeps a requested mode strict and distinct from semantic history state', () => {
		const envelope = buildLibraryViewRequestPageStateEnvelope('timeline');

		expect(normalizeLibraryViewRequestPageStateEnvelope(envelope)).toEqual({
			libraryView: 'timeline',
			schemaVersion: 1
		});
		expect(normalizeLibraryPageStateEnvelope(envelope)).toBeNull();
		expect(normalizeLibraryViewRequestPageStateEnvelope({
			...envelope,
			library: buildClassicRootPageState()
		})).toBeNull();
		expect(normalizeLibraryViewRequestPageStateEnvelope({
			libraryRequest: { ...envelope.libraryRequest, itemKey: 'forbidden' }
		})).toBeNull();
	});
});
