<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { AddFavoriteRequest } from '@shared/types';
	import { bookmarkPayload } from '$lib/bookmarks';
	import BookmarkButton from '$lib/components/BookmarkButton.svelte';
	import EntityFeedback from '$lib/components/EntityFeedback.svelte';
	import type { LibraryAlbumEntry, LibraryArtistEntry } from '$lib/libraryEntries';
	import { imageUrl } from '$lib/imageUrl';
	import { monogram } from '$lib/monogram';
	import { hideOnError } from '$lib/actions/imageFallback';
	import UnifiedItemPageFrame from './UnifiedItemPageFrame.svelte';

	/**
	 * First-class artist page (rich-item plan §4.1): identity heading plus
	 * the Roon-authoritative discography. The discography grid itself is
	 * rendered by the host through the `discography` snippet so the page
	 * does not re-own the scope-view wiring; this page owns the identity,
	 * honest loading/empty states, and the discography summary.
	 */
	interface Props {
		artist: LibraryArtistEntry | null;
		albums: readonly LibraryAlbumEntry[];
		overlayPhase: 'idle' | 'loading' | 'failed';
		/**
		 * True when `albums` is an answer about THIS artist — the live
		 * discography, or the list the walk stored for this artist. False when
		 * it is only whatever the catalog happens to link here, which is a
		 * different and much weaker claim.
		 *
		 * The difference matters most when the page is empty. A known empty
		 * discography is "no albums", plainly. An unknown one is not a count at
		 * all, and the page says nothing rather than a confident zero.
		 */
		discographyKnown: boolean;
		truncated: boolean;
		/**
		 * Why there is no artist here, in the caller's own words.
		 *
		 * A page with no artist is not always the same fact. The catalog page
		 * means "no such record"; the live page (Slice 2) means whichever of
		 * "Roon no longer lists this", "Roon lists it twice — merge them in
		 * Roon", "the library has been re-read", or "the Core could not be read"
		 * actually happened. The reader is owed the one that did, so the caller
		 * that knows says it. Absent, this page says the catalog's sentence.
		 */
		missingMessage?: string | null;
		backLabel: string;
		onBack: () => void;
		onBookmark?: (items: readonly AddFavoriteRequest[]) => void;
		bookmarkBusy?: boolean;
		bookmarkStatus?: string | null;
		/** Sort control, rendered inside the page header. */
		headerExtra?: Snippet;
		entityActions?: Snippet;
		discography: Snippet;
	}

	const {
		artist,
		albums,
		overlayPhase,
		discographyKnown,
		truncated,
		missingMessage = null,
		backLabel,
		onBack,
		onBookmark,
		bookmarkBusy = false,
		bookmarkStatus = null,
		headerExtra,
		entityActions,
		discography
	}: Props = $props();

	function bookmarkArtist(): void {
		if (!onBookmark || bookmarkBusy || overlayPhase !== 'idle' || !artist?.name.trim()) return;
		onBookmark([bookmarkPayload('artist', { title: artist.name, imageKey: artist.imageKey })]);
	}

	const summary = $derived.by(() => {
		if (!artist) return null;
		// An empty page only gets to say "0 ALBUMS" when zero is an answer
		// somebody gave about this artist — the live discography, or the list
		// the walk stored. While that is still loading, or when it never
		// arrived, the page claims nothing rather than a confident "0". A
		// truncated list says "N+" rather than asserting a complete total.
		if (!discographyKnown && albums.length === 0) return null;
		return `${albums.length.toLocaleString()}${truncated ? '+' : ''} ALBUMS`;
	});
	/**
	 * The wide photograph, when the library holds one for THIS artist.
	 *
	 * While a related artist is being followed the live view belongs to the
	 * child, so its picture is not this page's hero — the page still names
	 * and counts the artist it opened on.
	 *
	 * Absence is an ordinary answer, never a failure: most of the artists
	 * without one are unidentified credit strings rather than people, and
	 * a build without the extended library features never carries the field
	 * at all. Either way the page keeps the header it already had.
	 *
	 * A view read for one artist must never dress another artist's page, so
	 * everything below is scoped to `artist.id` rather than trusting the
	 * live view to have caught up with the page.
	 */
	// Aspect-adaptive header. Its premise holds for the artwork
	// key it reads: that key names ONE image per artist, usually square-ish,
	// with no wide variant behind it. What is no longer true is that this is
	// the only picture there is — the branch above renders the real wide
	// master when there is one. Where there is not, the layout still adapts
	// to the photo rather than forcing a shape on it: wide shots get the
	// banner, anything else a compact header with the image at natural size
	// beside the name — no crop, no blur filler, no fake band.
	let imgAspect = $state<number | null>(null);
	function noteAspect(event: Event): void {
		const img = event.currentTarget as HTMLImageElement;
		if (img.naturalWidth > 0 && img.naturalHeight > 0) {
			imgAspect = img.naturalWidth / img.naturalHeight;
		}
	}
	const wideImage = $derived(imgAspect !== null && imgAspect >= 1.6);
</script>

{#snippet artistHeadingActions()}
	{#if onBookmark && artist}<BookmarkButton title="Bookmark artist" onclick={bookmarkArtist} disabled={bookmarkBusy || overlayPhase !== 'idle' || !artist.name.trim()} />{/if}
	{#if entityActions}{@render entityActions()}{/if}
{/snippet}

<UnifiedItemPageFrame
	label="Artist page"
	heading={artist?.name ?? '…'}
	headingTestId="unified-artist-name"
	{backLabel}
	backTestId="unified-artist-back"
	{onBack}
	{summary}
	headingActions={artistHeadingActions}
	{headerExtra}
>
	<EntityFeedback label="Artist status" message={bookmarkStatus} />
	{#if !artist}
		<p class="notice" data-testid="unified-drill-missing">
			{missingMessage ?? 'That artist is no longer in this library.'}
		</p>
	{:else}
		{@const fallback = monogram(artist.name)}
		{#if artist.imageKey}
			{#if imgAspect === null}
				<!-- Measuring: fixed placeholder so nothing jumps when the
				     aspect lands. The monogram under-layer is decorative in all
				     states (q2-3) and stays out of the accessibility tree. -->
				<div class="artist-shot" data-testid="unified-artist-hero">
					<div
						class="mono-tile"
						style={fallback.style}
						data-testid="unified-artist-hero-fallback"
						aria-hidden="true"
					>
						{fallback.letter}
					</div>
					<img
						src={imageUrl(artist.imageKey, { scale: 'fit', width: 2400, height: 1600 })}
						alt=""
						loading="lazy"
						data-testid="unified-artist-hero-image"
						use:hideOnError
						onload={noteAspect}
					/>
				</div>
			{:else if wideImage}
				<div class="artist-banner" data-testid="unified-artist-hero">
					<div
						class="mono-tile"
						style={fallback.style}
						data-testid="unified-artist-hero-fallback"
						aria-hidden="true"
					>
						{fallback.letter}
					</div>
					<img
						src={imageUrl(artist.imageKey, { scale: 'fit', width: 2400, height: 1600 })}
						alt=""
						loading="lazy"
						data-testid="unified-artist-hero-image"
						use:hideOnError
					/>
					<div class="scrim" aria-hidden="true"></div>
					<div class="banner-id">
						<span class="banner-name">{artist.name}</span>
						{#if summary}<span class="banner-summary mono">{summary}</span>{/if}
					</div>
				</div>
			{:else}
				<div class="artist-lede" data-testid="unified-artist-hero">
					<img
						src={imageUrl(artist.imageKey, { scale: 'fit', width: 2400, height: 1600 })}
						alt=""
						loading="lazy"
						data-testid="unified-artist-hero-image"
						use:hideOnError
					/>
					<div class="lede-id">
						<span class="lede-name">{artist.name}</span>
						{#if summary}<span class="lede-summary mono">{summary}</span>{/if}
					</div>
				</div>
			{/if}
		{:else}
			<!-- No artwork: the modest monogram tile, square chrome like
			     album art. -->
			<div class="artist-hero" data-testid="unified-artist-hero">
				<div
					class="mono-tile"
					style={fallback.style}
					data-testid="unified-artist-hero-fallback"
					aria-hidden="true"
				>
					{fallback.letter}
				</div>
			</div>
		{/if}
		<div class="artist-cols">
			<div class="area-disco">
				<!-- Once an answer about this artist is in hand, it governs. A
				     live read that is still running, or that failed, has nothing
				     to add to a stored list that already said what this artist's
				     albums are, so neither of the two states below applies then. -->
				{#if !discographyKnown && albums.length === 0 && overlayPhase === 'loading'}
					<p class="status" data-testid="unified-drill-loading">Loading albums…</p>
				{:else if !discographyKnown && albums.length === 0 && overlayPhase === 'failed'}
					<p class="status error" data-testid="unified-drill-error">
						Could not load this artist's albums.
					</p>
				{:else}
					{@render discography()}
				{/if}
			</div>
		</div>
	{/if}
</UnifiedItemPageFrame>

<style>
	.artist-banner {
		position: relative;
		height: clamp(300px, 45vh, 520px);
		/* Full-bleed sideways past the pane's 26px padding (Roon's banner
		   runs edge to edge). The bottom margin is load-bearing in the
		   public build, where the sections that carry their own top
		   margin are capability-gated away. */
		margin: 0 -26px 24px;
		overflow: hidden;
		background: var(--songr-surface-11);
		box-shadow: 0 6px 16px rgba(0, 0, 0, 0.6);
	}
	.artist-banner img {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: cover;
		/* Mild top bias: wide press photos keep faces without the hard
		   letterbox crop that beheaded them in the first pass. */
		object-position: center 30%;
	}
	.artist-banner .mono-tile {
		display: grid;
		width: 100%;
		height: 100%;
		place-items: center;
		font-size: 96px;
		color: var(--soft);
	}
	/* Measuring placeholder (aspect unknown): fixed box so the page does
	   not jump when the image lands and the mode is chosen. */
	.artist-shot {
		position: relative;
		width: 240px;
		height: 240px;
		margin: 12px 0 24px;
		border-radius: 4px;
		overflow: hidden;
		background: var(--songr-surface-11);
		box-shadow:
			0 6px 16px rgba(0, 0, 0, 0.6),
			0 0 0 1px var(--line-subtle);
	}
	.artist-shot img {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.artist-shot .mono-tile {
		display: grid;
		width: 100%;
		height: 100%;
		place-items: center;
		font-size: 64px;
		color: var(--soft);
	}
	/* Compact header for non-banner photography: the image at its
	   natural aspect beside the identity. No crop, no band, no filler. */
	.artist-lede {
		display: flex;
		align-items: flex-end;
		gap: 20px;
		margin: 12px 0 24px;
	}
	.artist-lede img {
		display: block;
		width: auto;
		height: auto;
		max-width: min(45%, 380px);
		max-height: 260px;
		border-radius: 4px;
		background: var(--songr-surface-11);
		box-shadow:
			0 6px 16px rgba(0, 0, 0, 0.6),
			0 0 0 1px var(--line-subtle);
	}
	.artist-lede .lede-id {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding-bottom: 4px;
	}
	.artist-lede .lede-name {
		font-size: 24px;
		font-weight: 650;
	}
	.artist-lede .lede-summary {
		font-size: 11px;
		letter-spacing: 0.12em;
		color: var(--soft);
	}
	/* Legibility scrim: the identity overlay must read on any photo. */
	.artist-banner .scrim {
		position: absolute;
		inset: 0;
		background: linear-gradient(
			to top,
			rgba(0, 0, 0, 0.74) 0%,
			rgba(0, 0, 0, 0.28) 42%,
			transparent 72%
		);
	}
	.artist-banner .banner-id {
		position: absolute;
		right: 24px;
		bottom: 16px;
		left: 24px;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.artist-banner .banner-name {
		font-size: 30px;
		font-weight: 650;
		color: #fff;
		text-shadow: 0 1px 12px rgba(0, 0, 0, 0.55);
	}
	.artist-banner .banner-summary {
		font-size: 11px;
		letter-spacing: 0.12em;
		color: rgba(255, 255, 255, 0.82);
	}
	/* No-artwork fallback: the modest square tile (album-art chrome). The
	   bottom margin keeps the discography grid off the tile — the
	   "slightly overlapping image" the owner flagged 2026-08-17. */
	.artist-hero {
		position: relative;
		width: 196px;
		height: 196px;
		margin: 12px 0 24px;
		border-radius: 4px;
		overflow: hidden;
		background: var(--songr-surface-11);
		box-shadow:
			0 6px 16px rgba(0, 0, 0, 0.6),
			0 0 0 1px var(--line-subtle);
	}
	.artist-hero .mono-tile {
		display: grid;
		width: 100%;
		height: 100%;
		place-items: center;
		font-size: 48px;
		color: var(--soft);
	}
	.status {
		margin: 0;
		opacity: 0.75;
		font-size: 13px;
	}
	.status.error {
		opacity: 1;
		color: var(--error, #e66);
	}
</style>
