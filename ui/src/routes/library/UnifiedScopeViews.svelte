<script lang="ts">
	import { onDestroy } from 'svelte';
	import { createTrackSelection, type TrackSelection } from '$lib/trackSelection';
	import RetainedLibraryPanel from './RetainedLibraryPanel.svelte';
	import { prepareLibraryGrid } from '$lib/preparedLibraryGrid';
	import { libraryArtwork } from '$lib/actions/libraryArtwork';
	import type { UnifiedLibraryDrillTarget, UnifiedLibraryScope } from '$lib/libraryPageState';
	import { imageUrl } from '$lib/imageUrl';
	import { shouldHandleLibraryAnchorClick } from '$lib/libraryPageNavigation';
	import type { RecentlyPlayedEntry } from '@shared/types';
	import type {
		LetterBucket,
		LibraryAlbumEntry,
		LibraryArtistEntry
	} from '$lib/libraryEntries';
	import {
		formatGenreAlbumCount,
		GENRE_PAGE_BOUND,
		type NamedCountsState
	} from '$lib/stores/unifiedNamedCountsStore';
	import type { RecentlyPlayedState } from '$lib/stores/recentlyPlayedStore';
	import type {
		UnifiedAlbumsSort,
		UnifiedArtistsSort,
		UnifiedGenresSort
	} from '$lib/stores/unifiedLibraryPrefsStore';
	import {
		seededShuffle,
		sortAlbums,
		sortArtists,
		sortNamedCounts
	} from '$lib/unifiedLibrarySorts';

	/**
	 * Scope views ported from the owner-approved prototype
	 * (`library-surface.html`, build-v5): `artistRows`, `albumTiles`,
	 * genre cards, and `grouped()` letter sections, emitting the
	 * prototype's exact DOM classes styled by `unified-surface.css`.
	 * Data ownership stays in UnifiedLibraryMode.
	 */

	interface Props {
		scope: UnifiedLibraryScope;
		artists: readonly LibraryArtistEntry[];
		albums: readonly LibraryAlbumEntry[];
		sorts: {
			readonly artists: UnifiedArtistsSort;
			readonly albums: UnifiedAlbumsSort;
			readonly genres: UnifiedGenresSort;
		};
		randomSeed?: number;
		surpriseSeed?: number;
		groupByLetter?: boolean;
		retainScopes?: boolean;
		layoutRevision?: unknown;
		railTarget: LetterBucket | null;
		genres: NamedCountsState;
		recent: RecentlyPlayedState;
		onDrill?: (target: UnifiedLibraryDrillTarget) => void;
		/**
		 * Opens one row Roon itself rendered, by the reference that row carries
		 * (`.agents/plans/library-live-view.md` Slice 2).
		 *
		 * A live row is never named by a drill target: it has no catalog
		 * identity, and none is minted for it. The whole entry is handed back
		 * because the host — the one place that knows which list this is —
		 * builds the row's address from it.
		 */
		onOpenLiveArtist?: (entry: LibraryArtistEntry) => void;
		onOpenLiveAlbum?: (entry: LibraryAlbumEntry) => void;
		recentSelection?: TrackSelection<RecentlyPlayedEntry>;
		bookmarkBusy?: boolean;
		hrefForArtist?: (entry: LibraryArtistEntry) => string | null;
	hrefForAlbum?: (entry: LibraryAlbumEntry) => string | null;
	hrefForDrill?: (target: UnifiedLibraryDrillTarget) => string | null;
	albumTestId?: string;
	}

	const {
		scope,
		artists,
		albums,
		sorts,
		randomSeed = 1,
		surpriseSeed = randomSeed,
		groupByLetter = false,
		retainScopes = false,
		layoutRevision,
		railTarget,
		genres,
		recent,
		onDrill,
		onOpenLiveArtist,
		onOpenLiveAlbum,
		recentSelection = createTrackSelection<RecentlyPlayedEntry>(),
		bookmarkBusy = false,
		hrefForArtist,
		hrefForAlbum,
		hrefForDrill,
		albumTestId = 'unified-tile'
	}: Props = $props();
	$effect(() => {
		recentSelection.retain(recent.entries, recent.entries);
		if (scope !== 'recently-played') recentSelection.clear();
	});
	onDestroy(() => recentSelection.clear());

	interface TileItem {
		readonly source?: LibraryAlbumEntry;
		readonly recent?: RecentlyPlayedEntry;
		readonly key: string;
		readonly title: string;
		readonly artist: string;
		readonly imageKey: string | null;
		readonly versionCount: number;
		/** The live row this tile is, when it came from Roon's own list. */
		readonly live?: LibraryAlbumEntry;
	}

	interface Group<T> {
		readonly letter: string;
		readonly items: readonly T[];
	}

	/** Prototype `drawRandom` samples 24. */
	const SURPRISE_SAMPLE = 24;
	const GROUP_LETTERS: readonly string[] = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];

	let scroller: HTMLDivElement | null = $state(null);

	/** Prototype `sortKey`/`letterOf`: article-stripped, A–Z else '#'. */
	const stripArticle = (s: string): string => s.replace(/^(the |a |an )/i, '').trim();
	const letterOf = (key: string): string => {
		const c = (key[0] ?? '#').toUpperCase();
		return /[A-Z]/.test(c) ? c : '#';
	};

	/** Prototype `monogram`: hash-gradient art fallback. */
	function monogram(title: string): { style: string; letter: string } {
		const w = stripArticle(title || '?');
		let h = 0;
		for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0;
		return {
			style: `background:linear-gradient(150deg,hsl(${h % 360},14%,20%),hsl(${(h + 40) % 360},12%,11%))`,
			letter: (w[0] ?? '?').toUpperCase()
		};
	}

	/** Prototype `grouped()`: bucket first, then emit in fixed rail order. */
	function groupBy<T>(
		items: readonly T[],
		letterFn: (item: T) => string,
		direction: 'az' | 'za' = 'az'
	): Group<T>[] {
		const buckets = new Map<string, T[]>();
		for (const item of items) {
			const letter = letterFn(item);
			const bucket = buckets.get(letter);
			if (bucket) bucket.push(item);
			else buckets.set(letter, [item]);
		}
		const order = direction === 'za' ? [...GROUP_LETTERS].reverse() : GROUP_LETTERS;
		return order
			.filter((letter) => buckets.has(letter))
			.map((letter) => ({ letter, items: buckets.get(letter)! }));
	}

	const artistsSorted = $derived(sortArtists(artists, sorts.artists));
	const artistGroups = $derived(
		groupByLetter && (sorts.artists === 'az' || sorts.artists === 'za')
			? groupBy(artistsSorted, (a) => letterOf(a.searchKey), sorts.artists)
			: null
	);

	const albumTile = (entry: LibraryAlbumEntry): TileItem => ({
		source: entry,
		key: entry.id,
		title: entry.title,
		artist: entry.artist,
		imageKey: entry.imageKey ?? null,
		versionCount: entry.versionCount ?? 1,
		// A live row opens by its own reference, which is the whole identity it
		live: entry
	});

	const albumsSorted = $derived(sortAlbums(albums, sorts.albums, sorts.albums === 'shuffle' ? randomSeed : 0));
	const albumGroups = $derived.by((): Group<TileItem>[] | null => {
		if (!groupByLetter) return null;
		if (sorts.albums === 'az' || sorts.albums === 'za')
			return groupBy(albumsSorted, (b) => letterOf(b.searchKey), sorts.albums).map((g) => ({
				letter: g.letter,
				items: g.items.map(albumTile)
			}));
		if (sorts.albums === 'by-artist')
			return groupBy(albumsSorted, (b) => letterOf(stripArticle(b.artist).toLowerCase())).map(
				(g) => ({ letter: g.letter, items: g.items.map(albumTile) })
			);
		return null;
	});
	const albumsFlat = $derived(albumsSorted.map(albumTile));

	const surpriseTiles = $derived(
		seededShuffle(albums, surpriseSeed).slice(0, SURPRISE_SAMPLE).map(albumTile)
	);

	const recentTiles = $derived(
		recent.entries.map(
			(entry, index): TileItem => ({
				key: `rp:${index}:${entry.played_at}`,
				title: entry.title?.trim() || 'Unknown track',
				recent: entry,
				artist: entry.artist ?? '',
				imageKey: entry.image_key ?? null,
				versionCount: 1
			})
		)
	);

	interface CardItem {
		readonly key: string;
		readonly label: string;
		readonly count: number;
		readonly drill: UnifiedLibraryDrillTarget;
	}

	const namedCards = (state: NamedCountsState, sort: UnifiedGenresSort): CardItem[] =>
		sortNamedCounts(state.entries, sort).map((entry) => ({
			key: `genre:${entry.label}`,
			label: entry.label,
			count: entry.albumCount,
			drill: { kind: 'genre', label: entry.label }
		}));

	const genreCards = $derived(namedCards(genres, sorts.genres));
	const cardGroups = $derived.by((): Group<CardItem>[] | null => {
		const sort = sorts.genres;
		if (!groupByLetter || (sort !== 'az' && sort !== 'za')) return null;
		return groupBy(
			genreCards,
			(card) => letterOf(stripArticle(card.label).toLowerCase()),
			sort
		);
	});

	$effect(() => {
		if (!railTarget || !scroller) return;
		if (scroller.closest('[data-retained-library-panel][aria-hidden="true"]')) return;
		const activeScope = retainScopes
			? scroller.querySelector<HTMLElement>(`[data-scope-panel="${scope}"]`)
			: scroller;
		if (!activeScope || activeScope.closest('[data-retained-library-panel][aria-hidden="true"]')) return;
		const target = activeScope.querySelector<HTMLElement>(
			`[data-grp="${railTarget.letter}"], [data-letter="${railTarget.letter}"]`
		);
		if (target && typeof target.scrollIntoView === 'function')
			target.scrollIntoView({ block: 'start' });
	});

	function scopeStatus(scope: UnifiedLibraryScope): string | null {
		if (scope === 'genres') {
			if (genres.loading && !genres.loaded) return 'Loading genres…';
			if (genres.error) return `Could not load genres: ${genres.error}`;
			if (genres.loaded && genres.entries.length === 0) return 'No genres in this library.';
		}
		if (scope === 'recently-played') {
			if (recent.loading && !recent.loaded) return 'Loading recent plays…';
			if (recent.loaded && recent.entries.length === 0)
				return 'No recent plays yet.';
		}
		if (scope === 'artists' && artists.length === 0) return 'No artists in this library.';
		if ((scope === 'albums' || scope === 'surprise') && albums.length === 0)
			return 'No albums in this library.';
		return null;
	}

	function followAddress(event: MouseEvent, open: (() => void) | undefined): void {
		if (open === undefined || !shouldHandleLibraryAnchorClick(event)) return;
		event.preventDefault();
		open();
	}
</script>

{#snippet artistRows(rows: readonly LibraryArtistEntry[])}
	<div class={artistGroups ? 'alist' : 'alist artist-grid'}>
		{#each rows as entry (entry.id)}
			{@const href = hrefForArtist?.(entry) ?? null}
			{@const open = onOpenLiveArtist ? () => onOpenLiveArtist(entry) : undefined}
			<svelte:element
				this={href === null ? 'button' : 'a'}
				role={href === null ? 'button' : 'link'}
				type={href === null ? 'button' : undefined}
				{href}
				class="arow"
				data-letter={letterOf(entry.searchKey)}
				data-testid="unified-row"
				disabled={href === null && open === undefined}
				onclick={(event: MouseEvent) =>
					href === null ? open?.() : followAddress(event, open)}
			>
				<span class="an">{entry.name}</span><span class="ad"></span><span class="ac mono"
					><!-- Build-v5 renders the count Roon supplies on every Artists row. -->{entry.albumCount ===
					undefined
						? ''
						: entry.albumCount}</span
				>
			</svelte:element>
		{/each}
	</div>
{/snippet}

{#snippet albumTiles(items: readonly TileItem[])}
	<div class="tiles" use:prepareLibraryGrid={[items, layoutRevision]}>
		{#each items as tile (tile.key)}
			{@const liveEntry = tile.live}
			{@const drillable = liveEntry !== undefined && onOpenLiveAlbum !== undefined}
			{@const href = tile.source === undefined ? null : (hrefForAlbum?.(tile.source) ?? null)}
			{@const open = drillable && liveEntry !== undefined ? () => onOpenLiveAlbum?.(liveEntry) : undefined}
			<svelte:element
				this={href === null ? 'button' : 'a'}
				role={href === null ? 'button' : 'link'}
				type={href === null ? 'button' : undefined}
				{href}
				class="tile"
				data-letter={letterOf(sorts.albums === 'by-artist'
					? stripArticle(tile.artist) : (tile.source?.searchKey ?? stripArticle(tile.title)))}
				data-testid={albumTestId}
				disabled={href === null && open === undefined}
				onclick={(event: MouseEvent) =>
					href === null ? open?.() : followAddress(event, open)}
			>
				<div class="art">
					{#if tile.imageKey}
						<img
							use:libraryArtwork={imageUrl(tile.imageKey, { scale: 'fit', width: 300, height: 300 })}
							alt=""
						/>
					{:else}
						{@const mono = monogram(tile.title)}
						<div class="mono-tile" style={mono.style}>{mono.letter}</div>
					{/if}
				</div>
				<div class="tt">{tile.title}</div>
				<div class="ta">{tile.artist}</div>
				{#if tile.versionCount > 1}
					<div class="tv" data-testid="unified-album-version-count">{tile.versionCount} versions</div>
				{/if}
			</svelte:element>
		{/each}
	</div>
{/snippet}

{#snippet cardList(cards: readonly CardItem[])}
	<div class="glist">
		{#each cards as card (card.key)}
			{@const href = hrefForDrill?.(card.drill) ?? null}
			{@const open = onDrill ? () => onDrill(card.drill) : undefined}
			<svelte:element
				this={href === null ? 'button' : 'a'}
				role={href === null ? 'button' : 'link'}
				type={href === null ? 'button' : undefined}
				{href}
				class="gcard"
				data-letter={letterOf(stripArticle(card.label))}
				data-testid="unified-card"
				disabled={href === null && open === undefined}
				onclick={(event: MouseEvent) =>
					href === null ? open?.() : followAddress(event, open)}
			>
				<div class="gn">{card.label}</div>
				<div class="gc mono">{formatGenreAlbumCount(card.count)}</div>
			</svelte:element>
		{/each}
	</div>
{/snippet}

{#snippet grouped(groups: readonly Group<never>[] | null, body: unknown)}
	{#if groups}
		{#each groups as group (group.letter)}
			<div class="grp" data-grp={group.letter}>
				<div class="gl">{group.letter}</div>
				<!-- eslint-disable-next-line -->
				{@render (body as any)(group.items)}
			</div>
		{/each}
	{/if}
{/snippet}

{#snippet scopeContent(selectedScope: UnifiedLibraryScope)}
	{@const status = scopeStatus(selectedScope)}
	{#if status}
		<p class="hint" data-testid="unified-scope-status">{status}</p>
	{:else if selectedScope === 'artists'}
		{#if artistGroups}
			{@render grouped(artistGroups as never, artistRows)}
		{:else}
			{@render artistRows(artistsSorted)}
		{/if}
	{:else if selectedScope === 'albums'}
		{#if albumGroups}
			{@render grouped(albumGroups as never, albumTiles)}
		{:else}
			{@render albumTiles(albumsFlat)}
		{/if}
	{:else if selectedScope === 'surprise'}
		{@render albumTiles(surpriseTiles)}
		<div class="hint">
			Choose Surprise me again for another selection.
		</div>
	{:else if selectedScope === 'genres'}
		{#if cardGroups}
			{@render grouped(cardGroups as never, cardList)}
		{:else}
			{@render cardList(genreCards)}
		{/if}
		{#if genreCards.some(card => card.count >= GENRE_PAGE_BOUND)}
			<div class="hint">+ means at least this many albums.</div>
		{/if}
	{:else if selectedScope === 'recently-played'}
		<div class="tiles recent-tiles" use:prepareLibraryGrid={[recentTiles, layoutRevision]}>
			{#each recentTiles as tile (tile.key)}
				{@const entry = tile.recent!}
				<div class="tile recent-tile" data-testid={albumTestId} data-track-select-row
					use:recentSelection.row={{ item: entry, ordered: () => recent.entries,
						generation: recent.entries, disabled: bookmarkBusy || scope !== 'recently-played' }}>
					<div class="art">
						{#if tile.imageKey}
							<img use:libraryArtwork={imageUrl(tile.imageKey, { scale: 'fit', width: 300, height: 300 })} alt="" />
						{:else}
							{@const mono = monogram(tile.title)}
							<div class="mono-tile" style={mono.style}>{mono.letter}</div>
						{/if}
					</div>
					<button type="button" class="tt" data-track-select-target aria-label="Select {tile.title}" aria-pressed="false">{tile.title}</button>
					<div class="ta">{tile.artist}</div>
				</div>
			{/each}
		</div>
	{/if}
{/snippet}

<div class="scope-view" data-testid="unified-scope-view" data-scope={scope} bind:this={scroller}>
	{#if retainScopes}
		{#each ['artists', 'albums', 'genres', 'recently-played', 'surprise'] as heldScope (heldScope)}
			<RetainedLibraryPanel active={scope === heldScope}
				revision={heldScope === 'artists' ? [artists, sorts.artists, groupByLetter, layoutRevision] :
					heldScope === 'albums' ? [albums, sorts.albums, groupByLetter, layoutRevision, sorts.albums === 'shuffle' ? randomSeed : 0] :
					heldScope === 'genres' ? [genres, sorts.genres, groupByLetter, layoutRevision] :
					heldScope === 'surprise' ? [albums, surpriseSeed, layoutRevision] : [recent, layoutRevision]}>
				<div data-scope-panel={heldScope}>{@render scopeContent(heldScope as UnifiedLibraryScope)}</div>
			</RetainedLibraryPanel>
		{/each}
		{#if !['artists', 'albums', 'genres', 'recently-played', 'surprise'].includes(scope)}
			{@render scopeContent(scope)}
		{/if}
	{:else}
		{@render scopeContent(scope)}
	{/if}
</div>

<style>
	.recent-tile { position: relative; }
</style>
