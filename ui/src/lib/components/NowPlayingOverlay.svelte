<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { get } from 'svelte/store';
	import { nowPlayingOverlayStore, closeNowPlayingOverlay } from '$lib/stores/nowPlayingOverlayStore';
	import { nowPlayingList } from '$lib/stores/nowPlayingStore';
	import { selectedZoneStore } from '$lib/stores/selectedZoneStore';
	import { zoneMapStore } from '$lib/stores/zonesStore';
	import { interpolatedSeekStore } from '$lib/stores/interpolatedSeekStore';
	import { pushCommandFeedback } from '$lib/stores/commandFeedbackStore';
	import { getSocket } from '$lib/socket/client';
	import { emitWithAck } from '$lib/socket/emit';
	import { imageUrl } from '$lib/imageUrl';
	import { hideOnError } from '$lib/actions/imageFallback';
	import { createOptimisticSeekBase, seekTargetForKey } from '$lib/seekKeys';
	import type {
		TransportControlRequest,
		SeekRequest,
		ZoneOutput
	} from '@shared/types';

	/**
	 * Optional click handler the layout can pass in to wire "Go to
	 * album" to its existing `openAlbumOfNowPlaying`. Defaults to a
	 * no-op so the overlay is mountable in isolation (tests).
	 */
	interface Props {
		onOpenAlbum?: () => void;
	}
	let { onOpenAlbum }: Props = $props();

	const nowPlaying = $derived(
		$selectedZoneStore ? $nowPlayingList.find((t) => t.zone_id === $selectedZoneStore) : undefined
	);
	const activeZone = $derived(
		$selectedZoneStore ? $zoneMapStore.get($selectedZoneStore) : undefined
	);
	const isPlaying = $derived(activeZone?.state === 'playing');
	const canPlay = $derived(!!(activeZone?.is_play_allowed || activeZone?.is_pause_allowed));
	const canPrev = $derived(!!activeZone?.is_previous_allowed);
	const canNext = $derived(!!activeZone?.is_next_allowed);
	const canSeek = $derived(!!activeZone?.is_seek_allowed);
	const duration = $derived(nowPlaying?.duration ?? 0);
	// Interpolated between 1 Hz server ticks so the bar moves smoothly
	// while playing; clamped to the track length since interpolation can
	// overshoot the end between ticks.
	const seekPosition = $derived.by(() => {
		const raw =
			($selectedZoneStore ? $interpolatedSeekStore.get($selectedZoneStore) : undefined) ??
			activeZone?.seek_position ??
			0;
		return duration > 0 ? Math.min(raw, duration) : raw;
	});
	const progress = $derived(duration > 0 ? Math.min(seekPosition / duration, 1) : 0);

	let commandInFlight = $state(false);

	function formatTime(seconds: number): string {
		if (!seconds || seconds < 0) return '0:00';
		const whole = Math.floor(seconds);
		const m = Math.floor(whole / 60);
		const s = whole % 60;
		return `${m}:${String(s).padStart(2, '0')}`;
	}

	function getLiveSocket() {
		const s = getSocket();
		if (!s) {
			pushCommandFeedback({
				source: 'transport',
				command: 'socket',
				message: 'Realtime connection unavailable.'
			});
			return null;
		}
		return s;
	}

	async function sendCommand(event: string, payload: TransportControlRequest) {
		const s = getLiveSocket();
		if (!s || commandInFlight) return;
		commandInFlight = true;
		try {
			await emitWithAck(s, event, payload, {
				timeoutMs: 3000,
				feedback: { source: 'transport', command: event }
			});
		} finally {
			commandInFlight = false;
		}
	}

	function playPause() {
		const z = get(selectedZoneStore);
		if (z) void sendCommand('transport:play-pause', { zone_id: z });
	}
	function next() {
		const z = get(selectedZoneStore);
		if (z) void sendCommand('transport:next', { zone_id: z });
	}
	function previous() {
		const z = get(selectedZoneStore);
		if (z) void sendCommand('transport:previous', { zone_id: z });
	}

	// Base for repeated seeks between 1 Hz server ticks (rev-8): a held
	// arrow key must step from the last sent target, not the stale
	// server position. Keyed by zone AND track identity (title +
	// duration — the strongest identity the now-playing payload
	// carries) so a track change mid-hold can't reuse the old track's
	// absolute target.
	const optimisticSeek = createOptimisticSeekBase();
	const seekContext = $derived(
		$selectedZoneStore
			? `${$selectedZoneStore}::${nowPlaying?.title ?? ''}::${duration}`
			: null
	);

	function sendSeek(seconds: number) {
		const z = get(selectedZoneStore);
		if (!z) return;
		const s = getLiveSocket();
		if (s) {
			const token = optimisticSeek.record(seekContext, seconds);
			void emitWithAck(
				s,
				'transport:seek',
				{ zone_id: z, seconds } satisfies SeekRequest,
				{ feedback: { source: 'transport', command: 'transport:seek' } }
			).then((res) => {
				// A failed/disconnected seek must not leave a phantom base;
				// token-guarded so an older failure never clears a newer
				// pending seek.
				if (!res?.success) optimisticSeek.invalidate(token);
			});
		}
	}

	function seekTo(e: MouseEvent) {
		if (!canSeek || !duration) return;
		const bar = e.currentTarget as HTMLElement;
		const rect = bar.getBoundingClientRect();
		const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
		sendSeek(Math.floor(fraction * duration));
	}

	function seekKeydown(e: KeyboardEvent) {
		if (!canSeek || !duration) return;
		const target = seekTargetForKey(
			e.key,
			optimisticSeek.base(seekContext, seekPosition),
			duration
		);
		if (target === null) return;
		e.preventDefault();
		sendSeek(target);
	}

	function onBackdropClick(e: MouseEvent) {
		// Click on the backdrop closes; clicks inside the dialog
		// shouldn't bubble (target check guards against that).
		if (e.target === e.currentTarget) {
			closeNowPlayingOverlay();
		}
	}

	function onAlbumClick() {
		closeNowPlayingOverlay();
		onOpenAlbum?.();
	}

	// Refs for focus management. `dialogEl` is the modal container we
	// move focus into on open; `previouslyFocused` is the element that
	// owned focus before the overlay opened, restored on close.
	let dialogEl: HTMLDivElement | null = $state(null);
	let previouslyFocused: HTMLElement | null = null;

	// Esc key closes the overlay. The listener is attached only while
	// open to avoid mass-firing on every keydown in the app.
	onMount(() => {
		const handler = (e: KeyboardEvent) => {
			if (!get(nowPlayingOverlayStore)) return;
			if (e.key === 'Escape') {
				closeNowPlayingOverlay();
			} else if (e.key === 'Tab' && dialogEl) {
				// Focus trap: keep Tab cycling inside the dialog so a
				// keyboard user can't reach controls underneath the
				// backdrop. Build a fresh focusable list per keydown
				// because button enable/disable state can change as
				// the underlying zone updates.
				const focusables = getFocusable(dialogEl);
				if (focusables.length === 0) {
					e.preventDefault();
					dialogEl.focus();
					return;
				}
				const first = focusables[0];
				const last = focusables[focusables.length - 1];
				const active = document.activeElement as HTMLElement | null;
				if (e.shiftKey && active === first) {
					e.preventDefault();
					last.focus();
				} else if (!e.shiftKey && active === last) {
					e.preventDefault();
					first.focus();
				} else if (active && !dialogEl.contains(active)) {
					// Focus escaped the dialog somehow (e.g. external
					// script). Pull it back to the first focusable.
					e.preventDefault();
					first.focus();
				}
			}
		};
		window.addEventListener('keydown', handler);
		return () => window.removeEventListener('keydown', handler);
	});

	function getFocusable(root: HTMLElement): HTMLElement[] {
		const selector =
			'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
		return Array.from(root.querySelectorAll<HTMLElement>(selector));
	}

	// Reactively handle open/close transitions for focus.
	// On open: snapshot the prior focus owner, move focus into the
	// dialog. On close: restore focus to the opener (if still in the
	// document). Use the store value as the trigger — derived on
	// every change of `nowPlayingOverlayStore`.
	$effect(() => {
		const open = $nowPlayingOverlayStore;
		if (open) {
			previouslyFocused = document.activeElement as HTMLElement | null;
			void tick().then(() => {
				if (!dialogEl) return;
				// Prefer the close button for first focus — predictable
				// landing spot, common modal pattern.
				const closeBtn = dialogEl.querySelector<HTMLElement>(
					'.np-close'
				);
				(closeBtn ?? dialogEl).focus();
			});
		} else if (previouslyFocused && document.body.contains(previouslyFocused)) {
			previouslyFocused.focus();
			previouslyFocused = null;
		}
	});

	// Volume control mirrors the play-bar's. Same derivation logic:
	// pick the first output that has a volume control; absent → no
	// slider (fixed-volume DAC).
	const volumeOutput = $derived<ZoneOutput | undefined>(
		activeZone?.outputs?.find((o) => o.volume !== undefined)
	);
	const volumeIsIncremental = $derived(volumeOutput?.volume?.type === 'incremental');

	function sendVolume(value: number) {
		const out = volumeOutput;
		if (!out?.volume) return;
		const s = getLiveSocket();
		if (!s) return;
		void emitWithAck(
			s,
			'transport:volume',
			{ output_id: out.output_id, value },
			{ feedback: { source: 'transport', command: 'transport:volume' } }
		);
	}

	function onVolumeStep(delta: number) {
		sendVolume(delta);
	}

	// rAF-throttled volume slider — mirrors the play-bar's pattern.
	// Without this, native range drag fires `input` per pixel,
	// flooding Roon with transport:volume emits and triggering the
	// stale-ack toast storm. We coalesce to one emit per animation
	// frame (max 60Hz) and always send the LATEST pending value,
	// including the final drag position. The +/- buttons stay as
	// direct sendVolume() calls because they're discrete clicks, not
	// drag.
	let pendingVolume: number | null = null;
	let volumeRafId: number | null = null;

	function flushVolume() {
		volumeRafId = null;
		if (pendingVolume === null) return;
		const value = pendingVolume;
		pendingVolume = null;
		sendVolume(value);
	}

	function onVolumeSlide(e: Event) {
		const target = e.currentTarget as HTMLInputElement;
		const value = Number(target.value);
		if (!Number.isFinite(value)) return;
		pendingVolume = value;
		if (volumeRafId === null) {
			volumeRafId = requestAnimationFrame(flushVolume);
		}
	}
</script>

{#if $nowPlayingOverlayStore}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="np-backdrop"
		role="dialog"
		aria-modal="true"
		aria-label="Now playing"
		tabindex="-1"
		bind:this={dialogEl}
		onclick={onBackdropClick}
	>
		<div class="np-dialog">
			<button
				type="button"
				class="np-close"
				onclick={closeNowPlayingOverlay}
				aria-label="Close now playing"
			>✕</button>

			<div class="np-art">
				{#if nowPlaying?.image_key}
					<img
						src={imageUrl(nowPlaying.image_key, { width: 480, height: 480 })}
						alt={nowPlaying?.album ? `${nowPlaying.album} artwork` : 'Artwork'}
						decoding="async"
						use:hideOnError
					/>
				{:else}
					<div class="np-art-placeholder">♫</div>
				{/if}
			</div>

			<div class="np-meta">
				{#if nowPlaying?.title}
					<h2 class="np-title">{nowPlaying.title}</h2>
				{:else}
					<h2 class="np-title np-title-empty">Nothing playing</h2>
				{/if}
				{#if nowPlaying?.artist}
					<p class="np-artist">{nowPlaying.artist}</p>
				{/if}
				{#if nowPlaying?.album}
					<button
						type="button"
						class="np-album np-link"
						onclick={onAlbumClick}
						aria-label="Go to album {nowPlaying.album}"
					>{nowPlaying.album}</button>
				{/if}

				<div
					class="np-progress"
					class:seekable={canSeek}
					role="slider"
					tabindex={canSeek ? 0 : -1}
					aria-label="Seek"
					aria-valuemin={0}
					aria-valuemax={Math.max(0, Math.floor(duration))}
					aria-valuenow={Math.max(0, Math.min(Math.floor(seekPosition), Math.floor(duration)))}
					aria-valuetext="{formatTime(seekPosition)} of {formatTime(duration)}"
					aria-disabled={!canSeek}
					onclick={seekTo}
					onkeydown={seekKeydown}
				>
					<div class="np-progress-fill" style="width: {progress * 100}%"></div>
				</div>
				<div class="np-times">
					<span>{formatTime(seekPosition)}</span>
					<span>{formatTime(duration)}</span>
				</div>

				<div class="np-controls">
					<button
						type="button"
						class="np-ctrl"
						onclick={previous}
						disabled={!canPrev || commandInFlight}
						aria-label="Previous"
					>⏮</button>
					<button
						type="button"
						class="np-ctrl primary"
						onclick={playPause}
						disabled={!canPlay || commandInFlight}
						aria-label={isPlaying ? 'Pause' : 'Play'}
					>{isPlaying ? '⏸' : '▶'}</button>
					<button
						type="button"
						class="np-ctrl"
						onclick={next}
						disabled={!canNext || commandInFlight}
						aria-label="Next"
					>⏭</button>
				</div>

				{#if volumeOutput?.volume}
					{#if volumeIsIncremental}
						<div class="np-vol-incremental">
							<button
								type="button"
								class="np-vol-step"
								onclick={() => onVolumeStep(-1)}
								aria-label="Volume down"
							>−</button>
							<span class="np-vol-icon">🔊</span>
							<button
								type="button"
								class="np-vol-step"
								onclick={() => onVolumeStep(1)}
								aria-label="Volume up"
							>+</button>
						</div>
					{:else}
						<label class="np-vol-slider">
							<span class="np-vol-icon" aria-hidden="true">🔊</span>
							<input
								type="range"
								min={volumeOutput.volume.min}
								max={volumeOutput.volume.max}
								step={volumeOutput.volume.step ?? 1}
								value={volumeOutput.volume.value}
								oninput={onVolumeSlide}
								aria-label="Volume"
							/>
						</label>
					{/if}
				{/if}
			</div>
		</div>
	</div>
{/if}

<style>
	.np-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.75);
		display: grid;
		place-items: center;
		z-index: 1000;
		padding: 1rem;
	}

	.np-dialog {
		background: var(--surface);
		color: var(--text);
		border: 1px solid var(--border);
		border-radius: 12px;
		box-shadow: var(--shadow-strong);
		max-width: 720px;
		width: 100%;
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr);
		gap: 1.5rem;
		padding: 2rem;
		position: relative;
	}

	@media (max-width: 720px) {
		.np-backdrop {
			padding: 0;
		}
		.np-dialog {
			max-width: 100%;
			width: 100%;
			height: 100%;
			border-radius: 0;
			grid-template-columns: 1fr;
			grid-template-rows: auto auto;
			overflow-y: auto;
		}
	}

	.np-close {
		position: absolute;
		top: 0.5rem;
		right: 0.5rem;
		background: transparent;
		color: inherit;
		border: 0;
		font-size: 1.2rem;
		line-height: 1;
		padding: 0.5rem 0.75rem;
		cursor: pointer;
		border-radius: 8px;
	}
	.np-close:hover {
		background: var(--surface-2);
	}

	.np-art img,
	.np-art-placeholder {
		width: 100%;
		aspect-ratio: 1;
		object-fit: cover;
		border-radius: 8px;
		background: var(--surface-3);
		display: grid;
		place-items: center;
		font-size: 3rem;
		color: var(--text-soft);
	}

	.np-meta {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		min-width: 0;
	}

	.np-title {
		font-size: 1.5rem;
		font-weight: 600;
		margin: 0;
		line-height: 1.2;
		word-break: break-word;
	}
	.np-title-empty {
		color: var(--text-soft);
	}

	.np-artist {
		font-size: 1.05rem;
		margin: 0;
		color: var(--text-soft);
	}

	.np-album {
		font-size: 0.95rem;
		text-align: left;
		padding: 0;
		color: var(--text-soft);
		background: transparent;
		border: 0;
		cursor: pointer;
	}
	.np-link:hover {
		color: var(--accent);
		text-decoration: underline;
	}

	.np-progress {
		position: relative;
		height: 6px;
		background: var(--border);
		border-radius: 3px;
		margin-top: 1rem;
		cursor: default;
	}
	.np-progress.seekable {
		cursor: pointer;
	}
	.np-progress:focus-visible {
		outline: 2px solid var(--accent-2);
		outline-offset: 2px;
	}
	.np-progress-fill {
		position: absolute;
		left: 0;
		top: 0;
		bottom: 0;
		background: var(--accent);
		border-radius: 3px;
	}

	.np-times {
		display: flex;
		justify-content: space-between;
		font-size: 0.85rem;
		color: var(--text-soft);
		margin-top: 0.3rem;
	}

	.np-controls {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.75rem;
		margin-top: 1rem;
	}

	.np-ctrl {
		background: var(--surface-2);
		color: inherit;
		border: 1px solid var(--border);
		border-radius: 999px;
		width: 44px;
		height: 44px;
		font-size: 1.1rem;
		cursor: pointer;
	}
	.np-ctrl:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	.np-ctrl.primary {
		background: var(--accent);
		border-color: var(--accent);
		color: #fff;
		width: 56px;
		height: 56px;
		font-size: 1.4rem;
	}

	.np-vol-slider,
	.np-vol-incremental {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-top: 1rem;
	}
	.np-vol-slider input[type='range'] {
		flex: 1;
	}
	.np-vol-step {
		background: var(--surface-2);
		color: inherit;
		border: 1px solid var(--border);
		border-radius: 6px;
		width: 32px;
		height: 32px;
		cursor: pointer;
	}
</style>
