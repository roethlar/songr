<script lang="ts">
	import '../app.css';
	import { page } from '$app/stores';
	import { onMount, untrack } from 'svelte';
	import { resolveAppShellContract } from '$lib/appShellContract';
	import { requestLibraryViewFromSettings } from '$lib/libraryViewSettings';
	import { coreStore, isCorePaired } from '$lib/stores/coreStore';
	import { healthStore } from '$lib/stores/healthStore';
	import {
		libraryViewHostStore,
		requestLibraryView
	} from '$lib/stores/libraryViewHostStore';
	import {
		getAvailableLibraryViews,
		libraryViewStore,
		resolveAvailableLibraryView,
		type LibraryView
	} from '$lib/stores/libraryViewStore';
	import { unifiedLibraryPrefsStore } from '$lib/stores/unifiedLibraryPrefsStore';
	import {
		classicBrowseSessionClient,
		type ClassicBrowseSessionClaim
	} from '$lib/stores/classicBrowseSessionStore';
	import {
		initializeStores,
		clearCommandFeedback,
		nowPlayingList,
		selectedZoneStore,
		setSelectedZone,
		themeStore,
		setTheme,
		initializeTheme,
		pushCommandFeedback,
		browseNavStore,
		socketStatusStore,
		exploreRailStore,
		resolveExploreRail,
		invalidateExploreRail,
		type ExploreRailEntry
	} from '$lib/stores';
	import { goto } from '$app/navigation';
	import { zonesStore, zoneMapStore } from '$lib/stores/zonesStore';
	import { interpolatedSeekStore } from '$lib/stores/interpolatedSeekStore';
	import { registerSocketHandlers } from '$lib/socket/register';
	import { startMediaSessionBinding } from '$lib/media/mediaSessionBinding';
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
	import Search from '$lib/components/Search.svelte';
	import NowPlayingOverlay from '$lib/components/NowPlayingOverlay.svelte';
	import { openNowPlayingOverlay } from '$lib/stores/nowPlayingOverlayStore';
	import ZoneGroupingModal from '$lib/components/ZoneGroupingModal.svelte';
	import { openZoneGrouping } from '$lib/stores/zoneGroupingStore';
	import { imageUrl } from '$lib/imageUrl';
	import { hideOnError } from '$lib/actions/imageFallback';
	import { createOptimisticSeekBase, seekTargetForKey } from '$lib/seekKeys';
	import { version } from '$app/environment';
	import type {
		TransportControlRequest,
		SeekRequest,
		VolumeRequest,
		ZoneOutput
	} from '@shared/types';

	let { children } = $props();

	let socket = $state(getSocket());
	let commandInFlight = $state(false);
	let mobileNavOpen = $state(false);
	let unifiedZoneMenuOpen = $state(false);
	let unifiedZonePicker = $state<HTMLElement | null>(null);
	let classicAcquireContext = '';
	let classicAcquireAttempted = false;
	let classicBrowseEffectsInvalidated = false;
	let classicLayoutClaim: ClassicBrowseSessionClaim | null = null;
	const shellContract = $derived(
		resolveAppShellContract($page.url.pathname, $libraryViewHostStore.activeMode)
	);
	const compactTransport = $derived(shellContract.transportPresentation === 'compact');
	const unifiedTransport = $derived(shellContract.transportPresentation === 'unified');
	const unifiedPiTransport = $derived(
		unifiedTransport && $unifiedLibraryPrefsStore.density === 'pi'
	);
	const unifiedMonoFont = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
	const availableLibraryViews = getAvailableLibraryViews();
	const settingsCurrentLibraryView = $derived.by(() => {
		const availablePreference = resolveAvailableLibraryView($libraryViewStore);
		if ($page.url.pathname !== '/library') return availablePreference;
		return $libraryViewHostStore.activeMode ?? $libraryViewHostStore.pendingMode;
	});

	$effect(() => {
		if (!shellContract.showClassicChrome) mobileNavOpen = false;
		if (!unifiedTransport) unifiedZoneMenuOpen = false;
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
		socket = getSocket();
		initializeTheme();
		const cleanupSocket = registerSocketHandlers();
		// One media session for the whole app: mirrors the selected zone into
		// the OS media controls (MPRIS / SMTC / Now Playing) and routes the
		// hardware media keys back through the same transport commands the
		// on-screen buttons send. No-op where the platform has no media session.
		const stopMediaSession = startMediaSessionBinding();
		void initializeStores(fetch);

		return () => {
			stopMediaSession();
			cleanupSocket();
			const layoutClaim = classicLayoutClaim;
			classicLayoutClaim = null;
			if (layoutClaim) classicBrowseSessionClient.release(layoutClaim);
			clearCommandFeedback();
		};
	});

	// Resolve the Explore rail only while its Classic/normal chrome is mounted,
	// then again whenever Roon Core (re)pairs. Timeline and the neutral Library
	// boundary invalidate cached keys without issuing an invisible Browse call.
	// Cached itemKeys go stale on Core restart, so a reconnect must
	// trigger a fresh resolve. `invalidateExploreRail` runs on un-pair to
	// clear visibly-stale entries during the reconnect window.
	$effect(() => {
		const status = $coreStore.status;
		const socketStatus = $socketStatusStore;
		const allowClassicBrowseEffects = shellContract.allowClassicBrowseEffects;
		// Normal routes own an epoch-bound claim. /library Classic owns a distinct
		// component claim, so either side of a route handoff may run first without
		// letting stale cleanup retire the new owner's generation.
		const layoutOwnsClassicSession = shellContract.presentation === 'normal';
		const classicSessionPhase = $classicBrowseSessionClient.phase;
		const classicSessionOwner = $classicBrowseSessionClient.owner;
		const classicSessionOwnerEpoch = $classicBrowseSessionClient.ownerEpoch;
		const acquireContext = `${allowClassicBrowseEffects}:${layoutOwnsClassicSession}:${status}:${socketStatus}`;
		if (acquireContext !== classicAcquireContext) {
			classicAcquireContext = acquireContext;
			classicAcquireAttempted = false;
		}
		// Read inside untrack so we don't loop on entries changes.
		untrack(() => {
			const invalidateClassicBrowseEffects = () => {
				if (classicBrowseEffectsInvalidated) return;
				classicBrowseEffectsInvalidated = true;
				invalidateExploreRail();
			};
			const releaseLayoutClaim = () => {
				const layoutClaim = classicLayoutClaim;
				classicLayoutClaim = null;
				if (layoutClaim) classicBrowseSessionClient.release(layoutClaim);
			};
			if (!layoutOwnsClassicSession) {
				releaseLayoutClaim();
				if (
					allowClassicBrowseEffects &&
					status === 'paired' &&
					socketStatus === 'connected' &&
					classicSessionPhase === 'live'
				) {
					classicAcquireAttempted = false;
					classicBrowseEffectsInvalidated = false;
				} else {
					invalidateClassicBrowseEffects();
				}
			} else if (!allowClassicBrowseEffects) {
				releaseLayoutClaim();
				invalidateClassicBrowseEffects();
			} else if (status === 'paired' && socketStatus === 'connected') {
				if (!classicLayoutClaim) {
					const layoutClaim = classicBrowseSessionClient.claim('normal-shell');
					classicLayoutClaim = layoutClaim;
					classicAcquireAttempted = true;
					void layoutClaim.ready.catch(() => {
						if (
							classicLayoutClaim !== layoutClaim ||
							!classicBrowseSessionClient.isClaimCurrent(layoutClaim)
						) return;
						// A context change (Core/socket/mode) is the retry boundary.
						invalidateClassicBrowseEffects();
					});
				} else if (
					classicSessionOwner === 'normal-shell' &&
					classicSessionOwnerEpoch === classicLayoutClaim.claimId &&
					classicSessionPhase === 'none' &&
					!classicAcquireAttempted
				) {
					classicAcquireAttempted = true;
					const layoutClaim = classicLayoutClaim;
					void classicBrowseSessionClient.recover(layoutClaim).catch(() => {
						if (
							classicLayoutClaim !== layoutClaim ||
							!classicBrowseSessionClient.isClaimCurrent(layoutClaim)
						) return;
						invalidateClassicBrowseEffects();
					});
				} else if (
					classicSessionPhase === 'live' &&
					classicSessionOwner === 'normal-shell' &&
					classicSessionOwnerEpoch === classicLayoutClaim.claimId
				) {
					classicAcquireAttempted = false;
					classicBrowseEffectsInvalidated = false;
					void resolveExploreRail(fetch, classicLayoutClaim);
				}
			} else if (socketStatus === 'connecting' || socketStatus === 'disconnected') {
				if (classicLayoutClaim) {
					classicBrowseSessionClient.connectionLost(classicLayoutClaim);
				}
				invalidateClassicBrowseEffects();
			} else if (status === 'discovering' || status === 'unpaired') {
				releaseLayoutClaim();
				invalidateClassicBrowseEffects();
			}
		});
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

	const connectedLabel = $derived(
		$socketStatusStore === 'connecting'
			? 'Connecting…'
			: $socketStatusStore === 'disconnected'
				? 'Disconnected'
				: $isCorePaired
					? 'Connected'
					: 'Searching for Core…'
	);
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

	// Group rail entries by their parent label for sectioned rendering.
	// Top-level entries have labelPath length 1; nested entries (today
	// only Library children) have length 2 with the parent at index 0.
	const railSections = $derived.by(() => {
		const sections = new Map<string | null, ExploreRailEntry[]>();
		for (const entry of $exploreRailStore.entries) {
			const parent = entry.labelPath.length > 1 ? entry.labelPath[0] : null;
			const list = sections.get(parent) ?? [];
			list.push(entry);
			sections.set(parent, list);
		}
		return sections;
	});

	const railTopLevel = $derived(railSections.get(null) ?? []);
	const railLibrary = $derived(railSections.get('Library') ?? []);

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
		command: string,
		closeMobileRail = false
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

		if (closeMobileRail) mobileNavOpen = false;
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

	function searchInLibrary(query: string): void {
		void routeLibraryIntent(
			{
				kind: 'general',
				destination: 'search',
				query,
				display: { title: query }
			},
			'library-search'
		);
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

	function openFavoritesRail(): void {
		void routeLibraryIntent(
			{
				kind: 'general',
				destination: 'welcome-section',
				section: 'favorites'
			},
			'rail',
			true
		);
	}

	function navigateToRailEntry(entry: ExploreRailEntry): void {
		void routeLibraryIntent(
			{
				kind: 'general',
				destination: 'explore-path',
				// ExploreRailEntry also contains session-scoped cached keys.
				// Copy only its semantic label path across the mode boundary.
				labelPath: [...entry.labelPath]
			},
			'rail',
			true
		);
	}

	function toggleMobileNav() {
		mobileNavOpen = !mobileNavOpen;
	}

	async function requestSettingsLibraryView(view: LibraryView): Promise<void> {
		try {
			const result = await requestLibraryViewFromSettings(view, {
				pathname: $page.url.pathname,
				currentView: settingsCurrentLibraryView,
				availableViews: availableLibraryViews,
				requestActiveView: requestLibraryView,
				navigate: (url, options) => goto(url, options)
			});
			if (result === 'unavailable') {
				pushCommandFeedback({
					source: 'browse',
					command: 'controller-settings',
					message: 'That Library view is not available in this build.'
				});
			} else if (result === 'host-unavailable') {
				pushCommandFeedback({
					source: 'browse',
					command: 'controller-settings',
					message: 'Library is not ready to change views.'
				});
			} else if (result === 'activation-failed') {
				pushCommandFeedback({
					source: 'browse',
					command: 'controller-settings',
					message: 'Could not change Library view. Close Controller settings to retry.'
				});
			}
		} catch (reason) {
			const detail = reason instanceof Error ? reason.message : String(reason);
			pushCommandFeedback({
				source: 'browse',
				command: 'controller-settings',
				message: `Could not open Library: ${detail}`
			});
		}
	}
</script>

{#snippet transportArtwork()}
	<button
		type="button"
		class="pb-art pb-art-button"
		onclick={openNowPlayingOverlay}
		disabled={!nowPlaying?.title}
		aria-label="Open now playing"
	>
		{#if nowPlaying?.image_key}
			<img
				src={imageUrl(nowPlaying.image_key, { width: 80, height: 80 })}
				alt="Artwork"
				decoding="async"
				use:hideOnError
			/>
		{/if}
	</button>
{/snippet}

{#snippet transportControls()}
	<div class="pb-controls">
		<button type="button" class="ctrl-btn" onclick={previous} disabled={!canPrev || commandInFlight} aria-label="Previous">⏮</button>
		<button type="button" class="ctrl-btn primary" onclick={playPause} disabled={!canPlay || commandInFlight} aria-label={isPlaying ? 'Pause' : 'Play'}>
			{isPlaying ? '⏸' : '▶'}
		</button>
		<button type="button" class="ctrl-btn" onclick={next} disabled={!canNext || commandInFlight} aria-label="Next">⏭</button>
	</div>
{/snippet}

<div
	class="app-root"
	class:mobile-nav-open={mobileNavOpen}
	data-shell-presentation={shellContract.presentation}
>
	<div
		class="main-area"
		class:without-classic-chrome={!shellContract.showClassicChrome}
		style:grid-template-columns={!shellContract.showClassicChrome ? '1fr' : undefined}
	>
		{#if shellContract.showClassicChrome}
		<aside class="sidebar" class:open={mobileNavOpen}>
			<div class="brand-block">
				<p class="eyebrow">Roon Controller</p>
			</div>

			<nav class="explore" aria-label="Explore">
				{#if $exploreRailStore.loading && $exploreRailStore.entries.length === 0}
					<div class="rail-skeleton">
						<span class="skel-row"></span>
						<span class="skel-row"></span>
						<span class="skel-row"></span>
						<span class="skel-row"></span>
					</div>
				{:else if $exploreRailStore.error}
					<p class="rail-error">{$exploreRailStore.error}</p>
				{:else}
					{#if railLibrary.length > 0}
						<div class="rail-section">
							<h3 class="rail-section-header">Library</h3>
							{#each railLibrary as entry}
								<button
									type="button"
									class="rail-link"
									class:muted={entry.isEmpty}
									onclick={() => navigateToRailEntry(entry)}
								>{entry.label}</button>
							{/each}
						</div>
					{/if}

					<div class="rail-section">
						<!-- Favorites is a controller feature, pinned above the
						     Roon top-level entries (Playlists, Genres, …). -->
						<button
							type="button"
							class="rail-link top"
							onclick={() => void openFavoritesRail()}
						>Favorites</button>
						{#each railTopLevel as entry}
							<button
								type="button"
								class="rail-link top"
								class:muted={entry.isEmpty}
								onclick={() => navigateToRailEntry(entry)}
							>{entry.label}</button>
						{/each}
					</div>
				{/if}
			</nav>

			<div class="sidebar-footer">
				<div class="status card">
					<p class="status-value" class:good={connectedGood}>{connectedLabel}</p>
					<p class="status-core">{$coreStore.core?.displayName ?? '—'}</p>
					<p class="status-version">{$coreStore.core?.displayVersion ?? ''}</p>
					<p class="status-rev" title="UI build revision">rev {version}</p>
					<p class="status-about" data-testid="app-about">
						Sǫngr — web-based controller for Roon
					</p>
					<p class="status-disclaimer">Not affiliated with or endorsed by Roon Labs LLC.</p>
				</div>
			</div>
		</aside>
		{/if}

		{#if shellContract.showClassicChrome && mobileNavOpen}
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div class="sidebar-scrim" onclick={toggleMobileNav}></div>
		{/if}

		<section class="workspace">
			{#if shellContract.showClassicChrome}
			<header class="workspace-header">
			<button
				type="button"
				class="hamburger"
				aria-label="Toggle navigation"
				onclick={toggleMobileNav}
			>☰</button>

			{#if $page.url.pathname === '/library'}
				<div class="nav-btns">
					<button
						type="button"
						class="nav-btn"
						onclick={$browseNavStore.back}
						disabled={!$browseNavStore.canBack}
						aria-label="Back"
						title="Back"
					>←</button>
					<button
						type="button"
						class="nav-btn"
						onclick={$browseNavStore.home}
						aria-label="Home"
						title="Browse home"
					>⌂</button>
					<button
						type="button"
						class="nav-btn"
						onclick={$browseNavStore.forward}
						disabled={!$browseNavStore.canForward}
						aria-label="Forward"
						title="Forward"
					>→</button>
				</div>
			{:else}
				<span class="nav-spacer"></span>
			{/if}

			<div class="header-search">
				<Search mode="input" onSubmit={searchInLibrary} />
			</div>

		</header>
			{/if}

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
				style:padding={shellContract.fullBleedWorkspace ? '0' : undefined}
				style:overflow={shellContract.fullBleedWorkspace ? 'hidden' : undefined}
				style:--workspace-content-max-width={shellContract.fullBleedWorkspace ? 'none' : '1440px'}
				style:--workspace-content-margin={shellContract.fullBleedWorkspace ? '0' : '0 auto'}
				style:--workspace-content-width={shellContract.fullBleedWorkspace ? '100%' : 'auto'}
				style:--workspace-content-height={shellContract.fullBleedWorkspace ? '100%' : 'auto'}
			>
				{@render children()}
			</main>
		</section>
	</div>

	{#if shellContract.transportPresentation !== 'hidden'}
	<footer
		class="play-bar card"
		class:compact={compactTransport}
		class:unified={unifiedTransport}
		class:pi-density={unifiedPiTransport}
		aria-label="Playback controls"
		data-transport-presentation={shellContract.transportPresentation}
		style:position={compactTransport ? 'fixed' : undefined}
		style:left={compactTransport ? '50%' : undefined}
		style:bottom={compactTransport ? '0.75rem' : undefined}
		style:transform={compactTransport ? 'translateX(-50%)' : undefined}
		style:grid-template-columns={compactTransport ? 'auto minmax(180px, 1fr) auto' : undefined}
		style:grid-template-rows={compactTransport ? 'auto' : undefined}
		style:width={compactTransport ? 'calc(100vw - 1.5rem)' : undefined}
		style:max-width={compactTransport ? '520px' : undefined}
		style:margin={compactTransport ? '0' : undefined}
		style:padding={compactTransport ? '0.45rem 0.55rem' : undefined}
	>
	{#if unifiedTransport}
		<div class="unified-now-playing">
			{#if nowPlaying?.title}
				<button type="button" class="unified-title pb-link" onclick={openNowPlayingOverlay}>
					{nowPlaying.title}
				</button>
			{:else}
				<p class="unified-title">Nothing playing</p>
			{/if}
			<p class="unified-time mono" style:font-family={unifiedMonoFont}>
				{formatTime(seekPosition)} / {formatTime(duration)}
			</p>
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
		{#if volumeOutput?.volume && !volumeIsIncremental}
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
					style:background={`linear-gradient(to right, #c8a24a ${
						((volumeOutput.volume.value - volumeOutput.volume.min) /
							Math.max(1, volumeOutput.volume.max - volumeOutput.volume.min)) *
						100
					}%, #1c1c1c 0)`}
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
			<a href="/queue" class="unified-queue" data-sveltekit-preload-data="hover">Queue</a>
		</div>
	{:else if compactTransport}
		<div class="compact-now-playing">
			{@render transportArtwork()}
		</div>
		<div class="compact-transport-meta">
			{#if nowPlaying?.title}
				<button type="button" class="compact-title pb-link" onclick={openNowPlayingOverlay}>{nowPlaying.title}</button>
			{:else}
				<p class="compact-title">Nothing playing</p>
			{/if}
			<p class="compact-subtitle">{nowPlaying?.artist ?? ''}</p>
			<div
				class="compact-progress"
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
				<div class="pb-progress-fill" style="width: {progress * 100}%"></div>
			</div>
		</div>
		{@render transportControls()}
	{:else}
	<div
		class="pb-progress-bar"
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
		<div class="pb-progress-fill" style="width: {progress * 100}%"></div>
	</div>
	<div class="pb-track">
		{@render transportArtwork()}
		<div class="pb-meta">
			{#if nowPlaying?.title}
				<button type="button" class="pb-title pb-link" onclick={openNowPlayingOverlay}>{nowPlaying.title}</button>
			{:else}
				<p class="pb-title">Nothing playing</p>
			{/if}
			{#if nowPlaying?.artist}
				<!-- Multi-artist credits arrive as one " / "-joined string;
				     each name resolves to its own artist page. -->
				<p class="pb-sub pb-artists">
					{#each splitArtists(nowPlaying.artist) as artistName, i (i)}
						{#if i > 0}<span class="pb-artist-sep" aria-hidden="true">/</span>{/if}
						<button
							type="button"
							class="pb-link pb-artist-link"
							onclick={() => openArtistPage(artistName)}
						>{artistName}</button>
					{/each}
				</p>
			{:else}
				<p class="pb-sub"></p>
			{/if}
			<span class="pb-time">{formatTime(seekPosition)} / {formatTime(duration)}</span>
		</div>
	</div>

	{@render transportControls()}

	<div class="pb-right">
		{#if volumeOutput?.volume}
			{#if volumeIsIncremental}
				<div class="vol-incremental" title="Volume ({volumeOutput.display_name})">
					<button type="button" class="vol-step" onclick={() => onVolumeStep(-1)} aria-label="Volume down">−</button>
					<span class="vol-icon">🔊</span>
					<button type="button" class="vol-step" onclick={() => onVolumeStep(1)} aria-label="Volume up">+</button>
				</div>
			{:else}
				<label class="vol-slider" title="Volume ({volumeOutput.display_name})">
					<span class="vol-icon" aria-hidden="true">🔊</span>
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
		<label class="visually-hidden" for="footer-zone">Zone</label>
		<select
			id="footer-zone"
			class="zone-select"
			value={$selectedZoneStore}
			onchange={(e) => setSelectedZone((e.target as HTMLSelectElement).value)}
		>
			{#if $zonesStore.length === 0}
				<option value="">No zones</option>
			{:else}
				{#each $zonesStore as zone}
					<option value={zone.zone_id}>{zone.display_name}</option>
				{/each}
			{/if}
		</select>
		<button
			type="button"
			class="zone-action-btn"
			onclick={openZoneGrouping}
			disabled={$zonesStore.length === 0}
			aria-label="Group zones"
			title="Group zones"
		>⛓</button>
		{#if activeZone?.outputs && activeZone.outputs.length > 1}
			<button
				type="button"
				class="zone-action-btn"
				onclick={ungroupCurrent}
				disabled={commandInFlight}
				aria-label="Ungroup current zone"
				title="Ungroup current zone"
			>⊟</button>
		{/if}
		<a href="/queue" class="queue-btn" data-sveltekit-preload-data="hover">Queue</a>
	</div>
	{/if}
	</footer>
	{/if}
</div>

<AppSettingsMenu
	showTrigger={shellContract.presentation !== 'unified'}
	availableViews={availableLibraryViews}
	currentView={settingsCurrentLibraryView}
	onLibraryViewChange={(view) => void requestSettingsLibraryView(view)}
	theme={$themeStore}
	onThemeChange={setTheme}
	connectionLabel={connectedLabel}
	connectionGood={connectedGood}
	coreName={$coreStore.core?.displayName ?? null}
	coreVersion={$coreStore.core?.displayVersion ?? null}
	buildRevision={`rev ${version}`}
/>

<NowPlayingOverlay onOpenAlbum={openAlbumOfNowPlaying} />
<ZoneGroupingModal />
<ErrorToast />
<!-- Renders nothing unless the server says no Roon Core has ever been
     paired on this install. Gated on that, never on being inside the
     desktop shell, so a plain-browser first run gets the same guidance and
     an established appliance never sees it. -->
<OnboardingFlow />

<style>
	/* App-level: lock the viewport so only the workspace-main scrolls.
	   The sidebar, sticky header, and play bar stay fixed; the right
	   pane is the only scrollable surface. */
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
		grid-template-columns: 200px 1fr;
		min-height: 0;
		overflow: hidden;
	}

	.main-area.without-classic-chrome {
		grid-template-columns: 1fr;
	}

	/* ── Sidebar ── */
	.sidebar {
		background: var(--sidebar-bg);
		color: var(--sidebar-text);
		padding: 1rem 0.75rem;
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		border-right: 1px solid var(--sidebar-border);
		min-height: 0;
		overflow: hidden; /* internal scrolling only on .explore */
	}

	.brand-block {
		padding: 0.2rem 0.3rem 0;
	}

	.eyebrow {
		font-size: 0.74rem;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		opacity: 0.65;
		font-family: var(--font-display);
	}

	.explore {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		flex: 1;
		min-height: 0;
		overflow-y: auto;
	}

	.rail-section {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}

	.rail-section-header {
		font-size: 0.7rem;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		opacity: 0.55;
		margin: 0.4rem 0.5rem 0.2rem;
		font-family: var(--font-display);
	}

	.rail-link {
		display: block;
		text-align: left;
		padding: 0.45rem 0.7rem;
		padding-left: 1.6rem;
		border-radius: 8px;
		background: transparent;
		border: 1px solid transparent;
		color: var(--sidebar-text);
		font-size: 0.88rem;
		cursor: pointer;
		transition: background 120ms ease;
	}

	.rail-link.top {
		font-weight: 500;
		padding-left: 0.7rem;
	}

	.rail-link:hover:not(:disabled) {
		background: var(--sidebar-hover-bg);
	}

	.rail-link:disabled {
		opacity: 0.45;
		cursor: default;
	}

	.rail-link.muted {
		opacity: 0.5;
	}

	.rail-skeleton {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		padding: 0.5rem;
	}

	.skel-row {
		height: 1.1rem;
		border-radius: 6px;
		background: linear-gradient(
			90deg,
			rgba(255, 255, 255, 0.05) 0%,
			rgba(255, 255, 255, 0.12) 50%,
			rgba(255, 255, 255, 0.05) 100%
		);
		animation: rail-shimmer 1.4s linear infinite;
	}

	@keyframes rail-shimmer {
		0% { background-position: -100px 0; }
		100% { background-position: 200px 0; }
	}

	.rail-error {
		font-size: 0.8rem;
		color: var(--text-soft);
		padding: 0.5rem;
	}

	.sidebar-footer {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		padding-top: 0.4rem;
		border-top: 1px solid var(--sidebar-border);
	}

	.status {
		background: var(--sidebar-card-bg);
		border-color: var(--sidebar-card-border);
		color: var(--sidebar-text);
		padding: 0.55rem 0.65rem;
		border-radius: 9px;
	}

	.status-value {
		font-weight: 700;
		font-size: 0.82rem;
	}

	.status-value.good {
		color: #89f0b4;
	}

	.status-core {
		margin-top: 0.2rem;
		font-weight: 600;
		font-size: 0.82rem;
	}

	.status-version {
		font-size: 0.72rem;
		opacity: 0.62;
		margin-top: 0.05rem;
	}

	.status-rev {
		font-family: var(--font-mono);
		font-size: 0.68rem;
		opacity: 0.55;
		margin-top: 0.2rem;
	}

	.status-about {
		font-size: 0.68rem;
		opacity: 0.62;
		margin-top: 0.45rem;
	}

	.status-disclaimer {
		font-size: 0.62rem;
		opacity: 0.4;
		margin-top: 0.15rem;
	}

	.sidebar-scrim {
		display: none;
	}

	/* ── Workspace ── */
	.workspace {
		display: flex;
		flex-direction: column;
		position: relative;
		min-height: 0;
		min-width: 0;
		overflow: hidden;
	}

	.workspace-header {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.5rem 4.1rem 0.5rem 0.9rem;
		border-bottom: 1px solid var(--border);
		background: var(--surface-1);
		flex-shrink: 0; /* doesn't scroll with workspace-main */
	}

	.hamburger {
		display: none;
		font-size: 1.1rem;
		line-height: 1;
		padding: 0.3rem 0.55rem;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--surface-2);
		color: var(--text);
		cursor: pointer;
	}

	.nav-btns {
		display: flex;
		gap: 0.2rem;
	}

	.nav-spacer {
		width: 0;
	}

	.nav-btn {
		width: 2rem;
		height: 2rem;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--surface-2);
		color: var(--text);
		font-size: 1rem;
		display: grid;
		place-items: center;
		cursor: pointer;
		transition: background 120ms ease;
	}

	.nav-btn:hover:not(:disabled) {
		background: var(--surface-3);
	}

	.nav-btn:disabled {
		opacity: 0.35;
		cursor: default;
	}

	.header-search {
		flex: 0 0 auto;
		width: 360px;
		max-width: 50vw;
		margin-left: auto;
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

	/* Cap the inner content so wide screens don't stretch grids
	   edge-to-edge, but let the scroll container itself fill. */
	.workspace-main > :global(*) {
		max-width: var(--workspace-content-max-width);
		margin: var(--workspace-content-margin);
		width: var(--workspace-content-width);
		height: var(--workspace-content-height);
	}

	.workspace-main.full-bleed {
		animation: none;
	}

	/* ── Play bar (persistent footer) ── */
	.play-bar {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
		align-items: center;
		gap: 0.6rem;
		padding: 0 1rem 0.5rem;
		background: var(--mini-player-bg);
		border-color: var(--mini-player-border);
		color: var(--mini-player-text);
		margin: 0.4rem;
		border-radius: 14px;
		overflow: hidden;
	}

	.play-bar.compact {
		z-index: 10;
		box-shadow: 0 10px 30px rgba(0, 0, 0, 0.28);
	}

	.play-bar.unified {
		display: flex;
		flex-shrink: 0;
		align-items: center;
		gap: 18px;
		margin: 0;
		padding: 10px 22px;
		overflow: visible;
		border: 0;
		border-top: 1px solid rgba(255, 255, 255, 0.09);
		border-radius: 0;
		background: #050505;
		color: #fff;
		font: 15px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
		-webkit-font-smoothing: antialiased;
		box-shadow: none;
	}

	.play-bar.unified.pi-density {
		padding: 14px 22px;
	}

	.unified-now-playing {
		width: 190px;
		min-width: 190px;
	}

	.unified-title {
		display: block;
		max-width: 190px;
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

	.unified-time {
		color: #5e5e5e;
		font-size: 11px;
	}

	.unified-transport-controls {
		display: flex;
		align-items: center;
		gap: 14px;
		margin: 0 auto;
		color: #c4c4c4;
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
		background: #161616;
	}

	.unified-transport-controls button:disabled {
		opacity: 0.45;
		cursor: default;
	}

	.unified-transport-controls button.big {
		width: 38px;
		height: 38px;
		padding: 0;
		border: 1px solid rgba(255, 255, 255, 0.2);
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
		color: #5e5e5e;
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
		background: #1c1c1c;
	}

	.unified-volume.unavailable {
		opacity: 0.55;
	}

	.unified-zone {
		display: flex;
		align-items: center;
		gap: 10px;
		color: #9a9a9a;
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
		background: #161616;
		color: #d8d8d8;
	}

	.unified-zone-trigger:focus-visible {
		outline: 1px solid #c8a24a;
		outline-offset: 1px;
	}

	.unified-zone-trigger:disabled {
		cursor: default;
		opacity: 0.55;
	}

	.unified-zone-chevron {
		color: #5e5e5e;
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
		border: 1px solid rgba(255, 255, 255, 0.15);
		border-radius: 9px;
		background: #090909;
		box-shadow: 0 16px 42px rgba(0, 0, 0, 0.62);
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
		color: #d8d8d8;
		font: inherit;
		text-align: left;
		white-space: nowrap;
		cursor: pointer;
	}

	.unified-zone-menu button:hover,
	.unified-zone-menu button:focus-visible {
		outline: 0;
		background: #181818;
		color: #fff;
	}

	.unified-zone-menu button.selected {
		color: #c8a24a;
	}

	.unified-zone-dot {
		display: inline-block;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: #5e5e5e;
	}

	.unified-zone-dot.connected {
		background: #3fcf8e;
		box-shadow: 0 0 8px #3fcf8e;
	}

	.unified-queue {
		padding: 7px 14px;
		border: 1px solid rgba(255, 255, 255, 0.09);
		border-radius: 7px;
		background: #121212;
		color: #d8d8d8;
		font-size: 12px;
		text-decoration: none;
	}

	.unified-queue:hover {
		background: #1c1c1c;
	}

	.compact-now-playing {
		display: flex;
		align-items: center;
	}

	.play-bar.compact .pb-art {
		width: 44px;
		height: 44px;
	}

	.compact-transport-meta {
		display: grid;
		min-width: 0;
		gap: 0.05rem;
	}

	.compact-title {
		min-width: 0;
		overflow: hidden;
		font-size: 0.82rem;
		font-weight: 650;
		line-height: 1.1;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.compact-subtitle {
		min-height: 0.85rem;
		overflow: hidden;
		font-size: 0.7rem;
		opacity: 0.72;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.compact-progress {
		height: 3px;
		margin-top: 0.18rem;
		overflow: hidden;
		background: rgba(255, 255, 255, 0.1);
		cursor: default;
	}

	.compact-progress.seekable {
		cursor: pointer;
	}

	.compact-progress:focus-visible {
		outline: 2px solid var(--accent-2);
		outline-offset: 2px;
	}

	.pb-progress-bar {
		grid-column: 1 / -1;
		height: 3px;
		background: rgba(255, 255, 255, 0.1);
		cursor: default;
		margin-bottom: 0.3rem;
	}

	.pb-progress-bar.seekable {
		cursor: pointer;
	}

	.pb-progress-bar.seekable:hover {
		height: 5px;
	}

	.pb-progress-bar:focus-visible {
		outline: 2px solid var(--accent-2);
		outline-offset: 2px;
		height: 5px;
	}

	.pb-progress-fill {
		height: 100%;
		background: linear-gradient(90deg, var(--accent), var(--accent-2));
		transition: width 0.8s linear;
	}

	.pb-time {
		font-size: 0.72rem;
		font-family: var(--font-mono);
		opacity: 0.55;
		margin-top: 0.1rem;
	}

	.pb-track {
		display: flex;
		align-items: center;
		gap: 0.65rem;
		min-width: 0;
	}

	.pb-art {
		width: 48px;
		height: 48px;
		border-radius: 8px;
		overflow: hidden;
		background: rgba(255, 255, 255, 0.08);
		flex-shrink: 0;
	}

	/* Override button defaults: the pb-art is now a button (clickable to
	   open the now-playing overlay), but it must look identical to the
	   old non-clickable square. */
	.pb-art-button {
		padding: 0;
		border: 0;
		color: inherit;
		cursor: pointer;
		display: block;
	}
	.pb-art-button:disabled {
		cursor: default;
	}
	.pb-art-button:not(:disabled):hover {
		outline: 2px solid var(--accent, #6cf);
		outline-offset: 2px;
	}

	.pb-art img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.pb-meta {
		min-width: 0;
	}

	.pb-title {
		font-weight: 650;
		font-size: 0.9rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.pb-sub {
		font-size: 0.8rem;
		opacity: 0.78;
		margin-top: 0.08rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.pb-link {
		display: block;
		background: none;
		border: none;
		padding: 0;
		text-align: left;
		color: inherit;
		cursor: pointer;
		max-width: 100%;
	}

	.pb-link:hover {
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	/* Per-artist links flow inline inside the (truncating) .pb-sub
	   line; .pb-link's display:block would stack them. */
	.pb-artists .pb-artist-link {
		display: inline;
		font: inherit;
	}

	.pb-artist-sep {
		margin: 0 0.25rem;
		opacity: 0.6;
	}

	.pb-controls {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.ctrl-btn {
		width: 2.4rem;
		height: 2.4rem;
		border-radius: 50%;
		border: 1px solid rgba(255, 255, 255, 0.15);
		background: rgba(255, 255, 255, 0.08);
		color: inherit;
		font-size: 1rem;
		display: grid;
		place-items: center;
		cursor: pointer;
		transition: background 120ms ease;
	}

	.ctrl-btn:hover:not(:disabled) {
		background: rgba(255, 255, 255, 0.16);
	}

	.ctrl-btn.primary {
		width: 2.8rem;
		height: 2.8rem;
		background: linear-gradient(135deg, var(--accent), var(--accent-2));
		border-color: transparent;
		font-size: 1.05rem;
	}

	.ctrl-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.pb-right {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		justify-content: flex-end;
	}

	.queue-btn {
		padding: 0.38rem 0.8rem;
		border-radius: 9px;
		border: 1px solid rgba(255, 255, 255, 0.2);
		background: rgba(255, 255, 255, 0.1);
		color: inherit;
		font-size: 0.85rem;
		white-space: nowrap;
		transition: background 120ms ease;
	}

	.zone-select {
		padding: 0.38rem 0.5rem;
		border-radius: 9px;
		border: 1px solid rgba(255, 255, 255, 0.18);
		background: rgba(255, 255, 255, 0.1);
		color: inherit;
		font-size: 0.85rem;
		max-width: 160px;
	}

	/* Group / ungroup icon buttons sit between the zone selector
	   and the queue link. Square-ish so the emoji glyph centers. */
	.zone-action-btn {
		padding: 0.32rem 0.55rem;
		border-radius: 9px;
		border: 1px solid rgba(255, 255, 255, 0.18);
		background: rgba(255, 255, 255, 0.07);
		color: inherit;
		font-size: 0.9rem;
		line-height: 1;
		cursor: pointer;
	}
	.zone-action-btn:hover:not(:disabled) {
		background: rgba(255, 255, 255, 0.14);
	}
	.zone-action-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.queue-btn:hover {
		background: rgba(255, 255, 255, 0.18);
	}

	.vol-slider {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.25rem 0.5rem;
		border-radius: 9px;
		background: rgba(255, 255, 255, 0.08);
		border: 1px solid rgba(255, 255, 255, 0.15);
	}

	.vol-slider input[type='range'] {
		width: 100px;
		accent-color: var(--accent);
	}

	.vol-incremental {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		padding: 0.25rem 0.4rem;
		border-radius: 9px;
		background: rgba(255, 255, 255, 0.08);
		border: 1px solid rgba(255, 255, 255, 0.15);
	}

	.vol-step {
		width: 1.6rem;
		height: 1.6rem;
		border-radius: 6px;
		border: 1px solid rgba(255, 255, 255, 0.2);
		background: rgba(255, 255, 255, 0.08);
		color: inherit;
		font-size: 0.95rem;
		line-height: 1;
		cursor: pointer;
	}

	.vol-step:hover {
		background: rgba(255, 255, 255, 0.18);
	}

	.vol-icon {
		font-size: 0.9rem;
		opacity: 0.85;
	}

	/* ── Responsive ── */
	@media (max-width: 1020px) {
		.main-area {
			grid-template-columns: 1fr;
		}

		.sidebar {
			position: fixed;
			top: 0;
			left: 0;
			bottom: 0;
			width: 240px;
			z-index: 12;
			transform: translateX(-100%);
			transition: transform 220ms ease;
		}

		.sidebar.open {
			transform: translateX(0);
			box-shadow: 4px 0 24px rgba(0, 0, 0, 0.35);
		}

		.sidebar-scrim {
			display: block;
			position: fixed;
			inset: 0;
			background: rgba(0, 0, 0, 0.5);
			z-index: 11;
			animation: scrim-fade 200ms ease;
		}

		@keyframes scrim-fade {
			from { opacity: 0; }
			to { opacity: 1; }
		}

		.hamburger {
			display: grid;
			place-items: center;
		}
	}

	@media (max-width: 680px) {
		.play-bar {
			grid-template-columns: 1fr auto;
			grid-template-rows: auto auto;
		}

		.pb-right {
			grid-column: 1 / -1;
			justify-content: flex-start;
		}

		.header-search {
			max-width: none;
		}
	}
</style>
