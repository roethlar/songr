import { describe, it, expect } from 'vitest';
import { createOptimisticSeekBase, seekTargetForKey } from '../seekKeys';

describe('seekTargetForKey', () => {
	it('steps ±5s on arrows', () => {
		expect(seekTargetForKey('ArrowRight', 30, 200)).toBe(35);
		expect(seekTargetForKey('ArrowUp', 30, 200)).toBe(35);
		expect(seekTargetForKey('ArrowLeft', 30, 200)).toBe(25);
		expect(seekTargetForKey('ArrowDown', 30, 200)).toBe(25);
	});

	it('steps ±30s on page keys', () => {
		expect(seekTargetForKey('PageUp', 60, 200)).toBe(90);
		expect(seekTargetForKey('PageDown', 60, 200)).toBe(30);
	});

	it('jumps to start/end on Home/End', () => {
		expect(seekTargetForKey('Home', 120, 200)).toBe(0);
		expect(seekTargetForKey('End', 30, 200)).toBe(200);
	});

	it('clamps to the track bounds', () => {
		expect(seekTargetForKey('ArrowLeft', 2, 200)).toBe(0);
		expect(seekTargetForKey('ArrowRight', 198, 200)).toBe(200);
		expect(seekTargetForKey('PageDown', 10, 200)).toBe(0);
	});

	it('ignores unrelated keys', () => {
		expect(seekTargetForKey('Enter', 30, 200)).toBeNull();
		expect(seekTargetForKey('a', 30, 200)).toBeNull();
		expect(seekTargetForKey('Tab', 30, 200)).toBeNull();
	});
});

describe('createOptimisticSeekBase (rev-8)', () => {
	function withClock(expiryMs = 2000) {
		let t = 1000;
		return {
			seek: createOptimisticSeekBase(expiryMs, () => t),
			advance: (ms: number) => (t += ms)
		};
	}

	it('returns the server position when nothing was sent', () => {
		const { seek } = withClock();
		expect(seek.base('ctx-a', 30)).toBe(30);
	});

	it('each seek refreshes the expiry window, not just the target', () => {
		// Crosses the FIRST record's deadline while staying inside the
		// second's — this fails if record() only replaced the target
		// without restamping the clock (round-1 review: the earlier
		// version of this test never left the first window).
		const { seek, advance } = withClock(2000);
		seek.record('ctx-a', 35);
		advance(1900);
		expect(seek.base('ctx-a', 30)).toBe(35);
		seek.record('ctx-a', 40); // t=2900; first window ends at 3000
		advance(1900); // t=4800 — past the first deadline, inside the second's
		expect(seek.base('ctx-a', 30)).toBe(40);
	});

	it('falls back to the server position after expiry', () => {
		const { seek, advance } = withClock(2000);
		seek.record('ctx-a', 35);
		advance(2000);
		expect(seek.base('ctx-a', 92)).toBe(92);
	});

	it('ignores a target recorded for a different context (zone or track)', () => {
		const { seek } = withClock();
		seek.record('zone-a::Track One::200', 35);
		expect(seek.base('zone-b::Track One::200', 60)).toBe(60);
		expect(seek.base('zone-a::Track Two::180', 60)).toBe(60);
		expect(seek.base(null, 60)).toBe(60);
	});

	it('invalidate clears the base for a failed seek', () => {
		const { seek } = withClock();
		const token = seek.record('ctx-a', 35);
		seek.invalidate(token);
		expect(seek.base('ctx-a', 30)).toBe(30);
	});

	it('an older failure never clears a newer pending seek', () => {
		const { seek } = withClock();
		const first = seek.record('ctx-a', 35);
		seek.record('ctx-a', 40);
		seek.invalidate(first);
		expect(seek.base('ctx-a', 30)).toBe(40);
	});
});
