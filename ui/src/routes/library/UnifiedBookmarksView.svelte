<script lang="ts">
	import { onDestroy } from 'svelte';
	import { createTrackSelection } from '$lib/trackSelection';
	import EntityFeedback from '$lib/components/EntityFeedback.svelte';
	import TrackSelectionControls from './TrackSelectionControls.svelte';
	import { hideOnError } from '$lib/actions/imageFallback';
	import { imageUrl } from '$lib/imageUrl';
	import type { FavoritesState } from '$lib/stores/favoritesStore';
	import type { FavoriteEntry } from '@shared/types';

	let {
		state: favoriteState,
		busy = false,
		status = null,
		onActivate,
		onRemoveBatch
	}: {
		state: FavoritesState;
		busy?: boolean;
		status?: string | null;
		onActivate: (favorite: FavoriteEntry) => void;
		onRemoveBatch: (favorites: readonly FavoriteEntry[]) => Promise<void>;
	} = $props();
	const selection = createTrackSelection<FavoriteEntry>();
	let removing = $state(false);
	let removeError = $state<string | null>(null);
	$effect(() => { selection.retain(favoriteState.entries, favoriteState.entries); });
	onDestroy(() => selection.clear());
	async function removeSelected(items: FavoriteEntry[]): Promise<void> {
		if (busy || removing || items.length === 0) return;
		removing = true;
		removeError = null;
		try { await onRemoveBatch([...items]); }
		catch (error) { removeError = error instanceof Error ? error.message : 'Bookmarks could not be removed.'; }
		finally { removing = false; }
	}
</script>

<section class="favorites-surface" data-testid="unified-favorites-view" aria-labelledby="favorites-title">
	<div class="favorites-heading">
		<div>
			<p>YOUR LIBRARY</p>
			<h2 id="favorites-title">Bookmarks</h2>
		</div>
		<span class="favorites-total">{favoriteState.entries.length.toLocaleString()} TOTAL</span>
		<div class="favorites-selection">
			<TrackSelectionControls {selection} orderedItems={favoriteState.entries} visibleItems={favoriteState.entries} groupLabel="Selected bookmarks"
				busy={busy || removing} status={removeError} label={(favorite) => favorite.title}
				actions={[
					{ id: 'open', label: 'Open', disabled: $selection.count !== 1,
						run: (items) => { if (items.length === 1) onActivate(items[0]); } },
					{ id: 'remove', label: 'Remove selected', run: (items) => void removeSelected(items) }
				]} />
		</div>
	</div>

	<EntityFeedback message={status} />
	{#if favoriteState.loading && !favoriteState.loaded}
		<p class="favorites-empty" data-testid="unified-favorites-loading">Loading bookmarks…</p>
	{:else if favoriteState.entries.length === 0}
		<p class="favorites-empty" data-testid="unified-favorites-empty">
			No bookmarks yet — use Bookmark on a track, album or artist.
		</p>
	{:else}

		<div class="favorites-list" data-testid="unified-favorites-list">
			{#each favoriteState.entries as favorite (favorite.id)}
				<div class="favorite-row" data-testid="unified-favorite-row" data-track-select-row
					use:selection.row={{ item: favorite, ordered: () => favoriteState.entries,
						generation: favoriteState.entries, disabled: busy || removing }}>
					<div class="favorite-open">
						<span class="favorite-art" aria-hidden="true">
							{#if favorite.image_key}
								<img
									src={imageUrl(favorite.image_key, { width: 80, height: 80 })}
									alt=""
									loading="lazy"
									decoding="async"
									use:hideOnError
								/>
							{:else}
								{favorite.title.charAt(0).toUpperCase() || '♪'}
							{/if}
						</span>
						<span class="favorite-copy">
							<button type="button" data-track-select-target aria-label="Select {favorite.title}" aria-pressed="false">{favorite.title}</button>
							<small>{favorite.artist ?? favorite.album ?? favorite.type}</small>
						</span>
						<span class="favorite-type">{favorite.type.toUpperCase()}</span>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</section>

<style>
	.favorites-surface {
		display: flex;
		flex-direction: column;
		gap: 14px;
		color: var(--unified-fg);
	}

	.favorites-heading {
		display: flex;
		align-items: end;
		justify-content: space-between;
		gap: 20px;
		padding: 12px 0 14px;
		border-bottom: 1px solid var(--songr-line-16);
	}

	.favorites-heading p,
	.favorites-heading h2,
	.favorite-copy button,
	.favorite-copy small,
	.favorites-empty {
		margin: 0;
	}

	.favorites-heading p,
	.favorites-heading span,
	.favorite-type {
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		font-size: 10px;
		letter-spacing: 0.13em;
		color: var(--songr-text-48);
	}

	.favorites-heading h2 {
		font-size: clamp(24px, 3vw, 38px);
		font-weight: 500;
	}

	.favorites-selection { flex: 1 1 160px; min-width: min-content; }
	.favorites-heading > div:first-child { min-width: 0; }
	.favorites-heading h2 { overflow: hidden; text-overflow: ellipsis; }
	.favorites-total { white-space: nowrap; }
	@media (max-width: 520px) { .favorites-heading { gap: 8px; } .favorites-total { display: none; } }

	.favorites-list {
		display: flex;
		flex-direction: column;
		border-top: 1px solid var(--songr-line-10);
	}

	.favorite-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		align-items: center;
		border-bottom: 1px solid var(--songr-line-10);
	}

	.favorite-open {
		display: grid;
		grid-template-columns: 42px minmax(0, 1fr) auto;
		align-items: center;
		gap: 12px;
		min-width: 0;
		padding: 8px 12px;
		border: 0;
		background: transparent;
		color: inherit;
		text-align: left;
		font: inherit;
		cursor: pointer;
	}

	.favorite-art {
		display: grid;
		place-items: center;
		width: 38px;
		height: 38px;
		overflow: hidden;
		border: 1px solid color-mix(in srgb, var(--unified-accent) 35%, transparent);
		border-radius: 4px;
		background: var(--songr-raise);
		color: var(--unified-accent);
	}

	.favorite-art img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.favorite-copy {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 3px;
	}

	.favorite-copy button,
	.favorite-copy small {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.favorite-copy button {
		font-weight: 500;
	}

	.favorite-copy small {
		color: var(--songr-text-56);
	}

	.favorites-empty {
		padding: 12px;
		border: 1px solid var(--songr-line-16);
		border-radius: 7px;
		color: var(--songr-text-64);
	}

	@media (max-width: 720px) {
		.favorite-open {
			grid-template-columns: 42px minmax(0, 1fr);
		}

		.favorite-type {
			display: none;
		}
	}
</style>
