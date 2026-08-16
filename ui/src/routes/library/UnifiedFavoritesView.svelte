<script lang="ts">
	import { hideOnError } from '$lib/actions/imageFallback';
	import { imageUrl } from '$lib/imageUrl';
	import type { FavoritesState } from '$lib/stores/favoritesStore';
	import type { FavoriteEntry } from '@shared/types';

	let {
		state,
		busy = false,
		status = null,
		onActivate,
		onRemove
	}: {
		state: FavoritesState;
		busy?: boolean;
		status?: string | null;
		onActivate: (favorite: FavoriteEntry) => void;
		onRemove: (favorite: FavoriteEntry) => void;
	} = $props();
</script>

<section class="favorites-surface" data-testid="unified-favorites-view" aria-labelledby="favorites-title">
	<div class="favorites-heading">
		<div>
			<p>YOUR LIBRARY</p>
			<h2 id="favorites-title">Favorites</h2>
		</div>
		<span>{state.entries.length.toLocaleString()} TOTAL</span>
	</div>

	{#if status}
		<p class="favorites-status" role="status" data-testid="unified-favorites-status">{status}</p>
	{/if}
	{#if state.loading && !state.loaded}
		<p class="favorites-empty" data-testid="unified-favorites-loading">Loading favorites…</p>
	{:else if state.entries.length === 0}
		<p class="favorites-empty" data-testid="unified-favorites-empty">
			No favorites yet — add one from a song, album, or Browse action sheet.
		</p>
	{:else}
		<div class="favorites-list" data-testid="unified-favorites-list">
			{#each state.entries as favorite (favorite.id)}
				<div class="favorite-row" data-testid="unified-favorite-row">
					<button
						type="button"
						class="favorite-open"
						aria-label="Search favorite {favorite.title}"
						disabled={busy}
						onclick={() => onActivate(favorite)}
					>
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
							<strong>{favorite.title}</strong>
							<small>{favorite.artist ?? favorite.album ?? favorite.type}</small>
						</span>
						<span class="favorite-type">{favorite.type.toUpperCase()}</span>
						<span class="favorite-affordance">SEARCH</span>
					</button>
					<button
						type="button"
						class="favorite-remove"
						aria-label="Remove {favorite.title} from favorites"
						disabled={busy}
						onclick={() => onRemove(favorite)}
					>
						Remove
					</button>
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
	.favorite-copy strong,
	.favorite-copy small,
	.favorites-status,
	.favorites-empty {
		margin: 0;
	}

	.favorites-heading p,
	.favorites-heading span,
	.favorite-type,
	.favorite-affordance,
	.favorite-remove {
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		font-size: 10px;
		letter-spacing: 0.13em;
		color: var(--songr-text-48);
	}

	.favorites-heading h2 {
		font-size: clamp(24px, 3vw, 38px);
		font-weight: 500;
	}

	.favorites-list {
		display: flex;
		flex-direction: column;
		border-top: 1px solid var(--songr-line-10);
	}

	.favorite-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		border-bottom: 1px solid var(--songr-line-10);
	}

	.favorite-open {
		display: grid;
		grid-template-columns: 42px minmax(150px, 1fr) auto auto;
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

	.favorite-copy strong,
	.favorite-copy small {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.favorite-copy strong {
		font-weight: 500;
	}

	.favorite-copy small {
		color: var(--songr-text-56);
	}

	.favorite-remove {
		align-self: stretch;
		padding: 0 14px;
		border: 0;
		border-left: 1px solid var(--songr-line-10);
		background: var(--songr-panel);
		cursor: pointer;
	}

	.favorite-open:hover:not(:disabled),
	.favorite-remove:hover:not(:disabled) {
		color: var(--unified-accent);
		background: var(--songr-raise);
	}

	.favorite-open:focus-visible,
	.favorite-remove:focus-visible {
		outline: 2px solid var(--unified-accent);
		outline-offset: -2px;
	}

	.favorite-open:disabled,
	.favorite-remove:disabled {
		opacity: 0.4;
		cursor: default;
	}

	.favorites-status,
	.favorites-empty {
		padding: 12px;
		border: 1px solid var(--songr-line-16);
		border-radius: 7px;
		color: var(--songr-text-64);
	}

	@media (max-width: 720px) {
		.favorite-open {
			grid-template-columns: 42px minmax(0, 1fr) auto;
		}

		.favorite-type {
			display: none;
		}
	}
</style>
