/**
 * Map a seek-slider keydown to a target position in seconds, following
 * WAI-ARIA slider conventions: arrows step ±5s, PageUp/PageDown ±30s,
 * Home/End jump to the start/end. Returns null for keys the slider
 * doesn't handle so callers can let them propagate.
 */
/**
 * Optimistic base for repeated seeks (rev-8). Roon reports seek
 * position at ~1 Hz and seeks are absolute, so consecutive seek
 * commands inside one tick would all compute from the same stale
 * base — holding ArrowRight from 0:30 advanced ~5s total instead of
 * ~5s per repeat. The last sent target is remembered and used as the
 * base while fresh; each new seek refreshes it, so a held key steps
 * monotonically. After `expiryMs` without a seek the server-fed
 * position wins again (by then it reflects the applied seek), which
 * also keeps a stale target from ever dragging a later seek
 * backwards. `now` is injectable for tests.
 *
 * `contextKey` must identify the zone AND the playing track (round-1
 * review): keyed by zone alone, a same-zone track change inside the
 * expiry window would reuse the previous track's absolute target —
 * holding End/ArrowRight across a track boundary could pin the new
 * track at its end.
 *
 * `record` returns a token for `invalidate`: a seek whose delivery
 * later fails must not leave a phantom base (round-1 review — a
 * failed Right from 30 followed by Left would send 30 instead of
 * 25). Invalidation is token-guarded so an older failure landing
 * late never clears a newer pending seek.
 */
export function createOptimisticSeekBase(
	expiryMs = 2000,
	now: () => number = () => Date.now()
): {
	base(contextKey: string | null | undefined, serverPosition: number): number;
	record(contextKey: string | null | undefined, target: number): number;
	invalidate(token: number): void;
} {
	let pending: { contextKey: string; target: number; at: number; token: number } | null = null;
	let lastToken = 0;
	return {
		base(contextKey, serverPosition) {
			if (
				pending &&
				contextKey &&
				pending.contextKey === contextKey &&
				now() - pending.at < expiryMs
			) {
				return pending.target;
			}
			return serverPosition;
		},
		record(contextKey, target) {
			lastToken += 1;
			pending = contextKey ? { contextKey, target, at: now(), token: lastToken } : null;
			return lastToken;
		},
		invalidate(token) {
			if (pending?.token === token) pending = null;
		}
	};
}

export function seekTargetForKey(
	key: string,
	current: number,
	duration: number
): number | null {
	const max = Math.max(0, Math.floor(duration));
	const clamp = (value: number) => Math.max(0, Math.min(max, Math.floor(value)));
	switch (key) {
		case 'ArrowRight':
		case 'ArrowUp':
			return clamp(current + 5);
		case 'ArrowLeft':
		case 'ArrowDown':
			return clamp(current - 5);
		case 'PageUp':
			return clamp(current + 30);
		case 'PageDown':
			return clamp(current - 30);
		case 'Home':
			return 0;
		case 'End':
			return max;
		default:
			return null;
	}
}
