<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { focusTrap, isTopModalOwner } from '$lib/actions/focusTrap';
	import { TIMELINE_LIST_PAGE_SIZE } from '$lib/timeline';

	type TimelineListAlbum = {
		readonly id: string;
		readonly title: string;
		readonly artist: string;
		readonly chronologyLabel: string;
		readonly ordinal: number;
		/** Code-owned branch provenance; omitted for the base discography. */
		readonly provenanceLabel?: string;
	};

	let {
		albums,
		currentId,
		selectedId,
		onFocus,
		onChoose,
		onActions,
		onClose,
		onPageChange
	}: {
		albums: readonly TimelineListAlbum[];
		currentId: string | null;
		selectedId?: string | null;
		onFocus: (albumLocalId: string) => void;
		onChoose: (albumLocalId: string) => void;
		onActions: (albumLocalId: string) => void;
		onClose: () => void;
		onPageChange?: (page: number, pageCount: number) => void;
	} = $props();

	let dialog: HTMLElement;
	let activeId = $state(untrack(() => currentId ?? albums[0]?.id ?? null));
	let page = $state(untrack(() => pageForId(albums, activeId)));
	let focusGeneration = 0;
	let pageCount = $derived(Math.max(1, Math.ceil(albums.length / TIMELINE_LIST_PAGE_SIZE)));
	let visibleAlbums = $derived(pageSlice(albums, page));
	let initialFocusId = $derived(
		visibleAlbums.some((album) => album.id === activeId)
			? activeId
			: (visibleAlbums[0]?.id ?? null)
	);

	function pageForId(items: readonly TimelineListAlbum[], id: string | null): number {
		const index = id ? items.findIndex((item) => item.id === id) : -1;
		return Math.floor(Math.max(0, index) / TIMELINE_LIST_PAGE_SIZE);
	}

	function pageSlice(
		items: readonly TimelineListAlbum[],
		pageNumber: number
	): readonly TimelineListAlbum[] {
		const start = pageNumber * TIMELINE_LIST_PAGE_SIZE;
		return items.slice(start, start + TIMELINE_LIST_PAGE_SIZE);
	}

	async function focusActiveTarget(
		expectedId: string | null,
		shouldFocus: boolean
	): Promise<void> {
		const operation = ++focusGeneration;
		await tick();
		if (
			operation !== focusGeneration ||
			!shouldFocus ||
			!dialog?.isConnected ||
			!isTopModalOwner(dialog)
		) return;
		const activeElement = document.activeElement as HTMLElement | null;
		if (
			activeElement &&
			activeElement !== document.body &&
			activeElement.isConnected &&
			dialog.contains(activeElement) &&
			!activeElement.hasAttribute('data-list-album-id')
		) return;
		const row = expectedId
			? Array.from(dialog.querySelectorAll<HTMLElement>('[data-list-album-id]')).find(
				(element) => element.dataset.listAlbumId === expectedId
			)
			: null;
		(row ?? dialog.querySelector<HTMLElement>('.close-list') ?? dialog).focus();
	}

	$effect(() => {
		const activeElement = document.activeElement as HTMLElement | null;
		const ownedRowFocus = Boolean(
			dialog &&
				((dialog.contains(activeElement) && activeElement?.hasAttribute('data-list-album-id')) ||
					activeElement === document.body ||
					!activeElement?.isConnected)
		);
		const activeStillExists = activeId && albums.some((album) => album.id === activeId);
		const currentStillExists = currentId && albums.some((album) => album.id === currentId);
		const nextId = activeStillExists
			? activeId
			: currentStillExists
				? currentId
				: (albums[0]?.id ?? null);
		const nextPage = pageForId(albums, nextId);
		const activeChanged = nextId !== activeId;
		const pageChanged = nextPage !== page;
		if (!activeChanged && !pageChanged) return;
		activeId = nextId;
		page = nextPage;
		if (activeChanged && nextId) onFocus(nextId);
		void focusActiveTarget(nextId, ownedRowFocus);
	});

	function handleWindowKeydown(event: KeyboardEvent): void {
		if (
			event.defaultPrevented ||
			event.key !== 'Escape' ||
			!dialog?.isConnected ||
			!isTopModalOwner(dialog)
		) return;
		event.preventDefault();
		event.stopPropagation();
		onClose();
	}

	function handleWindowFocusIn(): void {
		focusGeneration += 1;
	}

	function handleRowFocus(albumId: string): void {
		focusGeneration += 1;
		activeId = albumId;
		page = pageForId(albums, albumId);
		onFocus(albumId);
	}

	async function changePage(delta: -1 | 1): Promise<void> {
		const next = Math.max(0, Math.min(pageCount - 1, page + delta));
		if (next === page) return;
		const nextActiveId = pageSlice(albums, next)[0]?.id ?? null;
		page = next;
		activeId = nextActiveId;
		if (activeId) onFocus(activeId);
		onPageChange?.(next, pageCount);
		await focusActiveTarget(activeId, true);
	}

	async function moveActive(event: KeyboardEvent, albumId: string): Promise<void> {
		let nextIndex: number | null = null;
		const currentIndex = albums.findIndex((album) => album.id === albumId);
		if (event.key === 'ArrowDown') nextIndex = Math.min(albums.length - 1, currentIndex + 1);
		else if (event.key === 'ArrowUp') nextIndex = Math.max(0, currentIndex - 1);
		else if (event.key === 'Home') nextIndex = 0;
		else if (event.key === 'End') nextIndex = albums.length - 1;
		else if (event.shiftKey && event.key === 'F10') {
			event.preventDefault();
			onActions(albumId);
			return;
		}
		if (nextIndex === null || nextIndex < 0) return;
		event.preventDefault();
		activeId = albums[nextIndex].id;
		page = pageForId(albums, activeId);
		onFocus(activeId);
		await focusActiveTarget(activeId, true);
	}
</script>

<svelte:window onkeydown={handleWindowKeydown} onfocusin={handleWindowFocusIn} />

<div class="list-scrim">
	<div
		bind:this={dialog}
		class="timeline-list-overlay"
		role="dialog"
		aria-modal="true"
		aria-labelledby="timeline-list-title"
		tabindex="-1"
		data-mounted-row-count={visibleAlbums.length}
		use:focusTrap={{ initialFocus: '[data-list-initial="true"]', restoreFocus: false }}
	>
		<header>
			<div>
				<strong id="timeline-list-title">Browse active set as list</strong>
				<span>Text-only equivalent view · at most {TIMELINE_LIST_PAGE_SIZE} rows</span>
			</div>
			<nav aria-label="Timeline list pages">
				<button type="button" disabled={page === 0} onclick={() => void changePage(-1)}>Previous</button>
				<span>Page {page + 1} of {pageCount}</span>
				<button type="button" disabled={page + 1 >= pageCount} onclick={() => void changePage(1)}>Next</button>
			</nav>
			<button type="button" class="close-list" onclick={onClose}>Close</button>
		</header>

		<ol>
			{#each visibleAlbums as album (album.id)}
				<li data-timeline-list-row aria-current={album.id === selectedId ? 'true' : undefined}>
					<button
						type="button"
						class="album-list-choice"
						data-list-album-id={album.id}
						data-list-initial={album.id === initialFocusId ? 'true' : undefined}
						data-list-active={album.id === activeId ? 'true' : undefined}
						tabindex={album.id === activeId ? 0 : -1}
						aria-haspopup="menu"
						aria-keyshortcuts="Enter Shift+F10"
						onfocus={() => handleRowFocus(album.id)}
						onkeydown={(event) => void moveActive(event, album.id)}
						onclick={() => onChoose(album.id)}
					>
						<span class="ordinal">{album.ordinal + 1}</span>
						<span class="album-copy">
							<strong>{album.title}</strong>
							<small>{album.provenanceLabel ? `${album.provenanceLabel} · ` : ''}{album.artist} · {album.chronologyLabel}</small>
						</span>
						<span>Open</span>
					</button>
					<button
						type="button"
						class="row-actions"
						tabindex="-1"
						aria-label={`Actions for ${album.title}`}
						aria-haspopup="menu"
						onclick={() => onActions(album.id)}
					>Actions</button>
				</li>
			{/each}
		</ol>
	</div>
</div>

<style>
	.list-scrim {
		position: absolute;
		inset: 0;
		z-index: 11;
		display: grid;
		place-items: center;
		padding: 24px;
		background: rgb(0 0 0 / 0.58);
	}

	.timeline-list-overlay {
		display: grid;
		width: min(760px, 100%);
		max-height: min(720px, 100%);
		overflow: hidden;
		border: 1px solid color-mix(in srgb, var(--accent-2) 52%, var(--border));
		border-radius: 16px;
		background: var(--surface);
		box-shadow: 0 24px 72px rgb(0 0 0 / 0.44);
	}

	header {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto auto;
		align-items: center;
		gap: 16px;
		padding: 14px;
		border-bottom: 1px solid var(--border);
	}

	header > div {
		display: grid;
		gap: 3px;
	}

	header strong {
		font-size: 15px;
	}

	header span,
	small {
		color: var(--text-soft);
		font-size: 10px;
	}

	nav {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	button {
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--surface-2);
		color: var(--text);
		font: inherit;
		cursor: pointer;
	}

	button:disabled {
		opacity: 0.4;
		cursor: default;
	}

	button:focus-visible {
		outline: 2px solid var(--accent-2);
		outline-offset: 2px;
	}

	nav button,
	.close-list {
		padding: 7px 9px;
		font-size: 10px;
	}

	ol {
		display: grid;
		margin: 0;
		padding: 8px;
		overflow: auto;
		list-style: none;
	}

	li {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: stretch;
		gap: 6px;
		border-bottom: 1px solid color-mix(in srgb, var(--border) 64%, transparent);
	}

	li:last-child {
		border-bottom: 0;
	}

	li[aria-current='true'] {
		background: color-mix(in srgb, var(--accent) 9%, transparent);
	}

	.album-list-choice {
		display: grid;
		grid-template-columns: 34px minmax(0, 1fr) auto;
		align-items: center;
		gap: 10px;
		min-width: 0;
		padding: 9px;
		border-color: transparent;
		background: transparent;
		text-align: left;
	}

	.ordinal {
		color: var(--text-soft);
		font-size: 10px;
		font-variant-numeric: tabular-nums;
	}

	.album-copy {
		display: grid;
		min-width: 0;
		gap: 2px;
	}

	.album-copy strong,
	.album-copy small {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.row-actions {
		align-self: center;
		padding: 7px 9px;
		font-size: 10px;
	}

	@media (max-width: 720px) {
		header {
			grid-template-columns: 1fr auto;
		}

		header nav {
			grid-column: 1 / -1;
			grid-row: 2;
		}
	}
</style>
