<script lang="ts">
	import type { EditorialItemState } from '$lib/library/EditorialItemController';

	/**
	 * Core-supplied external links (rich-item plan Slice 7). Every row is
	 * display + safe navigation only: destinations render as links only
	 * when plainly http(s), and rows without a safe destination render as
	 * plain text. Renders nothing unless a ready view of the expected
	 * kind actually carries links.
	 */
	interface Props {
		editorial: EditorialItemState | null;
		testId: string;
		/** Which view kind may supply these links. */
		kind?: 'album' | 'artist';
	}

	const { editorial, testId, kind = 'artist' }: Props = $props();

	// View-presence gate (ri4-2), same rule as the other sections.
	const links = $derived(
		editorial?.view?.kind === kind ? (editorial.view.links ?? []) : []
	);

	/** External destinations render as links only when plainly http(s). */
	function safeUrl(url: string | undefined): string | null {
		if (!url) return null;
		return /^https?:\/\//i.test(url) ? url : null;
	}
</script>

{#if links.length > 0}
	<section class="editorial" data-testid={testId}>
		<h3>Links</h3>
		<ul class="links">
			{#each links as row, index (index)}
				<li>
					{#if safeUrl(row.url)}
						<a
							href={safeUrl(row.url)}
							target="_blank"
							rel="noopener noreferrer"
							data-testid="{testId}-link-{index}"
						>
							{row.text}
						</a>
					{:else}
						<span data-testid="{testId}-link-{index}">{row.text}</span>
					{/if}
				</li>
			{/each}
		</ul>
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
	.links {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 6px 14px;
		max-width: 68ch;
		font-size: 12px;
	}
	.links a {
		color: var(--accent);
		text-decoration: underline;
	}
</style>
