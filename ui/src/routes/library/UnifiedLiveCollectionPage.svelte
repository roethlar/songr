<script lang="ts">
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

	interface Props {
		page: LiveLibraryPageState;
		levelKind: LibraryNodeKind;
		backLabel: string;
		onBack: () => void;
		onRetry: () => void;
		onOpenRow: (row: LibraryLevelRow) => void;
		hrefForRow: (row: LibraryLevelRow) => string | null;
		onOpenAlbum: (entry: LibraryAlbumEntry) => void;
		hrefForAlbum: (entry: LibraryAlbumEntry) => string | null;
		actionController: AlbumActionController;
		actionsEnabled: boolean;
		onBeginActions: () => void;
		sorts: {
			readonly artists: UnifiedArtistsSort;
			readonly albums: UnifiedAlbumsSort;
			readonly genres: UnifiedGenresSort;
		};
		randomSeed: number;
		onSetAlbumSort: (value: string) => void;
	}

	let {
		page,
		levelKind,
		backLabel,
		onBack,
		onRetry,
		onOpenRow,
		hrefForRow,
		onOpenAlbum,
		hrefForAlbum,
		actionController,
		actionsEnabled,
		onBeginActions,
		sorts,
		randomSeed,
		onSetAlbumSort
	}: Props = $props();

	let sortOpen = $state(false);
	let railTarget = $state<LetterBucket | null>(null);
	const action = $derived($actionController);
	const rows = $derived(page.level?.rows ?? []);
	const albumRows = $derived(rows.filter((row) => row.kind === 'album'));
	const albums = $derived(albumRows.map(albumEntry));
	const ordinaryRows = $derived(
		rows.filter((row) => row.kind !== 'album' && row.kind !== 'action')
	);
	const hasActions = $derived(rows.some((row) => row.kind === 'action'));
	const actionBusy = $derived(
		action.phase === 'resolving' ||
			action.phase === 'choosing' ||
			action.phase === 'executing'
	);
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

	function setAlbumSort(value: string): void {
		railTarget = null;
		onSetAlbumSort(value);
	}
</script>

<section
	class="item-page"
	data-testid="unified-live-collection-page"
	data-level-kind={levelKind}
>
	<div class="ctx">
		<button type="button" class="back" onclick={onBack}>← {backLabel}</button>
		<h2 tabindex="-1" data-testid="unified-live-collection-title">
			{page.target?.title ?? page.path?.steps.at(-1)?.title ?? 'Library'}
		</h2>
		{#if page.phase === 'ready' && albumRows.length > 0}
			<span class="n mono" data-testid="unified-live-collection-summary">
				{(page.level?.count ?? albumRows.length).toLocaleString()} ALBUMS
			</span>
		{/if}
		{#if page.phase === 'ready' && albumRows.length > 0}
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
				</div>
			</div>
		{/if}
		{#if page.phase === 'ready' && hasActions}
			<button
				type="button"
				class="ctab"
				data-testid="unified-live-actions"
				disabled={!actionsEnabled || actionBusy}
				onclick={onBeginActions}
			>
				Actions
			</button>
		{/if}
	</div>

	{#if action.phase === 'choosing'}
		<div class="action-choices" data-testid="unified-live-action-choices">
			{#each action.actions as choice (choice.actionId)}
				<button type="button" onclick={() => actionController.execute(choice.actionId)}>
					{choice.label}
				</button>
			{/each}
			<button type="button" class="ghost" onclick={() => actionController.cancel()}>Cancel</button>
		</div>
	{:else if action.phase === 'resolving' || action.phase === 'executing'}
		<p class="status" data-testid="unified-live-action-busy">Working…</p>
	{:else if action.phase === 'failed' || action.phase === 'outcome-unknown'}
		<p class="status error" data-testid="unified-live-action-error">
			{action.error ?? 'The action failed.'}
		</p>
	{/if}

	{#if page.phase === 'opening'}
		<p class="status">Loading…</p>
	{:else if page.phase === 'failed'}
		<p class="status error">{page.message}</p>
		<button type="button" onclick={onRetry}>Retry</button>
	{:else if page.phase === 'ready'}
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
					groupAlbums={true}
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
			<div class="alist" data-testid="unified-live-collection-rows">
				{#each ordinaryRows as row, index (`${row.ref.generation}:${row.ref.token}`)}
					{@const href = hrefForRow(row)}
					{#if href === null}
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
</section>

<style>
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
</style>
