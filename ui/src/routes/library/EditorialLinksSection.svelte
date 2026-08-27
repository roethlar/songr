<script lang="ts">
	import type { EditorialItemState } from '$lib/library/EditorialItemController';

	/**
	 * Core-supplied external links (rich-item plan Slice 7). Every row is
	 * display + safe navigation only: destinations render as links only
	 * when plainly http(s), and rows without a safe destination render as
	 * plain text. Skeleton, collapsed (first links), and honest-empty
	 * states occupy the IDENTICAL fixed box (`slot`), so a resolving read
	 * never moves the page below (q1-1); only the user-initiated "Show
	 * all" may grow. Terminal no-content states after a positively issued
	 * open keep the fixed box with a quiet note (cc-1); feature-absent-at-
	 * ack, canceled, and idle states render nothing at all (q1-2).
	 */
	interface Props {
		editorial: EditorialItemState | null;
		testId: string;
		/** Which view kind may supply these links. */
		kind?: 'album' | 'artist';
	}

	const { editorial, testId, kind = 'artist' }: Props = $props();

	/** The collapsed state renders at most this many links — the exact
	    pill count the skeleton reserves, so the swap never changes
	    height. */
	const COLLAPSED_LINKS = 2;

	let expanded = $state(false);

	// View-presence gate (ri4-2), same rule as the other sections.
	const links = $derived(
		editorial?.view?.kind === kind ? (editorial.view.links ?? []) : []
	);
	// Only a positively issued open (opening) reserves the section slot
	// (R3, q1-2): idle — no open initiated or no live socket — renders
	// nothing, as do feature-absent states.
	const opening = $derived(editorial !== null && editorial.phase === 'opening');
	// A ready view of the expected kind that honestly carries no links
	// keeps the reserved slot with a quiet empty state (q1-1) instead of
	// unmounting — the grid below never moves.
	const emptyResult = $derived(
		editorial !== null &&
			editorial.phase === 'ready' &&
			editorial.view !== null &&
			editorial.view.kind === kind &&
			links.length === 0
	);
	// cc-1: a terminal no-content state after a positively issued open
	// keeps the reserved slot — the open reserved the box, so unmounting
	// on the failure path would snap the content below back up (the q1-1
	// layout-shift class on the failure path). A failed read keeps it with
	// a quiet failure note; a mid-session FEATURE_UNAVAILABLE (failed
	// event, session id attached) keeps it with the honest-absence wording.
	// Only never-opened (idle), feature-absent-at-ack (unavailable with no
	// session id, q1-2), and canceled states render nothing.
	const failedAfterOpen = $derived(editorial !== null && editorial.phase === 'failed');
	const unavailableInSession = $derived(
		editorial !== null && editorial.phase === 'unavailable' && editorial.sessionId !== null
	);
	const collapsible = $derived(links.length > COLLAPSED_LINKS);
	// Collapsed: the first COLLAPSED_LINKS links in delivered order;
	// expansion reveals the rest (user action may grow).
	const shownLinks = $derived(expanded || !collapsible ? links : links.slice(0, COLLAPSED_LINKS));

	// A new links payload (new item, follow) starts collapsed again.
	$effect(() => {
		void links;
		expanded = false;
	});

	/** External destinations render as links only when plainly http(s). */
	function safeUrl(url: string | undefined): string | null {
		if (!url) return null;
		return /^https?:\/\//i.test(url) ? url : null;
	}
</script>

{#if links.length > 0}
	<section class="editorial" class:slot={!expanded} data-testid={testId}>
		<h3>Links</h3>
		<ul class="links">
			{#each shownLinks as row, index (index)}
				<li>
					{#if safeUrl(row.url)}
						<a
							href={safeUrl(row.url)}
							target="_blank"
							rel="noopener noreferrer"
							data-testid="{testId}-link-{index}"
						>
							{row.text}
						</a>
					{:else}
						<span data-testid="{testId}-link-{index}">{row.text}</span>
					{/if}
				</li>
			{/each}
		</ul>
		{#if collapsible}
			<button
				type="button"
				class="toggle"
				data-testid="{testId}-toggle"
				aria-expanded={expanded}
				onclick={() => (expanded = !expanded)}
			>
				{expanded ? 'Show less' : `Show all ${links.length}`}
			</button>
		{/if}
	</section>
{:else if failedAfterOpen}
	<!-- Quiet failure (cc-1): the open reserved this slot, so the terminal
	     failure keeps the fixed box — unmounting would snap the grid
	     below back up. -->
	<section class="editorial slot" data-testid="{testId}-failed">
		<p class="status">Links could not be loaded.</p>
	</section>
{:else if emptyResult || unavailableInSession}
	<!-- Honest empty (q1-1): the Core answered and has no links for this
	     view — or the feature vanished mid-session (cc-1). The slot stays
	     occupied so nothing below moves. -->
	<section class="editorial slot" data-testid="{testId}-empty">
		<p class="status">No links available.</p>
	</section>
{:else if opening}
	<!-- Reserved slot (R3/q1-1): identical fixed height to the collapsed
	     state it will be replaced by, so nothing below it moves. The
	     heading is static, so the skeleton shows the real one (same
	     treatment as the prose sections, q6); only the data-dependent
	     pills are placeholder bars. -->
	<section class="editorial slot" data-testid="{testId}-skeleton" aria-hidden="true">
		<h3>Links</h3>
		<ul class="links">
			<li><span class="skeleton-line pill"></span></li>
			<li><span class="skeleton-line pill"></span></li>
		</ul>
	</section>
{/if}

<style>
	.editorial {
		margin-top: 18px;
	}
	/* Fixed reserved box (q1-1): skeleton, collapsed (first links), and
	   empty states occupy the identical height, so a resolving read never
	   moves the content below. Worst-case contents: heading (~20px) + one
	   pill row (~14px) + toggle (~18px) ≈ 52px; 60px carries slack, and
	   overflow is the backstop. The user-initiated expanded state drops
	   this class and may grow. */
	.slot {
		height: 60px;
		overflow: hidden;
	}
	.editorial h3 {
		margin: 0 0 6px;
		font-size: 12px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--soft);
	}
	.links {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 6px 14px;
		max-width: 68ch;
		font-size: 12px;
	}
	.links a {
		color: var(--accent);
		text-decoration: underline;
	}
	.links a:hover {
		color: var(--accent2);
	}
	.skeleton-line.pill {
		display: inline-block;
		width: 12ch;
		height: 12px;
		border-radius: 3px;
		background: var(--songr-surface-11);
		animation: editorial-pulse 1.4s ease-in-out infinite;
	}
	@keyframes editorial-pulse {
		0%,
		100% {
			opacity: 0.45;
		}
		50% {
			opacity: 1;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.skeleton-line {
			animation: none;
		}
	}
	.toggle {
		margin-top: 6px;
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--accent);
		font-size: 12px;
		cursor: pointer;
	}
	.toggle:hover {
		color: var(--accent2);
	}
	.status {
		margin: 0;
		opacity: 0.75;
		font-size: 13px;
	}
</style>
