<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { getSocket } from '$lib/socket/client';
	import { emitWithAck } from '$lib/socket/emit';
	import {
		selectedZoneStore,
		queueStore,
		setQueueSnapshot,
		pushCommandFeedback,
		socketStatusStore
	} from '$lib/stores';
	import { publishLibraryIntent, cancelLibraryIntent } from '$lib/stores/libraryIntentStore';
	import { zoneMapStore } from '$lib/stores/zonesStore';
	import { splitArtists } from '$lib/artistList';
	import { imageUrl } from '$lib/imageUrl';
	import { hideOnError } from '$lib/actions/imageFallback';
	import type { LibraryIntent } from '$lib/libraryIntent';
	import type { LoopModeRequest, QueueItem, ZoneQueue, ZonePlaybackSettingsRequest } from '@shared/types';

	let socket = $state(getSocket());
	let queueLoading = $state(false);
	let queueActionInFlight = $state(false);
	let settingsInFlight = $state(false);

	onMount(() => {
		socket = getSocket();
	});

	$effect(() => {
		// Depends on the socket status as well as the zone: queue-updated
		// events missed during a connection drop leave the store stale,
		// and the server does not replay them. When the status flips back
		// to 'connected' this re-runs, and the subscribe ack carries a
		// fresh queue snapshot. Gating on 'connected' also stops the
		// zone-change path from firing a doomed emit (plus failure toast)
		// while disconnected — the reconnect re-run covers it instead.
		if ($selectedZoneStore && $socketStatusStore === 'connected') {
			void subscribeQueue($selectedZoneStore);
		}
	});

	const activeZone = $derived($selectedZoneStore ? $zoneMapStore.get($selectedZoneStore) : undefined);
	const activeQueue = $derived($selectedZoneStore ? $queueStore[$selectedZoneStore] : undefined);
	const totalQueueSeconds = $derived((activeQueue?.items ?? []).reduce((sum, item) => sum + (item.length ?? 0), 0));

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

	async function subscribeQueue(zoneId: string) {
		const liveSocket = getLiveSocket();
		if (!liveSocket) {
			return;
		}

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

	async function playFromHere(queueItemId: number, title: string) {
		if (!$selectedZoneStore) {
			return;
		}

		const liveSocket = getLiveSocket();
		if (!liveSocket) {
			return;
		}

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

	async function updateSettings(patch: Omit<ZonePlaybackSettingsRequest, 'zone_id'>) {
		if (!$selectedZoneStore) {
			return;
		}

		const liveSocket = getLiveSocket();
		if (!liveSocket) {
			return;
		}

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
		if (current === 'disabled') {
			return 'loop';
		}
		if (current === 'loop') {
			return 'loop_one';
		}
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

	/**
	 * Queue rows carry transient queue/media identifiers, but a Library
	 * handoff needs only an inert semantic search. Publish that intent
	 * synchronously before routing so the lazy Library host can consume it
	 * on mount. If navigation fails, cancel only this request so it cannot
	 * replay on a later visit without erasing a newer handoff.
	 */
	async function openLibrary(intent: LibraryIntent): Promise<void> {
		const pending = publishLibraryIntent(intent);
		if (!pending) return;

		try {
			await goto('/library');
		} catch (err) {
			cancelLibraryIntent(pending.requestId);
			pushCommandFeedback({
				source: 'queue',
				command: 'library:navigate',
				message: `Couldn't open Library: ${(err as Error).message}`
			});
		}
	}

	function itemDuration(seconds?: number): string {
		if (!seconds || Number.isNaN(seconds) || seconds < 0) {
			return '--:--';
		}
		const whole = Math.floor(seconds);
		const mins = Math.floor(whole / 60);
		const secs = whole % 60;
		return `${mins}:${String(secs).padStart(2, '0')}`;
	}

	function totalDurationLabel(): string {
		const seconds = totalQueueSeconds;
		if (!seconds) {
			return '--';
		}

		const hrs = Math.floor(seconds / 3600);
		const mins = Math.floor((seconds % 3600) / 60);
		if (hrs > 0) {
			return `${hrs}h ${mins}m`;
		}
		return `${mins}m`;
	}

	function isCurrentRow(index: number): boolean {
		// Roon's queue subscription delivers items starting at the currently
		// playing track (verified by capture against a live Core, May 2026).
		// When a track is consumed, Roon issues a `remove` op at index 0 so
		// the new index 0 is the new current track. Using the row index is
		// reliable; the substring-match heuristic this replaces would
		// mis-highlight whenever titles repeated.
		return index === 0;
	}
</script>

<div class="queue-layout">
	<section class="queue-panel card">
		<div class="queue-header">
			<div>
				<h2>Queue</h2>
				<p class="meta">{activeZone?.display_name || 'No active zone'} · {totalDurationLabel()} total</p>
			</div>
			<div class="queue-controls">
				<button
					type="button"
					disabled={settingsInFlight || !activeZone}
					onclick={() => {
						void updateSettings({ shuffle: !activeZone?.settings?.shuffle });
					}}
					class:active={Boolean(activeZone?.settings?.shuffle)}
				>
					Shuffle
				</button>
				<button
					type="button"
					disabled={settingsInFlight || !activeZone}
					onclick={() => {
						void updateSettings({ auto_radio: !activeZone?.settings?.auto_radio });
					}}
					class:active={Boolean(activeZone?.settings?.auto_radio)}
				>
					Auto Radio
				</button>
				<button
					type="button"
					disabled={settingsInFlight || !activeZone}
					onclick={() => {
						void updateSettings({ loop: cycleLoop(activeZone?.settings?.loop) });
					}}
				>
					Loop: {activeZone?.settings?.loop || 'disabled'}
				</button>
			</div>
		</div>

		{#if queueLoading}
			<p class="placeholder-copy">Loading queue...</p>
		{:else if !activeQueue || activeQueue.items.length === 0}
			<p class="placeholder-copy">Queue is empty for this zone.</p>
		{:else}
			<div class="queue-list">
				{#each activeQueue.items as item, index}
					{@const libraryIntent = trackLibraryIntent(item)}
					<article class="queue-item" class:current={isCurrentRow(index)}>
						<div class="item-art">
							{#if item.image_key}
								<img
									src={imageUrl(item.image_key, { width: 120, height: 120 })}
									alt={itemTitle(item)}
									loading="lazy"
									decoding="async"
									use:hideOnError
								/>
							{:else}
								<div class="fallback">#{item.queue_item_id}</div>
							{/if}
						</div>
						<div class="item-body">
							<p class="title">
								{#if libraryIntent}
									<button
										type="button"
										class="queue-link"
										title="Search for {itemTitle(item)}"
										onclick={() => void openLibrary(libraryIntent)}
									>{itemTitle(item)}</button>
								{:else}
									<span>{itemTitle(item)}</span>
								{/if}
							</p>
							{#if itemSubtitle(item)}
								<!-- line2 is the artist credit; multi-artist
								     credits arrive " / "-joined — link each
								     name individually. -->
								<p class="subtitle">
									{#each splitArtists(itemSubtitle(item)) as artistName, i (i)}
										{#if i > 0}<span class="queue-seg-sep" aria-hidden="true">/</span>{/if}
										<button
											type="button"
											class="queue-link"
											title="Search for {artistName}"
											onclick={() => void openLibrary(artistLibraryIntent(artistName))}
										>{artistName}</button>
									{/each}
								</p>
							{/if}
							{#if itemTertiary(item)}
								<p class="tertiary">{itemTertiary(item)}</p>
							{/if}
						</div>
						<div class="item-actions">
							<span>{itemDuration(item.length)}</span>
							<button
								type="button"
								onclick={() => {
									void playFromHere(item.queue_item_id, itemTitle(item));
								}}
								disabled={queueActionInFlight}
							>
								Play Here
							</button>
						</div>
					</article>
				{/each}
			</div>
		{/if}
	</section>

	<section class="up-next card" aria-label="Up next">
		<h2>Up Next</h2>
		{#if !activeQueue || activeQueue.items.length === 0}
			<p class="placeholder-copy">Nothing queued — play an album or playlist to fill this up.</p>
		{:else}
			{@const upcoming = activeQueue.items.slice(1, 6)}
			{#if upcoming.length === 0}
				<p class="placeholder-copy">Queue ends after the current track.</p>
			{:else}
				<ol class="up-next-list">
					{#each upcoming as item (item.queue_item_id)}
						<li>
							<span class="up-next-title">{itemTitle(item)}</span>
							<span class="up-next-len">{itemDuration(item.length)}</span>
							{#if itemSubtitle(item)}
								<span class="up-next-sub">{itemSubtitle(item)}</span>
							{/if}
						</li>
					{/each}
				</ol>
				{#if activeQueue.items.length - 1 > upcoming.length}
					<p class="up-next-more">
						+{activeQueue.items.length - 1 - upcoming.length} more · {totalDurationLabel()} total
					</p>
				{/if}
			{/if}
		{/if}
	</section>
</div>

<style>
	.queue-layout {
		display: grid;
		grid-template-columns: 1.2fr 0.8fr;
		gap: 0.85rem;
	}

	.queue-panel,
	.up-next {
		padding: 0.85rem;
		background: var(--surface);
	}

	.queue-header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 0.75rem;
		margin-bottom: 0.8rem;
	}

	.queue-header h2,
	.up-next h2 {
		font-family: var(--font-display);
		font-size: 1.05rem;
	}

	.meta {
		margin-top: 0.2rem;
		font-size: 0.82rem;
		color: var(--text-soft);
	}

	.queue-controls {
		display: flex;
		gap: 0.42rem;
		flex-wrap: wrap;
		justify-content: flex-end;
	}

	.queue-controls button {
		padding: 0.42rem 0.6rem;
		border: 1px solid var(--border);
		border-radius: 9px;
		background: var(--surface-2);
		font-size: 0.8rem;
	}

	.queue-controls button.active {
		border-color: var(--accent-2);
		background: rgba(95, 109, 240, 0.2);
	}

	.queue-controls button:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}

	.placeholder-copy,
	.up-next-more {
		color: var(--text-soft);
	}

	.queue-list {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.queue-item {
		display: grid;
		grid-template-columns: 58px 1fr auto;
		gap: 0.62rem;
		padding: 0.5rem;
		border: 1px solid var(--border);
		border-radius: 10px;
		background: var(--surface-2);
	}

	.queue-item.current {
		border-color: var(--accent-2);
		background: rgba(95, 109, 240, 0.15);
	}

	.item-art {
		width: 58px;
		height: 58px;
		border-radius: 8px;
		overflow: hidden;
		background: var(--surface-3);
	}

	.item-art img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.fallback {
		display: grid;
		place-items: center;
		height: 100%;
		font-size: 0.72rem;
		color: var(--text-soft);
	}

	.item-body {
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: 0.1rem;
	}

	.item-body .title {
		font-weight: 640;
		line-height: 1.25;
	}

	.item-body .subtitle,
	.item-body .tertiary {
		font-size: 0.79rem;
		line-height: 1.28;
		color: var(--text-soft);
	}

	/* Queue title/subtitle render as search links (BUGS.md #7) while
	   keeping their parent's typography. */
	.queue-link {
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		color: inherit;
		text-align: left;
		cursor: pointer;
	}

	.queue-link:hover {
		color: var(--text);
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.queue-seg-sep {
		margin: 0 0.25rem;
		opacity: 0.6;
	}

	.item-actions {
		display: flex;
		flex-direction: column;
		justify-content: center;
		align-items: flex-end;
		gap: 0.28rem;
	}

	.item-actions span {
		font-family: var(--font-mono);
		font-size: 0.76rem;
		color: var(--text-soft);
	}

	.item-actions button {
		padding: 0.35rem 0.58rem;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--surface-3);
		font-size: 0.76rem;
	}

	.item-actions button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.up-next {
		display: flex;
		flex-direction: column;
		gap: 0.65rem;
		align-self: start;
	}

	.up-next-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
	}

	.up-next-list li {
		display: grid;
		grid-template-columns: 1fr auto;
		column-gap: 0.5rem;
		padding: 0.42rem 0.55rem;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--surface-2);
	}

	.up-next-title {
		font-size: 0.84rem;
		font-weight: 600;
		line-height: 1.3;
	}

	.up-next-sub {
		grid-column: 1 / -1;
		font-size: 0.78rem;
		line-height: 1.3;
		color: var(--text-soft);
	}

	.up-next-len {
		font-family: var(--font-mono);
		font-size: 0.75rem;
		color: var(--text-soft);
		align-self: center;
	}

	.up-next-more {
		font-size: 0.78rem;
	}

	@media (max-width: 980px) {
		.queue-layout {
			grid-template-columns: 1fr;
		}
	}

	@media (max-width: 700px) {
		.queue-header {
			flex-direction: column;
		}

		.queue-controls {
			justify-content: flex-start;
		}

		.queue-item {
			grid-template-columns: 1fr;
		}

		.item-actions {
			align-items: flex-start;
			flex-direction: row;
			justify-content: flex-start;
		}
	}
</style>
