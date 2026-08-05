<script lang="ts">
	import { getContext, onMount, tick } from 'svelte';
	import { get } from 'svelte/store';
	import Search from '$lib/components/Search.svelte';
	import ItemGrid from '$lib/components/ItemGrid.svelte';
	import TrackList from '$lib/components/TrackList.svelte';
	import TrackActionsMenu from '$lib/components/TrackActionsMenu.svelte';
	import { trackTitle } from '$lib/trackTitle';
	import { splitArtists } from '$lib/artistList';
	import { imageUrl } from '$lib/imageUrl';
	import { hideOnError } from '$lib/actions/imageFallback';
	import {
		extractAlbumChips,
		extractArtistFromSubtitle,
		isAlbumPage
	} from '$lib/albumChips';
	import { searchTypeForToken } from '@shared/searchTypes';
	import type {
		ClassicBrowseOptions,
		ClassicBrowsePopOptions,
		ClassicBrowseRole
	} from '@shared/classicBrowseContracts';
	import {
		browseStore,
		setBrowseError,
		setBrowseLoading,
		clearBrowseLoading,
		setSearchLoading,
		setSearchResults,
		setSearchError,
		clearSearchResults,
		closeSearchPanel,
		setBrowseResult,
		appendBrowseItems,
		resetBrowse,
		openSearchPanel
	} from '$lib/stores/browseStore';
	import { selectedZoneStore } from '$lib/stores/selectedZoneStore';
	import {
		pushCommandFeedback,
		browseNavStore,
		browseHistoryStore,
		pushHistory,
		popHistory,
		resetHistory,
		replaceHistory,
		getClassicHistorySnapshot,
		welcomeStatsStore,
		loadWelcomeStats,
		invalidateWelcomeStats,
		resolveExploreRail,
		invalidateExploreRail,
		recentlyPlayedStore,
		applyClearResponse,
		favoritesStore,
		loadFavorites,
		addFavorite,
		removeFavorite,
		nowPlayingList,
		type BrowseBreadcrumb,
		type BrowseHistoryContext,
		type BrowseHistoryStep,
		type ClassicHistorySnapshot
	} from '$lib/stores';
	import { zoneMapStore } from '$lib/stores/zonesStore';
	import { getSocket } from '$lib/socket/client';
	import {
		classicBrowseSessionClient,
		ClassicBrowseSupersededError,
		type ClassicBrowseSessionClaim
	} from '$lib/stores/classicBrowseSessionStore';
	import {
		browse as apiBrowse,
		browseLoad as apiBrowseLoad,
		browsePop as apiBrowsePop,
		clearRecentlyPlayed,
		withClassicBrowseRoleTransaction,
		type ClassicBrowseApiTransaction
	} from '$lib/api/client';
	import { browseSearch as apiBrowseSearch } from '$lib/api/client';
	import { buildClassicLibraryPageState } from '$lib/libraryPageState';
	import {
		pushLibraryPageState,
		replaceLibraryPageState
	} from '$lib/libraryPageNavigation';
	import {
		LIBRARY_MODE_ACTIVATION_CONTEXT,
		type CommittedLibraryModeActivation,
		type LibraryModeActivationContext
	} from '$lib/libraryModeActivationContext';
	import {
		claimLibraryIntent,
		pendingLibraryIntentStore,
		publishLibraryIntent,
		type PendingLibraryIntent
	} from '$lib/stores/libraryIntentStore';
	import { libraryViewHostStore } from '$lib/stores/libraryViewHostStore';
	import type { LibraryIntent } from '$lib/libraryIntent';
	import type {
		AddFavoriteRequest,
		BrowseItem,
		BrowseResult,
		FavoriteEntry,
		RecentlyPlayedEntry,
		SearchResult
	} from '@shared/types';
	import type { BrowseHistoryState } from '$lib/stores/browseHistoryStore';

	let { restoreOnMount = true }: { restoreOnMount?: boolean } = $props();
	let socket = $state(getSocket());
	let quickPlayInFlight = $state(false);
	let loadMoreInFlight = $state(false);
	let libraryIntentBusy = $state(false);
	let scrollSearchResultsPending = $state(false);
	let classicLifecycleActive = $state(false);
	let classicLifecycleGeneration = 0;
	let classicResumeCount = 0;
	let classicRecoveryGeneration: number | null = null;
	let classicSessionClaim = $state.raw<ClassicBrowseSessionClaim | null>(null);
	let previousClassicSessionPhase: 'none' | 'acquiring' | 'live' = 'none';
	let previousClassicSessionGeneration = 0;
	let browseRequestGeneration = 0;
	let classicSocketListenersAttached = false;
	type ClassicInfiniteScrollResource = {
		resume(): void;
		suspend(): void;
	};
	const classicInfiniteScrollResources = new Set<ClassicInfiniteScrollResource>();
	const activationContext = getContext<LibraryModeActivationContext>(
		LIBRARY_MODE_ACTIVATION_CONTEXT
	);

	function attachClassicSocketListeners(): void {
		const nextSocket = getSocket();
		if (classicSocketListenersAttached && socket !== nextSocket) {
			detachClassicSocketListeners();
		}
		socket = nextSocket;
		if (!socket || classicSocketListenersAttached) return;
		socket.on('disconnect', handleClassicConnectionLost);
		socket.on('connect', handleClassicReconnect);
		classicSocketListenersAttached = true;
	}

	function detachClassicSocketListeners(): void {
		if (!classicSocketListenersAttached) return;
		socket?.off('disconnect', handleClassicConnectionLost);
		socket?.off('connect', handleClassicReconnect);
		classicSocketListenersAttached = false;
	}

	function resumeClassicInfiniteScroll(): void {
		for (const resource of classicInfiniteScrollResources) resource.resume();
	}

	function suspendClassicInfiniteScroll(): void {
		for (const resource of classicInfiniteScrollResources) resource.suspend();
	}

	function isCurrentClassicLifecycle(generation: number): boolean {
		return classicLifecycleActive && generation === classicLifecycleGeneration;
	}

	function requireClassicSessionClaim(): ClassicBrowseSessionClaim {
		if (
			!classicSessionClaim ||
			!classicBrowseSessionClient.isClaimCurrent(classicSessionClaim)
		) throw new ClassicBrowseSupersededError();
		return classicSessionClaim;
	}

	function isCurrentClassicClaim(claim: ClassicBrowseSessionClaim): boolean {
		return (
			classicSessionClaim === claim &&
			classicBrowseSessionClient.isClaimCurrent(claim)
		);
	}

	type ClassicSessionFence = {
		claim: ClassicBrowseSessionClaim;
		generation: number;
	};

	function captureLiveClassicSessionGeneration(): ClassicSessionFence | null {
		const claim = classicSessionClaim;
		const sessionState = get(classicBrowseSessionClient);
		return (
			claim &&
			sessionState.phase === 'live' &&
			classicBrowseSessionClient.isClaimCurrent(claim) &&
			getSocket()?.connected
		)
			? { claim, generation: sessionState.lifecycleGeneration }
			: null;
	}

	function isCurrentClassicSessionGeneration(fence: ClassicSessionFence | null): boolean {
		return (
			fence !== null &&
			classicSessionClaim === fence.claim &&
			classicBrowseSessionClient.isGenerationCurrent(fence.claim, fence.generation) &&
			Boolean(getSocket()?.connected)
		);
	}

	function resumeClassic(_activation?: CommittedLibraryModeActivation): void {
		if (classicLifecycleActive) {
			attachClassicSocketListeners();
			resumeClassicInfiniteScroll();
			return;
		}
		cancelTrackMenu();
		trackMenuRequestGeneration += 1;
		classicLifecycleActive = true;
		attachClassicSocketListeners();
		resumeClassicInfiniteScroll();
		const generation = ++classicLifecycleGeneration;
		const isFirstResume = classicResumeCount++ === 0;
		const mustReseed = restoreOnMount || !isFirstResume || !!get(pendingLibraryIntentStore);
		const pendingAtResume = get(pendingLibraryIntentStore);
		const hasOfflineLocalIntent =
			pendingAtResume?.intent.destination === 'welcome-section';
		libraryIntentConsumerActive = false;
		initialLibraryIntentSeen = false;
		browseRequestGeneration += 1;
		trackMenuBusy = false;
		if (mustReseed) {
			resetBrowse();
			clearSearchResults();
			closeSearchPanel();
		}
		libraryIntentBusy = mustReseed;
		browseNavStore.set({
			canBack: false,
			canForward: false,
			back: pop,
			forward,
			home: () => {
				if (!libraryIntentBusy) resetRoot(true);
			}
		});
		if (hasOfflineLocalIntent) {
			libraryIntentConsumerActive = true;
			scheduleInitialLibraryNavigation();
		}

		const sessionClaim = classicBrowseSessionClient.claim('classic-mode');
		classicSessionClaim = sessionClaim;
		// Establish this instance's own claim generation as the lifecycle
		// baseline. A keyed predecessor may still have been live when this
		// component's effect first subscribed; acquiring our replacement claim
		// is not a later retirement of authority this instance rendered.
		const claimedSessionState = get(classicBrowseSessionClient);
		previousClassicSessionPhase = claimedSessionState.phase;
		previousClassicSessionGeneration = claimedSessionState.lifecycleGeneration;
		void sessionClaim.ready
			.then(() => {
				if (!isCurrentClassicLifecycle(generation) || !isCurrentClassicClaim(sessionClaim)) return;
				libraryIntentConsumerActive = true;
				if (mustReseed) {
					scheduleInitialLibraryNavigation();
				} else {
					libraryIntentBusy = false;
				}
				void resolveExploreRail(fetch, sessionClaim);
				if (!get(welcomeStatsStore).loaded) void loadWelcomeStats(fetch, sessionClaim);
			})
			.catch((error) => {
				if (!isCurrentClassicLifecycle(generation) || !isCurrentClassicClaim(sessionClaim)) return;
				if (hasOfflineLocalIntent) {
					void libraryIntentResolution.finally(() => {
						if (!isCurrentClassicLifecycle(generation)) return;
						libraryIntentConsumerActive = false;
						libraryIntentBusy = false;
					});
				} else {
					libraryIntentBusy = false;
				}
				if (!hasOfflineLocalIntent && !(error instanceof ClassicBrowseSupersededError)) {
					setBrowseError(`Classic session failed: ${(error as Error).message}`);
				}
			});
	}

	function suspendClassic(): void {
		detachClassicSocketListeners();
		suspendClassicInfiniteScroll();
		if (!classicLifecycleActive) return;
		const sessionClaim = classicSessionClaim;
		const ownsSessionClaim = Boolean(
			sessionClaim && classicBrowseSessionClient.isClaimCurrent(sessionClaim)
		);
		cancelTrackMenu();
		trackMenuRequestGeneration += 1;
		classicLifecycleActive = false;
		classicLifecycleGeneration += 1;
		browseRequestGeneration += 1;
		libraryIntentConsumerActive = false;
		libraryIntentGeneration += 1;
		libraryIntentResolution = Promise.resolve();
		trackMenuRequestBarrier = Promise.resolve();
		trackMenuBusy = false;
		quickPlayInFlight = false;
		recentlyPlayedClickInFlight = false;
		favoriteClickInFlight = false;
		loadMoreInFlight = false;
		libraryIntentBusy = true;
		scrollSearchResultsPending = false;
		if (ownsSessionClaim) {
			resetBrowse();
			clearSearchResults();
			closeSearchPanel();
			invalidateExploreRail();
			invalidateWelcomeStats();
			browseNavStore.set({
				canBack: false,
				canForward: false,
				back: noop,
				forward: noop,
				home: noop
			});
		}
		classicSessionClaim = null;
		if (sessionClaim) classicBrowseSessionClient.release(sessionClaim);
	}

	function retireClassicLocalAuthority(): void {
		cancelTrackMenu();
		trackMenuRequestGeneration += 1;
		classicLifecycleGeneration += 1;
		libraryIntentConsumerActive = false;
		browseRequestGeneration += 1;
		libraryIntentGeneration += 1;
		libraryIntentResolution = Promise.resolve();
		trackMenuRequestBarrier = Promise.resolve();
		trackMenuBusy = false;
		quickPlayInFlight = false;
		recentlyPlayedClickInFlight = false;
		favoriteClickInFlight = false;
		loadMoreInFlight = false;
		libraryIntentBusy = true;
		scrollSearchResultsPending = false;
		resetBrowse();
		clearSearchResults();
		closeSearchPanel();
		invalidateExploreRail();
		invalidateWelcomeStats();
	}

	function handleClassicConnectionLost(): void {
		const sessionClaim = classicSessionClaim;
		if (!classicLifecycleActive || !sessionClaim || !isCurrentClassicClaim(sessionClaim)) return;
		retireClassicLocalAuthority();
		classicBrowseSessionClient.connectionLost(sessionClaim);
	}

	function handleClassicReconnect(): void {
		const generation = classicLifecycleGeneration;
		const sessionClaim = classicSessionClaim;
		if (
			!classicLifecycleActive ||
			!sessionClaim ||
			!isCurrentClassicClaim(sessionClaim) ||
			classicRecoveryGeneration === generation
		) return;
		classicRecoveryGeneration = generation;
		libraryIntentConsumerActive = false;
		initialLibraryIntentSeen = false;
		void classicBrowseSessionClient
			.recover(sessionClaim)
			.then(() => {
				if (!isCurrentClassicLifecycle(generation) || !isCurrentClassicClaim(sessionClaim)) return;
				libraryIntentConsumerActive = true;
				scheduleInitialLibraryNavigation();
				void resolveExploreRail(fetch, sessionClaim);
				if (!get(welcomeStatsStore).loaded) void loadWelcomeStats(fetch, sessionClaim);
			})
			.catch((error) => {
				if (
					isCurrentClassicLifecycle(generation) &&
					isCurrentClassicClaim(sessionClaim) &&
					!(error instanceof ClassicBrowseSupersededError)
				) {
					libraryIntentBusy = false;
					setBrowseError(`Classic reconnect failed: ${(error as Error).message}`);
				}
			})
			.finally(() => {
				if (classicRecoveryGeneration === generation) classicRecoveryGeneration = null;
			});
	}

	$effect(() => {
		const phase = $classicBrowseSessionClient.phase;
		const sessionGeneration = $classicBrowseSessionClient.lifecycleGeneration;
		const previous = previousClassicSessionPhase;
		const previousGeneration = previousClassicSessionGeneration;
		const sessionClaim = classicSessionClaim;
		previousClassicSessionPhase = phase;
		previousClassicSessionGeneration = sessionGeneration;
		if (
			classicLifecycleActive &&
			sessionClaim &&
			classicBrowseSessionClient.isClaimCurrent(sessionClaim) &&
			previous === 'live' &&
			sessionGeneration !== previousGeneration &&
			getSocket()?.connected
		) {
			// A failed command retires its lifecycle generation synchronously.
			// Another queued transaction can already be acquiring (or live) by
			// the time this effect runs, so phase === 'none' is not observable.
			// The generation boundary still invalidates every rendered item key.
			retireClassicLocalAuthority();
			handleClassicReconnect();
		}
	});

	onMount(() => {
		socket = getSocket();

		// Favorites for the welcome view. Normally loaded by the layout's
		// initializeStores; this covers a direct page mount.
		if (!get(favoritesStore).loaded) {
			void loadFavorites(fetch);
		}

		const unregisterLifecycle = activationContext?.registerLifecycle
			? activationContext.registerLifecycle('classic', {
					resume: resumeClassic,
					suspend: suspendClassic
				})
			: (() => {
					resumeClassic(activationContext?.committedActivation?.() ?? undefined);
					return noop;
				})();

		return () => {
			unregisterLifecycle();
			suspendClassic();
			detachClassicSocketListeners();
			suspendClassicInfiniteScroll();
		};
	});

	// Now-playing hero card on the welcome view. Selected zone might
	// not yet be set on first mount; in that case the welcome view
	// just hides the hero.
	const heroNowPlaying = $derived(
		$selectedZoneStore ? $nowPlayingList.find((t) => t.zone_id === $selectedZoneStore) : undefined
	);
	const heroZone = $derived(
		$selectedZoneStore ? $zoneMapStore.get($selectedZoneStore) : undefined
	);
	const heroIsPlaying = $derived(heroZone?.state === 'playing');

	function fmtCount(n: number | null): string {
		return n === null ? '—' : n.toLocaleString();
	}

	/**
	 * Track-row "now playing" check. Compares a row from a track-list
	 * page against the selected zone's now_playing payload. Match is
	 * by stripped title equality + artist substring on the row's
	 * subtitle. We strip the leading "N. " prefix the same way
	 * `trackTitle` does so a numbered row matches against Roon's
	 * unprefixed now_playing.title.
	 */
	function isNowPlayingTrack(item: BrowseItem): boolean {
		const np = heroNowPlaying;
		if (!np?.title || !item.title) return false;
		const itemTitle = trackTitle(item.title).toLowerCase();
		if (itemTitle !== np.title.toLowerCase()) return false;
		if (np.artist && item.subtitle) {
			return item.subtitle.toLowerCase().includes(np.artist.toLowerCase());
		}
		return true;
	}

	let recentlyPlayedClickInFlight = $state(false);

	/**
	 * Play a Recently Played tile. We don't store Roon item_keys (they're
	 * session-scoped — would be stale across Core restarts), so we resolve
	 * the entry to a fresh result by searching Roon for its title and
	 * matching against the recorded artist/album/duration. On a confirmed
	 * match, run the quickPlay action-lookup → Play Now flow against the
	 * fresh search itemKey. On no match (track removed from library, name
	 * collision, etc.), surface a feedback toast.
	 */
	/**
	 * Normalize a string for tolerant equality / substring comparison.
	 * Live regression: a Recently Played entry for "'Til Tuesday –
	 * Love in a Vacuum" failed to resolve because the stored artist
	 * used U+2019 (curly apostrophe) and Roon's search response used
	 * U+0027 (straight). Same risk with en/em dashes, double quotes,
	 * stray whitespace, and case. Compose all comparisons through
	 * this so a single character difference doesn't hide a real track.
	 */
	function normalizeText(s: string | undefined | null): string {
		if (!s) return '';
		return s
			// NFC: precomposed `Beyoncé` (U+00E9) vs decomposed
			// `Beyonce` + U+0301 should compare equal. Without this,
			// the token strip can also lose the combining mark and
			// produce `beyonce` vs `beyoncé`.
			.normalize('NFC')
			.toLowerCase()
			.replace(/[‘’‛]/g, "'")
			.replace(/[“”‟]/g, '"')
			// Includes U+2010/U+2011 (‐ ‑): live Roon search subtitles
			// render "Lin‐Manuel" with U+2010 where tags use ASCII '-'.
			.replace(/[–—−‐‑]/g, '-')
			.replace(/\s+/g, ' ')
			.trim();
	}

	/**
	 * Tokenize a string for content comparison: split on whitespace
	 * and common metadata separators, then strip leading/trailing
	 * non-letter/digit chars from each token. Empty tokens dropped.
	 * Preserves internal punctuation so contractions ("what's"),
	 * hyphens-inside-words, and accented letters survive.
	 *
	 * Unicode-aware via `\p{L}\p{N}` (letters + numbers across
	 * scripts) so albums with accented characters (`Beyoncé`) and
	 * non-Latin scripts tokenize correctly.
	 */
	function tokenizeForMatch(s: string): string[] {
		return s
			.split(/[\s·/,|:;\-]+/)
			.map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
			.filter((t) => t.length > 0);
	}

	/**
	 * True when `album` appears in `subtitle` as a contiguous run of
	 * whole tokens — NOT as an arbitrary substring.
	 *
	 * Tokens are compared after stripping leading/trailing punctuation,
	 * so `Help!`, `(What's the Story) Morning Glory?`, and `Beyoncé`
	 * match correctly even though their boundaries aren't ASCII-word
	 * characters. The earlier `\b<album>\b` regex couldn't handle
	 * these: `\b` in JS is ASCII-only, so `\bHelp!\b` produces a
	 * "no-boundary after !" match where there shouldn't be one,
	 * and `\b(What's…\b` is malformed entirely (L-2 follow-up).
	 *
	 * Short-album safety preserved: album="1" against subtitle "Live
	 * in 1971" tokenizes to ["1"] vs ["live","in","1971"] — no token
	 * match → false. The substring-bug case stays fixed.
	 */
	function subtitleHasAlbumToken(subtitle: string, album: string): boolean {
		if (!album) return false;
		const subTokens = tokenizeForMatch(subtitle);
		const albTokens = tokenizeForMatch(album);
		if (albTokens.length === 0) return false;
		const last = subTokens.length - albTokens.length;
		for (let i = 0; i <= last; i++) {
			let all = true;
			for (let j = 0; j < albTokens.length; j++) {
				if (subTokens[i + j] !== albTokens[j]) {
					all = false;
					break;
				}
			}
			if (all) return true;
		}
		return false;
	}

	/**
	 * Find the search result that matches a Recently Played entry's
	 * track. Three passes from strongest evidence to weakest:
	 *
	 *   1. Strict — title matches AND artist appears in subtitle
	 *      (Unicode-normalized substring).
	 *   2. Album-evidence — title matches AND album appears in
	 *      subtitle as a word-boundary token, AND there's EXACTLY ONE
	 *      such candidate. Roon sometimes formats subtitles as
	 *      "Album" alone, or "Artist · Album" where the artist string
	 *      doesn't match verbatim. Album evidence catches those
	 *      WITHOUT opening the wrong-track door:
	 *        - Word-boundary regex prevents short-album false
	 *          positives ("1" matching "1971").
	 *        - Single-candidate requirement prevents multi-version
	 *          ambiguity (same track appearing on N compilations).
	 *   3. Title-only ONLY when EXACTLY ONE title-matching track row
	 *      exists. Same disambiguation rationale as pass 2.
	 *      Reviewer caught the looser variants of both fallbacks as
	 *      silent wrong-play hazards.
	 */
	/** Title/artist/album metadata for resolving a track via search.
	 *  Satisfied by both RecentlyPlayedEntry and FavoriteEntry. */
	interface TrackMeta {
		title?: string;
		artist?: string;
		album?: string;
	}

	function findTrackMatch(
		items: BrowseItem[],
		entry: TrackMeta,
		opts: { assumeTracks?: boolean } = {}
	): BrowseItem | undefined {
		// Strip both sides of any "N. " / "D-T " row prefix. Favorites
		// saved before the multi-disc strip existed carry titles like
		// "1-22 Dear Theodosia" — comparing them raw can never match a
		// fresh search row.
		const titleN = normalizeText(entry.title ? trackTitle(entry.title) : '');
		const artistN = normalizeText(entry.artist);
		const albumN = normalizeText(entry.album);
		const isTrack = (c: BrowseItem) => {
			const type = (c.itemType ?? '').toLowerCase();
			// Trust an explicit itemType when Roon supplies one.
			if (type) return type === 'track' || type === 'tracks';
			// Untyped row. Live failure (BUGS.md 2026-06-09): Roon's
			// search response doesn't always stamp item_type on track
			// rows, and the old `type === 'track'` requirement made
			// every Recently Played click end in "Couldn't find".
			// Untyped action_list rows are playable leaves — at the
			// search top level those are tracks (albums/artists come
			// back as hint 'list'). On a drilled "Tracks" category page
			// (assumeTracks) every row is a track by construction.
			return opts.assumeTracks || c.hint === 'action_list';
		};
		// Compare stripped of any "N. " prefix — drilled category pages
		// can number their rows the way album pages do.
		const titleMatches = (c: BrowseItem) =>
			!!c.itemKey && isTrack(c) && normalizeText(trackTitle(c.title)) === titleN;

		if (artistN) {
			const strict = items.find(
				(c) => titleMatches(c) && normalizeText(c.subtitle).includes(artistN)
			);
			if (strict) return strict;
		}
		if (albumN) {
			const albumCandidates = items.filter(
				(c) => titleMatches(c) && subtitleHasAlbumToken(normalizeText(c.subtitle), albumN)
			);
			if (albumCandidates.length === 1) return albumCandidates[0];
			// length === 0: fall through to title-only.
			// length > 1: refuse here, but title-only's
			// single-candidate guard below will also refuse → toast.
		}
		const allTitleMatches = items.filter(titleMatches);
		if (allTitleMatches.length === 1) return allTitleMatches[0];
		return undefined;
	}

	/**
	 * Resolve a track described only by display metadata (Recently
	 * Played entry or track favorite) against a fresh Roon search and
	 * quick-play it. Throws on transport errors; "no match" / "no
	 * zone" are reported via feedback toast and resolve normally.
	 */
	async function resolveAndPlayTrack(entry: TrackMeta, command: string): Promise<void> {
		if (trackMenu || trackMenuBusy) return;
		const lifecycleGeneration = classicLifecycleGeneration;
		if (!isCurrentClassicLifecycle(lifecycleGeneration)) return;
		const zoneId = $selectedZoneStore || undefined;
		if (!zoneId) {
			pushCommandFeedback({
				source: 'browse',
				command,
				message: 'Select a zone to play.'
			});
			return;
		}
		if (!entry.title) return;
		// Search with the row prefix stripped: a stored title like
		// "1-22 Dear Theodosia" (multi-disc favorite saved before the
		// strip handled the "D-T " form) finds nothing verbatim.
		const searchTitle = trackTitle(entry.title);
		// Resolution takes several Roon round-trips (search → match →
		// drill → play), which reads as seconds of dead air on a real
		// Core (live feedback 2026-07-10) — acknowledge the click NOW.
		pushCommandFeedback({
			source: 'browse',
			command,
			kind: 'success',
			message: `Finding "${searchTitle}"…`
		});
		await withClassicBrowseRoleTransaction(
			'classic-search',
			requireClassicSessionClaim(),
			async (transaction) => {
			// Note: this re-seeds Roon's search session with the title,
			// but we deliberately do NOT touch browseStore's search panel
			// state (lastSearch / lastSearchQuery / searchLoading).
			// The user's previous search results must remain visible and
			// correctly labeled — clobbering lastSearchQuery while
			// leaving stale lastSearch would mislabel the prior results.
			// The tile's own `disabled` binding to
			// `recentlyPlayedClickInFlight` provides per-tile feedback.
			const search = await transaction.browse({
				hierarchy: 'search',
				input: searchTitle,
				zoneId,
				popAll: true
			});
			if (!isCurrentClassicLifecycle(lifecycleGeneration)) return;

			// Find a track-typed result with matching title + (optionally)
			// matching artist. Comparisons go through `normalizeText` so
			// curly-quote vs straight-quote ("'Til Tuesday" rendered with
			// U+2019 in the store vs U+0027 in Roon's response or
			// vice-versa), em/en-dash differences, and stray whitespace
			// don't make a real track miss its match. Verified live: an
			// RP entry for "'Til Tuesday – Love in a Vacuum" failed to
			// resolve against Roon's identical-looking search result
			// because of one curly-quote difference.
			//
			// If the strict title+artist match fails, retry with title
			// alone. A common live failure: Roon's track subtitle is
			// "Artist · Album · Year" (or any other variant) and our
			// recently-played `artist` field doesn't appear verbatim in
			// the subtitle string (e.g. abbreviated, combined with
			// "feat." additions, etc.). Title-only retry recovers these
			// cases. The risk of a wrong play (e.g. two unrelated tracks
			// sharing a title) is bounded — the user explicitly clicked
			// the RP tile so they wanted SOMETHING, and the
			// `?artistLower` check still applied on the first pass.
			let match = findTrackMatch(search.items, entry);

			if (!match?.itemKey) {
				// Top level had no usable track row. Roon's search top
				// level can list the track only under its "Tracks"
				// category (a hint:'list' row) rather than as a direct
				// hit. Drill that category once and retry the match
				// against the full track list. The drill leaves the
				// search session one level deep — acceptable, since
				// every search-panel interaction re-seeds with popAll.
				const tracksCategory = search.items.find(
					(c) => !!c.itemKey && c.hint === 'list' && normalizeText(c.title) === 'tracks'
				);
				if (tracksCategory?.itemKey) {
					const trackPage = await transaction.browse({
						hierarchy: 'search',
						itemKey: tracksCategory.itemKey,
						zoneId
					});
					if (!isCurrentClassicLifecycle(lifecycleGeneration)) return;
					match = findTrackMatch(trackPage.items, entry, { assumeTracks: true });
				}
			}

			if (!match?.itemKey) {
				pushCommandFeedback({
					source: 'browse',
					command,
					message: `Couldn't find "${searchTitle}" in your library.`
				});
				return;
			}

			// QuickPlay the matched track via its fresh search itemKey.
			await quickPlay(match, {
				hierarchy: 'search',
				role: 'classic-search',
				transaction,
				// resetSearch:false — we just freshened above.
				// playOnly: don't fall back to an action-menu browse on
				// missing play action. The fallback would record history
				// under the user's prior visible lastSearchQuery (R9
				// preserves it on RP clicks), letting restore re-seed
				// the wrong search session (R10 finding).
				playOnly: true
			});
			}
		);
	}

	async function playRecentEntry(entry: RecentlyPlayedEntry): Promise<void> {
		if (recentlyPlayedClickInFlight) return;
		const lifecycleGeneration = classicLifecycleGeneration;
		recentlyPlayedClickInFlight = true;
		try {
			await resolveAndPlayTrack(entry, 'recently-played');
		} catch (err) {
			if (
				isCurrentClassicLifecycle(lifecycleGeneration) &&
				!(err instanceof ClassicBrowseSupersededError)
			) {
				pushCommandFeedback({
					source: 'browse',
					command: 'recently-played',
					message: `Play failed: ${(err as Error).message}`
				});
			}
		} finally {
			if (isCurrentClassicLifecycle(lifecycleGeneration)) recentlyPlayedClickInFlight = false;
		}
	}

	let clearRecentInFlight = $state(false);

	/**
	 * Wipe the Recently Played list. The DELETE response carries an
	 * authoritative `{ entries, revision }` snapshot. `applyClearResponse`
	 * sets the store IF the revision is newer than anything else
	 * applied so far — newer socket events that arrived during the
	 * round trip already bumped lastApplied, so a stale snapshot
	 * is discarded; older or concurrent socket events with revisions
	 * <= the snapshot's get filtered out as they arrive too. Server,
	 * disk, and all clients converge regardless of arrival order.
	 */
	async function clearRecentEntries(): Promise<void> {
		if (clearRecentInFlight) return;
		clearRecentInFlight = true;
		try {
			const snapshot = await clearRecentlyPlayed(fetch);
			applyClearResponse(snapshot);
		} catch (err) {
			pushCommandFeedback({
				source: 'browse',
				command: 'recently-played',
				message: `Couldn't clear recently played: ${(err as Error).message}`
			});
		} finally {
			clearRecentInFlight = false;
		}
	}

	// ── Favorites (BUGS.md #4) ───────────────────────────────────────
	//
	// Like Recently Played, favorites store display metadata only — no
	// Roon item_keys. A track favorite plays via the same search
	// resolution; album/artist favorites run a library search for the
	// name (landing the user on the results to pick from).
	let favoriteClickInFlight = $state(false);
	let favoriteMutationInFlight = $state(false);

	async function addFavoriteEntry(payload: AddFavoriteRequest): Promise<void> {
		if (favoriteMutationInFlight) return;
		favoriteMutationInFlight = true;
		try {
			await addFavorite(fetch, payload);
			pushCommandFeedback({
				source: 'browse',
				command: 'favorites',
				kind: 'success',
				message: `Added "${payload.title}" to favorites.`
			});
		} catch (err) {
			pushCommandFeedback({
				source: 'browse',
				command: 'favorites',
				message: `Couldn't add favorite: ${(err as Error).message}`
			});
		} finally {
			favoriteMutationInFlight = false;
		}
	}

	async function handleRemoveFavorite(fav: FavoriteEntry): Promise<void> {
		if (favoriteMutationInFlight) return;
		favoriteMutationInFlight = true;
		try {
			await removeFavorite(fetch, fav.id);
		} catch (err) {
			pushCommandFeedback({
				source: 'browse',
				command: 'favorites',
				message: `Couldn't remove favorite: ${(err as Error).message}`
			});
		} finally {
			favoriteMutationInFlight = false;
		}
	}

	async function handleFavoriteClick(fav: FavoriteEntry): Promise<void> {
		if (fav.type === 'track') {
			if (favoriteClickInFlight) return;
			const lifecycleGeneration = classicLifecycleGeneration;
			favoriteClickInFlight = true;
			try {
				await resolveAndPlayTrack(fav, 'favorites');
			} catch (err) {
				if (
					isCurrentClassicLifecycle(lifecycleGeneration) &&
					!(err instanceof ClassicBrowseSupersededError)
				) {
					pushCommandFeedback({
						source: 'browse',
						command: 'favorites',
						message: `Play failed: ${(err as Error).message}`
					});
				}
			} finally {
				if (isCurrentClassicLifecycle(lifecycleGeneration)) favoriteClickInFlight = false;
			}
			return;
		}
		// Album / artist favorites: run a library search for the name —
		// the results panel gives the user the entity to drill into.
		scrollSearchResultsPending = true;
		void searchArtist(fav.title);
		// The favorites section lives far down the welcome view while the
		// search panel renders at the very top — without scrolling, the
		// click looks like it did nothing (live bug 2026-07-10).
	}

	$effect(() => {
		if (
			!scrollSearchResultsPending ||
			libraryIntentBusy ||
			!($browseStore.searchOpen || $browseStore.searchError || $browseStore.lastSearch)
		) return;
		scrollSearchResultsPending = false;
		void tick().then(() => {
			document
				.querySelector('.search-results-panel')
				?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
		});
	});

	/** "Add to Favorites" from the track ⋮ menu. */
	function addTrackFavoriteFromMenu(): void {
		const menu = trackMenu;
		if (!menu) return;
		// The album-page inference reads the browse PANE — meaningless
		// for a menu opened from the search panel, whose row already
		// carries its artist in the subtitle.
		const onAlbum =
			menu.origin === 'pane' && isAlbumPage($browseStore.current, isTrackList, inferredAllTracks);
		void addFavoriteEntry({
			type: 'track',
			title: trackTitle(menu.item.title),
			// Album rows usually carry no subtitle; fall back to the
			// album header's parsed artist. Library/Tracks rows carry
			// "Artist · Album" — stored as-is, the resolver's strict
			// pass compares it as a substring of fresh subtitles.
			artist: menu.item.subtitle || (onAlbum ? albumArtist || undefined : undefined),
			album: onAlbum ? $browseStore.current?.title : undefined
		});
		closeTrackMenu();
	}

	/**
	 * Normalize an itemType for breadcrumb-match comparison. Mirrors
	 * the singular/plural-tolerant style used by `BrowseService
	 * .inferSearchType` and the play-bar `itemTypeMatches` helper. A
	 * breadcrumb persisted with `'album'` should still match a fresh
	 * search result that comes back with `'Albums'` after a Core
	 * restart.
	 */
	function breadcrumbItemTypeMatches(actual: string | undefined, expected: string): boolean {
		const a = (actual ?? '').toLowerCase().replace(/s$/, '');
		const e = expected.toLowerCase().replace(/s$/, '');
		return a === e;
	}

	/**
	 * A search-top-level category stub is identified by its "N Results"
	 * subtitle (mirrors BrowseService.isSearchCategory). Shared by every
	 * category matcher on this page so the shape check cannot drift
	 * between them.
	 */
	function isCategoryResultsSubtitle(subtitle?: string): boolean {
		return /^\d+\s+results?$/i.test(subtitle ?? '');
	}

	function breadcrumbMatches(candidate: BrowseItem, crumb: BrowseBreadcrumb): boolean {
		// Search-category steps ("See all N" drills) match by the stub's
		// SHAPE, not by exact subtitle: the stub's "N Results" count is
		// volatile across re-seeds, so exact equality would break
		// restoration the moment the library count changes. The shape
		// (list hint + exact title + any "N Results" subtitle) still
		// rejects same-title content decoys, which never combine all
		// three (mirrors BrowseService.isSearchCategory).
		if (crumb.searchCategory) {
			return (
				candidate.hint === 'list' &&
				candidate.title === crumb.title &&
				isCategoryResultsSubtitle(candidate.subtitle)
			);
		}
		// Match on every breadcrumb field that's present. Title must match
		// exactly; subtitle/imageKey/itemType act as disambiguators when
		// multiple rows share a title (e.g. albums with the same name by
		// different artists).
		if (candidate.title !== crumb.title) return false;
		if (crumb.subtitle && candidate.subtitle !== crumb.subtitle) return false;
		if (crumb.imageKey && candidate.imageKey !== crumb.imageKey) return false;
		if (crumb.itemType && !breadcrumbItemTypeMatches(candidate.itemType, crumb.itemType))
			return false;
		return true;
	}

	function semanticPathEquals(
		left: readonly BrowseHistoryStep[],
		right: readonly BrowseHistoryStep[]
	): boolean {
		return JSON.stringify(left) === JSON.stringify(right);
	}

	function reportRestoreStop(message: string): void {
		pushCommandFeedback({
			source: 'browse',
			command: 'browse:restore',
			message: `Restore stopped: ${message}.`
		});
	}

	/**
	 * Restore Classic navigation from semantic state only. Every run starts
	 * at an explicit fresh browse/search root and obtains each item key from
	 * the immediately preceding response. Persisted/session state never
	 * supplies Roon authority.
	 */
	async function restoreBrowse(
		state: BrowseHistoryState,
		generation: number,
		preserveOnIncomplete?: ClassicHistorySnapshot,
		retireStaleRowsBeforeReadiness = false
	): Promise<boolean> {
		if (!isCurrentLibraryIntent(generation)) return false;
		const sessionGeneration = captureLiveClassicSessionGeneration();
		if (sessionGeneration === null) {
			// No live generation can own any rendered key, so this is teardown
			// of unsafe authority rather than optimistic navigation mutation.
			resetBrowse();
			libraryIntentBusy = false;
			return false;
		}

		libraryIntentBusy = true;
		cancelTrackMenu();
		trackMenuRequestGeneration += 1;
		trackMenuBusy = false;
		if (retireStaleRowsBeforeReadiness) {
			// A newly mounted Classic instance cannot retain live keys from the
			// instance it replaced, even while offline. This is teardown of an
			// abandoned generation, not an optimistic navigation mutation.
			resetBrowse();
		}

		const liveSocket = getSocket();
		socket = liveSocket;
		// Readiness precedes history or browse-store mutation. Apart from
		// preventing a doomed request, this keeps the outgoing semantic
		// snapshot intact for a later retry.
		if (!liveSocket?.connected) {
			if (isCurrentLibraryIntent(generation)) {
				libraryIntentBusy = false;
				reportRestoreStop('not connected to server');
			}
			return false;
		}

		// Once readiness is established, retire every visible live key before
		// re-seeding. A failed or disconnected restore may expose a safe empty
		// surface, never rows from the abandoned browse generation.
		if (!retireStaleRowsBeforeReadiness) resetBrowse();

		const { context, history } = state;
		const zoneId = $selectedZoneStore || undefined;
		let rootResolved = false;
		const role: ClassicBrowseRole =
			context.hierarchy === 'search' ? 'classic-search' : 'classic-browse';

		try {
			return await withClassicBrowseRoleTransaction(
				role,
				requireClassicSessionClaim(),
				async (transaction) => {
			let last = await transaction.browse({
				hierarchy: context.hierarchy,
				...(context.hierarchy === 'search' ? { input: context.query } : {}),
				zoneId,
				popAll: true
				}
			);
			rootResolved = true;
			if (!isCurrentLibraryIntent(generation)) return false;
			if (!getSocket()?.connected) {
				// The root may already have changed server-side. Never expose
				// rows whose keys now belong to an abandoned generation.
				resetBrowse();
				reportRestoreStop('connection changed during restore');
				return false;
			}

			const resolvedHistory: BrowseHistoryStep[] = [];
			let stopReason: string | undefined;
			for (const step of history) {
				if (!isCurrentLibraryIntent(generation)) return false;
				if (!getSocket()?.connected) {
					resetBrowse();
					reportRestoreStop('connection changed during restore');
					return false;
				}
				if (step.hierarchy !== context.hierarchy) {
					stopReason = 'navigation context changed';
					break;
				}
				const candidates = last.items.filter((candidate) =>
					breadcrumbMatches(candidate, step.breadcrumb)
				);
				const match = candidates.length === 1 ? candidates[0] : undefined;
				if (!match?.itemKey) {
					stopReason =
						candidates.length > 1
							? `"${step.breadcrumb.title}" is ambiguous`
							: `"${step.breadcrumb.title}" is no longer in results`;
					break;
				}

				try {
					const next = await transaction.browse({
						hierarchy: context.hierarchy,
						itemKey: match.itemKey,
						zoneId
					});
					if (!isCurrentLibraryIntent(generation)) return false;
					if (!getSocket()?.connected) {
						resetBrowse();
						reportRestoreStop('connection changed during restore');
						return false;
					}
					last = next;
					resolvedHistory.push(step);
				} catch (err) {
					stopReason = (err as Error).message;
					break;
				}
			}

			// A rejected drill may already have abandoned the coordinator
			// generation even before the component observes its phase change.
			// Never turn the last pre-failure page into a "safe truncation"
			// carrying keys from that retired session.
			if (
				!isCurrentLibraryIntent(generation) ||
				!isCurrentClassicSessionGeneration(sessionGeneration)
			) {
				throw new ClassicBrowseSupersededError();
			}

			const complete = resolvedHistory.length === history.length;
			let committed: ClassicHistorySnapshot;
			if (complete) {
				committed = state;
			} else if (
				preserveOnIncomplete &&
				semanticPathEquals(resolvedHistory, preserveOnIncomplete.history)
			) {
				// A failed Forward target has re-resolved the current page.
				// Keep the target in Forward so a retry remains possible.
				committed = preserveOnIncomplete;
			} else {
				// A path that no longer resolves is safely truncated to the
				// deepest exact semantic match. Forward from the obsolete path
				// cannot be trusted.
				committed = { context, history: resolvedHistory, forward: [] };
			}

			if (!replaceHistory(committed)) {
				throw new Error('resolved semantic history was invalid');
			}
			clearSearchResults();
			closeSearchPanel();
			if (context.hierarchy === 'search') setSearchLoading(context.query);
			setBrowseResult(last, context.hierarchy);
			if (!complete && stopReason) reportRestoreStop(stopReason);
			return complete;
			});
		} catch (err) {
			if (isCurrentLibraryIntent(generation)) {
				// If a fresh root was acquired, the outgoing row keys are no
				// longer actionable. An error surface is safer than republishing
				// the abandoned generation.
				if (rootResolved) resetBrowse();
				if (!(err instanceof ClassicBrowseSupersededError)) {
					setBrowseError(`Restore failed: ${(err as Error).message}`);
				}
			}
			return false;
		} finally {
			if (isCurrentLibraryIntent(generation)) libraryIntentBusy = false;
		}
	}

	const noop = () => {};

	// Keep nav store in sync with navigation state
	$effect(() => {
		browseNavStore.update((s) => ({
			...s,
			canBack:
				!libraryIntentBusy && !!$browseStore.current && $browseStore.current.level > 0,
			canForward: !libraryIntentBusy && $browseHistoryStore.forward.length > 0
		}));
	});

	// The shared shell and future Timeline fallbacks publish one-shot,
	// keyless Library intents. Claim synchronously so a remount cannot
	// replay an old request, then serialize resolution so two rapid clicks
	// cannot race the same Roon browse/search sessions.
	let libraryIntentResolution: Promise<void> = Promise.resolve();
	let libraryIntentGeneration = 0;
	let initialLibraryIntentSeen = false;
	let libraryIntentConsumerActive = $state(false);
	let trackMenuRequestGeneration = 0;
	let trackMenuRequestBarrier: Promise<void> = Promise.resolve();

	function isCurrentLibraryIntent(generation: number): boolean {
		return (
			classicLifecycleActive &&
			libraryIntentConsumerActive &&
			generation === libraryIntentGeneration
		);
	}

	function reportLibraryIntentFailure(err: unknown): void {
		pushCommandFeedback({
			source: 'browse',
			command: 'library-intent',
			message: `Couldn't open Library destination: ${(err as Error).message}`
		});
	}

	function beginNetworkLibraryIntent(generation: number): boolean {
		if (!isCurrentLibraryIntent(generation)) return false;
		if (!connectedForLibraryIntent()) {
			libraryIntentBusy = false;
			return false;
		}
		libraryIntentBusy = true;
		cancelTrackMenu();
		trackMenuBusy = false;
		resetRoot();
		return true;
	}

	function finishNetworkLibraryIntent(generation: number): void {
		if (isCurrentLibraryIntent(generation)) libraryIntentBusy = false;
	}

	function writeClassicPageState(mutation: 'push' | 'replace'): void {
		const state = buildClassicLibraryPageState(getClassicHistorySnapshot());
		if (mutation === 'push') {
			pushLibraryPageState(state);
		} else {
			replaceLibraryPageState(state);
		}
	}

	function enqueueLibraryIntent(
		intent: LibraryIntent,
		historyMutation: 'push' | 'replace'
	): void {
		initialLibraryIntentSeen = true;
		const menuBarrier = trackMenuRequestBarrier;
		cancelTrackMenu();
		trackMenuRequestGeneration += 1;
		const generation = ++libraryIntentGeneration;
		// Preserve the stable local welcome anchors when there is nothing
		// async to drain. An in-flight menu lookup is different: hide the
		// old actionable surface immediately while its session call settles.
		if (trackMenuBusy) libraryIntentBusy = true;
		libraryIntentResolution = Promise.all([libraryIntentResolution, menuBarrier])
			.then(async () => {
				if (!isCurrentLibraryIntent(generation)) return;
				trackMenuBusy = false;
				const before = getClassicHistorySnapshot();
				await resolveLibraryIntent(intent, generation);
				if (!isCurrentLibraryIntent(generation)) return;
				const after = getClassicHistorySnapshot();
				if (JSON.stringify(before) !== JSON.stringify(after)) {
					writeClassicPageState(historyMutation);
				}
			})
			.catch((err) => {
				if (isCurrentLibraryIntent(generation)) {
					libraryIntentBusy = false;
					trackMenuBusy = false;
					reportLibraryIntentFailure(err);
				}
			});
	}

	type PendingLibraryIntentClaim = 'claimed' | 'parked' | 'unavailable';

	function claimPendingClassicIntent(
		pending: PendingLibraryIntent
	): PendingLibraryIntentClaim {
		if ($libraryViewHostStore.transition?.fromMode === 'classic') return 'parked';
		const intent = claimLibraryIntent(pending.requestId);
		if (!intent) return 'unavailable';
		enqueueLibraryIntent(intent, pending.historyMutation);
		return 'claimed';
	}

	function scheduleInitialLibraryNavigation(): void {
		const pending = get(pendingLibraryIntentStore);
		if (pending && claimPendingClassicIntent(pending) !== 'unavailable') {
			return;
		}
		if (initialLibraryIntentSeen) return;

		const savedHistory = get(browseHistoryStore);
		const truncationHistoryPolicy =
			activationContext?.classicTruncationHistoryPolicy() ?? 'replace';
		// Start immediately, as Classic historically did, while retaining
		// the promise as the head of the intent chain. Any later intent is
		// appended and therefore deterministically wins after replay.
		const generation = ++libraryIntentGeneration;
		libraryIntentResolution = restoreBrowse(savedHistory, generation, undefined, true)
			.then(() => {
				if (
					isCurrentLibraryIntent(generation) &&
					truncationHistoryPolicy !== 'preserve' &&
					JSON.stringify(savedHistory) !== JSON.stringify(getClassicHistorySnapshot())
				) {
					writeClassicPageState('replace');
				}
			})
			.catch(reportLibraryIntentFailure);
	}

	$effect(() => {
		const pending = $pendingLibraryIntentStore;
		if (!classicLifecycleActive || !pending) return;
		const isLocalWelcomeIntent = pending.intent.destination === 'welcome-section';
		if (
			!isLocalWelcomeIntent &&
			(!libraryIntentConsumerActive || $classicBrowseSessionClient.phase !== 'live')
		) return;
		// Welcome anchors are entirely local UI state. They remain usable while
		// the Classic Roon lease is unavailable; keyed/network destinations stay
		// pending until a fresh live generation exists.
		if (isLocalWelcomeIntent) libraryIntentConsumerActive = true;
		claimPendingClassicIntent(pending);
	});

	function connectedForLibraryIntent(): boolean {
		const liveSocket = getSocket();
		socket = liveSocket;
		if (liveSocket?.connected) return true;
		pushCommandFeedback({
			source: 'browse',
			command: 'library-intent',
			message: 'Not connected to server'
		});
		return false;
	}

	async function resolveSearchIntent(query: string, generation: number): Promise<void> {
		if (!beginNetworkLibraryIntent(generation)) return;
		const zoneId = $selectedZoneStore || undefined;

		try {
			setSearchLoading(query);
			const results = await apiBrowseSearch(fetch, {
				input: query,
				zoneId,
				popAll: true
			}, requireClassicSessionClaim(), 'classic-search');
			if (!isCurrentLibraryIntent(generation)) return;
			if (!connectedForLibraryIntent()) {
				resetRoot();
				return;
			}
			resetHistory({ hierarchy: 'search', query });
			setSearchResults(results);
		} catch (error) {
			if (isCurrentLibraryIntent(generation)) {
				setSearchError((error as Error).message);
				pushCommandFeedback({
					source: 'browse',
					command: 'library-intent',
					message: `Couldn't search Library: ${(error as Error).message}`
				});
			}
		} finally {
			finishNetworkLibraryIntent(generation);
		}
	}

	async function resolveWelcomeSection(
		section: 'favorites' | 'recently-played',
		generation: number
	): Promise<void> {
		if (!isCurrentLibraryIntent(generation)) return;
		libraryIntentBusy = false;
		cancelTrackMenu();
		trackMenuBusy = false;
		// These are controller-owned local surfaces. They remain useful
		// while disconnected and never need a Roon key or live session.
		resetRoot();
		await tick();
		if (!isCurrentLibraryIntent(generation)) return;
		const targetId =
			section === 'favorites' ? 'favorites-section' : 'recently-played-section';
		const target = document.getElementById(targetId);
		if (!(target instanceof HTMLElement)) {
			pushCommandFeedback({
				source: 'browse',
				command: 'library-intent',
				message: `Couldn't open ${section === 'favorites' ? 'Favorites' : 'Recently Played'}.`
			});
			return;
		}
		target.focus({ preventScroll: true });
		target.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
	}

	type ResolvedExploreStep = {
		itemKey: string;
		label: string;
		subtitle?: string;
		imageKey?: string;
		itemType?: string;
	};

	function commitExploreResolution(
		result: BrowseResult,
		steps: readonly ResolvedExploreStep[],
		_zoneId: string | undefined
	): void {
		clearSearchResults();
		closeSearchPanel();
		const context: BrowseHistoryContext = { hierarchy: 'browse' };
		resetHistory(context);
		for (const step of steps) {
			pushHistory(
				context,
				{
					title: step.label,
					subtitle: step.subtitle,
					imageKey: step.imageKey,
					itemType: step.itemType
				}
			);
		}
		setBrowseResult(result, 'browse');
	}

	async function resolveExplorePath(
		labelPath: readonly string[],
		generation: number
	): Promise<void> {
		if (!beginNetworkLibraryIntent(generation)) return;
		const sessionGeneration = captureLiveClassicSessionGeneration();
		if (sessionGeneration === null) {
			resetRoot();
			finishNetworkLibraryIntent(generation);
			return;
		}
		const zoneId = $selectedZoneStore || undefined;

		let current: BrowseResult | null = null;
		const resolved: ResolvedExploreStep[] = [];
		try {
			await withClassicBrowseRoleTransaction(
				'classic-browse',
				requireClassicSessionClaim(),
				async (transaction) => {
			current = await transaction.browse({
				hierarchy: 'browse',
				zoneId,
				popAll: true
				}
			);
			if (!isCurrentLibraryIntent(generation)) return;
			if (!connectedForLibraryIntent()) {
				resetRoot();
				return;
			}

			for (const label of labelPath) {
				if (!isCurrentLibraryIntent(generation)) return;
				if (!connectedForLibraryIntent()) {
					resetRoot();
					return;
				}
				const matches = current.items.filter(
					(item) => item.title === label && Boolean(item.itemKey)
				);
				if (matches.length !== 1) {
					commitExploreResolution(current, resolved, zoneId);
					pushCommandFeedback({
						source: 'browse',
						command: 'library-intent',
						message:
							matches.length === 0
								? `Couldn't open Explore path: "${label}" is no longer available.`
								: `Couldn't open Explore path: "${label}" is ambiguous.`
					});
					return;
				}

				const match = matches[0];
				const next = await transaction.browse({
					hierarchy: 'browse',
					zoneId,
					itemKey: match.itemKey
				});
				if (!isCurrentLibraryIntent(generation)) return;
				if (!connectedForLibraryIntent()) {
					resetRoot();
					return;
				}
				resolved.push({
					itemKey: match.itemKey!,
					label,
					subtitle: match.subtitle,
					imageKey: match.imageKey,
					itemType: match.itemType
				});
				current = next;
			}

			if (!isCurrentLibraryIntent(generation)) return;
			commitExploreResolution(current, resolved, zoneId);
			});
		} catch (err) {
			if (!isCurrentLibraryIntent(generation)) return;
			// Once a coordinated browse walk has begun, its server-side session may have
			// re-rooted even when a later call fails. Publish only the last
			// known-fresh surface; if no response arrived, fall back to the
			// keyless welcome view rather than retaining actionable stale rows.
			if (current && isCurrentClassicSessionGeneration(sessionGeneration)) {
				commitExploreResolution(current, resolved, zoneId);
			} else {
				resetRoot();
			}
			pushCommandFeedback({
				source: 'browse',
				command: 'library-intent',
				message: `Couldn't open Explore path: ${(err as Error).message}`
			});
		} finally {
			finishNetworkLibraryIntent(generation);
		}
	}

	function commitSearchCategorySurface(results: SearchResult[], query: string): void {
		resetHistory({ hierarchy: 'search', query });
		resetBrowse();
		setSearchLoading(query);
		setSearchResults(results);
	}

	async function resolveSearchCategoryIntent(
		query: string,
		categoryTitle: string,
		generation: number
	): Promise<void> {
		if (!beginNetworkLibraryIntent(generation)) return;
		const sessionGeneration = captureLiveClassicSessionGeneration();
		if (sessionGeneration === null) {
			resetRoot();
			finishNetworkLibraryIntent(generation);
			return;
		}
		const zoneId = $selectedZoneStore || undefined;

		let groupedResults: SearchResult[] | null = null;
		try {
			await withClassicBrowseRoleTransaction(
				'classic-search',
				requireClassicSessionClaim(),
				async (transaction) => {
			groupedResults = await transaction.browseSearch({
				input: query,
				zoneId,
				popAll: true
				}
			);
			if (!isCurrentLibraryIntent(generation)) return;
			if (!connectedForLibraryIntent()) {
				resetRoot();
				return;
			}

			const freshRoot = await transaction.browse({
				hierarchy: 'search',
				input: query,
				zoneId,
				popAll: true
			});
			if (!isCurrentLibraryIntent(generation)) return;
			if (!connectedForLibraryIntent()) {
				resetRoot();
				return;
			}

			const matches = freshRoot.items.filter(
				(item) =>
					Boolean(item.itemKey) &&
					item.hint === 'list' &&
					item.title === categoryTitle &&
					isCategoryResultsSubtitle(item.subtitle)
			);
			if (matches.length !== 1) {
				commitSearchCategorySurface(groupedResults, query);
				pushCommandFeedback({
					source: 'browse',
					command: 'library-intent',
					message:
						matches.length === 0
							? `Search category is no longer available: ${categoryTitle}`
							: `Search category is ambiguous: ${categoryTitle}`
				});
				return;
			}

			if (!connectedForLibraryIntent()) {
				resetRoot();
				return;
			}
			const stub = matches[0];
			const result = await transaction.browse({
				hierarchy: 'search',
				itemKey: stub.itemKey,
				zoneId
			});
			if (!isCurrentLibraryIntent(generation)) return;
			if (!connectedForLibraryIntent()) {
				resetRoot();
				return;
			}

			commitSearchCategorySurface(groupedResults, query);
			pushHistory(
				{ hierarchy: 'search', query },
				{ title: categoryTitle, searchCategory: true }
			);
			setBrowseResult(result, 'search');
			});
		} catch (err) {
			if (!isCurrentLibraryIntent(generation)) return;
			if (groupedResults && isCurrentClassicSessionGeneration(sessionGeneration)) {
				commitSearchCategorySurface(groupedResults, query);
			} else {
				resetRoot();
			}
			pushCommandFeedback({
				source: 'browse',
				command: 'library-intent',
				message: `Couldn't open search category: ${(err as Error).message}`
			});
		} finally {
			finishNetworkLibraryIntent(generation);
		}
	}

	async function resolveLibraryIntent(intent: LibraryIntent, generation: number): Promise<void> {
		if (intent.destination === 'search') {
			await resolveSearchIntent(intent.query, generation);
			return;
		}
		switch (intent.destination) {
			case 'welcome-section':
				await resolveWelcomeSection(intent.section, generation);
				return;
			case 'explore-path':
				await resolveExplorePath(intent.labelPath, generation);
				return;
			case 'search-category':
				await resolveSearchCategoryIntent(intent.query, intent.categoryTitle, generation);
				return;
		}
	}

	function activeBrowseRole(hierarchy = $browseStore.hierarchy): ClassicBrowseRole {
		return hierarchy === 'search' ? 'classic-search' : 'classic-browse';
	}

	function reportClassicBrowseError(error: unknown): void {
		if (error instanceof ClassicBrowseSupersededError) {
			clearBrowseLoading();
			return;
		}
		setBrowseError((error as Error).message);
	}

	function makeBreadcrumb(item: BrowseItem): BrowseBreadcrumb | undefined {
		// Capture only stable, content-keyed fields. itemKey is intentionally
		// excluded — search itemKeys mint fresh on each search re-seed, which
		// is exactly the staleness this breadcrumb is meant to recover from.
		if (!item.title?.trim()) return undefined;
		return {
			title: item.title,
			...(item.subtitle?.trim() ? { subtitle: item.subtitle } : {}),
			...(item.imageKey?.trim() ? { imageKey: item.imageKey } : {}),
			...(item.itemType?.trim() ? { itemType: item.itemType } : {})
		};
	}

	function historyContextFor(hierarchy: string | undefined): BrowseHistoryContext | undefined {
		if (hierarchy !== 'search') return { hierarchy: 'browse' };
		const query = $browseStore.lastSearchQuery?.trim();
		return query ? { hierarchy: 'search', query } : undefined;
	}

	function browse(
		options: ClassicBrowseOptions,
		opts: { recordHistory?: boolean; breadcrumb?: BrowseBreadcrumb } = {}
	) {
		if (libraryIntentBusy || !classicLifecycleActive || trackMenu || trackMenuBusy) return;
		const scopedOptions: ClassicBrowseOptions = {
			...options,
			zoneId: options.zoneId ?? ($selectedZoneStore || undefined)
		};

		// Check the socket BEFORE mutating any state. setBrowseLoading
		// would switch the store's hierarchy field optimistically —
		// safe for same-hierarchy clicks, but for cross-hierarchy
		// navigation (e.g. browse → search via search-result click)
		// a failed emit would leave the store with hierarchy='search'
		// over the prior browse result. Subsequent clicks would then
		// re-emit browse-session itemKeys against the search session
		// and 500. Doing the readiness check first means a
		// disconnected click leaves page state exactly as it was.
		const liveSocket = socket ?? getSocket();
		socket = liveSocket;
		if (!liveSocket) {
			setBrowseError('Realtime connection is unavailable.');
			return;
		}
		if (!liveSocket.connected) {
			pushCommandFeedback({
				source: 'browse',
				command: 'browse:browse',
				message: 'Not connected to server'
			});
			return;
		}

		const lifecycleGeneration = classicLifecycleGeneration;
		const requestGeneration = ++browseRequestGeneration;
		const role = activeBrowseRole(scopedOptions.hierarchy);
		// Past the readiness check — safe to show an in-flight surface.
		setBrowseLoading(scopedOptions.hierarchy ?? 'browse');
		void apiBrowse(fetch, scopedOptions, requireClassicSessionClaim(), role)
			.then((result) => {
				if (
					!isCurrentClassicLifecycle(lifecycleGeneration) ||
					requestGeneration !== browseRequestGeneration
				) return;
				if (opts.recordHistory) {
					// Only semantic metadata crosses the durable boundary. A row
					// without a stable title or a search step without its originating
					// query remains usable now but is deliberately not restorable.
					const context = historyContextFor(scopedOptions.hierarchy);
					if (context && opts.breadcrumb && pushHistory(context, opts.breadcrumb)) {
						writeClassicPageState('push');
					}
				}
				setBrowseResult(result, scopedOptions.hierarchy);
			})
			.catch((error) => {
				if (
					isCurrentClassicLifecycle(lifecycleGeneration) &&
					requestGeneration === browseRequestGeneration
				) reportClassicBrowseError(error);
			});
	}

	function pop() {
		if (libraryIntentBusy || !classicLifecycleActive || trackMenu || trackMenuBusy) return;
		// Same readiness-check-first pattern as browse(): check the
		// socket BEFORE any state mutation so a disconnected Back
		// click doesn't leave history mutated or loading stuck.
		const liveSocket = socket ?? getSocket();
		socket = liveSocket;
		if (!liveSocket) {
			setBrowseError('Realtime connection is unavailable.');
			return;
		}
		if (!liveSocket.connected) {
			pushCommandFeedback({
				source: 'browse',
				command: 'browse:pop',
				message: 'Not connected to server'
			});
			return;
		}

		const options: ClassicBrowsePopOptions = {
			hierarchy: $browseStore.hierarchy,
			zoneId: $selectedZoneStore || undefined
		};
		const lifecycleGeneration = classicLifecycleGeneration;
		const requestGeneration = ++browseRequestGeneration;
		setBrowseLoading(options.hierarchy);
		void apiBrowsePop(
			fetch,
			options,
			requireClassicSessionClaim(),
			activeBrowseRole(options.hierarchy)
		)
			.then((result) => {
				if (
					!isCurrentClassicLifecycle(lifecycleGeneration) ||
					requestGeneration !== browseRequestGeneration
				) return;
				const popped = popHistory();
				if (popped) writeClassicPageState('push');
				setBrowseResult(result, options.hierarchy);
			})
			.catch((error) => {
				if (
					isCurrentClassicLifecycle(lifecycleGeneration) &&
					requestGeneration === browseRequestGeneration
				) reportClassicBrowseError(error);
			});
	}

	function forward() {
		if (libraryIntentBusy) return;
		// Readiness check BEFORE any history mutation. Forward is semantic:
		// it re-roots and resolves the target path instead of emitting a key
		// captured by an earlier Roon session.
		const liveSocket = socket ?? getSocket();
		socket = liveSocket;
		if (!liveSocket) {
			setBrowseError('Realtime connection is unavailable.');
			return;
		}
		if (!liveSocket.connected) {
			pushCommandFeedback({
				source: 'browse',
				command: 'browse:browse',
				message: 'Not connected to server'
			});
			return;
		}

		const current = getClassicHistorySnapshot();
		const next = current.forward[current.forward.length - 1];
		if (!next) return;
		const target: ClassicHistorySnapshot = {
			context: current.context,
			history: [...current.history, next],
			forward: current.forward.slice(0, -1)
		};
		const menuBarrier = trackMenuRequestBarrier;
		cancelTrackMenu();
		trackMenuRequestGeneration += 1;
		const generation = ++libraryIntentGeneration;
		libraryIntentBusy = true;
		libraryIntentResolution = Promise.all([libraryIntentResolution, menuBarrier])
			.then(() => restoreBrowse(target, generation, current))
			.then((restored) => {
				if (restored) writeClassicPageState('push');
			})
			.catch(reportLibraryIntentFailure);
	}

	function resetRoot(pushEntry = false) {
		cancelTrackMenu();
		trackMenuRequestGeneration += 1;
		browseRequestGeneration += 1;
		// Home returns to the welcome view, not the Roon browse root.
		// The browse root would just mirror the Explore rail (Library /
		// Playlists / Genres / etc.) which is already in the sidebar.
		const before = getClassicHistorySnapshot();
		resetHistory({ hierarchy: 'browse' });
		resetBrowse();
		if (
			pushEntry &&
			JSON.stringify(before) !== JSON.stringify(getClassicHistorySnapshot())
		) {
			writeClassicPageState('push');
		}
	}

	/**
	 * Load the next page of items at the current level. Used by the
	 * "Load more" / "Load all" buttons and the alphabetic jump bar fast-path.
	 */
	async function loadMore(opts: { all?: boolean } = {}): Promise<void> {
		const current = $browseStore.current;
		if (
			!current ||
			loadMoreInFlight ||
			!classicLifecycleActive ||
			trackMenu ||
			trackMenuBusy
		) return;
		const total = current.totalCount ?? current.count;
		const loaded = current.items.length;
		if (loaded >= total) return;

		loadMoreInFlight = true;
		const lifecycleGeneration = classicLifecycleGeneration;
		const requestGeneration = browseRequestGeneration;
		try {
			const remaining = total - loaded;
			const count = opts.all ? remaining : Math.min(100, remaining);
			const next = await apiBrowseLoad(fetch, {
				hierarchy: $browseStore.hierarchy,
				zoneId: $selectedZoneStore || undefined,
				offset: loaded,
				count
			}, requireClassicSessionClaim(), activeBrowseRole());
			if (
				!isCurrentClassicLifecycle(lifecycleGeneration) ||
				requestGeneration !== browseRequestGeneration
			) return;
			appendBrowseItems(next.items);
		} catch (err) {
			if (
				isCurrentClassicLifecycle(lifecycleGeneration) &&
				requestGeneration === browseRequestGeneration &&
				!(err instanceof ClassicBrowseSupersededError)
			) pushCommandFeedback({
				source: 'browse',
				command: 'browse:load',
				message: `Load failed: ${(err as Error).message}`
			});
		} finally {
			if (isCurrentClassicLifecycle(lifecycleGeneration)) loadMoreInFlight = false;
		}
	}

	/** Navigate into a list item (hierarchy drill-down). */
	function navigate(item: BrowseItem) {
		if (!item.itemKey) return;
		const opts: ClassicBrowseOptions = {
			hierarchy: $browseStore.hierarchy,
			itemKey: item.itemKey,
			zoneId: $selectedZoneStore || undefined
		};
		browse(opts, { recordHistory: true, breadcrumb: makeBreadcrumb(item) });
	}

	// ── Track ⋮ inline action menu (BUGS.md #3) ─────────────────────
	//
	// The old behavior browsed into the track's action list as a full
	// page transition. Now the action list is fetched in a claim-scoped
	// Classic transaction (so
	// the visible browse result never changes) and rendered as a small
	// popup. While the menu is open the Roon session sits one level
	// deep (at the action list); choosing an action drills one more
	// level, so the stack is restored with a 2-level pop after an
	// action and a 1-level pop on dismiss — the same depth bookkeeping
	// quickPlay uses. Pops only apply in the main browse hierarchy;
	// the search session re-seeds (popAll) on every use.
	/**
	 * The open ⋮ menu, carrying the Roon session context its item and
	 * action keys belong to. `origin: 'pane'` menus (browse track
	 * lists) restore the session by popping after use; `'search-panel'`
	 * menus never pop — the shared search session is re-seeded with
	 * popAll by every search interaction, and the browse pane's session
	 * was never touched.
	 */
	let trackMenu = $state<{
		item: BrowseItem;
		actions: BrowseItem[];
		hierarchy: string;
		role: ClassicBrowseRole;
		origin: 'pane' | 'search-panel';
		decide: (action: BrowseItem | null) => void;
	} | null>(null);
	let trackMenuBusy = $state(false);

	function cancelTrackMenu(): void {
		const menu = trackMenu;
		trackMenu = null;
		menu?.decide(null);
	}

	function waitForTrackMenuDecision(
		menu: Omit<NonNullable<typeof trackMenu>, 'decide'>
	): Promise<BrowseItem | null> {
		return new Promise((resolve) => {
			let settled = false;
			const decide = (action: BrowseItem | null) => {
				if (settled) return;
				settled = true;
				resolve(action);
			};
			trackMenu = { ...menu, decide };
			trackMenuBusy = false;
		});
	}

	function beginTrackMenuRequest(): { generation: number; settle: () => void } {
		const generation = ++trackMenuRequestGeneration;
		let settle!: () => void;
		trackMenuRequestBarrier = new Promise<void>((resolve) => {
			settle = resolve;
		});
		return { generation, settle };
	}

	function isCurrentTrackMenuRequest(generation: number): boolean {
		return (
			classicLifecycleActive &&
			generation === trackMenuRequestGeneration
		);
	}

	async function openTrackMenu(item: BrowseItem) {
		if (!item.itemKey || trackMenu || trackMenuBusy) return;
		const request = beginTrackMenuRequest();
		trackMenuBusy = true;
		try {
			const hierarchy = $browseStore.hierarchy;
			const role = activeBrowseRole(hierarchy);
			await withClassicBrowseRoleTransaction(
				role,
				requireClassicSessionClaim(),
				async (transaction) => {
				const actionResult = await transaction.browse({
					hierarchy,
					itemKey: item.itemKey,
					zoneId: $selectedZoneStore || undefined
				});
				if (!isCurrentTrackMenuRequest(request.generation)) return;
				const actions = actionResult.items.filter(
					(i) => i.itemKey && (i.isPlayable || i.hint === 'action')
				);
				if (actions.length === 0) {
					await transaction.browsePop({
						hierarchy,
						zoneId: $selectedZoneStore || undefined,
						levels: 1
					});
					if (isCurrentTrackMenuRequest(request.generation)) {
						pushCommandFeedback({
							source: 'browse',
							command: 'track-menu',
							message: `No actions available for "${trackTitle(item.title)}".`
						});
					}
					return;
				}
				const action = await waitForTrackMenuDecision({
					item,
					actions,
					hierarchy,
					role,
					origin: 'pane'
				});
				if (!isCurrentTrackMenuRequest(request.generation)) return;
				trackMenu = null;
				trackMenuBusy = true;
				if (action?.itemKey) {
					const zoneId = $selectedZoneStore || undefined;
					if (!zoneId) return;
					await transaction.browse({ hierarchy, itemKey: action.itemKey, zoneId });
					await transaction.browsePop({ hierarchy, zoneId, levels: 2 });
					if (isCurrentTrackMenuRequest(request.generation)) {
						pushCommandFeedback({
							source: 'browse',
							command: 'track-menu',
							kind: 'success',
							message: `${action.title} — ${trackTitle(item.title)}`
						});
					}
				} else {
					await transaction.browsePop({
						hierarchy,
						zoneId: $selectedZoneStore || undefined,
						levels: 1
					});
				}
				}
			);
		} catch (err) {
			if (isCurrentTrackMenuRequest(request.generation)) {
				if (err instanceof ClassicBrowseSupersededError) return;
				pushCommandFeedback({
					source: 'browse',
					command: 'track-menu',
					message: `Couldn't load actions: ${(err as Error).message}`
				});
			}
		} finally {
			if (isCurrentTrackMenuRequest(request.generation)) {
				trackMenu = null;
				trackMenuBusy = false;
			}
			request.settle();
		}
	}

	/**
	 * ⋮ on a search-result track row. Search rows live in a stale
	 * side-session, so the item is freshened first (re-seeding the
	 * shared search session — every search interaction does), then
	 * drilled in the same claim-scoped transaction. Roon's search hierarchy
	 * sometimes nests the action list one level deeper than browse
	 * (see quickPlay), so lone action_list rows are followed a bounded
	 * number of hops. No pops afterwards: the next search interaction
	 * re-seeds with popAll, and the browse pane's session was never
	 * touched.
	 */
	async function openSearchTrackMenu(result: SearchResult) {
		if (trackMenu || trackMenuBusy) return;
		const request = beginTrackMenuRequest();
		trackMenuBusy = true;
		try {
			const requestIsCurrent = () => isCurrentTrackMenuRequest(request.generation);
			await withClassicBrowseRoleTransaction(
				'classic-search',
				requireClassicSessionClaim(),
				async (transaction) => {
					const target = await freshenSearchItem(
						result,
						requestIsCurrent,
						transaction
					);
					if (!requestIsCurrent()) throw new ClassicBrowseSupersededError();
					let actionResult = await transaction.browse({
						hierarchy: 'search',
						itemKey: target.itemKey,
						zoneId: $selectedZoneStore || undefined
					});
					const filterPlayable = (items: BrowseItem[]) =>
						items.filter((i) => i.itemKey && (i.isPlayable || i.hint === 'action'));
					let actions = filterPlayable(actionResult.items);
					for (let hop = 0; hop < 2 && actions.length === 0; hop++) {
						const nested = actionResult.items.filter(
							(i) => i.itemKey && i.hint === 'action_list'
						);
						if (nested.length !== 1) break;
						actionResult = await transaction.browse({
							hierarchy: 'search',
							itemKey: nested[0].itemKey,
							zoneId: $selectedZoneStore || undefined
						});
						if (!requestIsCurrent()) throw new ClassicBrowseSupersededError();
						actions = filterPlayable(actionResult.items);
					}
					if (actions.length === 0) {
						if (requestIsCurrent()) {
							pushCommandFeedback({
								source: 'browse',
								command: 'track-menu',
								message: `No actions available for "${trackTitle(result.title)}".`
							});
						}
						await resetSearchSession(transaction);
						return;
					}
					const action = await waitForTrackMenuDecision({
						item: target,
						actions,
						hierarchy: 'search',
						role: 'classic-search',
						origin: 'search-panel'
					});
					if (!requestIsCurrent()) return;
					trackMenu = null;
					trackMenuBusy = true;
					if (action?.itemKey) {
						const zoneId = $selectedZoneStore || undefined;
						if (zoneId) {
							await transaction.browse({
								hierarchy: 'search',
								itemKey: action.itemKey,
								zoneId
							});
							if (requestIsCurrent()) {
								pushCommandFeedback({
									source: 'browse',
									command: 'track-menu',
									kind: 'success',
									message: `${action.title} — ${trackTitle(target.title)}`
								});
							}
						}
					}
					await resetSearchSession(transaction);
				}
			);
		} catch (err) {
			if (isCurrentTrackMenuRequest(request.generation)) {
				if (err instanceof ClassicBrowseSupersededError) return;
				pushCommandFeedback({
					source: 'browse',
					command: 'track-menu',
					message: `Couldn't load actions: ${(err as Error).message}`
				});
			}
		} finally {
			if (isCurrentTrackMenuRequest(request.generation)) {
				trackMenu = null;
				trackMenuBusy = false;
			}
			request.settle();
		}
	}

	function runTrackMenuAction(action: BrowseItem) {
		const menu = trackMenu;
		if (!menu || !action.itemKey || trackMenuBusy) return;
		const zoneId = $selectedZoneStore || undefined;
		if (!zoneId) {
			pushCommandFeedback({
				source: 'browse',
				command: 'track-menu',
				message: 'Select a zone to play.'
			});
			return;
		}
		trackMenuBusy = true;
		menu.decide(action);
	}

	function closeTrackMenu() {
		cancelTrackMenu();
	}

	function handleSearchResultClick(result: SearchResult) {
		if (result.resultType === 'track' && result.hint === 'action_list') {
			void quickPlay(result, {
				hierarchy: 'search',
				role: 'classic-search',
				resetSearch: true
			});
		} else {
			void navigateSearchResult(result);
		}
	}

	function handleSeeAllCategory(categoryTitle: string) {
		const query = $browseStore.lastSearchQuery?.trim();
		if (!query) {
			pushCommandFeedback({
				source: 'browse',
				command: 'library-intent',
				message: `Couldn't open search category: the originating query is unavailable.`
			});
			return;
		}
		publishLibraryIntent({
			kind: 'general',
			destination: 'search-category',
			query,
			categoryTitle
		}, 'push');
	}

	function submitClassicSearch(rawQuery: string): Promise<void> {
		if (libraryIntentBusy || trackMenu || trackMenuBusy) return Promise.resolve();
		const query = rawQuery.trim();
		if (!query) return Promise.resolve();
		const pending = publishLibraryIntent(
			{ kind: 'general', destination: 'search', query },
			'push'
		);
		if (
			pending &&
			classicLifecycleActive &&
			libraryIntentConsumerActive &&
			get(classicBrowseSessionClient).phase === 'live'
		) {
			scheduleInitialLibraryNavigation();
		}
		return libraryIntentResolution;
	}

	/** Search for an artist by name (from album subtitle). */
	function searchArtist(name: string): Promise<void> {
		return submitClassicSearch(name);
	}

	async function resetSearchSession(
		transaction?: ClassicBrowseApiTransaction
	): Promise<BrowseResult | null> {
		const query = $browseStore.lastSearchQuery;
		if (!query) return null;

		const options: ClassicBrowseOptions = {
			hierarchy: 'search',
			input: query,
			zoneId: $selectedZoneStore || undefined,
			popAll: true
		};
		return transaction
			? transaction.browse(options)
			: apiBrowse(fetch, options, requireClassicSessionClaim(), 'classic-search');
	}

	function optionalFieldMatches(left?: string, right?: string): boolean {
		return !left || !right || left === right;
	}

	function semanticType(item: BrowseItem): string | undefined {
		const resultType = (item as BrowseItem & { resultType?: SearchResult['resultType'] }).resultType;
		return item.itemType ?? (resultType && resultType !== 'unknown' ? resultType : undefined);
	}

	function searchItemMatches(candidate: BrowseItem, original: BrowseItem): boolean {
		if (candidate.title !== original.title) return false;
		if (!optionalFieldMatches(candidate.subtitle, original.subtitle)) return false;
		if (!optionalFieldMatches(candidate.hint, original.hint)) return false;
		if (!optionalFieldMatches(candidate.imageKey, original.imageKey)) return false;
		if (!optionalFieldMatches(semanticType(candidate), semanticType(original))) return false;
		return true;
	}

	/**
	 * A search-top-level category stub ("Albums — 3 Results") whose
	 * title maps to the item's resultType via the SHARED token mapping
	 * (rev-6: the server maps "Stations" to 'radio'; a singularize
	 * heuristic here produced 'station' and made radio results
	 * impossible to freshen). Mirrors the server-side detection in
	 * BrowseService.isSearchCategory.
	 */
	function matchingCategoryRow(items: BrowseItem[], item: BrowseItem): BrowseItem | undefined {
		const resultType = (item as BrowseItem & { resultType?: SearchResult['resultType'] })
			.resultType;
		if (!resultType || resultType === 'unknown') return undefined;
		return items.find(
			(c) =>
				!!c.itemKey &&
				c.hint === 'list' &&
				isCategoryResultsSubtitle(c.subtitle) &&
				searchTypeForToken(c.title) === resultType
		);
	}

	/**
	 * Count the fields a candidate CONCRETELY shares with the clicked
	 * item (both present and equal — wildcard matches score nothing).
	 */
	function concreteMatchScore(candidate: BrowseItem, item: BrowseItem): number {
		let score = 0;
		if (candidate.subtitle && item.subtitle && candidate.subtitle === item.subtitle) score++;
		if (candidate.imageKey && item.imageKey && candidate.imageKey === item.imageKey) score++;
		if (candidate.hint && item.hint && candidate.hint === item.hint) score++;
		const ct = semanticType(candidate);
		const it = semanticType(item);
		if (ct && it && ct === it) score++;
		return score;
	}

	async function freshenSearchItem(
		item: BrowseItem,
		isActive: () => boolean = () => true,
		transaction?: ClassicBrowseApiTransaction
	): Promise<BrowseItem> {
		const freshSearch = await resetSearchSession(transaction);
		if (!isActive()) throw new Error('Search interaction was superseded.');
		if (!freshSearch) return item;

		// Tolerant matching accepts missing fields as wildcards, so with
		// duplicate titles a metadata-sparse row earlier in the list could
		// shadow the exact row the user clicked (rev-5). Among tolerant
		// matches, prefer the one that concretely agrees on the most
		// fields; first-wins only breaks genuine ties.
		const matchIn = (items: BrowseItem[]) => {
			const candidates = items.filter(
				(candidate) => candidate.itemKey && searchItemMatches(candidate, item)
			);
			if (candidates.length <= 1) return candidates[0];
			return candidates.reduce((best, candidate) =>
				concreteMatchScore(candidate, item) > concreteMatchScore(best, item)
					? candidate
					: best
			);
		};

		let freshItem = matchIn(freshSearch.items);

		// Server-expanded category results don't exist at the fresh top
		// level — only their category stub does. Drill the stub matching
		// the item's type and look inside. The drill leaves the session a
		// level deep; fine, every search interaction re-seeds with popAll.
		if (!freshItem) {
			const category = matchingCategoryRow(freshSearch.items, item);
			if (category?.itemKey) {
				const options: ClassicBrowseOptions = {
					hierarchy: 'search',
					itemKey: category.itemKey,
					zoneId: $selectedZoneStore || undefined
				};
				const page = transaction
					? await transaction.browse(options)
					: await apiBrowse(
							fetch,
							options,
							requireClassicSessionClaim(),
							'classic-search'
						);
				if (!isActive()) throw new Error('Search interaction was superseded.');
				freshItem = matchIn(page.items);
			}
		}

		if (!freshItem?.itemKey) {
			throw new Error(`Search result is no longer available: ${item.title}`);
		}
		return { ...item, itemKey: freshItem.itemKey };
	}

	async function navigateSearchResult(result: SearchResult): Promise<void> {
		const lifecycleGeneration = classicLifecycleGeneration;
		if (!isCurrentClassicLifecycle(lifecycleGeneration)) return;
		const searchQuery = $browseStore.lastSearchQuery?.trim();
		if (!searchQuery) {
			pushCommandFeedback({
				source: 'browse',
				command: 'search-result',
				message: 'Search result is missing its originating query.'
			});
			return;
		}

		// Readiness check BEFORE the coordinated freshen (same hardening as
		// navigateSearchCategory, rev-4 round 2): freshenSearchItem
		// re-roots the coordinator-owned search generation, so bailing only
		// afterwards could leave every rendered row's item key stale.
		let liveSocket = socket ?? getSocket();
		socket = liveSocket;
		if (!liveSocket?.connected) {
			pushCommandFeedback({
				source: 'browse',
				command: 'browse:browse',
				message: 'Not connected to server'
			});
			return;
		}

		// Show loading without switching hierarchy yet — the hierarchy
		// commit is the irreversible part. We defer it until after the
		// connection readiness re-check below, so a disconnected click
		// doesn't leave the store with hierarchy='search' over a stale
		// browse result.
		setBrowseLoading();
		try {
			await withClassicBrowseRoleTransaction(
				'classic-search',
				requireClassicSessionClaim(),
				async (transaction) => {
					const target = await freshenSearchItem(
						result,
						() => isCurrentClassicLifecycle(lifecycleGeneration),
						transaction
					);
					if (!isCurrentClassicLifecycle(lifecycleGeneration)) {
						throw new ClassicBrowseSupersededError();
					}
					const page = await transaction.browse({
						hierarchy: 'search',
						itemKey: target.itemKey,
						zoneId: $selectedZoneStore || undefined
					});
					if (!isCurrentClassicLifecycle(lifecycleGeneration)) {
						throw new ClassicBrowseSupersededError();
					}
					const currentSocket = socket ?? getSocket();
					socket = currentSocket;
					if (!currentSocket?.connected) throw new ClassicBrowseSupersededError();
					resetHistory({ hierarchy: 'search', query: searchQuery });
					const breadcrumb = makeBreadcrumb(target);
					if (
						breadcrumb &&
						pushHistory({ hierarchy: 'search', query: searchQuery }, breadcrumb)
					) writeClassicPageState('push');
					setBrowseResult(page, 'search');
				}
			);
			if (!isCurrentClassicLifecycle(lifecycleGeneration)) return;
		} catch (err) {
			if (!isCurrentClassicLifecycle(lifecycleGeneration)) return;
			if (err instanceof ClassicBrowseSupersededError) {
				// The transaction can observe a disconnected socket before the
				// component's disconnect listener resets the browse store.
				clearBrowseLoading();
				return;
			}
			setBrowseError(`Browse failed: ${(err as Error).message}`);
			pushCommandFeedback({
				source: 'browse',
				command: 'search-result',
				message: `Browse failed: ${(err as Error).message}`
			});
		}
	}

	/**
	 * Immediately play a track-level item without navigating into its action menu.
	 * Uses the coordinator's semantic role so main navigation is undisturbed.
	 * Flow: browse(itemKey) → find first action ("Play Now") → browse(actionKey) → plays.
	 */
	async function quickPlay(
		item: BrowseItem,
		options: {
			hierarchy?: string;
			role?: ClassicBrowseRole;
			transaction?: ClassicBrowseApiTransaction;
			resetSearch?: boolean;
			// When true, a missing play action produces a feedback toast
			// instead of falling back to an action-menu browse. The
			// fallback browse pushes history with the current
			// $browseStore.lastSearchQuery, which for a Recently Played
			// click is the user's prior visible search — not the title
			// we just seeded. Recording history under the wrong query
			// would let restore re-seed the wrong search session.
			playOnly?: boolean;
			// Lowercased action titles to prefer, in order, over the
			// first playable action. The track-list ▶ passes
			// ['play from here'] so an album/playlist click continues
			// to the end of the list (BUGS.md #6); flows that want a
			// single-track play (search, Recently Played) omit it.
			preferActionTitles?: string[];
		} = {}
	) {
		if (trackMenu || trackMenuBusy) return;
		if (!item.itemKey && !options.resetSearch) return;
		const lifecycleGeneration = classicLifecycleGeneration;
		if (!isCurrentClassicLifecycle(lifecycleGeneration)) return;
		const sessionGeneration = captureLiveClassicSessionGeneration();
		if (sessionGeneration === null) {
			if (getSocket()?.connected) {
				resetRoot();
			} else {
				pushCommandFeedback({
					source: 'browse',
					command: 'play',
					message: 'Not connected to server'
				});
			}
			return;
		}

		const zoneId = $selectedZoneStore || undefined;
		if (!zoneId) {
			pushCommandFeedback({ source: 'browse', command: 'play', message: 'Select a zone to play.' });
			return;
		}

		const hierarchyAtStart = options.hierarchy ?? $browseStore.hierarchy;
		const role = options.role ?? activeBrowseRole(hierarchyAtStart);
		quickPlayInFlight = true;
		try {
			const execute = async (transaction: ClassicBrowseApiTransaction) => {
			let target = item;
			if (options.resetSearch) {
				target = await freshenSearchItem(
					item,
					() => isCurrentClassicLifecycle(lifecycleGeneration),
					transaction
				);
			}
			if (!isCurrentClassicLifecycle(lifecycleGeneration) || !target.itemKey) return;

			// Browse into the track to get its action list (Play Now, Play Next, etc.).
			// The claim-scoped transaction keeps intermediate action-list state private.
			let actionResult = await transaction.browse({
				hierarchy: hierarchyAtStart,
				itemKey: target.itemKey,
				zoneId
			});
			if (!isCurrentClassicLifecycle(lifecycleGeneration)) return;

			const filterPlayable = (items: BrowseItem[]) =>
				items.filter((i) => i.itemKey && (i.isPlayable || i.hint === 'action'));

			let playableActions = filterPlayable(actionResult.items);

			// Roon's search hierarchy sometimes nests one level deeper than
			// browse: drilling a search-result track returns a single-row
			// list holding the track again as another action_list, and only
			// the NEXT drill yields Play Now / Add Next / … (verified live
			// 2026-07-09 against Core 2.67 build 1661). Follow lone
			// action_list rows a bounded number of hops before concluding
			// there is nothing playable. The extra drills leave the session
			// deeper, which is fine — every search interaction re-seeds
			// with popAll.
			for (let hop = 0; hop < 2 && playableActions.length === 0; hop++) {
				const nested = actionResult.items.filter(
					(i) => i.itemKey && i.hint === 'action_list'
				);
				if (nested.length !== 1) break;
				actionResult = await transaction.browse({
					hierarchy: hierarchyAtStart,
					itemKey: nested[0].itemKey,
					zoneId
				});
				if (!isCurrentClassicLifecycle(lifecycleGeneration)) return;
				playableActions = filterPlayable(actionResult.items);
			}
			const preferred = options.preferActionTitles
				?.map((wanted) =>
					playableActions.find((a) => a.title.trim().toLowerCase() === wanted)
				)
				.find(Boolean);
			const playAction = preferred ?? playableActions[0];
			if (!playAction?.itemKey) {
				if (options.playOnly) {
					pushCommandFeedback({
						source: 'browse',
						command: 'play',
						message: `Couldn't play "${item.title}".`
					});
					return;
				}
				// The action result is already the fresh surface at the session's
				// current level. Commit it after the transaction releases its role.
				return { result: actionResult, target };
			}

			// Execute Play Now
			if (!isCurrentClassicLifecycle(lifecycleGeneration)) return;
			await transaction.browse({
				hierarchy: hierarchyAtStart,
				itemKey: playAction.itemKey,
				zoneId
			});
			if (!isCurrentClassicLifecycle(lifecycleGeneration)) return;

			pushCommandFeedback({
				source: 'browse',
				command: 'play',
				kind: 'success',
				message: item.title ? `Playing "${trackTitle(item.title)}".` : 'Playing.'
			});

			// Only restore the album view if we were in the main browse hierarchy.
			// In search context there's no album view to restore.
			if (hierarchyAtStart === 'browse') {
				await transaction.browsePop({
					hierarchy: 'browse',
					zoneId,
					levels: 2
				});
			}
			return null;
			};
			const fallbackSurface = options.transaction
				? await execute(options.transaction)
				: await withClassicBrowseRoleTransaction(
						role,
						requireClassicSessionClaim(),
						execute
					);
			if (fallbackSurface) {
				if (!isCurrentClassicLifecycle(lifecycleGeneration)) return;
				if (!isCurrentClassicSessionGeneration(sessionGeneration)) {
					resetRoot();
					return;
				}
				const context = historyContextFor(hierarchyAtStart);
				if (options.resetSearch && context) resetHistory(context);
				const breadcrumb = makeBreadcrumb(fallbackSurface.target);
				if (context && breadcrumb && pushHistory(context, breadcrumb)) {
					writeClassicPageState('push');
				}
				setBrowseResult(fallbackSurface.result, hierarchyAtStart);
			}
		} catch (err) {
			if (
				isCurrentClassicLifecycle(lifecycleGeneration) &&
				!(err instanceof ClassicBrowseSupersededError)
			) pushCommandFeedback({
				source: 'browse',
				command: 'play',
				message: `Play failed: ${(err as Error).message}`
			});
		} finally {
			if (isCurrentClassicLifecycle(lifecycleGeneration)) quickPlayInFlight = false;
		}
	}

	function handleItemClick(item: BrowseItem) {
		// Input-prompt items (Roon's Library > Search node) require text
		// input — drilling their itemKey without input lands on an empty
		// "No results" list. Open the search interface instead; the
		// query then runs through the regular search session.
		if (item.inputPrompt) {
			openSearchPanel();
			return;
		}

		if (!item.itemKey) return;

		if (item.hint === 'action_list') {
			if (shouldQuickPlayActionList(item)) {
				void quickPlay(item, { role: activeBrowseRole() });
			} else if (parseAlbumByArtist(item.title)) {
				// Contextual rows like "On Ocean to Ocean by Tilda Arlen"
				// land on a play-action menu in Roon, not the album page.
				// Try to resolve the album via search; fall back to the
				// existing navigate (action menu) if resolution fails.
				void resolveAlbumOrNavigate(item);
			} else {
				navigate(item);
			}
			return;
		}

		navigate(item);
	}

	/**
	 * Click handler for ▶ buttons inside the track-list rendering.
	 * Bypasses the heuristic gates in `shouldQuickPlayActionList` —
	 * if the layout has decided this is a track row, the only sensible
	 * thing to do on play is quickPlay. Roon playlist tracks come back
	 * without `itemType=track` and without numeric prefixes, so the
	 * default `handleItemClick` path would drill into the play-action
	 * menu ("Play Now / Add to Queue / …") instead of playing.
	 */
	function handleTrackPlay(item: BrowseItem) {
		if (!item.itemKey) return;
		// BUGS.md #6 + owner clarification (2026-06-10): a track clicked
		// in ANY list — album, playlist, or other track listing — should
		// continue playing through the rest of that list. Prefer Roon's
		// "Play From Here" wherever it's offered; fall back to the first
		// play action ("Play Now") where it isn't. Single-track play
		// stays available per-row via the ⋮ menu.
		void quickPlay(item, {
			role: activeBrowseRole(),
			preferActionTitles: ['play from here']
		});
	}

	/**
	 * Parse "<album> by <artist>" titles. Roon uses this format for
	 * contextual rows on Work / Composer pages where the row points to a
	 * play-action menu rather than an album browse page. Returning the
	 * parsed pair lets `resolveAlbumOrNavigate` look up the album via
	 * search and jump to the album page directly.
	 */
	function parseAlbumByArtist(title: string): { album: string; artist: string } | null {
		const m = title.match(/^(.+?)\s+by\s+(.+?)\s*$/i);
		if (!m) return null;
		const album = m[1].trim();
		const artist = m[2].trim();
		if (!album || !artist) return null;
		return { album, artist };
	}

	async function resolveAlbumOrNavigate(item: BrowseItem): Promise<void> {
		const lifecycleGeneration = classicLifecycleGeneration;
		if (!isCurrentClassicLifecycle(lifecycleGeneration)) return;
		const sessionGeneration = captureLiveClassicSessionGeneration();
		if (sessionGeneration === null) {
			resetRoot();
			return;
		}
		const parsed = parseAlbumByArtist(item.title);
		if (!parsed) {
			navigate(item);
			return;
		}

		// Show loading without committing the hierarchy switch — a
		// failed resolver must be able to fall back to navigate(item)
		// in the original hierarchy. setBrowseLoading('search') here
		// would switch the store's hierarchy and the fallback would
		// then send the contextual row's browse-hierarchy itemKey
		// against the search session.
		setBrowseLoading();

		try {
			const resolved = await withClassicBrowseRoleTransaction(
				'classic-search',
				requireClassicSessionClaim(),
				async (transaction) => {
					const searchResult = await transaction.browse({
						hierarchy: 'search',
						input: parsed.album,
						zoneId: $selectedZoneStore || undefined,
						popAll: true
					});
					if (!isCurrentClassicLifecycle(lifecycleGeneration)) {
						throw new ClassicBrowseSupersededError();
					}
					const albumLower = parsed.album.toLowerCase();
					const artistLower = parsed.artist.toLowerCase();
					const match = searchResult.items.find((candidate) => {
						if (!candidate.itemKey) return false;
						if ((candidate.itemType ?? '').toLowerCase() !== 'album') return false;
						if (candidate.title.toLowerCase() !== albumLower) return false;
						return (candidate.subtitle ?? '').toLowerCase().includes(artistLower);
					});
					if (!match?.itemKey) return false;
					const page = await transaction.browse({
						hierarchy: 'search',
						itemKey: match.itemKey,
						zoneId: $selectedZoneStore || undefined
					});
					if (!isCurrentClassicLifecycle(lifecycleGeneration)) {
						throw new ClassicBrowseSupersededError();
					}
					const liveSocket = socket ?? getSocket();
					socket = liveSocket;
					if (!liveSocket?.connected) throw new ClassicBrowseSupersededError();
					setSearchLoading(parsed.album);
					const context: BrowseHistoryContext = {
						hierarchy: 'search',
						query: parsed.album
					};
					resetHistory(context);
					const breadcrumb = makeBreadcrumb(match);
					if (breadcrumb && pushHistory(context, breadcrumb)) writeClassicPageState('push');
					setBrowseResult(page, 'search');
					return true;
				}
			);
			if (!resolved && isCurrentClassicLifecycle(lifecycleGeneration)) {
				clearBrowseLoading();
				if (!isCurrentClassicSessionGeneration(sessionGeneration)) {
					resetRoot();
					return;
				}
				navigate(item);
			}
		} catch (error) {
			if (!isCurrentClassicLifecycle(lifecycleGeneration)) return;
			// Clear loading before either stopping or falling back. A disconnected
			// socket can supersede this resolver before the disconnect event has
			// reset the browse store, so returning first would strand loading.
			clearBrowseLoading();
			if (
				error instanceof ClassicBrowseSupersededError ||
				!isCurrentClassicSessionGeneration(sessionGeneration)
			) {
				resetRoot();
				return;
			}
			navigate(item);
		}
	}

	/**
	 * Normalize a Roon `item_type` / `item_subtype` for comparison.
	 * BrowseService passes the raw value through; Roon is mostly lowercase
	 * singular but `inferSearchType` already handles plurals defensively.
	 * Match that style here so a `Track` / `tracks` payload doesn't slip
	 * through as untyped.
	 */
	function normalizeItemType(value: string | undefined): string | undefined {
		return value ? value.toLowerCase() : undefined;
	}

	function isTrackType(value: string | undefined): boolean {
		const t = normalizeItemType(value);
		return t === 'track' || t === 'tracks';
	}

	/**
	 * Classify an action_list item as a track. Roon usually sets
	 * `item_type === 'track'` on real track rows; when it does, trust that
	 * over the leading-digit heuristic (some tracklists — e.g. classical
	 * movements — have no numeric prefix). Fall back to the regex only when
	 * the payload omits `item_type`, so older Roon responses keep working.
	 */
	function isTrackItem(item: BrowseItem): boolean {
		if (item.itemType) return isTrackType(item.itemType);
		return /^\d/.test(item.title);
	}

	function shouldQuickPlayActionList(item: BrowseItem): boolean {
		// Track rows always quick-play, regardless of title shape.
		if (isTrackType(item.itemType)) return true;
		// For any other itemType (or none), fall back to title heuristics.
		// `/^play\b/i` is a strong positive signal across itemType values:
		// `Play Work` may carry `itemType: "work"` or `"action"`, but it's
		// still an explicit play action — not blocking on itemType here
		// keeps that path working. The numeric prefix only fires as a
		// track signal when itemType is absent (legacy fallback for the
		// untyped track-row path).
		const title = item.title.trim();
		if (/^play\b/i.test(title)) return true;
		if (!item.itemType && /^\d/.test(title)) return true;
		return false;
	}

	/**
	 * True when the current level renders as a track list. We make the
	 * decision against the page's action_list rows only — Roon
	 * playlists ship 1+ non-action_list metadata rows (track count,
	 * duration) mixed in with the track rows; previously those tripped
	 * an `every(action_list)` check and sent every track into
	 * `pageActions` as blue-pill buttons. Filtering to actionable rows
	 * first keeps the classification stable.
	 *
	 * After the filter, a page is a track list when any of:
	 *   (a) at least one action_list row explicitly classifies as a
	 *       track via `isTrackItem` (itemType=track or numbered title), OR
	 *   (b) at least one action_list row is a "collection" page action
	 *       ("Play Playlist", "Play Album", …) — its presence implies
	 *       the SIBLING action_list rows are tracks of that collection,
	 *       which catches small playlists (1–4 tracks) that previously
	 *       fell through the size threshold, OR
	 *   (c) the action_list set is large enough (>= 5) that it can only
	 *       reasonably be a track list — Library/Tracks pages come
	 *       back as 100s of action_list rows with no itemType and
	 *       non-numeric titles AND no recognised page action, so
	 *       heuristics (a) and (b) both miss.
	 *
	 * The Work-page exclusion still holds: a Work page has "Play Work"
	 * (NOT in the collection set) + a few "<X> by <Y>" contextual
	 * rows, so heuristics (a), (b), and (c) all return false and it
	 * stays out of the track layout.
	 */
	const TRACK_LIST_SIZE_THRESHOLD = 5;
	const actionListRows = $derived(
		$browseStore.current?.items.filter((i) => i.hint === 'action_list') ?? []
	);
	const isTrackList = $derived.by(() => {
		const cur = $browseStore.current;
		if (!cur || cur.items.length === 0) return false;
		if (actionListRows.length === 0) return false;
		if (actionListRows.some(isTrackItem)) return true;
		if (actionListRows.some(isCollectionPageAction)) return true;
		return actionListRows.length >= TRACK_LIST_SIZE_THRESHOLD;
	});

	/**
	 * True when Roon returned its "Not Found" placeholder for the page.
	 * Verified live (server log 2026-05-17): clicking into a smart
	 * playlist returns count=1 with a single placeholder item:
	 *
	 *   {title: "Not Found", subtitle: null, image_key: null,
	 *    item_key: "836:0"}  // no hint, no isPlayable, no isLoadable
	 *
	 * Roon's public browse API can't materialize smart-playlist
	 * contents (they're a saved query, not a stored list). Other
	 * sources of this pattern: playlists referencing tracks from a
	 * disconnected streaming service, or any itemKey Roon considers
	 * unresolvable at browse time.
	 *
	 * Match on the FULL placeholder shape — title + null subtitle +
	 * null image + no hint — NOT just the title. A real one-item
	 * playlist or album containing a track legitimately titled
	 * "Not Found" would have a subtitle (artist) and/or an image
	 * and/or a hint (action_list for a track row) and won't match.
	 * Tightening avoids hiding legitimate content behind the
	 * placeholder UI (reviewer caught the prior title-only check
	 * as too broad).
	 */
	const isRoonNotFoundPage = $derived.by(() => {
		const cur = $browseStore.current;
		if (!cur || cur.items.length !== 1) return false;
		const only = cur.items[0];
		if (only.title.trim() !== 'Not Found') return false;
		// Placeholder shape: no subtitle, no image, no hint.
		if (only.subtitle != null && only.subtitle !== '') return false;
		if (only.imageKey != null && only.imageKey !== '') return false;
		if (only.hint !== undefined) return false;
		return true;
	});

	/**
	 * "Non-album track list" mode: the page IS a track list, but it
	 * isn't an album page — so isAlbumPage / albumChips / the
	 * subtitle-as-search-artist link should all stay off. Two
	 * triggers:
	 *
	 * 1. No action_list row classifies as a track via isTrackItem
	 *    (Library/Tracks-style page with hundreds of untyped rows —
	 *    the original case).
	 * 2. The page contains a non-album collection page action
	 *    ("Play Playlist", "Play Tag", "Play Mix", "Play All") —
	 *    a strong positive signal that the page is a playlist /
	 *    tag / mix, NOT an album, even if Roon happens to type one
	 *    of the sibling rows as `track`.
	 *
	 * Without (2), a mixed-typing playlist would re-enable
	 * isAlbumPage and bring back the "subtitle becomes search link"
	 * bug — clicking "321 Tracks" would search Roon for that string.
	 *
	 * The name `inferredAllTracks` is retained for backwards-
	 * compatibility with downstream consumers (isAlbumPage callers,
	 * the album chip / artist link gates). Its semantics are now
	 * "is this a non-album track list" rather than the original
	 * "did we hit the size threshold without any isTrackItem hit".
	 */
	const inferredAllTracks = $derived(
		isTrackList && (
			!actionListRows.some(isTrackItem) ||
			actionListRows.some(isNonAlbumCollectionAction)
		)
	);

	/**
	 * Roon page-level "Play <X>" actions whose presence implies the
	 * other action_list rows on the page ARE tracks of that
	 * collection. Used as a positive signal in `isTrackList` so small
	 * playlists (1–4 tracks + "Play Playlist") don't fall through the
	 * size-threshold and render as blue-pill pageActions.
	 *
	 * Excluded from this set on purpose: "Play Work", "Play Artist",
	 * "Play Composer", "Play Genre", "Play Radio" — those pages
	 * have rows that aren't tracks (Work pages list recordings,
	 * Artist pages list albums, etc.). Including them would
	 * misclassify e.g. a Work page as a track list.
	 */
	const COLLECTION_PAGE_ACTION_TITLES = new Set([
		'play playlist',
		'play album',
		'play tag',
		'play all',
		'play mix'
	]);

	/**
	 * Subset of collection page actions whose presence means the page
	 * is NOT an album — playlists, tags, mixes, "All Tracks", etc.
	 * "Play Album" is intentionally absent: a real album page has
	 * "Play Album" as its top action, and we DO want isAlbumPage to
	 * return true there (so artist-link, chips, etc. render).
	 *
	 * Used by `inferredAllTracks` to flip true even when one
	 * mixed-typing playlist row happens to satisfy isTrackItem —
	 * otherwise that single typed row would mark the playlist as an
	 * album page and reintroduce the "search for 321 Tracks" bug.
	 */
	const NON_ALBUM_COLLECTION_TITLES = new Set([
		'play playlist',
		'play tag',
		'play all',
		'play mix'
	]);
	function isNonAlbumCollectionAction(item: BrowseItem): boolean {
		return NON_ALBUM_COLLECTION_TITLES.has(item.title.trim().toLowerCase());
	}

	/**
	 * All known Roon page-action labels — the union of "collection"
	 * actions (above) and "navigation" actions whose siblings aren't
	 * tracks. Used by `isPageActionTitle` to split pageActions vs
	 * trackItems so a "Play Playlist" row never lands among the
	 * tracks even in the inferredAllTracks layout.
	 *
	 * Exact match against this set — NOT a `^Play ` prefix — so
	 * that real song titles starting with "Play" ("Play Dead",
	 * "Play With Fire", "Play That Funky Music", "Play Crack the
	 * Sky") stay classified as tracks.
	 *
	 * If Roon adds a new page-action label, it falls through to
	 * trackItems until the set is updated. That's the safer failure
	 * mode: an extra row in the track list is visually wrong but
	 * reachable; a missing song row hides content.
	 */
	const PAGE_ACTION_TITLES = new Set([
		...COLLECTION_PAGE_ACTION_TITLES,
		'play artist',
		'play genre',
		'play composer',
		'play work',
		'play radio'
	]);
	function isPageActionTitle(item: BrowseItem): boolean {
		return PAGE_ACTION_TITLES.has(item.title.trim().toLowerCase());
	}
	function isCollectionPageAction(item: BrowseItem): boolean {
		return COLLECTION_PAGE_ACTION_TITLES.has(item.title.trim().toLowerCase());
	}

	/**
	 * True when an item is unambiguously a page-level action. Two
	 * signals trigger this:
	 * 1. Known "Play <X>" title in PAGE_ACTION_TITLES (the cross-Roon
	 *    contract — Playlist, Album, Tag, Mix, Work, Composer, etc.).
	 * 2. Explicit non-track itemType (e.g. `itemType: 'action'` on a
	 *    "1 Hour Continuous Mix" pill). Roon only sets `itemType:
	 *    'track'` on real track rows; everything else with a typed
	 *    itemType is page-level.
	 *
	 * What we INTENTIONALLY don't use as a signal: `isTrackItem` /
	 * `!isTrackItem`. Roon frequently emits inconsistent
	 * itemType / numeric-prefix data across rows of the SAME
	 * playlist (one track typed `track`, hundreds untyped; or one
	 * track titled "9 to 5" matching the numeric-prefix fallback
	 * while siblings don't). Splitting on `!isTrackItem` would send
	 * every untyped sibling into pageActions as a blue-pill — the
	 * exact bug the live screenshots showed.
	 */
	function isPageAction(item: BrowseItem): boolean {
		if (isPageActionTitle(item)) return true;
		if (item.itemType && !isTrackType(item.itemType)) return true;
		return false;
	}

	const pageActions = $derived(
		isTrackList
			? actionListRows.filter(isPageAction)
			: actionListRows
	);

	/** Individual tracks — every action_list row on a track-list page that ISN'T a page action. */
	const trackItems = $derived(
		isTrackList
			? actionListRows.filter((i) => !isPageAction(i))
			: []
	);

	/** Non-action items for the current list. */
	const browseItems = $derived(
		isTrackList
			? []
			: ($browseStore.current?.items.filter((i) => i.hint !== 'action_list') ?? [])
	);

	/** Levels 0–1 are navigation menus; level 2+ is content (artists, albums, etc.). */
	const isContentList = $derived(($browseStore.current?.level ?? 0) >= 2);

	/**
	 * Album-page header chips (year, format) extracted from the
	 * subtitle. Only render on level-2+ track lists so subtitle
	 * patterns like "Artist · 1994" on artist/genre pages don't
	 * generate spurious year chips. See `$lib/albumChips.ts` for
	 * the extraction heuristics.
	 */
	const albumChips = $derived(
		isAlbumPage($browseStore.current, isTrackList, inferredAllTracks)
			? extractAlbumChips($browseStore.current?.subtitle)
			: []
	);

	/**
	 * Artist label used by the album-header "Search for this artist"
	 * link. The raw subtitle may contain chip tokens
	 * ("Artist · 1994 · FLAC"); strip them so the search query is
	 * just the artist portion.
	 */
	const albumArtist = $derived(
		extractArtistFromSubtitle($browseStore.current?.subtitle)
	);

	const gridItems = $derived(isContentList ? browseItems : []);
	const listItems = $derived(isContentList ? [] : browseItems);

	const JUMP_ALPHABET = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '#'];

	/**
	 * Jump letter for an item — derived from its SORT key, not its raw
	 * first character. Roon sorts "The Beatles" under B (the leading
	 * article is ignored), so the jump letter must skip it too
	 * (BUGS.md #8).
	 */
	function itemLetter(title: string): string {
		const sortKey = title.replace(/^the\s+/i, '');
		const ch = sortKey.charAt(0).toUpperCase();
		return /[A-Z]/.test(ch) ? ch : '#';
	}

	/**
	 * Alphabetic jump list. Fully-loaded lists derive their letters
	 * from the items; a partially-loaded list shows the complete
	 * alphabet so the jump list spans the whole library, not just the
	 * loaded batch (BUGS.md #9) — clicking an unloaded letter loads
	 * the rest first (see jumpTo).
	 */
	const jumpLetters = $derived.by(() => {
		if (isTrackList || browseItems.length === 0) return [];
		const total = $browseStore.current?.totalCount ?? browseItems.length;
		if (total <= 20) return [];
		if (browseItems.length < total) return JUMP_ALPHABET;
		const seen = new Set<string>();
		for (const item of browseItems) {
			seen.add(itemLetter(item.title));
		}
		return Array.from(seen).sort((a, b) => (a === '#' ? 1 : b === '#' ? -1 : a.localeCompare(b)));
	});

	/** For each letter, the index of the first browseItem starting with it. */
	const jumpIndex = $derived.by(() => {
		const map = new Map<string, number>();
		for (let i = 0; i < browseItems.length; i++) {
			const letter = itemLetter(browseItems[i].title);
			if (!map.has(letter)) map.set(letter, i);
		}
		return map;
	});

	function jumpId(item: BrowseItem, index: number): string | undefined {
		const letter = itemLetter(item.title);
		return jumpIndex.get(letter) === index ? `jump-${letter}` : undefined;
	}

	async function jumpTo(letter: string) {
		const el = document.getElementById(`jump-${letter}`);
		if (el) {
			el.scrollIntoView({ behavior: 'smooth', block: 'start' });
			return;
		}
		// Letter not in the loaded slice yet — pull the rest, then jump.
		await loadMore({ all: true });
		// Wait one tick for derived state to flush.
		await new Promise((r) => setTimeout(r, 0));
		// The library may have no entries under the exact letter (the
		// full-alphabet bar renders letters speculatively) — fall back
		// to the nearest following letter, then nearest preceding.
		const idx = JUMP_ALPHABET.indexOf(letter);
		const candidates =
			idx === -1
				? [letter]
				: [...JUMP_ALPHABET.slice(idx), ...JUMP_ALPHABET.slice(0, idx).reverse()];
		for (const candidate of candidates) {
			const target = document.getElementById(`jump-${candidate}`);
			if (target) {
				target.scrollIntoView({ behavior: 'smooth', block: 'start' });
				return;
			}
		}
	}

	/**
	 * Svelte action: auto-load the next page when the sentinel (the
	 * load-more bar) scrolls into view — infinite scroll until the
	 * whole list is loaded (BUGS.md #10). The bar unmounts once
	 * everything is loaded, which tears the observer down. The manual
	 * buttons remain as fallback (and for jsdom / browsers without
	 * IntersectionObserver, where this action is a no-op).
	 */
	function infiniteScroll(node: HTMLElement) {
		if (typeof IntersectionObserver === 'undefined') return;
		let observer: IntersectionObserver | null = null;
		const resource: ClassicInfiniteScrollResource = {
			resume() {
				if (observer || !classicLifecycleActive) return;
				const nextObserver = new IntersectionObserver(
					(entries) => {
						if (
							observer !== nextObserver ||
							!classicLifecycleActive ||
							!entries.some((entry) => entry.isIntersecting)
						) return;
						void loadMore();
					},
					{ rootMargin: '600px' }
				);
				observer = nextObserver;
				nextObserver.observe(node);
			},
			suspend() {
				const activeObserver = observer;
				observer = null;
				activeObserver?.disconnect();
			}
		};
		classicInfiniteScrollResources.add(resource);
		resource.resume();
		return {
			destroy() {
				classicInfiniteScrollResources.delete(resource);
				resource.suspend();
			}
		};
	}

</script>

<div class="library-shell">
	{#if libraryIntentBusy}
		<section
			class="library-intent-loading card"
			aria-label="Opening Library destination"
			aria-busy="true"
			aria-live="polite"
		>
			<p>Opening Library destination…</p>
		</section>
	{:else}
	{#if $browseStore.searchOpen || $browseStore.searchLoading || $browseStore.searchError || $browseStore.lastSearch}
		<section class="search-results-panel card">
			<!--
				Explicitly-opened search (searchOpen) renders the full
				interface with its own input so the user can type right
				here; results arriving via the header input render the
				results-only mode (the input already lives in the header).
			-->
			<Search
				mode={$browseStore.searchOpen ? 'full' : 'results'}
				focusInput={$browseStore.searchOpen}
				sessionClaim={classicSessionClaim}
				onSubmit={submitClassicSearch}
				onResultClick={handleSearchResultClick}
				onSeeAllCategory={handleSeeAllCategory}
				onTrackMore={(result) => void openSearchTrackMenu(result)}
			/>
		</section>
	{/if}

	<section class="results-panel card">
		{#if $browseStore.loading}
			<p class="loading">Loading library data...</p>
		{:else if $browseStore.error}
			<div class="error">
				<p>{$browseStore.error}</p>
			</div>
		{:else if $browseStore.current}
			<div class="result-header">
				<div>
					<h2>{$browseStore.current.title || 'Browse'}</h2>
					{#if $browseStore.current?.subtitle && !isTrackList}
						<!--
							Subtitle on a non-tracklist page is informational
							metadata (e.g. "12 albums", "453 tracks") — NOT
							an artist name. Rendering it as a search-link
							would route clicks like "453 tracks" through the
							search hierarchy and return "no results". Static
							text only. Artist search is still available from
							the play-bar artist link and from the in-album
							header below when we're on an actual album page.
						-->
						<span class="artist-link-static">{$browseStore.current.subtitle}</span>
					{/if}
				</div>
				{#if pageActions.length > 0}
					<div class="page-actions">
						{#each pageActions as action}
							<button
								type="button"
								class="album-action-btn"
								onclick={() => handleItemClick(action)}
								disabled={!action.itemKey || quickPlayInFlight}
							>{action.title}</button>
						{/each}
					</div>
				{/if}
			</div>

			{#if jumpLetters.length > 0}
				<nav class="jump-bar" aria-label="Alphabetic index">
					{#each jumpLetters as letter}
						<button type="button" class="jump-letter" onclick={() => jumpTo(letter)}>{letter}</button>
					{/each}
				</nav>
			{/if}

			{#if isRoonNotFoundPage}
				<!--
					Roon returned its "Not Found" placeholder for the page.
					Verified live for smart playlists, which Roon's public
					browse API can't materialize. Same shape also appears
					for playlists referencing tracks from a disconnected
					streaming service (Tidal/Qobuz expired) and for any
					itemKey Roon considers unresolvable at browse time.
					Show a friendly explanation in place of the confusing
					"Not Found" card.
				-->
				<div class="unloadable-list">
					<p class="unloadable-list-title">
						Couldn't load this playlist's contents
					</p>
					<p class="unloadable-list-hint">
						Roon couldn't materialize this list — most often a
						<strong>smart playlist</strong> (the public Roon API
						can't browse smart-playlist contents), or a regular
						playlist referencing tracks from a disconnected
						streaming service.
					</p>
					<p class="unloadable-list-hint">
						If this is a normal playlist, try opening it in the
						Roon app first to verify it loads there.
					</p>
				</div>
			{:else if isTrackList}
				{#if $browseStore.current?.subtitle}
					<div class="album-header">
						{#if isAlbumPage($browseStore.current, isTrackList, inferredAllTracks) && albumArtist}
							<!--
								Only render as search link on a confirmed
								album page. Playlists/Library track lists also
								hit isTrackList=true (via inferredAllTracks)
								and carry subtitles like "453 tracks" — those
								must not become "search 453 tracks" clicks.
								isAlbumPage already excludes inferredAllTracks
								so a true album with a parsed artist gets the
								link, and a playlist contents page gets static
								text.
							-->
							<button
								type="button"
								class="artist-link"
								onclick={() => searchArtist(albumArtist)}
								title="Search for this artist"
							>{albumArtist}</button>
						{:else}
							<span class="artist-link-static">{$browseStore.current.subtitle}</span>
						{/if}
						{#if albumChips.length > 0}
							<div class="album-chips" aria-label="Album metadata">
								{#each albumChips as chip}
									<span class="album-chip album-chip-{chip.kind}">{chip.label}</span>
								{/each}
							</div>
						{/if}
						{#if isAlbumPage($browseStore.current, isTrackList, inferredAllTracks) && $browseStore.current?.title}
							<button
								type="button"
								class="fav-add-btn"
								disabled={favoriteMutationInFlight}
								title="Add this album to favorites"
								onclick={() =>
									void addFavoriteEntry({
										type: 'album',
										title: $browseStore.current?.title ?? '',
										artist: albumArtist || undefined
									})}
							>☆ Album</button>
							{#if albumArtist}
								<button
									type="button"
									class="fav-add-btn"
									disabled={favoriteMutationInFlight}
									title="Add this artist to favorites"
									onclick={() => void addFavoriteEntry({ type: 'artist', title: albumArtist })}
								>☆ Artist</button>
							{/if}
						{/if}
					</div>
				{/if}
				<TrackList
					items={trackItems}
					onItemClick={handleTrackPlay}
					onMoreClick={(item) => void openTrackMenu(item)}
					onSubtitleClick={searchArtist}
					isNowPlaying={isNowPlayingTrack}
					playDisabled={quickPlayInFlight}
				/>
			{:else}
				{#if listItems.length > 0}
					<ul class="list-items">
						{#each listItems as item, index}
							<li id={jumpId(item, index)}>
								<button
									type="button"
									class="list-item-btn"
									onclick={() => handleItemClick(item)}
									disabled={!item.itemKey}
								>
									<span class="list-item-title">{item.title}</span>
									{#if item.subtitle}
										<span class="list-item-sub">{item.subtitle}</span>
									{/if}
								</button>
							</li>
						{/each}
					</ul>
				{/if}
				{#if gridItems.length > 0}
					<ItemGrid items={gridItems} onItemClick={handleItemClick} {jumpId} />
				{/if}
				{#if $browseStore.current && !isTrackList && $browseStore.current.items.length < ($browseStore.current.totalCount ?? $browseStore.current.count)}
					<div class="load-more-bar" use:infiniteScroll>
						<span class="load-meta">
							Showing {$browseStore.current.items.length} of {$browseStore.current.totalCount ?? $browseStore.current.count}
						</span>
						<div class="load-actions">
							<button type="button" onclick={() => loadMore()} disabled={loadMoreInFlight}>
								{loadMoreInFlight ? 'Loading…' : 'Load more'}
							</button>
							<button type="button" onclick={() => loadMore({ all: true })} disabled={loadMoreInFlight}>
								Load all
							</button>
						</div>
					</div>
				{/if}
			{/if}
		{:else}
			<div class="welcome">
				{#if heroNowPlaying}
					<section class="hero" aria-label="Now playing">
						<div class="hero-art">
							{#if heroNowPlaying.image_key}
								<img
									src={imageUrl(heroNowPlaying.image_key, { width: 320, height: 320 })}
									alt="Now playing artwork"
									decoding="async"
									use:hideOnError
								/>
							{:else}
								<span class="hero-art-fallback">{heroNowPlaying.title?.charAt(0) ?? '♪'}</span>
							{/if}
						</div>
						<div class="hero-meta">
							<p class="hero-eyebrow">{heroIsPlaying ? 'Now playing' : 'Paused'} · {heroZone?.display_name ?? ''}</p>
							<h2 class="hero-title">{heroNowPlaying.title ?? 'Untitled'}</h2>
							{#if heroNowPlaying.artist}
								<!--
									Roon delivers multi-artist credits as one
									" / "-joined string; split so each artist is
									individually explorable (live feedback
									2026-06-10: the Hamilton cast credit was a
									single giant link).
								-->
								<p class="hero-artist">
									{#each splitArtists(heroNowPlaying.artist) as artistName, i (i)}
										{#if i > 0}<span class="hero-sep" aria-hidden="true">/</span>{/if}
										<button
											type="button"
											class="hero-link"
											title="Search for {artistName}"
											onclick={() => searchArtist(artistName)}
										>{artistName}</button>
									{/each}
								</p>
							{/if}
							{#if heroNowPlaying.album}
								{@const heroAlbum = heroNowPlaying.album}
								<p class="hero-album">
									<button
										type="button"
										class="hero-link"
										title="Search for {heroAlbum}"
										onclick={() => searchArtist(heroAlbum)}
									>{heroAlbum}</button>
								</p>
							{/if}
						</div>
					</section>
				{/if}

				<section class="stats" aria-label="Library statistics">
					<div class="stat-tile">
						<p class="stat-value">{fmtCount($welcomeStatsStore.artists)}</p>
						<p class="stat-label">Artists</p>
					</div>
					<div class="stat-tile">
						<p class="stat-value">{fmtCount($welcomeStatsStore.albums)}</p>
						<p class="stat-label">Albums</p>
					</div>
					<div class="stat-tile">
						<p class="stat-value">{fmtCount($welcomeStatsStore.tracks)}</p>
						<p class="stat-label">Tracks</p>
					</div>
					<div class="stat-tile">
						<p class="stat-value">{fmtCount($welcomeStatsStore.composers)}</p>
						<p class="stat-label">Composers</p>
					</div>
				</section>

				<section
					class="recently-played"
					id="recently-played-section"
					tabindex="-1"
					aria-labelledby="recently-played-heading"
					aria-busy={$recentlyPlayedStore.loading}
				>
						<header class="recently-played-header">
							<h3 id="recently-played-heading">Recently played</h3>
							<p class="recently-played-note">on this controller</p>
							{#if $recentlyPlayedStore.entries.length > 0}
								<button
									type="button"
									class="recently-played-clear"
									disabled={clearRecentInFlight}
									onclick={clearRecentEntries}
								>Clear</button>
							{/if}
						</header>
						{#if $recentlyPlayedStore.loading && !$recentlyPlayedStore.loaded}
							<p class="recently-played-empty">Loading recently played music…</p>
						{:else if $recentlyPlayedStore.entries.length === 0}
							<p class="recently-played-empty">
								No recently played music has been observed by this controller yet.
							</p>
						{:else}
							<div class="recently-played-grid">
							{#each $recentlyPlayedStore.entries.slice(0, 12) as entry}
								<button
									type="button"
									class="rp-tile"
									disabled={recentlyPlayedClickInFlight}
									title="Play '{entry.title ?? 'Untitled'}' on the selected zone"
									aria-label="Play '{entry.title ?? 'Untitled'}' on the selected zone"
									onclick={() => playRecentEntry(entry)}
								>
									<div class="rp-art">
										{#if entry.image_key}
											<img
												src={imageUrl(entry.image_key, { width: 160, height: 160 })}
												alt={entry.album ?? entry.title ?? 'Artwork'}
												loading="lazy"
												decoding="async"
												use:hideOnError
											/>
										{:else}
											<span class="rp-art-fallback">{entry.title?.charAt(0) ?? '♪'}</span>
										{/if}
										<span class="rp-play-overlay" aria-hidden="true">▶</span>
									</div>
									<div class="rp-meta">
										<p class="rp-title" title={entry.title}>{entry.title ?? 'Untitled'}</p>
										{#if entry.artist}
											<p class="rp-artist" title={entry.artist}>{entry.artist}</p>
										{/if}
										{#if entry.zone_name}
											<p class="rp-zone">{entry.zone_name}</p>
										{/if}
									</div>
								</button>
							{/each}
							</div>
						{/if}
					</section>

					<section
						class="favorites"
						id="favorites-section"
						tabindex="-1"
						aria-labelledby="favorites-heading"
						aria-busy={$favoritesStore.loading}
					>
						<header class="recently-played-header">
							<h3 id="favorites-heading">Favorites</h3>
						</header>
						{#if $favoritesStore.loading && !$favoritesStore.loaded}
							<p class="favorites-empty">Loading favorites…</p>
						{:else if $favoritesStore.entries.length === 0}
							<p class="favorites-empty">
								No favorites yet — use the ⋮ menu on a track, or the
								☆ buttons on an album page.
							</p>
						{:else}
						<div class="recently-played-grid">
							{#each $favoritesStore.entries.slice(0, 24) as fav (fav.id)}
								<div class="fav-tile-wrap">
									<button
										type="button"
										class="rp-tile fav-tile"
										disabled={fav.type === 'track' && favoriteClickInFlight}
										title={fav.type === 'track'
											? `Play '${fav.title}' on the selected zone`
											: `Search for '${fav.title}'`}
										aria-label={fav.type === 'track'
											? `Play favorite '${fav.title}'`
											: `Search favorite '${fav.title}'`}
										onclick={() => void handleFavoriteClick(fav)}
									>
										<div class="rp-art">
											{#if fav.image_key}
												<img
													src={imageUrl(fav.image_key, { width: 160, height: 160 })}
													alt={fav.title}
													loading="lazy"
													decoding="async"
													use:hideOnError
												/>
											{:else}
												<span class="rp-art-fallback">{fav.title.charAt(0)}</span>
											{/if}
											<span class="rp-play-overlay" aria-hidden="true">{fav.type === 'track' ? '▶' : '⌕'}</span>
										</div>
										<div class="rp-meta">
											<p class="rp-title" title={fav.title}>{fav.title}</p>
											{#if fav.artist}
												<p class="rp-artist" title={fav.artist}>{fav.artist}</p>
											{/if}
											<p class="rp-zone">{fav.type}</p>
										</div>
									</button>
									<button
										type="button"
										class="fav-remove"
										disabled={favoriteMutationInFlight}
										title="Remove from favorites"
										aria-label="Remove '{fav.title}' from favorites"
										onclick={() => void handleRemoveFavorite(fav)}
									>×</button>
								</div>
							{/each}
						</div>
						{/if}
					</section>

				<p class="welcome-hint">Pick something from <strong>Explore</strong> on the left, or search up top.</p>
			</div>
		{/if}
	</section>
	{/if}
</div>

{#if trackMenu && !libraryIntentBusy}
	<TrackActionsMenu
		title={trackTitle(trackMenu.item.title)}
		actions={trackMenu.actions}
		extras={[{ label: 'Add to Favorites', onSelect: addTrackFavoriteFromMenu }]}
		busy={trackMenuBusy}
		onAction={(action) => void runTrackMenuAction(action)}
		onClose={closeTrackMenu}
	/>
{/if}

<style>
	.library-shell {
		display: grid;
		gap: 0.85rem;
	}

	/* Both panels are items of the .library-shell grid. Grid items
	   default to min-width: auto = their content's min-content width —
	   and the Recently Played tile row's intrinsic width (12 × 160px
	   tiles, pre-scroll) is far wider than the viewport. Without an
	   explicit min-width: 0 the panel's grid track grows to that
	   intrinsic width, stretching the hero/stats sections above and
	   clipping everything past the viewport edge (.workspace-main has
	   overflow-x: hidden). min-width: 0 lets the panel shrink to the
	   container so the tile row's own overflow-x: auto can engage. */
	.search-results-panel {
		padding: 0.85rem;
		background: var(--surface);
		min-width: 0;
	}

	.results-panel {
		padding: 0.85rem;
		background: var(--surface);
		min-width: 0;
	}

	.library-intent-loading {
		min-height: 12rem;
		display: grid;
		place-items: center;
		color: var(--muted);
	}

	.welcome {
		padding: 1.8rem 1.4rem;
		display: flex;
		flex-direction: column;
		gap: 1.6rem;
	}

	/* ── Now-playing hero ── */
	.hero {
		display: grid;
		grid-template-columns: 200px 1fr;
		gap: 1.4rem;
		align-items: center;
		padding: 1.4rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 14px;
	}

	.hero-art {
		width: 200px;
		height: 200px;
		border-radius: 10px;
		overflow: hidden;
		background: rgba(255, 255, 255, 0.05);
		display: grid;
		place-items: center;
	}

	.hero-art img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.hero-art-fallback {
		font-family: var(--font-display);
		font-size: 4.5rem;
		opacity: 0.45;
	}

	.hero-meta {
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.hero-eyebrow {
		font-size: 0.74rem;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--text-soft);
		font-family: var(--font-display);
	}

	.hero-title {
		font-family: var(--font-display);
		font-size: 1.5rem;
		line-height: 1.15;
		margin: 0.1rem 0 0.2rem;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.hero-artist {
		font-size: 1rem;
		font-weight: 600;
	}

	.hero-album {
		font-size: 0.92rem;
		color: var(--text-soft);
	}

	/* Hero artist/album render as search links (BUGS.md #7) but keep
	   their parent's typography. */
	.hero-link {
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		color: inherit;
		cursor: pointer;
	}

	.hero-link:hover {
		text-decoration: underline;
		text-underline-offset: 3px;
		color: var(--text);
	}

	.hero-sep {
		margin: 0 0.3rem;
		color: var(--text-soft);
		opacity: 0.7;
	}

	/* ── Stat tiles ── */
	.stats {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
		gap: 0.85rem;
	}

	.stat-tile {
		padding: 1rem 1.1rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 12px;
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}

	.stat-value {
		font-family: var(--font-display);
		font-size: 1.7rem;
		font-weight: 700;
		line-height: 1;
	}

	.stat-label {
		font-size: 0.72rem;
		letter-spacing: 0.18em;
		text-transform: uppercase;
		color: var(--text-soft);
	}

	.welcome-hint {
		font-size: 0.86rem;
		color: var(--text-soft);
	}

	/* ── Recently played ── */
	.recently-played:focus-visible,
	.favorites:focus-visible {
		outline: 2px solid var(--accent-2);
		outline-offset: 6px;
		border-radius: 8px;
	}

	.recently-played-header {
		display: flex;
		align-items: baseline;
		gap: 0.7rem;
		margin-bottom: 0.7rem;
	}

	.recently-played-header h3 {
		font-family: var(--font-display);
		font-size: 1rem;
		margin: 0;
	}

	.recently-played-note {
		font-size: 0.74rem;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--text-soft);
	}

	.recently-played-empty {
		font-size: 0.84rem;
		color: var(--text-soft);
	}

	.recently-played-clear {
		margin-left: auto;
		padding: 0.28rem 0.62rem;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--surface-2);
		color: var(--text-soft);
		font-size: 0.76rem;
		cursor: pointer;
	}

	.recently-played-clear:hover:not(:disabled) {
		border-color: var(--accent-2);
		color: var(--text);
	}

	.recently-played-clear:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.recently-played-grid {
		display: flex;
		flex-direction: row;
		gap: 0.7rem;
		overflow-x: auto;
		overflow-y: visible;
		padding-bottom: 0.4rem; /* room for the scrollbar without clipping tiles */
		scroll-snap-type: x mandatory;
		scrollbar-color: var(--text-soft) transparent;
		/* As a flex item of .welcome, the row defaults to
		   min-width: auto = its content's intrinsic width (~16k px
		   for a full row of tiles). That lets it overflow .welcome
		   horizontally and the page scrolls instead of the row.
		   `min-width: 0` + `max-width: 100%` clamps the row to its
		   container's width, so overflow-x: auto kicks in correctly
		   on the row itself. */
		min-width: 0;
		max-width: 100%;
	}

	.recently-played-grid::-webkit-scrollbar {
		height: 8px;
	}

	.recently-played-grid::-webkit-scrollbar-thumb {
		background: var(--text-soft);
		border-radius: 4px;
		opacity: 0.5;
	}

	.rp-tile {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		flex: 0 0 160px;
		min-width: 160px;
		padding: 0;
		background: transparent;
		border: 0;
		text-align: left;
		color: inherit;
		cursor: pointer;
		transition: transform 140ms ease;
		scroll-snap-align: start;
	}

	.rp-tile:hover:not(:disabled) {
		transform: translateY(-2px);
	}

	.rp-tile:disabled {
		opacity: 0.55;
		cursor: progress;
	}

	.rp-art {
		position: relative;
		width: 100%;
		aspect-ratio: 1;
		border-radius: 9px;
		overflow: hidden;
		background: rgba(255, 255, 255, 0.06);
		display: grid;
		place-items: center;
	}

	.rp-play-overlay {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		font-size: 2.4rem;
		color: #fff;
		background: rgba(0, 0, 0, 0.45);
		opacity: 0;
		transition: opacity 140ms ease;
	}

	.rp-tile:hover:not(:disabled) .rp-play-overlay {
		opacity: 1;
	}

	.rp-art img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.rp-art-fallback {
		font-family: var(--font-display);
		font-size: 2.2rem;
		opacity: 0.45;
	}

	.rp-meta {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		min-width: 0;
	}

	.rp-title,
	.rp-artist,
	.rp-zone {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.rp-title {
		font-size: 0.86rem;
		font-weight: 600;
	}

	.rp-artist {
		font-size: 0.78rem;
		color: var(--text-soft);
	}

	.rp-zone {
		font-size: 0.7rem;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--text-soft);
		opacity: 0.78;
	}

	/* ── Favorites ── */
	/* Favorite tiles reuse the rp-tile look; the wrapper exists so the
	   remove (×) button isn't nested inside the tile button (invalid
	   HTML) and can float over the artwork corner. */
	.fav-tile-wrap {
		position: relative;
		flex: 0 0 160px;
		min-width: 160px;
		scroll-snap-align: start;
	}

	.fav-tile-wrap .rp-tile {
		flex: none;
		width: 100%;
		min-width: 0;
	}

	.fav-remove {
		position: absolute;
		top: 0.3rem;
		right: 0.3rem;
		width: 1.5rem;
		height: 1.5rem;
		border: 1px solid var(--border);
		border-radius: 50%;
		background: var(--surface);
		color: var(--text-soft);
		font-size: 0.9rem;
		line-height: 1;
		cursor: pointer;
		opacity: 0;
		transition: opacity 120ms ease;
	}

	.fav-tile-wrap:hover .fav-remove,
	.fav-tile-wrap:focus-within .fav-remove {
		opacity: 1;
	}

	.fav-remove:hover:not(:disabled) {
		color: var(--text);
		border-color: var(--accent-2);
	}

	@media (hover: none), (pointer: coarse) {
		.fav-remove {
			opacity: 1;
		}
	}

	.fav-add-btn {
		padding: 0.22rem 0.6rem;
		border: 1px solid var(--border);
		border-radius: 999px;
		background: var(--surface-2);
		color: var(--text-soft);
		font-size: 0.76rem;
		font-weight: 600;
		cursor: pointer;
	}

	.fav-add-btn:hover:not(:disabled) {
		color: var(--text);
		border-color: var(--accent-2);
	}

	.fav-add-btn:disabled {
		opacity: 0.5;
		cursor: progress;
	}

	.favorites-empty {
		font-size: 0.84rem;
		color: var(--text-soft);
	}

	@media (max-width: 680px) {
		.hero {
			grid-template-columns: 1fr;
		}
		.hero-art {
			width: 100%;
			height: auto;
			aspect-ratio: 1;
		}
	}

	.loading {
		color: var(--text-soft);
	}

	.error {
		padding: 0.8rem;
		background: rgba(255, 124, 124, 0.1);
		border: 1px solid rgba(255, 124, 124, 0.4);
		border-radius: 10px;
		color: #ffb3b3;
	}

	/* Roon "Not Found" placeholder: smart playlist / disconnected
	   service / unresolvable itemKey. Distinct visual from the hard
	   .error block — this isn't a controller error, just Roon
	   declining to materialize the list. */
	.unloadable-list {
		margin: 1rem 0;
		padding: 1rem 1.2rem;
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: 10px;
	}
	.unloadable-list-title {
		margin: 0 0 0.4rem;
		font-weight: 650;
		color: var(--text);
	}
	.unloadable-list-hint {
		margin: 0.3rem 0 0;
		color: var(--text-soft);
		font-size: 0.88rem;
		line-height: 1.45;
	}

	/* ── Jump bar ── */
	.jump-bar {
		display: flex;
		flex-wrap: wrap;
		gap: 0.2rem;
		margin-bottom: 0.7rem;
		position: sticky;
		top: 0;
		z-index: 5;
		background: var(--surface);
		padding: 0.4rem 0;
	}

	.jump-letter {
		min-width: 1.7rem;
		padding: 0.2rem 0;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--surface-2);
		color: var(--text);
		font-size: 0.75rem;
		font-weight: 600;
		font-family: var(--font-mono);
		cursor: pointer;
		text-align: center;
		line-height: 1;
	}

	.jump-letter:hover {
		background: var(--accent);
		color: var(--bg);
		border-color: var(--accent);
	}

	.result-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.8rem;
		margin-bottom: 0.85rem;
		flex-wrap: wrap;
	}

	.result-header h2 {
		font-family: var(--font-display);
		font-size: 1.2rem;
	}

	.page-actions {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	/* ── Album header (artist link + metadata chips in tracklist view) ── */
	.album-header {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.75rem;
		margin-bottom: 0.5rem;
	}

	.album-chips {
		display: inline-flex;
		gap: 0.4rem;
	}

	.album-chip {
		display: inline-block;
		padding: 0.1rem 0.55rem;
		border-radius: 999px;
		font-size: 0.75rem;
		font-weight: 600;
		background: rgba(255, 255, 255, 0.07);
		color: var(--text-muted, rgba(255, 255, 255, 0.75));
		letter-spacing: 0.02em;
	}

	.album-chip-year {
		background: rgba(108, 204, 255, 0.12);
		color: var(--accent, #6cf);
	}

	.album-chip-format {
		background: rgba(180, 220, 110, 0.12);
		color: #b4dc6e;
	}

	.artist-link {
		font-size: 0.88rem;
		font-weight: 600;
		color: var(--accent-2);
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
		text-decoration: underline;
		text-underline-offset: 3px;
	}

	/* Rare: subtitle present but extractArtistFromSubtitle returned
	   empty (only chip tokens, no artist remainder). Render the raw
	   subtitle as plain text so the album header isn't blank, but
	   without the searchArtist click affordance. */
	.artist-link-static {
		font-size: 0.88rem;
		font-weight: 600;
		color: var(--text-muted, rgba(255, 255, 255, 0.7));
	}

	.artist-link:hover {
		opacity: 0.8;
	}

	.album-action-btn {
		padding: 0.45rem 1rem;
		border: 1px solid var(--accent);
		border-radius: 20px;
		background: transparent;
		color: var(--accent);
		font-size: 0.85rem;
		font-weight: 600;
		cursor: pointer;
		transition: background 120ms ease;
	}

	.album-action-btn:hover:not(:disabled) {
		background: rgba(95, 109, 240, 0.15);
	}

	.album-action-btn:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	/* ── Track list (album view) ── */
	/* ── List items (no artwork) ── */
	.list-items {
		list-style: none;
		margin: 0 0 0.85rem;
		padding: 0;
		display: flex;
		flex-direction: column;
	}

	.list-item-btn {
		width: 100%;
		display: flex;
		align-items: baseline;
		gap: 0.6rem;
		padding: 0.52rem 0.5rem;
		border: none;
		border-radius: 8px;
		background: none;
		color: var(--text);
		text-align: left;
		cursor: pointer;
	}

	.list-item-btn:hover:not(:disabled) {
		background: var(--surface-2);
	}

	.list-item-btn:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.list-items li + li .list-item-btn {
		border-top: 1px solid var(--border);
		border-radius: 0;
	}

	.list-items li:first-child .list-item-btn {
		border-radius: 8px 8px 0 0;
	}

	.list-items li:last-child .list-item-btn {
		border-radius: 0 0 8px 8px;
	}

	.list-items li:only-child .list-item-btn {
		border-radius: 8px;
	}

	.list-item-title {
		font-weight: 600;
	}

	.list-item-sub {
		font-size: 0.82rem;
		color: var(--text-soft);
	}

	/* ── Load more bar ── */
	.load-more-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.6rem;
		padding: 0.7rem 0.4rem;
		margin-top: 0.6rem;
		border-top: 1px solid var(--border);
	}

	.load-meta {
		font-size: 0.78rem;
		color: var(--text-soft);
		font-family: var(--font-mono);
	}

	.load-actions {
		display: flex;
		gap: 0.4rem;
	}

	.load-actions button {
		padding: 0.42rem 0.85rem;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--surface-2);
		color: var(--text);
		font-size: 0.82rem;
		font-weight: 600;
		cursor: pointer;
	}

	.load-actions button:hover:not(:disabled) {
		background: var(--surface-3);
		border-color: var(--accent-2);
	}

	.load-actions button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
