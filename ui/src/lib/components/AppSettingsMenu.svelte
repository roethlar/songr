<script lang="ts">
	import { tick } from 'svelte';
	import { ROON_EXTENSION_DISPLAY_NAME } from '@shared/types';
	import { focusTrap, isTopModalOwner } from '$lib/actions/focusTrap';
	import { switchCore as switchCoreRequest } from '$lib/api/client';
	import { coreStore } from '$lib/stores/coreStore';
	import { onboardingStatusStore } from '$lib/stores/onboardingStore';
	import { closeSettingsMenu, settingsMenuOpen } from '$lib/stores/settingsMenuStore';
	import { setTheme, themeStore, type ThemeMode } from '$lib/stores/themeStore';
	import {
		requestUnifiedLibraryDensity,
		UNIFIED_LIBRARY_DENSITY_OPTIONS,
		unifiedLibraryPrefsStore,
		type UnifiedLibraryDensity
	} from '$lib/stores/unifiedLibraryPrefsStore';

	let {
		requestDensity = requestUnifiedLibraryDensity,
		switchCoreClient = switchCoreRequest,
		fetchFn = fetch
	}: {
		requestDensity?: typeof requestUnifiedLibraryDensity;
		switchCoreClient?: typeof switchCoreRequest;
		fetchFn?: typeof fetch;
	} = $props();

	type CoreSwitchPhase = 'idle' | 'confirm' | 'requesting' | 'waiting' | 'error' | 'complete';

	let dialogEl = $state<HTMLElement | null>(null);
	let coreSwitchAction = $state<HTMLButtonElement | null>(null);
	let coreSwitchCancel = $state<HTMLButtonElement | null>(null);
	let coreSwitchPhase = $state<CoreSwitchPhase>('idle');
	let coreSwitchError = $state<string | null>(null);
	let coreSwitchSawDisconnect = $state(false);
	const currentCoreLabel = $derived(
		$coreStore.status === 'paired' && $coreStore.core
			? $coreStore.core.displayName
			: $coreStore.status === 'discovering'
				? 'Searching for Core…'
				: 'Disconnected'
	);
	const extensionLabel = $derived(
		$onboardingStatusStore.hostname
			? `${ROON_EXTENSION_DISPLAY_NAME} (${$onboardingStatusStore.hostname})`
			: ROON_EXTENSION_DISPLAY_NAME
	);

	$effect(() => {
		if (coreSwitchPhase !== 'requesting' && coreSwitchPhase !== 'waiting') return;
		if ($coreStore.status !== 'paired') {
			coreSwitchSawDisconnect = true;
			return;
		}
		if (coreSwitchSawDisconnect) {
			coreSwitchPhase = 'complete';
			coreSwitchError = null;
		}
	});

	/** Restore to the Unified bar trigger after every close path. */
	function restoreTriggerFocus(): void {
		document
			.querySelector<HTMLElement>('[aria-label="Open Controller settings"]')
			?.focus();
	}

	function closeSettings(): void {
		closeSettingsMenu();
		restoreTriggerFocus();
	}

	function handleWindowKeydown(event: KeyboardEvent): void {
		if (
			!$settingsMenuOpen ||
			event.key !== 'Escape' ||
			(dialogEl !== null && !isTopModalOwner(dialogEl))
		) {
			return;
		}
		event.preventDefault();
		closeSettings();
	}

	function handleBackdropClick(event: MouseEvent): void {
		if (event.target === event.currentTarget) closeSettings();
	}

	function selectDensity(value: UnifiedLibraryDensity): void {
		requestDensity(value);
	}

	function selectTheme(value: ThemeMode): void {
		setTheme(value);
	}

	function beginCoreSwitch(): void {
		coreSwitchError = null;
		coreSwitchPhase = 'confirm';
		void tick().then(() => coreSwitchCancel?.focus());
	}

	function cancelCoreSwitch(): void {
		coreSwitchError = null;
		coreSwitchPhase = 'idle';
		void tick().then(() => coreSwitchAction?.focus());
	}

	async function confirmCoreSwitch(): Promise<void> {
		if (coreSwitchPhase === 'requesting') return;
		coreSwitchError = null;
		coreSwitchSawDisconnect = $coreStore.status !== 'paired';
		coreSwitchPhase = 'requesting';
		try {
			await switchCoreClient(fetchFn);
			if (coreSwitchPhase === 'requesting') coreSwitchPhase = 'waiting';
		} catch (error) {
			coreSwitchError =
				error instanceof Error && error.message
					? error.message
					: 'Could not start Core discovery.';
			coreSwitchPhase = 'error';
		}
	}
</script>

<svelte:window onkeydown={handleWindowKeydown} />

<!-- Dialog only. The Unified bar opens it through settingsMenuStore. -->
{#if $settingsMenuOpen}
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="settings-backdrop" onclick={handleBackdropClick}>
			<div
				id="controller-settings-dialog"
				class="settings-dialog"
				role="dialog"
				aria-modal="true"
				aria-labelledby="controller-settings-title"
				tabindex="-1"
				bind:this={dialogEl}
				use:focusTrap={{ initialFocus: '.settings-close', restoreFocus: false }}
			>
				<header class="settings-header">
					<div>
						<p class="settings-eyebrow">Application</p>
						<h2 id="controller-settings-title">Controller settings</h2>
					</div>
					<button
						type="button"
						class="settings-close"
						aria-label="Close Controller settings"
						onclick={closeSettings}
					>✕</button>
				</header>

				<div class="settings-content">
					<section class="settings-section" aria-labelledby="settings-appearance-title">
						<div>
							<h3 id="settings-appearance-title">Appearance</h3>
							<p>Choose the Library color theme.</p>
						</div>
						<div class="appearance-buttons" role="group" aria-label="Color theme">
							{#each ['dark', 'light'] as option (option)}
								<button
									type="button"
									class="appearance-button"
									class:selected={$themeStore === option}
									aria-pressed={$themeStore === option}
									onclick={() => selectTheme(option as ThemeMode)}
								>{option === 'dark' ? 'Dark' : 'Light'}</button>
							{/each}
						</div>
					</section>

					<section class="settings-section" aria-labelledby="settings-density-title">
						<div>
							<h3 id="settings-density-title">Density</h3>
							<p>Choose the size of Library rows and controls.</p>
						</div>
						<div class="density-buttons" role="group" aria-label="Library density">
							{#each UNIFIED_LIBRARY_DENSITY_OPTIONS as option (option.id)}
								<button
									type="button"
									class="density-button"
									class:selected={$unifiedLibraryPrefsStore.density === option.id}
									aria-pressed={$unifiedLibraryPrefsStore.density === option.id}
									data-testid="settings-density-{option.id}"
									onclick={() => selectDensity(option.id)}
								>
									{option.label}
								</button>
							{/each}
						</div>
					</section>

					<section class="settings-section" aria-labelledby="settings-core-title">
						<div>
							<h3 id="settings-core-title">Roon Core</h3>
							<dl class="core-current">
								<dt>Current Core</dt>
								<dd data-testid="settings-current-core">{currentCoreLabel}</dd>
							</dl>
						</div>

						{#if coreSwitchPhase === 'confirm'}
							<div class="core-confirm" role="group" aria-label="Confirm Core switch">
								<p>
									Songr will disconnect from <strong>{currentCoreLabel}</strong> immediately.
									Playback continues in Roon, but this controller's transport and Library
									access stop until another Core is authorized.
								</p>
								<div class="core-actions">
									<button
										type="button"
										class="core-secondary"
										bind:this={coreSwitchCancel}
										onclick={cancelCoreSwitch}
									>Cancel</button>
									<button
										type="button"
										class="core-danger"
										onclick={confirmCoreSwitch}
									>Disconnect and find another Core</button>
								</div>
							</div>
						{:else if coreSwitchPhase === 'requesting'}
							<p class="core-status" role="status">Disconnecting from the current Core…</p>
						{:else if coreSwitchPhase === 'waiting'}
							<div class="core-waiting" role="status">
								<p>
									Open Roon and go to <strong>Settings → Extensions</strong>. Find
									<strong>{extensionLabel}</strong> and choose <strong>Enable</strong>.
								</p>
								<p>This panel updates by itself when the new Core connects.</p>
							</div>
						{:else if coreSwitchPhase === 'error'}
							<div class="core-error">
								<p role="alert">{coreSwitchError}</p>
								<div class="core-actions">
									<button type="button" class="core-secondary" onclick={cancelCoreSwitch}
										>Cancel</button>
									<button type="button" class="core-primary" onclick={confirmCoreSwitch}
										>Try again</button>
								</div>
							</div>
						{:else}
							{#if coreSwitchPhase === 'complete'}
								<p class="core-connected" role="status">Connected to {currentCoreLabel}.</p>
							{/if}
							<button
								type="button"
								class="core-switch-action"
								bind:this={coreSwitchAction}
								onclick={beginCoreSwitch}
							>Connect to a different Core</button>
						{/if}
					</section>
				</div>

				<footer class="settings-footer">
					<button type="button" class="settings-done" onclick={closeSettings}>Done</button>
				</footer>
			</div>
		</div>
{/if}

<style>
	/* This layout-level dialog follows the same songr tokens as Unified. */
	.settings-close:focus-visible,
	.appearance-button:focus-visible,
	.density-button:focus-visible,
	.core-switch-action:focus-visible,
	.core-secondary:focus-visible,
	.core-danger:focus-visible,
	.core-primary:focus-visible,
	.settings-done:focus-visible {
		outline: 2px solid var(--songr-accent-bright);
		outline-offset: 2px;
	}

	.settings-backdrop {
		position: fixed;
		inset: 0;
		z-index: 100;
		display: grid;
		place-items: center;
		padding: max(1rem, env(safe-area-inset-top)) max(1rem, env(safe-area-inset-right))
			max(1rem, env(safe-area-inset-bottom)) max(1rem, env(safe-area-inset-left));
		background: var(--songr-scrim);
	}

	.settings-dialog {
		width: min(31rem, 100%);
		max-height: min(44rem, calc(100dvh - 2rem));
		display: flex;
		flex-direction: column;
		overflow: hidden;
		background: var(--songr-panel);
		color: var(--songr-text);
		border: 1px solid var(--songr-line);
		border-radius: 20px;
		box-shadow: 0 22px 52px var(--songr-shadow-soft);
		font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
	}

	.settings-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		padding: 1.15rem 1.2rem 0.9rem;
		border-bottom: 1px solid var(--songr-line);
	}

	.settings-eyebrow {
		margin: 0 0 0.2rem;
		color: var(--songr-soft);
		font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
		font-size: 0.68rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
	}

	.settings-header h2 {
		margin: 0;
		font-size: 1.35rem;
	}

	.settings-close {
		width: 2rem;
		height: 2rem;
		border: 1px solid transparent;
		border-radius: 999px;
		background: transparent;
		color: var(--songr-soft);
		line-height: 1;
	}

	.settings-close:hover {
		background: var(--songr-raise);
		color: var(--songr-text);
	}

	.settings-content {
		display: grid;
		gap: 1.15rem;
		overflow-y: auto;
		padding: 1.1rem 1.2rem 1.2rem;
	}

	.settings-section {
		display: grid;
		gap: 0.85rem;
	}

	.settings-section h3 {
		margin: 0;
		font-size: 1rem;
	}

	.settings-section p {
		margin: 0.25rem 0 0;
		color: var(--songr-soft);
		font-size: 0.85rem;
	}

	.settings-section + .settings-section {
		padding-top: 1.15rem;
		border-top: 1px solid var(--songr-line);
	}

	.appearance-buttons,
	.density-buttons {
		display: flex;
		flex-wrap: wrap;
		gap: 0.55rem;
	}

	.appearance-button,
	.density-button {
		flex: 0 0 7rem;
		width: 7rem;
		height: 2.75rem;
		padding: 0;
		border: 1px solid var(--songr-line);
		border-radius: 8px;
		background: var(--songr-raise);
		color: var(--songr-text);
		font: inherit;
		font-size: 0.86rem;
		font-weight: 650;
	}

	.appearance-button:hover,
	.density-button:hover {
		border-color: var(--songr-accent);
	}

	.appearance-button.selected,
	.density-button.selected {
		border-color: var(--songr-accent-bright);
		background: color-mix(in srgb, var(--songr-accent) 16%, var(--songr-raise));
		color: var(--songr-accent-bright);
	}

	.core-current {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		gap: 0.35rem 0.8rem;
		margin: 0.7rem 0 0;
		font-size: 0.86rem;
	}

	.core-current dt {
		color: var(--songr-soft);
	}

	.core-current dd {
		margin: 0;
		text-align: right;
		overflow-wrap: anywhere;
	}

	.core-confirm,
	.core-waiting,
	.core-error {
		padding: 0.85rem;
		border: 1px solid var(--songr-line);
		border-radius: 8px;
		background: var(--songr-raise);
	}

	.core-confirm p,
	.core-waiting p,
	.core-error p,
	.core-status,
	.core-connected {
		margin: 0;
		color: var(--songr-settings-copy);
		font-size: 0.86rem;
		line-height: 1.45;
	}

	.core-waiting p + p {
		margin-top: 0.55rem;
		color: var(--songr-soft);
	}

	.core-error p {
		color: var(--songr-error-soft);
	}

	.core-connected {
		color: var(--songr-success);
	}

	.core-actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 0.55rem;
		margin-top: 0.8rem;
	}

	.core-switch-action,
	.core-secondary,
	.core-danger,
	.core-primary {
		min-height: 2.4rem;
		padding: 0.45rem 0.75rem;
		border: 1px solid var(--songr-line-16);
		border-radius: 8px;
		background: var(--songr-raise);
		color: var(--songr-text);
		font: inherit;
		font-size: 0.82rem;
		font-weight: 650;
	}

	.core-switch-action,
	.core-primary {
		justify-self: start;
		border-color: var(--songr-accent);
		color: var(--songr-accent-bright);
	}

	.core-danger {
		border-color: var(--songr-error-border);
		color: var(--songr-error-soft);
	}

	.settings-footer {
		display: flex;
		justify-content: flex-end;
		padding: 0.85rem 1.2rem 1rem;
		border-top: 1px solid var(--songr-line);
	}

	.settings-done {
		padding: 0.5rem 1rem;
		border: 1px solid var(--songr-accent);
		border-radius: 8px;
		background: var(--songr-accent);
		color: var(--songr-on-accent);
		font-weight: 700;
	}

	@media (max-width: 34rem) {
		.settings-backdrop {
			align-items: end;
			padding: 0;
		}

		.settings-dialog {
			width: 100%;
			max-height: calc(100dvh - max(0.75rem, env(safe-area-inset-top)));
			border-radius: 20px 20px 0 0;
			padding-bottom: env(safe-area-inset-bottom);
		}
	}
</style>
