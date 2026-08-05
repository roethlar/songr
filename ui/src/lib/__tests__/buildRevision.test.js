import { describe, it, expect, vi } from 'vitest';
import { resolveBuildRevision } from '../buildRevision.js';

const gitOk = vi.fn(() => Buffer.from('abc1234\n'));
const gitFails = vi.fn(() => {
	throw new Error('not a git repository');
});

describe('resolveBuildRevision', () => {
	it('prefers the PUBLIC_BUILD_REV env stamp (Docker build arg)', () => {
		expect(
			resolveBuildRevision({ env: { PUBLIC_BUILD_REV: 'deadbee' }, exec: gitOk })
		).toBe('deadbee');
	});

	it('ignores an empty env stamp and asks git', () => {
		expect(resolveBuildRevision({ env: { PUBLIC_BUILD_REV: '  ' }, exec: gitOk })).toBe(
			'abc1234'
		);
		expect(resolveBuildRevision({ env: {}, exec: gitOk })).toBe('abc1234');
	});

	it('falls back to a UNIQUE per-build stamp, never a constant (rev-1)', () => {
		const first = resolveBuildRevision({ env: {}, exec: gitFails, now: () => 1_000_000 });
		const second = resolveBuildRevision({ env: {}, exec: gitFails, now: () => 2_000_000 });

		expect(first).toMatch(/^unstamped-/);
		expect(first).not.toBe('unknown');
		// Two builds at different times must not share a version name —
		// SvelteKit's stale-deployment detection depends on it.
		expect(first).not.toBe(second);
	});
});
