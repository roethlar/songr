<script lang="ts">
	import { focusTrap, isTopModalOwner } from '$lib/actions/focusTrap';

	let {
		title,
		description,
		busy = false,
		onConfirm,
		onCancel
	}: {
		title: string;
		description: string;
		busy?: boolean;
		onConfirm: () => void | Promise<void>;
		onCancel: () => void | Promise<void>;
	} = $props();

	let dialog: HTMLElement;

	function stopPointer(event: PointerEvent): void {
		event.stopPropagation();
	}

	function handleWindowKeydown(event: KeyboardEvent): void {
		if (
			event.defaultPrevented ||
			event.key !== 'Escape' ||
			busy ||
			!dialog?.isConnected ||
			!isTopModalOwner(dialog)
		) return;
		event.preventDefault();
		event.stopPropagation();
		onCancel();
	}
</script>

<svelte:window onkeydown={handleWindowKeydown} />

<div
	bind:this={dialog}
	class="open-classic-layer"
	role="dialog"
	aria-modal="true"
	aria-labelledby="timeline-open-classic-title"
	aria-describedby="timeline-open-classic-description"
	aria-busy={busy}
	tabindex="-1"
	use:focusTrap={{ initialFocus: '[data-open-classic-cancel]' }}
	onpointerdown={stopPointer}
>
	<button
		type="button"
		class="open-classic-backdrop"
		aria-hidden="true"
		tabindex="-1"
		disabled={busy}
		onclick={onCancel}
	></button>

	<section class="open-classic-dialog">
		<header>
			<span>Classic fallback</span>
			<h2 id="timeline-open-classic-title">Open {title} in Classic?</h2>
		</header>

		<p id="timeline-open-classic-description">
			{description} This changes Library view to Classic. Use your browser’s Back button or
			Controller settings to return to Timeline.
		</p>

		<footer>
			<button
				type="button"
				class="secondary-action"
				data-open-classic-cancel
				disabled={busy}
				onclick={onCancel}
			>
				Cancel
			</button>
			<button type="button" class="primary-action" disabled={busy} onclick={onConfirm}>
				{busy ? 'Opening…' : 'Open in Classic'}
			</button>
		</footer>
	</section>
</div>

<style>
	.open-classic-layer {
		position: absolute;
		inset: 0;
		z-index: 18;
		display: grid;
		place-items: center;
		padding: 24px;
	}

	.open-classic-backdrop {
		position: absolute;
		inset: 0;
		border: 0;
		background: rgb(0 0 0 / 0.58);
		cursor: default;
	}

	.open-classic-dialog {
		position: relative;
		z-index: 1;
		display: grid;
		width: min(440px, 100%);
		box-sizing: border-box;
		gap: 16px;
		padding: 20px;
		border: 1px solid color-mix(in srgb, var(--accent-2) 58%, var(--border));
		border-radius: 16px;
		background: color-mix(in srgb, var(--surface) 98%, transparent);
		box-shadow: 0 22px 64px rgb(0 0 0 / 0.42);
		color: var(--text);
	}

	header {
		display: grid;
		gap: 6px;
	}

	header > span {
		color: var(--accent-2);
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.09em;
		text-transform: uppercase;
	}

	h2,
	p {
		margin: 0;
	}

	h2 {
		font-size: 20px;
		line-height: 1.2;
	}

	p {
		color: var(--text-soft);
		font-size: 13px;
		line-height: 1.5;
	}

	footer {
		display: flex;
		justify-content: flex-end;
		gap: 10px;
	}

	footer button {
		padding: 8px 12px;
		border: 1px solid var(--border);
		border-radius: 9px;
		color: var(--text);
		font: inherit;
		font-weight: 650;
		cursor: pointer;
	}

	footer button:disabled {
		opacity: 0.62;
		cursor: wait;
	}

	.secondary-action {
		background: var(--surface-2);
	}

	.primary-action {
		border-color: color-mix(in srgb, var(--accent-2) 65%, var(--border));
		background: color-mix(in srgb, var(--accent-2) 22%, var(--surface-2));
	}

	footer button:focus-visible {
		outline: 2px solid var(--accent-2);
		outline-offset: 2px;
	}

	@media (max-width: 520px) {
		.open-classic-layer {
			padding: 14px;
		}

		footer {
			align-items: stretch;
			flex-direction: column-reverse;
		}
	}
</style>
