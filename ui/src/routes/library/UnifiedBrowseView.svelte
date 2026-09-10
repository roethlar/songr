<script lang="ts">
	import type { LibraryCollectionSort } from '$lib/library/LibraryDestinations';
	import type { NavigationDestinationId } from '@shared/navigationSettings';
	import type { BrowseItem } from '@shared/types';
	import { shouldHandleLibraryAnchorClick } from '$lib/libraryPageNavigation';
	import type { UnifiedBrowseState } from '$lib/library/UnifiedBrowseController';
	import { classifyBrowsePage, classifyBrowseRow, isBrowseBulkItem, type BrowseRowActions } from '$lib/library/browsePresentation';
	import UnifiedBrowseRowControls from './UnifiedBrowseRowControls.svelte';

	let { state, onBack, onForward, onItem, onLoadMore, onSearchPrompt, hrefForItem = () => null,
		displayItems, collection, trackActions }: {
		state: UnifiedBrowseState;
		onBack: () => void; onForward: () => void; onItem: (item: BrowseItem) => void;
		onLoadMore: () => void; onSearchPrompt: () => void;
		hrefForItem?: (item: BrowseItem) => string | null;
		displayItems?: readonly BrowseItem[];
		trackActions?: BrowseRowActions;
		collection?: {
			id?: NavigationDestinationId; label: string; ready?: boolean; filter: string; sort: LibraryCollectionSort; matchCount: number;
			onFilter: (value: string) => void; onSort: (sort: LibraryCollectionSort) => void;
			onShowMore: () => void; onRetry: () => void;
		};
	} = $props();

	const result = $derived(state.result);
	const presentation = $derived(classifyBrowsePage(state, collection?.id));
	const items = $derived(displayItems ? displayItems.filter(item => !isBrowseBulkItem(item) && item.hint !== 'header') : presentation.contentItems);
	const hasMessage = $derived(result?.action === 'message' || Boolean(result?.message) || result?.isError === true);
	const total = $derived(result?.totalCount ?? result?.count ?? 0);
	const loadedCount = $derived(result?.items.length ?? 0);
	const contentTotal = $derived(Math.max(0, total - (loadedCount - presentation.contentItems.length)));
	const canLoadMore = $derived(!collection && (state.phase === 'ready' || state.phase === 'error') && loadedCount < total);
	const title = $derived(collection?.label ?? result?.title ?? state.snapshot.history.at(-1)?.breadcrumb.title ?? 'Library');

	function followItem(event: MouseEvent, href: string | null, item: BrowseItem): void {
		if (href !== null) {
			if (!shouldHandleLibraryAnchorClick(event)) return;
			event.preventDefault();
		}
		if (item.inputPrompt) onSearchPrompt();
		else onItem(item);
	}
</script>

<section class="browse-surface" data-testid="unified-browse-view" aria-label={title}>
	<div class="ctx collection-heading library-list-toolbar">
		{#if !collection}
			<button type="button" class="back" data-testid="unified-browse-back"
				disabled={state.snapshot.history.length === 0 || state.phase === 'loading'} onclick={onBack}>← Back</button>
		{/if}
		<h2 tabindex="-1" data-testid="unified-browse-title">{title}</h2>
		{#if result && !hasMessage && state.phase === 'ready'}
			<span class="n mono browse-count" data-testid="unified-browse-summary">
				{#if collection}{collection.matchCount.toLocaleString()}{collection.filter ? ` OF ${contentTotal.toLocaleString()}` : ''}
				{:else}{presentation.contentItems.length.toLocaleString()}{contentTotal > presentation.contentItems.length ? ` OF ${contentTotal.toLocaleString()}` : ''}{/if}
			</span>
		{/if}
		{#if collection}
			<input class="collection-filter" type="search" aria-label="Filter {collection.label}" placeholder="Filter {collection.label.toLowerCase()}…"
				value={collection.filter} disabled={state.phase !== 'ready' || collection.ready === false} oninput={event => collection?.onFilter(event.currentTarget.value)} />
			<select class="collection-sort" aria-label="Sort {collection.label}" value={collection.sort} disabled={state.phase !== 'ready' || collection.ready === false}
				onchange={event => collection?.onSort(event.currentTarget.value as LibraryCollectionSort)}>
				<option value="original">Roon order</option><option value="name-asc">Name A–Z</option><option value="name-desc">Name Z–A</option>
				{#if collection.id === 'tracks'}<option value="artist-asc">Artist A–Z</option><option value="artist-desc">Artist Z–A</option>{/if}
			</select>
		{:else if state.snapshot.forward.length > 0}
			<button type="button" class="back" data-testid="unified-browse-forward" disabled={state.phase === 'loading'} onclick={onForward}>Forward →</button>
		{/if}
		{#each presentation.bulkItems as item}
			<div class="bulk-controls" aria-label={item.title}>
				{#if presentation.bulkItems.length > 1}<span class="bulk-label">{item.title}</span>{/if}
				<UnifiedBrowseRowControls {item} actions={trackActions} ready={state.phase === 'ready'} playable={item.hint === 'action_list'} prominent />
			</div>
		{/each}
	</div>
	{#if !collection && result?.subtitle}<p class="browse-subtitle">{result.subtitle}</p>{/if}
	{#if !collection && state.snapshot.history.length > 1}
		<ol class="browse-crumbs" aria-label="Library path" data-testid="unified-browse-path">
			{#each state.snapshot.history as step, index (`${index}:${step.breadcrumb.title}`)}<li>{step.breadcrumb.title}</li>{/each}
		</ol>
	{/if}
	{#if state.notice}<p class="browse-status" data-testid="unified-browse-notice">{state.notice}</p>{/if}
	{#if trackActions?.status}
		<p class="browse-status" class:browse-error={trackActions.error} role={trackActions.error ? 'alert' : 'status'} data-testid="unified-track-status">{trackActions.status}</p>
	{/if}
	{#if state.phase === 'loading' && !result}
		<p class="browse-status" data-testid="unified-browse-loading">Loading {title}…</p>
	{:else if state.phase === 'error' && !result}
		<p class="browse-status browse-error" data-testid="unified-browse-error">{title} failed{state.error ? `: ${state.error}` : '.'}</p>
		{#if collection}<button type="button" class="browse-more" onclick={collection.onRetry}>Retry {collection.label}</button>{/if}
	{:else if hasMessage}
		<p class="browse-status" class:browse-error={result?.isError === true} data-testid="unified-browse-message" role={result?.isError === true ? 'alert' : 'status'}>
			{result?.message || (result?.isError ? 'Roon reported an error.' : 'Roon returned a message.')}
		</p>
	{:else if collection && state.phase === 'ready' && collection.ready === false}
		<p class="browse-status" role="status">Roon did not return a complete {collection.label.toLowerCase()} collection.</p>
		<button type="button" class="browse-more" onclick={collection.onRetry}>Retry {collection.label}</button>
	{:else if result && items.length === 0 && !canLoadMore}
		<p class="browse-status" data-testid="unified-browse-empty">{collection?.filter ? 'No matches.' : 'Nothing is available here.'}</p>
	{:else if result}
		{#if state.phase === 'error'}<p class="browse-status browse-error" data-testid="unified-browse-error">Could not load more{state.error ? `: ${state.error}` : '.'}</p>{/if}
		{#if presentation.sectionLabel}<h3 class="section-label">{presentation.sectionLabel}</h3>{/if}
		<div class="browse-list" data-testid="unified-browse-list">
			{#each items as item, index (`${index}:${item.title}:${item.subtitle ?? ''}`)}
				{@const rowKind = classifyBrowseRow(item, presentation)}
				{@const navigable = rowKind === 'navigation'}
				{@const href = navigable && state.phase !== 'loading' ? hrefForItem(item) : null}
				<div class="tr browse-row" data-testid="unified-browse-row" data-row-kind={rowKind}>
					{#if navigable}
						<svelte:element this={href === null ? 'button' : 'a'} role={href === null ? 'button' : 'link'} type={href === null ? 'button' : undefined}
							{href} class="browse-name" disabled={state.phase === 'loading'} aria-label={item.inputPrompt ? `${item.inputPrompt} in Search` : `Open ${item.title}`}
							onclick={(event: MouseEvent) => followItem(event, href, item)}>
							<span class="tnm">{item.title}</span>{#if item.subtitle}<span class="browse-secondary">{item.subtitle}</span>{/if}
						</svelte:element>
					{:else}
						<div class="browse-name"><span class="tnm" title={item.title}>{item.title}</span>{#if item.subtitle}<span class="browse-secondary" title={item.subtitle}>{item.subtitle}</span>{/if}</div>
					{/if}
					{#if rowKind === 'track' || rowKind === 'recording' || rowKind === 'actions'}
						<UnifiedBrowseRowControls {item} actions={trackActions} ready={state.phase === 'ready'} playable={rowKind !== 'actions'} favorite={rowKind === 'track'} />
					{/if}
				</div>
			{/each}
		</div>
		{#if collection && items.length < collection.matchCount}<button type="button" class="browse-more" onclick={collection.onShowMore}>Show next {Math.min(100, collection.matchCount - items.length)}</button>{/if}
		{#if canLoadMore}<button type="button" class="browse-more" data-testid="unified-browse-more" onclick={onLoadMore}>{state.phase === 'error' ? 'Retry next' : 'Load next'} {Math.min(100, total - loadedCount).toLocaleString()}</button>{/if}
	{/if}
</section>

<style>
	.browse-surface { display: flex; flex-direction: column; gap: 12px; min-height: 0; color: var(--text); }
	.collection-heading { display: flex; align-items: center; flex-wrap: wrap; gap: 11px; }
	.collection-heading h2 { font-size: 20px; font-weight: 600; letter-spacing: -.02em; margin: 0; }
	.collection-filter, .collection-sort { font: inherit; font-size: 12px; color: var(--text); background: var(--control); border: 1px solid var(--line); border-radius: 6px; min-height: 32px; padding: 5px 9px; }
	.collection-filter { min-width: 100px; width: 180px; max-width: 100%; margin-left: auto; }
	.collection-sort { max-width: 100%; }
	.collection-filter:focus-visible, .collection-sort:focus-visible, .browse-name:focus-visible, .browse-more:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
	.bulk-controls { display: flex; align-items: center; gap: 6px; }
	.bulk-label, .browse-subtitle, .browse-status { color: var(--soft); font-size: 12px; }
	.browse-subtitle, .browse-status { margin: 0; padding: 0 8px; }
	.browse-error { color: var(--songr-error); }
	.browse-crumbs { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 0 8px; list-style: none; color: var(--dim); font-size: 11px; }
	.browse-crumbs li:not(:last-child)::after { content: ' /'; }
	.section-label { margin: 10px 8px 0; font-size: 13px; font-weight: 500; color: var(--soft); }
	.browse-list { display: flex; flex-direction: column; }
	.browse-row { min-width: 0; cursor: default; }
	.browse-name { display: flex; align-items: baseline; flex: 1; gap: 14px; min-width: 0; border: 0; padding: 0; background: transparent; color: inherit; text-align: left; text-decoration: none; font: inherit; }
	button.browse-name, a.browse-name { cursor: pointer; align-self: stretch; align-items: center; }
	.browse-name:disabled { cursor: default; opacity: .6; }
	.browse-name .tnm { flex: 1; min-width: 0; }
	.browse-secondary { flex: 0 1 40%; min-width: 0; color: var(--soft); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.browse-more { align-self: center; margin: 8px 0 24px; border: 1px solid var(--line); border-radius: 5px; background: var(--control); color: var(--accent); padding: 7px 11px; font: inherit; cursor: pointer; }
	@media (max-width: 600px) {
		.browse-name { flex-direction: column; align-items: stretch; gap: 3px; }
		button.browse-name, a.browse-name { align-items: stretch; }
		.browse-secondary { flex-basis: auto; width: 100%; }
	}
</style>
