<script lang="ts">
	import { imageUrl } from '$lib/imageUrl';

	export type TimelineBranchViewStatus = 'loading' | 'ready' | 'empty' | 'error';

	export interface TimelineBranchNodeView {
		readonly id: string;
		readonly albumLocalId: string;
		readonly title: string;
		readonly artistName: string;
		readonly chronologyLabel: string;
		readonly x: number;
		readonly y: number;
		readonly width: number;
		readonly height: number;
		readonly imageKeyHint?: string;
		readonly artworkAllowed?: boolean;
		readonly activationEnabled?: boolean;
	}

	export interface TimelineBranchView {
		readonly branchId: string;
		readonly artistName: string;
		readonly depth: 1 | 2;
		readonly sourceX: number;
		readonly sourceY: number;
		readonly headerX: number;
		readonly headerY: number;
		readonly headerWidth?: number;
		readonly headerHeight?: number;
		readonly connectorVisible?: boolean;
		readonly retryEnabled?: boolean;
		readonly status: TimelineBranchViewStatus;
		readonly message?: string | null;
		readonly candidateCount?: number;
		readonly nodes: readonly TimelineBranchNodeView[];
	}

	let {
		branches = [],
		activeNodeId = null,
		onNodeActivate,
		onNodeFocus,
		onNodeKeydown,
		onNodeActions,
		onRetry,
		onClose
	}: {
		branches?: readonly TimelineBranchView[];
		activeNodeId?: string | null;
		onNodeActivate?: (nodeId: string) => void;
		onNodeFocus?: (nodeId: string) => void;
		onNodeKeydown?: (nodeId: string, event: KeyboardEvent) => void;
		onNodeActions?: (nodeId: string, opener?: HTMLElement) => void;
		onRetry?: (branchId: string) => void;
		onClose?: (branchId: string) => void;
	} = $props();

	let visibleBranches = $derived(
		branches.filter((branch) => branch.depth === 1 || branch.depth === 2).slice(0, 3)
	);

	function stopPointer(event: PointerEvent): void {
		event.stopPropagation();
	}
</script>

<div class="timeline-branch-layer" data-testid="timeline-branch-layer">
	{#each visibleBranches as branch (branch.branchId)}
		{@const visibleNodes = branch.nodes.slice(0, 8)}
		{#if branch.connectorVisible !== false}
			<svg class="branch-connector-layer" aria-hidden="true" focusable="false">
				<line
					data-timeline-branch-connector={branch.branchId}
					x1={branch.sourceX}
					y1={branch.sourceY}
					x2={branch.headerX}
					y2={branch.headerY}
				></line>
			</svg>
		{/if}

		<section
			class="branch-header"
			class:branch-error={branch.status === 'error'}
			data-world-object
			data-timeline-branch-id={branch.branchId}
			data-timeline-branch-depth={branch.depth}
			role="group"
			aria-label={`Artist branch for ${branch.artistName}`}
			style:left={`${branch.headerX}px`}
			style:top={`${branch.headerY}px`}
			style:width={`${branch.headerWidth ?? 244}px`}
			style:height={`${branch.headerHeight ?? 132}px`}
			onpointerdown={stopPointer}
		>
			<div class="branch-provenance">
				<strong>Artist search · {branch.artistName}</strong>
				<span>User-attached branch</span>
			</div>
			{#if branch.status === 'loading'}
				<p role="status" aria-live="polite">Loading artist albums…</p>
			{:else if branch.status === 'error'}
				<p role="alert">{branch.message ?? 'This artist branch could not be loaded.'}</p>
			{:else if branch.status === 'empty'}
				<p role="status">No albums found for this artist.</p>
			{:else}
				<p>{visibleNodes.length} of {Math.max(visibleNodes.length, branch.candidateCount ?? visibleNodes.length)} shown</p>
			{/if}
			<div class="branch-controls">
				{#if branch.status === 'error'}
					<button
						type="button"
						data-world-object
						data-timeline-branch-control="retry"
						disabled={onRetry === undefined || branch.retryEnabled === false}
						onpointerdown={stopPointer}
						onclick={() => onRetry?.(branch.branchId)}
					>Retry artist branch</button>
				{/if}
				<button
					type="button"
					data-world-object
					data-timeline-branch-control="close"
					disabled={onClose === undefined}
					onpointerdown={stopPointer}
					onclick={() => onClose?.(branch.branchId)}
				>Close artist branch</button>
			</div>
		</section>

		{#each visibleNodes as node (node.id)}
			<button
				type="button"
				class="branch-album-marker"
				class:detail-unavailable={node.activationEnabled === false}
				data-world-object
				data-timeline-node-id={node.id}
				data-timeline-branch-owner-id={branch.branchId}
				data-album-local-id={node.albumLocalId}
				style:left={`${node.x}px`}
				style:top={`${node.y}px`}
				style:width={`${node.width}px`}
				style:height={`${node.height}px`}
				aria-label={`${node.title}, ${node.chronologyLabel}, ${node.artistName}. Artist search; User-attached branch.${
					node.activationEnabled === false ? ' Album detail unavailable.' : ''
				}`}
				aria-haspopup="menu"
				aria-keyshortcuts="Enter Shift+F10"
				tabindex={node.id === activeNodeId ? 0 : -1}
				onpointerdown={stopPointer}
				onfocus={() => onNodeFocus?.(node.id)}
				onkeydown={(event) => onNodeKeydown?.(node.id, event)}
				oncontextmenu={(event) => {
					event.preventDefault();
					event.stopPropagation();
					onNodeActions?.(node.id, event.currentTarget);
				}}
				onclick={() => {
					if (node.activationEnabled !== false) onNodeActivate?.(node.id);
				}}
			>
				<span class="branch-cover" aria-hidden="true">
					{#if node.artworkAllowed && node.imageKeyHint}
						<img
							data-timeline-artwork
							src={imageUrl(node.imageKeyHint, { width: 192, height: 192 })}
							alt=""
							loading="lazy"
							draggable="false"
						/>
					{:else}
						<span class="branch-cover-placeholder"></span>
					{/if}
				</span>
				<span class="branch-album-copy">
					<strong>{node.title}</strong>
					<span>{node.chronologyLabel}</span>
				</span>
			</button>
		{/each}
	{/each}
</div>

<style>
	.timeline-branch-layer {
		position: absolute;
		inset: 0 auto auto 0;
		width: 0;
		height: 0;
	}

	.branch-connector-layer {
		position: absolute;
		inset: 0 auto auto 0;
		width: 1px;
		height: 1px;
		overflow: visible;
		pointer-events: none;
	}

	.branch-connector-layer line {
		stroke: color-mix(in srgb, var(--accent-2) 46%, var(--text-soft));
		stroke-width: 1;
		stroke-dasharray: 5 5;
		vector-effect: non-scaling-stroke;
	}

	.branch-header,
	.branch-album-marker {
		position: absolute;
		translate: -50% -50%;
		box-sizing: border-box;
		contain: layout paint style;
	}

	.branch-header {
		display: grid;
		gap: 8px;
		padding: 10px;
		border: 1px solid color-mix(in srgb, var(--accent-2) 48%, var(--border));
		border-radius: 12px;
		background: color-mix(in srgb, var(--surface) 94%, transparent);
		color: var(--text);
		overflow: hidden;
	}

	.branch-header.branch-error {
		border-color: color-mix(in srgb, var(--danger, #d06b6b) 62%, var(--border));
	}

	.branch-provenance {
		display: grid;
		gap: 2px;
	}

	.branch-provenance strong {
		overflow: hidden;
		font-size: 11px;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.branch-provenance span,
	.branch-header p {
		margin: 0;
		color: var(--text-soft);
		font-size: 9px;
		line-height: 1.35;
	}

	.branch-header p {
		display: -webkit-box;
		overflow: hidden;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
	}

	.branch-controls {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.branch-controls button {
		padding: 5px 7px;
		border: 1px solid var(--border);
		border-radius: 7px;
		background: var(--surface-2);
		color: var(--text);
		font: inherit;
		font-size: 9px;
		cursor: pointer;
	}

	.branch-controls button:disabled {
		opacity: 0.46;
		cursor: default;
	}

	.branch-controls button:focus-visible,
	.branch-album-marker:focus-visible {
		outline: 2px solid var(--accent-2);
		outline-offset: 3px;
	}

	.branch-album-marker {
		display: grid;
		grid-template-columns: 48px minmax(0, 1fr);
		align-content: center;
		align-items: center;
		gap: 9px;
		padding: 7px;
		border: 1px solid color-mix(in srgb, var(--accent-2) 38%, var(--border));
		border-radius: 12px;
		background: color-mix(in srgb, var(--surface) 91%, transparent);
		color: var(--text);
		font: inherit;
		text-align: left;
		cursor: pointer;
	}

	.branch-album-marker.detail-unavailable {
		opacity: 0.72;
		cursor: context-menu;
	}

	.branch-cover,
	.branch-cover-placeholder,
	.branch-cover img {
		display: block;
		width: 48px;
		height: 48px;
		border-radius: 7px;
	}

	.branch-cover {
		overflow: hidden;
		background: var(--surface-2);
	}

	.branch-cover img {
		object-fit: cover;
	}

	.branch-cover-placeholder {
		background:
			linear-gradient(145deg, color-mix(in srgb, var(--accent-2) 16%, transparent), transparent),
			var(--surface-2);
	}

	.branch-album-copy {
		display: grid;
		min-width: 0;
		gap: 3px;
	}

	.branch-album-copy strong {
		overflow: hidden;
		font-size: 11px;
		line-height: 1.2;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.branch-album-copy span {
		color: var(--text-soft);
		font-size: 9px;
	}
</style>
