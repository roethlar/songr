import { describe, expect, it, vi } from 'vitest';

import {
	createSecureTimelineOpaqueId,
	type SecureRandomSource
} from '../secureOpaqueId';

describe('secure Timeline opaque identity', () => {
	it('formats 128 random bits with deterministic UUID version and variant bits', () => {
		const getRandomValues = vi.fn((bytes: Uint8Array) => {
			bytes.set(Array.from({ length: 16 }, (_, index) => index));
			return bytes;
		});
		const source: SecureRandomSource = { getRandomValues };

		expect(createSecureTimelineOpaqueId(source)).toBe(
			'00010203-0405-4607-8809-0a0b0c0d0e0f'
		);
		expect(getRandomValues).toHaveBeenCalledTimes(1);
		expect(getRandomValues.mock.calls[0][0]).toHaveLength(16);
	});

	it('fails closed when secure browser entropy is unavailable', () => {
		expect(() => createSecureTimelineOpaqueId(null)).toThrow(
			'Secure browser entropy is unavailable'
		);
	});
});
