<script lang="ts">
	import { tick } from 'svelte';
	import { ROON_EXTENSION_DISPLAY_NAME } from '@shared/types';
	import { focusTrap, isTopModalOwner } from '$lib/actions/focusTrap';
	import { switchCore as switchCoreRequest } from '$lib/api/client';
	import { openAdvancedSettings } from '$lib/desktopShell';
	import { coreStore } from '$lib/stores/coreStore';
	import { selectedZoneStore } from '$lib/stores/selectedZoneStore';
	import { socketStatusStore } from '$lib/stores/socketStatusStore';
	import RoonBrowseSettings from './RoonBrowseSettings.svelte';
	import { onboardingStatusStore } from '$lib/stores/onboardingStore';
	import { closeSettingsMenu, settingsMenuOpen } from '$lib/stores/settingsMenuStore';
	import { navigationSettingsStore, type NavigationSettingsStore } from '$lib/stores/navigationSettingsStore';
	import { getNavigationDestinationLabel, type NavigationDestinationId } from '@shared/navigationSettings';
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
		fetchFn = fetch,
		resolveAdvancedSettings = openAdvancedSettings,
		navigationStore = navigationSettingsStore
	}: {
		requestDensity?: typeof requestUnifiedLibraryDensity;
		switchCoreClient?: typeof switchCoreRequest;
		fetchFn?: typeof fetch;
		/** Injected so tests can mount both the shell and the browser case. */
		resolveAdvancedSettings?: typeof openAdvancedSettings;
		navigationStore?: NavigationSettingsStore;
	} = $props();

	// Null in a browser tab. The desktop shell is the only place these settings
	// exist, and until now the tray was the only way to reach them — so on any
	// desktop without a tray, network serving could not be turned on at all.
	const advancedSettings = $derived(resolveAdvancedSettings());
	const navigation = $derived($navigationStore);
	const navigationPages = $derived([
		...(navigation.snapshot?.order ?? []),
		...navigation.availableDestinations.filter(id => !navigation.snapshot?.order.includes(id))
	].filter(id => navigation.availableDestinations.includes(id)));
	const navigationSummary = $derived(navigation.snapshot === null
		? 'Choose your main pages'
		: navigationPages.filter(id => navigation.snapshot?.pinned.includes(id))
			.map(getNavigationDestinationLabel).join(' · ') || 'All pages in More');
	let navigationExpanded = $state(false);
	let roonOptionsExpanded = $state(false);

	$effect(() => {
		if (!$settingsMenuOpen) {
			navigationExpanded = false;
			roonOptionsExpanded = false;
		}
	});
	const navigationBusy = $derived(navigation.loading || navigation.saving || navigation.snapshot === null);

	$effect(() => {
		if ($settingsMenuOpen && navigation.snapshot === null && !navigation.loading && !navigation.error) {
			void navigationStore.load(fetchFn);
		}
	});

	function pinNavigation(event: Event, id: NavigationDestinationId): void {
		const input = event.currentTarget as HTMLInputElement;
		const pinned = input.checked;
		// The browser toggles a checkbox before its change event. Restore the
		// confirmed state while saving; a failed write must never look saved.
		input.checked = navigation.snapshot?.pinned.includes(id) ?? false;
		void navigationStore.setPinned(id, pinned, fetchFn);
	}


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
							<p class="settings-scope">This device</p>
						</div>
						<div class="settings-field">
							<h4>Theme</h4>
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
						</div>
						<div class="settings-field">
							<h4>Row size</h4>
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
						</div>
					</section>

					<section class="settings-section" aria-labelledby="settings-navigation-title" aria-busy={navigation.loading || navigation.saving}>
						<div>
							<h3 id="settings-navigation-title">
								<button type="button" class="settings-disclosure" aria-label="Library navigation"
									aria-expanded={navigationExpanded} aria-controls="settings-navigation-editor"
									onclick={() => { navigationExpanded = !navigationExpanded; }}>
									<span>Library navigation</span><span class="disclosure-chevron" class:expanded={navigationExpanded} aria-hidden="true">›</span>
								</button>
							</h3>
							<p class="navigation-summary" title={navigationSummary} data-testid="settings-navigation-summary">{navigationSummary}</p>
						</div>
						{#if navigation.loading}
							<p class="navigation-status" role="status">Loading navigation settings…</p>
						{:else if navigation.saving}
							<p class="navigation-status" role="status">Saving navigation settings…</p>
						{/if}
						{#if navigation.error}
							<p class="navigation-error" role="alert">{navigation.error}</p>
							{#if navigation.snapshot === null}
								<button type="button" class="core-secondary" disabled={navigation.loading} onclick={() => void navigationStore.load(fetchFn)}>Retry navigation settings</button>
							{/if}
						{/if}
						{#if navigation.notice}<p class="navigation-status" role="status">{navigation.notice}</p>{/if}
						{#if navigationExpanded}
							<div id="settings-navigation-editor" class="settings-editor">
								<p>Choose and order the main pages for all clients connected to this server. Screen width only changes which pages fit before More.</p>
								{#if navigation.snapshot !== null}
									<div class="navigation-options">
										{#each navigationPages as id, index (id)}
											<div class="navigation-option">
												<label><input type="checkbox" checked={navigation.snapshot.pinned.includes(id)} disabled={navigationBusy}
													data-testid="settings-navigation-pin-{id}" onchange={(event) => pinNavigation(event, id)} />{getNavigationDestinationLabel(id)}</label>
												<button type="button" class="navigation-move" aria-label="Move {getNavigationDestinationLabel(id)} earlier"
													disabled={navigationBusy || index === 0} onclick={() => void navigationStore.move(id, 'earlier', fetchFn)}>↑</button>
												<button type="button" class="navigation-move" aria-label="Move {getNavigationDestinationLabel(id)} later"
													disabled={navigationBusy || index === navigationPages.length - 1} onclick={() => void navigationStore.move(id, 'later', fetchFn)}>↓</button>
											</div>
										{/each}
									</div>
									<div><button type="button" class="core-secondary" disabled={navigationBusy} onclick={() => void navigationStore.resetDefaults(fetchFn)}>Reset navigation defaults</button></div>
								{/if}
							</div>
						{/if}
					</section>
					<section class="settings-section" aria-labelledby="settings-core-title">
						<div>
							<h3 id="settings-core-title">Roon</h3>
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
						<div class="roon-options">
							<h4>
								<button type="button" class="settings-disclosure" aria-label="Roon options"
									aria-expanded={roonOptionsExpanded} aria-controls="settings-roon-options"
									onclick={() => { roonOptionsExpanded = !roonOptionsExpanded; }}>
									<span>Roon options</span><span class="disclosure-chevron" class:expanded={roonOptionsExpanded} aria-hidden="true">›</span>
								</button>
							</h4>
							{#if roonOptionsExpanded}
								<div id="settings-roon-options">
									<RoonBrowseSettings open={$settingsMenuOpen} embedded
										connected={$socketStatusStore === 'connected' && $coreStore.status === 'paired'}
										zoneId={$selectedZoneStore || undefined} coreId={$coreStore.core?.id} />
								</div>
							{/if}
						</div>
					</section>
					{#if advancedSettings}
						<section class="settings-section" aria-labelledby="settings-advanced-title">
							<div>
								<h3 id="settings-advanced-title">Server &amp; sharing</h3>
								<p>
									Share this library with phones and other computers on your
									network, or point the app at another Songr server.
								</p>
							</div>
							<button
								type="button"
								class="core-switch-action"
								data-testid="settings-open-advanced"
								onclick={() => advancedSettings?.()}
							>
								Open server &amp; sharing settings
							</button>
						</section>
					{/if}
				</div>

				<footer class="settings-footer">
					<button type="button" class="settings-done" onclick={closeSettings}>Done</button>
				</footer>
			</div>
		</div>
{/if}

<style>
	/* This layout-level dialog follows the same songr tokens as Unified. */
	.navigation-options { display: grid; }
	.navigation-option { display: flex; align-items: center; gap: 4px; }
	.navigation-option label { display: flex; align-items: center; flex: 1; min-width: 0; min-height: 40px; gap: 10px; overflow-wrap: anywhere; font-size: 0.85rem; color: var(--songr-soft); cursor: pointer; }
	.navigation-option input { width: 16px; height: 16px; margin: 0; flex: none; accent-color: var(--songr-accent); }
	.navigation-move { width: 36px; min-height: 40px; padding: 0; border: 0; border-radius: 5px; background: transparent; color: var(--songr-soft); font-size: 16px; cursor: pointer; }
	.navigation-move:hover:not(:disabled) { background: var(--songr-raise); color: var(--songr-text); }
	.navigation-move:disabled { opacity: 0.3; cursor: default; }
	.navigation-option input:focus-visible, .navigation-move:focus-visible { outline: 2px solid var(--songr-accent-bright); outline-offset: 2px; }
	.navigation-error { color: var(--songr-error); }
	@media (pointer: coarse) {
		.navigation-option label, .navigation-move { min-height: 44px; }
		.navigation-move { width: 44px; }
	}

	.settings-disclosure:focus-visible,
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
		min-width: 0;
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

	.navigation-summary {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.settings-field,
	.settings-editor {
		display: grid;
		gap: 0.6rem;
	}

	.settings-section h4 {
		margin: 0;
		font-size: 0.85rem;
		font-weight: 600;
	}

	.settings-disclosure {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		width: 100%;
		min-height: 2.25rem;
		padding: 0;
		border: 0;
		background: transparent;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}

	.disclosure-chevron {
		color: var(--songr-soft);
		font-size: 1.35rem;
		line-height: 1;
	}

	.disclosure-chevron.expanded {
		transform: rotate(90deg);
	}

	.roon-options {
		display: grid;
		gap: 0.4rem;
	}

	.settings-section .settings-scope {
		font-size: 0.76rem;
	}

	@media (pointer: coarse) {
		.settings-disclosure { min-height: 44px; }
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

	.density-buttons {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		width: min(100%, 22.1rem);
	}

	.density-button {
		width: 100%;
		min-width: 0;
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
