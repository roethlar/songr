<script lang="ts">
	import type { BrowseItem } from '@shared/types';
	import type { UnifiedBrowseState } from '$lib/library/UnifiedBrowseController';
	import { classifyBrowsePage, type BrowseRowActions } from '$lib/library/browsePresentation';
	import { librarySortKey, type LibraryAlbumEntry, type LibraryArtistEntry } from '$lib/libraryEntries';
	import UnifiedAlbumPage from './UnifiedAlbumPage.svelte';
	import UnifiedArtistPage from './UnifiedArtistPage.svelte';
	import UnifiedBrowseRowControls from './UnifiedBrowseRowControls.svelte';
	import UnifiedScopeViews from './UnifiedScopeViews.svelte';

	let {
		state,
		kind,
		onBack,
		onItem,
		hrefForItem,
		onLoadMore,
		actions
	}: {
		state: UnifiedBrowseState;
		kind: 'artist' | 'album';
		onBack: () => void;
		onItem: (item: BrowseItem) => void;
		hrefForItem: (item: BrowseItem) => string | null;
		onLoadMore: () => void;
		actions: BrowseRowActions;
	} = $props();

	const result = $derived(state.result);
	const presentation = $derived(classifyBrowsePage(state));
	const selected = $derived(state.snapshot.history.at(-1)?.breadcrumb);
	const title = $derived(result?.title ?? selected?.title ?? (kind === 'album' ? 'Album' : 'Artist'));
	const subtitle = $derived(result?.subtitle ?? selected?.subtitle ?? null);
	const imageKey = $derived(selected?.imageKey);
	const backLabel = $derived(state.snapshot.history.at(-2)?.breadcrumb.title ?? 'Library');
	const ready = $derived(state.phase === 'ready' && !result?.isError && result?.message === undefined);
	const total = $derived(result?.totalCount ?? result?.count ?? 0);
	const canLoadMore = $derived(Boolean(result && result.items.length < total));
	const failure = $derived(state.error ?? (result?.isError ? result.message ?? 'This page could not be loaded.' : null));
	const tracks = $derived(presentation.contentItems.map((item, index) => ({ index, title: item.title })));
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

	function openAlbum(entry: LibraryAlbumEntry): void {
		const item = albumSources.get(entry);
		if (ready && item?.itemKey) onItem(item);
	}

	function hrefForAlbum(entry: LibraryAlbumEntry): string | null {
		const item = albumSources.get(entry);
		return ready && item?.itemKey ? hrefForItem(item) : null;
	}
</script>

{#snippet bulkControls()}
	{#each presentation.bulkItems as item}
		<div class="public-bulk" class:album-bulk={kind === 'album'} role="group" aria-label={item.title}>
			<button
				type="button"
				data-testid="unified-{kind}-play"
				disabled={!ready || !actions.enabled || actions.busy || !item.itemKey}
				onclick={() => actions.onAction(item, 'play-now')}
			>Play {kind}</button>
			<button
				type="button"
				data-testid="unified-{kind}-queue"
				disabled={!ready || !actions.enabled || actions.busy || !item.itemKey}
				onclick={() => actions.onAction(item, 'queue')}
			>Queue {kind}</button>
			<UnifiedBrowseRowControls {item} {actions} {ready} playable={false} prominent />
		</div>
	{/each}
{/snippet}

{#snippet feedback()}
	{#if failure && (kind === 'artist' || result)}
		<p class="status error" role="alert">{failure}</p>
	{:else if result?.message}
		<p class="status" role="status">{result.message}</p>
	{:else if state.phase === 'loading' || state.phase === 'idle'}
		<p class="status" role="status">Loading…</p>
	{/if}
	{#if state.notice}<p class="notice">{state.notice}</p>{/if}
	{#if actions.status}
		<p class="status" class:error={actions.error} role="status">{actions.status}</p>
	{/if}
{/snippet}

{#snippet footer()}
	{#if canLoadMore}
		<button type="button" class="load-more" disabled={state.phase === 'loading'} onclick={onLoadMore}>
			Load more
		</button>
	{/if}
{/snippet}

{#snippet trackControls(index: number)}
	{@const item = presentation.contentItems[index]}
	{#if item}
		<UnifiedBrowseRowControls {item} {actions} {ready} playable />
	{/if}
{/snippet}

{#if kind === 'album'}
	<UnifiedAlbumPage
		publicPage={{
			title, artist: subtitle, imageKey,
			phase: albumPhase, error: failure, tracks,
			controls: bulkControls, trackControls, feedback, footer
		}}
		{backLabel}
		{onBack}
	/>
{:else}
	<UnifiedArtistPage
		{artist}
		{albums}
		overlayPhase="idle"
		discographyKnown={ready}
		truncated={canLoadMore}
		missingMessage={failure}
		{backLabel}
		{onBack}
		headerExtra={bulkControls}
	>
		{#snippet discography()}
			{@render feedback()}
			<UnifiedScopeViews
				scope="albums"
				artists={[]}
				{albums}
				sorts={{ artists: 'az', albums: 'az', genres: 'az' }}
				groupAlbums={false}
				railTarget={null}
				genres={{ entries: [], totalCount: 0, loading: false, loaded: true, error: null }}
				recent={{ entries: [], loading: false, loaded: true }}
				onOpenLiveAlbum={ready ? openAlbum : undefined}
				{hrefForAlbum}
				albumTestId="unified-public-album"
			/>
			{@render footer()}
		{/snippet}
	</UnifiedArtistPage>
{/if}

<style>
	.public-bulk {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 7px;
	}
	.album-bulk {
		flex-direction: column;
		align-items: stretch;
	}
	.public-bulk > button {
		padding: 10px;
		border-radius: 7px;
		background: var(--songr-surface-16);
		border: 1px solid var(--line);
		font: inherit;
		font-size: 12.5px;
		text-align: center;
		cursor: pointer;
		color: var(--songr-control-text);
	}
	.public-bulk > button:hover:not(:disabled) {
		background: var(--songr-surface-20);
		border-color: var(--accent);
	}
	.public-bulk > button:disabled {
		cursor: default;
		opacity: 1;
	}
	.load-more {
		margin-top: 14px;
		padding: 6px 12px;
		border: 1px solid var(--line-subtle);
		border-radius: 4px;
		background: transparent;
		color: var(--soft);
		cursor: pointer;
	}
	.load-more:disabled {
		opacity: 0.5;
		cursor: default;
	}
</style>
