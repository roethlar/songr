import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import * as navigation from '$lib/libraryPageNavigation';
import { decodeLibraryRoute } from '$lib/libraryRoute';
import { libraryPageStateFromRoute } from '$lib/libraryRouteState';
import type { CommittedLibraryModeActivation } from '$lib/libraryModeActivationContext';
import type { LibraryOpenResponse, LibraryLevelRow } from '@shared/libraryOpenContracts';
import type { LibraryPreviewResponse } from '@shared/libraryPreviewContracts';
import { __getNavigationLog, __resetNavigation } from '../../../test/app-stubs/navigation';
import { genrePage, genrePrefix, genreRow } from '../../../test/fixtures/genrePreviews';
import { genrePreviewMeasurement } from '../../../test/fixtures/genrePreviewMeasurement';
import { deferred, fakeConnectionSocket, harnessLibrary, mountMode } from './unifiedLibraryModeHarness';

const genreUrl = 'http://localhost/library/genres/Alt.%20Rock';
function level(title: string, rows: readonly LibraryLevelRow[], generation = 'gen-1'): LibraryOpenResponse {
	return { contract: 'library-open-v1', kind: 'level', generation, title, count: rows.length, rows };
}
function mount(options: Parameters<typeof mountMode>[0] = {}) {
	const socket = fakeConnectionSocket(); socket.connected = true;
	const h = mountMode({ withContext: true, liveLibrary: harnessLibrary(), getSocketClient: () => socket,
		openLiveRoot: async () => level('Genres', [genreRow('genre', 'Alt. Rock', 'genre')]),
		openLiveRef: async (_fetch, ref) => {
			if (ref.token === 'genre') return genrePage().level!;
			if (ref.token === 'artists') return level('Artists', genrePrefix('artist', 17).rows);
			if (ref.token === 'albums' || ref.token.startsWith('artist-')) return level(ref.token === 'albums' ? 'Albums' : 'artist 0', genrePrefix('album', 17).rows);
			return level('album 0', [genreRow('track-0', 'Track 0', 'track')]);
		},
		previewLiveSection: async (_fetch, ref, limit) => genrePrefix(ref.token === 'artists' ? 'artist' : 'album', limit),
		...options });
	return { ...h, socket };
}
function restore(h: ReturnType<typeof mount>, url = genreUrl) {
	const route = decodeLibraryRoute(new URL(url)); if (!route) throw new Error('bad test route');
	h.registered.lifecycle!.resume({ cause: 'initial', pageState: libraryPageStateFromRoute(route) } as CommittedLibraryModeActivation);
}
async function ready() { await waitFor(() => expect(screen.getAllByTestId('genre-preview-album')).toHaveLength(3)); }

describe('genre preview navigation and host lifecycle', () => {
	beforeEach(() => { __resetNavigation(genreUrl); navigation.clearPendingLibraryPageStateWrite(); genrePreviewMeasurement(); });
	afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
	it('reads only measured prefixes, supplies exact section paths, and opens clicked refs without full reads', async () => {
		const h = mount(); restore(h); await ready();
		expect(h.previewLiveSection.mock.calls.map(([, ref, limit]) => [ref.token, limit])).toEqual([['artists', 3], ['albums', 3]]);
		expect(h.openLiveRef.mock.calls.map(([, ref]) => ref.token)).toEqual(['genre']);
		const artist = screen.getAllByTestId('genre-preview-artist')[0];
		expect(artist).toHaveAttribute('href', '/library/genres/path/genre;Alt.%20Rock;;/section;Artists;;/artist;artist%200;;');
		expect(screen.getByRole('link', { name: 'More albums' })).toHaveAttribute('href', '/library/genres/path/genre;Alt.%20Rock;;/section;Albums;;');
		await fireEvent.click(artist); expect(await screen.findByTestId('unified-artist-name')).toHaveTextContent('artist 0');
		expect(h.openLiveRef.mock.calls.map(([, ref]) => ref.token)).toEqual(['genre', 'artist-0']);
		expect(__getNavigationLog().filter(entry => entry.operation === 'pushState')).toHaveLength(1);
	});
	it.each(['artist', 'album'] as const)('More %s opens the complete list, not the preview prefix', async kind => {
		const h = mount(); restore(h); await ready();
		await fireEvent.click(screen.getByRole('link', { name: `More ${kind}s` }));
		await waitFor(() => expect(screen.getByTestId('unified-live-collection-page')).toHaveAttribute('data-level-kind', 'section'));
		expect(h.openLiveRef.mock.calls.at(-1)?.[1].token).toBe(`${kind}s`);
		if (kind === 'album') expect(await screen.findAllByTestId('unified-live-album')).toHaveLength(17);
		else expect(await screen.findAllByTestId(/^unified-live-artist-/)).toHaveLength(17);
	});
	it.each(['offline', 'refused'] as const)('%s navigation preserves the overview, URL and pending previews', async refusal => {
		const h = mount(); restore(h); await ready(); const log = __getNavigationLog(), reads = h.openLiveRef.mock.calls.length;
		if (refusal === 'offline') h.socket.connected = false;
		else vi.spyOn(navigation, 'pushLibraryPageState').mockReturnValue('refused');
		await fireEvent.click(screen.getAllByTestId('genre-preview-album')[0]);
		await fireEvent.click(screen.getByRole('link', { name: 'More artists' }));
		expect(screen.getByTestId('genre-overview')).toBeVisible(); expect(__getNavigationLog()).toEqual(log);
		expect(h.openLiveRef).toHaveBeenCalledTimes(reads);
	});
	it.each(['artist', 'album'] as const)('a fresh preview %s address walks complete section levels before opening the item', async kind => {
		const h = mount(); restore(h); await ready();
		const href = screen.getAllByTestId(`genre-preview-${kind}`)[0].getAttribute('href')!;
		h.unmount(); const url = new URL(href, genreUrl).href; __resetNavigation(url);
		const fresh = mount(); restore(fresh, url);
		await screen.findByTestId(kind === 'artist' ? 'unified-artist-name' : 'unified-album-title');
		await waitFor(() => expect(fresh.openLiveRef.mock.calls.map(([, ref]) => ref.token)).toEqual(['genre', `${kind}s`, `${kind}-0`]));
		await fireEvent.click(screen.getByRole('button', { name: /^← / }));
		await waitFor(() => expect(screen.getByTestId('unified-live-collection-page')).toHaveAttribute('data-level-kind', 'section'));
		expect(screen.getByTestId('unified-live-collection-title')).toHaveTextContent(kind === 'artist' ? 'Artists' : 'Albums');
		expect(__getNavigationLog().at(-1)).toMatchObject({ operation: 'replaceState',
			url: `http://localhost/library/genres/path/genre;Alt.%20Rock;;/section;${kind === 'artist' ? 'Artists' : 'Albums'};;` });
	});
	it('owned in-app Back uses the preceding overview history entry', async () => {
		const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
		const h = mount(); restore(h); await ready();
		await fireEvent.click(screen.getAllByTestId('genre-preview-album')[0]);
		await screen.findByTestId('unified-album-title');
		await fireEvent.click(screen.getByRole('button', { name: /^← / }));
		expect(back).toHaveBeenCalledTimes(1);
		expect(__getNavigationLog().filter(entry => entry.operation === 'replaceState')).toHaveLength(0);
	});
	it('replacement roots re-resolve sections and ignore the prior generation prefix', async () => {
		let generation = 'gen-1'; const pending = deferred<LibraryPreviewResponse>();
		const h = mount({ openLiveRoot: async () => level('Genres', [genreRow('genre', 'Alt. Rock', 'genre', generation)], generation),
			openLiveRef: async () => genrePage([genreRow('artists', 'Artists', 'section', generation), genreRow('albums', 'Albums', 'section', generation)], generation).level!,
			previewLiveSection: async (_fetch, ref, limit) => ref.generation === 'gen-1' ? pending.promise : genrePrefix(ref.token === 'artists' ? 'artist' : 'album', limit, 17, generation) });
		restore(h); await waitFor(() => expect(h.previewLiveSection).toHaveBeenCalledTimes(1));
		generation = 'gen-2'; h.rootsStore.update(state => ({ ...state, generation }));
		await waitFor(() => expect(h.openLiveRef.mock.calls.at(-1)?.[1].generation).toBe('gen-2'));
		pending.resolve(genrePrefix('artist', 3)); await ready();
		expect(h.previewLiveSection.mock.calls.map(([, ref]) => [ref.generation, ref.token])).toEqual([
			['gen-1', 'artists'], ['gen-2', 'artists'], ['gen-2', 'albums']]);
	});
	it('restored addresses detect a duplicate artist beyond N rather than claiming preview uniqueness', async () => {
		const h = mount(); restore(h); await ready(); const href = screen.getAllByTestId('genre-preview-artist')[0].getAttribute('href')!;
		h.unmount(); const url = new URL(href, genreUrl).href; __resetNavigation(url);
		const fresh = mount({ openLiveRef: async (_fetch, ref) => ref.token === 'genre' ? genrePage().level! : level('Artists',
			[...genrePrefix('artist', 17).rows, genreRow('duplicate-beyond-prefix', 'artist 0', 'artist')]) });
		restore(fresh, url);
		expect(await screen.findByTestId('unified-library-group-candidates')).toBeVisible();
		expect(fresh.openLiveRef.mock.calls.map(([, ref]) => ref.token)).toEqual(['genre', 'artists']);
	});
	it.each(['scope', 'suspend', 'replacement'] as const)('retires in-flight previews synchronously on %s without another old read', async leave => {
		const pending = deferred<LibraryPreviewResponse>(); const h = mount({ previewLiveSection: async () => pending.promise });
		restore(h); await waitFor(() => expect(h.previewLiveSection).toHaveBeenCalledTimes(1));
		if (leave === 'scope') await fireEvent.click(screen.getByTestId('unified-scope-albums'));
		if (leave === 'suspend') h.registered.lifecycle!.suspend();
		if (leave === 'replacement') await fireEvent.click(screen.getByRole('link', { name: 'More albums' }));
		await tick(); pending.resolve(genrePrefix('artist', 3)); await tick(); await new Promise(resolve => setTimeout(resolve, 30));
		expect(h.previewLiveSection).toHaveBeenCalledTimes(1); expect(screen.queryByTestId('genre-preview-artist')).toBeNull();
	});
	it('retries a stale preview only once automatically per generation; explicit Retry reacquires both sections', async () => {
		let stale = true; const h = mount({ previewLiveSection: async (_fetch, ref, limit) => stale
			? { contract: 'library-preview-v1', kind: 'stale' } : genrePrefix(ref.token === 'artists' ? 'artist' : 'album', limit) });
		restore(h);
		await waitFor(() => expect(h.previewLiveSection).toHaveBeenCalledTimes(2));
		await screen.findByRole('button', { name: 'Retry artists preview' });
		await new Promise(resolve => setTimeout(resolve, 200)); expect(h.previewLiveSection).toHaveBeenCalledTimes(2);
		expect(h.openLiveRoot).toHaveBeenCalledTimes(2);
		stale = false; await fireEvent.click(screen.getByRole('button', { name: 'Retry artists preview' })); await ready();
		expect(h.previewLiveSection).toHaveBeenCalledTimes(4); expect(h.openLiveRoot).toHaveBeenCalledTimes(3);
	});
	it('keeps a failed recovery actionable and ignores its completion after leaving the genre', async () => {
		const pending = deferred<void>(); const loadRoots = vi.fn(async () => pending.promise);
		const h = mount({ loadRoots, previewLiveSection: async () => ({ contract: 'library-preview-v1', kind: 'stale' }) });
		restore(h); await screen.findByRole('button', { name: 'Retry albums preview' });
		await fireEvent.click(screen.getByTestId('unified-scope-albums')); const reads = h.openLiveRoot.mock.calls.length;
		pending.resolve(); await tick(); expect(h.openLiveRoot).toHaveBeenCalledTimes(reads);
		expect(screen.queryByTestId('genre-overview')).toBeNull();
		expect(__getNavigationLog().at(-1)?.url).toBe('http://localhost/library/albums');
	});
	it('recovery rejection leaves explicit Retry available and a later retry succeeds', async () => {
		let failing = true;
		const loadRoots = vi.fn(async () => { if (loadRoots.mock.calls.length > 1 && failing) throw new Error('Core unavailable'); });
		const h = mount({ loadRoots,
			previewLiveSection: async (_fetch, ref, limit) => failing ? { contract: 'library-preview-v1', kind: 'stale' }
				: genrePrefix(ref.token === 'artists' ? 'artist' : 'album', limit) });
		restore(h); await screen.findByRole('button', { name: 'Retry artists preview' });
		expect(loadRoots).toHaveBeenCalledTimes(2);
		await new Promise(resolve => setTimeout(resolve, 30)); expect(h.previewLiveSection).toHaveBeenCalledTimes(1);
		failing = false; await fireEvent.click(screen.getByRole('button', { name: 'Retry artists preview' })); await ready();
		expect(h.previewLiveSection).toHaveBeenCalledTimes(3);
	});
});
