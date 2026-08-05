import { describe, expect, it, vi } from 'vitest';

import {
	TIMELINE_TAB_STORAGE_KEY,
	createTimelineTabIdProvider,
	type TimelineTabStorage
} from '../tabId';

function storage(initial: string | null = null): TimelineTabStorage & {
	value: string | null;
} {
	return {
		value: initial,
		getItem() {
			return this.value;
		},
		setItem(_key, value) {
			this.value = value;
		}
	};
}

describe('Timeline browser tab identity', () => {
	it('uses getRandomValues when the production provider creates a new tab identity', () => {
		const getRandomValues = vi
			.spyOn(globalThis.crypto, 'getRandomValues')
			.mockImplementation(((bytes: Uint8Array) => {
				bytes.fill(0xff);
				return bytes;
			}) as Crypto['getRandomValues']);
		const target = storage();
		const getTabId = createTimelineTabIdProvider(target);

		try {
			expect(getTabId()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
			expect(getTabId()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
			expect(getRandomValues).toHaveBeenCalledTimes(1);
			expect(target.value).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
		} finally {
			getRandomValues.mockRestore();
		}
	});

	it('reuses one valid session-scoped value without generating another', () => {
		const target = storage('tab-existing');
		const createId = vi.fn(() => 'tab-new');
		const getTabId = createTimelineTabIdProvider(target, createId);

		expect(getTabId()).toBe('tab-existing');
		expect(getTabId()).toBe('tab-existing');
		expect(createId).not.toHaveBeenCalled();
	});

	it('replaces invalid stored data with one strictly opaque identifier', () => {
		const target = storage('bad tab id');
		const getTabId = createTimelineTabIdProvider(target, () => 'tab-generated:1');

		expect(getTabId()).toBe('tab-generated:1');
		expect(target.value).toBe('tab-generated:1');
	});

	it('keeps its in-memory identity when browser storage throws', () => {
		const target: TimelineTabStorage = {
			getItem: () => {
				throw new Error('blocked');
			},
			setItem: () => {
				throw new Error('blocked');
			}
		};
		const createId = vi.fn(() => 'tab-memory');
		const getTabId = createTimelineTabIdProvider(target, createId);

		expect(getTabId()).toBe('tab-memory');
		expect(getTabId()).toBe('tab-memory');
		expect(createId).toHaveBeenCalledTimes(1);
	});

	it('fails closed when the generator does not produce an opaque value', () => {
		const target = storage();
		const getTabId = createTimelineTabIdProvider(target, () => '../shared-tab');

		expect(() => getTabId()).toThrow('Generated Timeline tab identity is invalid');
		expect(target.getItem(TIMELINE_TAB_STORAGE_KEY)).toBeNull();
	});
});
