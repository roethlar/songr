<script lang="ts">
	import { tick } from 'svelte';
	import type { AlbumActionSemantic } from '@shared/albumActionContracts';
	import type { LibraryAlbumCandidate } from '@shared/libraryAlbumContracts';
	import { normalizeCatalogText } from '@shared/timelineCatalogContracts';
	import { imageUrl } from '$lib/imageUrl';
	import { trackTitleCarriesOrdinal } from '$lib/trackTitle';
	import type { LibraryAlbumController } from '$lib/library/LibraryAlbumController';
	import type { LibraryAlbumEntry } from '$lib/stores/libraryIndexStore';
	import type { TimelineAlbumActionController } from '$lib/timeline/TimelineAlbumActionController';

	interface ZoneOption {
		readonly zoneId: string;
		readonly name: string;
	}

	type SheetTrackTarget = { readonly index: number; readonly title: string };

	interface PendingActionTarget {
		readonly track: SheetTrackTarget | null;
		readonly desiredSemantic: AlbumActionSemantic;
	}

	interface Props {
		controller: LibraryAlbumController;
		actionController: TimelineAlbumActionController;
		zones: readonly ZoneOption[];
		album?: LibraryAlbumEntry | null;
		focusSongTitle?: string | null;
		onClose: () => void;
		onRetry: () => void;
		onChooseCandidate: (candidate: LibraryAlbumCandidate) => void;
		onBeginAction: (
			track: SheetTrackTarget | null,
			zoneId: string,
			desiredSemantic: AlbumActionSemantic
		) => void;
		onOpenArtist?: () => void;
	}

	const {
		controller,
		actionController,
		zones,
		album = null,
		focusSongTitle = null,
		onClose,
		onRetry,
		onChooseCandidate,
		onBeginAction,
		onOpenArtist
	}: Props = $props();

	const PAGE_SIZE = 100;

	let page = $state(0);
	let trackList: HTMLOListElement | null = $state(null);
	let actionTarget = $state<PendingActionTarget | undefined>(undefined);

	const sheet = $derived($controller);
	const action = $derived($actionController);
	const pageCount = $derived(Math.max(1, Math.ceil(sheet.orderedTracks.length / PAGE_SIZE)));
	const pageTracks = $derived(
		sheet.orderedTracks.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
	);
	// Suppress the derived row index per rendered page (never per row, which
	// would jag the title column): when every title on the page carries Roon's
	// own ordinal, Roon's ordinal is authoritative and our index is the defect.
	const suppressRowIndex = $derived(
		pageTracks.length > 0 && pageTracks.every((track) => trackTitleCarriesOrdinal(track.title))
	);
	const focusedTrackPosition = $derived.by(() => {
		if (!focusSongTitle) return -1;
		const normalizedTitle = normalizeCatalogText(focusSongTitle);
		if (!normalizedTitle) return -1;
		const exactMatches: number[] = [];
		sheet.orderedTracks.forEach((track, position) => {
			if (normalizeCatalogText(track.title) === normalizedTitle) {
				exactMatches.push(position);
			}
		});
		if (exactMatches.length > 0) {
			return exactMatches.length === 1 ? exactMatches[0] : -1;
		}

		const ordinalMatches: number[] = [];
		sheet.orderedTracks.forEach((track, position) => {
			const trackTitleWithoutOrdinal = normalizeCatalogText(track.title).replace(
				/^\d+\.\s+/,
				''
			);
			if (trackTitleWithoutOrdinal === normalizedTitle) {
				ordinalMatches.push(position);
			}
		});
		return ordinalMatches.length === 1 ? ordinalMatches[0] : -1;
	});
	const focusedTrackIndex = $derived(
		focusedTrackPosition < 0
			? null
			: sheet.orderedTracks[focusedTrackPosition]?.index ?? null
	);
	const actionBusy = $derived(
		action.phase === 'resolving' || action.phase === 'choosing' || action.phase === 'executing'
	);
	const displayTitle = $derived(sheet.title ?? album?.title ?? 'Album');
	const displayArtist = $derived(sheet.artist ?? album?.artist ?? '');
	const displayImageKey = $derived(album?.imageKey ?? null);

	$effect(() => {
		void sheet.orderedTracks;
		const focusPosition = focusedTrackPosition;
		// A new resolution restarts paging unless exactly one normalized title
		// match identifies the page the requested song appears on.
		page = focusPosition >= 0 ? Math.floor(focusPosition / PAGE_SIZE) : 0;
		actionTarget = undefined;
		if (focusPosition >= 0) {
			void tick().then(() => {
				const highlighted = trackList?.querySelector<HTMLElement>(
					'[data-song-highlight="true"]'
				);
				highlighted?.scrollIntoView?.({ block: 'center' });
			});
		}
	});

	function monogram(title: string): { style: string; letter: string } {
		const word = title.replace(/^(the |a |an )/i, '').trim() || '?';
		let hash = 0;
		for (const character of word) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
		return {
			style: `background:linear-gradient(150deg,hsl(${hash % 360},14%,20%),hsl(${(hash + 40) % 360},12%,11%))`,
			letter: (word[0] ?? '?').toUpperCase()
		};
	}

	function pickTarget(
		track: SheetTrackTarget | null,
		desiredSemantic: AlbumActionSemantic
	): void {
		if (!sheet.actionsAvailable || actionBusy || zones.length === 0) return;
		if (zones.length === 1) {
			onBeginAction(track, zones[0].zoneId, desiredSemantic);
			actionTarget = undefined;
			return;
		}
		actionTarget = { track, desiredSemantic };
	}

	function chooseZone(zoneId: string): void {
		if (!sheet.actionsAvailable || actionTarget === undefined) return;
		onBeginAction(actionTarget.track, zoneId, actionTarget.desiredSemantic);
		actionTarget = undefined;
	}

	function zonePrompt(target: PendingActionTarget): string {
		const verb =
			target.desiredSemantic === 'queue'
				? 'Queue'
				: target.desiredSemantic === 'add-next'
					? 'Add next'
					: 'Play';
		return target.track === null
			? `${verb} album on`
			: `${verb} “${target.track.title}” on`;
	}
</script>

<div
	class="sheet open"
	data-testid="unified-album-sheet"
	role="presentation"
	onclick={(event) => event.target === event.currentTarget && onClose()}
>
	<div class="panel" role="dialog" aria-modal="true" aria-label="Album">
		<button type="button" class="x" aria-label="Cancel" onclick={onClose}>×</button>

		<div class="pleft">
			<div class="art">
				{#if displayImageKey}
					<img
						src={imageUrl(displayImageKey, { scale: 'fit', width: 300, height: 300 })}
						alt=""
						loading="lazy"
					/>
				{:else}
					{@const fallback = monogram(displayTitle)}
					<div class="mono-tile" style={fallback.style}>{fallback.letter}</div>
				{/if}
			</div>
			<div class="pb">
				<button
					type="button"
					data-testid="unified-album-play"
					disabled={!sheet.actionsAvailable ||
						sheet.phase !== 'resolved' ||
						actionBusy ||
						zones.length === 0}
					onclick={() => pickTarget(null, 'play-now')}
				>
					Play album
				</button>
				<button
					type="button"
					data-testid="unified-album-queue"
					disabled={!sheet.actionsAvailable ||
						sheet.phase !== 'resolved' ||
						actionBusy ||
						zones.length === 0}
					onclick={() => pickTarget(null, 'queue')}
				>
					Queue album
				</button>
				<button
					type="button"
					data-testid="unified-album-artist-link"
					disabled={!onOpenArtist}
					onclick={onOpenArtist}
				>
					All by artist
				</button>
			</div>
		</div>

		<div class="pright">
			<div class="pt" data-testid="unified-album-title">{displayTitle}</div>
			<div class="pa" data-testid="unified-album-artist">{displayArtist}</div>

			{#if actionTarget !== undefined && zones.length > 1}
				<div class="zone-picker" data-testid="unified-album-zone-picker">
					<span class="zone-label">
						{zonePrompt(actionTarget)}
					</span>
					{#each zones as zone (zone.zoneId)}
						<button type="button" onclick={() => chooseZone(zone.zoneId)}>{zone.name}</button>
					{/each}
					<button type="button" class="ghost" onclick={() => (actionTarget = undefined)}>
						Cancel
					</button>
				</div>
			{/if}

			{#if action.phase === 'choosing'}
				<div class="action-choices" data-testid="unified-album-action-choices">
					{#each action.actions as choice (choice.actionId)}
						<button type="button" onclick={() => actionController.execute(choice.actionId)}>
							{choice.label}
						</button>
					{/each}
					<button type="button" class="ghost" onclick={() => actionController.cancel()}>
						Cancel
					</button>
				</div>
			{:else if action.phase === 'resolving' || action.phase === 'executing'}
				<p class="status" data-testid="unified-album-action-busy">Working…</p>
			{:else if action.phase === 'failed' || action.phase === 'outcome-unknown'}
				<p class="status error" data-testid="unified-album-action-error">
					{action.error ?? 'The action failed.'}
				</p>
			{/if}

			{#if sheet.phase === 'resolving'}
				<div class="tl">
					<p class="status" data-testid="unified-album-loading">Opening album…</p>
				</div>
				<div class="stub">Loading the track list from your Core.</div>
			{:else if sheet.phase === 'failed' && sheet.candidates.length > 0}
				<div class="tl">
					<p class="status" data-testid="unified-album-ambiguous">
						This album exists in more than one edition. Pick the one to open.
					</p>
					<ul class="candidates" data-testid="unified-album-candidates">
						{#each sheet.candidates as candidate (candidate.title + '\u0000' + candidate.editionText)}
							<li>
								<button
									type="button"
									class="candidate"
									onclick={() => onChooseCandidate(candidate)}
								>
									<span class="candidate-title">{candidate.title}</span>
									{#if candidate.editionText}
										<span class="candidate-edition">{candidate.editionText}</span>
									{/if}
									<span class="candidate-artist">{candidate.artist}</span>
								</button>
							</li>
						{/each}
					</ul>
				</div>
				<div class="stub">Choose an edition to load its tracks.</div>
			{:else if sheet.phase === 'failed' || sheet.phase === 'canceled'}
				<div class="tl">
					<p class="status error" data-testid="unified-album-error">
						{sheet.error ?? 'The album could not be opened.'}
					</p>
					<button type="button" class="retry" onclick={onRetry} data-testid="unified-album-retry">
						Try again
					</button>
				</div>
				<div class="stub">Track data is unavailable until the catalog resolves this album.</div>
			{:else if sheet.phase === 'resolved'}
				<ol
					class="tl tracks"
					data-testid="unified-album-tracks"
					start={page * PAGE_SIZE + 1}
					bind:this={trackList}
				>
					{#each pageTracks as track, offset (track.index)}
						<li
							class="tr"
							class:song-focus={track.index === focusedTrackIndex}
							data-testid="unified-track-row-{track.index}"
							data-song-highlight={track.index === focusedTrackIndex ? 'true' : undefined}
						>
							{#if !suppressRowIndex}
								<span class="tn mono">{page * PAGE_SIZE + offset + 1}</span>
							{/if}
							<span class="tnm">{track.title}</span>
							<button
								type="button"
								class="tgo"
								data-testid="unified-track-action-{track.index}"
								disabled={!sheet.actionsAvailable || actionBusy || zones.length === 0}
								onclick={() =>
									pickTarget({ index: track.index, title: track.title }, 'play-now')}
							>
								Play
							</button>
							<button
								type="button"
								class="tq"
								data-testid="unified-track-queue-{track.index}"
								disabled={!sheet.actionsAvailable || actionBusy || zones.length === 0}
								onclick={() => pickTarget({ index: track.index, title: track.title }, 'queue')}
							>
								Queue
							</button>
						</li>
					{/each}
				</ol>

				{#if pageCount > 1}
					<nav class="pager" data-testid="unified-album-pager" aria-label="Track pages">
						<button
							type="button"
							disabled={page === 0}
							onclick={() => (page = Math.max(0, page - 1))}
						>
							Previous
						</button>
						<span class="page-label">Page {page + 1} of {pageCount}</span>
						<button
							type="button"
							disabled={page >= pageCount - 1}
							onclick={() => (page = Math.min(pageCount - 1, page + 1))}
						>
							Next
						</button>
					</nav>
				{/if}
				<div class="stub">{sheet.orderedTracks.length} tracks loaded from your Core.</div>
			{/if}
		</div>
	</div>
</div>

<style>
	.status {
		margin: 0;
		opacity: 0.75;
		font-size: 13px;
	}
	.status.error {
		opacity: 1;
		color: var(--error, #e66);
	}
	.zone-picker,
	.action-choices {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		margin-top: 12px;
	}
	.zone-label {
		font-size: 13px;
		opacity: 0.75;
	}
	.candidates {
		list-style: none;
		margin: 12px 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.candidate {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 2px;
		width: 100%;
		text-align: left;
		padding: 8px 10px;
	}
	.candidate-edition,
	.candidate-artist {
		font-size: 12px;
		opacity: 0.7;
	}
	.tracks {
		list-style: none;
		margin-bottom: 0;
		padding-left: 0;
	}

	.tr.song-focus {
		border-color: color-mix(in srgb, var(--accent) 70%, transparent);
		background: color-mix(in srgb, var(--accent) 18%, #111);
		box-shadow: inset 3px 0 0 var(--accent);
	}
	.pager {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-top: 8px;
	}
	.page-label {
		font-size: 12px;
		opacity: 0.7;
	}
	.ghost {
		opacity: 0.7;
	}
	.retry {
		margin-top: 12px;
	}
</style>
