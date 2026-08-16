<script lang="ts">
	import type {
		UnifiedSongActionSemantic,
		UnifiedSongAlbumRelationship,
		UnifiedSongRelationship
	} from '@shared/unifiedSearchContracts';
	import { imageUrl } from '$lib/imageUrl';
	import type { PaletteSearchRow } from '$lib/stores/unifiedPaletteSearchStore';
	import UnifiedItemPageFrame from './UnifiedItemPageFrame.svelte';

	/**
	 * The public exact-track page (rich-item plan Slice 5): the retained
	 * search result's exact context and only the actions and links its
	 * authority actually exposes. This replaces the UnifiedSongPanel
	 * terminal dialog — same behavior set (search return, independently
	 * authorized album/artist links, Favorite where supplied, playback,
	 * queue, authority retirement via a withdrawn onAction), hosted as a
	 * first-class page instead of a modal. Composer text intentionally
	 * links to composer drills only — never a composition page: the
	 * observed public track action authority supplied no such target.
	 */
	interface ZoneOption {
		readonly zoneId: string;
		readonly name: string;
	}

	interface Props {
		readonly song: PaletteSearchRow;
		readonly zones: readonly ZoneOption[];
		readonly busy?: boolean;
		readonly error?: string | null;
		readonly relationshipPhase?: 'idle' | 'loading' | 'ready' | 'unavailable';
		readonly relationship?: UnifiedSongRelationship | null;
		readonly relationshipError?: string | null;
		readonly onBack: () => void;
		readonly onClose: () => void;
		readonly onAction?: (semantic: UnifiedSongActionSemantic, zoneId: string) => void;
		readonly onFavorite?: () => void;
		readonly favoriteBusy?: boolean;
		readonly favoriteStatus?: string | null;
		readonly onOpenAlbum?: (album: UnifiedSongAlbumRelationship) => void;
		readonly onOpenArtist?: (artistLocalId: string) => void;
		readonly onOpenComposer?: (label: string) => void;
	}

	let {
		song,
		zones,
		busy = false,
		error = null,
		relationshipPhase = 'idle',
		relationship = null,
		relationshipError = null,
		onBack,
		onClose,
		onAction,
		onFavorite,
		favoriteBusy = false,
		favoriteStatus = null,
		onOpenAlbum,
		onOpenArtist,
		onOpenComposer
	}: Props = $props();

	let pendingSemantic = $state<UnifiedSongActionSemantic | null>(null);
	let albumChooserOpen = $state(false);

	const actionEnabled = $derived(Boolean(onAction) && zones.length > 0 && !busy);
	const relationshipAlbums = $derived(relationship?.albums ?? []);
	const relationshipArtists = $derived.by(() => {
		const artists = new Map<string, string>();
		for (const album of relationshipAlbums) {
			if (album.artistLocalId && !artists.has(album.artistLocalId)) {
				artists.set(album.artistLocalId, album.artist);
			}
		}
		return [...artists].map(([localId, name]) => ({ localId, name }));
	});

	$effect(() => {
		void song.resultId;
		albumChooserOpen = false;
	});

	function monogram(title: string): { style: string; letter: string } {
		const word = title.replace(/^(the |a |an )/i, '').trim() || '?';
		let hash = 0;
		for (const character of word) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
		return {
			style: `background:linear-gradient(150deg,hsl(${hash % 360},14%,20%),hsl(${(hash + 40) % 360},12%,11%))`,
			letter: (word[0] ?? '?').toUpperCase()
		};
	}

	function semanticLabel(semantic: UnifiedSongActionSemantic): string {
		if (semantic === 'play-now') return 'Play Now';
		if (semantic === 'add-next') return 'Add Next';
		return 'Queue';
	}

	function beginAction(semantic: UnifiedSongActionSemantic): void {
		if (!actionEnabled || !onAction) return;
		if (zones.length === 1) {
			onAction(semantic, zones[0].zoneId);
			pendingSemantic = null;
			return;
		}
		pendingSemantic = semantic;
	}

	function chooseZone(zoneId: string): void {
		if (!pendingSemantic || !onAction || busy) return;
		onAction(pendingSemantic, zoneId);
		pendingSemantic = null;
	}

	function beginAlbumNavigation(): void {
		if (!onOpenAlbum || relationshipAlbums.length === 0) return;
		if (relationshipAlbums.length === 1) {
			onOpenAlbum(relationshipAlbums[0]);
			return;
		}
		albumChooserOpen = true;
	}

	function openOnlyArtist(): void {
		if (!onOpenArtist || relationshipArtists.length !== 1) return;
		onOpenArtist(relationshipArtists[0].localId);
	}
</script>

<UnifiedItemPageFrame
	label="Track page"
	heading={song.title}
	headingTestId="unified-song-title"
	backLabel="Search results"
	backTestId="unified-song-back"
	{onBack}
>
	{#snippet headerExtra()}
		<button
			type="button"
			class="close-search"
			data-testid="unified-song-close"
			onclick={onClose}
		>
			Close search
		</button>
	{/snippet}
	<div class="item-page-body" data-testid="unified-track-page">
		<div class="pleft">
			<div class="art">
				{#if song.imageKey}
					<img
						src={imageUrl(song.imageKey, { scale: 'fit', width: 300, height: 300 })}
						alt=""
						loading="lazy"
					/>
				{:else}
					{@const fallback = monogram(song.title)}
					<div class="mono-tile" style={fallback.style}>{fallback.letter}</div>
				{/if}
			</div>
			<div class="pb song-actions">
				<button
					type="button"
					data-testid="unified-song-play-now"
					disabled={!actionEnabled}
					onclick={() => beginAction('play-now')}
				>
					Play Now
				</button>
				<button
					type="button"
					data-testid="unified-song-add-next"
					disabled={!actionEnabled}
					onclick={() => beginAction('add-next')}
				>
					Add Next
				</button>
				<button
					type="button"
					data-testid="unified-song-queue"
					disabled={!actionEnabled}
					onclick={() => beginAction('queue')}
				>
					Queue
				</button>
				<button
					type="button"
					data-testid="unified-song-favorite"
					disabled={!onFavorite || favoriteBusy}
					onclick={() => onFavorite?.()}
				>
					Favorite
				</button>
				<button
					type="button"
					data-testid="unified-song-album-link"
					disabled={!onOpenAlbum || relationshipAlbums.length === 0}
					onclick={beginAlbumNavigation}
				>
					Go to Album
				</button>
				<button
					type="button"
					data-testid="unified-song-artist-link"
					disabled={!onOpenArtist || relationshipArtists.length !== 1}
					onclick={openOnlyArtist}
				>
					{relationshipArtists.length > 1 ? 'Choose Artist' : 'Go to Artist'}
				</button>
			</div>
		</div>

		<div class="pright">
			<div class="pa song-subtitle" data-testid="unified-song-subtitle">{song.subtitle}</div>

			{#if pendingSemantic && zones.length > 1}
				<div class="zone-picker" data-testid="unified-song-zone-picker">
					<span class="zone-label">{semanticLabel(pendingSemantic)} on</span>
					{#each zones as zone (zone.zoneId)}
						<button type="button" onclick={() => chooseZone(zone.zoneId)}>{zone.name}</button>
					{/each}
					<button type="button" class="ghost" onclick={() => (pendingSemantic = null)}>Cancel</button>
				</div>
			{/if}

			{#if busy}
				<p class="status" data-testid="unified-song-action-busy">Working…</p>
			{:else if error}
				<p class="status error" data-testid="unified-song-action-error">{error}</p>
			{/if}
			{#if favoriteStatus}
				<p class="status" data-testid="unified-song-favorite-status">{favoriteStatus}</p>
			{/if}

			{#if albumChooserOpen && relationshipAlbums.length > 1}
				<div class="relationship-options" data-testid="unified-song-album-chooser">
					<span class="relationship-label">Choose an album edition</span>
					{#each relationshipAlbums as album (album.albumLocalId)}
						<button
							type="button"
							data-testid="unified-song-album-choice-{album.albumLocalId}"
							onclick={() => onOpenAlbum?.(album)}
						>
							<span>{album.title}</span>
							{#if album.editionText}
								<small>{album.editionText}</small>
							{/if}
							<small>{album.artist}</small>
						</button>
					{/each}
					<button type="button" class="ghost" onclick={() => (albumChooserOpen = false)}>
						Cancel
					</button>
				</div>
			{/if}

			{#if relationshipArtists.length > 1 && onOpenArtist}
				<div class="relationship-options" data-testid="unified-song-artist-links">
					<span class="relationship-label">Artists</span>
					{#each relationshipArtists as artist (artist.localId)}
						<button type="button" onclick={() => onOpenArtist?.(artist.localId)}>
							{artist.name}
						</button>
					{/each}
				</div>
			{/if}

			{#if relationship && relationship.composerLabels.length > 0 && onOpenComposer}
				<div class="relationship-options" data-testid="unified-song-composer-links">
					<span class="relationship-label">Composers</span>
					{#each relationship.composerLabels as label (label)}
						<button type="button" onclick={() => onOpenComposer?.(label)}>
							{label}
						</button>
					{/each}
				</div>
			{/if}

			<p class="song-relationship-status" data-testid="unified-song-relationship-status">
				{#if relationshipPhase === 'ready' && relationshipAlbums.length === 0}
					No matching album was found in this library.
				{:else if relationshipPhase === 'ready' && relationshipAlbums.length === 1}
					One matching album found.
				{:else if relationshipPhase === 'ready'}
					{relationshipAlbums.length} matching albums found.
				{:else if relationshipPhase === 'unavailable'}
					{relationshipError ?? 'Album, artist, and composer links are unavailable.'}
				{:else}
					Finding album, artist, and composer links…
				{/if}
			</p>
		</div>
	</div>
</UnifiedItemPageFrame>

<style>
	.item-page-body {
		display: flex;
		gap: 22px;
		min-height: 0;
		margin-top: 12px;
	}
	.item-page-body .art {
		width: 196px;
		height: 196px;
		border-radius: 4px;
		overflow: hidden;
		background: var(--songr-surface-11);
	}
	.item-page-body .art img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.item-page-body .art .mono-tile {
		display: grid;
		width: 100%;
		height: 100%;
		place-items: center;
		font-size: 48px;
		color: var(--soft);
	}
	.pright {
		min-width: 0;
		flex: 1;
	}
	.close-search {
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--soft);
		font: inherit;
		font-size: 12px;
		cursor: pointer;
	}
	.close-search:hover {
		color: var(--accent2);
	}
	.song-subtitle {
		cursor: default;
	}
	.song-actions button:disabled {
		opacity: 0.45;
	}
	.status {
		margin: 12px 0 0;
		opacity: 0.75;
		font-size: 13px;
	}
	.status.error {
		opacity: 1;
		color: var(--error, #e66);
	}
	.zone-picker {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 7px;
		margin-top: 18px;
		padding: 10px;
		border: 1px solid var(--line);
		border-radius: 7px;
		background: var(--songr-surface-11);
	}
	.relationship-options {
		display: flex;
		flex-wrap: wrap;
		align-items: stretch;
		gap: 7px;
		margin-top: 18px;
		padding: 10px;
		border: 1px solid var(--line);
		border-radius: 7px;
		background: var(--songr-surface-11);
	}
	.relationship-label {
		width: 100%;
		color: var(--soft);
		font-size: 12px;
	}
	.relationship-options button {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 7px 10px;
		border: 1px solid var(--line);
		border-radius: 6px;
		background: var(--hover-subtle);
		color: var(--songr-copy);
		font: inherit;
		font-size: 12px;
		text-align: left;
		cursor: pointer;
	}
	.relationship-options button:hover {
		border-color: var(--accent);
	}
	.relationship-options small {
		color: var(--dim);
	}
	.zone-label {
		width: 100%;
		color: var(--soft);
		font-size: 12px;
	}
	.zone-picker button {
		padding: 7px 10px;
		border: 1px solid var(--line);
		border-radius: 6px;
		background: var(--hover-subtle);
		color: var(--songr-copy);
		font: inherit;
		font-size: 12px;
		cursor: pointer;
	}
	.zone-picker button:hover {
		border-color: var(--accent);
	}
	.zone-picker .ghost {
		color: var(--dim);
	}
	.song-relationship-status {
		margin-top: 18px;
		color: var(--dim);
		font-size: 12px;
		line-height: 1.5;
	}
</style>
