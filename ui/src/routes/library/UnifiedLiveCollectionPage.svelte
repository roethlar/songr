<script lang="ts">
	import LibraryActionButton from '$lib/components/LibraryActionButton.svelte';
	import EntityFeedback from '$lib/components/EntityFeedback.svelte';
	import { onDestroy, untrack } from 'svelte';
	import { get } from 'svelte/store';
	import { prepareLibraryGrid } from '$lib/preparedLibraryGrid';
	import { createTrackSelection } from '$lib/trackSelection';
	import { bookmarkPayload } from '$lib/bookmarks';
	import type { AddFavoriteRequest } from '@shared/types';
	import { measureLibraryChrome } from '$lib/libraryListChrome';
	import type { AlbumActionController } from '$lib/library/AlbumActionController';
	import type {
		LiveLibraryPageState
	} from '$lib/library/LiveLibraryPageController';
	import {
		bucketLetterFor,
		librarySortKey,
		type LetterBucket,
		type LibraryAlbumEntry
	} from '$lib/libraryEntries';
	import type { LibraryLevelRow, LibraryNodeKind } from '@shared/libraryOpenContracts';
	import type {
		UnifiedAlbumsSort,
		UnifiedArtistsSort,
		UnifiedGenresSort
	} from '$lib/stores/unifiedLibraryPrefsStore';
	import { genreDrillSortMenu, sortAlbums } from '$lib/unifiedLibrarySorts';
	import UnifiedScopeViews from './UnifiedScopeViews.svelte';
	import UnifiedGenreOverview from './UnifiedGenreOverview.svelte';
	import type { GenrePreviewState } from '$lib/library/GenrePreviewController';
	import type { LibraryRenderingPath } from '$lib/library/liveLibraryPath';
	import type { LibraryPreviewItemKind } from '@shared/libraryPreviewContracts';
	import type { UnifiedLibraryDensity } from '$lib/stores/unifiedLibraryPrefsStore';
	import TrackSelectionControls from './TrackSelectionControls.svelte';

	interface Props {
		page: LiveLibraryPageState;
		levelKind: LibraryNodeKind;
		backLabel: string;
		onBack: () => void;
		onRetry: () => void;
		onOpenRow: (row: LibraryLevelRow) => void;
		onRowAction?: (row: LibraryLevelRow, semantic: 'play-now' | 'add-next' | 'queue') => void;
		onRowsAction?: (rows: readonly LibraryLevelRow[], semantic: 'play-now' | 'add-next' | 'queue') => void;
		onBookmark?: (items: readonly AddFavoriteRequest[]) => void;
		bookmarkBusy?: boolean;
		bookmarkStatus?: string | null;
		batchBusy?: boolean;
		batchStatus?: string | null;
		onCancelBatch?: () => void;
		onRowMore?: (row: LibraryLevelRow) => void;
		onCloseRowMore?: () => void;
		hrefForRow: (row: LibraryLevelRow) => string | null;
		onOpenAlbum: (entry: LibraryAlbumEntry) => void;
		hrefForAlbum: (entry: LibraryAlbumEntry) => string | null;
		actionController: AlbumActionController;
		actionsEnabled: boolean;
		sorts: {
			readonly artists: UnifiedArtistsSort;
			readonly albums: UnifiedAlbumsSort;
			readonly genres: UnifiedGenresSort;
		};
		randomSeed: number;
		onSetAlbumSort: (value: string) => void;
		groupByLetter?: boolean;
		onSetGroupByLetter?: (value: boolean) => void;
		genrePreviews: GenrePreviewState;
		density: UnifiedLibraryDensity;
		onPreviewCapacity: (capacity: number) => void;
		onRetryPreview: (kind: LibraryPreviewItemKind) => void;
		onOpenPreview: (source: LibraryRenderingPath, row: LibraryLevelRow) => void;
		hrefForPreview: (source: LibraryRenderingPath, row: LibraryLevelRow) => string | null;
	}

	let {
		page,
		levelKind,
		backLabel,
		onBack,
		onRetry,
		onOpenRow,
		onRowAction,
		onRowsAction,
		onBookmark,
		bookmarkBusy = false,
		bookmarkStatus = null,
		batchBusy = false,
		batchStatus = null,
		onCancelBatch,
		onRowMore,
		onCloseRowMore,
		hrefForRow,
		onOpenAlbum,
		hrefForAlbum,
		actionController,
		actionsEnabled,
		sorts,
		randomSeed,
		onSetAlbumSort,
		groupByLetter = false,
		onSetGroupByLetter,
		genrePreviews,
		density,
		onPreviewCapacity,
		onRetryPreview,
		onOpenPreview,
		hrefForPreview
	}: Props = $props();

	let surface: HTMLElement | null = null;
	let menuRow = $state.raw<LibraryLevelRow | null>(null);
	let menuTrigger: HTMLButtonElement | null = null;
	let menuRequestId = $state<string | null>(null);
	let menuStartingRequestId: string | null = null;
	let menuMayReissue = false;
	let sortOpen = $state(false);
	let rowFilter = $state('');
	let rowSort = $state('original');
	let railTarget = $state<LetterBucket | null>(null);
	const trackSelection = createTrackSelection<LibraryLevelRow>();
	const action = $derived($actionController);
	const rows = $derived(page.level?.rows ?? []);
	const albumRows = $derived(rows.filter((row) => row.kind === 'album'));
	const albums = $derived(albumRows.map(albumEntry));
	const ordinaryRows = $derived(
		rows.filter((row) => row.kind !== 'album' && row.kind !== 'action')
	);
	const orderedOrdinaryRows = $derived.by(() => {
		const ordered = [...ordinaryRows];
		if (rowSort !== 'original') ordered.sort((a, b) => (rowSort === 'name-desc' ? -1 : 1) * a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true }));
		return ordered;
	});
	const ordinaryMatches = $derived.by(() => {
		const query = rowFilter.trim().toLocaleLowerCase();
		return orderedOrdinaryRows.filter(row => !query || `${row.title}\n${row.subtitle ?? ''}`.toLocaleLowerCase().includes(query));
	});
	const trackRows = $derived(orderedOrdinaryRows.filter(row => row.kind === 'track'));
	const visibleTracks = $derived(ordinaryMatches.filter(row => row.kind === 'track'));
	$effect(() => { trackSelection.retain(page.phase === 'ready' ? trackRows : [], page.level ?? undefined); });
	const rowLabel = $derived(levelKind === 'composer' ? 'Compositions' : 'Recordings');
	$effect(() => { page.level; rowFilter = ''; rowSort = 'original'; });
	const actionRows = $derived(rows.filter((row) => row.kind === 'action'));
	const bulkRows = $derived(rows.filter(row => row.kind === 'action' &&
		['play artist', 'play album', 'play genre', 'play composer', 'play composition', 'play work'].includes(row.title.trim().toLowerCase())));
	const actionBusy = $derived(
		bookmarkBusy || batchBusy || action.phase === 'resolving' ||
			action.phase === 'choosing' ||
			action.phase === 'executing'
	);
	const selectionActions = $derived([
		{ id: 'play', label: 'Play', disabled: !onRowsAction || !actionsEnabled || actionBusy, run: (selected: LibraryLevelRow[]) => beginRows(selected, 'play-now') },
		{ id: 'queue', label: 'Queue', disabled: !onRowsAction || !actionsEnabled || actionBusy, run: (selected: LibraryLevelRow[]) => beginRows(selected, 'queue') },
		{ id: 'next', label: 'Add next', disabled: !onRowsAction || !actionsEnabled || actionBusy, run: (selected: LibraryLevelRow[]) => beginRows(selected, 'add-next') }
	]);
	const bookmarkDisabled = $derived.by(() => {
		if (actionBusy || page.phase !== 'ready') return true;
		for (const row of $trackSelection.selected) if (!row.title.trim()) return true;
		return false;
	});

	function bookmarkTracks(selected: LibraryLevelRow[]): void {
		if (!onBookmark || actionBusy || page.phase !== 'ready' || !selected.length ||
			selected.some(row => !trackRows.includes(row) || !row.title.trim())) return;
		closeRowMenu();
		onBookmark(selected.map(row => bookmarkPayload('track', {
			title: row.title, artist: row.subtitle, imageKey: row.imageKey
		})));
	}
	const sortMenu = genreDrillSortMenu();
	const railBuckets = $derived.by((): readonly LetterBucket[] => {
		if (
			sorts.albums !== 'az' &&
			sorts.albums !== 'za' &&
			sorts.albums !== 'by-artist'
		) {
			return [];
		}
		const buckets: LetterBucket[] = [];
		for (const [index, album] of sortAlbums(albums, sorts.albums, randomSeed).entries()) {
			const searchKey =
				sorts.albums === 'by-artist' ? librarySortKey(album.artist) : album.searchKey;
			const letter = bucketLetterFor(searchKey);
			const last = buckets[buckets.length - 1];
			if (last?.letter === letter) last.count += 1;
			else buckets.push({ letter, start: index, count: 1 });
		}
		return buckets;
	});
	const railVisible = $derived(albumRows.length >= 40 && railBuckets.length >= 3);
	const railLetters = $derived.by(() => {
		const alphabet = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
		const byLetter = new Map(railBuckets.map((bucket) => [bucket.letter, bucket]));
		const first = railBuckets[0];
		const last = railBuckets[railBuckets.length - 1];
		const reversed =
			first !== undefined && last !== undefined && alphabet.indexOf(first.letter) > alphabet.indexOf(last.letter);
		const order = reversed ? [...alphabet].reverse() : alphabet;
		return order.map((letter) => ({ letter, bucket: byLetter.get(letter) ?? null }));
	});

	function albumEntry(row: LibraryLevelRow): LibraryAlbumEntry {
		return {
			id: row.ref.token,
			title: row.title,
			artist: row.subtitle ?? '',
			searchKey: `${row.title} ${row.subtitle ?? ''}`.toLocaleLowerCase(),
			liveRef: row.ref,
			...(row.imageKey === undefined ? {} : { imageKey: row.imageKey })
		};
	}

	function followAddress(event: MouseEvent, open: () => void): void {
		if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
			return;
		}
		event.preventDefault();
		open();
	}

	function rowFamily(kind: LibraryNodeKind): string {
		return kind === 'track' ? 'recording' : kind === 'entry' ? 'list' : kind;
	}

	function beginRows(selected: readonly LibraryLevelRow[], semantic: 'play-now' | 'add-next' | 'queue'): void {
		if (!actionsEnabled || actionBusy || page.phase !== 'ready' || !selected.length || selected.some(row => !trackRows.includes(row))) return;
		closeRowMenu();
		onRowsAction?.(selected, semantic);
	}

	function closeRowMenu(cancel = true, focus = false): void {
		if (!menuRow) return;
		const current = get(actionController);
		const owns = menuRequestId === null ? current.requestId === menuStartingRequestId : current.requestId === menuRequestId;
		menuRow = null;
		menuRequestId = null;
		menuMayReissue = false;
		if (cancel && owns && current.phase !== 'executing') {
			if (onCloseRowMore) onCloseRowMore();
			else actionController.cancel();
		}
		if (focus) menuTrigger?.focus();
		menuTrigger = null;
	}

	function openRowMenu(row: LibraryLevelRow, event?: MouseEvent): void {
		if (menuRow === row) { closeRowMenu(true, true); return; }
		if (!onRowMore || !actionsEnabled || actionBusy || page.phase !== 'ready' || !rows.includes(row)) return;
		closeRowMenu();
		menuRow = row;
		menuTrigger = event?.currentTarget as HTMLButtonElement ?? null;
		menuTrigger?.focus();
		menuStartingRequestId = get(actionController).requestId;
		menuRequestId = null;
		onRowMore(row);
	}

	// Observe every controller transition, including a bounded same-intent reissue,
	// so choices from a newer unrelated attempt never inherit this row's menu.
	$effect(() => {
		const controller = actionController;
		return controller.subscribe(current => untrack(() => {
			if (!menuRow) return;
			if (current.requestId === menuStartingRequestId && menuRequestId === null) return;
			if (current.requestId !== null && current.requestId !== menuRequestId) {
				if (menuRequestId !== null && !menuMayReissue) { closeRowMenu(false); return; }
				menuRequestId = current.requestId;
				menuMayReissue = false;
			}
			if (current.phase === 'failed' && current.code === 'SESSION_LOST' && !current.executionAttempted) menuMayReissue = true;
			if (current.phase === 'executed') closeRowMenu(false, true);
			else if (current.phase === 'canceled' || current.phase === 'idle') closeRowMenu(false);
		}));
	});
	$effect(() => {
		const selected = menuRow;
		if (selected && (!actionsEnabled || page.phase !== 'ready' || !rows.includes(selected))) untrack(() => closeRowMenu());
	});
	$effect(() => {
		const selection = $trackSelection;
		if (menuRow?.kind === 'track' && (selection.count !== 1 || !selection.selected.has(menuRow))) untrack(() => closeRowMenu());
	});
	onDestroy(() => closeRowMenu());

	function dismissRecordingMenus(event: PointerEvent | KeyboardEvent): void {
		if (!menuRow || menuRow.kind === 'track') return;
		if (event instanceof KeyboardEvent) {
			if (event.key !== 'Escape') return;
			event.preventDefault();
			closeRowMenu(true, true);
		} else {
			const menu = surface?.querySelector('[data-live-row-menu="open"]');
			if (!(event.target instanceof Node) || !menu?.contains(event.target)) closeRowMenu();
		}
	}

	function setAlbumSort(value: string): void {
		railTarget = null;
		onSetAlbumSort(value);
	}
</script>

{#snippet rowMenuContents(row: LibraryLevelRow)}
	{#if menuRow === row}
		{#if menuRequestId === null || action.phase === 'resolving'}<span role="status">Loading…</span>
		{:else if action.phase === 'executing'}<span role="status">Working…</span>
		{:else if action.phase === 'failed' || action.phase === 'outcome-unknown'}<span class="error" role="alert">{action.error ?? 'The action failed.'}</span>
		{:else if action.phase === 'choosing' && action.requestId === menuRequestId}
			{#each action.actions as choice (choice.actionId)}
				<button type="button" role="menuitem" disabled={!actionsEnabled} onclick={() => {
					if (menuRow === row && rows.includes(row) && get(actionController).requestId === menuRequestId) actionController.execute(choice.actionId);
				}}>{choice.label}</button>
			{/each}
			{#if action.actions.length === 0}<span>No actions are available.</span>{/if}
		{/if}
	{/if}
{/snippet}

{#snippet rowControls(row: LibraryLevelRow, prominent: boolean, playable = true)}
	<div class="recording-controls" class:prominent data-live-row-menu={menuRow === row ? 'open' : undefined}>
		{#if playable}
			<LibraryActionButton icon="play" label="Play" disabled={!onRowAction || !actionsEnabled || actionBusy} onclick={() => onRowAction?.(row, 'play-now')} />
			<LibraryActionButton icon="queue" label="Queue" disabled={!onRowAction || !actionsEnabled || actionBusy} onclick={() => onRowAction?.(row, 'queue')} />
		{/if}
		<LibraryActionButton icon="more" label="More" aria-label="More actions for {row.title}" aria-haspopup="menu" aria-expanded={menuRow === row}
			disabled={menuRow !== row && (!onRowMore || !actionsEnabled || actionBusy)} onclick={event => openRowMenu(row, event)} />
		{#if menuRow === row}
			<div class="recording-menu" role="menu" aria-label="Actions for {row.title}">{@render rowMenuContents(row)}</div>
		{/if}
	</div>
{/snippet}

{#snippet selectedTrackMore(selected: LibraryLevelRow[])}
	{#if selected.length === 1}{@render rowMenuContents(selected[0])}{/if}
{/snippet}

<svelte:window onpointerdown={dismissRecordingMenus} onkeydown={dismissRecordingMenus} />

<section
	bind:this={surface}
	class="item-page"
	data-testid="unified-live-collection-page"
	data-level-kind={levelKind}
>
	<div class="ctx library-list-toolbar" class:has-tracks={trackRows.length > 0} use:measureLibraryChrome={'toolbar'}>
		<div class="live-heading-core">
		<button type="button" class="back" onclick={onBack}>← {backLabel}</button>
		<h2 tabindex="-1" data-testid="unified-live-collection-title">
			{page.target?.title ?? page.path?.steps.at(-1)?.title ?? 'Library'}
		</h2>
		{#if levelKind !== 'genre' && page.phase === 'ready' && albumRows.length > 0}
			<span class="n mono" data-testid="unified-live-collection-summary">
				{albumRows.length.toLocaleString()} ALBUMS
			</span>
		{/if}
		{#if page.phase === 'ready' && (levelKind === 'composer' || levelKind === 'composition') && ordinaryRows.length > 0}
			<span class="n mono" data-testid="unified-live-collection-summary">{ordinaryMatches.length.toLocaleString()}{rowFilter ? ` OF ${ordinaryRows.length.toLocaleString()}` : ''} {levelKind === 'composer' ? 'COMPOSITIONS' : 'RECORDINGS'}</span>
		{/if}
		{#if page.phase === 'ready' && trackRows.length > 0}
			<div class="selection-header">
			<TrackSelectionControls selection={trackSelection} orderedItems={trackRows} visibleItems={visibleTracks}
				actions={selectionActions} busy={bookmarkBusy || batchBusy || action.phase === 'resolving' || action.phase === 'executing'} status={bookmarkStatus ?? batchStatus} onCancel={onCancelBatch}
				onBookmark={onBookmark ? bookmarkTracks : undefined} {bookmarkDisabled}
				label={row => row.title} more={selectedTrackMore}
				hasMore={$trackSelection.count === 1 && Boolean(onRowMore)} moreDisabled={!actionsEnabled}
				remoteMenuActive={menuRow?.kind === 'track'}
				onOpenMore={selected => { if (selected.length === 1) openRowMenu(selected[0]); }}
				onCloseMore={() => closeRowMenu()} />
			</div>
		{/if}
		</div>
		{#if levelKind !== 'genre' && page.phase === 'ready' && albumRows.length > 0}
			<div class="sortc-wrap">
				<button
					type="button"
					class="sortc"
					data-testid="unified-live-collection-sort"
					aria-haspopup="menu"
					aria-expanded={sortOpen}
					onclick={() => (sortOpen = !sortOpen)}
				>
					Sort: <b>{sortMenu.find((option) => option.id === sorts.albums)?.label ?? ''}</b>
					<span style="color:var(--dim)">▾</span>
				</button>
				<div class="smenu" class:open={sortOpen}>
					{#each sortMenu as option (option.id)}
						<button
							type="button"
							class="so"
							class:on={option.id === sorts.albums}
							data-testid="unified-live-collection-sort-option-{option.id}"
							onclick={() => {
							setAlbumSort(option.id);
								sortOpen = false;
							}}
						>
							{option.label}
						</button>
					{/each}
					{#if onSetGroupByLetter}
						<button type="button" class="so grouping-option" class:on={groupByLetter}
							aria-pressed={groupByLetter} disabled={!['az', 'za', 'by-artist'].includes(sorts.albums)}
							onclick={() => { railTarget = null; onSetGroupByLetter?.(!groupByLetter); sortOpen = false; }}>
							Group by letter
						</button>
					{/if}
				</div>
			</div>
		{/if}
		{#if levelKind === 'composer' || levelKind === 'composition'}
			<input class="row-filter" type="search" aria-label="Filter {rowLabel}" placeholder="Filter {rowLabel.toLowerCase()}…" bind:value={rowFilter} disabled={page.phase !== 'ready'} />
			<select class="row-sort" aria-label="Sort {rowLabel}" bind:value={rowSort} disabled={page.phase !== 'ready'}>
				<option value="original">Roon order</option><option value="name-asc">Name A–Z</option><option value="name-desc">Name Z–A</option>
			</select>
		{/if}
		{#if page.phase === 'ready'}
			{#each actionRows as row (`${row.ref.generation}:${row.ref.token}`)}
				<div class="bulk-controls" aria-label={row.title}>
					{#if actionRows.length > 1 || !bulkRows.includes(row)}<span>{row.title}</span>{/if}
					{@render rowControls(row, true, bulkRows.includes(row))}
				</div>
			{/each}
		{/if}

		<EntityFeedback message={!menuRow && (action.phase === 'resolving' || action.phase === 'executing') ? 'Working…' : !menuRow && (action.phase === 'failed' || action.phase === 'outcome-unknown') ? action.error ?? 'The action failed.' : null} />
	</div>

	{#if page.phase === 'opening'}
		<p class="status">Loading…</p>
	{:else if page.phase === 'failed'}
		<p class="status error">{page.message}</p>
		<button type="button" onclick={onRetry}>Retry</button>
	{:else if page.phase === 'ready'}
		{#if levelKind === 'genre'}
			<UnifiedGenreOverview state={genrePreviews} {density} onCapacity={onPreviewCapacity}
				onRetry={onRetryPreview} onOpen={onOpenPreview} hrefFor={hrefForPreview} />
		{:else}
		{#if albumRows.length > 0}
			<div class="live-album-layout" data-testid="unified-live-albums">
				{#if railVisible}
					<nav class="rail" aria-label="A to Z index" data-testid="unified-rail">
						{#each railLetters as entry (entry.letter)}
							<button
								type="button"
								class:on={railTarget?.letter === entry.letter}
								class:off={!entry.bucket}
								disabled={!entry.bucket}
								onclick={() => entry.bucket && (railTarget = entry.bucket)}
							>
								{entry.letter}
							</button>
						{/each}
					</nav>
				{/if}
				<UnifiedScopeViews
					scope="albums"
					artists={[]}
					{albums}
					{sorts}
					{randomSeed}
					{groupByLetter}
					layoutRevision={density}
					{railTarget}
					genres={{ loading: false, loaded: true, error: null, entries: [], totalCount: 0 }}
					recent={{ loading: false, loaded: true, entries: [] }}
					albumTestId="unified-live-album"
					onOpenLiveAlbum={onOpenAlbum}
					{hrefForAlbum}
				/>
			</div>
		{/if}
		{#if ordinaryRows.length > 0}
			{#if levelKind === 'composer' || levelKind === 'composition'}<h3 class="section-label">{levelKind === 'composer' ? 'Compositions' : 'Recordings'}</h3>{/if}
			{#if ordinaryMatches.length === 0}<p class="status">No matches.</p>{/if}
			<div class="alist prepared-rows" data-testid="unified-live-collection-rows" use:prepareLibraryGrid={[ordinaryMatches, density]}>
				{#each ordinaryMatches as row, index (`${row.ref.generation}:${row.ref.token}`)}
					{@const href = hrefForRow(row)}
					{#if row.kind === 'track'}
						<div class="tr recording-row" data-testid="unified-live-recording-{index}" data-row-kind={row.kind} data-track-select-row
							use:trackSelection.row={{ item: row, ordered: () => visibleTracks, disabled: batchBusy, generation: page.level ?? undefined }}>
							<span class="recording-name"><button type="button" class="tnm" data-track-select-target aria-label="Select {row.title}" aria-pressed="false">{row.title}</button>{#if row.subtitle}<span class="recording-credit">{row.subtitle}</span>{/if}</span>
						</div>
					{:else if href === null}
						<div
							class="live-fact"
							data-testid="unified-live-fact-{index}"
							data-row-kind={row.kind}
						>
							<span class="an">{row.title}</span><span class="ad"></span><span class="ac mono"
								>{row.subtitle ?? ''}</span
							>
						</div>
					{:else}
						<a
							class="arow"
							data-testid="unified-live-{rowFamily(row.kind)}-{index}"
							data-row-kind={row.kind}
							{href}
							onclick={(event) => followAddress(event, () => onOpenRow(row))}
						>
							<span class="an">{row.title}</span><span class="ad"></span><span class="ac mono"
								>{row.subtitle ?? ''}</span
							>
						</a>
					{/if}
				{/each}
			</div>
		{/if}
		{/if}
	{/if}
</section>

<style>
	.live-heading-core { display:flex; align-items:center; gap:11px; min-width:0; flex:1; }
	.has-tracks .live-heading-core { flex-basis:260px; min-width:min(100%,260px); }
	.has-tracks .live-heading-core .back { min-width:0; max-width:25%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
	.selection-header { flex:1 1 160px; min-width:min-content; }
	.has-tracks h2 { max-width:40%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
	.has-tracks .row-filter, .has-tracks .row-sort, .has-tracks .bulk-controls { order:2; }
	.has-tracks .row-filter { margin-left:0; }
	.prepared-rows { display: grid; grid-template-columns: minmax(0, 1fr); --library-chunk-overflow: 280px; }
	.row-filter, .row-sort { font: inherit; font-size: 12px; color: var(--text); background: var(--control); border: 1px solid var(--line); border-radius: 6px; min-height: 32px; padding: 5px 9px; max-width: 100%; }
	.row-filter { margin-left: auto; width: 180px; min-width: 100px; }
	.row-filter:focus-visible, .row-sort:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

	.section-label { margin: 14px 8px 8px; color: var(--soft); font-size: 13px; font-weight: 500; }
	.recording-menu span { padding: 7px 10px; color: var(--soft); font-size: 12px; }
	.recording-menu .error { color: var(--songr-error); }
	.recording-menu button:hover { background: var(--hover-subtle); }
	.recording-row { cursor: default; min-width: 0; }
	.recording-name { display: flex; flex: 1; align-items: baseline; gap: 14px; min-width: 0; }
	.recording-credit { flex: 0 1 40%; min-width: 0; font-size: 12px; color: var(--soft); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.recording-controls { position: relative; display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
	.recording-menu { max-height: 260px; overflow-y: auto; display: flex; flex-direction: column; position: absolute; right: 0; top: 100%; z-index: 20; min-width: 110px; padding: 4px; background: var(--control); border: 1px solid var(--line); border-radius: 5px; }
	.recording-menu button { min-height: var(--library-action-target, 36px); text-align: left; border: 0; background: transparent; color: var(--text); padding: 7px 10px; font: inherit; font-size: 12px; cursor: pointer; }
	.recording-controls button:disabled { cursor: default; color: var(--dim); }
	.recording-controls button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
	@media (max-width: 600px) { .recording-name { flex-direction: column; align-items: stretch; gap: 3px; } .recording-credit { flex-basis: auto; } }

	.live-album-layout {
		display: flex;
		min-height: 0;
	}

	.live-album-layout :global(.scope-view) {
		flex: 1;
		min-width: 0;
	}

	.live-fact {
		display: flex;
		align-items: baseline;
		gap: 10px;
		padding: 7px 10px;
		color: var(--songr-soft);
	}
	@media (any-pointer: coarse) { .recording-menu button { min-height: 44px; } }
</style>
