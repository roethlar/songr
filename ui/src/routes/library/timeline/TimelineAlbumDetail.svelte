<script lang="ts">
	import { imageUrl } from '$lib/imageUrl';
	import type { TimelineAlbumDetailViewModel } from '$lib/timeline/detailView';

	const TRACK_PAGE_SIZE = 40;

	let {
		view,
		x,
		y,
		onOpenTrackInClassic
	}: {
		view: TimelineAlbumDetailViewModel;
		x: number;
		y: number;
		onOpenTrackInClassic?: (trackTitle: string) => void;
	} = $props();

	let page = $state(0);
	let album = $derived(view.album);
	let tracks = $derived(view.detail?.orderedTrackTitles ?? []);
	let pageCount = $derived(Math.max(1, Math.ceil(tracks.length / TRACK_PAGE_SIZE)));
	let firstTrack = $derived(page * TRACK_PAGE_SIZE);
	let visibleTracks = $derived(
		tracks.slice(firstTrack, firstTrack + TRACK_PAGE_SIZE)
	);

	$effect(() => {
		album.localId;
		page = 0;
	});
</script>

<aside
	class="album-detail-slab"
	data-world-object
	data-album-detail-id={album.localId}
	style:left={`${x}px`}
	style:top={`${y}px`}
	aria-label={`${album.exactTitle} album detail`}
>
	<span class="detail-connector" aria-hidden="true"></span>
	<header class:has-artwork={album.imageKeyHint !== undefined}>
		{#if album.imageKeyHint}
			<img
				data-timeline-detail-artwork
				src={imageUrl(album.imageKeyHint, { width: 320, height: 320 })}
				alt=""
				loading="lazy"
				draggable="false"
			/>
		{/if}
		<div>
		<span class="detail-kicker">Album detail</span>
		<strong>{album.exactTitle}</strong>
		<span>{album.exactArtist}</span>
		</div>
	</header>

	<div class="detail-evidence" aria-label="Release evidence">
		{#if album.originalReleaseYear !== undefined}
			<span>Original {album.originalReleaseYear}</span>
		{:else}
			<span>Original date unproven</span>
		{/if}
		{#if album.editionReleaseYear !== undefined}
			<span>Edition {album.editionReleaseYear}</span>
		{/if}
		{#if album.editionText}
			<span>{album.editionText}</span>
		{/if}
	</div>

	{#if view.phase === 'resolve-required'}
		<section class="detail-state" role="status">
			<strong>Resolve required</strong>
			<p>{view.message ?? 'This album could not be matched safely. Known metadata remains available.'}</p>
		</section>
	{:else if view.phase === 'loading'}
		<section class="detail-state" role="status">
			<strong>Loading album detail…</strong>
		</section>
	{:else if view.phase === 'error'}
		<section class="detail-state" role="alert">
			<strong>Album detail unavailable</strong>
			<p>{view.message ?? 'The album detail could not be loaded.'}</p>
		</section>
	{:else}
	<section aria-label="Tracks">
		<div class="track-heading">
			<strong>Tracks</strong>
			<span>{tracks.length}</span>
		</div>
		{#if visibleTracks.length > 0}
			<ol start={firstTrack + 1}>
				{#each visibleTracks as title, index (`${firstTrack + index}:${title}`)}
					<li data-detail-track>
						<span>{firstTrack + index + 1}</span>
						<strong>{title}</strong>
						{#if onOpenTrackInClassic}
							<button
								type="button"
								class="track-classic-action"
								aria-label={`Open ${title} in Classic`}
								onclick={() => onOpenTrackInClassic(title)}
							>
								Open in Classic
							</button>
						{/if}
					</li>
				{/each}
			</ol>
		{:else}
			<p>No track titles were exposed for this edition.</p>
		{/if}
	</section>

	{#if pageCount > 1}
		<nav aria-label="Track pages">
			<button type="button" disabled={page === 0} onclick={() => page -= 1}>Previous</button>
			<span>Page {page + 1} of {pageCount}</span>
			<button type="button" disabled={page + 1 >= pageCount} onclick={() => page += 1}>Next</button>
		</nav>
	{/if}
	{/if}
</aside>

<style>
	.album-detail-slab {
		position: absolute;
		z-index: 3;
		display: grid;
		width: 360px;
		max-height: 440px;
		translate: 0 -50%;
		box-sizing: border-box;
		gap: 12px;
		padding: 18px;
		border: 1px solid color-mix(in srgb, var(--accent-2) 58%, var(--border));
		border-radius: 16px;
		background: color-mix(in srgb, var(--surface) 97%, transparent);
		box-shadow: 0 18px 48px rgb(0 0 0 / 0.36);
		color: var(--text);
		contain: layout paint style;
	}

	.detail-connector {
		position: absolute;
		top: 50%;
		right: 100%;
		width: 64px;
		height: 1px;
		background: color-mix(in srgb, var(--accent-2) 58%, transparent);
	}

	header {
		display: grid;
		align-items: center;
		gap: 3px;
	}

	header.has-artwork {
		grid-template-columns: 84px minmax(0, 1fr);
	}

	header > div {
		display: grid;
		min-width: 0;
		gap: 3px;
	}

	header img {
		display: block;
		width: 76px;
		height: 76px;
		border-radius: 10px;
		object-fit: cover;
	}

	header strong {
		font-size: 20px;
		line-height: 1.15;
	}

	header div > span:last-child,
	.detail-kicker,
	.detail-evidence,
	.track-heading span,
	p,
	nav {
		color: var(--text-soft);
	}

	.detail-kicker {
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.09em;
		text-transform: uppercase;
	}

	.detail-evidence {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		font-size: 10px;
	}

	.detail-evidence span {
		padding: 4px 7px;
		border: 1px solid var(--border);
		border-radius: 999px;
		background: var(--surface-2);
	}

	section {
		display: grid;
		min-height: 0;
		gap: 7px;
	}

	.track-heading {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
	}

	ol {
		display: grid;
		max-height: 248px;
		margin: 0;
		padding: 0;
		overflow: auto;
		list-style: none;
	}

	li {
		display: grid;
		grid-template-columns: 28px minmax(0, 1fr) auto;
		align-items: center;
		gap: 8px;
		padding: 5px 0;
		border-top: 1px solid color-mix(in srgb, var(--border) 62%, transparent);
		font-size: 11px;
	}

	li > span {
		color: var(--text-soft);
		font-variant-numeric: tabular-nums;
	}

	li strong {
		overflow: hidden;
		font-weight: 560;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.track-classic-action {
		padding: 3px 6px;
		border-color: color-mix(in srgb, var(--accent-2) 45%, var(--border));
		color: var(--text-soft);
		font-size: 9px;
		white-space: nowrap;
	}

	.track-classic-action:focus-visible {
		outline: 2px solid var(--accent-2);
		outline-offset: 1px;
	}

	p {
		margin: 0;
		font-size: 11px;
	}

	.detail-state {
		padding: 10px;
		border: 1px solid var(--border);
		border-radius: 10px;
		background: var(--surface-2);
	}

	nav {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		font-size: 10px;
	}

	button {
		padding: 5px 8px;
		border: 1px solid var(--border);
		border-radius: 7px;
		background: var(--surface-2);
		color: var(--text);
		font: inherit;
		cursor: pointer;
	}

	button:disabled {
		opacity: 0.4;
		cursor: default;
	}
</style>
