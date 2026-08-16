<script lang="ts">
	import type { EditorialProseSectionName } from '@shared/editorialItemContracts';
	import type { EditorialItemState } from '$lib/library/EditorialItemController';

	/**
	 * One optional editorial prose section (rich-item plan Slice 3): a
	 * review or biography with attribution, long-form collapse, and a
	 * quiet per-section retry. The section renders NOTHING while the
	 * enrichment is idle, opening, unavailable, or honestly absent — the
	 * page must read as complete without it (§2, §7).
	 */
	interface Props {
		heading: string;
		section: EditorialProseSectionName;
		editorial: EditorialItemState | null;
		testId: string;
		onRetry: () => void;
	}

	const { heading, section, editorial, testId, onRetry }: Props = $props();

	/** Collapse long prose past this many characters until expanded. */
	const COLLAPSE_THRESHOLD = 700;

	let expanded = $state(false);

	const prose = $derived(
		editorial?.phase === 'ready' ? (editorial.view?.sections[section] ?? null) : null
	);
	const attribution = $derived(
		prose !== null ? (editorial?.view?.attribution ?? []) : []
	);
	// A retryable failure earns a quiet retry row; every other absence —
	// unavailable feature, honest empty, non-retryable failure — renders
	// nothing at all (no placeholder, no teaser).
	const failedRetryable = $derived(
		editorial !== null &&
			editorial.phase === 'failed' &&
			editorial.retryable &&
			(editorial.section === null || editorial.section === section)
	);
	const collapsible = $derived(prose !== null && prose.text.length > COLLAPSE_THRESHOLD);
	const shownText = $derived.by(() => {
		if (prose === null) return '';
		if (!collapsible || expanded) return prose.text;
		const slice = prose.text.slice(0, COLLAPSE_THRESHOLD);
		const boundary = slice.lastIndexOf(' ');
		return `${boundary > COLLAPSE_THRESHOLD / 2 ? slice.slice(0, boundary) : slice}…`;
	});

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
	<section class="editorial" data-testid={testId}>
		<h3>{heading}</h3>
		<p class="prose" data-testid="{testId}-text">{shownText}</p>
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
{:else if failedRetryable}
	<section class="editorial" data-testid="{testId}-failed">
		<h3>{heading}</h3>
		<p class="status">This section could not be loaded.</p>
		<button type="button" class="retry" data-testid="{testId}-retry" onclick={onRetry}>
			Try again
		</button>
	</section>
{/if}

<style>
	.editorial {
		margin-top: 18px;
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
	.toggle {
		margin-top: 6px;
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--accent);
		font-size: 12px;
		cursor: pointer;
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
	.retry {
		margin-top: 8px;
	}
</style>
