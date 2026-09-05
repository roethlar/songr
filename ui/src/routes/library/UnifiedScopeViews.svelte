<script lang="ts">
	import type { UnifiedLibraryDrillTarget, UnifiedLibraryScope } from '$lib/libraryPageState';
	import { imageUrl } from '$lib/imageUrl';
	import { shouldHandleLibraryAnchorClick } from '$lib/libraryPageNavigation';
	import type { UnifiedSongActionSemantic } from '@shared/unifiedSearchContracts';
	import type {
		LetterBucket,
		LibraryAlbumEntry,
		LibraryArtistEntry
	} from '$lib/libraryEntries';
	import {
		formatGenreAlbumCount,
		type NamedCountsState
	} from '$lib/stores/unifiedNamedCountsStore';
	import type { RecentlyPlayedState } from '$lib/stores/recentlyPlayedStore';
	import type {
		UnifiedAlbumsSort,
		UnifiedArtistsSort,
		UnifiedGenresSort
	} from '$lib/stores/unifiedLibraryPrefsStore';
	import {
		NO_IMPORT_DATES_REASON,
		seededShuffle,
		sortAlbums,
		sortAlbumsByRecentlyAdded,
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
		groupAlbums?: boolean;
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
		groupAlbums = true,
		railTarget,
		genres,
		recent,
		onDrill,
		onOpenLiveArtist,
		onOpenLiveAlbum,
		hrefForArtist,
		hrefForAlbum,
		hrefForDrill,
		albumTestId = 'unified-tile'
	}: Props = $props();

	interface TileItem {
		readonly source?: LibraryAlbumEntry;
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
		sorts.artists === 'az' || sorts.artists === 'za'
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

	const albumsSorted = $derived(sortAlbums(albums, sorts.albums, randomSeed));
	const albumGroups = $derived.by((): Group<TileItem>[] | null => {
		if (!groupAlbums) return null;
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
		seededShuffle(albums, randomSeed).slice(0, SURPRISE_SAMPLE).map(albumTile)
	);

	/** Slice 5: library-added timestamp descending from the catalog snapshot, no live reads. */
	const recentlyAddedTiles = $derived(sortAlbumsByRecentlyAdded(albums).map(albumTile));

	const recentTiles = $derived(
		recent.entries.map(
			(entry, index): TileItem => ({
				key: `rp:${index}:${entry.played_at}`,
				title: entry.title ?? 'Unknown track',
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
		if (sort !== 'az' && sort !== 'za') return null;
		return groupBy(
			genreCards,
			(card) => letterOf(stripArticle(card.label).toLowerCase()),
			sort
		);
	});

	$effect(() => {
		if (!railTarget || !scroller) return;
		const target = scroller.querySelector<HTMLElement>(`[data-grp="${railTarget.letter}"]`);
		if (target && typeof target.scrollIntoView === 'function')
			target.scrollIntoView({ block: 'start' });
	});

	const status = $derived.by((): string | null => {
		if (scope === 'genres') {
			if (genres.loading && !genres.loaded) return 'Loading genres…';
			if (genres.error) return `Could not load genres: ${genres.error}`;
			if (genres.loaded && genres.entries.length === 0) return 'No genres in this library.';
		}
		if (scope === 'recently-played') {
			if (recent.loading && !recent.loaded) return 'Loading recent plays…';
			if (recent.loaded && recent.entries.length === 0)
				return 'Nothing recorded yet — plays are tracked only while this controller is running.';
		}
		if (scope === 'artists' && artists.length === 0) return 'No artists in this library.';
		if ((scope === 'albums' || scope === 'surprise' || scope === 'recently-added') && albums.length === 0)
			return 'No albums in this library.';
		return null;
	});

	function followAddress(event: MouseEvent, open: (() => void) | undefined): void {
		if (open === undefined || !shouldHandleLibraryAnchorClick(event)) return;
		event.preventDefault();
		open();
	}
</script>

{#snippet artistRows(rows: readonly LibraryArtistEntry[])}
	<div class="alist">
		{#each rows as entry (entry.id)}
			{@const href = hrefForArtist?.(entry) ?? null}
			{@const open = onOpenLiveArtist ? () => onOpenLiveArtist(entry) : undefined}
			<svelte:element
				this={href === null ? 'button' : 'a'}
				role={href === null ? 'button' : 'link'}
				type={href === null ? 'button' : undefined}
				{href}
				class="arow"
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
	<div class="tiles">
		{#each items as tile (tile.key)}
			{@const liveEntry = tile.live}
			{@const drillable = liveEntry !== undefined && onOpenLiveAlbum !== undefined}
			{@const href = tile.source === undefined ? null : (hrefForAlbum?.(tile.source) ?? null)}
			{@const open =
				!drillable || liveEntry === undefined
					? undefined
					: () => onOpenLiveAlbum?.(liveEntry)}
			<svelte:element
				this={href === null ? 'button' : 'a'}
				role={href === null ? 'button' : 'link'}
				type={href === null ? 'button' : undefined}
				{href}
				class="tile"
				data-testid={albumTestId}
				disabled={href === null && !drillable}
				onclick={(event: MouseEvent) =>
					href === null ? open?.() : followAddress(event, open)}
			>
				<div class="art">
					{#if tile.imageKey}
						<img
							src={imageUrl(tile.imageKey, { scale: 'fit', width: 300, height: 300 })}
							alt=""
							loading="lazy"
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

<div
	class="scope-view"
	data-testid="unified-scope-view"
	data-scope={scope}
	bind:this={scroller}
>
	{#if status}
		<p class="hint" data-testid="unified-scope-status">{status}</p>
	{:else if scope === 'artists'}
		{#if artistGroups}
			{@render grouped(artistGroups as never, artistRows)}
		{:else}
			{@render artistRows(artistsSorted)}
		{/if}
	{:else if scope === 'albums'}
		{#if albumGroups}
			{@render grouped(albumGroups as never, albumTiles)}
		{:else}
			{@render albumTiles(albumsFlat)}
		{/if}
	{:else if scope === 'surprise'}
		{@render albumTiles(surpriseTiles)}
		<div class="hint">
			Random, not "unplayed" — nothing knows what you have heard. Re-select the chip to redraw.
		</div>
	{:else if scope === 'genres'}
		{#if cardGroups}
			{@render grouped(cardGroups as never, cardList)}
		{:else}
			{@render cardList(genreCards)}
		{/if}
		<div class="hint">Counts marked + are Roon's page bound, not the full genre.</div>
	{:else if scope === 'recently-played'}
		{@render albumTiles(recentTiles)}
		<div class="hint">
			Only what this controller watched play. Roon does not share its own history.
		</div>
	{:else if scope === 'recently-added'}
		<!-- A restored address outliving the feature: the honest reason, never a
		     guessed order. Roon's public browse API exposes no import date, and
		     the native layer that used to supply one is gone. -->
		<p class="hint" data-testid="unified-recently-added-gated">
			{NO_IMPORT_DATES_REASON}
		</p>
	{/if}
</div>
