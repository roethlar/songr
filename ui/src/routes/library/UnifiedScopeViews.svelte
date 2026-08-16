<script lang="ts">
	import type { UnifiedLibraryDrillTarget, UnifiedLibraryScope } from '$lib/libraryPageState';
	import { imageUrl } from '$lib/imageUrl';
	import type { UnifiedSongActionSemantic } from '@shared/unifiedSearchContracts';
	import type {
		LetterBucket,
		LibraryAlbumEntry,
		LibraryArtistEntry
	} from '$lib/stores/libraryIndexStore';
	import type { PublicSongActionController } from '$lib/library/PublicSongActionController';
	import type { Readable } from 'svelte/store';
	import {
		libraryScopeSlots,
		type MostPlayedState,
		type PlaylistsState,
		type ResolvedLibraryScopeSlots
	} from '@libraryFeatures';
	import type { ScopeActionTarget } from '$lib/libraryFeatures/scopeSlotContract';
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
		sortNamedCounts,
		type DateFeatureGate
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
		/**
		 * Native date-feature gate (Slice 5): a restored Recently added page
		 * whose gate has since dropped degrades to the honest reason instead
		 * of an ordering the data cannot back.
		 */
		dateFeatureGate: DateFeatureGate;
		/** All-time native metrics, drills, and shared song action wiring. */
		mostPlayed?: UnifiedMostPlayedViewProps;
		/**
		 * Playlists scope (Slice 7): the playlist-feature gate (base native
		 * capability, no date/play gate), the scope store, and the action
		 * wiring for resolved tracks. A restored Playlists page whose gate
		 * dropped renders the carried reason.
		 */
		playlists?: UnifiedPlaylistsViewProps;
		/**
		 * The extended scope views this build carries, resolved through the
		 * `@libraryFeatures` alias. A `null` slot means the build has no such
		 * view, and the scope renders its hint instead — absent, never disabled.
		 */
		scopeSlots?: Pick<ResolvedLibraryScopeSlots, 'mostPlayedView' | 'playlistsView'>;
		genres: NamedCountsState;
		recent: RecentlyPlayedState;
		onDrill?: (target: UnifiedLibraryDrillTarget) => void;
	}

	interface UnifiedPlaylistsViewProps {
		readonly gate: DateFeatureGate;
		readonly store: Readable<PlaylistsState>;
		readonly open: (fetchFn: typeof fetch, playlistId: string) => Promise<void>;
		readonly close: () => void;
		readonly actionController: PublicSongActionController;
		readonly zones: readonly { readonly zoneId: string; readonly name: string }[];
		readonly onBeginAction: (
			target: ScopeActionTarget,
			zoneId: string,
			desiredSemantic: UnifiedSongActionSemantic
		) => void;
		readonly albums: readonly LibraryAlbumEntry[];
		readonly fetchFn: typeof fetch;
	}

	interface UnifiedMostPlayedViewProps {
		readonly gate: DateFeatureGate;
		readonly state: MostPlayedState;
		readonly actionController: PublicSongActionController;
		readonly zones: readonly { readonly zoneId: string; readonly name: string }[];
		readonly onBeginAction: (
			target: ScopeActionTarget,
			zoneId: string,
			desiredSemantic: UnifiedSongActionSemantic
		) => void;
		readonly onClearAction: () => void;
		readonly onOpenAlbum: (albumLocalId: string) => void;
		readonly fetchFn: typeof fetch;
	}

	const {
		scope,
		artists,
		albums,
		sorts,
		randomSeed = 1,
		groupAlbums = true,
		railTarget,
		dateFeatureGate,
		mostPlayed = undefined,
		playlists = undefined,
		scopeSlots = libraryScopeSlots,
		genres,
		recent,
		onDrill
	}: Props = $props();

	/**
	 * Bound as locals so the markup renders a slot component. Capitalised
	 * because that is how Svelte tells a component expression from an element.
	 */
	const MostPlayedView = $derived(scopeSlots.mostPlayedView);
	const PlaylistsView = $derived(scopeSlots.playlistsView);

	interface TileItem {
		readonly key: string;
		readonly title: string;
		readonly artist: string;
		readonly imageKey: string | null;
		readonly versionCount: number;
		readonly drill?: UnifiedLibraryDrillTarget;
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
		key: entry.id,
		title: entry.title,
		artist: entry.artist,
		imageKey: entry.imageKey ?? null,
		versionCount: entry.versionCount ?? 1,
		// Albums without a catalog identity stay inert (browse fallback
		// rows); the sheet needs a stable localId.
		...(entry.catalogLocalId
			? { drill: { kind: 'album', localId: entry.catalogLocalId } as const }
			: {})
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

</script>

{#snippet artistRows(rows: readonly LibraryArtistEntry[])}
	<div class="alist">
		{#each rows as entry (entry.id)}
			<button
				type="button"
				class="arow"
				data-testid="unified-row"
				onclick={onDrill ? () => onDrill({ kind: 'artist', localId: entry.id }) : undefined}
			>
				<span class="an">{entry.name}</span><span class="ad"></span><span class="ac mono"
					><!-- Build-v5 renders the count Roon supplies on every Artists row. -->{entry.albumCount ===
					undefined
						? ''
						: entry.albumCount}</span
				>
			</button>
		{/each}
	</div>
{/snippet}

{#snippet albumTiles(items: readonly TileItem[])}
	<div class="tiles">
		{#each items as tile (tile.key)}
			{@const drillable = tile.drill !== undefined && onDrill !== undefined}
			<button
				type="button"
				class="tile"
				data-testid="unified-tile"
				disabled={!drillable}
				onclick={drillable ? () => onDrill?.(tile.drill!) : undefined}
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
			</button>
		{/each}
	</div>
{/snippet}

{#snippet cardList(cards: readonly CardItem[])}
	<div class="glist">
		{#each cards as card (card.key)}
			<button
				type="button"
				class="gcard"
				data-testid="unified-card"
				onclick={onDrill ? () => onDrill(card.drill) : undefined}
			>
				<div class="gn">{card.label}</div>
				<div class="gc mono">{formatGenreAlbumCount(card.count)}</div>
			</button>
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
		{#if !dateFeatureGate.available}
			<!-- Restored page outliving the feature: honest reason, no guessed order. -->
			<p class="hint" data-testid="unified-recently-added-gated">
				{dateFeatureGate.reason ?? NO_IMPORT_DATES_REASON}
			</p>
		{:else}
			{@render albumTiles(recentlyAddedTiles)}
		{/if}
	{:else if scope === 'most-played'}
		{#if mostPlayed && MostPlayedView}
			<MostPlayedView
				gate={mostPlayed.gate}
				state={mostPlayed.state}
				actionController={mostPlayed.actionController}
				zones={mostPlayed.zones}
				onBeginAction={mostPlayed.onBeginAction}
				onClearAction={mostPlayed.onClearAction}
				onOpenAlbum={mostPlayed.onOpenAlbum}
				fetchFn={mostPlayed.fetchFn}
			/>
		{:else}
			<!-- No view in this build: honest hint, never a disabled surface. -->
			<p class="hint" data-testid="unified-most-played-gated">Most played is unavailable.</p>
		{/if}
	{:else if scope === 'playlists'}
		{#if playlists && playlists.gate.available && PlaylistsView}
			<PlaylistsView
				gate={playlists.gate}
				playlistsStore={playlists.store}
				openPlaylistData={playlists.open}
				closePlaylistView={playlists.close}
				actionController={playlists.actionController}
				zones={playlists.zones}
				onBeginAction={playlists.onBeginAction}
				albums={playlists.albums}
				fetchFn={playlists.fetchFn}
			/>
		{:else}
			<!--
				Restored page outliving the feature, or a build without the view:
				the carried reason either way, and no guessed data. The gate is
				checked here rather than only inside the view so the answer
				survives the view being absent from the build.
			-->
			<p class="hint" data-testid="unified-playlists-gated">
				{playlists?.gate.reason ?? 'Playlists are unavailable.'}
			</p>
		{/if}
	{/if}
</div>
