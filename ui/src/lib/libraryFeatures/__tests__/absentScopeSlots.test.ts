import { describe, expect, it } from 'vitest';
import { get } from 'svelte/store';

import { libraryScopeSlots } from '../absentScopeSlots';

/**
 * The resolution a build with no extended library views gets. This suite
 * imports the absent module directly rather than through the
 * `@libraryFeatures` alias, so it asserts the same thing in a walled checkout
 * and a public one — a test of absence that only runs when the material is
 * already gone proves nothing about the build that ships.
 */

describe('absent library scope slots', () => {
	it('offers no view for either extended scope', () => {
		// Null, not a component rendering a disabled surface: the scope is
		// absent from this build, and the library surface renders its own hint.
		expect(libraryScopeSlots.mostPlayedView).toBeNull();
		expect(libraryScopeSlots.playlistsView).toBeNull();
	});

	it('reports nothing loaded, nothing loading and no error', () => {
		// "No error" is the truth. A build without the feature has not failed to
		// load it, and a surface that showed an error here would be lying.
		expect(get(libraryScopeSlots.mostPlayedStore)).toEqual({
			loading: false,
			loaded: false,
			error: null
		});
		expect(get(libraryScopeSlots.playlistsStore)).toEqual({
			loading: false,
			loaded: false,
			error: null,
			// The scope chip reports a total, and zero is the honest one.
			playlists: []
		});
	});

	it('resolves every loader instead of rejecting', async () => {
		// The surface asks whether a scope needs data before it renders anything.
		// An absent scope must not turn that question into an unhandled rejection.
		await expect(libraryScopeSlots.loadMostPlayed(fetch)).resolves.toBeUndefined();
		await expect(libraryScopeSlots.loadPlaylists(fetch)).resolves.toBeUndefined();
		await expect(libraryScopeSlots.openPlaylist(fetch, 'any-playlist')).resolves.toBeUndefined();
	});

	it('leaves the inert stores unchanged when the surface resets or closes', () => {
		expect(() => {
			libraryScopeSlots.resetMostPlayed();
			libraryScopeSlots.resetPlaylists();
			libraryScopeSlots.closePlaylist();
		}).not.toThrow();

		expect(get(libraryScopeSlots.mostPlayedStore).loaded).toBe(false);
		expect(get(libraryScopeSlots.playlistsStore).loaded).toBe(false);
	});
});
