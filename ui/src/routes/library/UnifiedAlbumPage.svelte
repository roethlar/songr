<script lang="ts">
	import { tick } from 'svelte';
	import type { AlbumActionSemantic } from '@shared/albumActionContracts';
	import { normalizeCatalogText } from '@shared/catalogContracts';
	import { imageUrl } from '$lib/imageUrl';
	import { trackTitleCarriesOrdinal } from '$lib/trackTitle';
	import type {
		LibraryAlbumController,
		LibraryAlbumVersionState
	} from '$lib/library/LibraryAlbumController';
	import type { LibraryAlbumEntry } from '$lib/stores/libraryIndexStore';
	import type { AlbumActionController } from '$lib/library/AlbumActionController';
	import type { EditorialItemState } from '$lib/library/EditorialItemController';
	import EditorialCreditsSection from './EditorialCreditsSection.svelte';
	import EditorialRelationshipSection from './EditorialRelationshipSection.svelte';
	import EditorialTextSection from './EditorialTextSection.svelte';
	import UnifiedItemPageFrame from './UnifiedItemPageFrame.svelte';

	interface ZoneOption {
		readonly zoneId: string;
		readonly name: string;
	}

	type PageTrackTarget = { readonly index: number; readonly title: string };

	interface PendingActionTarget {
		readonly track: PageTrackTarget | null;
		readonly desiredSemantic: AlbumActionSemantic;
	}

	interface Props {
		controller: LibraryAlbumController;
		actionController: AlbumActionController;
		zones: readonly ZoneOption[];
		album?: LibraryAlbumEntry | null;
		focusSongTitle?: string | null;
		backLabel: string;
		onBack: () => void;
		onRetry: () => void;
		onBeginAction: (
			track: PageTrackTarget | null,
			zoneId: string,
			desiredSemantic: AlbumActionSemantic
		) => void;
		onOpenArtist?: () => void;
		/** Optional editorial enrichment (plan Slice 3); null renders nothing. */
		editorial?: EditorialItemState | null;
		onEditorialRetry?: () => void;
		/** Credit-performer navigation (plan Slice 4); opaque targets only. */
		onEditorialFollow?: (target: string) => void;
		/** Returns from a followed performer to the album's own view. */
		onEditorialBack?: () => void;
		/** True while the live editorial destination is a followed child. */
		editorialFollowActive?: boolean;
		/**
		 * Opens exact-track credits for a ZERO-BASED position in this
		 * version's ordered tracks (plan Slice 5). Offered only on
		 * single-version pages — the exact album/version/index binding.
		 */
		onOpenTrackInfo?: (trackPosition: number) => void;
		/**
		 * A restored exact-track child index (Slice 8): consumed once when
		 * the single-version track order arrives; a stale index keeps the
		 * parent page (session-bound restoration rule).
		 */
		initialTrackInfoIndex?: number | null;
	}

	const {
		controller,
		actionController,
		zones,
		album = null,
		focusSongTitle = null,
		backLabel,
		onBack,
		onRetry,
		onBeginAction,
		onOpenArtist,
		editorial = null,
		onEditorialRetry = () => {},
		onEditorialFollow = () => {},
		onEditorialBack = () => {},
		editorialFollowActive = false,
		onOpenTrackInfo = undefined,
		initialTrackInfoIndex = null
	}: Props = $props();

	const PAGE_SIZE = 100;

	let page = $state(0);
	let trackList: HTMLOListElement | null = $state(null);
	let actionTarget = $state<PendingActionTarget | undefined>(undefined);
	/**
	 * The live public track target (ri5-2): the child view renders from
	 * the page's own exact data immediately; editorial credits only
	 * layer on top when they arrive.
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

	$effect(() => {
		void sheet.selectedVersionId;
		void sheet.orderedTracks;
		const focusPosition = focusedTrackPosition;
		page = focusPosition >= 0 ? Math.floor(focusPosition / PAGE_SIZE) : 0;
		actionTarget = undefined;
		trackInfo = null;
		if (focusPosition >= 0) {
			void tick().then(() => {
				trackList
					?.querySelector<HTMLElement>('[data-song-highlight="true"]')
					?.scrollIntoView?.({ block: 'center' });
			});
		}
	});

	function monogram(title: string): { style: string; letter: string } {
		const word = title.replace(/^(the |a |an )/i, '').trim() || '?';
		let hash = 0;
		for (const character of word) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
		return {
			style: `background:linear-gradient(150deg,hsl(${hash % 360},14%,20%),hsl(${(hash + 40) % 360},12%,11%))`,
			letter: (word[0] ?? '?').toUpperCase()
		};
	}

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
		if (!sheet.actionsAvailable || actionBusy || zones.length === 0) return;
		if (zones.length === 1) {
			onBeginAction(track, zones[0].zoneId, desiredSemantic);
			actionTarget = undefined;
			return;
		}
		actionTarget = { track, desiredSemantic };
	}

	function chooseZone(zoneId: string): void {
		if (!sheet.actionsAvailable || actionTarget === undefined) return;
		onBeginAction(actionTarget.track, zoneId, actionTarget.desiredSemantic);
		actionTarget = undefined;
	}

	function openTrackInfo(position: number, title: string): void {
		trackInfo = { position, title };
		onOpenTrackInfo?.(position);
	}

	function closeTrackInfo(): void {
		trackInfo = null;
		onEditorialBack();
	}

	// Restores a persisted exact-track child (Slice 8). The index is
	// honored only when it resolves inside the loaded single-version track
	// order — anything stale keeps the parent page (the session-bound
	// restoration rule).
	$effect(() => {
		if (initialTrackInfoIndex === null || trackInfo !== null) return;
		if (sheet.versions.length !== 1 || onOpenTrackInfo === undefined) return;
		const track = sheet.orderedTracks[initialTrackInfoIndex];
		if (track === undefined) return;
		openTrackInfo(initialTrackInfoIndex, track.title);
	});

	function zonePrompt(target: PendingActionTarget): string {
		const verb =
			target.desiredSemantic === 'queue'
				? 'Queue'
				: target.desiredSemantic === 'add-next'
					? 'Add next'
					: 'Play';
		return target.track === null
			? `${verb} album on`
			: `${verb} “${target.track.title}” on`;
	}
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
				{#if displayImageKey}
					<img
						src={imageUrl(displayImageKey, { scale: 'fit', width: 300, height: 300 })}
						alt=""
						loading="lazy"
					/>
				{:else}
					{@const fallback = monogram(displayTitle)}
					<div class="mono-tile" style={fallback.style}>{fallback.letter}</div>
				{/if}
			</div>
			<div class="pb">
				<button
					type="button"
					data-testid="unified-album-play"
					disabled={!sheet.actionsAvailable || sheet.phase !== 'details' || actionBusy || zones.length === 0}
					onclick={() => pickTarget(null, 'play-now')}
				>
					Play album
				</button>
				<button
					type="button"
					data-testid="unified-album-queue"
					disabled={!sheet.actionsAvailable || sheet.phase !== 'details' || actionBusy || zones.length === 0}
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

			{#if actionTarget !== undefined && zones.length > 1}
				<div class="zone-picker" data-testid="unified-album-zone-picker">
					<span class="zone-label">{zonePrompt(actionTarget)}</span>
					{#each zones as zone (zone.zoneId)}
						<button type="button" onclick={() => chooseZone(zone.zoneId)}>{zone.name}</button>
					{/each}
					<button type="button" class="ghost" onclick={() => (actionTarget = undefined)}>Cancel</button>
				</div>
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
				<p class="status error" data-testid="unified-album-action-error">{action.error ?? 'The action failed.'}</p>
			{/if}

			{#if sheet.phase === 'opening'}
				<div class="tl">
					<p class="status" data-testid="unified-album-loading">Opening album page…</p>
				</div>
				<div class="stub">Finding the versions Roon currently exposes.</div>
			{:else if sheet.phase === 'failed' || sheet.phase === 'canceled'}
				<div class="tl">
					<p class="status error" data-testid="unified-album-error">{sheet.error ?? 'The album page could not be opened.'}</p>
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
									{#if version.imageKeyHint}
										<img src={imageUrl(version.imageKeyHint, { scale: 'fit', width: 96, height: 96 })} alt="" loading="lazy" />
									{:else}
										<span class="version-mono">{versionLabel(version, index).slice(0, 1)}</span>
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
					<p class="status" data-testid="unified-album-detail-loading">Loading {selectedVersion ? versionLabel(selectedVersion, sheet.versions.indexOf(selectedVersion)) : 'version'}…</p>
				</div>
				<div class="stub">Loading this version's exact track list.</div>
			{:else if sheet.phase === 'details'}
				{#if selectedVersion}
					<div class="version-heading" data-testid="unified-album-selected-version">
						<strong>{versionLabel(selectedVersion, sheet.versions.indexOf(selectedVersion))}</strong>
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
							{#if onOpenTrackInfo && sheet.versions.length === 1}
								<button
									type="button"
									class="tinfo"
									data-testid="unified-track-info-{track.index}"
									onclick={() => openTrackInfo(page * PAGE_SIZE + offset, track.title)}
								>Info</button>
							{/if}
							<button
								type="button"
								class="tgo"
								data-testid="unified-track-action-{track.index}"
								disabled={!sheet.actionsAvailable || actionBusy || zones.length === 0}
								onclick={() => pickTarget({ index: track.index, title: track.title }, 'play-now')}
							>Play</button>
							<button
								type="button"
								class="tq"
								data-testid="unified-track-queue-{track.index}"
								disabled={!sheet.actionsAvailable || actionBusy || zones.length === 0}
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
				{#if sheet.versions.length === 1}
					<!-- The editorial read is bound to the crosswalked catalog anchor
					     identity; only a single-version page can attribute that prose
					     honestly to what the user is looking at (ri3-1). Multi-version
					     pages render no editorial surface until version-exact
					     editorial identity exists. -->
					{#if editorialFollowActive && editorial?.view?.kind === 'album'}
						<!-- A followed similar album (Slice 7): the child's own
						     native identity heading, review, and display-only
						     credits. Parent and child share kind 'album', so the
						     live follow state — not the view kind — is the gate. -->
						<section class="editorial" data-testid="unified-album-similar-album">
							<h3>{editorial.view.title}</h3>
							{#if editorial.view.subtitle}
								<p class="child-subtitle">{editorial.view.subtitle}</p>
							{/if}
							<button
								type="button"
								class="follow-back"
								data-testid="unified-album-similar-album-back"
								onclick={onEditorialBack}
							>
								Back to album info
							</button>
						</section>
						<EditorialTextSection
							heading="Review"
							section="review"
							{editorial}
							testId="unified-album-similar-review"
							onRetry={onEditorialRetry}
						/>
						<EditorialCreditsSection
							{editorial}
							testId="unified-album-similar-credits"
							onFollow={onEditorialFollow}
						/>
					{:else if trackInfo !== null && editorial?.view?.kind !== 'artist'}
						<!-- Exact-track child view (Slice 5, ri5-2): the heading is
						     the page's OWN exact track title — public data first;
						     the settled graph's role-grouped credits layer on only
						     when the enrichment arrives. -->
						<section class="editorial" data-testid="unified-album-track-info">
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
						<EditorialTextSection
							heading="About the composition"
							section="description"
							{editorial}
							testId="unified-album-track-description"
							onRetry={onEditorialRetry}
						/>
						<EditorialCreditsSection
							{editorial}
							kind="track"
							testId="unified-album-track-credits"
							onFollow={onEditorialFollow}
						/>
					{:else if editorial?.view?.kind === 'artist'}
						<!-- A followed credit performer (Slice 4): identity heading,
						     biography, and the way back to the album's own view. -->
						<section class="editorial" data-testid="unified-album-credit-performer">
							<h3>{editorial.view.title}</h3>
							<button
								type="button"
								class="follow-back"
								data-testid="unified-album-credit-performer-back"
								onclick={onEditorialBack}
							>
								<!-- The control names the real destination (ri5-4): a
								     performer followed from track credits backs out to
								     those credits, not to the album view. -->
								{trackInfo !== null ? 'Back to track credits' : 'Back to album info'}
							</button>
						</section>
						<EditorialTextSection
							heading="Biography"
							section="biography"
							{editorial}
							testId="unified-album-performer-biography"
							onRetry={onEditorialRetry}
						/>
					{:else}
						<EditorialTextSection
							heading="Review"
							section="review"
							{editorial}
							testId="unified-album-review"
							onRetry={onEditorialRetry}
						/>
						<EditorialCreditsSection
							{editorial}
							testId="unified-album-credits"
							onFollow={onEditorialFollow}
						/>
						<EditorialRelationshipSection
							{editorial}
							kind="album"
							testId="unified-album-related"
							onFollow={onEditorialFollow}
						/>
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
		width: 196px;
		height: 196px;
		border-radius: 4px;
		overflow: hidden;
		background: var(--songr-surface-11);
	}
	.item-page-body .art img {
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
		width: 50px;
		height: 50px;
		flex: 0 0 50px;
		overflow: hidden;
		border-radius: 4px;
		background: var(--songr-surface-16);
	}
	.version-art img {
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
	.zone-picker,
	.action-choices {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		margin-top: 12px;
	}
	.zone-label {
		font-size: 13px;
		opacity: 0.75;
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
	.editorial {
		margin-top: 18px;
	}
	.editorial h3 {
		margin: 0 0 6px;
		font-size: 12px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--soft);
	}
	.follow-back {
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--accent);
		font-size: 12px;
		cursor: pointer;
	}
	.child-subtitle {
		margin: 0 0 4px;
		font-size: 12px;
		color: var(--soft);
	}
	.tinfo {
		padding: 2px 8px;
		border: 1px solid var(--line-subtle);
		border-radius: 5px;
		background: transparent;
		color: var(--soft);
		font-size: 11px;
		cursor: pointer;
	}
	.tinfo:hover {
		border-color: var(--accent);
		color: var(--songr-control-text);
	}
</style>
