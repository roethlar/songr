<script lang="ts">
	import { tick } from 'svelte';
	import { focusTrap, isTopModalOwner } from '$lib/actions/focusTrap';

	export type TimelineAlbumActionChooserPhase =
		| 'resolving'
		| 'choosing'
		| 'executing'
		| 'error'
		| 'outcome-unknown';

	export interface TimelineAlbumActionChoiceView {
		readonly actionId: string;
		readonly label: string;
	}

	let {
		albumTitle,
		zoneName,
		phase,
		actions = [],
		message = null,
		executingLabel = null,
		onExecute,
		onCancel,
		onDismiss
	}: {
		albumTitle: string;
		zoneName: string;
		phase: TimelineAlbumActionChooserPhase;
		actions?: readonly TimelineAlbumActionChoiceView[];
		message?: string | null;
		executingLabel?: string | null;
		onExecute: (actionId: string) => void;
		onCancel?: () => void;
		onDismiss?: () => void;
	} = $props();

	let dialog: HTMLElement;
	let focusGeneration = 0;
	let activeFlow = $derived(phase === 'resolving' || phase === 'choosing');
	let canDismiss = $derived(
		phase !== 'executing' && (activeFlow ? onCancel !== undefined : onDismiss !== undefined)
	);

	function requestDismiss(): void {
		if (!canDismiss) return;
		if (activeFlow) onCancel?.();
		else onDismiss?.();
	}

	function handleWindowKeydown(event: KeyboardEvent): void {
		if (
			event.defaultPrevented ||
			event.key !== 'Escape' ||
			!canDismiss ||
			!dialog?.isConnected ||
			!isTopModalOwner(dialog)
		) return;
		event.preventDefault();
		event.stopPropagation();
		requestDismiss();
	}

	$effect(() => {
		const observedPhase = phase;
		const observedFirstAction = actions[0]?.actionId ?? null;
		const operation = ++focusGeneration;
		void tick().then(() => {
			if (
				operation !== focusGeneration ||
				phase !== observedPhase ||
				!dialog?.isConnected ||
				!isTopModalOwner(dialog)
			) return;
			let target: HTMLElement | null = null;
			if (observedPhase === 'choosing' && observedFirstAction) {
				target = dialog.querySelector<HTMLElement>('[data-album-action-choice]');
			} else if (observedPhase === 'resolving') {
				target = dialog.querySelector<HTMLElement>('[data-album-action-cancel]');
			} else if (observedPhase === 'error' || observedPhase === 'outcome-unknown') {
				target = dialog.querySelector<HTMLElement>('[data-album-action-dismiss]');
			}
			(target ?? dialog).focus();
		});
	});
</script>

<svelte:window onkeydown={handleWindowKeydown} />

<div
	bind:this={dialog}
	class="album-action-layer"
	role="dialog"
	aria-modal="true"
	aria-labelledby="album-action-title"
	aria-describedby="album-action-context"
	aria-busy={phase === 'resolving' || phase === 'executing' ? 'true' : undefined}
	data-album-action-phase={phase}
	tabindex="-1"
	use:focusTrap={{ initialFocus: '[data-album-action-initial="true"]', restoreFocus: false }}
>
	{#if canDismiss}
		<button
			type="button"
			class="album-action-backdrop"
			aria-hidden="true"
			tabindex="-1"
			onclick={requestDismiss}
		></button>
	{/if}
	<section class="album-action-chooser">
		<header>
			<span>Roon action</span>
			<strong id="album-action-title">{albumTitle}</strong>
			<p id="album-action-context">Target: {zoneName}</p>
		</header>

		{#if phase === 'resolving'}
			<div class="action-state" role="status" aria-live="polite">
				<span class="activity-mark" aria-hidden="true"></span>
				<strong>Resolving current actions…</strong>
				<p>{message ?? `Checking what Roon currently allows in ${zoneName}.`}</p>
			</div>
			{#if canDismiss}
				<button
					type="button"
					class="secondary-action"
					data-album-action-cancel
					data-album-action-initial="true"
					onclick={requestDismiss}
				>Cancel</button>
			{/if}
		{:else if phase === 'choosing'}
			<div class="action-copy">
				<strong>Choose one current Roon action</strong>
				<p>Dropping the album did not start playback or change the queue.</p>
			</div>
			<div class="action-choice-list" aria-label={`Current actions for ${albumTitle}`}>
				{#each actions as action, index (action.actionId)}
					<button
						type="button"
						class="action-choice"
						data-album-action-choice
						data-album-action-id={action.actionId}
						data-album-action-initial={index === 0 ? 'true' : undefined}
						onclick={() => onExecute(action.actionId)}
					>{action.label}</button>
				{/each}
				{#if actions.length === 0}
					<p role="status">No current actions were returned.</p>
				{/if}
			</div>
			{#if canDismiss}
				<button
					type="button"
					class="secondary-action"
					data-album-action-cancel
					onclick={requestDismiss}
				>Cancel</button>
			{/if}
		{:else if phase === 'executing'}
			<div class="action-state" role="status" aria-live="polite">
				<span class="activity-mark" aria-hidden="true"></span>
				<strong>{executingLabel ? `Sending ${executingLabel}…` : 'Sending action…'}</strong>
				<p>Roon owns this request now. It will not be canceled or retried automatically.</p>
			</div>
		{:else if phase === 'outcome-unknown'}
			<div class="action-state caution" role="alert">
				<strong>Outcome unknown</strong>
				<p>{message ?? `Check ${zoneName} in Roon before taking another action.`}</p>
			</div>
			{#if canDismiss}
				<button
					type="button"
					class="primary-action"
					data-album-action-dismiss
					data-album-action-initial="true"
					onclick={requestDismiss}
				>Close</button>
			{/if}
		{:else}
			<div class="action-state error" role="alert">
				<strong>Action unavailable</strong>
				<p>{message ?? 'Roon could not provide a current action for this album and zone.'}</p>
			</div>
			{#if canDismiss}
				<button
					type="button"
					class="primary-action"
					data-album-action-dismiss
					data-album-action-initial="true"
					onclick={requestDismiss}
				>Close</button>
			{/if}
		{/if}
	</section>
</div>

<style>
	.album-action-layer {
		position: absolute;
		inset: 0;
		z-index: 14;
		display: grid;
		place-items: center;
		padding: 24px;
	}

	.album-action-backdrop {
		position: absolute;
		inset: 0;
		border: 0;
		background: rgb(0 0 0 / 0.58);
		cursor: default;
	}

	.album-action-chooser {
		position: relative;
		z-index: 1;
		display: grid;
		width: min(420px, 100%);
		max-height: min(640px, 100%);
		box-sizing: border-box;
		gap: 14px;
		padding: 18px;
		overflow: hidden;
		border: 1px solid color-mix(in srgb, var(--accent-2) 58%, var(--border));
		border-radius: 16px;
		background: color-mix(in srgb, var(--surface) 98%, transparent);
		box-shadow: 0 22px 64px rgb(0 0 0 / 0.42);
		color: var(--text);
	}

	header,
	.action-copy,
	.action-state {
		display: grid;
		gap: 5px;
	}

	header {
		padding-bottom: 12px;
		border-bottom: 1px solid var(--border);
	}

	header > span {
		color: var(--accent-2);
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.09em;
		text-transform: uppercase;
	}

	header strong {
		overflow: hidden;
		font-size: 18px;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	p {
		margin: 0;
		color: var(--text-soft);
		font-size: 12px;
		line-height: 1.45;
	}

	.action-choice-list {
		display: grid;
		min-height: 0;
		max-height: min(300px, 42vh);
		gap: 7px;
		overflow: auto;
		overscroll-behavior: contain;
		scrollbar-width: thin;
	}

	.action-choice,
	.primary-action,
	.secondary-action {
		border-radius: 10px;
		font: inherit;
		cursor: pointer;
	}

	.action-choice {
		width: 100%;
		padding: 11px 12px;
		border: 1px solid var(--border);
		background: var(--surface-2);
		color: var(--text);
		font-size: 13px;
		font-weight: 650;
		text-align: left;
	}

	.primary-action,
	.secondary-action {
		justify-self: end;
		padding: 9px 14px;
	}

	.primary-action {
		border: 1px solid var(--accent-2);
		background: var(--accent-2);
		color: var(--accent-contrast, #090b10);
	}

	.secondary-action {
		border: 1px solid var(--border);
		background: transparent;
		color: var(--text);
	}

	button:hover,
	button:focus-visible {
		outline: 0;
		border-color: var(--accent-2);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent-2) 20%, transparent);
	}

	.action-state {
		position: relative;
		padding: 12px;
		border: 1px solid var(--border);
		border-radius: 12px;
		background: var(--surface-2);
	}

	.action-state.error,
	.action-state.caution {
		border-color: color-mix(in srgb, #d98b42 64%, var(--border));
	}

	.activity-mark {
		width: 18px;
		height: 18px;
		border: 2px solid color-mix(in srgb, var(--accent-2) 28%, transparent);
		border-top-color: var(--accent-2);
		border-radius: 999px;
		animation: action-spin 900ms linear infinite;
	}

	@keyframes action-spin {
		to {
			rotate: 1turn;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.activity-mark {
			animation: none;
		}
	}
</style>
