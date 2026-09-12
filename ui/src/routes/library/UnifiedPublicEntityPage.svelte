<script lang="ts">
	import type { BrowseItem, AddFavoriteRequest } from '@shared/types';
	import { bookmarkPayload } from '$lib/bookmarks';
	import BookmarkButton from '$lib/components/BookmarkButton.svelte';
	import EntityActionMenu from '$lib/components/EntityActionMenu.svelte';
	import EntityFeedback from '$lib/components/EntityFeedback.svelte';
	import type { LibraryAlbumTrack } from '@shared/libraryAlbumContracts';
	import type { AlbumActionSemantic } from '@shared/albumActionContracts';
	import type { UnifiedBrowseState } from '$lib/library/UnifiedBrowseController';
	import { classifyBrowsePage, type BrowseRowActions } from '$lib/library/browsePresentation';
	import { librarySortKey, type LibraryAlbumEntry, type LibraryArtistEntry } from '$lib/libraryEntries';
	import type { UnifiedArtistDrillSort } from '$lib/stores/unifiedLibraryPrefsStore';
	import { artistDrillSortMenu } from '$lib/unifiedLibrarySorts';
	import LibrarySortMenu from './LibrarySortMenu.svelte';
	import UnifiedAlbumPage from './UnifiedAlbumPage.svelte';
	import UnifiedArtistPage from './UnifiedArtistPage.svelte';
	import UnifiedScopeViews from './UnifiedScopeViews.svelte';

	let {
		state: browseState,
		kind,
		onBack,
		onItem,
		hrefForItem,
		actions,
		onBookmark,
		bookmarkBusy = false,
		bookmarkStatus = null,
		albumSort = 'az',
		randomSeed = 1,
		groupByLetter = false,
		onSetAlbumSort,
		onSetGroupByLetter
	}: {
		state: UnifiedBrowseState;
		kind: 'artist' | 'album';
		onBack: () => void;
		onItem: (item: BrowseItem) => void;
		hrefForItem: (item: BrowseItem) => string | null;
		actions: BrowseRowActions;
		onBookmark?: (items: readonly AddFavoriteRequest[]) => void;
		bookmarkBusy?: boolean;
		bookmarkStatus?: string | null;
		albumSort?: UnifiedArtistDrillSort;
		randomSeed?: number;
		groupByLetter?: boolean;
		onSetAlbumSort?: (sort: UnifiedArtistDrillSort) => void;
		onSetGroupByLetter?: (enabled: boolean) => void;
	} = $props();

	const result = $derived(browseState.result);
	const presentation = $derived(classifyBrowsePage(browseState));
	const selected = $derived(browseState.snapshot.history.at(-1)?.breadcrumb);
	const title = $derived(result?.title ?? selected?.title ?? (kind === 'album' ? 'Album' : 'Artist'));
	const subtitle = $derived(result?.subtitle ?? selected?.subtitle ?? null);
	const imageKey = $derived(selected?.imageKey);
	const backLabel = $derived(browseState.snapshot.history.at(-2)?.breadcrumb.title ?? 'Library');
	const ready = $derived(browseState.phase === 'ready' && !result?.isError && result?.message === undefined);
	const failure = $derived(browseState.error ?? (result?.isError ? result.message ?? 'This page could not be loaded.' : null));
	const wholeAlbumItem = $derived(presentation.bulkItems.length === 1 ? presentation.bulkItems[0] : undefined);
	let activeBulkItem: BrowseItem | undefined = $state();
	const tracks = $derived(presentation.contentItems.map((item, index) => ({ index, title: item.title })));
	const trackSources = $derived(new Map<LibraryAlbumTrack, BrowseItem>(tracks.map((track, index) => [track, presentation.contentItems[index]])));
	const albumPhase = $derived(failure && !result ? 'failed' : result ? 'details' : 'opening');

	// These entries are display rows only. The map retains the exact source objects;
	// neither their render keys nor their titles are library navigation authority.
	const albums = $derived(presentation.contentItems.map((item, index): LibraryAlbumEntry => ({
		id: `public-album-${index}`,
		title: item.title,
		artist: item.subtitle ?? '',
		searchKey: librarySortKey(item.title),
		...(item.imageKey ? { imageKey: item.imageKey } : {})
	})));
	const albumSources = $derived(new Map(albums.map((entry, index) => [entry, presentation.contentItems[index]])));
	const artist = $derived<LibraryArtistEntry>({
		id: 'public-artist', name: title, searchKey: librarySortKey(title),
		...(imageKey ? { imageKey } : {})
	});

	function bookmarkEntity(): void {
		const entityTitle = result?.title ?? selected?.title;
		if (!onBookmark || bookmarkBusy || !ready || !entityTitle?.trim()) return;
		onBookmark([bookmarkPayload(kind, {
			title: entityTitle, artist: kind === 'album' ? subtitle : undefined, imageKey
		})]);
	}

	function openAlbum(entry: LibraryAlbumEntry): void {
		const item = albumSources.get(entry);
		if (ready && item?.itemKey) onItem(item);
	}

	function hrefForAlbum(entry: LibraryAlbumEntry): string | null {
		const item = albumSources.get(entry);
		return ready && item?.itemKey ? hrefForItem(item) : null;
	}

	function playWholeAlbum(): void {
		const item = wholeAlbumItem;
		if (!ready || !actions.enabled || actions.busy || !item?.itemKey) return;
		actions.onAction(item, 'play-now');
	}
	function openEntityMore(): void {
		activeBulkItem = wholeAlbumItem;
		if (activeBulkItem) actions.onMore(activeBulkItem);
	}
	function openTrackMore(selectedTracks: LibraryAlbumTrack[]): void {
		const item = selectedTracks.length === 1 ? trackSources.get(selectedTracks[0]) : undefined;
		if (item) actions.onMore(item);
	}
	function beginTracks(selectedTracks: readonly LibraryAlbumTrack[], semantic: AlbumActionSemantic): void {
		if (semantic !== 'play-now' && semantic !== 'add-next' && semantic !== 'queue') return;
		if (!ready || !actions.enabled || actions.busy) return;
		const items: BrowseItem[] = [];
		for (const track of selectedTracks) {
			const item = trackSources.get(track);
			if (!item) return;
			items.push(item);
		}
		actions.onBatchAction?.(items, semantic);
	}
</script>

{#snippet remoteChoices(item: BrowseItem, close: () => void)}
	{@const menu = actions.menu?.item === item ? actions.menu : undefined}
	{@const busy = !menu || menu.state.phase === 'loading' || menu.state.phase === 'executing'}
	{#if busy}<span class="menu-status" role="status">{menu?.state.phase === 'executing' ? 'Working…' : 'Loading…'}</span>{/if}
	{#if menu?.state.error}<span class="menu-status" role="alert">{menu.state.error}</span>{/if}
	{#each menu?.state.actions ?? [] as choice}
		<button class="advertised-choice" type="button" role="menuitem" disabled={busy || !actions.enabled} onclick={() => menu?.onChoose(choice)}>{choice.title}</button>
	{/each}
	{#if menu?.state.phase === 'ready' && !menu.state.actions?.length}<span class="menu-status">No actions are available.</span>{/if}
{/snippet}

{#snippet entityMore(close: () => void)}
	{#if activeBulkItem}
		{@render remoteChoices(activeBulkItem, close)}
	{:else}
		{#each presentation.bulkItems as item}
			<button class="advertised-choice" type="button" role="menuitem" disabled={!ready || !actions.enabled || actions.busy || !item.itemKey}
				onclick={() => { activeBulkItem = item; actions.onMore(item); }}>{item.title}</button>
		{/each}
	{/if}
{/snippet}

{#snippet artistEntityActions()}
	{#if onBookmark}<BookmarkButton title="Bookmark artist" onclick={bookmarkEntity} disabled={bookmarkBusy || !ready || !title.trim()} />{/if}
	{#if presentation.bulkItems.length}
		<EntityActionMenu label="More actions for artist {title}" generation={result} disabled={!ready || !actions.enabled || actions.busy}
			onOpen={openEntityMore} onClose={actions.onCloseMore} remoteActive={Boolean(actions.menu && presentation.bulkItems.includes(actions.menu.item))}>
			{#snippet children(close)}{@render entityMore(close)}{/snippet}
		</EntityActionMenu>
	{/if}
{/snippet}

{#snippet artistControls()}
	{#if onSetAlbumSort}
		<LibrarySortMenu options={artistDrillSortMenu()} value={albumSort}
			onSort={(sort) => { if (sort === 'az' || sort === 'za' || sort === 'shuffle') onSetAlbumSort?.(sort); }}
			{groupByLetter} onGroupByLetter={onSetGroupByLetter} testId="unified-public-artist-sort" />
	{/if}
{/snippet}

{#snippet feedback()}
	{#if failure && (kind === 'artist' || result)}
		<p class="status error" role="alert">{failure}</p>
	{:else if result?.message}
		<p class="status" role="status">{result.message}</p>
	{:else if browseState.phase === 'loading' || browseState.phase === 'idle'}
		<p class="status" role="status">Loading…</p>
	{/if}
	{#if browseState.notice}<p class="notice">{browseState.notice}</p>{/if}
	{#if actions.status && actions.status !== bookmarkStatus}
		<EntityFeedback label={kind === 'album' ? 'Album status' : 'Artist status'} error={actions.error} message={actions.status} />
	{/if}
{/snippet}

{#snippet selectedTrackMore(selectedTracks: LibraryAlbumTrack[], close: () => void)}
	{@const item = selectedTracks.length === 1 ? trackSources.get(selectedTracks[0]) : undefined}
	{#if item}
		{@render remoteChoices(item, close)}
	{/if}
{/snippet}

{#if kind === 'album'}
	<UnifiedAlbumPage
		publicPage={{
			title, artist: subtitle, imageKey,
			phase: albumPhase, error: failure, tracks,
			feedback, onBatchAction: beginTracks,
			onPlayAlbum: wholeAlbumItem ? () => { const item = wholeAlbumItem; if (ready && actions.enabled && !actions.busy && item?.itemKey) actions.onAction(item, 'play-now'); } : undefined,
			albumActionsEnabled: ready && actions.enabled && Boolean(wholeAlbumItem?.itemKey),
			entityActionsEnabled: ready && actions.enabled,
			entityMore: presentation.bulkItems.length ? entityMore : undefined, onOpenEntityMore: openEntityMore,
			entityMenuActive: Boolean(actions.menu && presentation.bulkItems.includes(actions.menu.item)),
			selectionMore: selectedTrackMore, hasSelectionMore: true, selectionMenuActive: Boolean(actions.menu && presentation.contentItems.includes(actions.menu.item)), onOpenSelectionMore: openTrackMore, actionsEnabled: ready && actions.enabled && Boolean(actions.onBatchAction),
			busy: actions.busy, status: actions.status === bookmarkStatus ? null : actions.status, onCancel: actions.onCancel, onCloseMore: actions.onCloseMore
		}}
		{backLabel}
		{onBack}
		onBookmark={ready ? onBookmark : undefined}
		{bookmarkBusy}
		{bookmarkStatus}
	/>
{:else}
	<UnifiedArtistPage
		{artist}
		{albums}
		overlayPhase="idle"
		discographyKnown={ready}
		truncated={false}
		missingMessage={failure}
		{backLabel}
		{onBack}
		headerExtra={artistControls}
		entityActions={artistEntityActions}
		{bookmarkStatus}
	>
		{#snippet discography()}
			{@render feedback()}
			<UnifiedScopeViews
				scope="albums"
				artists={[]}
				{albums}
				sorts={{ artists: 'az', albums: albumSort, genres: 'az' }}
				{randomSeed}
				groupByLetter={groupByLetter && (albumSort === 'az' || albumSort === 'za')}
				railTarget={null}
				genres={{ entries: [], totalCount: 0, loading: false, loaded: true, error: null }}
				recent={{ entries: [], loading: false, loaded: true }}
				onOpenLiveAlbum={ready ? openAlbum : undefined}
				{hrefForAlbum}
				albumTestId="unified-public-album"
			/>
		{/snippet}
	</UnifiedArtistPage>
{/if}

<style>
 .advertised-choice { border: 0; border-radius: 3px; background: transparent; color: var(--songr-accent); font: inherit;
  font-size: 12px; padding: 8px 10px; min-height: 36px; text-align: left; cursor: pointer; }
 .advertised-choice:hover:not(:disabled) { background: var(--songr-hover-subtle); }
 .advertised-choice:focus-visible { outline: 2px solid var(--songr-accent); outline-offset: -2px; }
 .advertised-choice:disabled { color: var(--songr-dim); cursor: default; }
 :global([data-density="compact"]) .advertised-choice { min-height: 32px; }
 :global([data-density="pi"]) .advertised-choice { min-height: 44px; }
 @media (any-pointer: coarse) { .advertised-choice, :global([data-density="compact"]) .advertised-choice { min-height: 44px; } }
</style>
