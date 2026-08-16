<script lang="ts">
	import type { EditorialItemState } from '$lib/library/EditorialItemController';

	/**
	 * The album Credits section (rich-item plan Slice 4): the Core's own
	 * credit list in exact order with verbatim role labels. Rows whose
	 * performer carries an opaque follow target render as navigation
	 * buttons — navigation only, never action authority. Renders nothing
	 * unless a ready album view actually carries credit groups.
	 */
	interface Props {
		editorial: EditorialItemState | null;
		testId: string;
		onFollow: (target: string) => void;
		/** Which view kind may supply these credits (Slice 5: 'track'). */
		kind?: 'album' | 'track';
	}

	const { editorial, testId, onFollow, kind = 'album' }: Props = $props();

	// The retained view, not the transport phase, is the render gate
	// (ri4-2): every transition that should clear content already nulls
	// the view, while a section-scoped failure after a ready view keeps
	// the still-valid credits on the page.
	const groups = $derived(
		editorial?.view?.kind === kind ? (editorial.view.creditGroups ?? []) : []
	);
</script>

{#if groups.length > 0}
	<section class="editorial" data-testid={testId}>
		<h3>Credits</h3>
		{#each groups as group, groupIndex (groupIndex)}
			<!-- Track group labels ARE the roles (ri5-3): they always render.
			     The album's single structural "Album" label stays implicit. -->
			{#if kind === 'track' || groups.length > 1}
				<h4>{group.label}</h4>
			{/if}
			<ul class="credits" data-testid="{testId}-group-{groupIndex}">
				{#each group.credits as credit, position (position)}
					{@const target = credit.followTarget}
					<li class="credit-row">
						<span class="role">{credit.role}</span>
						{#if target !== undefined}
							<button
								type="button"
								class="name follow"
								data-testid="{testId}-follow-{groupIndex}-{position}"
								onclick={() => onFollow(target)}
							>
								{credit.name}
							</button>
						{:else}
							<span class="name">{credit.name}</span>
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
	.editorial h4 {
		margin: 8px 0 4px;
		font-size: 11px;
		color: var(--soft);
	}
	.credits {
		list-style: none;
		margin: 0;
		padding: 0;
		max-width: 68ch;
	}
	.credit-row {
		display: flex;
		align-items: baseline;
		gap: 10px;
		padding: 3px 0;
		font-size: 13px;
	}
	.role {
		flex: 0 0 40%;
		max-width: 40%;
		color: var(--soft);
		font-size: 12px;
	}
	.name {
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
