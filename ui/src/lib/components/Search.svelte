<script lang="ts">
	import { onDestroy } from 'svelte';
	import {
		browseStore,
		setSearchError,
		setSearchLoading,
		setSearchResults
	} from '$lib/stores/browseStore';
	import { selectedZoneStore } from '$lib/stores/selectedZoneStore';
	import { browseSearch as apiBrowseSearch } from '$lib/api/client';
	import ItemGrid from './ItemGrid.svelte';
	import { imageUrl } from '$lib/imageUrl';
	import { hideOnError } from '$lib/actions/imageFallback';
	import type { BrowseItem, SearchResult } from '@shared/types';
	import {
		ClassicBrowseSupersededError,
		type ClassicBrowseSessionClaim
	} from '$lib/stores/classicBrowseSessionStore';

	type SearchMode = 'full' | 'input' | 'results';
	let {
		onResultClick,
		onSubmit,
		onSeeAllCategory,
		onTrackMore,
		sessionClaim,
		mode = 'full',
		focusInput = false
	}: {
		onResultClick?: (result: SearchResult) => void;
		/**
		 * Navigate the browse pane into a truncated search category
		 * ("See all N" on a group whose server expansion loaded only
		 * the first page). Receives the category row title, e.g.
		 * "Tracks".
		 */
		onSeeAllCategory?: (categoryTitle: string) => void;
		/**
		 * When provided, track rows render a ⋮ button that calls this
		 * with the row — the page opens the track actions menu (Play
		 * Next / Queue / favorites) without quick-playing.
		 */
		onTrackMore?: (result: SearchResult) => void;
		sessionClaim?: ClassicBrowseSessionClaim | null;
		/**
		 * Optional submit interceptor. When provided, the component calls
		 * this with the query string and skips its own socket emission.
		 * Lets the layout-level `<Search mode="input" />` redirect cross-route
		 * submissions through the typed LibraryIntent boundary + `/library`
		 * navigation so the selected Library mode owns resolution.
		 */
		onSubmit?: (query: string) => void;
		mode?: SearchMode;
		/**
		 * Focus the query input when it appears. Used when the panel is
		 * opened from an explicit "Search" click so the user can type
		 * immediately.
		 */
		focusInput?: boolean;
	} = $props();

	let searchQuery = $state('');
	let searchGeneration = 0;
	onDestroy(() => {
		searchGeneration += 1;
	});
	let inputEl = $state<HTMLInputElement | null>(null);

	// Unique per instance — the header (mode 'input') and the library
	// panel (mode 'full') can both render an input at the same time,
	// and duplicate ids would break the label association.
	const inputId = $derived(`library-search-${mode}`);

	$effect(() => {
		if (focusInput && inputEl) {
			inputEl.focus();
		}
	});

	/**
	 * Per-group pagination state. Tracks how many items of each result type
	 * are currently revealed; "Show more" bumps the count by PAGE_SIZE.
	 */
	const PAGE_SIZE = 12;
	let pageSize: Record<string, number> = $state({});
	let lastQueryDisplayed = $state<string | null>(null);

	async function search() {
		const query = searchQuery.trim();
		if (!query) {
			return;
		}

		// Layout-level submit interceptor (header input). The layout publishes
		// a typed, keyless Library intent before routing, so a search from
		// /queue lands in the selected mode without transferring live keys.
		if (onSubmit) {
			onSubmit(query);
			return;
		}

		const generation = ++searchGeneration;
		setSearchLoading(query);
		try {
			if (!sessionClaim) throw new ClassicBrowseSupersededError();
			const results = await apiBrowseSearch(fetch, {
				input: query,
				zoneId: $selectedZoneStore || undefined,
				popAll: true
			}, sessionClaim, 'classic-search');
			if (generation === searchGeneration) setSearchResults(results);
		} catch (error) {
			if (generation === searchGeneration) setSearchError((error as Error).message);
		}
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			event.preventDefault();
			search();
		}
	}

	// Reset per-group pagination and the "not in your library" reveals
	// whenever a new query lands.
	$effect(() => {
		const q = $browseStore.lastSearchQuery;
		if (q !== lastQueryDisplayed) {
			pageSize = {};
			revealedEmpty = {};
			lastQueryDisplayed = q;
		}
	});

	// Display order for resultType groups. 'unknown' holds Roon's
	// untyped direct hits (its "Top Result" rows) — lead with them,
	// the way native Roon does.
	const TYPE_ORDER: ReadonlyArray<SearchResult['resultType']> = [
		'unknown',
		'artist',
		'album',
		'track',
		'playlist',
		'composer',
		'genre',
		'label',
		'radio'
	];

	const TYPE_LABELS: Record<SearchResult['resultType'], string> = {
		artist: 'Artists',
		album: 'Albums',
		track: 'Tracks',
		playlist: 'Playlists',
		composer: 'Composers',
		genre: 'Genres',
		label: 'Labels',
		radio: 'Radio',
		unknown: 'Top results'
	};

	/**
	 * Two deliberate presentation modes keep the panel coherent
	 * (2026-07-10 owner feedback: "I hate the mix of cards and lists"):
	 * artwork CARD GRIDS only where artwork is the point (albums,
	 * playlists, genres, radio); uniform compact ROWS for everything
	 * people-shaped (top results, artists, composers, labels) and for
	 * tracks. Rows share one visual system: thumb, title/subtitle,
	 * trailing affordance.
	 */
	const ROW_TYPES: ReadonlySet<SearchResult['resultType']> = new Set([
		'unknown',
		'artist',
		'composer',
		'label'
	]);

	/**
	 * Roon's search pads people groups with collaboration entries whose
	 * subtitle is "0 Albums" — nothing of theirs is in the library, and
	 * a wall of them buried the real matches (owner screenshot,
	 * 2026-07-10). They stay reachable behind a per-group toggle.
	 */
	function hasLibraryContent(item: SearchResult): boolean {
		return !/^0\s/.test((item.subtitle ?? '').trim());
	}

	function splitByLibraryContent(items: SearchResult[]): {
		content: SearchResult[];
		empty: SearchResult[];
	} {
		const content: SearchResult[] = [];
		const empty: SearchResult[] = [];
		for (const item of items) {
			(hasLibraryContent(item) ? content : empty).push(item);
		}
		return { content, empty };
	}

	let revealedEmpty: Record<string, boolean> = $state({});

	const grouped = $derived.by(() => {
		const buckets = new Map<SearchResult['resultType'], SearchResult[]>();
		for (const r of $browseStore.lastSearch ?? []) {
			const list = buckets.get(r.resultType) ?? [];
			list.push(r);
			buckets.set(r.resultType, list);
		}
		return TYPE_ORDER.filter((t) => buckets.has(t)).map((t) => ({
			type: t,
			label: TYPE_LABELS[t],
			items: buckets.get(t) ?? []
		}));
	});

	function shownCount(type: string, total: number): number {
		const current = pageSize[type] ?? PAGE_SIZE;
		return Math.min(current, total);
	}

	function showMore(type: string) {
		const current = pageSize[type] ?? PAGE_SIZE;
		pageSize = { ...pageSize, [type]: current + PAGE_SIZE };
	}

	// ItemGrid types its callback as BrowseItem (the broader type).
	// Items are SearchResult[] here, so the cast back is safe.
	//
	// Tracks render as compact rows (a track has no meaningful square
	// card — it drew a letter placeholder); everything else stays an
	// artwork card grid. Rows and cards go through the same
	// onResultClick, so the caller still decides playable vs navigable.
	function handleClick(item: BrowseItem) {
		onResultClick?.(item as SearchResult);
	}
</script>

<div class="search-shell" class:input-only={mode === 'input'}>
	{#if mode !== 'results'}
		<div class="search-row">
			<label class="visually-hidden" for={inputId}>Search library</label>
			<input
				id={inputId}
				type="text"
				bind:this={inputEl}
				bind:value={searchQuery}
				onkeydown={handleKeydown}
				placeholder="Search artists, albums, tracks"
				spellcheck="false"
			/>
			<button type="button" onclick={search} disabled={!searchQuery.trim()}>Search</button>
		</div>
	{/if}

	{#if mode !== 'input'}
	{#if $browseStore.searchLoading}
		<p class="loading">Searching...</p>
	{:else if $browseStore.searchError}
		<div class="error">
			<p>{$browseStore.searchError}</p>
		</div>
	{:else if $browseStore.lastSearch}
		<div class="results">
			{#if $browseStore.lastSearch.length === 0}
				<div class="no-results">
					<p class="no-results-title">
						No results{#if $browseStore.lastSearchQuery}
							for <strong>"{$browseStore.lastSearchQuery}"</strong>{/if}
					</p>
					<p class="no-results-hint">
						Check the spelling, try fewer words, or search for the artist or album instead.
					</p>
				</div>
			{:else}
			<p class="result-count">
				{$browseStore.lastSearch.length} results
				{#if $browseStore.lastSearchQuery}
					for <strong>"{$browseStore.lastSearchQuery}"</strong>
				{/if}
			</p>
			{/if}
			{#each grouped as group}
				{@const rowMode = ROW_TYPES.has(group.type)}
				{@const parts = rowMode
					? splitByLibraryContent(group.items)
					: { content: group.items, empty: [] }}
				{@const visible = parts.content.slice(0, shownCount(group.type, parts.content.length))}
				<!-- Direct hits are typed too and carry no category stamp, so
				     the metadata must come from ANY stamped item, and the
				     truncation compare uses only the expanded rows (rev-4
				     reopen: a direct hit at items[0] hid "See all"). -->
				{@const catSource = group.items.find((i) => i.categoryTitle)}
				{@const categoryTitle = catSource?.categoryTitle}
				{@const categoryTotal = catSource?.categoryTotal ?? 0}
				{@const expandedCount = group.items.filter((i) => i.categoryTitle).length}
				{@const truncated = !!categoryTitle && categoryTotal > expandedCount}
				<section class="group">
					<header class="group-header">
						<h3>{group.label}</h3>
						<span class="group-count">
							{shownCount(group.type, parts.content.length)} of {truncated
								? categoryTotal
								: parts.content.length}
						</span>
					</header>
					{#if group.type === 'track'}
						<ul class="track-rows">
							{#each visible as item, i (`${item.resultType}:${item.title}:${item.subtitle ?? ''}:${i}`)}
								<li class="track-row-wrap">
									<button
										type="button"
										class="track-row"
									onclick={() => handleClick(item)}
									disabled={!onResultClick}
									>
										<span class="tr-main">
											<span class="tr-title">{item.title}</span>
											{#if item.subtitle}
												<span class="tr-sub">{item.subtitle}</span>
											{/if}
										</span>
										<span class="tr-play" aria-hidden="true">▶</span>
									</button>
								{#if onTrackMore}
										<button
											type="button"
											class="tr-more"
											title="More options"
											aria-label="More options for {item.title}"
											onclick={() => onTrackMore(item as SearchResult)}
										>⋮</button>
									{/if}
								</li>
							{/each}
						</ul>
					{:else if rowMode}
						{@const rowsToShow = revealedEmpty[group.type]
							? [...visible, ...parts.empty]
							: visible}
						<ul class="result-rows">
							{#each rowsToShow as item, i (`${item.resultType}:${item.title}:${item.subtitle ?? ''}:${i}`)}
								<li>
									<button
										type="button"
										class="result-row"
										class:empty-entry={!hasLibraryContent(item)}
									onclick={() => handleClick(item)}
									disabled={!onResultClick}
									>
										<span class="rr-art">
											<span class="rr-initial">{item.title.charAt(0)}</span>
											{#if item.imageKey}
												<img
													src={imageUrl(item.imageKey, { width: 96, height: 96 })}
													alt=""
													loading="lazy"
													decoding="async"
													use:hideOnError
												/>
											{/if}
										</span>
										<span class="rr-main">
											<span class="rr-title">{item.title}</span>
											{#if item.subtitle}
												<span class="rr-sub">{item.subtitle}</span>
											{/if}
										</span>
										<span class="rr-go" aria-hidden="true">›</span>
									</button>
								</li>
							{/each}
						</ul>
						{#if parts.empty.length > 0 && !revealedEmpty[group.type]}
							<button
								type="button"
								class="show-more subtle"
								onclick={() => (revealedEmpty = { ...revealedEmpty, [group.type]: true })}
							>
								Show {parts.empty.length} more not in your library
							</button>
						{/if}
					{:else}
					<ItemGrid
						items={visible}
						onItemClick={handleClick}
						allowKeyless={!!onResultClick}
						interactive={!!onResultClick}
					/>
					{/if}
					{#if parts.content.length > shownCount(group.type, parts.content.length)}
						<button type="button" class="show-more" onclick={() => showMore(group.type)}>
							Show more {group.label.toLowerCase()}
						</button>
					{:else if truncated && onSeeAllCategory}
						<!-- Expansion loaded only the first page of this category
						     (rev-4) — hand off to the browse pane, which paginates
						     the full list. -->
						<button
							type="button"
							class="show-more"
							onclick={() => onSeeAllCategory(categoryTitle ?? '')}
						>
							See all {categoryTotal} {group.label.toLowerCase()}
						</button>
					{/if}
				</section>
			{/each}
		</div>
	{/if}
	{/if}
</div>

<style>
	.search-shell {
		display: flex;
		flex-direction: column;
		gap: 0.8rem;
	}

	.search-shell.input-only {
		gap: 0;
	}

	.search-row {
		display: flex;
		gap: 0.45rem;
	}

	.search-shell.input-only .search-row input {
		padding: 0.4rem 0.6rem;
		font-size: 0.9rem;
	}

	.search-shell.input-only .search-row button {
		padding: 0.4rem 0.85rem;
		font-size: 0.85rem;
	}

	.no-results {
		padding: 1.4rem 1rem;
		border: 1px dashed var(--border);
		border-radius: 10px;
		text-align: center;
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}

	.no-results-title {
		font-weight: 600;
	}

	.no-results-hint {
		font-size: 0.85rem;
		color: var(--text-soft);
	}

	.track-rows {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}

	.track-row-wrap {
		display: flex;
		align-items: stretch;
		gap: 0.15rem;
	}

	.track-row-wrap .track-row {
		flex: 1;
		min-width: 0;
	}

	.tr-more {
		flex-shrink: 0;
		align-self: center;
		padding: 0.3rem 0.5rem;
		border: none;
		border-radius: 8px;
		background: none;
		color: var(--text-soft);
		font-size: 1rem;
		cursor: pointer;
	}

	.tr-more:hover {
		background: var(--surface-2);
		color: var(--text);
	}

	/* ── Uniform result rows (top results / artists / composers / labels) ── */
	.result-rows {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}

	.result-row {
		width: 100%;
		display: flex;
		align-items: center;
		gap: 0.65rem;
		padding: 0.45rem 0.55rem;
		border: none;
		border-bottom: 1px solid var(--border);
		border-radius: 0;
		background: none;
		color: var(--text);
		text-align: left;
		cursor: pointer;
	}

	.result-rows li:last-child .result-row {
		border-bottom: none;
	}

	.result-row:hover:not(:disabled) {
		background: var(--surface-2);
		border-radius: 8px;
	}

	.result-row:disabled {
		opacity: 0.6;
		cursor: default;
	}

	.result-row.empty-entry {
		opacity: 0.75;
	}

	.rr-art {
		position: relative;
		flex-shrink: 0;
		width: 44px;
		height: 44px;
		border-radius: 50%;
		overflow: hidden;
		background: var(--surface-3);
		display: grid;
		place-items: center;
	}

	.rr-initial {
		font-size: 1.05rem;
		font-weight: 700;
		font-family: var(--font-display);
		color: var(--text-soft);
		opacity: 0.6;
		text-transform: uppercase;
		user-select: none;
	}

	.rr-art img {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.rr-main {
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.08rem;
	}

	.rr-title {
		font-weight: 600;
		line-height: 1.3;
		overflow: hidden;
		text-overflow: ellipsis;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
	}

	.rr-sub {
		font-size: 0.8rem;
		line-height: 1.3;
		color: var(--text-soft);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.rr-go {
		margin-left: auto;
		flex-shrink: 0;
		font-size: 1rem;
		color: var(--text-soft);
		opacity: 0;
		transition: opacity 120ms ease;
	}

	.result-row:hover .rr-go,
	.result-row:focus-visible .rr-go {
		opacity: 1;
		color: var(--accent-2);
	}

	@media (pointer: coarse) {
		.rr-go {
			opacity: 1;
		}
	}

	.show-more.subtle {
		color: var(--text-soft);
		font-size: 0.8rem;
	}

	.track-row {
		width: 100%;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.6rem;
		padding: 0.5rem 0.55rem;
		border: none;
		border-bottom: 1px solid var(--border);
		border-radius: 0;
		background: none;
		color: var(--text);
		text-align: left;
		cursor: pointer;
	}

	.track-rows li:last-child .track-row {
		border-bottom: none;
	}

	.track-row:hover:not(:disabled) {
		background: var(--surface-2);
		border-radius: 8px;
	}

	.track-row:disabled {
		opacity: 0.6;
		cursor: default;
	}

	.tr-main {
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.08rem;
	}

	.tr-title {
		font-weight: 600;
		line-height: 1.3;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.tr-sub {
		font-size: 0.8rem;
		line-height: 1.3;
		color: var(--text-soft);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.tr-play {
		flex-shrink: 0;
		font-size: 0.8rem;
		color: var(--text-soft);
		opacity: 0;
		transition: opacity 120ms ease;
	}

	.track-row:hover .tr-play,
	.track-row:focus-visible .tr-play {
		opacity: 1;
		color: var(--accent-2);
	}

	/* Touch devices have no hover — keep the play affordance visible. */
	@media (pointer: coarse) {
		.tr-play {
			opacity: 1;
		}
	}

	.search-row input {
		flex: 1;
		padding: 0.62rem 0.72rem;
		border: 1px solid var(--border);
		border-radius: 10px;
		background: var(--surface-2);
	}

	.search-row button {
		padding: 0.6rem 1rem;
		border: 1px solid var(--accent);
		border-radius: 10px;
		background: linear-gradient(100deg, var(--accent), var(--accent-2));
		color: #fff;
		font-weight: 600;
	}

	.search-row button:disabled {
		opacity: 0.48;
		cursor: not-allowed;
	}

	.loading {
		font-size: 0.88rem;
		color: var(--text-soft);
	}

	.error {
		padding: 0.65rem;
		border-radius: 10px;
		background: rgba(255, 124, 124, 0.1);
		border: 1px solid rgba(255, 124, 124, 0.45);
		color: #ffb3b3;
	}

	.results {
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
	}

	.result-count {
		font-size: 0.8rem;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-soft);
	}

	.result-count strong {
		color: var(--text);
		text-transform: none;
		letter-spacing: 0;
	}

	.group {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
	}

	.group-header {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.6rem;
	}

	.group-header h3 {
		font-family: var(--font-display);
		font-size: 0.92rem;
		margin: 0;
	}

	.group-count {
		font-size: 0.72rem;
		font-family: var(--font-mono);
		color: var(--text-soft);
	}

	.show-more {
		align-self: flex-start;
		padding: 0.36rem 0.7rem;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--surface-2);
		color: var(--text);
		font-size: 0.78rem;
		cursor: pointer;
	}

	.show-more:hover {
		background: var(--surface-3);
		border-color: var(--accent-2);
	}
</style>
