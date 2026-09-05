/**
 * `m:ss` for a position or duration in seconds.
 *
 * One implementation: the play bar, the Now Playing overlay and the shared
 * seek bar all print the same clock, and three hand-written copies of a
 * formatter is three places for the rounding to drift.
 */
export function formatTime(seconds: number): string {
	if (!seconds || seconds < 0) return '0:00';
	const whole = Math.floor(seconds);
	const m = Math.floor(whole / 60);
	const s = whole % 60;
	return `${m}:${String(s).padStart(2, '0')}`;
}
