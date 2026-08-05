<script lang="ts">
	import { imageUrl } from '$lib/imageUrl';
	import { hideOnError } from '$lib/actions/imageFallback';
	import type { BrowseItem } from '@shared/types';

	let {
		items,
		onItemClick,
		jumpId,
		allowKeyless = false,
		interactive = true
	}: {
		items: BrowseItem[];
		onItemClick: (item: BrowseItem) => void;
		/** Optional id resolver for alphabetic jump bar anchoring. */
		jumpId?: (item: BrowseItem, index: number) => string | undefined;
		/** Search descriptors are intentionally keyless and re-resolve on click. */
		allowKeyless?: boolean;
		interactive?: boolean;
	} = $props();
</script>

<div class="items-grid">
	{#each items as item, index (item.itemKey ?? index)}
		<div
			class="item-wrapper"
			style={`--delay: ${Math.min(index * 20, 240)}ms`}
			id={jumpId?.(item, index)}
		>
			<button
				type="button"
				class="item-card"
				onclick={() => onItemClick(item)}
				disabled={!interactive || (!allowKeyless && !item.itemKey)}
				title={item.title}
			>
				<div class="item-art">
					<!-- The letter renders behind the artwork so a failed
					     image load (hidden via hideOnError) degrades to the
					     same placeholder as a missing image key. -->
					<span class="art-placeholder">{item.title.charAt(0)}</span>
					{#if item.imageKey}
						<img
							src={imageUrl(item.imageKey, { width: 320, height: 320 })}
							alt={item.title}
							loading="lazy"
							decoding="async"
							use:hideOnError
						/>
					{/if}
				</div>
				<div class="item-meta">
					<p class="title">{item.title}</p>
					{#if item.subtitle}
						<p class="subtitle">{item.subtitle}</p>
					{/if}
				</div>
			</button>
		</div>
	{/each}
</div>

<style>
	.items-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
		gap: 0.62rem;
	}

	.item-wrapper {
		position: relative;
		animation: rise-in 280ms ease both;
		animation-delay: var(--delay);
	}

	.item-card {
		width: 100%;
		padding: 0.48rem;
		border: 1px solid var(--border);
		border-radius: 11px;
		background: var(--surface-2);
		text-align: left;
		display: flex;
		flex-direction: column;
		gap: 0.55rem;
		color: var(--text);
	}

	.item-card:hover:not(:disabled) {
		border-color: var(--accent-2);
		box-shadow: var(--shadow-soft);
		transform: translateY(-1px);
	}

	.item-card:disabled {
		opacity: 0.72;
		cursor: default;
	}

	.item-art {
		position: relative;
		aspect-ratio: 1 / 1;
		border-radius: 9px;
		overflow: hidden;
		background: var(--surface-3);
		display: grid;
		place-items: center;
		font-size: 0.76rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-soft);
	}

	.item-art img {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.art-placeholder {
		font-size: 2.5rem;
		font-weight: 700;
		font-family: var(--font-display);
		color: var(--text-soft);
		opacity: 0.5;
		text-transform: uppercase;
		user-select: none;
	}

	.item-meta .title {
		font-weight: 650;
		line-height: 1.3;
	}

	.item-meta .subtitle {
		margin-top: 0.15rem;
		font-size: 0.82rem;
		color: var(--text-soft);
		line-height: 1.33;
	}
</style>
