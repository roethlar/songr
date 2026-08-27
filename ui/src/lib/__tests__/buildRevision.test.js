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

	it('falls back to the root manifest version on git-less trees', () => {
		expect(
			resolveBuildRevision({ env: {}, exec: gitFails, version: () => '1.2.3' })
		).toBe('unstamped-1.2.3');
	});

	it('is deterministic within one build, or the client cannot boot', () => {
		// The version stamp names the hydration global, and Vite evaluates the
		// config once per environment: a clock-reading value splits the global
		// between the rendered HTML and the client chunks — the 2026-08-17
		// public-desktop black screen. Evaluations of one tree land seconds
		// apart and must still agree.
		vi.useFakeTimers();
		try {
			const deps = { env: {}, exec: gitFails, version: () => '1.2.3' };
			const first = resolveBuildRevision(deps);
			vi.setSystemTime(Date.now() + 60_000);
			expect(resolveBuildRevision(deps)).toBe(first);
		} finally {
			vi.useRealTimers();
		}
	});

	it('still changes across releases, so stale-deploy detection keeps working (rev-1)', () => {
		const first = resolveBuildRevision({ env: {}, exec: gitFails, version: () => '1.2.3' });
		const second = resolveBuildRevision({ env: {}, exec: gitFails, version: () => '1.3.0' });

		expect(first).toMatch(/^unstamped-/);
		expect(first).not.toBe('unknown');
		expect(first).not.toBe(second);
	});

	it('fails loudly when no identity source exists, instead of shipping a dead page', () => {
		expect(() =>
			resolveBuildRevision({ env: {}, exec: gitFails, version: () => null })
		).toThrow(/PUBLIC_BUILD_REV/);
	});
});
