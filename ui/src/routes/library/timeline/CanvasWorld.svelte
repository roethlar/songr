<script lang="ts">
	import { imageUrl } from '$lib/imageUrl';
	import {
		cameraCssTransform,
		type Camera,
		type ScreenViewport,
		type TimelineCanvasModel,
		type TimelineRenderPlan
	} from '$lib/timeline';
	import type { TimelineAlbumDetailViewModel } from '$lib/timeline/detailView';
	import type {
		TimelineBranchLayout,
		TimelineBranchRenderPlan
	} from '$lib/timeline/branchModel';
	import TimelineAlbumDetail from './TimelineAlbumDetail.svelte';
	import TimelineBranchLayer, {
		type TimelineBranchView
	} from './TimelineBranchLayer.svelte';

	let {
		model,
		plan,
		branchLayout,
		branchPlan,
		camera,
		viewport,
		detailView = null,
		detailAnchor = null,
		activeAlbumId = null,
		dragPreview = null,
		albumActivationEnabled = false,
		branchActivationEnabled = false,
		branchRetryEnabled = false,
		onAlbumActivate,
		onAlbumFocus,
		onAlbumKeydown,
		onAlbumActions,
		onBranchActivate,
		onBranchFocus,
		onBranchKeydown,
		onBranchActions,
		onBranchRetry,
		onBranchClose,
		onOpenTrackInClassic
	}: {
		model: TimelineCanvasModel;
		plan: TimelineRenderPlan;
		branchLayout: TimelineBranchLayout;
		branchPlan: TimelineBranchRenderPlan;
		camera: Camera;
		viewport: ScreenViewport;
		detailView?: TimelineAlbumDetailViewModel | null;
		detailAnchor?: { id: string; x: number; y: number; width: number; height: number } | null;
		activeAlbumId?: string | null;
		dragPreview?: {
			albumLocalId: string;
			offset: { dx: number; dy: number };
		} | null;
		albumActivationEnabled?: boolean;
		branchActivationEnabled?: boolean;
		branchRetryEnabled?: boolean;
		onAlbumActivate?: (albumLocalId: string) => void;
		onAlbumFocus?: (albumLocalId: string) => void;
		onAlbumKeydown?: (albumLocalId: string, event: KeyboardEvent) => void;
		onAlbumActions?: (albumLocalId: string, opener?: HTMLElement) => void;
		onBranchActivate?: (nodeId: string) => void;
		onBranchFocus?: (nodeId: string) => void;
		onBranchKeydown?: (nodeId: string, event: KeyboardEvent) => void;
		onBranchActions?: (nodeId: string, opener?: HTMLElement) => void;
		onBranchRetry?: (branchId: string) => void;
		onBranchClose?: (branchId: string) => void;
		onOpenTrackInClassic?: (trackTitle: string) => void;
	} = $props();

	let artworkIds = $derived(new Set(plan.artworkIds));
	let branchArtworkIds = $derived(new Set(branchPlan.artworkIds));
	let transform = $derived(cameraCssTransform(camera, viewport));
	let resolvedDetailAnchor = $derived(
		detailView
			? detailAnchor ?? model.entityById.get(detailView.album.localId) ?? null
			: null
	);
	let detailPosition = $derived(
		resolvedDetailAnchor ? displayPosition(resolvedDetailAnchor) : null
	);
	let branchViews = $derived.by<readonly TimelineBranchView[]>(() => {
		const visibleAlbumIds = new Set(branchPlan.albums.map((object) => object.id));
		const visibleHeaderIds = new Set(branchPlan.headers.map((object) => object.id));
		const visibleConnectorBranchIds = new Set(
			branchPlan.connectors.map((connector) => connector.branchId)
		);
		return branchLayout.groups
			.filter((group) => visibleHeaderIds.has(group.header.id))
			.map((group) => ({
				branchId: group.branchId,
				artistName: group.header.artistName,
				depth: group.depth,
				sourceX: group.source.x,
				sourceY: group.source.y,
				headerX: group.header.x,
				headerY: group.header.y,
				headerWidth: group.header.width,
				headerHeight: group.header.height,
				connectorVisible: visibleConnectorBranchIds.has(group.branchId),
				retryEnabled: branchRetryEnabled,
				status:
					group.phase === 'ready' && group.entities.length === 0
						? 'empty' as const
						: group.phase,
				message: group.error,
				candidateCount: group.header.catalogTotal,
				nodes: group.entities
					.filter((entity) => visibleAlbumIds.has(entity.id))
					.map((entity) => ({
						id: entity.id,
						albumLocalId: entity.albumLocalId,
						title: entity.title,
						artistName: entity.artist,
						chronologyLabel: entity.chronologyLabel,
						x: entity.x,
						y: entity.y,
						width: entity.width,
						height: entity.height,
						...(entity.imageKeyHint ? { imageKeyHint: entity.imageKeyHint } : {}),
						artworkAllowed: branchArtworkIds.has(entity.id),
						activationEnabled: branchActivationEnabled
					}))
			}));
	});

	function displayPosition(entity: {
		id: string;
		x: number;
		y: number;
		anchorX?: number;
		anchorY?: number;
	}): { x: number; y: number } {
		if (
			dragPreview?.albumLocalId !== entity.id ||
			entity.anchorX === undefined ||
			entity.anchorY === undefined
		) return { x: entity.x, y: entity.y };
		return {
			x: entity.anchorX + dragPreview.offset.dx,
			y: entity.anchorY + dragPreview.offset.dy
		};
	}

	function isFloating(
		entity: { anchorX: number; anchorY: number },
		position: { x: number; y: number }
	): boolean {
		return position.x !== entity.anchorX || position.y !== entity.anchorY;
	}
</script>

<div
	class="canvas-world"
	data-testid="timeline-canvas-world"
	data-semantic-tier={plan.tier}
	style:transform
>
	<div
		class="timeline-axis"
		aria-hidden="true"
		style:left={`${model.axis.startX}px`}
		style:width={`${model.axis.endX - model.axis.startX}px`}
	></div>

	{#each plan.visibleYearAnchors as anchor (anchor.year)}
		<div class="year-tick" aria-hidden="true" style:left={`${anchor.x}px`}>
			<span>{anchor.year}</span>
		</div>
	{/each}

	{#if plan.showUndatedAnchor && model.axis.undatedStartX !== null}
		<div class="undated-anchor" aria-hidden="true" style:left={`${model.axis.undatedStartX}px`}>
			<span>Undated</span>
		</div>
	{/if}

	<svg class="manual-tether-layer" aria-hidden="true">
		{#each plan.objects as object (`tether-${object.id}`)}
			{@const entity = object.kind === 'album' ? object.entity : null}
			{@const position = entity ? displayPosition(entity) : null}
			{@const isDragged = entity?.id === dragPreview?.albumLocalId}
			{#if entity && position && (isDragged || isFloating(entity, position))}
				<line
					data-timeline-tether={entity.id}
					x1={entity.anchorX}
					y1={entity.anchorY}
					x2={position.x}
					y2={position.y}
				></line>
				<circle cx={entity.anchorX} cy={entity.anchorY} r="4"></circle>
			{/if}
		{/each}
	</svg>

	<TimelineBranchLayer
		branches={branchViews}
		activeNodeId={activeAlbumId}
		onNodeActivate={onBranchActivate}
		onNodeFocus={onBranchFocus}
		onNodeKeydown={onBranchKeydown}
		onNodeActions={onBranchActions}
		onRetry={onBranchRetry}
		onClose={onBranchClose}
	/>

	{#each plan.objects as object (object.id)}
		{#if object.kind === 'cluster'}
			<div
				class="timeline-cluster"
				data-world-object
				data-cluster-count={object.memberCount}
				style:left={`${object.x}px`}
				style:top={`${object.y}px`}
				style:width={`${object.width}px`}
				style:height={`${object.height}px`}
				aria-label={`${object.title}, ${object.subtitle}`}
			>
				<strong>{object.memberCount}</strong>
				<span>{object.memberCount === 1 ? 'release' : 'releases'}</span>
				<small>{object.subtitle}</small>
			</div>
		{:else}
			{@const entity = object.entity}
			{@const position = displayPosition(entity)}
			{@const isDragged = entity.id === dragPreview?.albumLocalId}
			<button
				type="button"
				class="album-marker"
				class:above-axis={position.y < 0}
					class:below-axis={position.y > 0}
					class:pinned={object.pinned}
					class:floating={isFloating(entity, position)}
					class:dragging={isDragged}
					class:detail-unavailable={!albumActivationEnabled}
				data-world-object
				data-album-id={entity.id}
				data-manual-offset-x={position.x - entity.anchorX}
				data-manual-offset-y={position.y - entity.anchorY}
				style:left={`${position.x}px`}
				style:top={`${position.y}px`}
				style:width={`${entity.width}px`}
					style:height={`${entity.height}px`}
					aria-label={`${entity.title}, ${entity.chronologyLabel}${
						!albumActivationEnabled
							? '. Album detail unavailable; layout actions remain available with Shift+F10.'
							: ''
					}`}
				aria-haspopup="menu"
				aria-keyshortcuts="Enter Shift+F10"
				tabindex={entity.id === activeAlbumId ? 0 : -1}
				onfocus={() => onAlbumFocus?.(entity.id)}
				onkeydown={(event) => onAlbumKeydown?.(entity.id, event)}
				oncontextmenu={(event) => {
					event.preventDefault();
					onAlbumActions?.(entity.id, event.currentTarget);
				}}
				onclick={() => {
					if (albumActivationEnabled) onAlbumActivate?.(entity.id);
				}}
			>
				<span
					class="marker-stem"
					aria-hidden="true"
					style:height={`${Math.max(0, Math.abs(position.y) - entity.height / 2)}px`}
				></span>
				<span class="cover-frame" aria-hidden="true">
					{#if artworkIds.has(entity.id) && entity.imageKeyHint}
						<img
							data-timeline-artwork
							src={imageUrl(entity.imageKeyHint, { width: 192, height: 192 })}
							alt=""
							loading="lazy"
							draggable="false"
						/>
					{:else}
						<span class="cover-placeholder"></span>
					{/if}
				</span>
				<span class="album-copy">
					<strong>{entity.title}</strong>
					<span>{entity.chronologyLabel}</span>
				</span>
			</button>
		{/if}
	{/each}

	{#if detailView && resolvedDetailAnchor && detailPosition}
		<TimelineAlbumDetail
			view={detailView}
			x={detailPosition.x + resolvedDetailAnchor.width / 2 + 64}
			y={detailPosition.y}
			{onOpenTrackInClassic}
		/>
	{/if}
</div>

<style>
	.canvas-world {
		position: absolute;
		inset: 0 auto auto 0;
		width: 0;
		height: 0;
		transform-origin: 0 0;
		will-change: transform;
	}

	.timeline-axis {
		position: absolute;
		top: -1px;
		height: 1px;
		background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--text-soft) 46%, transparent) 8%, color-mix(in srgb, var(--text-soft) 46%, transparent) 92%, transparent);
	}

	.manual-tether-layer {
		position: absolute;
		inset: 0 auto auto 0;
		width: 1px;
		height: 1px;
		overflow: visible;
		pointer-events: none;
	}

	.manual-tether-layer line {
		stroke: color-mix(in srgb, var(--accent-2) 52%, var(--text-soft));
		stroke-width: 1;
		stroke-dasharray: 5 5;
		vector-effect: non-scaling-stroke;
	}

	.manual-tether-layer circle {
		fill: var(--surface);
		stroke: color-mix(in srgb, var(--accent-2) 68%, var(--border));
		stroke-width: 1;
		vector-effect: non-scaling-stroke;
	}

	.year-tick,
	.undated-anchor {
		position: absolute;
		top: -5px;
		width: 1px;
		height: 10px;
		background: color-mix(in srgb, var(--text-soft) 44%, transparent);
	}

	.year-tick span,
	.undated-anchor span {
		position: absolute;
		top: 14px;
		left: 50%;
		translate: -50% 0;
		color: color-mix(in srgb, var(--text-soft) 78%, transparent);
		font-size: 11px;
		line-height: 1;
		white-space: nowrap;
	}

	.undated-anchor {
		height: 18px;
		background: color-mix(in srgb, var(--accent-2) 62%, transparent);
	}

	.album-marker,
	.timeline-cluster {
		position: absolute;
		translate: -50% -50%;
		box-sizing: border-box;
		contain: layout paint style;
	}

	.album-marker {
		display: grid;
		grid-template-columns: 56px minmax(0, 1fr);
		align-content: center;
		align-items: center;
		gap: 10px;
		padding: 8px;
		border: 1px solid color-mix(in srgb, var(--border) 78%, transparent);
		border-radius: 14px;
		background: color-mix(in srgb, var(--surface) 90%, transparent);
		color: var(--text);
		font: inherit;
		text-align: left;
		cursor: pointer;
	}

	.album-marker.detail-unavailable {
		cursor: context-menu;
		opacity: 0.78;
	}

	.album-marker:focus-visible {
		outline: 2px solid var(--accent-2);
		outline-offset: 3px;
	}

	.album-marker.pinned {
		border-color: color-mix(in srgb, var(--accent-2) 75%, var(--border));
	}

	.album-marker.floating {
		border-color: color-mix(in srgb, var(--accent-2) 62%, var(--border));
	}

	.album-marker.dragging {
		will-change: left, top;
		cursor: grabbing;
	}

	.album-marker.floating .marker-stem {
		display: none;
	}

	.marker-stem {
		position: absolute;
		left: 50%;
		width: 1px;
		background: color-mix(in srgb, var(--text-soft) 42%, transparent);
	}

	.above-axis .marker-stem {
		top: 100%;
	}

	.below-axis .marker-stem {
		bottom: 100%;
	}

	.cover-frame,
	.cover-placeholder,
	.cover-frame img {
		display: block;
		width: 56px;
		height: 56px;
		border-radius: 9px;
	}

	.cover-frame {
		overflow: hidden;
		background: color-mix(in srgb, var(--surface-3) 84%, transparent);
	}

	.cover-frame img {
		object-fit: cover;
	}

	.cover-placeholder {
		background:
			linear-gradient(145deg, color-mix(in srgb, var(--accent) 26%, transparent), transparent 62%),
			color-mix(in srgb, var(--surface-3) 94%, transparent);
	}

	.album-copy {
		display: grid;
		min-width: 0;
		gap: 5px;
	}

	.album-copy strong {
		overflow: hidden;
		font-size: 13px;
		font-weight: 650;
		line-height: 1.2;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.album-copy span {
		color: var(--text-soft);
		font-size: 11px;
		line-height: 1.1;
	}

	.timeline-cluster {
		display: grid;
		place-content: center;
		justify-items: center;
		gap: 1px;
		border: 1px solid color-mix(in srgb, var(--accent-2) 42%, var(--border));
		border-radius: 50%;
		background: color-mix(in srgb, var(--surface-2) 92%, transparent);
		color: var(--text);
		text-align: center;
	}

	.timeline-cluster strong {
		font-size: 19px;
		line-height: 1;
	}

	.timeline-cluster span,
	.timeline-cluster small {
		font-size: 10px;
		line-height: 1.1;
	}

	.timeline-cluster small {
		max-width: 88px;
		overflow: hidden;
		color: var(--text-soft);
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.canvas-world[data-semantic-tier='overview'] .album-marker {
		grid-template-columns: 1fr;
		justify-items: center;
	}

	.canvas-world[data-semantic-tier='overview'] .cover-frame {
		display: none;
	}

	.canvas-world[data-semantic-tier='detail'] .album-marker {
		border-color: color-mix(in srgb, var(--text-soft) 42%, var(--border));
	}
</style>
