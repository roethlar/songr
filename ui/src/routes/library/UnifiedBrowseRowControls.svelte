<script lang="ts">
	import LibraryActionButton from '$lib/components/LibraryActionButton.svelte';
	import type { BrowseItem } from '@shared/types';
	import type { BrowseRowActions } from '$lib/library/browsePresentation';

	let { item, actions, ready = true, playable = true, favorite = false, prominent = false }: {
		item: BrowseItem; actions?: BrowseRowActions; ready?: boolean; playable?: boolean; favorite?: boolean; prominent?: boolean;
	} = $props();
	let surface = $state<HTMLElement | null>(null);
	let moreButton = $state<HTMLButtonElement | null>(null);
	const menu = $derived(actions?.menu?.item === item ? actions.menu : undefined);
	const disabled = $derived(!ready || !actions?.enabled || actions.busy);
	const menuBusy = $derived(menu?.state.phase === 'loading' || menu?.state.phase === 'executing');

	$effect(() => {
		if (!menu || !surface) return;
		const close = (event: PointerEvent | KeyboardEvent) => {
			if (event instanceof KeyboardEvent) {
				if (event.key !== 'Escape') return;
				event.preventDefault();
				actions?.onCloseMore();
				moreButton?.focus();
			} else if (!(event.target instanceof Node) || !surface?.contains(event.target)) actions?.onCloseMore();
		};
		window.addEventListener('pointerdown', close);
		window.addEventListener('keydown', close, true);
		return () => {
			window.removeEventListener('pointerdown', close);
			window.removeEventListener('keydown', close, true);
		};
	});
</script>

<div class="row-controls" class:prominent bind:this={surface}>
	{#if playable}
		<LibraryActionButton icon="play" label="Play" {disabled} onclick={() => actions?.onAction(item, 'play-now')} />
		<LibraryActionButton icon="queue" label="Queue" {disabled} onclick={() => actions?.onAction(item, 'queue')} />
	{/if}
	<LibraryActionButton icon="more" label="More" bind:element={moreButton} aria-label="More actions for {item.title}"
		aria-haspopup="menu" aria-expanded={Boolean(menu)} disabled={!menu && disabled}
		onclick={() => { moreButton?.focus(); if (menu) actions?.onCloseMore(); else actions?.onMore(item); }} />
	{#if menu}
		<div class="row-menu" role="menu" aria-label="Actions for {item.title}">
			{#if menuBusy}<span role="status">{menu.state.phase === 'executing' ? 'Working…' : 'Loading…'}</span>{/if}
			{#if menu.state.error}<span class="error" role="alert">{menu.state.error}</span>{/if}
			{#each menu.state.actions ?? [] as choice}
				<button type="button" role="menuitem" disabled={menuBusy || !actions?.enabled}
					onclick={() => menu?.onChoose(choice)}>{choice.title}</button>
			{/each}
			{#if menu.state.phase === 'ready' && !(menu.state.actions?.length)}<span>No actions are available.</span>{/if}
			{#if favorite && actions?.onFavorite}
				<button type="button" role="menuitem" disabled={menuBusy || !ready}
					onclick={() => { actions?.onCloseMore(); actions?.onFavorite?.(item); }}>Bookmark</button>
			{/if}
		</div>
	{/if}
</div>

<style>
	.row-controls { position: relative; display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
	button { cursor: pointer; }
	button:disabled { cursor: default; color: var(--dim); }
	button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
	.row-menu { position: absolute; right: 0; top: 100%; z-index: 20; display: flex; flex-direction: column;
		max-height: 260px; overflow-y: auto; min-width: 130px; max-width: min(320px, 85vw); padding: 4px; background: var(--control); border: 1px solid var(--line);
		border-radius: 5px; box-shadow: 0 4px 12px var(--songr-scrim); }
	.row-menu button { min-height: var(--library-action-target, 36px); text-align: left; border: 0; background: transparent; color: var(--text); font: inherit; font-size: 12px; padding: 7px 10px; border-radius: 3px; }
	.row-menu button:hover { background: var(--hover-subtle); }
	.row-menu span { padding: 7px 10px; font-size: 12px; color: var(--soft); }
	.row-menu .error { color: var(--songr-error); }
	@media (any-pointer: coarse) { .row-menu button { min-height: 44px; } }
</style>
