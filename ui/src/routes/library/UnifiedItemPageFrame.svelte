<script lang="ts">
	import { tick } from 'svelte';
	import type { Snippet } from 'svelte';

	/**
	 * Shared frame for first-class item pages (rich-item plan §4.1). The
	 * entity OWNS the content pane: this is page navigation, not a modal —
	 * no focus trap, no scrim, no Escape-to-dismiss. Browser/app Back is
	 * the page exit. On open, focus moves to the page heading (§4.3).
	 */
	interface Props {
		/** Region label, e.g. "Album page". */
		label: string;
		heading: string;
		headingTestId?: string;
		backLabel: string;
		backTestId?: string;
		onBack: () => void;
		summary?: string | null;
		/** Extra header controls (e.g. a sort menu). */
		headerExtra?: Snippet;
		headingActions?: Snippet;
		children: Snippet;
	}

	const {
		label,
		heading,
		headingTestId = 'unified-item-heading',
		backLabel,
		backTestId = 'unified-item-back',
		onBack,
		summary = null,
		headerExtra,
		headingActions,
		children
	}: Props = $props();

	let headingElement: HTMLHeadingElement | null = $state(null);

	// Focus ownership on open only: the heading takes focus once when the
	// page mounts, and never steals it back on later re-renders.
	$effect(() => {
		const target = headingElement;
		if (!target) return;
		void tick().then(() => {
			if (target.isConnected && !target.contains(document.activeElement)) {
				target.focus({ preventScroll: false });
			}
		});
	});
</script>

<section class="item-page" data-testid="unified-item-page" aria-label={label}>
	<div class="ctx">
		<button type="button" class="back" data-testid={backTestId} onclick={onBack}>
			← {backLabel}
		</button>
		<div class="entity-identity">
			<h2 tabindex="-1" bind:this={headingElement} data-testid={headingTestId}>{heading}</h2>
			{#if headingActions}<div class="entity-heading-actions">{@render headingActions()}</div>{/if}
		</div>
		{#if summary}
			<span class="n mono" data-testid="unified-item-summary">{summary}</span>
		{/if}
		{#if headerExtra}
			{@render headerExtra()}
		{/if}
	</div>
	{@render children()}
</section>

<style>
	.entity-identity { display: flex; align-items: center; gap: 8px; min-width: 0; }
	.entity-identity h2 { min-width: 0; }
	.entity-heading-actions { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
	.item-page {
		display: flex;
		min-height: 0;
		flex-direction: column;
	}
	.item-page h2:focus {
		outline: none;
	}
	.item-page h2:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 3px;
	}
</style>
