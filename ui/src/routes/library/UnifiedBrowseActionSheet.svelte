<script lang="ts">
	import type { UnifiedSongActionSemantic } from '@shared/unifiedSearchContracts';
	import { focusTrap, isTopModalOwner } from '$lib/actions/focusTrap';
	import type { UnifiedBrowseActionState } from '$lib/library/UnifiedBrowseController';

	interface ZoneOption {
		readonly zoneId: string;
		readonly name: string;
	}

	let {
		state: actionState,
		zones,
		onAction,
		onFavorite,
		favoriteEnabled = true,
		favoriteStatus = null,
		onClose
	}: {
		state: UnifiedBrowseActionState;
		zones: readonly ZoneOption[];
		onAction: (semantic: UnifiedSongActionSemantic, zoneId: string) => void;
		onFavorite: () => void;
		favoriteEnabled?: boolean;
		favoriteStatus?: string | null;
		onClose: () => void;
	} = $props();

	const ACTIONS: readonly UnifiedSongActionSemantic[] = ['play-now', 'add-next', 'queue'];
	let dialogEl = $state<HTMLElement | null>(null);
	let pending = $state<UnifiedSongActionSemantic | null>(null);
	const item = $derived(actionState.source?.item ?? null);
	const busy = $derived(actionState.phase === 'loading' || actionState.phase === 'executing');

	function begin(semantic: UnifiedSongActionSemantic): void {
		if (busy || !actionState.available[semantic] || zones.length === 0) return;
		if (zones.length === 1) {
			onAction(semantic, zones[0].zoneId);
			return;
		}
		pending = semantic;
	}

	function chooseZone(zoneId: string): void {
		if (!pending || busy) return;
		onAction(pending, zoneId);
		pending = null;
	}

	function label(semantic: UnifiedSongActionSemantic): string {
		if (semantic === 'play-now') return 'Play Now';
		if (semantic === 'add-next') return 'Add Next';
		return 'Queue';
	}

	function handleWindowKeydown(event: KeyboardEvent): void {
		if (
			event.key !== 'Escape' ||
			(dialogEl !== null && !isTopModalOwner(dialogEl))
		) return;
		event.preventDefault();
		onClose();
	}
</script>

<svelte:window onkeydown={handleWindowKeydown} />

<div
	class="browse-action-backdrop"
	data-testid="unified-browse-action-sheet"
	role="presentation"
	onclick={(event) => event.target === event.currentTarget && onClose()}
>
	<div
		class="browse-action-sheet"
		role="dialog"
		aria-modal="true"
		aria-label="Result actions"
		tabindex="-1"
		bind:this={dialogEl}
		use:focusTrap={{ initialFocus: '.browse-action-close' }}
	>
		<button type="button" class="browse-action-close" aria-label="Close actions" onclick={onClose}>
			×
		</button>
		<p class="browse-action-kicker">CHOOSE AN ACTION</p>
		<h2>{item?.title ?? 'Result'}</h2>
		{#if item?.subtitle}<p class="browse-action-subtitle">{item.subtitle}</p>{/if}

		<div class="browse-action-buttons">
			{#each ACTIONS as semantic (semantic)}
				<button
					type="button"
					data-testid="unified-browse-action-{semantic}"
					disabled={busy || zones.length === 0 || !actionState.available[semantic]}
					onclick={() => begin(semantic)}
				>
					{label(semantic)}
				</button>
			{/each}
			<button
				type="button"
				data-testid="unified-browse-action-favorite"
				disabled={busy || !item || !favoriteEnabled}
				onclick={onFavorite}
			>
				Favorite
			</button>
		</div>

		{#if pending && zones.length > 1}
			<div class="browse-action-zones" data-testid="unified-browse-action-zones">
				<p>{label(pending)} on</p>
				{#each zones as zone (zone.zoneId)}
					<button type="button" onclick={() => chooseZone(zone.zoneId)}>{zone.name}</button>
				{/each}
				<button type="button" class="ghost" onclick={() => (pending = null)}>Cancel</button>
			</div>
		{/if}

		{#if actionState.phase === 'loading'}
			<p class="browse-action-status" data-testid="unified-browse-action-loading">
				Resolving current actions…
			</p>
		{:else if actionState.phase === 'executing'}
			<p class="browse-action-status" data-testid="unified-browse-action-executing">
				Sending action…
			</p>
		{:else if actionState.phase === 'success'}
			<p class="browse-action-status success" data-testid="unified-browse-action-success">
				Action complete.
			</p>
		{:else if actionState.phase === 'error'}
			<p class="browse-action-status error" data-testid="unified-browse-action-error">
				{actionState.error ?? 'Actions are unavailable.'}
			</p>
		{:else if zones.length === 0}
			<p class="browse-action-status">Select a zone before playing or queueing.</p>
		{/if}
		{#if favoriteStatus}
			<p class="browse-action-status" data-testid="unified-browse-favorite-status">
				{favoriteStatus}
			</p>
		{/if}
	</div>
</div>

<style>
	.browse-action-backdrop {
		position: absolute;
		inset: 0;
		z-index: 18;
		display: grid;
		place-items: center;
		padding: 24px;
		background: var(--songr-scrim-78);
		backdrop-filter: blur(5px);
	}

	.browse-action-sheet {
		position: relative;
		width: min(520px, 100%);
		padding: 28px;
		border: 1px solid color-mix(in srgb, var(--unified-accent) 55%, transparent);
		border-radius: 12px;
		background: var(--songr-panel);
		box-shadow: 0 28px 80px rgba(0, 0, 0, 0.7);
		color: var(--unified-fg);
	}

	.browse-action-close {
		position: absolute;
		top: 12px;
		right: 14px;
		border: 0;
		background: transparent;
		color: var(--songr-text-70);
		font-size: 24px;
		cursor: pointer;
	}

	.browse-action-kicker,
	.browse-action-status,
	.browse-action-zones p {
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		font-size: 11px;
		letter-spacing: 0.12em;
		color: var(--songr-text-52);
	}

	.browse-action-sheet h2,
	.browse-action-subtitle {
		margin: 0;
	}

	.browse-action-sheet h2 {
		font-size: 28px;
		font-weight: 500;
	}

	.browse-action-subtitle {
		margin-top: 4px;
		color: var(--songr-text-58);
	}

	.browse-action-buttons,
	.browse-action-zones {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 8px;
		margin-top: 24px;
	}

	.browse-action-buttons button,
	.browse-action-zones button {
		min-height: 44px;
		border: 1px solid var(--songr-line-22);
		border-radius: 7px;
		background: var(--songr-raise);
		color: var(--songr-text-90);
		font: inherit;
		cursor: pointer;
	}

	.browse-action-buttons button:hover:not(:disabled),
	.browse-action-zones button:hover:not(:disabled) {
		border-color: var(--unified-accent);
		color: var(--unified-accent);
	}

	.browse-action-buttons button:focus-visible,
	.browse-action-zones button:focus-visible,
	.browse-action-close:focus-visible {
		outline: 2px solid var(--unified-accent);
		outline-offset: 2px;
	}

	.browse-action-buttons button:disabled {
		opacity: 0.32;
		cursor: default;
	}

	.browse-action-zones {
		grid-template-columns: 1fr;
		padding-top: 12px;
		border-top: 1px solid var(--songr-line-12);
	}

	.browse-action-zones p {
		margin: 0;
		color: var(--unified-accent);
	}

	.browse-action-zones .ghost {
		background: transparent;
	}

	.browse-action-status {
		margin: 18px 0 0;
	}

	.browse-action-status.success {
		color: var(--songr-success-muted);
	}

	.browse-action-status.error {
		color: var(--songr-error);
	}

	@media (max-width: 520px) {
		.browse-action-buttons {
			grid-template-columns: 1fr;
		}
	}
</style>
