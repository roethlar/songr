<script lang="ts">
	import { focusTrap, isTopModalOwner } from '$lib/actions/focusTrap';

	let {
		title,
		left,
		top,
		canOpen = true,
		openHint = 'Enter',
		floating = false,
		showWorkspaceControls = true,
		canMoveBefore = false,
		canMoveAfter = false,
		canAttachArtistBranch = true,
		zones = [],
		onOpen,
		onOpenInClassic,
		onAttachArtistBranch,
		onFloat,
		onReturn,
		onMoveBefore,
		onMoveAfter,
		onSendToZone,
		onDismiss
	}: {
		title: string;
		left: number;
		top: number;
		canOpen?: boolean;
		openHint?: string;
		floating?: boolean;
		showWorkspaceControls?: boolean;
		canMoveBefore?: boolean;
		canMoveAfter?: boolean;
		canAttachArtistBranch?: boolean;
		zones?: readonly { id: string; name: string; enabled: boolean }[];
		onOpen: () => void;
		onOpenInClassic?: () => void;
		onAttachArtistBranch?: () => void;
		onFloat: () => void;
		onReturn: () => void;
		onMoveBefore: () => void;
		onMoveAfter: () => void;
		onSendToZone?: (zoneId: string) => void;
		onDismiss: () => void;
	} = $props();
	let dialog: HTMLElement;

	function handleWindowKeydown(event: KeyboardEvent): void {
		if (
			event.defaultPrevented ||
			event.key !== 'Escape' ||
			!dialog?.isConnected ||
			!isTopModalOwner(dialog)
		) return;
		event.preventDefault();
		event.stopPropagation();
		onDismiss();
	}

	function handleMenuKeydown(event: KeyboardEvent): void {
		if (!(event.currentTarget instanceof HTMLElement)) return;
		const items = Array.from(
			event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])')
		);
		if (items.length === 0) return;
		const activeIndex = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement));
		let nextIndex: number | null = null;
		if (event.key === 'ArrowDown') nextIndex = (activeIndex + 1) % items.length;
		else if (event.key === 'ArrowUp') nextIndex = (activeIndex - 1 + items.length) % items.length;
		else if (event.key === 'Home') nextIndex = 0;
		else if (event.key === 'End') nextIndex = items.length - 1;
		if (nextIndex === null) return;
		event.preventDefault();
		items[nextIndex].focus();
	}

	function activateDetail(): void {
		onOpen();
		onDismiss();
	}

	function activateWorkspace(command: () => void): void {
		command();
		onDismiss();
	}

	function activateZone(zone: { id: string; enabled: boolean }): void {
		// The parent owns the modal-to-chooser transition and deliberately decides
		// when focus returns. Do not dismiss independently here.
		if (!zone.enabled || !onSendToZone) return;
		onSendToZone(zone.id);
	}
</script>

<svelte:window onkeydown={handleWindowKeydown} />

<div
	bind:this={dialog}
	class="action-menu-layer"
	role="dialog"
	aria-modal="true"
	aria-label={`Album actions for ${title}`}
	tabindex="-1"
	use:focusTrap={{ initialFocus: '[role="menuitem"]:not([disabled])', restoreFocus: false }}
>
	<button
		type="button"
		class="action-menu-dismiss"
		aria-hidden="true"
		tabindex="-1"
		onclick={onDismiss}
	></button>
	<div
		class="album-actions-menu"
		style:left={`${left}px`}
		style:top={`${top}px`}
		style:max-height={`calc(100% - ${top + 16}px)`}
		role="menu"
		aria-label={`${title} actions`}
		tabindex="-1"
		onkeydown={handleMenuKeydown}
	>
		<header role="presentation">
			<strong>{title}</strong>
			<kbd>Shift+F10</kbd>
		</header>
		<button
			type="button"
			role="menuitem"
			disabled={!canOpen}
			onclick={activateDetail}
		>
			<span>Open album detail</span>
			<kbd>{openHint}</kbd>
		</button>
		{#if onAttachArtistBranch}
			<button
				type="button"
				role="menuitem"
				disabled={!canAttachArtistBranch}
				onclick={() => activateWorkspace(onAttachArtistBranch)}
			>
				<span>Attach artist branch…</span>
				<kbd>Artist search</kbd>
			</button>
		{/if}
		{#if showWorkspaceControls}
			{#if floating}
				<button type="button" role="menuitem" onclick={() => activateWorkspace(onReturn)}>
					<span>Return to timeline</span>
					<kbd>Canonical anchor</kbd>
				</button>
			{:else}
				<button type="button" role="menuitem" onclick={() => activateWorkspace(onFloat)}>
					<span>Float from timeline</span>
					<kbd>This tab</kbd>
				</button>
			{/if}
			<button
				type="button"
				role="menuitem"
				disabled={!canMoveBefore}
				onclick={() => activateWorkspace(onMoveBefore)}
			>
				<span>Move before</span>
				<kbd>Visual only</kbd>
			</button>
			<button
				type="button"
				role="menuitem"
				disabled={!canMoveAfter}
				onclick={() => activateWorkspace(onMoveAfter)}
			>
				<span>Move after</span>
				<kbd>Visual only</kbd>
			</button>
		{/if}
		{#if onOpenInClassic}
			<button
				type="button"
				role="menuitem"
				onclick={() => activateWorkspace(onOpenInClassic)}
			>
				<span>Open album in Classic</span>
				<kbd>Switch view</kbd>
			</button>
		{/if}
		{#if zones.length > 0}
			<section class="zone-actions" aria-label="Send to named zone">
				<div class="zone-actions-heading" role="presentation">
					<strong>Send to named zone</strong>
					<small>Choose actions next</small>
				</div>
				<div class="zone-action-list" role="presentation">
					{#each zones as zone (zone.id)}
						<button
							type="button"
							role="menuitem"
							disabled={!zone.enabled || onSendToZone === undefined}
							onclick={() => activateZone(zone)}
						>
							<span>Send to {zone.name}</span>
							<kbd>{zone.enabled ? 'Choose action' : 'Unavailable'}</kbd>
						</button>
					{/each}
				</div>
			</section>
		{/if}
	</div>
</div>

<style>
	.action-menu-layer {
		position: absolute;
		inset: 0;
		z-index: 12;
		pointer-events: none;
	}

	.action-menu-dismiss {
		position: absolute;
		inset: 0;
		border: 0;
		background: transparent;
		pointer-events: auto;
		cursor: default;
	}

	.album-actions-menu {
		position: absolute;
		display: grid;
		width: min(300px, calc(100% - 32px));
		overflow: hidden;
		border: 1px solid color-mix(in srgb, var(--accent-2) 58%, var(--border));
		border-radius: 12px;
		background: color-mix(in srgb, var(--surface) 98%, transparent);
		box-shadow: 0 18px 48px rgb(0 0 0 / 0.38);
		pointer-events: auto;
		z-index: 1;
	}

	.zone-actions {
		display: grid;
		min-height: 0;
		border-top: 1px solid var(--border);
	}

	.zone-actions-heading {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
		padding: 9px 12px 7px;
	}

	.zone-actions-heading strong {
		font-size: 10px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}

	.zone-actions-heading small {
		color: var(--text-soft);
		font-size: 9px;
	}

	.zone-action-list {
		display: grid;
		max-height: min(184px, 32vh);
		overflow: auto;
		overscroll-behavior: contain;
		scrollbar-width: thin;
	}

	header,
	button {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
	}

	header {
		padding: 11px 12px;
		border-bottom: 1px solid var(--border);
	}

	header strong {
		overflow: hidden;
		font-size: 12px;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	kbd {
		color: var(--text-soft);
		font: inherit;
		font-size: 9px;
		white-space: nowrap;
	}

	button {
		width: 100%;
		padding: 10px 12px;
		border: 0;
		background: transparent;
		color: var(--text);
		font: inherit;
		font-size: 12px;
		text-align: left;
		cursor: pointer;
	}

	button:hover,
	button:focus-visible {
		outline: 0;
		background: var(--surface-2);
	}

	button:disabled {
		opacity: 0.46;
		cursor: default;
	}
</style>
