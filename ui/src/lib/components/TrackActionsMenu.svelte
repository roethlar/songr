<script lang="ts">
	import { focusTrap } from '$lib/actions/focusTrap';
	import type { BrowseItem } from '@shared/types';

	/**
	 * Inline popup for a track row's ⋮ button (BUGS.md #3). Renders
	 * Roon's action list (Play Now / Play From Here / Add Next /
	 * Queue / Start Radio) as a small overlay instead of the old
	 * full-page action-menu navigation, plus any caller-supplied
	 * extra entries (e.g. "Add to Favorites").
	 */
	let {
		title,
		actions,
		extras = [],
		busy = false,
		onAction,
		onClose
	}: {
		/** Track title shown as the menu header. */
		title: string;
		/** Roon action items (hint 'action' / isPlayable). */
		actions: BrowseItem[];
		/** Non-Roon entries appended below a divider. */
		extras?: { label: string; onSelect: () => void }[];
		/** Disables all entries while an action round-trip runs. */
		busy?: boolean;
		onAction: (action: BrowseItem) => void;
		onClose: () => void;
	} = $props();

	let backdropEl = $state<HTMLDivElement | null>(null);

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.preventDefault();
			onClose();
		}
	}

	function onBackdropClick(event: MouseEvent) {
		// Close only on a direct backdrop click; clicks inside the
		// menu bubble up here but must not dismiss it.
		if (event.target === backdropEl) onClose();
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="menu-backdrop"
	role="dialog"
	aria-modal="true"
	aria-label="Track actions"
	tabindex="-1"
	bind:this={backdropEl}
	onclick={onBackdropClick}
	use:focusTrap
>
	<div class="menu card">
		<p class="menu-title" title={title}>{title}</p>
		<ul class="menu-list">
			{#each actions as action (action.itemKey)}
				<li>
					<button
						type="button"
						class="menu-item"
						disabled={busy}
						onclick={() => onAction(action)}
					>{action.title}</button>
				</li>
			{/each}
			{#if extras.length > 0}
				<li class="menu-divider" aria-hidden="true"></li>
				{#each extras as extra (extra.label)}
					<li>
						<button
							type="button"
							class="menu-item"
							disabled={busy}
							onclick={extra.onSelect}
						>{extra.label}</button>
					</li>
				{/each}
			{/if}
		</ul>
		<button type="button" class="menu-close" onclick={onClose}>Cancel</button>
	</div>
</div>

<style>
	.menu-backdrop {
		position: fixed;
		inset: 0;
		z-index: 60;
		background: rgba(0, 0, 0, 0.45);
		display: grid;
		place-items: center;
		padding: 1rem;
	}

	.menu {
		width: min(320px, 92vw);
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 12px;
		padding: 0.7rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		box-shadow: var(--shadow-soft);
	}

	.menu-title {
		font-weight: 650;
		font-size: 0.92rem;
		margin: 0 0.2rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.menu-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}

	.menu-item {
		width: 100%;
		text-align: left;
		padding: 0.55rem 0.6rem;
		border: none;
		border-radius: 8px;
		background: none;
		color: var(--text);
		font-size: 0.9rem;
		cursor: pointer;
	}

	.menu-item:hover:not(:disabled) {
		background: var(--surface-2);
	}

	.menu-item:disabled {
		opacity: 0.5;
		cursor: progress;
	}

	.menu-divider {
		border-top: 1px solid var(--border);
		margin: 0.3rem 0.2rem;
	}

	.menu-close {
		align-self: flex-end;
		padding: 0.35rem 0.8rem;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--surface-2);
		color: var(--text-soft);
		font-size: 0.8rem;
		cursor: pointer;
	}

	.menu-close:hover {
		color: var(--text);
	}
</style>
