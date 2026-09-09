<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { imageUrl } from '$lib/imageUrl';
	import { shouldHandleLibraryAnchorClick } from '$lib/libraryPageNavigation';
	import { genrePreviewCapacity } from '$lib/library/genrePreviewLayout';
	import type { GenrePreviewState } from '$lib/library/GenrePreviewController';
	import type { LibraryRenderingPath } from '$lib/library/liveLibraryPath';
	import type { LibraryLevelRow } from '@shared/libraryOpenContracts';
	import type { LibraryPreviewItemKind } from '@shared/libraryPreviewContracts';
	import type { UnifiedLibraryDensity } from '$lib/stores/unifiedLibraryPrefsStore';

	let { state: previews, density, onCapacity, onRetry, onOpen, hrefFor }: {
		state: GenrePreviewState;
		density: UnifiedLibraryDensity;
		onCapacity: (capacity: number) => void;
		onRetry: (kind: LibraryPreviewItemKind) => void;
		onOpen: (source: LibraryRenderingPath, row: LibraryLevelRow) => void;
		hrefFor: (source: LibraryRenderingPath, row: LibraryLevelRow) => string | null;
	} = $props();
	let element: HTMLDivElement;
	let capacity = $state(0);
	let failedImages = $state<Set<string>>(new Set());
	let measure: (() => void) | null = null;
	const kinds = ['artist', 'album'] as const;
	const labels = { artist: 'Artists', album: 'Albums' };
	const extras = $derived(previews.owner?.page.level?.rows.filter(row => row.kind !== 'action' && row.kind !== 'section') ?? []);
	const subgenres = $derived(extras.filter(row => row.kind === 'genre'));
	const otherRows = $derived([...(previews.owner?.page.level?.rows.filter(row => row.kind === 'section' &&
		!previews.artist.candidates.includes(row) && !previews.album.candidates.includes(row)) ?? []),
		...extras.filter(row => row.kind !== 'genre')]);
	const genrePath = $derived(previews.owner?.page.path ?? null);

	function follow(event: MouseEvent, source: LibraryRenderingPath, row: LibraryLevelRow): void {
		if (!shouldHandleLibraryAnchorClick(event)) return;
		event.preventDefault(); onOpen(source, row);
	}
	function failed(key: string): void { failedImages = new Set([...failedImages, key]); }

	onMount(() => {
		let active = true;
		let frame = 0;
		const read = () => {
			frame = 0;
			if (!active) return;
			const style = getComputedStyle(element);
			const width = element.clientWidth - parseFloat(style.paddingLeft || '0') - parseFloat(style.paddingRight || '0');
			capacity = genrePreviewCapacity(width, parseFloat(style.getPropertyValue('--tile')), parseFloat(style.getPropertyValue('--gap')));
			onCapacity(capacity);
		};
		measure = () => { if (!frame && active) frame = requestAnimationFrame(read); };
		const observer = new ResizeObserver(() => measure?.());
		observer.observe(element); measure();
		return () => { active = false; observer.disconnect(); if (frame) cancelAnimationFrame(frame); measure = null; };
	});
	$effect(() => { void density; void previews.owner; void tick().then(() => measure?.()); });
</script>

{#snippet cardContents(row: LibraryLevelRow, kind: LibraryPreviewItemKind)}
	{@const key = `${row.ref.generation}:${row.ref.token}:${row.imageKey ?? ''}`}
		<div class="art">
			{#if row.imageKey && !failedImages.has(key)}
				<img src={imageUrl(row.imageKey, { scale: 'fit', width: 300, height: 300 })} alt="" onerror={() => failed(key)} />
			{:else}
				<div class="mono-tile" data-testid="genre-preview-placeholder">{Array.from(row.title.trim())[0]?.toLocaleUpperCase() ?? '?'}</div>
			{/if}
		</div>
		<div class="tt">{row.title}</div>
		{#if kind === 'album'}<div class="ta">{row.subtitle ?? ''}</div>{/if}
{/snippet}

{#snippet card(source: LibraryRenderingPath, row: LibraryLevelRow, kind: LibraryPreviewItemKind)}
	{@const href = previews.stale ? null : hrefFor(source, row)}
	{@const title = row.subtitle ? `${row.title} — ${row.subtitle}` : row.title}
	{#if href !== null}
		<a {href} class="tile preview-tile" class:portrait={kind === 'artist'} data-testid="genre-preview-{kind}"
			{title} onclick={event => follow(event, source, row)}>{@render cardContents(row, kind)}</a>
	{:else}
		<div class="tile preview-tile" class:portrait={kind === 'artist'} data-testid="genre-preview-{kind}"
			{title}>{@render cardContents(row, kind)}</div>
	{/if}
{/snippet}

{#snippet extraLinks(rows: readonly LibraryLevelRow[])}
	{#if genrePath}
		<div class="genre-links">
			{#each rows as row (row.ref.token)}
				{@const href = previews.stale ? null : hrefFor(genrePath, row)}
				{#if href !== null}<a {href} onclick={event => follow(event, genrePath!, row)}>{row.title}<span aria-hidden="true"> ›</span></a>
				{:else}<span>{row.title}</span>{/if}
			{/each}
		</div>
	{/if}
{/snippet}

<div class="genre-overview" bind:this={element} data-testid="genre-overview" data-capacity={capacity} style:--preview-capacity={Math.max(1, capacity)}>
	{#each kinds as kind (kind)}
		{@const section = previews[kind]}
		<section class="genre-preview-section" aria-label={labels[kind]} data-testid="genre-preview-section-{kind}">
			<div class="preview-heading">
				<h3>{labels[kind]}</h3>
				{#if section.candidates.length === 1 && genrePath}
					{@const href = previews.stale ? null : hrefFor(genrePath, section.candidates[0])}
					{#if href !== null}
						<a class="more" aria-label="More {labels[kind].toLowerCase()}" {href} onclick={event => follow(event, genrePath!, section.candidates[0])}>More <span aria-hidden="true">›</span></a>
					{:else}<span class="more unavailable" aria-disabled="true">More ›</span>{/if}
				{/if}
			</div>
			{#if previews.owner === null}
				<p class="preview-status" role="status">Loading {labels[kind].toLowerCase()}…</p>
			{:else if section.phase === 'omitted'}
				<p class="preview-status">Roon did not provide an {labels[kind]} section for this genre.</p>
			{:else if section.phase === 'ambiguous'}
				<p class="preview-status">Roon lists more than one {labels[kind]} section. Choose a section:</p>
				{@render extraLinks(section.candidates)}
			{:else}
				{#if section.phase === 'loading'}<p class="preview-status" role="status">Loading {labels[kind].toLowerCase()}…</p>{/if}
				{#if section.phase === 'failed'}
					<p class="preview-status error">{section.error}</p>
					<button type="button" class="ghost" onclick={() => onRetry(kind)} aria-label="Retry {labels[kind].toLowerCase()} preview">Retry</button>
				{/if}
				{#if section.phase === 'ready' && section.preview?.totalCount === 0}<p class="preview-status">No {labels[kind].toLowerCase()} in this section.</p>{/if}
				{#if section.sourcePath && section.preview && capacity > 0}
					<div class="preview-row" data-testid="genre-preview-row-{kind}">
						{#each section.preview.rows.slice(0, capacity) as row (row.ref.token)}
							{@render card(section.sourcePath, row, kind)}
						{/each}
					</div>
				{/if}
			{/if}
		</section>
	{/each}
	{#if subgenres.length}<section class="genre-extra"><h3>Subgenres</h3>{@render extraLinks(subgenres)}</section>{/if}
	{#if otherRows.length}<section class="genre-extra"><h3>More in this genre</h3>{@render extraLinks(otherRows)}</section>{/if}
</div>

<style>
	.genre-overview { min-width: 0; padding: 4px 22px 28px; }
	.genre-preview-section + .genre-preview-section, .genre-extra { margin-top: 28px; }
	.preview-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
	h3 { font-size: 18px; font-weight: 600; margin: 0; color: var(--text); }
	.more { color: var(--accent); font-size: 13px; text-decoration: none; white-space: nowrap; padding: 8px 0 8px 12px; }
	.more:hover, .genre-links a:hover { text-decoration: underline; }
	.more span { margin-left: 4px; font-size: 18px; }
	.unavailable { color: var(--dim); }
	.preview-row { display: grid; grid-template-columns: repeat(var(--preview-capacity), minmax(0, 1fr)); gap: var(--gap); }
	.preview-tile { min-width: 0; text-decoration: none; }
	.preview-tile.portrait .art { border-radius: 50%; }
	.preview-tile.portrait .tt { text-align: center; }
	.mono-tile { background: linear-gradient(135deg, var(--raise), var(--panel)); color: var(--accent); }
	.preview-status { color: var(--dim); font-size: 13px; margin: 8px 0 14px; }
	.preview-status.error { color: var(--text); }
	.genre-links { display: flex; flex-wrap: wrap; gap: 12px 24px; margin-top: 12px; }
	.genre-links a { color: var(--accent); text-decoration: none; padding: 6px 0; }
	.genre-links span { color: var(--dim); }
</style>
