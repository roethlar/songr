import { describe, it, expect } from 'vitest';
import { get } from 'svelte/store';
import { socketStatusStore, setSocketStatus } from '../socketStatusStore';

describe('socketStatusStore', () => {
	it('starts in connecting', () => {
		// Note: state may have been mutated by other test files in the same
		// run. Reset explicitly to keep this assertion meaningful.
		setSocketStatus('connecting');
		expect(get(socketStatusStore)).toBe('connecting');
	});

	it('cycles through all defined states', () => {
		setSocketStatus('connected');
		expect(get(socketStatusStore)).toBe('connected');
		setSocketStatus('disconnected');
		expect(get(socketStatusStore)).toBe('disconnected');
		setSocketStatus('connecting');
		expect(get(socketStatusStore)).toBe('connecting');
	});
});
