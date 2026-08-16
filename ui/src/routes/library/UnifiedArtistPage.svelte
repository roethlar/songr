<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { LibraryAlbumEntry, LibraryArtistEntry } from '$lib/stores/libraryIndexStore';
	import type { EditorialItemState } from '$lib/library/EditorialItemController';
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
		<EditorialTextSection
			heading="Biography"
			section="biography"
			{editorial}
			testId="unified-artist-biography"
			onRetry={onEditorialRetry}
		/>
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
		{#if overlayPhase === 'loading' && albums.length === 0}
			<p class="status" data-testid="unified-drill-loading">Loading albums…</p>
		{:else if overlayPhase === 'failed' && albums.length === 0}
			<p class="status error" data-testid="unified-drill-error">
				Could not load this artist's albums.
			</p>
		{:else}
			{@render discography()}
		{/if}
	{/if}
</UnifiedItemPageFrame>

<style>
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
	.editorial-child h3 {
		margin: 0 0 4px;
		font-size: 15px;
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
</style>
