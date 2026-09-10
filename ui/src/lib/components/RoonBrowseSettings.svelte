<script lang="ts">
	import { onDestroy } from 'svelte';
	import type { BrowseItem } from '@shared/types';
	import { CLASSIC_BROWSE_ERROR_MAX_LENGTH } from '@shared/classicBrowseContracts';
	import { createRoonSettingsController, type RoonSettingsController } from '$lib/library/RoonSettingsController';

	let { open, connected, zoneId, coreId, embedded = false, controller = createRoonSettingsController() }: {
		open: boolean;
		embedded?: boolean;
		connected: boolean;
		zoneId?: string;
		coreId?: string;
		controller?: RoonSettingsController;
	} = $props();
	const view = $derived($controller);
	const busy = $derived(view.phase === 'loading');
	let promptItem = $state<BrowseItem | null>(null);
	let inputValue = $state('');
	let promptTrigger: HTMLButtonElement | null = null;
	function focusInput(node: HTMLInputElement): void { node.focus(); }
	function cancelPrompt(): void { promptItem = null; inputValue = ''; promptTrigger?.focus(); }
	const canLoadMore = $derived(view.result !== null &&
		view.result.items.length < (view.result.totalCount ?? view.result.count));

	$effect(() => {
		void controller.setActive(open && connected, zoneId, coreId);
		promptItem = null;
		inputValue = '';
	});
	onDestroy(() => controller.close());

	function activate(item: BrowseItem, trigger: HTMLButtonElement): void {
		if (busy) return;
		if (item.inputPrompt) {
			promptTrigger = trigger;
			promptItem = item;
			inputValue = item.inputPromptValue ?? '';
		} else {
			promptItem = null;
			inputValue = '';
			void controller.activate(item);
		}
	}
	function submit(event: SubmitEvent): void {
		event.preventDefault();
		const item = promptItem;
		if (!item || busy) return;
		const value = inputValue;
		promptItem = null;
		inputValue = '';
		void controller.activate(item, value);
	}
</script>

{#if open}
	<section class="roon-settings" class:embedded aria-label={embedded ? 'Roon options' : undefined} aria-labelledby={embedded ? undefined : 'roon-settings-heading'} data-testid="roon-browse-settings">
		{#if !embedded}<h3 id="roon-settings-heading">Roon Settings</h3>{/if}
		{#if !connected}
			<p class="status">Connect to a Roon Core to see its settings.</p>
		{:else}
			{#if view.result}
				<div class="path">
					<button type="button" disabled={busy || view.result.level <= 0}
						onclick={() => { promptItem = null; inputValue = ''; void controller.back(); }}>Back</button>
					<span>{view.result.title ?? 'Settings'}</span>
				</div>
				{#if view.result.subtitle}<p class="status">{view.result.subtitle}</p>{/if}
			{/if}
			{#if view.error}<p class="error" role="alert">{view.error}</p>{/if}
			{#if view.message}<p class="status" role="status">{view.message}</p>{/if}
			{#if busy}<p class="status" role="status">Loading Roon Settings…</p>{/if}
			{#if view.result}
				{#if view.result.items.length === 0 && !busy && !view.message && !view.error}
					<p class="status">Roon returned no settings here.</p>
				{/if}
				<div class="rows">
					{#each view.result.items as item, index (`${index}:${item.itemKey ?? item.title}`)}
						{#if item.hint === 'header' || !item.itemKey}
							<p class="row-label">{item.title}{#if item.subtitle}<small>{item.subtitle}</small>{/if}</p>
						{:else}
							<button type="button" class="row" disabled={busy || view.phase === 'error'} onclick={(event) => activate(item, event.currentTarget)}>
								<span>{item.title}{#if item.subtitle}<small>{item.subtitle}</small>{/if}</span>
								{#if item.hint === 'list' || item.hint === 'action_list'}<span aria-hidden="true">›</span>{/if}
							</button>
						{/if}
					{/each}
				</div>
			{/if}
			{#if promptItem}
				<form onsubmit={submit} class="prompt">
					<label for="roon-setting-input">{promptItem.inputPrompt}</label>
					<input use:focusInput id="roon-setting-input" type={promptItem.inputPromptIsPassword ? 'password' : 'text'}
						bind:value={inputValue} maxlength={CLASSIC_BROWSE_ERROR_MAX_LENGTH} autocomplete="off" disabled={busy} />
					<div class="prompt-actions">
						<button type="submit" disabled={busy}>{promptItem.inputPromptAction || 'Apply'}</button>
						<button type="button" onclick={cancelPrompt}>Cancel</button>
					</div>
				</form>
			{/if}
			{#if canLoadMore}<button type="button" disabled={busy} onclick={() => void controller.loadMore()}>Load more</button>{/if}
			{#if view.error}<button type="button" disabled={busy} onclick={() => void controller.retry()}>Reload Roon Settings</button>{/if}
		{/if}
	</section>
{/if}

<style>
	.roon-settings { display: grid; gap: 8px; padding: 1rem 0; border-top: 1px solid var(--songr-line); color: var(--songr-text); }
	.roon-settings.embedded { padding: 0; border-top: 0; }
	h3 { margin: 0; font-size: 0.95rem; font-weight: 600; }
	.path { display: flex; align-items: center; gap: 10px; min-width: 0; }
	.path span { overflow-wrap: anywhere; }
	button, input { font: inherit; }
	button { min-height: 36px; padding: 6px 10px; border: 1px solid var(--songr-line); border-radius: 5px; background: var(--songr-panel); color: var(--songr-text); cursor: pointer; }
	button:hover:not(:disabled) { background: var(--songr-raise); }
	button:disabled { opacity: 0.4; cursor: default; }
	button:focus-visible, input:focus-visible { outline: 2px solid var(--songr-accent-bright); outline-offset: 2px; }
	.rows { display: grid; }
	.row { display: flex; justify-content: space-between; gap: 8px; width: 100%; text-align: left; border: 0; border-bottom: 1px solid var(--songr-line); border-radius: 0; padding: 9px 0; overflow-wrap: anywhere; }
	.row-label { margin: 0; padding: 9px 0; }
	small { display: block; margin-top: 3px; font-size: 0.78rem; color: var(--songr-soft); }
	.status, .error { margin: 0; font-size: 0.82rem; color: var(--songr-soft); overflow-wrap: anywhere; }
	.error { color: var(--songr-error); }
	.prompt { display: grid; gap: 8px; padding: 10px; border: 1px solid var(--songr-line); border-radius: 6px; }
	.prompt input { width: 100%; min-width: 0; box-sizing: border-box; background: var(--songr-bg); color: var(--songr-text); border: 1px solid var(--songr-line); border-radius: 4px; padding: 7px; }
	.prompt-actions { display: flex; gap: 8px; }
	@media (pointer: coarse) { button { min-height: 44px; } }
</style>
