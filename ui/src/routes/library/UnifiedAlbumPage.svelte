<script lang="ts">
	import { tick } from 'svelte';
	import type { AlbumActionSemantic } from '@shared/albumActionContracts';
	import { normalizeCatalogText } from '@shared/catalogContracts';
	import { imageUrl } from '$lib/imageUrl';
	import { monogram } from '$lib/monogram';
	import { hideOnError } from '$lib/actions/imageFallback';
	import { trackTitleCarriesOrdinal } from '$lib/trackTitle';
	import { shouldHandleLibraryAnchorClick } from '$lib/libraryPageNavigation';
	import type {
		LibraryAlbumController,
		LibraryAlbumVersionState
	} from '$lib/library/LibraryAlbumController';
	import type { LibraryAlbumEntry } from '$lib/libraryEntries';
	import type { AlbumActionController } from '$lib/library/AlbumActionController';
		import UnifiedItemPageFrame from './UnifiedItemPageFrame.svelte';

	type PageTrackTarget = { readonly index: number; readonly title: string };

	interface Props {
		controller: LibraryAlbumController;
		actionController: AlbumActionController;
		/**
		 * The zone every action on this page targets: the one the user has
		 * selected. `null` disables them. The page never asks which zone
		 * (public issue #12).
		 */
		zoneId: string | null;
		album?: LibraryAlbumEntry | null;
		/**
		 * Stage-aware prose for a collection-opened page whose locator could
		 * not be resolved (Slice 8d). It replaces the page's generic failure
		 * line, which cannot tell a missing collection from a missing album
		 * inside one.
		 */
		collectionFailureMessage?: string | null;
		focusSongTitle?: string | null;
		/** Changes whenever the host activates or restores a Library history entry. */
		activationGeneration?: number;
		backLabel: string;
		onBack: () => void;
		onRetry: () => void;
		actionRetryAvailable?: boolean;
		onRetryAction?: () => void;
		onBeginAction: (
			track: PageTrackTarget | null,
			zoneId: string,
			desiredSemantic: AlbumActionSemantic
		) => void;
		onOpenArtist?: () => void;
		/**
		 * Opens the exact-track child for a ZERO-BASED position in this
		 * version's ordered tracks (plan Slice 5). Offered only on
		 * single-version pages — the exact album/version/index binding.
		 */
		onOpenTrackInfo?: (trackPosition: number) => void;
		/** Leaves that child and returns to the album's own view. */
		onCloseTrackInfo?: () => void;
		hrefForTrack?: (trackTitle: string) => string | null;
		/**
		 * A restored exact-track title: consumed once when the single-version
		 * track order arrives; zero or several matches are never guessed.
		 */
		initialTrackInfoTitle?: string | null;
	}

	const {
		controller,
		actionController,
		zoneId,
		album = null,
		collectionFailureMessage = null,
		focusSongTitle = null,
		activationGeneration = 0,
		backLabel,
		onBack,
		onRetry,
		actionRetryAvailable = false,
		onRetryAction = () => {},
		onBeginAction,
		onOpenArtist,
		onOpenTrackInfo = undefined,
		onCloseTrackInfo = () => {},
		hrefForTrack = undefined,
		initialTrackInfoTitle = null
	}: Props = $props();

	const PAGE_SIZE = 100;

	let page = $state(0);
	let trackList: HTMLOListElement | null = $state(null);
	/**
	 * The live public track target (ri5-2): the child view renders from
	 * the page's own exact data.
	 */
	let trackInfo = $state<{ position: number; title: string } | null>(null);

	const sheet = $derived($controller);
	const action = $derived($actionController);
	const selectedVersion = $derived(
		sheet.versions.find((version) => version.versionId === sheet.selectedVersionId) ?? null
	);
	const pageCount = $derived(Math.max(1, Math.ceil(sheet.orderedTracks.length / PAGE_SIZE)));
	const pageTracks = $derived(sheet.orderedTracks.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE));
	const suppressRowIndex = $derived(
		pageTracks.length > 0 && pageTracks.every((track) => trackTitleCarriesOrdinal(track.title))
	);
	const focusedTrackPosition = $derived.by(() => {
		if (!focusSongTitle) return -1;
		const normalizedTitle = normalizeCatalogText(focusSongTitle);
		if (!normalizedTitle) return -1;
		const exactMatches: number[] = [];
		sheet.orderedTracks.forEach((track, position) => {
			if (normalizeCatalogText(track.title) === normalizedTitle) exactMatches.push(position);
		});
		if (exactMatches.length > 0) return exactMatches.length === 1 ? exactMatches[0] : -1;

		const ordinalMatches: number[] = [];
		sheet.orderedTracks.forEach((track, position) => {
			const withoutOrdinal = normalizeCatalogText(track.title).replace(/^\d+\.\s+/, '');
			if (withoutOrdinal === normalizedTitle) ordinalMatches.push(position);
		});
		return ordinalMatches.length === 1 ? ordinalMatches[0] : -1;
	});
	const focusedTrackIndex = $derived(
		focusedTrackPosition < 0 ? null : (sheet.orderedTracks[focusedTrackPosition]?.index ?? null)
	);
	const actionBusy = $derived(
		action.phase === 'resolving' || action.phase === 'choosing' || action.phase === 'executing'
	);
	const displayTitle = $derived(sheet.title ?? album?.title ?? 'Album');
	const displayArtist = $derived(sheet.artist ?? album?.artist ?? '');
	const displayImageKey = $derived(selectedVersion?.imageKeyHint ?? album?.imageKey ?? null);
	// Permanent hero placeholder layer (q6): rendered beneath the image so
	// a failed load — hidden in place by hideOnError — reveals it.
	const heroFallback = $derived(monogram(displayTitle));

	$effect(() => {
		void sheet.selectedVersionId;
		void sheet.orderedTracks;
		void activationGeneration;
		const focusPosition = focusedTrackPosition;
		page = focusPosition >= 0 ? Math.floor(focusPosition / PAGE_SIZE) : 0;
		trackInfo = null;
		if (focusPosition >= 0) {
			void tick().then(() => {
				trackList
					?.querySelector<HTMLElement>('[data-song-highlight="true"]')
					?.scrollIntoView?.({ block: 'center' });
			});
		}
	});

	function versionLabel(version: LibraryAlbumVersionState, index: number): string {
		return version.editionText || `Version ${index + 1}`;
	}

	function durationLabel(seconds: number): string {
		const rounded = Math.round(seconds);
		const hours = Math.floor(rounded / 3600);
		const minutes = Math.floor((rounded % 3600) / 60);
		const remainder = rounded % 60;
		return hours > 0
			? `${hours}:${minutes.toString().padStart(2, '0')}:${remainder.toString().padStart(2, '0')}`
			: `${minutes}:${remainder.toString().padStart(2, '0')}`;
	}

	function versionFacts(version: LibraryAlbumVersionState): string[] {
		const facts: string[] = [];
		if (version.trackCount !== null) {
			facts.push(`${version.trackCount} ${version.trackCount === 1 ? 'track' : 'tracks'}`);
		}
		if (version.durationSeconds !== undefined) facts.push(durationLabel(version.durationSeconds));
		if (version.releaseDate) facts.push(version.releaseDate);
		if (version.sourceLabel) facts.push(version.sourceLabel);
		if (version.available === false) facts.push('Unavailable');
		if (version.isFavorite) facts.push('Favorite');
		if (version.isListenLater) facts.push('Listen Later');
		if (version.isBanned) facts.push('Banned');
		if (version.playCount !== undefined) {
			facts.push(`${version.playCount} ${version.playCount === 1 ? 'play' : 'plays'}`);
		}
		if (version.lastPlayedAt) facts.push(`Last played ${version.lastPlayedAt.slice(0, 10)}`);
		return facts;
	}

	function versionMeta(version: LibraryAlbumVersionState): string {
		if (version.phase === 'loading') return 'Loading details…';
		if (version.phase === 'failed') return version.error ?? 'Could not load this version.';
		return versionFacts(version).join(' · ') || 'Select for details';
	}

	function selectVersion(versionId: string): void {
		if (action.phase === 'executing') return;
		actionController.cancel();
		actionController.reset();
		controller.select(versionId);
	}

	function pickTarget(
		track: PageTrackTarget | null,
		desiredSemantic: AlbumActionSemantic
	): void {
		// The guard matches the button that reaches it: a whole-album verb asks
		// the album-level answer, a track row asks the track-level one. They are
		// the same answer on a catalog page and may differ on a live one.
		const available = track === null ? sheet.albumActionsAvailable : sheet.actionsAvailable;
		if (!available || actionBusy || zoneId === null) return;
		onBeginAction(track, zoneId, desiredSemantic);
	}

	function openTrackInfo(position: number, title: string): void {
		trackInfo = { position, title };
		onOpenTrackInfo?.(position);
	}

	function followTrackInfo(event: MouseEvent, href: string | null, position: number, title: string): void {
		if (href !== null) {
			if (!shouldHandleLibraryAnchorClick(event)) return;
			event.preventDefault();
		}
		openTrackInfo(position, title);
	}

	function closeTrackInfo(): void {
		trackInfo = null;
		onCloseTrackInfo();
	}

	// Restores a persisted exact-track child by its rendering, never by list
	// position. A catalog page must identify one version; a live page already
	// is one exact rendering. Zero or several exact rows keep the parent until
	// the route's missing/group outcome can say what happened.
	$effect(() => {
		if (initialTrackInfoTitle === null || trackInfo !== null) return;
		if ((sheet.live == null && sheet.versions.length !== 1) || onOpenTrackInfo === undefined) return;
		const matches = sheet.orderedTracks.filter((track) => track.title === initialTrackInfoTitle);
		if (matches.length !== 1) return;
		const position = sheet.orderedTracks.indexOf(matches[0]);
		const title = matches[0].title;
		// The version/track reset effect and this restoration are invalidated by
		// the same level publication. Restore after that reset has settled.
		void tick().then(() => {
			if (initialTrackInfoTitle !== title || trackInfo !== null) return;
			if (sheet.orderedTracks[position]?.title !== title) return;
			openTrackInfo(position, title);
		});
	});
</script>

<UnifiedItemPageFrame
	label="Album page"
	heading={displayTitle}
	headingTestId="unified-album-title"
	{backLabel}
	backTestId="unified-album-back"
	{onBack}
>
	<div class="item-page-body" data-testid="unified-album-page">
		<div class="pleft">
			<div class="art">
				<!-- The monogram is the permanent placeholder layer (q6): a
				     failed image load hides the img in place — hideOnError keeps
				     its box, so the geometry never changes — and reveals the
				     monogram beneath. -->
				<div
					class="mono-tile"
					style={heroFallback.style}
					data-testid="unified-album-hero-fallback"
					aria-hidden="true"
				>
					{heroFallback.letter}
				</div>
				{#if displayImageKey}
					<img
						src={imageUrl(displayImageKey, { scale: 'fit', width: 300, height: 300 })}
						alt=""
						loading="lazy"
						data-testid="unified-album-hero-image"
						use:hideOnError
					/>
				{/if}
			</div>
			<div class="pb">
				<button
					type="button"
					data-testid="unified-album-play"
					disabled={!sheet.albumActionsAvailable || sheet.phase !== 'details' || actionBusy || zoneId === null}
					onclick={() => pickTarget(null, 'play-now')}
				>
					Play album
				</button>
				<button
					type="button"
					data-testid="unified-album-queue"
					disabled={!sheet.albumActionsAvailable || sheet.phase !== 'details' || actionBusy || zoneId === null}
					onclick={() => pickTarget(null, 'queue')}
				>
					Queue album
				</button>
				<button
					type="button"
					data-testid="unified-album-artist-link"
					disabled={!onOpenArtist}
					onclick={onOpenArtist}
				>
					All by artist
				</button>
			</div>
		</div>

		<div class="pright">
			<div class="pa" data-testid="unified-album-artist">{displayArtist}</div>

			{#if sheet.degraded}
				<!-- Non-blocking: the page below is real catalog data and behaves
				     exactly as the extended-bound page does. The notice only says
				     where it came from. -->
				<p class="degraded-notice" data-testid="unified-album-degraded">
					Live browse isn't answering — showing your library's catalog data.
				</p>
			{/if}

			{#if sheet.versions.length > 1}
				<!-- The tab strip earns its place only when there is a choice
				     to make (owner ruling 2026-08-17, reversing the 2026-08-10
				     "tab remains available with one row" line): a single-version
				     album opens straight on Details and shows no strip at all.
				     The codebase's own idiom agrees — the "N versions" badge on
				     tiles only appears when versionCount > 1. -->
				<nav class="album-tabs" aria-label="Album page sections" data-testid="unified-album-tabs">
					<button
						type="button"
						class:on={sheet.activeTab === 'versions'}
						data-testid="unified-album-tab-versions"
						onclick={() => controller.showVersions()}
					>
						Versions{sheet.versions.length > 0 ? ` (${sheet.versions.length})` : ''}
					</button>
					<button
						type="button"
						class:on={sheet.activeTab === 'details'}
						data-testid="unified-album-tab-details"
						disabled={!sheet.selectedVersionId}
						onclick={() => controller.showDetails()}
					>
						Details
					</button>
				</nav>
			{/if}

			{#if action.phase === 'choosing'}
				<div class="action-choices" data-testid="unified-album-action-choices">
					{#each action.actions as choice (choice.actionId)}
						<button type="button" onclick={() => actionController.execute(choice.actionId)}>{choice.label}</button>
					{/each}
					<button type="button" class="ghost" onclick={() => actionController.cancel()}>Cancel</button>
				</div>
			{:else if action.phase === 'resolving' || action.phase === 'executing'}
				<p class="status" data-testid="unified-album-action-busy">Working…</p>
			{:else if action.phase === 'failed' || action.phase === 'outcome-unknown'}
				<p class="status error" data-testid="unified-album-action-error">
					{action.error ?? 'The action failed.'}
				</p>
				{#if action.phase === 'failed' && actionRetryAvailable}
					<button
						type="button"
						class="retry"
						onclick={onRetryAction}
						data-testid="unified-album-action-retry"
					>
						Retry action
					</button>
				{/if}
			{/if}

			{#if sheet.phase === 'opening'}
				<div class="tl">
					<p class="status" data-testid="unified-album-loading">Opening album page…</p>
				</div>
				<div class="stub">Finding the versions Roon currently exposes.</div>
			{:else if sheet.phase === 'failed' || sheet.phase === 'canceled'}
				<div class="tl">
					<p class="status error" data-testid="unified-album-error">{collectionFailureMessage ??
							sheet.error ??
							'The album page could not be opened.'}</p>
					<button type="button" class="retry" onclick={onRetry} data-testid="unified-album-retry">Try again</button>
				</div>
				<div class="stub">Reopen the page to restore live version authority.</div>
			{:else if sheet.activeTab === 'versions'}
				<ul class="version-list tl" data-testid="unified-album-versions">
					{#each sheet.versions as version, index (version.versionId)}
						<li>
							<button
								type="button"
								class="version-row"
								class:selected={version.versionId === sheet.selectedVersionId}
								class:failed={version.phase === 'failed'}
								data-testid="unified-album-version-{index}"
								disabled={action.phase === 'executing'}
								onclick={() => selectVersion(version.versionId)}
							>
								<span class="version-art">
									<!-- Same treatment as the hero (q6): the mono glyph is
									     the permanent placeholder layer; a failed thumb load
									     hides the img in place and reveals it. -->
									<span class="version-mono" aria-hidden="true">{versionLabel(version, index).slice(0, 1)}</span>
									{#if version.imageKeyHint}
										<img
											src={imageUrl(version.imageKeyHint, { scale: 'fit', width: 96, height: 96 })}
											alt=""
											loading="lazy"
											data-testid="unified-album-version-art-{index}"
											use:hideOnError
										/>
									{/if}
								</span>
								<span class="version-copy">
									<strong>{versionLabel(version, index)}</strong>
									<small class:error={version.phase === 'failed'}>{versionMeta(version)}</small>
								</span>
								<span class="version-open">{version.phase === 'failed' ? 'Retry' : 'View'}</span>
							</button>
						</li>
					{/each}
				</ul>
				<div class="stub">Artwork is shown only to help recognize a row.</div>
			{:else if sheet.phase === 'loading-detail'}
				<div class="tl">
					<p class="status" data-testid="unified-album-detail-loading">Loading {selectedVersion && (sheet.versions.length > 1 || selectedVersion.editionText) ? versionLabel(selectedVersion, sheet.versions.indexOf(selectedVersion)) : 'album'}…</p>
				</div>
				<div class="stub">Loading this version's exact track list.</div>
			{:else if sheet.phase === 'details'}
				{#if selectedVersion}
					<div class="version-heading" data-testid="unified-album-selected-version">
						{#if sheet.versions.length > 1 || selectedVersion.editionText}
							<strong>{versionLabel(selectedVersion, sheet.versions.indexOf(selectedVersion))}</strong>
						{/if}
					<span>{versionFacts(selectedVersion).join(' · ')}</span>
					</div>
				{/if}
				<ol class="tl tracks" data-testid="unified-album-tracks" start={page * PAGE_SIZE + 1} bind:this={trackList}>
					{#each pageTracks as track, offset (track.index)}
						<li
							class="tr"
							class:song-focus={track.index === focusedTrackIndex}
							data-testid="unified-track-row-{track.index}"
							data-song-highlight={track.index === focusedTrackIndex ? 'true' : undefined}
						>
							{#if !suppressRowIndex}<span class="tn mono">{page * PAGE_SIZE + offset + 1}</span>{/if}
							<span class="tnm">{track.title}</span>
							{#if onOpenTrackInfo && (sheet.live != null || sheet.versions.length === 1)}
								{@const href = hrefForTrack?.(track.title) ?? null}
								<svelte:element
									this={href === null ? 'button' : 'a'}
									role={href === null ? 'button' : 'link'}
									type={href === null ? 'button' : undefined}
									{href}
									class="tinfo"
									data-testid="unified-track-info-{track.index}"
									onclick={(event: MouseEvent) =>
										followTrackInfo(event, href, page * PAGE_SIZE + offset, track.title)}
								>Info</svelte:element>
							{/if}
							<button
								type="button"
								class="tgo"
								data-testid="unified-track-action-{track.index}"
								disabled={!sheet.actionsAvailable || actionBusy || zoneId === null}
								onclick={() => pickTarget({ index: track.index, title: track.title }, 'play-now')}
							>Play</button>
							<button
								type="button"
								class="tq"
								data-testid="unified-track-queue-{track.index}"
								disabled={!sheet.actionsAvailable || actionBusy || zoneId === null}
								onclick={() => pickTarget({ index: track.index, title: track.title }, 'queue')}
							>Queue</button>
						</li>
					{/each}
				</ol>

				{#if pageCount > 1}
					<nav class="pager" data-testid="unified-album-pager" aria-label="Track pages">
						<button type="button" disabled={page === 0} onclick={() => (page = Math.max(0, page - 1))}>Previous</button>
						<span class="page-label">Page {page + 1} of {pageCount}</span>
						<button type="button" disabled={page >= pageCount - 1} onclick={() => (page = Math.min(pageCount - 1, page + 1))}>Next</button>
					</nav>
				{/if}
					{#if sheet.live != null || sheet.versions.length === 1}
						{#if trackInfo !== null}
							<!-- Exact-track child view (Slice 5): the page's OWN exact track
							     title, which is what the address names, and the way back to
							     the album's own view. -->
							<section class="track-child" data-testid="unified-album-track-info">
								<h3>{trackInfo.title}</h3>
								<button
									type="button"
									class="follow-back"
									data-testid="unified-album-track-info-back"
									onclick={closeTrackInfo}
								>
									Back to album info
								</button>
							</section>
						{/if}
					{/if}
				<div class="stub">{sheet.orderedTracks.length} tracks loaded from your Core.</div>
			{/if}
		</div>
	</div>
</UnifiedItemPageFrame>

<style>
	.item-page-body {
		display: flex;
		gap: 22px;
		min-height: 0;
		margin-top: 12px;
	}
	/* The shared hero-art rules are scoped to the retired modal's .panel
	   ancestor; the page carries its own (ri1-5). */
	.item-page-body .art {
		position: relative;
		width: 196px;
		height: 196px;
		border-radius: 4px;
		overflow: hidden;
		background: var(--songr-surface-11);
		/* Same art chrome as the scope-view tiles (q6): soft drop shadow
		   plus a 1px keyline. */
		box-shadow:
			0 6px 16px rgba(0, 0, 0, 0.6),
			0 0 0 1px var(--line-subtle);
	}
	.item-page-body .art img {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.item-page-body .art .mono-tile {
		display: grid;
		width: 100%;
		height: 100%;
		place-items: center;
		font-size: 48px;
		color: var(--soft);
	}
	.status {
		margin: 0;
		opacity: 0.75;
		font-size: 13px;
	}
	.status.error,
	.version-copy small.error {
		opacity: 1;
		color: var(--error, #e66);
	}
	.degraded-notice {
		margin: 8px 0 0;
		padding: 7px 10px;
		border: 1px solid var(--line-subtle);
		border-radius: 6px;
		background: var(--songr-surface-11);
		color: var(--soft);
		font-size: 12px;
	}
	.album-tabs {
		display: flex;
		gap: 4px;
		border-bottom: 1px solid var(--line-subtle);
	}
	.album-tabs button {
		padding: 8px 12px;
		border: 0;
		border-bottom: 2px solid transparent;
		background: transparent;
		color: var(--soft);
		cursor: pointer;
	}
	.album-tabs button.on {
		border-bottom-color: var(--accent);
		color: var(--songr-control-text);
	}
	.album-tabs button:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.version-list {
		list-style: none;
		padding-left: 0;
		margin-bottom: 0;
	}
	.version-list li + li {
		margin-top: 7px;
	}
	.version-row {
		display: flex;
		align-items: center;
		gap: 12px;
		width: 100%;
		padding: 9px;
		border: 1px solid var(--line-subtle);
		border-radius: 8px;
		background: var(--songr-surface-11);
		color: inherit;
		text-align: left;
		cursor: pointer;
	}
	.version-row:hover,
	.version-row.selected {
		border-color: var(--accent);
		background: var(--hover-subtle);
	}
	.version-row.failed {
		border-color: color-mix(in srgb, var(--error, #e66) 55%, var(--line-subtle));
	}
	.version-art {
		position: relative;
		width: 50px;
		height: 50px;
		flex: 0 0 50px;
		overflow: hidden;
		border-radius: 4px;
		background: var(--songr-surface-16);
		/* 1px keyline, matching the tile art chrome at thumbnail size (q6). */
		box-shadow: 0 0 0 1px var(--line-subtle);
	}
	.version-art img {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.version-mono {
		display: grid;
		width: 100%;
		height: 100%;
		place-items: center;
		color: var(--soft);
	}
	.version-copy {
		display: flex;
		min-width: 0;
		flex: 1;
		flex-direction: column;
		gap: 4px;
	}
	.version-copy strong {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.version-copy small,
	.version-open {
		color: var(--soft);
		font-size: 11px;
	}
	.version-heading {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
		margin-top: 14px;
	}
	.version-heading span {
		color: var(--soft);
		font-size: 11px;
	}
	.action-choices {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		margin-top: 12px;
	}
	.tracks {
		list-style: none;
		margin-bottom: 0;
		padding-left: 0;
	}
	.tr.song-focus {
		border-color: color-mix(in srgb, var(--accent) 70%, transparent);
		background: color-mix(in srgb, var(--accent) 18%, var(--songr-surface-11));
		box-shadow: inset 3px 0 0 var(--accent);
	}
	.pager {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-top: 8px;
	}
	.page-label {
		font-size: 12px;
		opacity: 0.7;
	}
	.ghost {
		opacity: 0.7;
	}
	.retry {
		margin-top: 12px;
	}
	.track-child {
		margin-top: 18px;
	}
	/* Child identity heading (q6): the child title reads as identity, not a
	   section label. */
	.track-child h3 {
		margin: 0 0 6px;
		font-size: 15px;
		font-weight: 600;
	}
	.follow-back {
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--accent);
		font-size: 12px;
		cursor: pointer;
	}
	.follow-back:hover {
		color: var(--accent2);
	}
	.tinfo {
		padding: 2px 8px;
		border: 1px solid var(--line-subtle);
		border-radius: 5px;
		background: transparent;
		color: var(--soft);
		font-size: 11px;
		cursor: pointer;
		text-decoration: none;
	}
	.tinfo:hover {
		border-color: var(--accent);
		color: var(--songr-control-text);
	}
</style>
