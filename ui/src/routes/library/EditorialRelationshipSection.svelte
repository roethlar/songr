<script lang="ts">
	import type { EditorialItemState } from '$lib/library/EditorialItemController';
	import { imageUrl } from '$lib/imageUrl';
	import { hideOnError } from '$lib/actions/imageFallback';

	/**
	 * Relationship sections (rich-item plan Slice 7): the Core's proven
	 * relationship families in delivered order — related artists on an
	 * artist view, similar albums on an album view. Rows carrying an
	 * opaque follow target render as navigation buttons — navigation
	 * only, never action authority. Skeleton, collapsed (first rows), and
	 * honest-empty states occupy the IDENTICAL fixed box (`slot`), so a
	 * resolving read never moves the page below (q1-1); only the
	 * user-initiated "Show all" may grow. Terminal no-content states after
	 * a positively issued open keep the fixed box with a quiet note (cc-1);
	 * feature-absent-at-ack, canceled, and idle states render nothing at
	 * all (q1-2).
	 */
	interface Props {
		editorial: EditorialItemState | null;
		testId: string;
		onFollow?: (target: string) => void;
		/** Which view kind may supply these groups. */
		kind?: 'album' | 'artist';
	}

	const { editorial, testId, onFollow = () => {}, kind = 'album' }: Props = $props();

	/** The collapsed state renders at most this many rows — the exact row
	    count the skeleton reserves, so the swap never changes height. */
	const COLLAPSED_ROWS = 2;

	let expanded = $state(false);

	// The retained view, not the transport phase, is the render gate
	// (ri4-2): every transition that should clear content already nulls
	// the view, while a section-scoped failure after a ready view keeps
	// the still-valid rows on the page.
	const groups = $derived(
		editorial?.view?.kind === kind ? (editorial.view.relationshipGroups ?? []) : []
	);
	// Only a positively issued open (opening) reserves the section slot
	// (R3, q1-2): idle — no open initiated or no live socket — renders
	// nothing, as do feature-absent states.
	const opening = $derived(editorial !== null && editorial.phase === 'opening');
	// A ready view of the expected kind that honestly carries no
	// relationships keeps the reserved slot with a quiet empty state
	// (q1-1) instead of unmounting — the grid below never moves.
	const emptyResult = $derived(
		editorial !== null &&
			editorial.phase === 'ready' &&
			editorial.view !== null &&
			editorial.view.kind === kind &&
			groups.length === 0
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
	const totalRows = $derived(groups.reduce((count, group) => count + group.items.length, 0));
	const collapsible = $derived(totalRows > COLLAPSED_ROWS);
	// Collapsed: the first COLLAPSED_ROWS rows in delivered order, group
	// labels intact; expansion reveals the rest (user action may grow).
	const shownGroups = $derived.by(() => {
		if (expanded || !collapsible) return groups;
		type RelationshipGroup = (typeof groups)[number];
		const clipped: RelationshipGroup[] = [];
		let remaining = COLLAPSED_ROWS;
		for (const group of groups) {
			if (remaining <= 0) break;
			const items = group.items.slice(0, remaining);
			clipped.push({ ...group, items });
			remaining -= items.length;
		}
		return clipped;
	});

	// A new groups payload (new item, follow) starts collapsed again.
	$effect(() => {
		void groups;
		expanded = false;
	});
</script>

{#if groups.length > 0}
	<section class="editorial" class:slot={!expanded} data-testid={testId}>
		<!-- cc-3: the collapsed clip preserves group boundaries, so a 1-row
		     first family pulls a second heading into the clipped area. The
		     toggle is pinned OUTSIDE the overflow-hidden clip — otherwise
		     that shape pushes it below the fixed slot's visible area and
		     the remaining rows become unreachable by mouse. -->
		<div class="clip">
			{#each shownGroups as group, groupIndex (groupIndex)}
				<h3>{group.label}</h3>
				<ul class="rows" data-testid="{testId}-group-{groupIndex}">
					{#each group.items as item, position (position)}
						{@const target = item.followTarget}
						<li class="row">
							{#if item.artworkKey}
								<!-- Honest absence: no key renders no image slot at
								     all; a failed load hides the img in place
								     (q2-3), revealing its placeholder tile. -->
								<img
									class="thumb"
									src={imageUrl(item.artworkKey, { scale: 'fit', width: 64, height: 64 })}
									alt=""
									loading="lazy"
									data-testid="{testId}-art-{groupIndex}-{position}"
									use:hideOnError
								/>
							{/if}
							{#if target !== undefined}
								<button
									type="button"
									class="title follow"
									data-testid="{testId}-follow-{groupIndex}-{position}"
									onclick={() => onFollow(target)}
								>
									{item.title}
								</button>
							{:else}
								<span class="title">{item.title}</span>
							{/if}
							{#if item.subtitle}
								<span class="subtitle">{item.subtitle}</span>
							{/if}
						</li>
					{/each}
				</ul>
			{/each}
		</div>
		{#if collapsible}
			<button
				type="button"
				class="toggle"
				data-testid="{testId}-toggle"
				aria-expanded={expanded}
				onclick={() => (expanded = !expanded)}
			>
				{expanded ? 'Show less' : `Show all ${totalRows}`}
			</button>
		{/if}
	</section>
{:else if failedAfterOpen}
	<!-- Quiet failure (cc-1): the open reserved this slot, so the terminal
	     failure keeps the fixed box — unmounting would snap the grid
	     below back up. -->
	<section class="editorial slot" data-testid="{testId}-failed">
		<p class="status">
			{kind === 'artist'
				? 'Related artists could not be loaded.'
				: 'Similar albums could not be loaded.'}
		</p>
	</section>
{:else if emptyResult || unavailableInSession}
	<!-- Honest empty (q1-1): the Core answered and has no relationships
	     for this view — or the feature vanished mid-session (cc-1). The
	     slot stays occupied so nothing below moves. -->
	<section class="editorial slot" data-testid="{testId}-empty">
		<p class="status">
			{kind === 'artist' ? 'No related artists available.' : 'No similar albums available.'}
		</p>
	</section>
{:else if opening}
	<!-- Reserved slot (R3/q1-1): identical fixed height to the collapsed
	     state it will be replaced by, so nothing below it moves. -->
	<section class="editorial slot" data-testid="{testId}-skeleton" aria-hidden="true">
		<div class="skeleton-heading"></div>
		<ul class="rows">
			<li class="row"><span class="skeleton-line"></span></li>
			<li class="row"><span class="skeleton-line short"></span></li>
		</ul>
	</section>
{/if}

<style>
	.editorial {
		margin-top: 18px;
	}
	/* Fixed reserved box (q1-1): skeleton, collapsed (first rows), and
	   empty states occupy the identical height, so a resolving read never
	   moves the content below. Worst-case contents: group heading (~20px)
	   + 2 rows with thumbnails (2 × 38px) + toggle (~20px) ≈ 116px;
	   124px carries slack, and overflow is the backstop. The
	   user-initiated expanded state drops this class and may grow. */
	.slot {
		height: 124px;
		overflow: hidden;
	}
	/* cc-3: inside the fixed slot, only the groups clip — the toggle is
	   its sibling, never clipped. The bound is the slot height minus the
	   toggle zone (margin 6px + ~20px text), so even a multi-heading
	   collapsed shape cannot push the toggle out of view; the slot's own
	   overflow remains the backstop. Expanded drops `.slot`, unclipping
	   the groups. */
	.slot .clip {
		max-height: 98px;
		overflow: hidden;
	}
	.editorial h3 {
		margin: 0 0 6px;
		font-size: 12px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--soft);
	}
	.rows {
		list-style: none;
		margin: 0 0 10px;
		padding: 0;
		max-width: 68ch;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 3px 0;
		font-size: 13px;
	}
	.thumb {
		width: 32px;
		height: 32px;
		flex: 0 0 32px;
		border-radius: 3px;
		object-fit: cover;
		background: var(--songr-surface-11);
		/* 1px keyline, matching the tile art chrome at thumbnail size (q6). */
		box-shadow: 0 0 0 1px var(--line-subtle);
	}
	.subtitle {
		color: var(--soft);
		font-size: 12px;
		min-width: 0;
	}
	.title {
		min-width: 0;
	}
	.skeleton-heading {
		width: 14ch;
		height: 12px;
		border-radius: 3px;
		background: var(--songr-surface-11);
		animation: editorial-pulse 1.4s ease-in-out infinite;
	}
	.skeleton-line {
		display: inline-block;
		width: 18ch;
		height: 13px;
		border-radius: 3px;
		background: var(--songr-surface-11);
		animation: editorial-pulse 1.4s ease-in-out infinite;
	}
	.skeleton-line.short {
		width: 10ch;
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
		.skeleton-heading,
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
	button.follow {
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--accent);
		font-size: 13px;
		text-align: left;
		cursor: pointer;
	}
	button.follow:hover {
		color: var(--accent2);
	}
</style>
