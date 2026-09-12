<script lang="ts">
 import EntityFeedback from '$lib/components/EntityFeedback.svelte';
 import LibraryActionButton from '$lib/components/LibraryActionButton.svelte';
 import { mount, unmount, onDestroy, untrack } from 'svelte';
 import { prepareTrackList, type PreparedTrackListState } from '$lib/preparedTrackList';
 import { createTrackSelection, type TrackSelection } from '$lib/trackSelection';
 import type { LibraryCollectionSort } from '$lib/library/LibraryDestinations';
 import type { NavigationDestinationId } from '@shared/navigationSettings';
 import type { UnifiedSongActionSemantic } from '@shared/unifiedSearchContracts';
 import type { BrowseItem } from '@shared/types';
 import { shouldHandleLibraryAnchorClick } from '$lib/libraryPageNavigation';
 import type { UnifiedBrowseState } from '$lib/library/UnifiedBrowseController';
 import { classifyBrowsePage, classifyBrowseRow, type BrowseRowActions } from '$lib/library/browsePresentation';
 import UnifiedBrowseRowControls from './UnifiedBrowseRowControls.svelte';
 import TrackSelectionControls from './TrackSelectionControls.svelte';

 let { state: browseState, onBack, onForward, onItem, onSearchPrompt, hrefForItem = () => null,
  displayItems, orderedItems, selectableItems, orderedSelectableItems, preparing = false, layoutRevision, collection, trackActions,
  selection = createTrackSelection<BrowseItem>() }: {
  state: UnifiedBrowseState;
  onBack: () => void; onForward: () => void; onItem: (item: BrowseItem) => void;
  onSearchPrompt: () => void;
  hrefForItem?: (item: BrowseItem) => string | null;
  displayItems?: readonly BrowseItem[];
  orderedItems?: readonly BrowseItem[];
  selectableItems?: readonly BrowseItem[];
  orderedSelectableItems?: readonly BrowseItem[];
  preparing?: boolean;
  layoutRevision?: unknown;
  selection?: TrackSelection<BrowseItem>;
  trackActions?: BrowseRowActions;
  collection?: {
   id?: NavigationDestinationId; root?: boolean; label: string; ready?: boolean; filter: string; sort: LibraryCollectionSort; matchCount: number; totalCount?: number;
   onFilter: (value: string) => void; onSort: (sort: LibraryCollectionSort) => void;
   onRetry: () => void;
  };
 } = $props();

 const result = $derived(browseState.result);
 const presentation = $derived(classifyBrowsePage(browseState, collection?.id));
 // Mode supplies already classified/filtered content; do not filter/copy it again.
 const items = $derived(displayItems ?? presentation.contentItems);
 const allItems = $derived(orderedItems ?? presentation.contentItems);
 const eligible = (item: BrowseItem): boolean => {
  const kind = classifyBrowseRow(item, presentation); return kind === 'track' || kind === 'recording';
 };
 const selectionItems = $derived(orderedSelectableItems ?? allItems.filter(eligible));
 const visibleSelectionItems = $derived(selectableItems ?? (items === allItems ? selectionItems : items.filter(eligible)));
 const selected = $derived.by(() => { if (!$selection.count) return []; return selection.ordered(selectionItems); });
 const hasMessage = $derived(result?.action === 'message' || Boolean(result?.message) || result?.isError === true);
 const total = $derived(result?.totalCount ?? result?.count ?? 0);
 const loadedCount = $derived(result?.items.length ?? 0);
 const contentTotal = $derived(collection?.totalCount ?? Math.max(0, total - (loadedCount - presentation.contentItems.length)));
 const title = $derived(collection?.label ?? result?.title ?? browseState.snapshot.history.at(-1)?.breadcrumb.title ?? 'Library');
 let renderState = $state<PreparedTrackListState>({ phase: 'preparing', prepared: 0, total: 0 });
 const actionBusy = $derived(Boolean(trackActions?.busy) || preparing || renderState.phase !== 'ready');
 const sharedActions = $derived([
  { id: 'play', label: 'Play', run: (rows: BrowseItem[]) => act(rows, 'play-now'), disabled: !trackActions?.enabled || (selected.length > 1 && !trackActions.onBatchAction) },
  { id: 'next', label: 'Add next', run: (rows: BrowseItem[]) => act(rows, 'add-next'), disabled: !trackActions?.enabled || (selected.length > 1 && !trackActions.onBatchAction) },
  { id: 'queue', label: 'Queue', run: (rows: BrowseItem[]) => act(rows, 'queue'), disabled: !trackActions?.enabled || (selected.length > 1 && !trackActions.onBatchAction) }
 ]);
 const canBookmark = $derived(selected.every(item => classifyBrowseRow(item, presentation) === 'track') &&
  (selected.length === 1 ? Boolean(trackActions?.onFavorite) : Boolean(trackActions?.onBatchFavorite)));
 const hasBookmarkableTracks = $derived(selectionItems.some(item => classifyBrowseRow(item, presentation) === 'track'));
 $effect(() => { selection.retain(result?.items ?? [], result ?? undefined); });
 $effect(() => { $selection.selected; untrack(() => trackActions?.onCloseMore()); });
 onDestroy(() => { selection.retain([]); selection.clear(); });
 function act(rows: BrowseItem[], semantic: UnifiedSongActionSemantic): void {
  if (!trackActions?.enabled || actionBusy || !rows.length) return;
  if (rows.length === 1) trackActions.onAction(rows[0], semantic);
  else trackActions.onBatchAction?.(rows, semantic);
 }
 function favorite(rows: BrowseItem[]): void {
  if (!rows.length || actionBusy || !canBookmark || rows.some(item => classifyBrowseRow(item, presentation) !== 'track')) return;
  trackActions?.onCloseMore();
  if (rows.length === 1) trackActions?.onFavorite?.(rows[0]); else trackActions?.onBatchFavorite?.(rows);
 }
 function openMore(rows: BrowseItem[]): void {
  if (!actionBusy && rows.length === 1 && trackActions?.enabled) trackActions.onMore(rows[0]);
 }
 function followItem(event: MouseEvent, href: string | null, item: BrowseItem): void {
  if (href !== null) { if (!shouldHandleLibraryAnchorClick(event)) return; event.preventDefault(); }
  if (item.inputPrompt) onSearchPrompt(); else onItem(item);
 }
 function createRow(item: BrowseItem) {
  const row = document.createElement('div');
  const kind = classifyBrowseRow(item, presentation);
  row.className = 'tr browse-row'; row.dataset.testid = 'unified-browse-row'; row.dataset.rowKind = kind;
  const cleanup: (() => void)[] = [];
  const selectable = kind === 'track' || kind === 'recording';
  const navigable = kind === 'navigation';
  const href = navigable ? hrefForItem(item) : null;
  const name: HTMLElement = document.createElement(navigable ? href === null ? 'button' : 'a' : selectable ? 'button' : 'div'); name.className = 'browse-name';
  if (navigable) {
   if (name instanceof HTMLAnchorElement && href !== null) name.href = href;
   if (name instanceof HTMLButtonElement) name.type = 'button';
   name.setAttribute('aria-label', item.inputPrompt ? `${item.inputPrompt} in Search` : `Open ${item.title}`);
   const click = (event: MouseEvent): void => { if (browseState.phase === 'ready' && !preparing) followItem(event, href, item); };
   name.addEventListener('click', click); cleanup.push(() => name.removeEventListener('click', click));
  }
  const primary = document.createElement('span'); primary.className = 'tnm'; primary.textContent = item.title; primary.title = item.title; name.append(primary);
  if (item.subtitle) { const secondary = document.createElement('span'); secondary.className = 'browse-secondary'; secondary.textContent = item.subtitle; secondary.title = item.subtitle; name.append(secondary); }
  row.append(name);
  if (selectable) {
   row.setAttribute('data-track-select-row', '');
   name.setAttribute('data-track-select-target', '');
   name.setAttribute('aria-label', `Select ${item.title}`);
   name.setAttribute('aria-pressed', 'false');
   (name as HTMLButtonElement).type = 'button';
   const binding = { item, ordered: () => visibleSelectionItems, generation: result ?? undefined,
    disabled: () => browseState.phase !== 'ready' || Boolean(trackActions?.busy) || preparing };
   cleanup.push(selection.row(row, binding).destroy);
  }
  if (kind === 'actions') {
   const control = mount(LibraryActionButton, { target: row, props: {
    icon: 'more', label: 'More', 'aria-label': `More actions for ${item.title}`,
    onclick: () => { if (browseState.phase === 'ready' && !preparing) trackActions?.onMore(item); }
   } });
   cleanup.push(() => { void unmount(control); });
  }
  return { node: row, destroy: () => { for (const release of cleanup) release(); } };
 }
</script>

<section class="browse-surface" data-testid="unified-browse-view" aria-label={title}>
	<div class="ctx collection-heading library-list-toolbar" class:has-tracks={selectionItems.length > 0}>
		{#if !collection?.root}
			<button type="button" class="back" data-testid="unified-browse-back"
				disabled={browseState.snapshot.history.length === 0 || browseState.phase === 'loading'} onclick={onBack}>← Back</button>
		{/if}
		<div class="heading-core">
		<div class="collection-identity">
		<h2 tabindex="-1" data-testid="unified-browse-title">{title}</h2>
		{#if result && !hasMessage && browseState.phase === 'ready' && (!collection || collection.ready !== false)}
			<span class="n mono browse-count" data-testid="unified-browse-summary">
				{#if collection}{collection.matchCount.toLocaleString()}{collection.filter ? ` OF ${contentTotal.toLocaleString()}` : ''}
				{:else}{presentation.contentItems.length.toLocaleString()}{contentTotal > presentation.contentItems.length ? ` OF ${contentTotal.toLocaleString()}` : ''}{/if}
			</span>
		{/if}
		</div>
        {#if selectionItems.length > 0}
         <div class="selection-header">
          <TrackSelectionControls {selection} orderedItems={selectionItems} visibleItems={visibleSelectionItems}
           actions={sharedActions} busy={actionBusy} status={trackActions?.status} onCancel={trackActions?.onCancel} label={item => item.title}
           onBookmark={hasBookmarkableTracks && (trackActions?.onFavorite || trackActions?.onBatchFavorite) ? favorite : undefined} bookmarkDisabled={!canBookmark}
           hasMore={selected.length === 1 && Boolean(trackActions?.onMore)} moreDisabled={!trackActions?.enabled}
           remoteMenuActive={Boolean(trackActions?.menu && selected.length === 1 && trackActions.menu.item === selected[0])}
           onOpenMore={openMore} onCloseMore={() => trackActions?.onCloseMore()}>
           {#snippet more(rows: BrowseItem[])}
            {#if rows.length === 1 && trackActions?.menu?.item === rows[0]}
             {#if trackActions.menu.state.phase === 'loading' || trackActions.menu.state.phase === 'executing'}<span role="status">{trackActions.menu.state.phase === 'executing' ? 'Working…' : 'Loading…'}</span>{/if}
             {#if trackActions.menu.state.error}<span role="alert">{trackActions.menu.state.error}</span>{/if}
             {#each trackActions.menu.state.actions ?? [] as choice}
              <button type="button" role="menuitem" disabled={trackActions.menu.state.phase !== 'ready' || !trackActions.enabled}
               onclick={() => trackActions?.menu?.onChoose(choice)}>{choice.title}</button>
             {/each}
             {#if trackActions.menu.state.phase === 'ready' && !trackActions.menu.state.actions?.length}<span>No actions are available.</span>{/if}
            {/if}
           {/snippet}
          </TrackSelectionControls>
         </div>
        {/if}
		</div>
		{#if collection}
			<input class="collection-filter" type="search" aria-label="Filter {collection.label}" placeholder="Filter {collection.label.toLowerCase()}…"
				value={collection.filter} disabled={browseState.phase !== 'ready' || collection.ready === false} oninput={event => collection?.onFilter(event.currentTarget.value)} />
			<select class="collection-sort" aria-label="Sort {collection.label}" value={collection.sort} disabled={browseState.phase !== 'ready' || collection.ready === false}
				onchange={event => collection?.onSort(event.currentTarget.value as LibraryCollectionSort)}>
				<option value="original">Roon order</option><option value="name-asc">Name A–Z</option><option value="name-desc">Name Z–A</option>
				{#if collection.id === 'tracks'}<option value="artist-asc">Artist A–Z</option><option value="artist-desc">Artist Z–A</option>{/if}
			</select>
		{/if}
		{#if browseState.snapshot.forward.length > 0}
			<button type="button" class="back" data-testid="unified-browse-forward" disabled={browseState.phase === 'loading'} onclick={onForward}>Forward →</button>
		{/if}

        {#if trackActions?.menu && !selected.includes(trackActions.menu.item) && !presentation.bulkItems.includes(trackActions.menu.item)}
         <div class="bulk-controls" aria-label={trackActions.menu.item.title}>
          <span class="bulk-label">{trackActions.menu.item.title}</span>
          <UnifiedBrowseRowControls item={trackActions.menu.item} actions={trackActions} ready={browseState.phase === 'ready'} playable={false} prominent />
         </div>
        {/if}
		{#each presentation.bulkItems as item}
			<div class="bulk-controls" aria-label={item.title}>
				{#if presentation.bulkItems.length > 1}<span class="bulk-label">{item.title}</span>{/if}
				<UnifiedBrowseRowControls {item} actions={trackActions} ready={browseState.phase === 'ready'} playable={item.hint === 'action_list'} prominent />
			</div>
		{/each}
	</div>
	{#if !collection && result?.subtitle}<p class="browse-subtitle">{result.subtitle}</p>{/if}
	{#if !collection && browseState.snapshot.history.length > 1}
		<ol class="browse-crumbs" aria-label="Library path" data-testid="unified-browse-path">
			{#each browseState.snapshot.history as step, index (`${index}:${step.breadcrumb.title}`)}<li>{step.breadcrumb.title}</li>{/each}
		</ol>
	{/if}
	{#if browseState.notice}<p class="browse-status" data-testid="unified-browse-notice">{browseState.notice}</p>{/if}
	<EntityFeedback message={selectionItems.length === 0 ? trackActions?.status : null} />
	{#if browseState.phase === 'loading' && !result}
		<p class="browse-status" data-testid="unified-browse-loading">Loading {title}…</p>
	{:else if browseState.phase === 'error' && !result}
		<p class="browse-status browse-error" data-testid="unified-browse-error">{title} failed{browseState.error ? `: ${browseState.error}` : '.'}</p>
		{#if collection}<button type="button" class="browse-more" onclick={collection.onRetry}>Retry {collection.label}</button>{/if}
	{:else if hasMessage}
		<p class="browse-status" class:browse-error={result?.isError === true} data-testid="unified-browse-message" role={result?.isError === true ? 'alert' : 'status'}>
			{result?.message || (result?.isError ? 'Roon reported an error.' : 'Roon returned a message.')}
		</p>
	{:else if collection && browseState.phase === 'ready' && collection.ready === false}
		<p class="browse-status" role="status">Roon did not return a complete {collection.label.toLowerCase()} collection.</p>
		<button type="button" class="browse-more" onclick={collection.onRetry}>Retry {collection.label}</button>
	{:else if result}
        {#if !preparing && items.length === 0}<p class="browse-status" data-testid="unified-browse-empty">{collection?.filter ? 'No matches.' : 'Nothing is available here.'}</p>{/if}
		{#if browseState.phase === 'error'}<p class="browse-status browse-error" data-testid="unified-browse-error">This page could not be loaded{browseState.error ? `: ${browseState.error}` : '.'}</p>{/if}
		{#if presentation.sectionLabel}<h3 class="section-label">{presentation.sectionLabel}</h3>{/if}
        {#if preparing || renderState.phase === 'preparing'}
         <p class="browse-status" role="status" data-testid="unified-browse-preparing">Preparing {title}…</p>
        {:else if renderState.phase === 'error'}
         <p class="browse-status browse-error" role="alert">{renderState.error}</p>
        {/if}
        <div class="browse-list" data-testid="unified-browse-list" aria-disabled={Boolean(trackActions?.busy) || preparing} aria-busy={preparing || renderState.phase === 'preparing'} use:prepareTrackList={{ items, generation: result, createRow,
         onState: next => renderState = next, layoutRevision, suspended: preparing }}></div>
	{/if}
</section>

<style>
	.browse-surface { display: flex; flex-direction: column; gap: 12px; min-height: 0; color: var(--text); }
	.collection-heading { display: flex; align-items: center; flex-wrap: wrap; gap: 11px; }
	.collection-heading h2 { font-size: 20px; font-weight: 600; letter-spacing: -.02em; margin: 0; }
	.collection-filter, .collection-sort { font: inherit; font-size: 12px; color: var(--text); background: var(--control); border: 1px solid var(--line); border-radius: 6px; min-height: 32px; padding: 5px 9px; }
	.collection-filter { min-width: 100px; width: 180px; max-width: 100%; margin-left: auto; }
	.collection-sort { max-width: 100%; }
	.collection-filter:focus-visible, .collection-sort:focus-visible, .browse-list :global(.browse-name:focus-visible), .browse-more:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
	.bulk-controls { display: flex; align-items: center; gap: 6px; }
	.bulk-label, .browse-subtitle, .browse-status { color: var(--soft); font-size: 12px; }
	.browse-subtitle, .browse-status { margin: 0; padding: 0 8px; }
	.browse-error { color: var(--songr-error); }
	.browse-crumbs { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 0 8px; list-style: none; color: var(--dim); font-size: 11px; }
	.browse-crumbs li:not(:last-child)::after { content: ' /'; }
	.section-label { margin: 10px 8px 0; font-size: 13px; font-weight: 500; color: var(--soft); }
	.browse-list { display: grid; grid-template-columns: minmax(0, 1fr); --library-chunk-overflow: 280px; }
	.browse-list :global(.browse-row) { min-width: 0; cursor: default; }
 .browse-list :global([data-track-select-row]) { cursor:pointer; }
	.browse-list :global(.browse-name) { display: flex; align-items: baseline; flex: 1; gap: 14px; min-width: 0; border: 0; padding: 0; background: transparent; color: inherit; text-align: left; text-decoration: none; font: inherit; }
	.browse-list :global(button.browse-name), .browse-list :global(a.browse-name) { cursor: pointer; align-self: stretch; align-items: center; }
	.browse-list :global(.browse-name:disabled) { cursor: default; opacity: .6; }
	.browse-list :global(.browse-name .tnm) { flex: 1; min-width: 0; }
	.browse-list :global(.browse-secondary) { flex: 0 1 40%; min-width: 0; color: var(--soft); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.browse-more, .browse-list :global(.browse-more) { align-self: center; margin: 8px 0 24px; border: 1px solid var(--line); border-radius: 5px; background: var(--control); color: var(--accent); padding: 7px 11px; font: inherit; cursor: pointer; }
	@media (max-width: 600px) {
		.browse-list :global(.browse-name) { flex-direction: column; align-items: stretch; gap: 3px; }
		.browse-list :global(button.browse-name), .browse-list :global(a.browse-name) { align-items: stretch; }
		.browse-list :global(.browse-secondary) { flex-basis: auto; width: 100%; }
	}
 .heading-core { display:flex; align-items:center; gap:11px; min-width:0; flex:1; }
 .has-tracks .heading-core { flex-basis:260px; min-width:min(100%,260px); }
 .selection-header { flex:1 1 160px; min-width:min-content; }
 .collection-identity { display:flex; align-items:baseline; gap:11px; min-width:0; }
 .has-tracks .collection-identity { max-width:40%; }
 .has-tracks .collection-identity h2 { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
 .has-tracks .collection-filter, .has-tracks .collection-sort { order:2; }
 .has-tracks .collection-filter { margin-left:0; }
</style>
