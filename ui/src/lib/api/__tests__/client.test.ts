import { describe, expect, it, vi } from 'vitest';
import { addFavorite, removeFavorite, switchCore } from '../client';

function jsonFetch(body: unknown, statusCode = 200): ReturnType<typeof vi.fn<typeof fetch>> {
	return vi.fn<typeof fetch>().mockResolvedValue(
		new Response(JSON.stringify(body), {
			status: statusCode,
			headers: { 'Content-Type': 'application/json' }
		})
	);
}

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
