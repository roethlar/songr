import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GenrePreviewController } from '../GenrePreviewController';
import { genrePreviewCapacity } from '../genrePreviewLayout';
import { libraryChildPath } from '../liveLibraryPath';
import { genrePage, genrePrefix, genreRow } from '../../../test/fixtures/genrePreviews';
import type { LibraryPreviewResponse } from '@shared/libraryPreviewContracts';
import type { LibraryRowReference } from '@shared/libraryRootsContracts';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function make() {
	const read = vi.fn(async (ref: LibraryRowReference, limit: number): Promise<LibraryPreviewResponse> => genrePrefix(ref.token === 'artists' ? 'artist' : 'album', limit));
	const isCurrent = vi.fn(() => true), canRetry = vi.fn(() => true), onStale = vi.fn();
	const controller = new GenrePreviewController({ read, isCurrent, canRetry, onStale });
	controller.setPage(genrePage(), 'gen-1', 1);
	return { controller, read, isCurrent, canRetry, onStale };
}
async function size(controller: GenrePreviewController, value: number) { controller.setCapacity(value); await vi.advanceTimersByTimeAsync(150); }

describe('GenrePreviewController', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());
	it('does not read at zero width; debounces capacity and reads Artists before Albums', async () => {
		const { controller, read } = make();
		await vi.advanceTimersByTimeAsync(500); expect(read).not.toHaveBeenCalled();
		const pending = deferred<LibraryPreviewResponse>(); read.mockReturnValueOnce(pending.promise);
		controller.setCapacity(4); await vi.advanceTimersByTimeAsync(149); expect(read).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1); expect(read.mock.calls).toEqual([[{ generation: 'gen-1', token: 'artists' }, 4]]);
		expect(controller.snapshot().album.phase).toBe('loading');
		pending.resolve(genrePrefix('artist', 4)); await settle();
		expect(read.mock.calls[1]).toEqual([{ generation: 'gen-1', token: 'albums' }, 4]);
		expect(controller.snapshot()).toMatchObject({ artist: { phase: 'ready' }, album: { phase: 'ready' } });
	});
	it('publishes Artists promptly while Albums is still pending', async () => {
		const { controller, read } = make(); const pending = deferred<LibraryPreviewResponse>();
		read.mockResolvedValueOnce(genrePrefix('artist', 3)).mockReturnValueOnce(pending.promise);
		await size(controller, 3);
		expect(controller.snapshot()).toMatchObject({ artist: { phase: 'ready' }, album: { phase: 'loading', preview: null } });
		pending.resolve(genrePrefix('album', 3, 0)); await settle();
		expect(controller.snapshot().album.preview?.totalCount).toBe(0);
	});
	it('ordinary failure does not block Albums, and Retry checks readiness before mutation', async () => {
		const { controller, read, canRetry } = make(); read.mockRejectedValueOnce(new Error('offline'));
		await size(controller, 4);
		expect(controller.snapshot()).toMatchObject({ artist: { phase: 'failed', error: 'offline' }, album: { phase: 'ready' } });
		const held = controller.snapshot(); canRetry.mockReturnValue(false); controller.retry('artist');
		expect(controller.snapshot()).toBe(held); expect(read).toHaveBeenCalledTimes(2);
		canRetry.mockReturnValue(true); controller.retry('artist'); await settle();
		expect(read).toHaveBeenCalledTimes(3); expect(controller.snapshot().artist.phase).toBe('ready');
	});
	it('does not retry ordinary errors automatically on resize', async () => {
		const { controller, read } = make(); read.mockRejectedValueOnce(new Error('busy'));
		await size(controller, 2); await size(controller, 5);
		expect(read.mock.calls.map(([ref]) => ref.token)).toEqual(['artists', 'albums', 'albums']);
	});
	it('keeps omitted and ambiguous sections honest, with exact candidates and no fabricated read', async () => {
		const { controller, read } = make(); const rows = [genreRow('a', 'Albums', 'section'), genreRow('b', 'albums', 'section'), genreRow('play', 'Play Genre', 'action')];
		controller.setPage(genrePage(rows), 'gen-1', 1); await size(controller, 5);
		expect(read).not.toHaveBeenCalled();
		expect(controller.snapshot()).toMatchObject({ artist: { phase: 'omitted' }, album: { phase: 'ambiguous', sourcePath: null, candidates: rows.slice(0, 2) } });
	});
	it('preserves the exact section step in preview item paths and the album credit tuple', () => {
		const { controller } = make(); const rows = [genreRow('albums', ' albums ', 'section'), genreRow('artists', 'Artists', 'section')];
		controller.setPage(genrePage(rows), 'gen-1', 1);
		const source = controller.snapshot().album.sourcePath!;
		expect(source.steps).toEqual([{ kind: 'genre', title: 'Alt. Rock' }, { kind: 'section', title: ' albums ' }]);
		expect(libraryChildPath(source, genrePrefix('album', 1).rows[0]).steps).toEqual([...source.steps,
			{ kind: 'album', title: 'album 0', credit: 'Exact Credit', edition: '' }]);
	});
	it.each(['stale', 'other-generation'] as const)('retires both previews on %s and never reads another retired section', async failure => {
		const { controller, read, onStale } = make();
		read.mockResolvedValueOnce(failure === 'stale' ? { contract: 'library-preview-v1', kind: 'stale' } : genrePrefix('artist', 4, 17, 'gen-2'));
		await size(controller, 4);
		expect(controller.snapshot()).toMatchObject({ stale: true, artist: { preview: null }, album: { preview: null } });
		expect(read).toHaveBeenCalledTimes(1); expect(onStale).toHaveBeenCalledTimes(1);
		await size(controller, 6); controller.retry('album'); await settle();
		expect(read).toHaveBeenCalledTimes(1); expect(onStale).toHaveBeenCalledTimes(1);
	});
	it('clears an already published Artist prefix when Albums is stale', async () => {
		const { controller, read } = make(); read.mockResolvedValueOnce(genrePrefix('artist', 2)).mockResolvedValueOnce({ contract: 'library-preview-v1', kind: 'stale' });
		await size(controller, 2); expect(controller.snapshot().artist.preview).toBeNull();
	});
	it.each(['reset', 'dispose', 'page', 'root', 'lifecycle', 'host'] as const)('suppresses late results and follow-on reads after %s retirement', async retirement => {
		const { controller, read, isCurrent } = make(); const pending = deferred<LibraryPreviewResponse>(); read.mockReturnValueOnce(pending.promise);
		await size(controller, 4);
		if (retirement === 'reset') controller.reset();
		if (retirement === 'dispose') controller.dispose();
		if (retirement === 'page') controller.setPage(genrePage(), 'gen-1', 1);
		if (retirement === 'root') controller.setPage(genrePage(), 'gen-2', 1);
		if (retirement === 'lifecycle') controller.setPage(controller.snapshot().owner!.page, 'gen-1', 2);
		if (retirement === 'host') isCurrent.mockReturnValue(false);
		const before = controller.snapshot(); pending.resolve(genrePrefix('artist', 4)); await settle();
		expect(controller.snapshot()).toBe(before); expect(read).toHaveBeenCalledTimes(1);
	});
	it('queues replacement pages behind an unfinished old read without accepting its result', async () => {
		const { controller, read } = make(); const pending = deferred<LibraryPreviewResponse>(); read.mockReturnValueOnce(pending.promise);
		await size(controller, 2); controller.setPage(genrePage(), 'gen-1', 1); await size(controller, 3);
		expect(read).toHaveBeenCalledTimes(1); pending.resolve(genrePrefix('artist', 2)); await settle();
		expect(read.mock.calls.map(([, limit]) => limit)).toEqual([2, 3, 3]);
		expect(controller.snapshot().artist.preview?.limit).toBe(3);
	});
	it('shrinks locally and reuses held capacity; growth is debounced and replaces, never merges, prefixes', async () => {
		const { controller, read } = make(); await size(controller, 5);
		await size(controller, 2); await size(controller, 4); expect(read).toHaveBeenCalledTimes(2);
		controller.setCapacity(6); await vi.advanceTimersByTimeAsync(100); controller.setCapacity(7);
		await vi.advanceTimersByTimeAsync(149); expect(read).toHaveBeenCalledTimes(2);
		read.mockResolvedValueOnce(genrePrefix('artist', 7, 17, 'gen-1', '-new'));
		await vi.advanceTimersByTimeAsync(1); expect(read.mock.calls.map(([, limit]) => limit)).toEqual([5, 5, 7, 7]);
		expect(controller.snapshot().artist.preview?.rows.every(row => row.ref.token.endsWith('-new'))).toBe(true);
	});
	it('keeps an in-flight larger prefix on shrink, but rejects it after larger demand', async () => {
		const { controller, read } = make(); const pending = deferred<LibraryPreviewResponse>(); read.mockReturnValueOnce(pending.promise);
		await size(controller, 5); await size(controller, 2); pending.resolve(genrePrefix('artist', 5)); await settle();
		expect(read.mock.calls.map(([, limit]) => limit)).toEqual([5, 5]);
		const next = deferred<LibraryPreviewResponse>(); read.mockReturnValueOnce(next.promise);
		await size(controller, 6); await size(controller, 7); next.resolve(genrePrefix('artist', 6)); await settle();
		expect(read.mock.calls.map(([, limit]) => limit)).toEqual([5, 5, 6, 7, 7]);
		expect(controller.snapshot().artist.preview?.limit).toBe(7);
	});
	it('invalidates pending work at zero width, then reacquires at a visible width', async () => {
		const { controller, read } = make(); const pending = deferred<LibraryPreviewResponse>(); read.mockReturnValueOnce(pending.promise);
		await size(controller, 3); await size(controller, 0); pending.resolve(genrePrefix('artist', 3)); await settle();
		expect(controller.snapshot().artist.preview).toBeNull(); expect(read).toHaveBeenCalledTimes(1);
		await size(controller, 2); expect(read).toHaveBeenCalledTimes(3);
	});
	it.each(['wrong-kind', 'wrong-limit', 'unavailable'] as const)('reports %s as an independent failure', async failure => {
		const { controller, read } = make(); read.mockResolvedValueOnce(failure === 'unavailable'
			? { contract: 'library-preview-v1', kind: 'unavailable', reason: 'read-failed', message: 'busy' }
			: genrePrefix(failure === 'wrong-kind' ? 'album' : 'artist', failure === 'wrong-limit' ? 2 : 3));
		await size(controller, 3); expect(controller.snapshot()).toMatchObject({ artist: { phase: 'failed' }, album: { phase: 'ready' }, stale: false });
	});
	it('caps requests at 100 and refuses invalid capacities', async () => {
		const { controller, read } = make(); for (const value of [-1, NaN, Infinity, 1.5]) await size(controller, value);
		expect(read).not.toHaveBeenCalled(); await size(controller, 1000); expect(read.mock.calls.map(([, limit]) => limit)).toEqual([100, 100]);
	});
});

describe('genrePreviewCapacity', () => {
	it.each([[0, 160, 16, 0], [159, 160, 16, 1], [511, 160, 16, 2], [512, 160, 16, 3], [1000, 220, 24, 4], [1000, 120, 8, 7], [100000, 1, 0, 100], [NaN, 160, 16, 0], [500, 0, 16, 0], [500, 160, -1, 0]])('measures W=%s T=%s G=%s as %s slots', (width, tile, gap, expected) => {
		expect(genrePreviewCapacity(width, tile, gap)).toBe(expected);
	});
});
