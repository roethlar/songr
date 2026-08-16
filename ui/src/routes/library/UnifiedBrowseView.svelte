<script lang="ts">
	import type { BrowseItem } from '@shared/types';
	import {
		browseItemOpensActions,
		type UnifiedBrowseState
	} from '$lib/library/UnifiedBrowseController';

	let {
		state,
		onBack,
		onForward,
		onItem,
		onLoadMore,
		onSearchPrompt
	}: {
		state: UnifiedBrowseState;
		onBack: () => void;
		onForward: () => void;
		onItem: (item: BrowseItem) => void;
		onLoadMore: () => void;
		onSearchPrompt: () => void;
	} = $props();

	const result = $derived(state.result);
	const items = $derived(result?.items ?? []);
	const total = $derived(result?.totalCount ?? result?.count ?? 0);
	const canLoadMore = $derived(
		(state.phase === 'ready' || state.phase === 'error') && items.length < total
	);

	function rowIcon(item: BrowseItem): string {
		const token = `${item.itemType ?? ''} ${item.hint ?? ''}`.toLowerCase();
		if (token.includes('track')) return '♬';
		if (token.includes('artist')) return '♪';
		if (token.includes('album')) return '○';
		if (token.includes('genre')) return '☉';
		if (token.includes('radio') || token.includes('station')) return '◉';
		if (item.inputPrompt) return '⌕';
		return '›';
	}

	function activate(item: BrowseItem): void {
		if (item.inputPrompt) onSearchPrompt();
		else onItem(item);
	}
</script>

<section class="browse-surface" data-testid="unified-browse-view" aria-label="Browse Roon">
	<div class="browse-heading">
		<div class="browse-nav" aria-label="Browse history">
			<button
				type="button"
				data-testid="unified-browse-back"
				disabled={state.snapshot.history.length === 0 || state.phase === 'loading'}
				onclick={onBack}
			>
				← Back
			</button>
			<button
				type="button"
				data-testid="unified-browse-forward"
				disabled={state.snapshot.forward.length === 0 || state.phase === 'loading'}
				onclick={onForward}
			>
				Forward →
			</button>
		</div>
		<div class="browse-title">
			<p class="browse-kicker">
				{state.snapshot.context.hierarchy === 'search' ? 'SEARCH RESULTS' : 'ROON BROWSE'}
			</p>
			<h2 data-testid="unified-browse-title">{result?.title ?? 'Browse'}</h2>
			{#if result?.subtitle}<p class="browse-subtitle">{result.subtitle}</p>{/if}
		</div>
		{#if result}
			<span class="browse-count" data-testid="unified-browse-summary">
				{items.length.toLocaleString()}{total > items.length ? ` OF ${total.toLocaleString()}` : ''}
			</span>
		{/if}
	</div>

	{#if state.snapshot.history.length > 0}
		<ol class="browse-crumbs" aria-label="Browse path" data-testid="unified-browse-path">
			{#each state.snapshot.history as step, index (`${index}:${step.breadcrumb.title}`)}
				<li>{step.breadcrumb.title}</li>
			{/each}
		</ol>
	{/if}

	{#if state.notice}
		<p class="browse-notice" data-testid="unified-browse-notice">{state.notice}</p>
	{/if}
	{#if state.phase === 'loading' && !result}
		<p class="browse-status" data-testid="unified-browse-loading">Loading Browse…</p>
	{:else if state.phase === 'error' && !result}
		<p class="browse-status browse-error" data-testid="unified-browse-error">
			Browse failed{state.error ? `: ${state.error}` : '.'}
		</p>
	{:else if result && items.length === 0}
		<p class="browse-status" data-testid="unified-browse-empty">Nothing is available here.</p>
	{:else if result}
		{#if state.phase === 'error'}
			<p class="browse-status browse-error" data-testid="unified-browse-error">
				Could not load more{state.error ? `: ${state.error}` : '.'}
			</p>
		{/if}
		<div class="browse-list" data-testid="unified-browse-list">
			{#each items as item, index (`${index}:${item.title}:${item.subtitle ?? ''}`)}
				<button
					type="button"
					class="browse-row"
					data-testid="unified-browse-row"
					aria-label={item.inputPrompt
						? `${item.inputPrompt} in Search`
						: browseItemOpensActions(item)
							? `Open actions for ${item.title}`
							: `Open ${item.title}`}
					disabled={state.phase === 'loading'}
					onclick={() => activate(item)}
				>
					<span class="browse-icon" aria-hidden="true">{rowIcon(item)}</span>
					<span class="browse-primary">{item.title}</span>
					<span class="browse-secondary">{item.subtitle ?? ''}</span>
					<span class="browse-affordance">
						{item.inputPrompt
							? 'SEARCH'
							: browseItemOpensActions(item)
								? 'ACTIONS'
								: 'OPEN'}
					</span>
				</button>
			{/each}
		</div>
		{#if canLoadMore}
			<button
				type="button"
				class="browse-more"
				data-testid="unified-browse-more"
				onclick={onLoadMore}
			>
				{state.phase === 'error' ? 'Retry next' : 'Load next'}
				{Math.min(100, total - items.length).toLocaleString()}
			</button>
		{/if}
	{/if}
</section>

<style>
	.browse-surface {
		display: flex;
		flex-direction: column;
		gap: 14px;
		min-height: 0;
		color: var(--unified-fg);
	}

	.browse-heading {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: end;
		gap: 20px;
		padding: 12px 0 14px;
		border-bottom: 1px solid var(--songr-line-16);
	}

	.browse-nav {
		display: flex;
		gap: 6px;
	}

	.browse-nav button,
	.browse-more {
		border: 1px solid var(--songr-line-22);
		border-radius: 999px;
		background: var(--songr-panel);
		color: var(--songr-text-90);
		padding: 7px 11px;
		font: inherit;
		cursor: pointer;
	}

	.browse-nav button:disabled {
		opacity: 0.28;
		cursor: default;
	}

	.browse-nav button:focus-visible,
	.browse-more:focus-visible,
	.browse-row:focus-visible {
		outline: 2px solid var(--unified-accent);
		outline-offset: 2px;
	}

	.browse-kicker,
	.browse-count,
	.browse-affordance {
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		font-size: 10px;
		letter-spacing: 0.14em;
		color: var(--songr-text-48);
	}

	.browse-title h2,
	.browse-title p {
		margin: 0;
	}

	.browse-title h2 {
		font-size: clamp(24px, 3vw, 38px);
		font-weight: 500;
	}

	.browse-subtitle {
		color: var(--songr-text-58);
	}

	.browse-crumbs {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin: 0;
		padding: 0;
		list-style: none;
		color: var(--songr-text-54);
		font-size: 12px;
	}

	.browse-crumbs li:not(:last-child)::after {
		content: ' /';
		color: var(--unified-accent);
	}

	.browse-list {
		display: flex;
		flex-direction: column;
		border-top: 1px solid var(--songr-line-10);
	}

	.browse-row {
		display: grid;
		grid-template-columns: 30px minmax(140px, 0.8fr) minmax(180px, 1.2fr) auto;
		align-items: center;
		gap: 12px;
		width: 100%;
		min-height: 48px;
		padding: 8px 12px;
		border: 0;
		border-bottom: 1px solid var(--songr-line-10);
		background: var(--unified-bg);
		color: var(--songr-text-90);
		font: inherit;
		text-align: left;
		cursor: pointer;
	}

	.browse-row:hover {
		background: var(--songr-browse-hover);
	}

	.browse-row:disabled {
		cursor: progress;
		opacity: 0.65;
	}

	.browse-icon {
		color: var(--unified-accent);
		text-align: center;
	}

	.browse-primary {
		font-size: 15px;
	}

	.browse-secondary {
		color: var(--songr-text-58);
		font-size: 13px;
	}

	.browse-affordance {
		color: var(--unified-accent);
	}

	.browse-notice,
	.browse-status {
		margin: 4px 0;
		padding: 12px;
		border: 1px solid var(--songr-line-strong);
		border-radius: 8px;
		color: var(--songr-text-64);
	}

	.browse-error {
		color: var(--songr-error);
	}

	.browse-more {
		align-self: center;
		margin: 8px 0 28px;
		border-color: var(--unified-accent);
		color: var(--unified-accent);
	}

	@media (max-width: 760px) {
		.browse-heading {
			grid-template-columns: 1fr auto;
		}

		.browse-nav {
			grid-column: 1 / -1;
		}

		.browse-row {
			grid-template-columns: 24px minmax(0, 1fr) auto;
		}

		.browse-secondary {
			display: none;
		}
	}
</style>
