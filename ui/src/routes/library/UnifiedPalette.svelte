<script lang="ts">
	/**
	 * Spotlight-style palette for the unified library view (plan §3.2,
	 * slice 7).
	 *
	 * Instant sections come from the local index and complete named stores
	 * (artists, albums, composers, genres) with the prototype's literal labels. Smart
	 * filters parse from free text: count filters run live against Roon's
	 * Artists-row counts and are gated on complete count-list coverage; year expressions
	 * always parse and always render disabled with the no-release-dates
	 * reason. The async section mirrors the prototype's SONGS group.
	 * Every song row opens a song-focused panel through its opaque,
	 * server-authorized identity. Artwork is display data only.
	 */
	import type { UnifiedLibraryDrillTarget } from '$lib/libraryPageState';
	import type { LibraryIndexState } from '$lib/stores/libraryIndexStore';
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
	import { normalizeCatalogText } from '@shared/timelineCatalogContracts';

	const INSTANT_ROW_LIMIT = 8;
	const NAMED_ROW_LIMIT = 4;
	const SEARCH_DEBOUNCE_MS = 250;
	const TRY_SEEDS = ['bowie', '>30 albums', 'one album', 'jazz', '1984-1989'] as const;

	let {
		index,
		genres,
		composers,
		searchStore = unifiedPaletteSearchStore,
		query = $bindable(''),
		selectedRowId = $bindable<string | null>(null),
		onClose,
		onDrill,
		onSong,
		onApplyFilter,
		onSearch
	}: {
		index: LibraryIndexState;
		genres: NamedCountsState;
		composers: NamedCountsState;
		searchStore?: typeof unifiedPaletteSearchStore;
		query?: string;
		selectedRowId?: string | null;
		onClose: () => void;
		onDrill: (target: UnifiedLibraryDrillTarget) => void;
		onSong: (song: PaletteSearchRow) => void;
		onApplyFilter: (text: string) => void;
		onSearch: (query: string) => void;
	} = $props();

	interface PaletteRow {
		readonly id: string;
		readonly icon: string;
		readonly primary: string;
		readonly secondary: string;
		readonly filter: boolean;
		readonly disabled: boolean;
		readonly reason: string | null;
		readonly activate: (() => void) | null;
	}

	interface PaletteGroup {
		readonly label: string;
		readonly rows: readonly PaletteRow[];
	}

	let inputEl = $state<HTMLInputElement | null>(null);
	let listEl = $state<HTMLElement | null>(null);

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
		const nq = normalizeCatalogText(q);
		const lq = q.toLowerCase();
		const out: PaletteGroup[] = [];

		// Smart filters (§3.2): count filters use the complete Roon Artists
		// count list; years remain disabled.
		const filterRows: PaletteRow[] = parseSmartFilters(q).map((filter, i) => {
			if (filter.kind === 'count') {
				if (!index.capabilities.countFilters) {
					return {
						id: `filter-${i}`,
						icon: '⋮',
						primary: filter.label,
						secondary: '',
						filter: true,
						disabled: true,
						reason:
							index.capabilities.countFiltersDisabledReason ??
							'Count filters are unavailable.',
						activate: null
					};
				}
				const matches = index.artists.reduce(
					(total, artist) => (filter.test(artist.albumCount ?? 0) ? total + 1 : total),
					0
				);
				return {
					id: `filter-${i}`,
					icon: '⋮',
					primary: filter.label,
					secondary: `${matches} artists`,
					filter: true,
					disabled: false,
					reason: null,
					activate: () => onApplyFilter(filter.text)
				};
			}
			return {
				id: `filter-${i}`,
				icon: '⋮',
				primary: filter.label,
				secondary: '',
				filter: true,
				disabled: true,
				reason: filter.reason,
				activate: null
			};
		});
		if (filterRows.length > 0) out.push({ label: 'FILTERS', rows: filterRows });

		if (index.phase === 'ready') {
			const genreMatches = genres.entries.filter((entry) =>
				normalizeCatalogText(entry.label).includes(nq)
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
						disabled: false,
						reason: null,
						activate: () => onDrill({ kind: 'genre', label: entry.label })
					}))
				});
			}

			const artistMatches = index.artists.filter(
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
								? `${entry.albumCount} ${pluralize(entry.albumCount, 'album', 'albums')}${index.capabilities.countsApproximate ? ' (approx.)' : ''}`
								: '',
						filter: false,
						disabled: false,
						reason: null,
						activate: () => onDrill({ kind: 'artist', localId: entry.id })
					}))
				});
			}

			const albumMatches = index.albums.filter(
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
						disabled: false,
						reason: null,
						activate: () => onDrill({ kind: 'album', localId: entry.id })
					}))
				});
			}

			const composerMatches = composers.entries.filter(
				(entry) =>
					normalizeCatalogText(entry.label).includes(nq) ||
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
						secondary: formatGenreAlbumCount(entry.albumCount),
						filter: false,
						disabled: false,
						reason: null,
						activate: () => onDrill({ kind: 'composer', label: entry.label })
					}))
				});
			}
		}

		// Async coordinated section — the prototype has one literal SONGS group.
		for (const group of searchState.groups) {
			out.push({
				label: paletteLabelForGroup(group.title),
				rows: group.rows.map((row) => {
					return {
						id: `song-${row.resultId}`,
						icon: paletteIconForGroup(group.title),
						primary: row.title,
						secondary: row.subtitle,
						filter: false,
						disabled: false,
						reason: null,
						activate: () => onSong(row)
					};
				})
			});
		}
		return out;
	});

	const flatRows = $derived(groups.flatMap((group) => group.rows));
	const selectedIndex = $derived(flatRows.findIndex((row) => row.id === selectedRowId));

	// Selection is keyed by row identity. New async song rows therefore do
	// not move an already-valid artist, album, composer, genre, or filter row.
	$effect(() => {
		const current = flatRows.find((row) => row.id === selectedRowId);
		if (current && !current.disabled && current.activate) return;
		selectedRowId =
			flatRows.find((candidate) => !candidate.disabled && candidate.activate)?.id ?? null;
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
			if (!flatRows[next].disabled && flatRows[next].activate) break;
		}
		selectedRowId = flatRows[next]?.id ?? null;
		listEl
			?.querySelector(`[data-palette-index="${next}"]`)
			?.scrollIntoView?.({ block: 'nearest' });
	}

	function activateSelected(): void {
		const row = selectedIndex >= 0 ? flatRows[selectedIndex] : undefined;
		if (row && !row.disabled && row.activate) {
			row.activate();
			return;
		}
		const first = flatRows.find((candidate) => !candidate.disabled && candidate.activate);
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
			activateSelected();
		} else if (event.key === 'Escape') {
			event.preventDefault();
			onClose();
		}
	}

	function rowIndexOf(row: PaletteRow): number {
		return flatRows.indexOf(row);
	}
</script>

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
			placeholder="Artist, album, song — or a filter: >30 albums, one album, 1984-1989, jazz"
			autocomplete="off"
			spellcheck="false"
			onkeydown={onInputKeydown}
		/>
		<div class="pres" bind:this={listEl} data-testid="unified-palette-results">
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
				{#each groups as group (group.label)}
					<div class="pgl" data-testid="unified-palette-group">{group.label}</div>
					{#each group.rows as row (row.id)}
						<button
							type="button"
							class="prow"
							class:sel={row.id === selectedRowId}
							class:dis={row.disabled}
							class:filter={row.filter}
							data-testid="unified-palette-row"
							data-palette-index={rowIndexOf(row)}
							disabled={row.disabled}
							title={row.reason ?? undefined}
							onclick={() => {
								if (!row.disabled) row.activate?.();
							}}
							onmousemove={() => {
								const idx = rowIndexOf(row);
								if (!row.disabled && idx >= 0) selectedRowId = row.id;
							}}
						>
							<span class="ic">{row.icon}</span>
							<span class="p1">{row.primary}</span>
							<span class="p2">{row.secondary || row.reason || ''}</span>
						</button>
					{/each}
				{/each}
				{#if searchState.phase === 'searching'}
					<div class="pgl" data-testid="unified-palette-searching">SEARCHING ROON…</div>
				{:else if searchState.phase === 'error'}
					<div class="pgl" data-testid="unified-palette-search-error">
						Roon search failed{searchState.error ? `: ${searchState.error}` : '.'}
					</div>
				{:else if groups.length === 0 && query.trim().length >= PALETTE_SEARCH_MIN_QUERY}
					<div class="pgl" data-testid="unified-palette-empty">NOTHING MATCHED</div>
				{/if}
			{/if}
		</div>
		<div class="palhint mono">↑↓ SELECT &nbsp;·&nbsp; ⏎ OPEN &nbsp;·&nbsp; ESC CLOSE</div>
	</div>
</div>
