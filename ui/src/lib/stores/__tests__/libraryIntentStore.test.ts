import { beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import {
	cancelLibraryIntent,
	claimLibraryIntent,
	pendingLibraryIntentStore,
	publishLibraryIntent,
	resetLibraryIntentStore
} from '$lib/stores/libraryIntentStore';
import type { LibraryIntent } from '$lib/libraryIntent';

const searchIntent = (query: string): LibraryIntent => ({
	kind: 'general',
	destination: 'search',
	query
});

beforeEach(() => {
	resetLibraryIntentStore();
});

describe('libraryIntentStore', () => {
	it('publishes a frozen request with a unique one-shot identity', () => {
		const first = publishLibraryIntent(searchIntent('first'));
		expect(first).not.toBeNull();
		expect(get(pendingLibraryIntentStore)).toBe(first);
		expect(Object.isFrozen(first)).toBe(true);

		const claimed = claimLibraryIntent(first!.requestId);
		expect(claimed).toEqual(searchIntent('first'));
		expect(get(pendingLibraryIntentStore)).toBeNull();
		expect(claimLibraryIntent(first!.requestId)).toBeNull();

		const second = publishLibraryIntent(searchIntent('first'));
		expect(second!.requestId).not.toBe(first!.requestId);
	});

	it('is latest-wins and stale claims preserve the replacement', () => {
		const first = publishLibraryIntent(searchIntent('first'))!;
		const second = publishLibraryIntent(searchIntent('second'))!;

		expect(claimLibraryIntent(first.requestId)).toBeNull();
		expect(get(pendingLibraryIntentStore)).toBe(second);
		expect(claimLibraryIntent(second.requestId)).toEqual(searchIntent('second'));
		expect(get(pendingLibraryIntentStore)).toBeNull();
	});

	it('cancels only the matching request', () => {
		const first = publishLibraryIntent(searchIntent('first'))!;
		const second = publishLibraryIntent(searchIntent('second'))!;

		expect(cancelLibraryIntent(first.requestId)).toBe(false);
		expect(get(pendingLibraryIntentStore)).toBe(second);
		expect(cancelLibraryIntent(second.requestId)).toBe(true);
		expect(get(pendingLibraryIntentStore)).toBeNull();
		expect(cancelLibraryIntent(second.requestId)).toBe(false);
	});

	it('rejects an invalid publish without replacing the current request', () => {
		const current = publishLibraryIntent(searchIntent('keep me'))!;

		expect(
			publishLibraryIntent({
				kind: 'general',
				destination: 'search',
				query: 'bad',
				itemKey: 'must-not-cross'
			} as unknown as Parameters<typeof publishLibraryIntent>[0])
		).toBeNull();
		expect(get(pendingLibraryIntentStore)).toBe(current);
	});

	it('reset clears pending state without allowing an old identity to affect a later request', () => {
		const beforeReset = publishLibraryIntent(searchIntent('before'))!;
		resetLibraryIntentStore();
		expect(get(pendingLibraryIntentStore)).toBeNull();

		const afterReset = publishLibraryIntent(searchIntent('after'))!;
		expect(afterReset.requestId).not.toBe(beforeReset.requestId);
		expect(cancelLibraryIntent(beforeReset.requestId)).toBe(false);
		expect(get(pendingLibraryIntentStore)).toBe(afterReset);
	});
});
