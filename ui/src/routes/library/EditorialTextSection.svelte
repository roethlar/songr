<script lang="ts">
	import type { EditorialProseSectionName } from '@shared/editorialItemContracts';
	import { stripEditorialMarkup } from '@shared/editorialMarkup';
	import type { EditorialItemState } from '$lib/library/EditorialItemController';

	/**
	 * One optional editorial prose section (rich-item plan Slice 3): a
	 * review or biography with attribution, long-form collapse, and a
	 * quiet per-section retry. While the editorial session is still
	 * opening the section holds a reserved skeleton slot in its fixed
	 * page position, so the arriving prose replaces it in place instead
	 * of shifting already-rendered controls (R3). Skeleton, collapsed,
	 * failed, and honest-empty states all occupy the IDENTICAL fixed box
	 * (`slot`), so a resolving read never moves the page below (q1-1);
	 * only the user-initiated expansion may grow. Terminal no-content
	 * states after a positively issued open keep the fixed box with a
	 * quiet honest-absence note (cc-1); the section renders NOTHING only
	 * when no open was issued or the feature is absent at the open ack —
	 * the page must read as complete without it (§2, §7, q1-2).
	 */
	interface Props {
		heading: string;
		section: EditorialProseSectionName;
		editorial: EditorialItemState | null;
		testId: string;
		onRetry: () => void;
	}

	const { heading, section, editorial, testId, onRetry }: Props = $props();

	/**
	 * Toggle heuristic for the 3-line clamp: enough text to plausibly
	 * exceed it (conservative — a false positive only shows a toggle
	 * whose expansion changes nothing).
	 */
	const COLLAPSE_THRESHOLD = 200;
	const COLLAPSE_NEWLINES = 3;

	let expanded = $state(false);

	const prose = $derived(
		editorial?.phase === 'ready' ? (editorial.view?.sections[section] ?? null) : null
	);
	const attribution = $derived(
		prose !== null ? (editorial?.view?.attribution ?? []) : []
	);
	// A retryable failure earns a quiet retry row. A NON-retryable failure
	// for this section keeps the reserved slot too (cc-1): the open already
	// reserved the box, so unmounting on the failure path would snap the
	// content below back up (the q1-1 layout-shift class). Only states that
	// never issued an open — idle, feature-absent (FEATURE_UNAVAILABLE at
	// the open ack, q1-2), canceled — render nothing at all.
	const failedRetryable = $derived(
		editorial !== null &&
			editorial.phase === 'failed' &&
			editorial.retryable &&
			(editorial.section === null || editorial.section === section)
	);
	const failedQuiet = $derived(
		editorial !== null &&
			editorial.phase === 'failed' &&
			!editorial.retryable &&
			(editorial.section === null || editorial.section === section)
	);
	// Only a positively issued open (opening) reserves the section slot
	// (R3, q1-2): idle — no open initiated or no live socket — renders
	// nothing, as do feature-absent, canceled, and failed-silent states.
	const opening = $derived(editorial !== null && editorial.phase === 'opening');
	// A ready view that honestly carries no prose for this section keeps
	// the reserved slot with a quiet empty state (q1-1) instead of
	// unmounting — the grid below never moves.
	const emptyResult = $derived(
		editorial !== null &&
			editorial.phase === 'ready' &&
			editorial.view !== null &&
			prose === null
	);
	// FEATURE_UNAVAILABLE arriving mid-SESSION (a failed event with the
	// session id attached, not the open ack) means the open succeeded and
	// the slot was reserved: keep the box with the same honest-absence
	// treatment as an empty result (cc-1). The feature-absent open-ack
	// answer (no session id) still renders nothing (q1-2).
	const unavailableInSession = $derived(
		editorial !== null && editorial.phase === 'unavailable' && editorial.sessionId !== null
	);
	// The server normalizes Roon `[Name](id)` markup before shipping; this
	// is the belt-and-braces pass so no markup pattern can ever render raw.
	const plainText = $derived(prose === null ? null : stripEditorialMarkup(prose.text));
	const collapsible = $derived(
		plainText !== null &&
			(plainText.length > COLLAPSE_THRESHOLD ||
				plainText.split('\n').length > COLLAPSE_NEWLINES)
	);

	$effect(() => {
		// A new prose payload (new item, follow) starts collapsed again.
		void prose;
		expanded = false;
	});

	/** External destinations render as links only when plainly http(s). */
	function safeUrl(url: string | undefined): string | null {
		if (!url) return null;
		return /^https?:\/\//i.test(url) ? url : null;
	}
</script>

{#if prose !== null}
	<section class="editorial" class:slot={!expanded} data-testid={testId}>
		<h3>{heading}</h3>
		<!-- cc-4: clamp only when the toggle exists to release it —
		     otherwise a narrow container could hide overflow text with no
		     reveal path. Unclamped short prose is shorter than the
		     reserved box, so the fixed-slot geometry (q1-1) is unaffected. -->
		<p class="prose" class:clamped={!expanded && collapsible} data-testid="{testId}-text">{plainText}</p>
		{#if collapsible}
			<button
				type="button"
				class="toggle"
				data-testid="{testId}-toggle"
				aria-expanded={expanded}
				onclick={() => (expanded = !expanded)}
			>
				{expanded ? 'Show less' : 'Read more'}
			</button>
		{/if}
		{#if attribution.length > 0}
			<ul class="attribution" data-testid="{testId}-attribution">
				{#each attribution as row, index (index)}
					<li>
						{#if safeUrl(row.url)}
							<a href={safeUrl(row.url)} target="_blank" rel="noopener noreferrer">{row.text}</a>
						{:else}
							{row.text}
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</section>
{:else if failedRetryable || failedQuiet}
	<section class="editorial slot" data-testid="{testId}-failed">
		<h3>{heading}</h3>
		<p class="status">This section could not be loaded.</p>
		{#if failedRetryable}
			<button type="button" class="retry" data-testid="{testId}-retry" onclick={onRetry}>
				Try again
			</button>
		{/if}
	</section>
{:else if emptyResult || unavailableInSession}
	<!-- Honest empty (q1-1): the Core answered and has no prose for this
	     section — or the feature vanished mid-session (cc-1). The slot
	     stays occupied so nothing below moves. -->
	<section class="editorial slot" data-testid="{testId}-empty">
		<h3>{heading}</h3>
		<p class="status">No {section} available.</p>
	</section>
{:else if opening}
	<!-- Reserved slot (R3/q1-1): identical fixed height to the collapsed
	     state it will be replaced by, so nothing below it moves. -->
	<section class="editorial slot" data-testid="{testId}-skeleton" aria-hidden="true">
		<h3>{heading}</h3>
		<p class="skeleton-line"></p>
		<p class="skeleton-line"></p>
		<p class="skeleton-line short"></p>
	</section>
{/if}

<style>
	.editorial {
		margin-top: 18px;
	}
	/* Fixed reserved box (q1-1): skeleton, collapsed, empty, and failed
	   states occupy the identical height, so a resolving read never moves
	   the content below. Worst-case contents: heading (~20px) + 3 clamped
	   prose lines (~61px) + toggle (~20px) + one attribution row (~22px)
	   ≈ 123px; 132px carries slack, and overflow is the backstop. The
	   user-initiated expanded state drops this class and may grow. */
	.slot {
		height: 132px;
		overflow: hidden;
	}
	.editorial h3 {
		margin: 0 0 6px;
		font-size: 12px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--soft);
	}
	.prose {
		margin: 0;
		max-width: 68ch;
		white-space: pre-line;
		font-size: 13px;
		line-height: 1.55;
	}
	/* The collapsed COLLAPSIBLE body is at most 3 rendered lines tall no
	   matter the character width or embedded newlines — the geometric half
	   of the fixed-slot promise (q1-1). Non-collapsible short prose never
	   clamps: a clamp without a toggle would hide text with no reveal
	   path (cc-4), and short prose fits the reserved box regardless. */
	.prose.clamped {
		display: -webkit-box;
		-webkit-line-clamp: 3;
		line-clamp: 3;
		-webkit-box-orient: vertical;
		overflow: hidden;
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
	.attribution {
		list-style: none;
		margin: 8px 0 0;
		padding: 0;
		font-size: 11px;
		color: var(--soft);
	}
	.attribution a {
		color: inherit;
		text-decoration: underline;
	}
	.status {
		margin: 0;
		opacity: 0.75;
		font-size: 13px;
	}
	.skeleton-line {
		margin: 6px 0 0;
		height: 13px;
		max-width: 68ch;
		border-radius: 3px;
		background: var(--songr-surface-11);
		animation: editorial-pulse 1.4s ease-in-out infinite;
	}
	.skeleton-line.short {
		max-width: 34ch;
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
	.retry {
		margin-top: 8px;
	}
</style>
