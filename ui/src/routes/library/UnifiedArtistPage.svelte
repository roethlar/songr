<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { LibraryAlbumEntry, LibraryArtistEntry } from '$lib/stores/libraryIndexStore';
	import type { EditorialItemState } from '$lib/library/EditorialItemController';
	import { imageUrl, wideArtistPortraitUrl } from '$lib/imageUrl';
	import { monogram } from '$lib/monogram';
	import { hideOnError } from '$lib/actions/imageFallback';
	import EditorialLinksSection from './EditorialLinksSection.svelte';
	import EditorialRelationshipSection from './EditorialRelationshipSection.svelte';
	import EditorialTextSection from './EditorialTextSection.svelte';
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
		truncated: boolean;
		backLabel: string;
		onBack: () => void;
		/** Sort control, rendered inside the page header. */
		headerExtra?: Snippet;
		discography: Snippet;
		/** Optional editorial enrichment (plan Slice 3); null renders nothing. */
		editorial?: EditorialItemState | null;
		onEditorialRetry?: () => void;
		/** Follows an opaque related-artist target (plan Slice 7). */
		onEditorialFollow?: (target: string) => void;
		/** True while the live editorial destination is a followed child. */
		editorialFollowActive?: boolean;
		/** Returns from a followed related artist to this artist's view. */
		onEditorialBack?: () => void;
	}

	const {
		artist,
		albums,
		overlayPhase,
		truncated,
		backLabel,
		onBack,
		headerExtra,
		discography,
		editorial = null,
		onEditorialRetry = () => {},
		onEditorialFollow = () => {},
		editorialFollowActive = false,
		onEditorialBack = () => {}
	}: Props = $props();

	// Parent and child views share kind 'artist' here, so the live follow
	// state — not the view kind — decides which surface a ready view is.
	const followedChild = $derived(
		editorialFollowActive && editorial?.view?.kind === 'artist'
			? editorial.view
			: null
	);

	const summary = $derived.by(() => {
		if (!artist) return null;
		// While the authoritative discography is still loading and the
		// fallback join found nothing, claim nothing rather than "0"; a
		// truncated page says "N+" rather than asserting a complete total.
		if (overlayPhase === 'loading' && albums.length === 0) return null;
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
	const wideKey = $derived.by((): string | null => {
		if (editorialFollowActive) return null;
		const view = editorial?.view ?? null;
		if (view === null || view.kind !== 'artist') return null;
		return view.wideArtworkKey ?? null;
	});

	/**
	 * The photograph this page has PROVEN, latched to the artist it belongs
	 * to. Set only once the picture has decoded — out of the layout, where
	 * it can move nothing — and never unset while the page stays on this
	 * artist, because taking a banner away would drag the discography out
	 * from under the pointer just as surely as adding one would.
	 *
	 * A key that changes for an artist already showing a banner is likewise
	 * ignored: the picture on screen is the one that was proven.
	 */
	let proven = $state<{ artistId: string; key: string } | null>(null);
	/** A portrait that 404'd or failed to decode. Never asked for again. */
	let refused = $state<{ artistId: string; key: string } | null>(null);

	const bannerKey = $derived(
		artist !== null && proven !== null && proven.artistId === artist.id
			? proven.key
			: null
	);
	const probeKey = $derived.by((): string | null => {
		if (artist === null || wideKey === null || bannerKey !== null) return null;
		const failed =
			refused !== null && refused.artistId === artist.id && refused.key === wideKey;
		return failed ? null : wideKey;
	});

	// Aspect-adaptive ordinary header — now the FALLBACK, reached only when
	// the library holds no wide photograph for this artist or the one it
	// holds could not be fetched. Its premise still holds for the artwork
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

<UnifiedItemPageFrame
	label="Artist page"
	heading={artist?.name ?? '…'}
	headingTestId="unified-artist-name"
	{backLabel}
	backTestId="unified-artist-back"
	{onBack}
	{summary}
	{headerExtra}
>
	{#if !artist}
		<p class="notice" data-testid="unified-drill-missing">
			That artist is no longer in this library.
		</p>
	{:else}
		{@const fallback = monogram(artist.name)}
		{#if bannerKey !== null}
			<!-- The wide photograph, full bleed. No monogram under-layer and
			     no placeholder: this branch is reached only after the picture
			     itself decoded, so there is nothing to stand in for. -->
			<div class="artist-banner wide" data-testid="unified-artist-wide-hero">
				<img
					src={wideArtistPortraitUrl(bannerKey)}
					alt=""
					data-testid="unified-artist-wide-hero-image"
					use:hideOnError
				/>
				<div class="scrim" aria-hidden="true"></div>
				<div class="banner-id">
					<span class="banner-name">{artist.name}</span>
					{#if summary}<span class="banner-summary mono">{summary}</span>{/if}
				</div>
			</div>
		{:else if artist.imageKey}
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
		{#if probeKey !== null}
			{@const probeArtistId = artist.id}
			{@const probeFor = probeKey}
			<!-- The portrait is fetched HERE first, outside the layout, so the
			     page cannot move while it is in flight. Only a picture that
			     decodes is promoted to the banner above; one that 404s or
			     fails leaves the page exactly as it already was, with nothing
			     to report. Deliberately not `loading="lazy"`: a lazy image in
			     a box with no size may never be fetched at all. -->
			<div class="wide-probe" aria-hidden="true">
				<img
					src={wideArtistPortraitUrl(probeFor)}
					alt=""
					data-testid="unified-artist-wide-probe"
					onload={() => (proven = { artistId: probeArtistId, key: probeFor })}
					onerror={() => (refused = { artistId: probeArtistId, key: probeFor })}
				/>
			</div>
		{/if}
		{#if followedChild !== null}
			<!-- A followed related artist (Slice 7): identity heading, its
			     own sections, and the way back to this artist's view. The
			     control names the real destination (ri5-4). -->
			<section class="editorial-child" data-testid="unified-artist-related-artist">
				<h3>{followedChild.title}</h3>
				<button
					type="button"
					class="follow-back"
					data-testid="unified-artist-related-artist-back"
					onclick={onEditorialBack}
				>
					Back to {artist.name}
				</button>
			</section>
		{/if}
		<!-- Two columns when editorial exists (owner direction 2026-08-17,
		     "more like Roon": biography + discography in the main column,
		     similar artists and links in a right rail. DOM order keeps all
		     three async sections ahead of the discography grid (R3). When
		     the feature is absent the rail renders nothing and the grid
		     must not be narrowed by an empty column — hence the split
		     class only when editorial is present. -->
		<div class="artist-cols" class:split={editorial !== null}>
			<div class="area-bio">
				<EditorialTextSection
					heading="Biography"
					section="biography"
					{editorial}
					testId="unified-artist-biography"
					onRetry={onEditorialRetry}
				/>
			</div>
			<div class="area-rail">
				<EditorialRelationshipSection
					{editorial}
					kind="artist"
					testId="unified-artist-relationships"
					onFollow={onEditorialFollow}
				/>
				<EditorialLinksSection
					{editorial}
					kind="artist"
					testId="unified-artist-links"
				/>
			</div>
			<div class="area-disco">
				{#if overlayPhase === 'loading' && albums.length === 0}
					<p class="status" data-testid="unified-drill-loading">Loading albums…</p>
				{:else if overlayPhase === 'failed' && albums.length === 0}
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
	/* The wide photograph's own frame. The library's wide master IS a 16:7
	   photograph, so a box of that exact shape shows the WHOLE of it: the
	   `cover` fit above has nothing left to cut, which is what makes this
	   honest where every earlier attempt was not — no top-biased crop
	   guessing where the faces are, no blurred band filling a shape the
	   picture does not have.

	   The height comes from the box's own width and never from the image,
	   so the frame is exactly as tall the instant it appears as it is once
	   the picture paints. Nothing below it can be moved by the image
	   arriving, resizing, or being re-decoded. */
	.artist-banner.wide {
		height: auto;
		aspect-ratio: 16 / 7;
	}
	.artist-banner.wide img {
		/* Centred, not biased: with the frame and the photograph the same
		   shape there is no offset to choose. */
		object-position: center;
	}
	/* Out of the layout entirely: no size, no space, no effect on anything
	   around it. The portrait is fetched in here and only a picture that
	   decodes is ever promoted into a frame that occupies the page. */
	.wide-probe {
		position: absolute;
		width: 0;
		height: 0;
		overflow: hidden;
		opacity: 0;
		pointer-events: none;
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
	   bottom margin is load-bearing in the public build: the editorial
	   sections that follow carry their own 18px top margin, but they are
	   absent there (capability-gated), and without this margin the
	   discography grid slams into the tile — the "slightly overlapping
	   image" the owner flagged 2026-08-17. */
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
	/* Two-column body (owner direction 2026-08-17): biography + discography
	   main, similar artists + links rail. Only when editorial exists — an
	   absent feature must not narrow the public page with an empty rail. */
	.artist-cols.split {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 300px;
		column-gap: 32px;
		align-items: start;
	}
	.artist-cols.split .area-bio {
		grid-column: 1;
		grid-row: 1;
	}
	.artist-cols.split .area-rail {
		grid-column: 2;
		grid-row: 1 / span 2;
	}
	.artist-cols.split .area-disco {
		grid-column: 1;
		grid-row: 2;
	}
	@media (max-width: 960px) {
		.artist-cols.split {
			grid-template-columns: 1fr;
		}
		.artist-cols.split .area-bio,
		.artist-cols.split .area-rail,
		.artist-cols.split .area-disco {
			grid-column: 1;
			grid-row: auto;
		}
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
	.editorial-child {
		margin-top: 18px;
	}
	/* Followed-child identity heading (q6): reads as identity — same
	   treatment as the album page's followed-child headings. */
	.editorial-child h3 {
		margin: 0 0 4px;
		font-size: 15px;
		font-weight: 600;
	}
	.follow-back {
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--accent);
		font-size: 12px;
		text-align: left;
		cursor: pointer;
	}
	.follow-back:hover {
		color: var(--accent2);
	}
</style>
