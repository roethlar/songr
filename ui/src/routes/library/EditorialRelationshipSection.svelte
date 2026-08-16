<script lang="ts">
	import type { EditorialItemState } from '$lib/library/EditorialItemController';

	/**
	 * Relationship sections (rich-item plan Slice 7): the Core's proven
	 * relationship families in delivered order — related artists on an
	 * artist view, similar albums on an album view. Rows carrying an
	 * opaque follow target render as navigation buttons — navigation
	 * only, never action authority. Renders nothing unless a ready view
	 * of the expected kind actually carries relationship groups.
	 */
	interface Props {
		editorial: EditorialItemState | null;
		testId: string;
		onFollow?: (target: string) => void;
		/** Which view kind may supply these groups. */
		kind?: 'album' | 'artist';
	}

	const { editorial, testId, onFollow = () => {}, kind = 'album' }: Props = $props();

	// The retained view, not the transport phase, is the render gate
	// (ri4-2): every transition that should clear content already nulls
	// the view, while a section-scoped failure after a ready view keeps
	// the still-valid rows on the page.
	const groups = $derived(
		editorial?.view?.kind === kind ? (editorial.view.relationshipGroups ?? []) : []
	);
</script>

{#if groups.length > 0}
	<section class="editorial" data-testid={testId}>
		{#each groups as group, groupIndex (groupIndex)}
			<h3>{group.label}</h3>
			<ul class="rows" data-testid="{testId}-group-{groupIndex}">
				{#each group.items as item, position (position)}
					{@const target = item.followTarget}
					<li class="row">
						{#if target !== undefined}
							<button
								type="button"
								class="title follow"
								data-testid="{testId}-follow-{groupIndex}-{position}"
								onclick={() => onFollow(target)}
							>
								{item.title}
							</button>
						{:else}
							<span class="title">{item.title}</span>
						{/if}
						{#if item.subtitle}
							<span class="subtitle">{item.subtitle}</span>
						{/if}
					</li>
				{/each}
			</ul>
		{/each}
	</section>
{/if}

<style>
	.editorial {
		margin-top: 18px;
	}
	.editorial h3 {
		margin: 0 0 6px;
		font-size: 12px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--soft);
	}
	.rows {
		list-style: none;
		margin: 0 0 10px;
		padding: 0;
		max-width: 68ch;
	}
	.row {
		display: flex;
		align-items: baseline;
		gap: 10px;
		padding: 3px 0;
		font-size: 13px;
	}
	.subtitle {
		color: var(--soft);
		font-size: 12px;
		min-width: 0;
	}
	.title {
		min-width: 0;
	}
	button.follow {
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--accent);
		font-size: 13px;
		text-align: left;
		cursor: pointer;
	}
</style>
