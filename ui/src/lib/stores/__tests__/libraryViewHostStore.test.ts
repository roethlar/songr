import { describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { createLibraryViewHostStateStore } from '../libraryViewHostStore';

describe('libraryViewHostStore', () => {
	it('publishes Unified only through the current host claim', () => {
		const hostState = createLibraryViewHostStateStore();
		const first = hostState.claim();
		first.publishActiveMode('unified');
		expect(get(hostState.store)).toEqual({ activeMode: 'unified' });

		const replacement = hostState.claim();
		expect(get(hostState.store)).toEqual({ activeMode: null });
		first.publishActiveMode('unified');
		first.release();
		expect(get(hostState.store)).toEqual({ activeMode: null });

		replacement.publishActiveMode('unified');
		expect(get(hostState.store)).toEqual({ activeMode: 'unified' });
	});

	it('ignores writes after a claim is released', () => {
		const hostState = createLibraryViewHostStateStore();
		const owner = hostState.claim();
		owner.publishActiveMode('unified');
		owner.release();

		expect(get(hostState.store)).toEqual({ activeMode: null });
		owner.publishActiveMode('unified');
		expect(get(hostState.store)).toEqual({ activeMode: null });
	});

	it('freezes every published state', () => {
		const hostState = createLibraryViewHostStateStore();
		const owner = hostState.claim();
		owner.publishActiveMode('unified');

		expect(Object.isFrozen(get(hostState.store))).toBe(true);
	});
});
