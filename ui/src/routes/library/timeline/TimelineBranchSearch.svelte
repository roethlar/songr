<script lang="ts">
	import { untrack } from 'svelte';
	import { focusTrap, isTopModalOwner } from '$lib/actions/focusTrap';

	export type TimelineBranchSearchPhase = 'idle' | 'loading' | 'ready' | 'error';

	export interface TimelineBranchSearchCandidate {
		readonly artistLocalId: string;
		readonly name: string;
		readonly subtitle?: string;
	}

	let {
		sourceTitle,
		phase = 'idle',
		candidates = [],
		errorMessage = null,
		initialQuery = '',
		onSearch,
		onChoose,
		onCancel
	}: {
		sourceTitle: string;
		phase?: TimelineBranchSearchPhase;
		candidates?: readonly TimelineBranchSearchCandidate[];
		errorMessage?: string | null;
		initialQuery?: string;
		onSearch: (query: string) => void;
		onChoose: (candidate: TimelineBranchSearchCandidate) => void;
		onCancel: () => void;
	} = $props();

	let dialog: HTMLElement;
	let query = $state(untrack(() => initialQuery));
	let visibleCandidates = $derived(candidates.slice(0, 8));
	let normalizedQuery = $derived(query.trim());

	function stopPointer(event: PointerEvent): void {
		event.stopPropagation();
	}

	function submitSearch(event: SubmitEvent): void {
		event.preventDefault();
		if (phase === 'loading' || normalizedQuery.length === 0) return;
		onSearch(normalizedQuery);
	}

	function handleWindowKeydown(event: KeyboardEvent): void {
		if (
			event.defaultPrevented ||
			event.key !== 'Escape' ||
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
	class="branch-search-layer"
	role="dialog"
	aria-modal="true"
	aria-labelledby="timeline-branch-search-title"
	aria-describedby="timeline-branch-search-context"
	aria-busy={phase === 'loading' ? 'true' : undefined}
	tabindex="-1"
	use:focusTrap={{ initialFocus: '[data-branch-search-input]', restoreFocus: false }}
	onpointerdown={stopPointer}
>
	<button
		type="button"
		class="branch-search-backdrop"
		aria-hidden="true"
		tabindex="-1"
		onclick={onCancel}
	></button>
	<section class="branch-search-dialog">
		<header>
			<span>Artist search</span>
			<h2 id="timeline-branch-search-title">Attach artist branch</h2>
			<p id="timeline-branch-search-context">
				Search for another artist to attach to <strong>{sourceTitle}</strong>.
			</p>
		</header>

		<form role="search" onsubmit={submitSearch}>
			<label for="timeline-branch-artist-query">Artist name</label>
			<div class="search-row">
				<input
					id="timeline-branch-artist-query"
					data-branch-search-input
					type="search"
					bind:value={query}
					autocomplete="off"
					spellcheck="false"
				/>
				<button type="submit" disabled={phase === 'loading' || normalizedQuery.length === 0}>
					Search
				</button>
			</div>
		</form>

		<div class="branch-search-results">
			{#if phase === 'loading'}
				<p role="status" aria-live="polite">Searching artists…</p>
			{:else if phase === 'error'}
				<p role="alert">{errorMessage ?? 'Artist search is unavailable. Try again.'}</p>
			{:else if phase === 'ready' && visibleCandidates.length === 0}
				<p role="status">No artists found. Try a different name.</p>
			{:else if phase === 'ready'}
				<div class="result-summary">
					<strong>Choose an artist</strong>
					{#if candidates.length > visibleCandidates.length}
						<span>Showing {visibleCandidates.length} of {candidates.length} matches</span>
					{:else}
						<span>{visibleCandidates.length} {visibleCandidates.length === 1 ? 'match' : 'matches'}</span>
					{/if}
				</div>
				<ul aria-label="Artist search results">
					{#each visibleCandidates as candidate (candidate.artistLocalId)}
						<li>
							<button
								type="button"
								data-branch-artist-id={candidate.artistLocalId}
								onclick={() => onChoose(candidate)}
							>
								<strong>{candidate.name}</strong>
								{#if candidate.subtitle}<span>{candidate.subtitle}</span>{/if}
							</button>
						</li>
					{/each}
				</ul>
			{:else}
				<p>Enter an artist name, then choose Search.</p>
			{/if}
		</div>

		<footer>
			<button type="button" class="secondary-action" onclick={onCancel}>Cancel</button>
		</footer>
	</section>
</div>

<style>
	.branch-search-layer {
		position: absolute;
		inset: 0;
		z-index: 15;
		display: grid;
		place-items: center;
		padding: 24px;
	}

	.branch-search-backdrop {
		position: absolute;
		inset: 0;
		border: 0;
		background: rgb(0 0 0 / 0.58);
		cursor: default;
	}

	.branch-search-dialog {
		position: relative;
		z-index: 1;
		display: grid;
		width: min(460px, 100%);
		max-height: min(680px, 100%);
		box-sizing: border-box;
		gap: 16px;
		padding: 18px;
		overflow: hidden;
		border: 1px solid color-mix(in srgb, var(--accent-2) 58%, var(--border));
		border-radius: 16px;
		background: color-mix(in srgb, var(--surface) 98%, transparent);
		box-shadow: 0 22px 64px rgb(0 0 0 / 0.42);
		color: var(--text);
	}

	header,
	form,
	.branch-search-results {
		display: grid;
		gap: 7px;
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

	h2,
	p {
		margin: 0;
	}

	h2 {
		font-size: 20px;
	}

	p,
	.result-summary span {
		color: var(--text-soft);
		font-size: 12px;
		line-height: 1.45;
	}

	label,
	.result-summary strong {
		font-size: 12px;
		font-weight: 700;
	}

	.search-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 8px;
	}

	input,
	button {
		border-radius: 10px;
		font: inherit;
	}

	input {
		min-width: 0;
		padding: 10px 11px;
		border: 1px solid var(--border);
		background: var(--surface-2);
		color: var(--text);
	}

	button {
		border: 1px solid var(--border);
		background: var(--surface-2);
		color: var(--text);
		cursor: pointer;
	}

	button:hover,
	button:focus-visible,
	input:focus-visible {
		outline: 2px solid var(--accent-2);
		outline-offset: 2px;
	}

	button:disabled {
		opacity: 0.48;
		cursor: default;
	}

	.search-row button {
		padding: 9px 14px;
		font-size: 12px;
		font-weight: 700;
	}

	.branch-search-results {
		min-height: 76px;
		overflow: hidden;
	}

	.result-summary {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 16px;
	}

	ul {
		display: grid;
		max-height: min(330px, 42vh);
		margin: 0;
		padding: 0;
		gap: 7px;
		overflow: auto;
		list-style: none;
		overscroll-behavior: contain;
		scrollbar-width: thin;
	}

	li button {
		display: grid;
		width: 100%;
		gap: 2px;
		padding: 10px 11px;
		text-align: left;
	}

	li strong {
		font-size: 13px;
	}

	li span {
		color: var(--text-soft);
		font-size: 11px;
	}

	footer {
		display: flex;
		justify-content: flex-end;
		padding-top: 2px;
	}

	.secondary-action {
		padding: 9px 13px;
		background: transparent;
		font-size: 12px;
	}
</style>
