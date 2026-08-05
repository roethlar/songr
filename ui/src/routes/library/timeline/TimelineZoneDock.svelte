<script lang="ts">
	import { onMount } from 'svelte';

	export interface TimelineZonePortView {
		readonly id: string;
		readonly name: string;
		readonly enabled: boolean;
	}

	export interface TimelineZoneDockControls {
		inspect(clientX: number, clientY: number): {
			readonly withinDock: boolean;
			readonly zoneId: string | null;
		};
		hitTest(clientX: number, clientY: number): { zoneId: string } | null;
	}

	let {
		zones,
		highlightedZoneId = null,
		activeZoneId = null,
		onControls
	}: {
		zones: readonly TimelineZonePortView[];
		highlightedZoneId?: string | null;
		activeZoneId?: string | null;
		onControls?: (controls: TimelineZoneDockControls | null) => void;
	} = $props();

	let dock: HTMLElement;

	function containsPoint(bounds: DOMRect, clientX: number, clientY: number): boolean {
		return (
			clientX >= bounds.left &&
			clientX <= bounds.right &&
			clientY >= bounds.top &&
			clientY <= bounds.bottom
		);
	}

	function inspect(clientX: number, clientY: number): {
		readonly withinDock: boolean;
		readonly zoneId: string | null;
	} {
		if (!Number.isFinite(clientX) || !Number.isFinite(clientY) || !dock?.isConnected) {
			return { withinDock: false, zoneId: null };
		}
		const dockBounds = dock.getBoundingClientRect();
		if (!containsPoint(dockBounds, clientX, clientY)) {
			return { withinDock: false, zoneId: null };
		}
		const currentlyEnabled = new Set(zones.filter((zone) => zone.enabled).map((zone) => zone.id));
		const listBounds = dock.querySelector<HTMLElement>('.zone-port-list')?.getBoundingClientRect();
		if (!listBounds || !containsPoint(listBounds, clientX, clientY)) {
			return { withinDock: true, zoneId: null };
		}
		for (const port of dock.querySelectorAll<HTMLElement>('[data-timeline-zone-port]')) {
			const zoneId = port.dataset.zoneId;
			if (!zoneId || !currentlyEnabled.has(zoneId) || port.dataset.disabled === 'true') {
				continue;
			}
			const bounds = port.getBoundingClientRect();
			if (containsPoint(bounds, clientX, clientY)) {
				return { withinDock: true, zoneId };
			}
		}
		return { withinDock: true, zoneId: null };
	}

	function hitTest(clientX: number, clientY: number): { zoneId: string } | null {
		const result = inspect(clientX, clientY);
		return result.zoneId ? { zoneId: result.zoneId } : null;
	}

	onMount(() => {
		const controls: TimelineZoneDockControls = Object.freeze({ inspect, hitTest });
		onControls?.(controls);
		return () => onControls?.(null);
	});
</script>

<aside
	bind:this={dock}
	class="timeline-zone-dock"
	aria-label="Roon zones"
	data-zone-count={zones.length}
>
	<header>
		<strong>Zones</strong>
		<span>Drop to choose an action</span>
	</header>
	<div class="zone-port-list" role="list" aria-label="Available Roon zones">
		{#if zones.length === 0}
			<p>No zones available</p>
		{:else}
			{#each zones as zone (zone.id)}
				<div
					class="zone-port"
					class:highlighted={zone.id === highlightedZoneId && zone.enabled}
					class:active={zone.id === activeZoneId}
					class:disabled={!zone.enabled}
					role="listitem"
					aria-current={zone.id === activeZoneId ? 'true' : undefined}
					data-timeline-zone-port
					data-zone-id={zone.id}
					data-disabled={!zone.enabled ? 'true' : undefined}
					data-highlighted={zone.id === highlightedZoneId && zone.enabled ? 'true' : undefined}
					data-active={zone.id === activeZoneId ? 'true' : undefined}
				>
					<span class="zone-port-dot" aria-hidden="true"></span>
					<span class="zone-port-copy">
						<strong>{zone.name}</strong>
						<small>{zone.enabled ? 'Action target' : 'Unavailable'}</small>
					</span>
				</div>
			{/each}
		{/if}
	</div>
</aside>

<style>
	.timeline-zone-dock {
		position: absolute;
		right: 16px;
		top: 50%;
		z-index: 6;
		display: grid;
		width: min(208px, calc(100% - 32px));
		max-height: min(42vh, 380px);
		translate: 0 -8%;
		box-sizing: border-box;
		gap: 8px;
		padding: 10px;
		border: 1px solid color-mix(in srgb, var(--border) 78%, transparent);
		border-radius: 15px 0 0 15px;
		background: color-mix(in srgb, var(--surface) 94%, transparent);
		box-shadow: 0 14px 34px rgb(0 0 0 / 0.24);
		pointer-events: none;
	}

	header,
	.zone-port,
	.zone-port-copy {
		display: grid;
	}

	header {
		gap: 2px;
		padding: 0 3px;
	}

	header strong {
		font-size: 11px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	header span,
	.zone-port small,
	p {
		color: var(--text-soft);
		font-size: 10px;
	}

	.zone-port-list {
		display: grid;
		min-height: 0;
		gap: 7px;
		overflow: auto;
		overscroll-behavior: contain;
		scrollbar-width: thin;
		pointer-events: auto;
	}

	.zone-port {
		grid-template-columns: 12px minmax(0, 1fr);
		align-items: center;
		gap: 9px;
		min-height: 48px;
		padding: 8px 9px;
		border: 1px solid var(--border);
		border-radius: 12px;
		background: color-mix(in srgb, var(--surface-2) 90%, transparent);
		transition: border-color 100ms ease, background 100ms ease, opacity 100ms ease;
	}

	.zone-port-copy {
		min-width: 0;
		gap: 2px;
	}

	.zone-port-copy strong {
		overflow: hidden;
		font-size: 12px;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.zone-port-dot {
		width: 9px;
		height: 9px;
		border: 1px solid color-mix(in srgb, var(--text-soft) 72%, var(--border));
		border-radius: 999px;
		background: var(--surface-3);
	}

	.zone-port.active {
		border-color: color-mix(in srgb, var(--accent) 58%, var(--border));
	}

	.zone-port.active .zone-port-dot {
		background: var(--accent);
	}

	.zone-port.highlighted {
		border-color: var(--accent-2);
		background: color-mix(in srgb, var(--accent-2) 18%, var(--surface-2));
	}

	.zone-port.highlighted .zone-port-dot {
		border-color: var(--accent-2);
		background: var(--accent-2);
		box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent-2) 18%, transparent);
	}

	.zone-port.disabled {
		opacity: 0.48;
	}

	p {
		margin: 0;
		padding: 12px 6px;
	}

	@media (max-width: 760px) {
		.timeline-zone-dock {
			top: auto;
			right: 10px;
			bottom: 86px;
			width: min(184px, calc(100% - 20px));
			max-height: 32vh;
			translate: none;
		}
	}
</style>
