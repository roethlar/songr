import { describe, expect, it, vi } from 'vitest';
import { addFavorite, removeFavorite, switchCore, previewLibrarySection } from '../client';

function jsonFetch(body: unknown, statusCode = 200): ReturnType<typeof vi.fn<typeof fetch>> {
	return vi.fn<typeof fetch>().mockResolvedValue(
		new Response(JSON.stringify(body), {
			status: statusCode,
			headers: { 'Content-Type': 'application/json' }
		})
	);
}

describe('genre preview API', () => {
	const ref = { generation: 'g1', token: 'section' };
	const body = { contract: 'library-preview-v1', kind: 'preview', generation: 'g1',
		title: 'Albums', totalCount: 17, limit: 1,
		rows: [{ ref: { ...ref, token: 'album' }, kind: 'album', title: 'One' }] };
	it('sends only the exact section ref and bounded limit, keeping the total distinct', async () => {
		const fetchFn = jsonFetch(body);
		await expect(previewLibrarySection(fetchFn, ref, 1)).resolves.toEqual(body);
		expect(fetchFn).toHaveBeenCalledWith('/api/library/preview', expect.objectContaining({
			method: 'POST', body: JSON.stringify({ ref, limit: 1 })
		}));
	});
	it.each([{ limit: 2 }, { generation: 'g2' }, { rows: [] }, { kind: 'level' }])('rejects mismatched response %j', async over => {
		await expect(previewLibrarySection(jsonFetch({ ...body, ...over }), ref, 1)).rejects.toMatchObject({ status: 502 });
	});
	it('rejects an invalid capacity before issuing a request', async () => {
		const fetchFn = jsonFetch(body);
		await expect(previewLibrarySection(fetchFn, ref, 101)).rejects.toMatchObject({ status: 400 });
		expect(fetchFn).not.toHaveBeenCalled();
	});
	it.each([400, 503])('returns typed unavailability at HTTP %i', async status => {
		const unavailable = { contract: 'library-preview-v1', kind: 'unavailable', reason: 'read-failed', message: 'Not now.' };
		await expect(previewLibrarySection(jsonFetch(unavailable, status), ref, 1)).resolves.toEqual(unavailable);
	});
	it('returns stale and keeps transport errors and HTML failures distinct', async () => {
		const stale = { contract: 'library-preview-v1', kind: 'stale' };
		await expect(previewLibrarySection(jsonFetch(stale, 409), ref, 1)).resolves.toEqual(stale);
		const failure = new Error('Network failed');
		await expect(previewLibrarySection(vi.fn().mockRejectedValue(failure), ref, 1)).rejects.toBe(failure);
		await expect(previewLibrarySection(vi.fn().mockResolvedValue(new Response('<html>')), ref, 1)).rejects.toMatchObject({ status: 502 });
	});
});

describe('Core API client', () => {
	it('sends the exact destructive confirmation to switch Core', async () => {
		const fetchFn = jsonFetch({ accepted: true, status: 'discovering' }, 202);

		await expect(switchCore(fetchFn)).resolves.toEqual({
			accepted: true,
			status: 'discovering'
		});
		expect(fetchFn).toHaveBeenCalledWith('/api/core/switch', {
			credentials: 'include',
			method: 'POST',
			body: JSON.stringify({ confirmed: true }),
			headers: { 'Content-Type': 'application/json' }
		});
	});
});

describe('API client request plumbing', () => {
	it('keeps the JSON content type when a request actually carries JSON', async () => {
		const fetchFn = jsonFetch({ entries: [] });

		await expect(
			addFavorite(fetchFn, { type: 'album', title: 'Homogenic', artist: 'Björk' })
		).resolves.toEqual({ entries: [] });

		const init = fetchFn.mock.calls[0][1];
		expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
		expect(init?.body).toBe(
			JSON.stringify({ type: 'album', title: 'Homogenic', artist: 'Björk' })
		);
	});

	it('sends no body and declares no content type when a request carries neither', async () => {
		// The counterpart to the rule above: a method-only request must not
		// announce a JSON body it does not have.
		const fetchFn = jsonFetch({ entries: [] });

		await expect(removeFavorite(fetchFn, 'fav-1')).resolves.toEqual({ entries: [] });

		const init = fetchFn.mock.calls[0][1];
		expect(init).not.toHaveProperty('body');
		expect(new Headers(init?.headers).has('content-type')).toBe(false);
	});
});
