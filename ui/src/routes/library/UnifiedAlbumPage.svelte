<script lang="ts">
	import { tick, untrack, type Snippet } from 'svelte';
	import { readable } from 'svelte/store';
	import type { LibraryAlbumTrack } from '@shared/libraryAlbumContracts';
	import type { AddFavoriteRequest } from '@shared/types';
	import { bookmarkPayload, albumTrackBookmarkPayload } from '$lib/bookmarks';
	import BookmarkButton from '$lib/components/BookmarkButton.svelte';
	import ArtworkPlay from '$lib/components/ArtworkPlay.svelte';
	import EntityActionMenu from '$lib/components/EntityActionMenu.svelte';
	import EntityFeedback from '$lib/components/EntityFeedback.svelte';
	import LibraryActionButton from '$lib/components/LibraryActionButton.svelte';
	import type { AlbumActionSemantic } from '@shared/albumActionContracts';
	import { prepareLibraryGrid } from '$lib/preparedLibraryGrid';
	import { createTrackSelection } from '$lib/trackSelection';
	import { normalizeLibraryText } from '@shared/libraryText';
	import { imageUrl } from '$lib/imageUrl';
	import { monogram } from '$lib/monogram';
	import { libraryArtwork } from '$lib/actions/libraryArtwork';
	import type {
		LibraryAlbumController,
		LibraryAlbumState,
		LibraryAlbumVersionState
	} from '$lib/library/LibraryAlbumController';
	import type { LibraryAlbumEntry } from '$lib/libraryEntries';
	import type { AlbumActionController, AlbumActionState } from '$lib/library/AlbumActionController';
	import UnifiedItemPageFrame from './UnifiedItemPageFrame.svelte';
	import TrackSelectionControls from './TrackSelectionControls.svelte';

	type PageTrackTarget = { readonly index: number; readonly title: string };

	/** Public Browse supplies display data and controls without library references. */
	interface PublicAlbumPresentation {
		title: string;
		artist: string | null;
		imageKey?: string;
		phase: 'opening' | 'details' | 'failed';
		error?: string | null;
		tracks: readonly LibraryAlbumTrack[];
		onPlayAlbum?: () => void;
		albumActionsEnabled: boolean;
		entityActionsEnabled: boolean;
		entityMore?: Snippet<[() => void]>;
		onOpenEntityMore?: () => void;
		entityMenuActive?: boolean;
		onBatchAction: (tracks: readonly LibraryAlbumTrack[], semantic: AlbumActionSemantic) => void;
		selectionMore?: Snippet<[LibraryAlbumTrack[], () => void]>;
		hasSelectionMore?: boolean;
		selectionMenuActive?: boolean;
		onOpenSelectionMore?: (tracks: LibraryAlbumTrack[]) => void;
		actionsEnabled: boolean;
		busy: boolean;
		status?: string | null;
		onCancel?: () => void;
		onCloseMore?: () => void;
		feedback?: Snippet;
		footer?: Snippet;
	}

	type AlbumDisplayState = Pick<LibraryAlbumState,
		'phase' | 'activeTab' | 'title' | 'artist' | 'versions' |
		'selectedVersionId' | 'actionsAvailable' | 'albumActionsAvailable' |
		'orderedTracks' | 'live' | 'error'>;
	const emptyDisplay: AlbumDisplayState = {
		phase: 'idle', activeTab: 'details', title: null, artist: null,
		versions: [], selectedVersionId: null,
		actionsAvailable: false, albumActionsAvailable: false,
		orderedTracks: [], live: null, error: null
	};
	const emptyPageStore = readable(emptyDisplay);
	const emptyActionStore = readable<Pick<AlbumActionState, 'phase' | 'actions' | 'error'>>({
		phase: 'idle', actions: [], error: null
	});

	interface Props {
		controller?: LibraryAlbumController;
		actionController?: AlbumActionController;
		publicPage?: PublicAlbumPresentation;
		/**
		 * The zone every action on this page targets: the one the user has
		 * selected. `null` disables them. The page never asks which zone
		 * (public issue #12).
		 */
		zoneId?: string | null;
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
		onRetry?: () => void;
		actionRetryAvailable?: boolean;
		onRetryAction?: () => void;
		onBeginAction?: (
			track: PageTrackTarget | null,
			zoneId: string,
			desiredSemantic: AlbumActionSemantic | null
		) => void;
		onBeginBatchAction?: (tracks: readonly PageTrackTarget[], zoneId: string, semantic: AlbumActionSemantic) => void;
		batchBusy?: boolean;
		batchStatus?: string | null;
		onCancelBatch?: () => void;
		onBookmark?: (items: readonly AddFavoriteRequest[]) => void;
		bookmarkBusy?: boolean;
		bookmarkStatus?: string | null;
	}

	const {
		controller,
		actionController,
		publicPage,
		zoneId = null,
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
		onBeginBatchAction,
		batchBusy = false,
		batchStatus = null,
		onCancelBatch,
		onBookmark,
		bookmarkBusy = false,
		bookmarkStatus = null
	}: Props = $props();

	let trackList: HTMLElement | null = $state(null);
	const trackSelection = createTrackSelection<LibraryAlbumTrack>();
	const pageStore = $derived(controller ?? emptyPageStore);
	const actionStore = $derived(actionController ?? emptyActionStore);
	const sheet = $derived<AlbumDisplayState>(publicPage ? {
		...emptyDisplay,
		phase: publicPage.phase,
		title: publicPage.title,
		artist: publicPage.artist,
		orderedTracks: publicPage.tracks,
		error: publicPage.error ?? null
	} : $pageStore);
	const action = $derived($actionStore);
	const selectedVersion = $derived(
		sheet.versions.find((version) => version.versionId === sheet.selectedVersionId) ?? null
	);
	const focusedTrackPosition = $derived.by(() => {
		if (!focusSongTitle) return -1;
		const normalizedTitle = normalizeLibraryText(focusSongTitle);
		if (!normalizedTitle) return -1;
		const exactMatches: number[] = [];
		sheet.orderedTracks.forEach((track, position) => {
			if (normalizeLibraryText(track.title) === normalizedTitle) exactMatches.push(position);
		});
		if (exactMatches.length > 0) return exactMatches.length === 1 ? exactMatches[0] : -1;

		const ordinalMatches: number[] = [];
		sheet.orderedTracks.forEach((track, position) => {
			const withoutOrdinal = normalizeLibraryText(track.title).replace(/^\d+\.\s+/, '');
			if (withoutOrdinal === normalizedTitle) ordinalMatches.push(position);
		});
		return ordinalMatches.length === 1 ? ordinalMatches[0] : -1;
	});
	const focusedTrackIndex = $derived(
		focusedTrackPosition < 0 ? null : (sheet.orderedTracks[focusedTrackPosition]?.index ?? null)
	);
	const actionBusy = $derived(
		batchBusy || publicPage?.busy === true || action.phase === 'resolving' || action.phase === 'choosing' || action.phase === 'executing'
	);
	const albumActionsDisabled = $derived(publicPage
		? !publicPage.albumActionsEnabled || actionBusy
		: !sheet.albumActionsAvailable || sheet.phase !== 'details' || actionBusy || zoneId === null);
	const selectedActionsDisabled = $derived(publicPage
		? !publicPage.actionsEnabled || actionBusy
		: !sheet.actionsAvailable || actionBusy || zoneId === null || !onBeginBatchAction);
	const selectedActions = $derived([
		{ id: 'play', label: 'Play', disabled: selectedActionsDisabled, run: (tracks: LibraryAlbumTrack[]) => beginSelected(tracks, 'play-now') },
		{ id: 'next', label: 'Add next', disabled: selectedActionsDisabled, run: (tracks: LibraryAlbumTrack[]) => beginSelected(tracks, 'add-next') },
		{ id: 'queue', label: 'Queue', disabled: selectedActionsDisabled, run: (tracks: LibraryAlbumTrack[]) => beginSelected(tracks, 'queue') }
	]);
	$effect(() => { trackSelection.retain(sheet.phase === 'details' ? sheet.orderedTracks : [], sheet.orderedTracks); });
	$effect(() => { void activationGeneration; trackSelection.clear(); });
	$effect(() => { void $trackSelection; untrack(() => publicPage?.onCloseMore?.()); });
	const displayTitle = $derived(sheet.title ?? album?.title ?? 'Album');
	const displayArtist = $derived(sheet.artist ?? album?.artist ?? '');
	const displayImageKey = $derived(publicPage?.imageKey ?? selectedVersion?.imageKeyHint ?? album?.imageKey ?? null);
	// Permanent hero placeholder layer (q6): rendered beneath the image so
	// a failed load — hidden in place by libraryArtwork — reveals it.
	const heroFallback = $derived(monogram(displayTitle));

	$effect(() => {
		void sheet.selectedVersionId;
		void sheet.orderedTracks;
		void activationGeneration;
		const focusPosition = focusedTrackPosition;
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

	function versionFacts(version: LibraryAlbumVersionState): string[] {
		return version.trackCount === null ? [] : [
			`${version.trackCount} ${version.trackCount === 1 ? 'track' : 'tracks'}`
		];
	}

	function versionMeta(version: LibraryAlbumVersionState): string {
		if (version.phase === 'loading') return 'Loading details…';
		if (version.phase === 'failed') return version.error ?? 'Could not load this version.';
		return versionFacts(version).join(' · ') || 'Select for details';
	}

	function selectVersion(versionId: string): void {
		if (action.phase === 'executing') return;
		actionController?.cancel();
		actionController?.reset();
		controller?.select(versionId);
	}

	function pickTarget(
		track: PageTrackTarget | null,
		desiredSemantic: AlbumActionSemantic | null
	): void {
		// The guard matches the button that reaches it: a whole-album verb asks
		// the album-level answer, a track row asks the track-level one.
		// These capabilities may differ.
		const available = track === null ? sheet.albumActionsAvailable : sheet.actionsAvailable;
		if (!available || actionBusy || zoneId === null) return;
		onBeginAction?.(track, zoneId, desiredSemantic);
	}

	function beginSelected(tracks: readonly LibraryAlbumTrack[], semantic: AlbumActionSemantic): void {
		if (selectedActionsDisabled || !tracks.length || tracks.some(track => !sheet.orderedTracks.includes(track))) return;
		if (publicPage) publicPage.onBatchAction(tracks, semantic);
		else if (zoneId !== null) onBeginBatchAction?.(tracks, zoneId, semantic);
	}

	function bookmarkAlbum(): void {
		const title = sheet.title ?? album?.title;
		if (!onBookmark || bookmarkBusy || !title?.trim()) return;
		onBookmark([bookmarkPayload('album', { title, artist: displayArtist, imageKey: displayImageKey })]);
	}

	function bookmarkTracks(tracks: readonly LibraryAlbumTrack[]): void {
		if (!onBookmark || bookmarkBusy || sheet.phase !== 'details' || tracks.length === 0) return;
		const currentTracks = new Set(sheet.orderedTracks);
		if (tracks.some(track => !currentTracks.has(track) || !track.title.trim())) return;
		onBookmark(tracks.map(track => albumTrackBookmarkPayload(track, {
			artist: displayArtist, album: sheet.title ?? album?.title, imageKey: displayImageKey
		})));
	}

</script>

{#snippet headingActions()}
	{#if onBookmark}<BookmarkButton title="Bookmark album" onclick={bookmarkAlbum} disabled={bookmarkBusy || !(sheet.title ?? album?.title)?.trim()} />{/if}
	{#if publicPage?.entityMore || (!publicPage && sheet.albumActionsAvailable)}
		<EntityActionMenu label="More actions for album {displayTitle}" disabled={publicPage ? !publicPage.entityActionsEnabled || actionBusy : albumActionsDisabled} generation={sheet.orderedTracks}
			remoteActive={publicPage ? publicPage.entityMenuActive : !['idle', 'executed', 'canceled'].includes(action.phase)}
			onOpen={() => { if (publicPage) publicPage.onOpenEntityMore?.(); else pickTarget(null, null); }}
			onClose={() => { if (publicPage) publicPage.onCloseMore?.(); else if (action.phase === 'choosing' || action.phase === 'resolving') actionController?.cancel(); }}>
			{#snippet children(close)}
				{#if publicPage?.entityMore}{@render publicPage.entityMore(close)}{:else}
					{#if action.phase === 'resolving' || action.phase === 'executing'}<span class="menu-status" role="status">Working…</span>{/if}
					{#if action.error}<span class="menu-status" role="alert">{action.error}</span>{/if}
					{#each action.actions.filter(choice => choice.semantic !== 'play-now') as choice (choice.actionId)}
						{#if choice.semantic === 'other'}
							<button class="advertised-choice" type="button" role="menuitem" disabled={action.phase !== 'choosing'} onclick={() => actionController?.execute(choice.actionId)}>{choice.label}</button>
						{:else}
							<LibraryActionButton icon={choice.semantic === 'add-next' ? 'add-next' : 'queue'} label={choice.label} role="menuitem" disabled={action.phase !== 'choosing'} onclick={() => actionController?.execute(choice.actionId)} />
						{/if}
					{/each}
					{#if action.phase === 'choosing' && !action.actions.some(choice => choice.semantic !== 'play-now')}<span class="menu-status">No other actions are available.</span>{/if}
					{#if action.phase === 'failed' && actionRetryAvailable}<button class="advertised-choice" type="button" role="menuitem" onclick={onRetryAction}>Retry action</button>{/if}
				{/if}
			{/snippet}
		</EntityActionMenu>
	{/if}
{/snippet}

<UnifiedItemPageFrame
	label="Album page"
	heading={displayTitle}
	headingTestId="unified-album-title"
	{headingActions}
	{backLabel}
	backTestId="unified-album-back"
	{onBack}
>
	<div class="item-page-body" data-testid="unified-album-page">
		<div class="pleft">
			<ArtworkPlay label="Play album {displayTitle}" disabled={albumActionsDisabled} generation={sheet.orderedTracks}
				onclick={() => { if (publicPage) publicPage.onPlayAlbum?.(); else pickTarget(null, 'play-now'); }}>
			<div class="art">
				<!-- The monogram is the permanent placeholder layer (q6): a
				     failed image load hides the img in place — libraryArtwork keeps
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
						use:libraryArtwork={imageUrl(displayImageKey, { scale: 'fit', width: 300, height: 300 })}
						alt=""
						data-testid="unified-album-hero-image"
					/>
				{/if}
			</div>
			</ArtworkPlay>
		</div>

		<div class="pright">
			<div class="album-metadata">
				<div class="pa" data-testid="unified-album-artist" title={displayArtist}>{displayArtist}</div>
				<div class="album-selection">
					<TrackSelectionControls selection={trackSelection} orderedItems={sheet.orderedTracks} visibleItems={sheet.orderedTracks}
						actions={selectedActions} busy={actionBusy} status={publicPage?.status ?? batchStatus}
						onBookmark={onBookmark ? bookmarkTracks : undefined} bookmarkDisabled={bookmarkBusy || sheet.phase !== 'details'}
						onCancel={publicPage?.onCancel ?? onCancelBatch} label={track => track.title} more={publicPage?.selectionMore} hasMore={Boolean(publicPage?.hasSelectionMore && $trackSelection.count === 1)}
					onOpenMore={publicPage?.onOpenSelectionMore} onCloseMore={publicPage?.onCloseMore} remoteMenuActive={publicPage?.selectionMenuActive} />
				</div>
			</div>
			<EntityFeedback label="Album status" error={action.phase === 'failed' || action.phase === 'outcome-unknown'} message={bookmarkStatus ?? (action.phase === 'failed' || action.phase === 'outcome-unknown' ? action.error ?? 'The action failed.' : action.phase === 'executing' ? 'Working…' : null)} />


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
						onclick={() => controller?.showVersions()}
					>
						Versions{sheet.versions.length > 0 ? ` (${sheet.versions.length})` : ''}
					</button>
					<button
						type="button"
						class:on={sheet.activeTab === 'details'}
						data-testid="unified-album-tab-details"
						disabled={!sheet.selectedVersionId}
						onclick={() => controller?.showDetails()}
					>
						Details
					</button>
				</nav>
			{/if}

			{#if publicPage?.feedback}
				{@render publicPage.feedback()}
			{/if}

			{#if sheet.phase === 'opening'}
				<div class="tl">
					<p class="status" data-testid="unified-album-loading">Opening album page…</p>
				</div>
			{:else if sheet.phase === 'failed' || sheet.phase === 'canceled'}
				<div class="tl">
					<p class="status error" data-testid="unified-album-error">{collectionFailureMessage ??
							sheet.error ??
							'The album page could not be opened.'}</p>
					{#if onRetry}
						<button type="button" class="retry" onclick={onRetry} data-testid="unified-album-retry">Try again</button>
					{/if}
				</div>
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
											use:libraryArtwork={imageUrl(version.imageKeyHint, { scale: 'fit', width: 96, height: 96 })}
											alt=""
											data-testid="unified-album-version-art-{index}"
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
			{:else if sheet.phase === 'loading-detail'}
				<div class="tl">
					<p class="status" data-testid="unified-album-detail-loading">Loading {selectedVersion && (sheet.versions.length > 1 || selectedVersion.editionText) ? versionLabel(selectedVersion, sheet.versions.indexOf(selectedVersion)) : 'album'}…</p>
				</div>
			{:else if sheet.phase === 'details'}
				{#if selectedVersion}
					<div class="version-heading" data-testid="unified-album-selected-version">
						{#if sheet.versions.length > 1 || selectedVersion.editionText}
							<strong>{versionLabel(selectedVersion, sheet.versions.indexOf(selectedVersion))}</strong>
						{/if}
					<span>{versionFacts(selectedVersion).join(' · ')}</span>
					</div>
				{/if}

				<div role="list" class="tl tracks" class:public-tracks={Boolean(publicPage)} data-testid="unified-album-tracks" use:prepareLibraryGrid={[sheet.orderedTracks, activationGeneration]} bind:this={trackList}>
					{#each sheet.orderedTracks as track (track.index)}
						<div role="listitem"
							class="tr"
							class:song-focus={track.index === focusedTrackIndex}
							data-testid="unified-track-row-{track.index}"
							data-song-highlight={track.index === focusedTrackIndex ? 'true' : undefined}
							data-track-select-row
							use:trackSelection.row={{ item: track, ordered: () => sheet.orderedTracks, disabled: actionBusy, generation: sheet.orderedTracks }}
							>
							<button type="button" class="tnm" data-track-select-target aria-label="Select {track.title}" aria-pressed="false">{track.title}</button>
						</div>
					{/each}
				</div>

				{#if publicPage?.footer}
					{@render publicPage.footer()}
				{/if}
			{/if}
		</div>
	</div>
</UnifiedItemPageFrame>

<style>
 .advertised-choice { border: 0; border-radius: 3px; background: transparent; color: var(--songr-accent); font: inherit;
  font-size: 12px; padding: 8px 10px; min-height: 36px; text-align: left; cursor: pointer; }
 .advertised-choice:hover:not(:disabled) { background: var(--songr-hover-subtle); }
 .advertised-choice:focus-visible { outline: 2px solid var(--songr-accent); outline-offset: -2px; }
 .advertised-choice:disabled { color: var(--songr-dim); cursor: default; }
 :global([data-density="compact"]) .advertised-choice { min-height: 32px; }
 :global([data-density="pi"]) .advertised-choice { min-height: 44px; }
 @media (any-pointer: coarse) { .advertised-choice, :global([data-density="compact"]) .advertised-choice { min-height: 44px; } }

	.album-metadata { display: flex; align-items: center; gap: 12px; min-height: 48px; min-width: 0; position: sticky; top: var(--library-toolbar-top, 0px); z-index: 5; background: var(--bg); }
	.album-metadata .pa { flex: 0 1 auto; max-width: 45%; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 0; }
	.album-selection { flex: 1 0 160px; min-width: min-content; }
	.public-tracks {
		overflow: visible;
	}
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
	.tracks {
		list-style: none;
		margin-bottom: 0;
		padding-left: 0;
	}
	.tracks { display: grid; grid-template-columns: minmax(0, 1fr); --library-chunk-overflow: 280px; }
	.tr.song-focus {
		border-color: color-mix(in srgb, var(--accent) 70%, transparent);
		background: color-mix(in srgb, var(--accent) 18%, var(--songr-surface-11));
		box-shadow: inset 3px 0 0 var(--accent);
	}
	.retry {
		margin-top: 12px;
	}
	@media (max-width: 620px) { .item-page-body { flex-direction: column; } }
</style>
