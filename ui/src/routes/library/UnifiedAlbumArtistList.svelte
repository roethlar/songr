<script lang="ts">
	import type { AlbumArtistGroup } from '$lib/albumArtistGroups';
	import type { LetterBucket } from '$lib/libraryEntries';
	import { shouldHandleLibraryAnchorClick } from '$lib/libraryPageNavigation';

	const { groups, grouped = true, railTarget, hrefForGroup, onOpen }: {
		groups: readonly AlbumArtistGroup[];
		grouped?: boolean;
		railTarget: LetterBucket | null;
		hrefForGroup: (group: AlbumArtistGroup) => string | null;
		onOpen: (group: AlbumArtistGroup) => void;
	} = $props();
	let list: HTMLDivElement | null = $state(null);
	const buckets = $derived.by(() => {
		if (!grouped) return [];
		const entries = new Map<string, AlbumArtistGroup[]>();
		for (const group of groups) {
			const bucket = entries.get(group.letter) ?? [];
			bucket.push(group);
			entries.set(group.letter, bucket);
		}
		return [...entries];
	});
	$effect(() => {
		if (!railTarget || !list) return;
		if (list.closest('[data-retained-library-panel][aria-hidden="true"]')) return;
		list.querySelector<HTMLElement>(`[data-letter="${railTarget.letter}"]`)
			?.scrollIntoView?.({ block: 'start' });
	});
</script>

{#snippet rows(entries: readonly AlbumArtistGroup[])}
	<div class="alist artist-grid">
		{#each entries as group (group.key)}
			{@const href = hrefForGroup(group)}
			<svelte:element this={href === null ? 'button' : 'a'}
				role={href === null ? 'button' : 'link'}
				{href} type={href === null ? 'button' : undefined}
				disabled={href === null ? true : undefined}
				class="arow credit-row" data-testid="unified-credit-artist" data-letter={group.letter}
				onclick={(event: MouseEvent) => {
					if (href === null || !shouldHandleLibraryAnchorClick(event)) return;
					event.preventDefault();
					onOpen(group);
				}}>
				<span class="credit-label"><span class="an">{group.label}</span>
					{#if group.selector.kind === 'uncredited'}<small>Albums without an artist credit</small>{/if}
				</span><span class="ad"></span><span class="ac mono">{group.albumCount}</span>
			</svelte:element>
		{/each}
	</div>
{/snippet}

<div class="scope-view" data-testid="unified-album-artists" bind:this={list}>
	{#if groups.length === 0}
		<p class="hint">No album artists in this library.</p>
	{:else if grouped}
		{#each buckets as [letter, entries] (letter)}
			<div class="grp"><div class="gl">{letter}</div>{@render rows(entries)}</div>
		{/each}
	{:else}
		{@render rows(groups)}
	{/if}
</div>
