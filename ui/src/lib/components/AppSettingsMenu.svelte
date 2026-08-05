<script lang="ts">
	import { focusTrap, isTopModalOwner } from '$lib/actions/focusTrap';
	import type { LibraryView } from '$lib/stores/libraryViewStore';
	import type { ThemeMode } from '$lib/stores/themeStore';

	let {
		showTrigger = true,
		availableViews,
		currentView,
		onLibraryViewChange,
		theme,
		onThemeChange,
		connectionLabel,
		connectionGood = false,
		coreName = null,
		coreVersion = null,
		buildRevision
	}: {
		showTrigger?: boolean;
		availableViews: readonly LibraryView[];
		currentView: LibraryView | null;
		onLibraryViewChange: (view: LibraryView) => void;
		theme: ThemeMode;
		onThemeChange: (theme: ThemeMode) => void;
		connectionLabel: string;
		connectionGood?: boolean;
		coreName?: string | null;
		coreVersion?: string | null;
		buildRevision: string;
	} = $props();

	let open = $state(false);
	let dialogEl = $state<HTMLElement | null>(null);

	function libraryViewLabel(view: LibraryView | null): string {
		if (view === null) return 'No active view';
		if (view === 'timeline') return 'Timeline canvas';
		if (view === 'unified') return 'Unified library';
		return 'Classic';
	}

	function openSettings(): void {
		open = true;
	}

	function closeSettings(): void {
		open = false;
	}

	function requestLibraryView(event: MouseEvent, view: LibraryView): void {
		// A radio's native click would otherwise display the requested target
		// immediately. The host owns activation, so keep the checked state tied
		// to currentView until the parent confirms the switch through props.
		event.preventDefault();
		const requestedRadio = event.currentTarget as HTMLInputElement;
		const group = requestedRadio.closest('fieldset');
		for (const radio of group?.querySelectorAll<HTMLInputElement>('input[type="radio"]') ?? []) {
			radio.checked = radio.value === currentView;
		}
		if (view !== currentView) onLibraryViewChange(view);
	}

	function handleWindowKeydown(event: KeyboardEvent): void {
		if (
			!open ||
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
</script>

<svelte:window onkeydown={handleWindowKeydown} />

<div class="settings-root floating">
	{#if showTrigger}
		<button
			type="button"
			class="settings-trigger"
			aria-label="Open Controller settings"
			aria-haspopup="dialog"
			aria-expanded={open}
			aria-controls="controller-settings-dialog"
			title="Controller settings"
			onclick={openSettings}
		>
			<span aria-hidden="true">⚙</span>
		</button>
	{/if}

	{#if open}
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
				use:focusTrap={{ initialFocus: '.settings-close' }}
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

				<div class="settings-body">
					<section class="settings-section" aria-labelledby="library-view-heading">
						<fieldset>
							<legend id="library-view-heading">Library view</legend>
							<p class="current-view" aria-live="polite">
								Current view: <strong>{libraryViewLabel(currentView)}</strong>
							</p>
							<div class="choice-list">
								{#each availableViews as view (view)}
									<label class="choice-row">
										<input
											type="radio"
											name="controller-library-view"
											value={view}
											checked={currentView === view}
											onclick={(event) => requestLibraryView(event, view)}
										/>
										<span>
											<strong>{libraryViewLabel(view)}</strong>
											<small>
												{view === 'timeline'
													? 'Explore albums on a spatial chronology.'
													: 'Browse the complete Roon library.'}
											</small>
										</span>
									</label>
								{/each}
								{#if availableViews.length === 0}
									<p class="empty-choice">No Library views are available.</p>
								{/if}
							</div>
						</fieldset>
					</section>

					<section class="settings-section" aria-labelledby="appearance-heading">
						<fieldset>
							<legend id="appearance-heading">Appearance</legend>
							<div class="choice-list compact">
								{#each ['dark', 'light'] as option (option)}
									{@const themeOption = option as ThemeMode}
									<label class="choice-row compact">
										<input
											type="radio"
											name="controller-theme"
											value={themeOption}
											checked={theme === themeOption}
											onchange={() => onThemeChange(themeOption)}
										/>
										<span>{themeOption === 'dark' ? 'Dark' : 'Light'}</span>
									</label>
								{/each}
							</div>
						</fieldset>
					</section>

					<section class="settings-section system" aria-labelledby="system-heading">
						<h3 id="system-heading">System</h3>
						<dl>
							<div>
								<dt>Connection</dt>
								<dd class:good={connectionGood}>{connectionLabel}</dd>
							</div>
							<div>
								<dt>Roon Core</dt>
								<dd>{coreName ?? '—'}</dd>
							</div>
							<div>
								<dt>Core version</dt>
								<dd>{coreVersion ?? '—'}</dd>
							</div>
							<div>
								<dt>UI build</dt>
								<dd class="revision">{buildRevision}</dd>
							</div>
						</dl>
					</section>
				</div>

				<footer class="settings-footer">
					<button type="button" class="settings-done" onclick={closeSettings}>Done</button>
				</footer>
			</div>
		</div>
	{/if}
</div>

<style>
	.settings-root {
		display: inline-flex;
	}

	.settings-trigger {
		display: inline-grid;
		width: 2.35rem;
		height: 2.35rem;
		place-items: center;
		border: 1px solid var(--border);
		border-radius: 999px;
		background: var(--surface-2);
		color: var(--text-soft);
		font-size: 1.05rem;
		line-height: 1;
		box-shadow: var(--shadow-soft);
	}

	.floating .settings-trigger {
		position: fixed;
		top: max(1rem, env(safe-area-inset-top));
		right: max(1rem, env(safe-area-inset-right));
		z-index: 45;
		background: color-mix(in srgb, var(--surface) 92%, transparent);
	}

	.settings-trigger:hover {
		color: var(--text);
		border-color: var(--accent-2);
	}

	.settings-trigger:focus-visible,
	.settings-close:focus-visible,
	.settings-done:focus-visible,
	.choice-row:has(input:focus-visible) {
		outline: 2px solid var(--accent-2);
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
		background: rgba(4, 6, 12, 0.7);
	}

	.settings-dialog {
		width: min(31rem, 100%);
		max-height: min(44rem, calc(100dvh - 2rem));
		display: flex;
		flex-direction: column;
		overflow: hidden;
		background: var(--surface);
		color: var(--text);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-strong);
	}

	.settings-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		padding: 1.15rem 1.2rem 0.9rem;
		border-bottom: 1px solid var(--border);
	}

	.settings-eyebrow {
		margin: 0 0 0.2rem;
		color: var(--text-soft);
		font-family: var(--font-display);
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
		color: var(--text-soft);
		line-height: 1;
	}

	.settings-close:hover {
		background: var(--surface-2);
		color: var(--text);
	}

	.settings-body {
		overflow-y: auto;
		padding: 0 1.2rem;
	}

	.settings-section {
		padding: 1rem 0;
		border-bottom: 1px solid var(--border);
	}

	.settings-section:last-child {
		border-bottom: none;
	}

	fieldset {
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}

	legend,
	.settings-section h3 {
		margin: 0;
		padding: 0;
		font-size: 0.92rem;
		font-weight: 700;
	}

	.current-view {
		margin: 0.35rem 0 0.75rem;
		color: var(--text-soft);
		font-size: 0.82rem;
	}

	.current-view strong {
		color: var(--text);
	}

	.choice-list {
		display: grid;
		gap: 0.5rem;
	}

	.choice-list.compact {
		grid-template-columns: repeat(2, minmax(0, 1fr));
		margin-top: 0.65rem;
	}

	.choice-row {
		display: flex;
		align-items: flex-start;
		gap: 0.7rem;
		padding: 0.75rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface-2);
		cursor: pointer;
	}

	.choice-row:has(input:checked) {
		border-color: var(--accent-2);
		background: color-mix(in srgb, var(--accent) 16%, var(--surface-2));
	}

	.choice-row.compact {
		align-items: center;
		padding: 0.65rem 0.75rem;
	}

	.choice-row input {
		flex: 0 0 auto;
		margin: 0.15rem 0 0;
		accent-color: var(--accent);
	}

	.choice-row span {
		display: grid;
		gap: 0.18rem;
	}

	.choice-row strong {
		font-size: 0.88rem;
	}

	.choice-row small {
		color: var(--text-soft);
		font-size: 0.75rem;
		line-height: 1.35;
	}

	.empty-choice {
		margin: 0;
		padding: 0.7rem;
		color: var(--text-soft);
		font-size: 0.82rem;
	}

	.system h3 {
		margin-bottom: 0.65rem;
	}

	dl {
		display: grid;
		gap: 0.45rem;
		margin: 0;
	}

	dl div {
		display: grid;
		grid-template-columns: minmax(7rem, 0.7fr) minmax(0, 1fr);
		gap: 0.8rem;
		align-items: baseline;
	}

	dt {
		color: var(--text-soft);
		font-size: 0.76rem;
	}

	dd {
		min-width: 0;
		margin: 0;
		font-size: 0.8rem;
		text-align: right;
		overflow-wrap: anywhere;
	}

	dd.good {
		color: var(--good);
		font-weight: 700;
	}

	dd.revision {
		font-family: var(--font-mono);
		font-size: 0.73rem;
	}

	.settings-footer {
		display: flex;
		justify-content: flex-end;
		padding: 0.85rem 1.2rem 1rem;
		border-top: 1px solid var(--border);
	}

	.settings-done {
		padding: 0.5rem 1rem;
		border: 1px solid var(--accent);
		border-radius: var(--radius-sm);
		background: var(--accent);
		color: #fff;
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
			border-radius: var(--radius-lg) var(--radius-lg) 0 0;
			padding-bottom: env(safe-area-inset-bottom);
		}
	}
</style>
