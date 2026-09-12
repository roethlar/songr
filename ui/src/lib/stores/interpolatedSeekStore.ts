import { derived, readable } from 'svelte/store';
import { zoneMapStore } from './zonesStore';
import { effectivePresentationStore } from './presentationSettingsStore';

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

const clock = readable({ now: 0, motion: false }, (set) => {
	let timer: ReturnType<typeof setInterval> | undefined;
	const stop = effectivePresentationStore.subscribe(settings => {
		if (timer !== undefined) clearInterval(timer);
		timer = undefined;
		set({ now: Date.now(), motion: settings.interfaceMotion });
		if (settings.interfaceMotion)
			timer = setInterval(() => set({ now: Date.now(), motion: true }), TICK_MS);
	});
	return () => { stop(); if (timer !== undefined) clearInterval(timer); };
});

// zone_id → the server-fed position this interpolation run is based
// on, and when we first saw it. Module-level on purpose: re-basing
// must survive derived recomputation.
const bases = new Map<string, { position: number; at: number }>();

let previousMotion = false;

export const interpolatedSeekStore = derived(
	[zoneMapStore, clock],
	([$zones, { now: $now, motion }]) => {
		if (motion !== previousMotion) bases.clear();
		previousMotion = motion;
		const out = new Map<string, number>();
		for (const [zoneId, zone] of $zones) {
			const serverPosition = zone.seek_position ?? 0;
			const prev = bases.get(zoneId);
			if (!prev || prev.position !== serverPosition) {
				bases.set(zoneId, { position: serverPosition, at: $now });
			}
			if (!motion || zone.state !== 'playing') {
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
