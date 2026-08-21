<script lang="ts">
	import '../app.css';
	import { page } from '$app/stores';
	import { onMount, tick } from 'svelte';
	import { resolveAppShellContract } from '$lib/appShellContract';
	import { isCorePaired } from '$lib/stores/coreStore';
	import { healthStore } from '$lib/stores/healthStore';
	import { libraryViewHostStore } from '$lib/stores/libraryViewHostStore';
	import { workspaceShellStore } from '$lib/stores/workspaceShellStore';
	import { initializeTheme } from '$lib/stores/themeStore';
	import { unifiedLibraryPrefsStore } from '$lib/stores/unifiedLibraryPrefsStore';
	import {
		initializeStores,
		clearCommandFeedback,
		nowPlayingList,
		selectedZoneStore,
		setSelectedZone,
		pushCommandFeedback,
		socketStatusStore
	} from '$lib/stores';
	import { goto } from '$app/navigation';
	import { zonesStore, zoneMapStore } from '$lib/stores/zonesStore';
	import { interpolatedSeekStore } from '$lib/stores/interpolatedSeekStore';
	import { registerSocketHandlers } from '$lib/socket/register';
	import { startDocumentTitleBinding } from '$lib/media/documentTitle';
	import { startMediaSessionBinding } from '$lib/media/mediaSessionBinding';
	import { startSpacebarPlayPause } from '$lib/media/spacebarPlayPause';
	import { getSocket } from '$lib/socket/client';
	import { emitWithAck } from '$lib/socket/emit';
	import { splitArtists } from '$lib/artistList';
	import type { LibraryIntent } from '$lib/libraryIntent';
	import {
		cancelLibraryIntent,
		publishLibraryIntent
	} from '$lib/stores/libraryIntentStore';
	import ErrorToast from '$lib/components/ErrorToast.svelte';
	import OnboardingFlow from '$lib/components/OnboardingFlow.svelte';
	import AppSettingsMenu from '$lib/components/AppSettingsMenu.svelte';
	import NowPlayingOverlay from '$lib/components/NowPlayingOverlay.svelte';
	import { openNowPlayingOverlay } from '$lib/stores/nowPlayingOverlayStore';
	import ZoneGroupingModal from '$lib/components/ZoneGroupingModal.svelte';
	import { openZoneGrouping } from '$lib/stores/zoneGroupingStore';
	import UnifiedQueuePanel from './library/UnifiedQueuePanel.svelte';
	import { createOptimisticSeekBase, seekTargetForKey } from '$lib/seekKeys';
	import type {
		TransportControlRequest,
		SeekRequest,
		VolumeRequest,
		ZoneOutput
	} from '@shared/types';

	let { children } = $props();

	let socket = $state(getSocket());
	let commandInFlight = $state(false);
	let unifiedZoneMenuOpen = $state(false);
	let unifiedQueueOpen = $state(false);
	let unifiedZonePicker = $state<HTMLElement | null>(null);
	// An active workspace claim wins ahead of the path-based resolution; a
	// build with no claimant resolves every workspace-looking URL neutrally.
	const shellContract = $derived(
		$workspaceShellStore.contract ??
			resolveAppShellContract($page.url.pathname, $libraryViewHostStore.activeMode)
	);
	const unifiedTransport = $derived(shellContract.transportPresentation === 'unified');
	const unifiedPiTransport = $derived(
		unifiedTransport && $unifiedLibraryPrefsStore.density === 'pi'
	);
	const unifiedMonoFont = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

	$effect(() => {
		if (!unifiedTransport) {
			unifiedZoneMenuOpen = false;
			unifiedQueueOpen = false;
		}
	});

	$effect(() => {
		if (!unifiedZoneMenuOpen) return;
		const closeOnOutsidePointer = (event: PointerEvent) => {
			if (!unifiedZonePicker?.contains(event.target as Node)) unifiedZoneMenuOpen = false;
		};
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key === 'Escape') unifiedZoneMenuOpen = false;
		};
		window.addEventListener('pointerdown', closeOnOutsidePointer);
		window.addEventListener('keydown', closeOnEscape);
		return () => {
			window.removeEventListener('pointerdown', closeOnOutsidePointer);
			window.removeEventListener('keydown', closeOnEscape);
		};
	});

	onMount(() => {
		initializeTheme();
		socket = getSocket();
		const cleanupSocket = registerSocketHandlers();
		// One media session for the whole app: mirrors the selected zone into
		// the OS media controls (MPRIS / SMTC / Now Playing) and routes the
		// hardware media keys back through the same transport commands the
		// on-screen buttons send. No-op where the platform has no media session.
		const stopMediaSession = startMediaSessionBinding();
		// One Space listener for the whole app, down the same play/pause
		// command as the on-screen button. Guards live in the module.
		const stopSpacebar = startSpacebarPlayPause();
		// Now playing in the browser tab, restored to the default title
		// whenever nothing is playing.
		const stopDocumentTitle = startDocumentTitleBinding();
		void initializeStores(fetch);

		return () => {
			stopDocumentTitle();
			stopSpacebar();
			stopMediaSession();
			cleanupSocket();
			clearCommandFeedback();
		};
	});

	$effect(() => {
		const zones = $zonesStore;
		const selected = $selectedZoneStore;
		if (zones.length === 0) {
			// Don't clear the persisted choice — the zone may reappear after a
			// Roon Core reconnect. Just leave selected as-is so it rehydrates.
			return;
		}
		if (!selected || !zones.some((z) => z.zone_id === selected)) {
			setSelectedZone(zones[0].zone_id);
		}
	});

	const connectedGood = $derived($socketStatusStore === 'connected' && $isCorePaired);
	// Degraded persistence subsystems from /api/health (refreshed on
	// load + every reconnect). Named subsystems drive the warning
	// banner; server-side details live in the logs.
	const degradedSubsystems = $derived.by(() => {
		if ($healthStore?.ready !== false) return [] as string[];
		const subs = $healthStore.subsystems;
		const names: string[] = [];
		if (subs.recently_played?.degraded) names.push('Recently Played');
		if (subs.favorites?.degraded) names.push('Favorites');
		return names.length ? names : ['a server subsystem'];
	});
	const activeZone = $derived($selectedZoneStore ? $zoneMapStore.get($selectedZoneStore) : undefined);
	const nowPlaying = $derived(
		$selectedZoneStore ? $nowPlayingList.find((t) => t.zone_id === $selectedZoneStore) : undefined
	);

	function getLiveSocket() {
		const s = socket ?? getSocket();
		socket = s;
		if (!s) {
			pushCommandFeedback({ source: 'transport', command: 'socket', message: 'Realtime connection unavailable.' });
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
		if ($selectedZoneStore) void sendCommand('transport:play-pause', { zone_id: $selectedZoneStore });
	}
	function next() {
		if ($selectedZoneStore) void sendCommand('transport:next', { zone_id: $selectedZoneStore });
	}
	function previous() {
		if ($selectedZoneStore) void sendCommand('transport:previous', { zone_id: $selectedZoneStore });
	}

	/**
	 * Ungroup the active zone. Roon's ungroup_outputs takes the list
	 * of outputs to split off; passing all-but-the-first effectively
	 * dissolves the group while keeping the first output as its own
	 * zone. The button only renders when the active zone has >1
	 * output (a single-output "zone" is already ungrouped).
	 */
	async function ungroupCurrent() {
		const z = activeZone;
		if (!z || !z.outputs || z.outputs.length < 2 || commandInFlight) return;
		const s = getLiveSocket();
		if (!s) return;
		commandInFlight = true;
		try {
			await emitWithAck(
				s,
				'transport:ungroup',
				{ output_ids: z.outputs.slice(1).map((o) => o.output_id) },
				{
					timeoutMs: 5000,
					feedback: { source: 'transport', command: 'transport:ungroup' }
				}
			);
		} finally {
			commandInFlight = false;
		}
	}

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

	function formatTime(seconds: number): string {
		if (!seconds || seconds < 0) return '0:00';
		const whole = Math.floor(seconds);
		const m = Math.floor(whole / 60);
		const s = whole % 60;
		return `${m}:${String(s).padStart(2, '0')}`;
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
		if (!$selectedZoneStore) return;
		const s = getLiveSocket();
		if (s) {
			const token = optimisticSeek.record(seekContext, seconds);
			void emitWithAck(s, 'transport:seek', { zone_id: $selectedZoneStore, seconds } satisfies SeekRequest, {
				feedback: { source: 'transport', command: 'transport:seek' }
			}).then((res) => {
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

	// Volume control. We target the first output that has a volume control —
	// fixed-volume DACs (most of yours) report no volume settings, so the
	// slider just hides. Multi-output zones still get a working slider for
	// the first controllable endpoint.
	const volumeOutput = $derived<ZoneOutput | undefined>(
		activeZone?.outputs?.find((o) => o.volume !== undefined)
	);
	const volumeIsIncremental = $derived(volumeOutput?.volume?.type === 'incremental');

	function sendVolume(value: number) {
		const out = volumeOutput;
		if (!out?.volume) return;
		const s = getLiveSocket();
		if (!s) return;
		void emitWithAck(s, 'transport:volume', { output_id: out.output_id, value } satisfies VolumeRequest, {
			feedback: { source: 'transport', command: 'transport:volume' }
		});
	}

	// rAF-throttled volume slider. Native range inputs fire `input` on
	// every pixel of drag — without throttling we flood Roon with
	// commands AND get a stale-ack toast storm. We coalesce to one
	// emit per animation frame (max 60Hz) and always send the LATEST
	// pending value, including the final drag position when the user
	// releases. The +/- buttons stay as direct sendVolume() calls;
	// they're discrete clicks, not drag, so no need to throttle.
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

	function onVolumeStep(delta: number) {
		// For incremental outputs, send the step delta directly. The backend
		// detects the type and switches to Roon's `relative` mode.
		sendVolume(delta);
	}

	async function routeLibraryIntent(
		intent: LibraryIntent,
		command: string
	): Promise<void> {
		const alreadyOnLibrary = $page.url.pathname === '/library';
		const pending = publishLibraryIntent(intent, alreadyOnLibrary ? 'push' : 'replace');
		if (!pending) {
			pushCommandFeedback({
				source: 'browse',
				command,
				message: 'Could not open Library: invalid navigation request.'
			});
			return;
		}

		if (alreadyOnLibrary) return;

		try {
			// Publish first so the destination mode can claim this exact
			// request during its mount. A failed route cancels only this
			// request; a newer producer cannot be cleared accidentally.
			await goto('/library');
		} catch (err) {
			cancelLibraryIntent(pending.requestId);
			const detail = err instanceof Error ? err.message : String(err);
			pushCommandFeedback({
				source: 'browse',
				command,
				message: `Could not open Library: ${detail}`
			});
		}
	}

	async function routeUnifiedQueueLibraryIntent(intent: LibraryIntent): Promise<void> {
		unifiedQueueOpen = false;
		await tick();
		await routeLibraryIntent(intent, 'queue-library');
	}

	function openArtistPage(name: string): void {
		if (!name) return;
		void routeLibraryIntent(
			{
				kind: 'artist',
				destination: 'search',
				query: name,
				display: { title: name }
			},
			'play-bar'
		);
	}

	function openAlbumOfNowPlaying(): void {
		const album = nowPlaying?.album;
		const artist = nowPlaying?.artist;
		if (!album) return;
		void routeLibraryIntent(
			{
				kind: 'album',
				destination: 'search',
				query: album,
				display: { title: album, ...(artist ? { artist } : {}) }
			},
			'play-bar'
		);
	}

</script>

<div class="app-root" data-shell-presentation={shellContract.presentation}>
	<div class="main-area">
		<section class="workspace">
			{#if degradedSubsystems.length > 0}
				<div
					class="health-banner"
					role="status"
				>
					⚠ Server persistence degraded: {degradedSubsystems.join(', ')}.
					Changes may not survive a restart — check the server logs.
				</div>
			{/if}
			<main
				class="workspace-main"
				class:full-bleed={shellContract.fullBleedWorkspace}
				data-workspace-presentation={shellContract.fullBleedWorkspace ? 'full-bleed' : 'contained'}
			>
				{@render children()}
			</main>
		</section>
	</div>

	{#if shellContract.transportPresentation !== 'hidden'}
	<footer
		class="play-bar unified"
		class:pi-density={unifiedPiTransport}
		aria-label="Playback controls"
		data-transport-presentation={shellContract.transportPresentation}
	>
		<div class="unified-now-playing">
			{#if nowPlaying?.title}
				<button type="button" class="unified-title" onclick={openNowPlayingOverlay}>
					{nowPlaying.title}
				</button>
			{:else}
				<p class="unified-title">Nothing playing</p>
			{/if}
			{#if nowPlaying?.artist}
				<p class="unified-artists">
					{#each splitArtists(nowPlaying.artist) as artistName, i (i)}
						{#if i > 0}<span aria-hidden="true">/</span>{/if}
						<button type="button" onclick={() => openArtistPage(artistName)}>{artistName}</button>
					{/each}
				</p>
			{/if}
			<p class="unified-time mono" style:font-family={unifiedMonoFont}>
				{formatTime(seekPosition)} / {formatTime(duration)}
			</p>
		</div>
		<div
			class="unified-seek"
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
			<span style:width={`${progress * 100}%`}></span>
		</div>
		<div class="unified-transport-controls">
			<button type="button" onclick={previous} disabled={!canPrev || commandInFlight} aria-label="Previous">⏮</button>
			<button
				type="button"
				class="big"
				onclick={playPause}
				disabled={!canPlay || commandInFlight}
				aria-label={isPlaying ? 'Pause' : 'Play'}
			>
				{isPlaying ? '⏸' : '▶'}
			</button>
			<button type="button" onclick={next} disabled={!canNext || commandInFlight} aria-label="Next">⏭</button>
		</div>
		{#if volumeOutput?.volume && volumeIsIncremental}
			<div
				class="unified-volume incremental mono"
				title="Volume ({volumeOutput.display_name})"
				style:font-family={unifiedMonoFont}
			>
				<span>VOL</span>
				<button type="button" onclick={() => onVolumeStep(-1)} aria-label="Volume down">−</button>
				<button type="button" onclick={() => onVolumeStep(1)} aria-label="Volume up">+</button>
			</div>
		{:else if volumeOutput?.volume}
			<label
				class="unified-volume mono"
				title="Volume ({volumeOutput.display_name})"
				style:font-family={unifiedMonoFont}
			>
				<span>VOL</span>
				<input
					type="range"
					min={volumeOutput.volume.min}
					max={volumeOutput.volume.max}
					step={volumeOutput.volume.step ?? 1}
					value={volumeOutput.volume.value}
					oninput={onVolumeSlide}
					aria-label="Volume"
					style:background={`linear-gradient(to right, var(--songr-accent) ${
						((volumeOutput.volume.value - volumeOutput.volume.min) /
							Math.max(1, volumeOutput.volume.max - volumeOutput.volume.min)) *
						100
					}%, var(--songr-hover) 0)`}
				/>
				<span>{Math.round(volumeOutput.volume.value)}</span>
			</label>
		{:else}
			<div
				class="unified-volume unavailable mono"
				aria-label="Volume unavailable"
				style:font-family={unifiedMonoFont}
			>
				<span>VOL</span><span class="unified-volume-bar"></span><span>—</span>
			</div>
		{/if}
		<div class="unified-zone">
			<button
				type="button"
				class="unified-zone-action"
				onclick={openZoneGrouping}
				disabled={$zonesStore.length === 0}
				aria-label="Group zones"
			>GROUP</button>
			{#if activeZone?.outputs && activeZone.outputs.length > 1}
				<button
					type="button"
					class="unified-zone-action"
					onclick={ungroupCurrent}
					disabled={commandInFlight}
					aria-label="Ungroup current zone"
				>UNGROUP</button>
			{/if}
			<div class="unified-zone-picker" bind:this={unifiedZonePicker}>
				<button
					type="button"
					class="unified-zone-trigger"
					disabled={$zonesStore.length === 0}
					aria-haspopup="menu"
					aria-expanded={unifiedZoneMenuOpen}
					aria-controls="unified-zone-menu"
					aria-label={`Select zone, current zone ${activeZone?.display_name ?? 'No zone'}`}
					onclick={() => {
						unifiedZoneMenuOpen = !unifiedZoneMenuOpen;
					}}
				>
					<span class:connected={connectedGood} class="unified-zone-dot"></span>
					<span>{activeZone?.display_name ?? 'No zone'}</span>
					<span class="unified-zone-chevron" aria-hidden="true">▾</span>
				</button>
				{#if unifiedZoneMenuOpen}
					<div id="unified-zone-menu" class="unified-zone-menu" role="menu" aria-label="Roon zones">
						{#each $zonesStore as zone (zone.zone_id)}
							<button
								type="button"
								role="menuitemradio"
								aria-checked={zone.zone_id === $selectedZoneStore}
								class:selected={zone.zone_id === $selectedZoneStore}
								onclick={() => {
									setSelectedZone(zone.zone_id);
									unifiedZoneMenuOpen = false;
								}}
							>
								<span>{zone.display_name}</span>
								{#if zone.zone_id === $selectedZoneStore}<span aria-hidden="true">✓</span>{/if}
							</button>
						{/each}
					</div>
				{/if}
			</div>
			<button
				type="button"
				class="unified-queue"
				aria-haspopup="dialog"
				aria-controls="unified-queue-dialog"
				aria-expanded={unifiedQueueOpen}
				onclick={() => {
					unifiedZoneMenuOpen = false;
					unifiedQueueOpen = !unifiedQueueOpen;
				}}
			>
				Queue
			</button>
		</div>
	</footer>
	{/if}
</div>

{#if unifiedTransport && unifiedQueueOpen}
	<UnifiedQueuePanel
		onclose={() => (unifiedQueueOpen = false)}
		onlibraryintent={routeUnifiedQueueLibraryIntent}
	/>
{/if}

<!-- The Unified bar owns the only settings trigger. -->
<AppSettingsMenu />

<NowPlayingOverlay onOpenAlbum={openAlbumOfNowPlaying} />
<ZoneGroupingModal />
<ErrorToast />
<!-- Renders nothing unless the server says no Roon Core has ever been
     paired on this install. Gated on that, never on being inside the
     desktop shell, so a plain-browser first run gets the same guidance and
     an established appliance never sees it. -->
<OnboardingFlow />

<style>
	/* App-level: lock the viewport so only the Unified workspace scrolls. */
	:global(html),
	:global(body) {
		height: 100%;
		margin: 0;
		overflow: hidden;
	}

	.app-root {
		display: grid;
		grid-template-rows: 1fr auto;
		height: 100vh;
	}

	.main-area {
		display: grid;
		grid-template-columns: 1fr;
		min-height: 0;
		overflow: hidden;
	}

	.workspace {
		display: flex;
		flex-direction: column;
		position: relative;
		min-height: 0;
		min-width: 0;
		overflow: hidden;
	}

	.health-banner {
		flex: none;
		margin: 0.6rem 0.9rem 0;
		padding: 0.5rem 0.9rem;
		border-radius: 8px;
		border: 1px solid color-mix(in srgb, #e0a020 45%, transparent);
		background: color-mix(in srgb, #e0a020 14%, transparent);
		font-size: 0.85rem;
		line-height: 1.35;
	}

	.workspace-main {
		flex: 1;
		min-height: 0;
		overflow-y: auto; /* the only scrolling surface */
		overflow-x: hidden; /* never let inner content cause page-wide horizontal scroll */
		padding: 0.9rem;
		animation: rise-in 320ms ease;
	}

	.workspace-main > :global(*) {
		max-width: none;
		margin: 0;
		width: 100%;
		height: 100%;
	}

	.workspace-main.full-bleed {
		animation: none;
		padding: 0;
	}

	.play-bar {
		display: flex;
		flex-shrink: 0;
		align-items: center;
		gap: 18px;
		margin: 0;
		padding: 10px 22px;
		overflow: visible;
		position: relative;
		border: 0;
		border-top: 1px solid var(--songr-line);
		border-radius: 0;
		background: var(--songr-app-bg);
		color: var(--songr-text);
		font: 15px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
		-webkit-font-smoothing: antialiased;
		box-shadow: none;
	}

	.play-bar.unified.pi-density {
		padding: 14px 22px;
	}

	.unified-now-playing {
		width: 220px;
		min-width: 220px;
	}

	.unified-title {
		display: block;
		max-width: 220px;
		overflow: hidden;
		border: 0;
		background: transparent;
		color: inherit;
		font: inherit;
		font-size: 13.5px;
		font-weight: 600;
		line-height: 1.45;
		text-align: left;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.unified-title:hover,
	.unified-title:focus-visible,
	.unified-artists button:hover,
	.unified-artists button:focus-visible {
		color: var(--songr-accent-bright);
		outline: 0;
	}

	.unified-artists {
		display: flex;
		gap: 5px;
		max-width: 220px;
		overflow: hidden;
		color: var(--songr-soft);
		font-size: 11px;
		white-space: nowrap;
	}

	.unified-artists button {
		overflow: hidden;
		border: 0;
		background: transparent;
		color: inherit;
		font: inherit;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.unified-time {
		color: var(--songr-dim);
		font-size: 11px;
	}

	.unified-seek {
		position: absolute;
		inset: auto 0 0;
		height: 3px;
		background: var(--songr-hover);
	}

	.unified-seek.seekable {
		cursor: pointer;
	}

	.unified-seek.seekable:hover,
	.unified-seek:focus-visible {
		height: 5px;
		outline: 0;
	}

	.unified-seek span {
		display: block;
		height: 100%;
		background: var(--songr-accent);
	}

	.unified-transport-controls {
		display: flex;
		align-items: center;
		gap: 14px;
		margin: 0 auto;
		color: var(--songr-text-mid);
		font-size: 15px;
	}

	.unified-transport-controls button {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 6px 8px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: inherit;
		font: inherit;
		cursor: pointer;
	}

	.unified-transport-controls button:hover:not(:disabled) {
		background: var(--songr-surface-16);
	}

	.unified-transport-controls button:disabled {
		opacity: 0.45;
		cursor: default;
	}

	.unified-transport-controls button.big {
		width: 38px;
		height: 38px;
		padding: 0;
		border: 1px solid var(--songr-line-20);
		border-radius: 50%;
	}

	.play-bar.unified.pi-density .unified-transport-controls {
		gap: 18px;
		font-size: 18px;
	}

	.play-bar.unified.pi-density .unified-transport-controls button.big {
		width: 48px;
		height: 48px;
	}

	.unified-volume {
		display: flex;
		align-items: center;
		gap: 8px;
		color: var(--songr-dim);
		font-size: 9.5px;
		letter-spacing: 0.14em;
	}

	.unified-volume input,
	.unified-volume-bar {
		width: 90px;
		height: 3px;
		border: 0;
		border-radius: 2px;
		appearance: none;
	}

	.unified-volume input {
		cursor: pointer;
	}

	.unified-volume input::-webkit-slider-thumb {
		width: 1px;
		height: 3px;
		appearance: none;
		background: transparent;
	}

	.unified-volume-bar {
		display: block;
		background: var(--songr-hover);
	}

	.unified-volume.unavailable {
		opacity: 0.55;
	}

	.unified-volume.incremental button,
	.unified-zone-action {
		padding: 5px 7px;
		border: 1px solid var(--songr-line-12);
		border-radius: 6px;
		background: var(--songr-inset);
		color: var(--songr-soft);
		font: inherit;
	}

	.unified-volume.incremental button:hover,
	.unified-volume.incremental button:focus-visible,
	.unified-zone-action:hover:not(:disabled),
	.unified-zone-action:focus-visible {
		border-color: var(--songr-accent);
		color: var(--songr-accent-bright);
		outline: 0;
	}

	.unified-zone-action {
		font-size: 9px;
		letter-spacing: 0.1em;
	}

	.unified-zone-action:disabled {
		opacity: 0.45;
	}

	.unified-zone {
		display: flex;
		align-items: center;
		gap: 10px;
		color: var(--songr-soft);
		font-size: 12px;
		white-space: nowrap;
	}

	.unified-zone-picker {
		position: relative;
	}

	.unified-zone-trigger {
		display: flex;
		align-items: center;
		gap: 5px;
		padding: 6px 8px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: inherit;
		font: inherit;
		white-space: nowrap;
		cursor: pointer;
	}

	.unified-zone-trigger:hover,
	.unified-zone-trigger[aria-expanded='true'] {
		background: var(--songr-surface-16);
		color: var(--songr-control-text);
	}

	.unified-zone-trigger:focus-visible {
		outline: 1px solid var(--songr-accent);
		outline-offset: 1px;
	}

	.unified-zone-trigger:disabled {
		cursor: default;
		opacity: 0.55;
	}

	.unified-zone-chevron {
		color: var(--songr-dim);
		font-size: 10px;
	}

	.unified-zone-menu {
		position: absolute;
		right: 0;
		bottom: calc(100% + 16px);
		z-index: 40;
		display: grid;
		min-width: 180px;
		max-width: min(280px, 70vw);
		padding: 6px;
		border: 1px solid var(--songr-line-15);
		border-radius: 9px;
		background: var(--songr-panel);
		box-shadow: 0 16px 42px var(--songr-shadow);
	}

	.unified-zone-menu button {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		width: 100%;
		padding: 9px 12px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--songr-control-text);
		font: inherit;
		text-align: left;
		white-space: nowrap;
		cursor: pointer;
	}

	.unified-zone-menu button:hover,
	.unified-zone-menu button:focus-visible {
		outline: 0;
		background: var(--songr-hover-subtle);
		color: var(--songr-text);
	}

	.unified-zone-menu button.selected {
		color: var(--songr-accent);
	}

	.unified-zone-dot {
		display: inline-block;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--songr-dim);
	}

	.unified-zone-dot.connected {
		background: var(--songr-success);
		box-shadow: 0 0 8px var(--songr-success);
	}

	.unified-queue {
		padding: 7px 14px;
		border: 1px solid var(--songr-line);
		border-radius: 7px;
		background: var(--songr-control);
		color: var(--songr-control-text);
		font: inherit;
		font-size: 12px;
		cursor: pointer;
	}

	.unified-queue:hover,
	.unified-queue:focus-visible {
		background: var(--songr-hover);
		outline: 1px solid var(--songr-accent);
		outline-offset: 2px;
	}

	@media (max-width: 900px) {
		.play-bar {
			gap: 10px;
			padding-inline: 12px;
		}

		.unified-now-playing {
			min-width: 140px;
			width: 140px;
		}

		.unified-title,
		.unified-artists {
			max-width: 140px;
		}

		.unified-transport-controls {
			gap: 6px;
		}

		.unified-zone {
			gap: 5px;
		}
	}

</style>
