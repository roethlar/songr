<script lang="ts">
	/**
	 * Spotlight-style palette for the unified library view (plan §3.2,
	 * slice 7).
	 *
	 * Instant sections come from Roon's own two roots (the live view's Artists
	 * and Albums snapshot) and the complete named stores (composers, genres) with
	 * the prototype's literal labels. Smart filters parse from free text: count
	 * filters run over the count Roon printed in each Artists row's own
	 * subtitle, and a row Roon gave no count for is not tested.
	 * The async section shows song results.
	 * Song rows select their exact server-authorized result for shared actions.
	 * The same palette also previews every
	 * keyless Roon Browse-search category; See All moves into the semantic
	 * Browse scope. Artwork is display data only.
	 */
	import { onMount } from 'svelte';
	import type { UnifiedLibraryDrillTarget } from '$lib/libraryPageState';
	import type { LibraryAlbumEntry, LibraryArtistEntry } from '$lib/libraryEntries';
	import type { LibraryRootsState } from '$lib/stores/libraryRootsStore';
	import {
		formatGenreAlbumCount,
		type NamedCountsState
	} from '$lib/stores/unifiedNamedCountsStore';
	import {
		unifiedPaletteSearchStore,
		PALETTE_SEARCH_MIN_QUERY,
		type PaletteSearchRow,
		type PaletteSearchState
	} from '$lib/stores/unifiedPaletteSearchStore';
	import { parseSmartFilters } from '$lib/unifiedSmartFilters';
	import { pluralize } from '$lib/pluralize';
	import { normalizeLibraryText } from '@shared/libraryText';
	import type { AddFavoriteRequest, SearchResult } from '@shared/types';
	import { bookmarkPayload } from '$lib/bookmarks';
	import type { UnifiedSongActionSemantic } from '@shared/unifiedSearchContracts';
	import { createTrackSelection } from '$lib/trackSelection';
	import { browseItemOpensActions } from '$lib/library/UnifiedBrowseController';
	import type { BrowseRowActions } from '$lib/library/browsePresentation';
	import UnifiedBrowseRowControls from './UnifiedBrowseRowControls.svelte';
	import TrackSelectionControls from './TrackSelectionControls.svelte';

	const INSTANT_ROW_LIMIT = 8;
	const NAMED_ROW_LIMIT = 4;
	const SEARCH_DEBOUNCE_MS = 250;
	const TRY_SEEDS = ['bowie', '>30 albums', 'one album', 'jazz'] as const;

	let {
		roots,
		genres,
		composers,
		searchStore = unifiedPaletteSearchStore,
		query = $bindable(''),
		selectedRowId = $bindable<string | null>(null),
		onClose,
		onDrill,
		onOpenLiveArtist,
		onOpenLiveAlbum,
		onSongsAction,
		onBookmark,
		bookmarkBusy = false,
		bookmarkStatus = null,
		songBatchBusy = false,
		songBatchStatus = null,
		onCancelSongBatch,
		onBrowseResult = () => {},
		browseActions,
		onBrowseCategory = () => {},
		onApplyFilter,
		onSearch
	}: {
		roots: LibraryRootsState;
		genres: NamedCountsState;
		composers: NamedCountsState;
		searchStore?: typeof unifiedPaletteSearchStore;
		query?: string;
		selectedRowId?: string | null;
		onClose: () => void;
		onDrill: (target: UnifiedLibraryDrillTarget) => void;
		onOpenLiveArtist: (entry: LibraryArtistEntry) => void;
		onOpenLiveAlbum: (entry: LibraryAlbumEntry) => void;
		onSongsAction?: (songs: readonly PaletteSearchRow[], semantic: UnifiedSongActionSemantic) => void;
		onBookmark?: (items: readonly AddFavoriteRequest[]) => void;
		bookmarkBusy?: boolean;
		bookmarkStatus?: string | null;
		songBatchBusy?: boolean;
		songBatchStatus?: string | null;
		onCancelSongBatch?: () => void;
		onBrowseResult?: (query: string, result: SearchResult) => void;
		browseActions?: BrowseRowActions;
		onBrowseCategory?: (query: string, categoryTitle: string) => void;
		onApplyFilter: (text: string) => void;
		onSearch: (query: string) => void;
	} = $props();

	interface PaletteRow {
		readonly id: string;
		readonly icon: string;
		readonly primary: string;
		readonly secondary: string;
		readonly filter: boolean;
		readonly activate: (() => void) | null;
		readonly actionItem?: SearchResult;
		readonly song?: PaletteSearchRow;
	}

	interface PaletteGroup {
		readonly label: string;
		readonly rows: readonly PaletteRow[];
	}

	let inputEl = $state<HTMLInputElement | null>(null);
	let listEl = $state<HTMLElement | null>(null);
	type PaletteTrack = PaletteSearchRow | SearchResult;
	const trackSelection = createTrackSelection<PaletteTrack>();

	const searchState = $derived<PaletteSearchState>($searchStore);

	function truncationLabel(base: string, shown: number, total: number): string {
		return total > shown ? `${base} — FIRST ${shown} OF ${total}` : base;
	}

	function paletteIconForGroup(title: string): string {
		const normalized = title.toLowerCase();
		if (normalized.includes('artist')) return '♪';
		if (normalized.includes('composer')) return '♩';
		if (normalized.includes('album')) return '○';
		if (normalized.includes('genre')) return '☉';
		if (normalized.includes('track') || normalized.includes('song')) return '♬';
		return '⋮';
	}

	function paletteLabelForGroup(title: string): string {
		return title.toLowerCase().includes('track') ? 'SONGS' : title.toUpperCase();
	}

	const groups = $derived.by((): PaletteGroup[] => {
		const q = query.trim();
		if (!q) return [];
		const nq = normalizeLibraryText(q);
		const lq = q.toLowerCase();
		const out: PaletteGroup[] = [];

		// Smart filters (§3.2): count filters run over Roon's own Artists root,
		// on the count Roon printed in each row's own subtitle. A row Roon gave
		// no count for is not tested — `undefined` is not zero.
		const filterRows: PaletteRow[] = parseSmartFilters(q).map((filter, i) => {
			const matches = roots.artists.reduce(
				(total, artist) =>
					artist.albumCount !== undefined && filter.test(artist.albumCount)
						? total + 1
						: total,
				0
			);
			return {
				id: `filter-${i}`,
				icon: '⋮',
				primary: filter.label,
				secondary: `${matches} artists`,
				filter: true,
				activate: () => onApplyFilter(filter.text)
			};
		});
		if (filterRows.length > 0) out.push({ label: 'FILTERS', rows: filterRows });

		if (roots.phase === 'ready') {
			const genreMatches = genres.entries.filter((entry) =>
				normalizeLibraryText(entry.label).includes(nq)
			);
			if (genreMatches.length > 0) {
				out.push({
					label: 'GENRES',
					rows: genreMatches.slice(0, NAMED_ROW_LIMIT).map((entry) => ({
						id: `genre-${entry.label}`,
						icon: '☉',
						primary: `Genre: ${entry.label}`,
						secondary: formatGenreAlbumCount(entry.albumCount),
						filter: false,
						activate: () => onDrill({ kind: 'genre', label: entry.label })
					}))
				});
			}

			const artistMatches = roots.artists.filter(
				(entry) => entry.searchKey.includes(nq) || entry.name.toLowerCase().includes(lq)
			);
			if (artistMatches.length > 0) {
				out.push({
					label: truncationLabel(
						'ARTISTS',
						Math.min(artistMatches.length, INSTANT_ROW_LIMIT),
						artistMatches.length
					),
					rows: artistMatches.slice(0, INSTANT_ROW_LIMIT).map((entry) => ({
						id: `artist-${entry.id}`,
						icon: '♪',
						primary: entry.name,
						secondary:
							entry.albumCount !== undefined
								? `${entry.albumCount} ${pluralize(entry.albumCount, 'album', 'albums')}`
								: '',
						filter: false,
						activate: () => onOpenLiveArtist(entry)
					}))
				});
			}

			const albumMatches = roots.albums.filter(
				(entry) => entry.searchKey.includes(nq) || entry.title.toLowerCase().includes(lq)
			);
			if (albumMatches.length > 0) {
				out.push({
					label: truncationLabel(
						'ALBUMS',
						Math.min(albumMatches.length, INSTANT_ROW_LIMIT),
						albumMatches.length
					),
					rows: albumMatches.slice(0, INSTANT_ROW_LIMIT).map((entry) => ({
						id: `album-${entry.id}`,
						icon: '○',
						primary: entry.title,
						secondary: entry.artist,
						filter: false,
						activate: () => onOpenLiveAlbum(entry)
					}))
				});
			}

			const composerMatches = composers.entries.filter(
				(entry) =>
					normalizeLibraryText(entry.label).includes(nq) ||
					entry.label.toLowerCase().includes(lq)
			);
			if (composerMatches.length > 0) {
				out.push({
					label: truncationLabel(
						'COMPOSERS',
						Math.min(composerMatches.length, NAMED_ROW_LIMIT),
						composerMatches.length
					),
					rows: composerMatches.slice(0, NAMED_ROW_LIMIT).map((entry) => ({
						id: `composer-${entry.label}`,
						icon: '♩',
						primary: `Composer: ${entry.label}`,
						secondary: entry.countLabel ?? '',
						filter: false,
						activate: () => onDrill({ kind: 'composer', label: entry.label })
					}))
				});
			}
		}

		const browseGroups = searchState.browseGroups ?? [];
		const browseTrackGroup = browseGroups.find((group) => group.resultType === 'track');
		const browseTrackCategoryTitle = browseTrackGroup?.categoryTitle;

		// The retained-result-ID song authority stays the one direct SONGS
		// group. Its See All row enters the full Roon Tracks category.
		for (const group of searchState.groups) {
			const rows: PaletteRow[] = group.rows.map((row) => ({
				id: `song-${row.resultId}`,
				icon: paletteIconForGroup(group.title),
				primary: row.title,
				secondary: row.subtitle,
				filter: false,
				activate: null,
				song: row
			}));
			if (
				browseTrackCategoryTitle &&
				browseTrackGroup.total > group.rows.length
			) {
				rows.push({
					id: `roon-see-all-${browseTrackGroup.resultType}-${browseTrackGroup.title}`,
					icon: '→',
					primary: `See all ${browseTrackGroup.title}`,
					secondary: `${browseTrackGroup.total.toLocaleString()} results`,
					filter: false,
					activate: () => onBrowseCategory(q, browseTrackCategoryTitle)
				});
			}
			out.push({
				label: paletteLabelForGroup(group.title),
				rows
			});
		}

		// Browse-search categories are keyless previews. Tracks are omitted
		// when the authoritative SONGS group exists, avoiding two copies of
		// the same result while preserving full reach through See All.
		for (const group of browseGroups) {
			if (group.resultType === 'track' && searchState.groups.length > 0) continue;
			const categoryTitle = group.categoryTitle;
			const rows: PaletteRow[] = group.rows.map((row, index) => ({
				id: `roon-${group.resultType}-${group.title}-${index}-${row.title}-${row.subtitle ?? ''}`,
				icon: paletteIconForGroup(group.title),
				primary: row.title,
				secondary: row.subtitle ?? '',
				filter: false,
				activate: browseItemOpensActions(row) ? null : () => onBrowseResult(q, row),
				...(browseItemOpensActions(row) ? { actionItem: row } : {})
			}));
			if (categoryTitle && group.total > group.rows.length) {
				rows.push({
					id: `roon-see-all-${group.resultType}-${group.title}`,
					icon: '→',
					primary: `See all ${group.title}`,
					secondary: `${group.total.toLocaleString()} results`,
					filter: false,
					activate: () => onBrowseCategory(q, categoryTitle)
				});
			}
			if (rows.length > 0) out.push({ label: `ROON ${paletteLabelForGroup(group.title)}`, rows });
		}
		return out;
	});

	const selectionGroup = $derived(groups.find(group => group.rows.some(row => trackForRow(row))));
	const flatRows = $derived(groups.flatMap((group) => group.rows));
	const selectedIndex = $derived(flatRows.findIndex((row) => row.id === selectedRowId));
	const trackItems = $derived(flatRows.flatMap(row => {
		const track = trackForRow(row);
		return track ? [track] : [];
	}));
	const songSources = $derived(new Map<object, PaletteSearchRow>(flatRows.flatMap(row => row.song ? [[row.song, row.song] as const] : [])));
	const browseSources = $derived(new Map<object, SearchResult>(flatRows.flatMap(row => row.actionItem?.resultType === 'track' ? [[row.actionItem, row.actionItem] as const] : [])));
	const selectionBusy = $derived(bookmarkBusy || songBatchBusy || browseActions?.busy === true);
	const bookmarkDisabled = $derived.by(() => {
		if (searchState.phase !== 'ready') return true;
		for (const item of $trackSelection.selected) if (!item.title.trim()) return true;
		return false;
	});

	function bookmarkTracks(items: PaletteTrack[]): void {
		if (!onBookmark || selectionBusy || searchState.phase !== 'ready' || !items.length ||
			items.some(item => !trackItems.includes(item) || !item.title.trim())) return;
		browseActions?.onCloseMore();
		onBookmark(items.map(item => bookmarkPayload('track', {
			title: item.title,
			artist: item.subtitle,
			imageKey: item.imageKey ?? undefined
		})));
	}
	const selectionDisabled = $derived(searchState.phase !== 'ready' || selectionBusy || (songSources.size > 0
		? !onSongsAction : !browseActions?.enabled || !browseActions.onBatchAction));
	const selectionActions = $derived([
		{ id: 'play', label: 'Play', disabled: selectionDisabled, run: (items: PaletteTrack[]) => runTracks(items, 'play-now') },
		{ id: 'queue', label: 'Queue', disabled: selectionDisabled, run: (items: PaletteTrack[]) => runTracks(items, 'queue') },
		{ id: 'next', label: 'Add next', disabled: selectionDisabled, run: (items: PaletteTrack[]) => runTracks(items, 'add-next') }
	]);
	$effect(() => { trackSelection.retain(searchState.phase === 'ready' ? trackItems : [], searchState); });
	$effect(() => { void query; trackSelection.clear(); });
	$effect(() => {
		const selected = $trackSelection;
		const menu = browseActions?.menu;
		const item = menu ? browseSources.get(menu.item) : undefined;
		if (item && (!selected.selected.has(item) || selected.count !== 1)) browseActions?.onCloseMore();
	});

	function trackForRow(row: PaletteRow): PaletteTrack | null {
		return row.song ?? (row.actionItem?.resultType === 'track' ? row.actionItem : null);
	}

	function canActivate(row: PaletteRow): boolean {
		return row.activate !== null || trackForRow(row) !== null;
	}

	function runTracks(items: readonly PaletteTrack[], semantic: UnifiedSongActionSemantic): void {
		if (selectionDisabled || !items.length || items.some(item => !trackItems.includes(item))) return;
		const songs = items.map(item => songSources.get(item));
		if (songs.every((song): song is PaletteSearchRow => song !== undefined)) {
			onSongsAction?.(songs, semantic);
			return;
		}
		const browse = items.map(item => browseSources.get(item));
		if (browse.every((item): item is SearchResult => item !== undefined)) browseActions?.onBatchAction?.(browse, semantic);
	}

	// Selection is keyed by row identity. New async song rows therefore do
	// not move an already-valid artist, album, composer, genre, or filter row.
	$effect(() => {
		const current = flatRows.find((row) => row.id === selectedRowId);
		if (current && canActivate(current)) return;
		selectedRowId =
			flatRows.find(canActivate)?.id ?? null;
	});

	let debounceTimer: ReturnType<typeof setTimeout> | null = null;
	$effect(() => {
		const current = query;
		const trimmed = current.trim();
		const searchAlreadyRepresentsQuery =
			trimmed.length < PALETTE_SEARCH_MIN_QUERY
				? searchState.phase === 'idle' && searchState.query === ''
				: searchState.phase !== 'idle' && searchState.query === trimmed;
		if (debounceTimer !== null) clearTimeout(debounceTimer);
		// Result navigation temporarily unmounts this component while the
		// owning mode retains both the query and server-owned song authority.
		// Remounting the same search must render that state, not replace it.
		if (searchAlreadyRepresentsQuery) {
			debounceTimer = null;
			return;
		}
		debounceTimer = setTimeout(() => {
			debounceTimer = null;
			onSearch(current);
		}, SEARCH_DEBOUNCE_MS);
		return () => {
			if (debounceTimer !== null) {
				clearTimeout(debounceTimer);
				debounceTimer = null;
			}
		};
	});

	$effect(() => {
		inputEl?.focus();
	});

	function move(delta: number): void {
		if (flatRows.length === 0) return;
		let next = selectedIndex >= 0 ? selectedIndex : delta > 0 ? -1 : 0;
		for (let i = 0; i < flatRows.length; i += 1) {
			next = (next + delta + flatRows.length) % flatRows.length;
			if (canActivate(flatRows[next])) break;
		}
		selectedRowId = flatRows[next]?.id ?? null;
		listEl
			?.querySelector(`[data-palette-index="${next}"]`)
			?.scrollIntoView?.({ block: 'nearest' });
	}

	function activateSelected(shift = false): void {
		const row = selectedIndex >= 0 ? flatRows[selectedIndex] : undefined;
		const track = row ? trackForRow(row) : null;
		if (track && !selectionBusy) {
			trackSelection.activateRow(track, trackItems, shift);
			return;
		}
		if (track) return;
		if (row?.activate) {
			row.activate();
			return;
		}
		const first = flatRows.find((candidate) => candidate.activate);
		first?.activate?.();
	}

	function onInputKeydown(event: KeyboardEvent): void {
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			move(1);
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			move(-1);
		} else if (event.key === 'Enter') {
			event.preventDefault();
			activateSelected(event.shiftKey);
		}
	}

	// Escape is handled on `window` (same pattern as ZoneGroupingModal and
	// +layout.svelte's zone menu) rather than only on the input, so it
	// closes the palette no matter what currently has focus. This matters
	// because a click that swaps the palette's content out from under the
	// clicked element (e.g. a TRY seed button, which sets `query` and so
	// unmounts itself in favor of the results list) leaves the browser
	// focus on `document.body` — an ancestor of this component, not a
	// descendant — so a keydown handler on the input or the palette's own
	// container would never see it.
	onMount(() => {
		const handleKeydown = (event: KeyboardEvent) => {
			if (event.key === 'Escape' && !event.defaultPrevented) {
				event.preventDefault();
				onClose();
			}
		};
		window.addEventListener('keydown', handleKeydown);
		return () => window.removeEventListener('keydown', handleKeydown);
	});

	function rowIndexOf(row: PaletteRow): number {
		return flatRows.indexOf(row);
	}
</script>

{#snippet selectedTrackMore(items: PaletteTrack[])}
 {#if items.length === 1}
  {@const row = browseSources.get(items[0])}
  {@const menu = row && browseActions?.menu?.item === row ? browseActions.menu : undefined}
  {#if menu}
   {#if menu.state.phase === 'loading' || menu.state.phase === 'executing'}<span role="status">{menu.state.phase === 'executing' ? 'Working…' : 'Loading…'}</span>{/if}
   {#if menu.state.error}<span role="alert">{menu.state.error}</span>{/if}
   {#each menu.state.actions ?? [] as choice}
    <button type="button" role="menuitem" disabled={menu.state.phase !== 'ready' || !browseActions?.enabled} onclick={() => menu.onChoose(choice)}>{choice.title}</button>
   {/each}
   {#if menu.state.phase === 'ready' && !menu.state.actions?.length}<span>No actions are available.</span>{/if}
  {/if}
 {/if}
{/snippet}

<div
	class="pal open"
	data-testid="unified-palette"
	role="presentation"
	onclick={(event) => {
		if (event.target === event.currentTarget) onClose();
	}}
>
	<div class="palbox" role="dialog" aria-modal="true" aria-label="Library search">
		<input
			bind:this={inputEl}
			bind:value={query}
			data-testid="unified-palette-input"
			placeholder="Artist, album, song — or a filter: >30 albums, one album, jazz"
			autocomplete="off"
			spellcheck="false"
			onkeydown={onInputKeydown}
		/>
		<div class="pres" bind:this={listEl} data-testid="unified-palette-results">
			{#if browseActions?.status && trackItems.length === 0}
				<p class="palette-action-status" class:error={browseActions.error}
					role={browseActions.error ? 'alert' : 'status'}>{browseActions.status}</p>
			{/if}
			{#if !query.trim()}
				<div class="pgl">TRY</div>
				{#each TRY_SEEDS as trySeed (trySeed)}
					<button
						type="button"
						class="prow"
						data-testid="unified-palette-seed"
						onclick={() => {
							query = trySeed;
						}}
					>
						<span class="ic">→</span>
						<span class="p1">{trySeed}</span>
					</button>
				{/each}
			{:else}
				{#each groups as group, groupIndex (`${groupIndex}:${group.label}`)}
					<div class="pgl" class:palette-track-heading={group === selectionGroup} data-testid="unified-palette-group">
						<span class="palette-group-label" title={group.label}>{group.label}</span>
						{#if group === selectionGroup}
							<div class="palette-selection"><TrackSelectionControls selection={trackSelection} orderedItems={trackItems} visibleItems={trackItems}
						actions={selectionActions} busy={selectionBusy} status={bookmarkStatus ?? songBatchStatus ?? browseActions?.status}
						onBookmark={onBookmark ? bookmarkTracks : undefined} {bookmarkDisabled}
						onCancel={songSources.size > 0 ? onCancelSongBatch : browseActions?.onCancel}
						label={item => item.title} more={selectedTrackMore}
      hasMore={$trackSelection.count === 1 && Boolean(browseActions?.onMore) && [...$trackSelection.selected].some(item => browseSources.has(item))}
      moreDisabled={!browseActions?.enabled}
      remoteMenuActive={Boolean(browseActions?.menu && $trackSelection.count === 1 && [...$trackSelection.selected].some(item => browseSources.get(item) === browseActions?.menu?.item))}
      onOpenMore={items => { const row = items.length === 1 ? browseSources.get(items[0]) : undefined; if (row) browseActions?.onMore(row); }}
      onCloseMore={() => browseActions?.onCloseMore()} /></div>
						{/if}
					</div>
					{#each group.rows as row (row.id)}
						{@const track = trackForRow(row)}
						{#if track}
							<div class="prow palette-action-row" class:sel={row.id === selectedRowId} role="group" aria-label={track.title}
								data-testid="unified-palette-row" data-palette-index={rowIndexOf(row)} data-track-select-row
								onpointerdown={() => selectedRowId = row.id} onfocusin={() => selectedRowId = row.id}
								use:trackSelection.row={{ item: track, ordered: () => trackItems, disabled: selectionBusy, generation: searchState }}>
								<button type="button" class="p1" data-track-select-target aria-label="Select {track.title}" aria-pressed="false">{row.primary}</button><span class="p2" title={row.secondary}>{row.secondary}</span>
							</div>
						{:else if row.actionItem}
							<div class="prow palette-action-row" data-testid="unified-palette-row">
								<span class="ic">{row.icon}</span>
								<span class="p1">{row.primary}</span>
								<span class="p2" title={row.secondary}>{row.secondary}</span>
								<UnifiedBrowseRowControls item={row.actionItem} actions={browseActions}
									playable={row.actionItem.resultType === 'track'} favorite={false} />
							</div>
						{:else}
						<button
							type="button"
							class="prow"
							class:sel={row.id === selectedRowId}
							class:filter={row.filter}
							data-testid="unified-palette-row"
							data-palette-index={rowIndexOf(row)}
							onclick={() => {
								row.activate?.();
							}}
							onmousemove={() => {
								const idx = rowIndexOf(row);
								if (idx >= 0) selectedRowId = row.id;
							}}
						>
							<span class="ic">{row.icon}</span>
							<span class="p1">{row.primary}</span>
								<span class="p2" title={row.secondary || undefined}>{row.secondary}</span>
						</button>
						{/if}
					{/each}
				{/each}
				{#if searchState.phase === 'searching'}
					<div class="pgl" data-testid="unified-palette-searching">SEARCHING ROON…</div>
				{:else if searchState.phase === 'error'}
					<div class="pgl" data-testid="unified-palette-search-error">
						Roon search failed{searchState.error ? `: ${searchState.error}` : '.'}
					</div>
				{:else if searchState.partialError}
					<div class="pgl" data-testid="unified-palette-search-partial">
						PARTIAL ROON RESULTS: {searchState.partialError}
					</div>
				{:else if groups.length === 0 && query.trim().length >= PALETTE_SEARCH_MIN_QUERY}
					<div class="pgl" data-testid="unified-palette-empty">NOTHING MATCHED</div>
				{/if}
			{/if}
		</div>
		<div class="palhint mono">↑↓ MOVE &nbsp;·&nbsp; ⏎ {selectedIndex >= 0 && trackForRow(flatRows[selectedIndex]) ? 'TOGGLE TRACK' : 'OPEN'} &nbsp;·&nbsp; ESC CLOSE</div>
	</div>
</div>

<style>
	.palette-track-heading { display: flex; align-items: center; flex-wrap: nowrap; gap: 10px;
		position: sticky; top: 0; z-index: 5; background: var(--songr-palette); min-width: 0; }
	.palette-track-heading .palette-group-label { flex: 0 1 auto; min-width: 0; max-width: 30%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.palette-selection { flex: 1; min-width: min-content; letter-spacing: normal; font-weight: 400; }
	.palette-action-row { cursor: default; flex-wrap: wrap; }
	.palette-action-status { padding: 8px 14px; margin: 0; color: var(--soft); font-size: 12px; }
	.palette-action-status.error { color: var(--songr-error); }
	@media (max-width: 600px) {
		.palette-action-row .p2 { display: block; order: 1; flex-basis: 100%; max-width: 100%; white-space: normal; overflow-wrap: anywhere; }
	}
</style>
