import { derived, readable } from 'svelte/store';
import { zoneMapStore } from './zonesStore';

/**
 * Seek positions interpolated between server ticks.
 *
 * Roon reports seek position at ~1 Hz over the socket, so a seek bar
 * bound directly to `zone.seek_position` advances in one-second jumps.
 * This store re-emits each PLAYING zone's position advanced by the
 * wall-clock time since its last server update, sampled every
 * `TICK_MS`; paused/stopped zones pass the server value through
 * untouched. A fresh server tick (or an absolute seek) re-bases the
 * interpolation, so drift never exceeds one server interval.
 *
 * The internal clock only runs while someone subscribes (Svelte
 * readable start/stop), so pages without a seek bar cost nothing.
 */
const TICK_MS = 250;

const clock = readable(0, (set) => {
	// The initial 0 emits immediately; each interval tick re-emits the
	// current time, prompting the derived below to resample.
	set(Date.now());
	const id = setInterval(() => set(Date.now()), TICK_MS);
	return () => clearInterval(id);
});

// zone_id → the server-fed position this interpolation run is based
// on, and when we first saw it. Module-level on purpose: re-basing
// must survive derived recomputation.
const bases = new Map<string, { position: number; at: number }>();

export const interpolatedSeekStore = derived(
	[zoneMapStore, clock],
	([$zones, $now]) => {
		const out = new Map<string, number>();
		for (const [zoneId, zone] of $zones) {
			const serverPosition = zone.seek_position ?? 0;
			const prev = bases.get(zoneId);
			if (!prev || prev.position !== serverPosition) {
				bases.set(zoneId, { position: serverPosition, at: $now });
			}
			if (zone.state !== 'playing') {
				out.set(zoneId, serverPosition);
				continue;
			}
			const base = bases.get(zoneId)!;
			out.set(zoneId, base.position + Math.max(0, ($now - base.at) / 1000));
		}
		// Drop bases for zones that disappeared so the map can't grow
		// unboundedly across zone re-configurations.
		for (const zoneId of bases.keys()) {
			if (!$zones.has(zoneId)) bases.delete(zoneId);
		}
		return out;
	}
);
