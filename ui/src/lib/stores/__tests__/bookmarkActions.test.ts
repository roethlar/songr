import { describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { createBookmarkActions } from '../bookmarkActions';
import type { AddFavoriteRequest } from '@shared/types';

describe('bookmark batch saving', () => {
	it('saves a metadata snapshot in displayed order and blocks duplicate gestures', async () => {
		let release!: () => void;
		const first = new Promise<void>(resolve => { release = resolve; });
		const write = vi.fn().mockReturnValueOnce(first).mockResolvedValue(undefined);
		const actions = createBookmarkActions(write);
		const entries: AddFavoriteRequest[] = [
			{ type: 'track', title: 'First' }, { type: 'album', title: 'Second' }
		];
		const pending = actions.save(entries);
		entries[1].title = 'Changed after click';
		await actions.save([{ type: 'artist', title: 'Duplicate click' }]);
		expect(write).toHaveBeenCalledTimes(1);
		expect(get(actions).busy).toBe(true);
		release(); await pending;
		expect(write.mock.calls.map(([entry]) => entry.title)).toEqual(['First', 'Second']);
		expect(get(actions)).toEqual({ busy: false, status: 'Bookmarked 2 items.' });
	});

	it('reports only durable successes and stops after a failed write', async () => {
		const write = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Disk full'));
		const actions = createBookmarkActions(write);
		await actions.save(['First', 'Second', 'Third'].map(title => ({ type: 'track', title })));
		expect(write).toHaveBeenCalledTimes(2);
		expect(get(actions)).toEqual({ busy: false, status: '1 saved. Disk full' });
		write.mockResolvedValueOnce(undefined);
		await actions.save([{ type: 'artist', title: 'Retry' }]);
		expect(get(actions)).toEqual({ busy: false, status: 'Bookmarked.' });
	});
});
