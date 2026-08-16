<script lang="ts">
	import { onMount } from 'svelte';
	import { focusTrap, isTopModalOwner } from '$lib/actions/focusTrap';
	import { splitArtists } from '$lib/artistList';
	import { hideOnError } from '$lib/actions/imageFallback';
	import { imageUrl } from '$lib/imageUrl';
	import type { LibraryIntent } from '$lib/libraryIntent';
	import { getSocket } from '$lib/socket/client';
	import { emitWithAck } from '$lib/socket/emit';
	import {
		pushCommandFeedback,
		queueStore,
		selectedZoneStore,
		setQueueSnapshot,
		socketStatusStore
	} from '$lib/stores';
	import { zoneMapStore } from '$lib/stores/zonesStore';
	import type {
		LoopModeRequest,
		QueueItem,
		ZonePlaybackSettingsRequest,
		ZoneQueue
	} from '@shared/types';

	let {
		onclose,
		onlibraryintent
	}: {
		onclose: () => void;
		onlibraryintent: (intent: LibraryIntent) => void | Promise<void>;
	} = $props();

	let socket = $state(getSocket());
	let dialogEl = $state<HTMLElement | null>(null);
	let queueLoading = $state(false);
	let queueActionInFlight = $state(false);
	let settingsInFlight = $state(false);

	onMount(() => {
		socket = getSocket();
	});

	$effect(() => {
		// Queue updates missed during a socket drop are not replayed. Re-run
		// the subscription on zone changes and reconnect so the ack refreshes
		// the shared queue store before the panel presents it.
		if ($selectedZoneStore && $socketStatusStore === 'connected') {
			void subscribeQueue($selectedZoneStore);
		}
	});

	const activeZone = $derived(
		$selectedZoneStore ? $zoneMapStore.get($selectedZoneStore) : undefined
	);
	const activeQueue = $derived(
		$selectedZoneStore ? $queueStore[$selectedZoneStore] : undefined
	);
	const totalQueueSeconds = $derived(
		(activeQueue?.items ?? []).reduce((sum, item) => sum + (item.length ?? 0), 0)
	);

	function close(): void {
		onclose();
	}

	function handleWindowKeydown(event: KeyboardEvent): void {
		if (
			event.key !== 'Escape' ||
			(dialogEl !== null && !isTopModalOwner(dialogEl))
		) return;
		event.preventDefault();
		close();
	}

	function handleBackdropClick(event: MouseEvent): void {
		if (event.target === event.currentTarget) close();
	}

	function getLiveSocket() {
		const liveSocket = socket ?? getSocket();
		socket = liveSocket;
		if (!liveSocket) {
			pushCommandFeedback({
				source: 'queue',
				command: 'socket',
				message: 'Realtime connection is unavailable. Refresh and retry.'
			});
			return null;
		}
		return liveSocket;
	}

	async function subscribeQueue(zoneId: string): Promise<void> {
		const liveSocket = getLiveSocket();
		if (!liveSocket) return;

		queueLoading = true;
		try {
			const response = await emitWithAck<{ queue?: ZoneQueue }>(
				liveSocket,
				'queue:subscribe',
				{ zone_id: zoneId },
				{ feedback: { source: 'queue', command: 'queue:subscribe' } }
			);
			if (response.success && response.data?.queue) {
				setQueueSnapshot(response.data.queue);
			}
		} finally {
			queueLoading = false;
		}
	}

	async function playFromHere(queueItemId: number, title: string): Promise<void> {
		if (!$selectedZoneStore) return;
		const liveSocket = getLiveSocket();
		if (!liveSocket) return;

		queueActionInFlight = true;
		try {
			const response = await emitWithAck(
				liveSocket,
				'queue:play-from-here',
				{ zone_id: $selectedZoneStore, queue_item_id: queueItemId },
				{ feedback: { source: 'queue', command: 'queue:play-from-here' } }
			);
			if (response.success) {
				pushCommandFeedback({
					source: 'queue',
					command: 'queue:play-from-here',
					kind: 'success',
					message: `Playing from "${title}".`
				});
			}
		} finally {
			queueActionInFlight = false;
		}
	}

	async function updateSettings(
		patch: Omit<ZonePlaybackSettingsRequest, 'zone_id'>
	): Promise<void> {
		if (!$selectedZoneStore) return;
		const liveSocket = getLiveSocket();
		if (!liveSocket) return;

		settingsInFlight = true;
		try {
			await emitWithAck(
				liveSocket,
				'transport:settings',
				{ zone_id: $selectedZoneStore, ...patch },
				{ feedback: { source: 'transport', command: 'transport:settings' } }
			);
		} finally {
			settingsInFlight = false;
		}
	}

	function cycleLoop(current?: string): LoopModeRequest {
		if (current === 'disabled') return 'loop';
		if (current === 'loop') return 'loop_one';
		return 'disabled';
	}

	function semanticItemTitle(item: QueueItem): string | null {
		const title = item.three_line?.line1 || item.two_line?.line1 || item.one_line?.line1;
		const normalized = title?.trim();
		return normalized ? normalized : null;
	}

	function itemTitle(item: QueueItem): string {
		return semanticItemTitle(item) ?? `Queue item ${item.queue_item_id}`;
	}

	function itemSubtitle(item: QueueItem): string {
		return item.three_line?.line2 || item.two_line?.line2 || '';
	}

	function itemTertiary(item: QueueItem): string {
		return item.three_line?.line3 || '';
	}

	function trackLibraryIntent(item: QueueItem): LibraryIntent | null {
		const title = semanticItemTitle(item);
		if (!title) return null;
		const artist = itemSubtitle(item).trim();
		const album = itemTertiary(item).trim();
		return {
			kind: 'track',
			destination: 'search',
			query: title,
			display: {
				title,
				artist: artist || undefined,
				album: album || undefined
			}
		};
	}

	function artistLibraryIntent(name: string): LibraryIntent {
		const artist = name.trim();
		return {
			kind: 'artist',
			destination: 'search',
			query: artist,
			display: { title: artist }
		};
	}

	function itemDuration(seconds?: number): string {
		if (!seconds || Number.isNaN(seconds) || seconds < 0) return '--:--';
		const whole = Math.floor(seconds);
		return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
	}

	function totalDurationLabel(): string {
		if (!totalQueueSeconds) return '--';
		const hours = Math.floor(totalQueueSeconds / 3600);
		const minutes = Math.floor((totalQueueSeconds % 3600) / 60);
		return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
	}
</script>

<svelte:window onkeydown={handleWindowKeydown} />

<!-- Full-height right sheet in the approved Unified list language. -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="queue-backdrop" onclick={handleBackdropClick}>
	<div
		id="unified-queue-dialog"
		class="queue-panel"
		role="dialog"
		aria-modal="true"
		aria-labelledby="unified-queue-title"
		tabindex="-1"
		bind:this={dialogEl}
		use:focusTrap={{ initialFocus: '.queue-close' }}
	>
		<header class="queue-header">
			<div>
				<p class="eyebrow">UP NEXT</p>
				<h2 id="unified-queue-title">Queue</h2>
				<p class="meta">
					{activeZone?.display_name || 'No active zone'}
					<span aria-hidden="true">·</span>
					{totalDurationLabel()} total
				</p>
			</div>
			<button type="button" class="queue-close mono" aria-label="Close Queue" onclick={close}>
				Close
			</button>
		</header>

		<div class="queue-controls" role="group" aria-label="Queue playback settings">
			<button
				type="button"
				class:active={Boolean(activeZone?.settings?.shuffle)}
				aria-pressed={Boolean(activeZone?.settings?.shuffle)}
				disabled={settingsInFlight || !activeZone}
				onclick={() => void updateSettings({ shuffle: !activeZone?.settings?.shuffle })}
			>
				Shuffle
			</button>
			<button
				type="button"
				class:active={Boolean(activeZone?.settings?.auto_radio)}
				aria-pressed={Boolean(activeZone?.settings?.auto_radio)}
				disabled={settingsInFlight || !activeZone}
				onclick={() => void updateSettings({ auto_radio: !activeZone?.settings?.auto_radio })}
			>
				Auto Radio
			</button>
			<button
				type="button"
				disabled={settingsInFlight || !activeZone}
				onclick={() => void updateSettings({ loop: cycleLoop(activeZone?.settings?.loop) })}
			>
				Loop: {activeZone?.settings?.loop || 'disabled'}
			</button>
		</div>

		<div class="queue-rule"></div>

		{#if queueLoading}
			<p class="empty">Loading queue…</p>
		{:else if !activeZone}
			<p class="empty">Select a Roon zone to see its queue.</p>
		{:else if !activeQueue || activeQueue.items.length === 0}
			<p class="empty">Queue is empty for this zone.</p>
		{:else}
			<ol class="queue-list">
				{#each activeQueue.items as item, index (item.queue_item_id)}
					{@const libraryIntent = trackLibraryIntent(item)}
					<li class="queue-row" class:current={index === 0}>
						<div class="queue-index mono">
							{#if index === 0}<span class="now">NOW</span>{:else}{String(index + 1).padStart(2, '0')}{/if}
						</div>
						<div class="queue-art">
							{#if item.image_key}
								<img
									src={imageUrl(item.image_key, { width: 112, height: 112 })}
									alt=""
									loading="lazy"
									decoding="async"
									use:hideOnError
								/>
							{:else}
								<div class="queue-art-fallback" aria-hidden="true">♫</div>
							{/if}
						</div>
						<div class="queue-copy">
							<p class="title">
								{#if libraryIntent}
									<button
										type="button"
										class="queue-link"
										aria-label="Search Library for {itemTitle(item)}"
										onclick={() => void onlibraryintent(libraryIntent)}
									>{itemTitle(item)}</button>
								{:else}
									<span>{itemTitle(item)}</span>
								{/if}
							</p>
							{#if itemSubtitle(item)}
								<p class="artist">
									{#each splitArtists(itemSubtitle(item)) as artistName, artistIndex (artistIndex)}
										{#if artistIndex > 0}<span class="queue-seg-sep" aria-hidden="true">/</span>{/if}
										<button
											type="button"
											class="queue-link"
											aria-label="Search Library for {artistName}"
											onclick={() => void onlibraryintent(artistLibraryIntent(artistName))}
										>{artistName}</button>
									{/each}
								</p>
							{/if}
							{#if itemTertiary(item)}<p class="album">{itemTertiary(item)}</p>{/if}
						</div>
						<div class="queue-action">
							<span class="duration mono">{itemDuration(item.length)}</span>
							<button
								type="button"
								disabled={queueActionInFlight}
								aria-label="Play from {itemTitle(item)}"
								onclick={() => void playFromHere(item.queue_item_id, itemTitle(item))}
							>
								Play here
							</button>
						</div>
					</li>
				{/each}
			</ol>
		{/if}
	</div>
</div>

<style>
	/* Layout-level panel: use the same theme tokens as the Unified surface. */
	.queue-backdrop {
		position: fixed;
		inset: 0;
		z-index: 900;
		display: flex;
		justify-content: flex-end;
		background: var(--songr-scrim-72);
	}

	.queue-panel {
		display: flex;
		flex-direction: column;
		width: min(660px, 52vw);
		min-width: 420px;
		height: 100%;
		padding: 28px 26px 30px;
		overflow: hidden;
		background: var(--songr-queue-bg);
		color: var(--songr-queue-text);
		border-left: 1px solid var(--songr-line);
		box-shadow: -24px 0 60px var(--songr-shadow);
		font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
	}

	.queue-panel:focus {
		outline: none;
	}

	.mono {
		font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
	}

	.queue-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 20px;
	}

	.eyebrow {
		margin: 0 0 5px;
		color: var(--songr-accent);
		font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.22em;
	}

	h2 {
		margin: 0;
		font-size: clamp(27px, 3vw, 38px);
		font-weight: 560;
		letter-spacing: -0.035em;
	}

	.meta {
		display: flex;
		gap: 8px;
		margin: 8px 0 0;
		color: var(--songr-subtle);
		font-size: 12px;
	}

	.queue-close {
		padding: 7px 10px;
		background: transparent;
		color: var(--songr-subtle);
		border: 1px solid var(--songr-line);
		border-radius: 7px;
		font-size: 10px;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		cursor: pointer;
	}

	.queue-close:hover,
	.queue-close:focus-visible {
		color: var(--songr-accent-bright);
		border-color: var(--songr-accent);
		outline: none;
	}

	.queue-controls {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 22px;
	}

	.queue-controls button,
	.queue-action button {
		padding: 7px 10px;
		background: var(--songr-surface-11);
		color: var(--songr-soft);
		border: 1px solid var(--songr-line);
		border-radius: 7px;
		font: inherit;
		font-size: 11px;
		cursor: pointer;
	}

	.queue-controls button:hover:not(:disabled),
	.queue-controls button:focus-visible,
	.queue-action button:hover:not(:disabled),
	.queue-action button:focus-visible {
		color: var(--songr-accent-bright);
		border-color: var(--songr-accent);
		outline: 1px solid var(--songr-accent);
		outline-offset: 2px;
	}

	.queue-controls button.active {
		color: var(--songr-on-accent);
		background: var(--songr-accent);
		border-color: var(--songr-accent);
	}

	.queue-controls button.active:focus-visible {
		outline-color: var(--songr-queue-text);
	}

	.queue-controls button:disabled,
	.queue-action button:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.queue-link {
		padding: 0;
		background: transparent;
		color: inherit;
		border: 0;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}

	.queue-link:hover,
	.queue-link:focus-visible {
		color: var(--songr-accent-bright);
		outline: 1px solid var(--songr-accent);
		outline-offset: 2px;
	}

	.queue-seg-sep {
		margin: 0 0.35em;
	}

	.queue-rule {
		margin: 20px 0 0;
		border-top: 1px solid var(--songr-line);
	}

	.empty {
		margin: 30px 0;
		color: var(--songr-subtle);
		font-size: 13px;
	}

	.queue-list {
		min-height: 0;
		margin: 0 -10px 0 0;
		padding: 10px 10px 10px 0;
		overflow-y: auto;
		list-style: none;
		scrollbar-color: var(--songr-queue-scrollbar) transparent;
	}

	.queue-row {
		display: grid;
		grid-template-columns: 32px 56px minmax(0, 1fr) auto;
		align-items: center;
		gap: 12px;
		min-height: 74px;
		padding: 9px 10px 9px 6px;
		border-bottom: 1px solid var(--songr-line-07);
	}

	.queue-row.current {
		background: linear-gradient(
			90deg,
			color-mix(in srgb, var(--songr-accent) 13%, transparent),
			transparent 72%
		);
		box-shadow: inset 2px 0 var(--songr-accent);
	}

	.queue-index {
		color: var(--songr-dim);
		font-size: 10px;
		letter-spacing: 0.05em;
		text-align: center;
	}

	.queue-index .now {
		color: var(--songr-accent-bright);
		font-size: 8px;
		font-weight: 700;
		letter-spacing: 0.08em;
	}

	.queue-art,
	.queue-art img,
	.queue-art-fallback {
		width: 56px;
		height: 56px;
		border-radius: 7px;
	}

	.queue-art {
		overflow: hidden;
		background: var(--songr-raise);
	}

	.queue-art img {
		display: block;
		object-fit: cover;
	}

	.queue-art-fallback {
		display: grid;
		place-items: center;
		color: var(--songr-dim);
		font-size: 18px;
	}

	.queue-copy {
		min-width: 0;
	}

	.queue-copy p {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.title {
		margin: 0;
		color: var(--songr-queue-text);
		font-size: 13px;
		font-weight: 600;
	}

	.artist,
	.album {
		margin: 3px 0 0;
		color: var(--songr-soft);
		font-size: 11px;
	}

	.album {
		color: var(--songr-dim);
	}

	.queue-action {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.duration {
		color: var(--songr-subtle);
		font-size: 10px;
	}

	.queue-action button {
		white-space: nowrap;
	}

	@media (max-width: 760px) {
		.queue-panel {
			width: 100%;
			min-width: 0;
			padding: 20px 16px;
			border-left: 0;
		}

		.queue-row {
			grid-template-columns: 24px 48px minmax(0, 1fr);
		}

		.queue-art,
		.queue-art img,
		.queue-art-fallback {
			width: 48px;
			height: 48px;
		}

		.queue-action {
			grid-column: 3;
			justify-content: space-between;
			margin-top: -5px;
		}
	}
</style>
