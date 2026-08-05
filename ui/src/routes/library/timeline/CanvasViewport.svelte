<script lang="ts">
	import { onMount } from 'svelte';
	import {
		TimelineRenderPlanner,
		createTimelineBranchRenderPlan,
		type Camera,
		type ScreenViewport,
		type SemanticZoomTier,
		type TimelineCanvasModel
	} from '$lib/timeline';
	import type { TimelineBranchLayout } from '$lib/timeline/branchModel';
	import {
		TimelineGestureController,
		type TimelineAlbumDragCancel,
		type TimelineAlbumDragCommit,
		type TimelineAlbumDragPreview,
		type TimelineAlbumDropHitTest,
		type TimelineAlbumDropTarget,
		type TimelineAlbumTap,
		type TimelineCameraGestureCancel,
		type TimelineCameraGestureCommit,
		type TimelineCameraGesturePreview,
		type TimelineWheelIdle
	} from '$lib/timeline/TimelineGestureController';
	import type { TimelineManualOffset } from '$lib/timeline/manualPlacement';
	import type { TimelineAlbumDetailViewModel } from '$lib/timeline/detailView';
	import { inertSubtree } from '$lib/actions/inertSubtree';
	import CanvasWorld from './CanvasWorld.svelte';

	type TimelineCanvasGestureControls = {
		cancelActive(): boolean;
		cancelWheel(): void;
		resumeRuntime(): void;
		suspendRuntime(): void;
	};

	let {
		model,
		branchLayout,
		camera,
		viewport,
		activeAlbumId = null,
		previousTier,
		detailView = null,
		detailAnchor = null,
		spatialInert = false,
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
		onOpenTrackInClassic,
		onAlbumGestureStart,
		onAlbumDragPreview,
		resolveAlbumDropTarget,
		onAlbumDragCommit,
		onAlbumDragCancel,
		onAlbumTap,
		onCameraPreview,
		onCameraCommit,
		onCameraCancel,
		onWheelIdle,
		onGestureControls
	}: {
		model: TimelineCanvasModel;
		branchLayout: TimelineBranchLayout;
		camera: Camera;
		viewport: ScreenViewport;
		activeAlbumId?: string | null;
		previousTier?: SemanticZoomTier;
		detailView?: TimelineAlbumDetailViewModel | null;
		detailAnchor?: { id: string; x: number; y: number; width: number; height: number } | null;
		spatialInert?: boolean;
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
		onAlbumGestureStart?: (
			gestureId: number,
			albumLocalId: string,
			preOffset: TimelineManualOffset | null
		) => boolean;
		onAlbumDragPreview?: (preview: TimelineAlbumDragPreview) => void;
		resolveAlbumDropTarget?: (
			request: TimelineAlbumDropHitTest
		) => TimelineAlbumDropTarget | null;
		onAlbumDragCommit?: (commit: TimelineAlbumDragCommit) => void;
		onAlbumDragCancel?: (cancel: TimelineAlbumDragCancel) => void;
		onAlbumTap?: (tap: TimelineAlbumTap) => void;
		onCameraPreview?: (preview: TimelineCameraGesturePreview) => void;
		onCameraCommit?: (commit: TimelineCameraGestureCommit) => void;
		onCameraCancel?: (cancel: TimelineCameraGestureCancel) => void;
		onWheelIdle?: (idle: TimelineWheelIdle) => void;
		onGestureControls?: (controls: TimelineCanvasGestureControls | null) => void;
	} = $props();

	let viewportElement: HTMLElement;
	let controller = $state<TimelineGestureController | null>(null);
	let dragPreview = $state<TimelineAlbumDragPreview | null>(null);
	let armedAlbumId = $state<string | null>(null);
	let activeGestureKind = $state<'album-armed' | 'album-drag' | 'pan' | null>(null);
	let spaceKey = false;
	const capturedGestureByPointer = new Map<number, number>();
	let observedModel: TimelineCanvasModel | null = null;
	let observedViewport: string | null = null;
	let runtimeActive = false;
	let windowListenersAttached = false;

	let planner = $derived(new TimelineRenderPlanner(model));
	let detailWorldObjects = $derived(detailView ? 1 : 0);
	let detailArtworkImages = $derived(detailView?.album.imageKeyHint ? 1 : 0);
	let interactingBaseAlbumId = $derived(dragPreview?.albumLocalId ?? armedAlbumId);
	let branchPinnedId = $derived(
		interactingBaseAlbumId === null && branchLayout.entityById.has(activeAlbumId ?? '')
			? activeAlbumId
			: null
	);
	let basePinnedId = $derived(
		interactingBaseAlbumId ??
		(branchLayout.entityById.has(activeAlbumId ?? '') ? null : activeAlbumId)
	);
	let branchPlan = $derived(createTimelineBranchRenderPlan(branchLayout, camera, viewport, {
		pinnedId: branchPinnedId,
		previousTier,
		reservedWorldObjects: detailWorldObjects,
		reservedArtworkImages: detailArtworkImages
	}));
	let plan = $derived(planner.createPlan(camera, viewport, {
		pinnedId: basePinnedId,
		previousTier,
		reservedWorldObjects: detailWorldObjects + branchPlan.counts.worldObjects,
		reservedArtworkImages: detailArtworkImages + branchPlan.counts.artworkImages
	}));
	let worldObjectCount = $derived(
		plan.counts.worldObjects + branchPlan.counts.worldObjects + detailWorldObjects
	);
	let artworkImageCount = $derived(
		plan.counts.artworkImages + branchPlan.counts.artworkImages + detailArtworkImages
	);

	function pointerIdentity(event: PointerEvent) {
		if (!runtimeActive) return null;
		const active = controller?.activeGesture();
		if (!active || active.pointerId !== event.pointerId) return null;
		return { pointerId: active.pointerId, gestureId: active.gestureId };
	}

	function albumTarget(event: Event): HTMLElement | null {
		return event.target instanceof Element
			? event.target.closest<HTMLElement>('[data-album-id]')
			: null;
	}

	function excludesPrimaryCanvasPan(event: PointerEvent): boolean {
		if (!(event.target instanceof Element)) return false;
		return event.target.closest(
			'[data-album-detail-id], a[href], input, select, textarea, [contenteditable="true"], [role="menuitem"]'
		) !== null;
	}

	function localWheelPoint(event: WheelEvent): { x: number; y: number } {
		const bounds = viewportElement.getBoundingClientRect();
		return {
			x: viewport.x + event.clientX - bounds.left,
			y: viewport.y + event.clientY - bounds.top
		};
	}

	function preOffsetFor(albumLocalId: string): TimelineManualOffset | null {
		const entity = model.entityById.get(albumLocalId);
		if (!entity) return null;
		const dx = entity.x - entity.anchorX;
		const dy = entity.y - entity.anchorY;
		return dx === 0 && dy === 0 ? null : { dx, dy };
	}

	function capturePointer(pointerId: number, gestureId: number): void {
		capturedGestureByPointer.set(pointerId, gestureId);
		if (typeof viewportElement?.setPointerCapture !== 'function') return;
		try {
			viewportElement.setPointerCapture(pointerId);
		} catch {
			queueMicrotask(() => controller?.escape());
		}
	}

	function releasePointer(pointerId: number): void {
		try {
			if (
				typeof viewportElement?.releasePointerCapture === 'function' &&
				(typeof viewportElement.hasPointerCapture !== 'function' ||
					viewportElement.hasPointerCapture(pointerId))
			) {
				viewportElement.releasePointerCapture(pointerId);
			}
		} catch {
			// Capture may already have been released by the browser. The controller
			// is terminal before this callback and must still settle its commit.
		} finally {
			capturedGestureByPointer.delete(pointerId);
		}
	}

	function clearAlbumGesture(): void {
		dragPreview = null;
		armedAlbumId = null;
		activeGestureKind = null;
	}

	function handlePointerDown(event: PointerEvent): void {
		if (
			!runtimeActive ||
			!controller ||
			spatialInert ||
			event.defaultPrevented ||
			event.isPrimary === false
		) return;
		const marker = albumTarget(event);
		const forcedPan = event.button === 1 || (event.button === 0 && spaceKey);
		if (!forcedPan && !marker && excludesPrimaryCanvasPan(event)) return;
		const albumLocalId = marker?.dataset.albumId ?? null;
		const preOffset = albumLocalId ? preOffsetFor(albumLocalId) : null;
		const result = controller.pointerDown({
			pointerId: event.pointerId,
			button: event.button,
			clientX: event.clientX,
			clientY: event.clientY,
			target: albumLocalId
				? { kind: 'album', albumLocalId, preOffset }
				: { kind: 'background' },
			spaceKey: spaceKey && event.button === 0
		});
		if (!result.accepted) return;
		event.preventDefault();
		activeGestureKind = result.kind;
		if (result.kind !== 'album-armed' || !albumLocalId) return;
		armedAlbumId = albumLocalId;
		if (onAlbumGestureStart?.(result.gestureId, albumLocalId, preOffset) === false) {
			controller.pointerCancel({
				pointerId: event.pointerId,
				gestureId: result.gestureId,
				clientX: event.clientX,
				clientY: event.clientY
			});
		}
	}

	function handlePointerMove(event: PointerEvent): void {
		const identity = pointerIdentity(event);
		if (!controller || !identity) return;
		if (controller.pointerMove({
			...identity,
			clientX: event.clientX,
			clientY: event.clientY
		})) {
			event.preventDefault();
			activeGestureKind = controller.activeGesture()?.kind ?? null;
		}
	}

	function handlePointerUp(event: PointerEvent): void {
		const identity = pointerIdentity(event);
		if (!controller || !identity) return;
		if (controller.pointerUp({
			...identity,
			clientX: event.clientX,
			clientY: event.clientY
		})) event.preventDefault();
		activeGestureKind = null;
	}

	function handlePointerCancel(event: PointerEvent): void {
		const identity = pointerIdentity(event);
		if (!controller || !identity) return;
		controller.pointerCancel({
			...identity,
			clientX: event.clientX,
			clientY: event.clientY
		});
		activeGestureKind = null;
	}

	function handleLostPointerCapture(event: PointerEvent): void {
		const gestureId = capturedGestureByPointer.get(event.pointerId);
		if (gestureId === undefined) return;
		controller?.lostPointerCapture({ pointerId: event.pointerId, gestureId });
		capturedGestureByPointer.delete(event.pointerId);
		activeGestureKind = null;
	}

	function handleWheel(event: WheelEvent): void {
		if (
			!runtimeActive ||
			!controller ||
			spatialInert ||
			event.defaultPrevented ||
			(event.target instanceof Element && event.target.closest('[data-album-detail-id]'))
		) return;
		const point = localWheelPoint(event);
		if (controller.wheel({
			clientX: point.x,
			clientY: point.y,
			deltaX: event.deltaX,
			deltaY: event.deltaY,
			deltaMode: event.deltaMode as 0 | 1 | 2,
			ctrlKey: event.ctrlKey,
			metaKey: event.metaKey
		})) event.preventDefault();
	}

	function handleWindowKeydown(event: KeyboardEvent): void {
		if (!runtimeActive) return;
		if (event.key === 'Escape' && controller?.escape()) {
			event.preventDefault();
			activeGestureKind = null;
			return;
		}
		if (
			event.key !== ' ' ||
			event.repeat ||
			event.altKey ||
			event.ctrlKey ||
			event.metaKey ||
			spatialInert ||
			(event.target instanceof Element && event.target.closest('[aria-modal="true"], dialog[open]')) ||
			(event.target instanceof Element && event.target.closest(
				'button, a[href], [role="button"], [role="menuitem"]'
			)) ||
			(event.target instanceof HTMLInputElement) ||
			(event.target instanceof HTMLTextAreaElement) ||
			(event.target instanceof HTMLSelectElement) ||
			(event.target instanceof HTMLElement && event.target.isContentEditable)
		) return;
		event.preventDefault();
		spaceKey = true;
	}

	function handleWindowKeyup(event: KeyboardEvent): void {
		if (event.key === ' ') spaceKey = false;
	}

	function handleWindowBlur(): void {
		spaceKey = false;
		if (controller?.escape()) activeGestureKind = null;
	}

	function attachWindowListeners(): void {
		if (windowListenersAttached || typeof window === 'undefined') return;
		window.addEventListener('keydown', handleWindowKeydown);
		window.addEventListener('keyup', handleWindowKeyup);
		window.addEventListener('blur', handleWindowBlur);
		windowListenersAttached = true;
	}

	function detachWindowListeners(): void {
		if (!windowListenersAttached || typeof window === 'undefined') return;
		window.removeEventListener('keydown', handleWindowKeydown);
		window.removeEventListener('keyup', handleWindowKeyup);
		window.removeEventListener('blur', handleWindowBlur);
		windowListenersAttached = false;
	}

	function resumeRuntime(): void {
		if (runtimeActive) {
			attachWindowListeners();
			return;
		}
		runtimeActive = true;
		attachWindowListeners();
	}

	function suspendRuntime(): void {
		runtimeActive = false;
		detachWindowListeners();
		spaceKey = false;
		controller?.cancelWheel();
		controller?.escape();
		activeGestureKind = null;
	}

	$effect(() => {
		const nextModel = model;
		const nextViewport = `${viewport.x}:${viewport.y}:${viewport.width}:${viewport.height}`;
		const activeController = controller;
		const initialized = observedModel !== null && observedViewport !== null;
		const changed = initialized && (
			nextModel !== observedModel || nextViewport !== observedViewport
		);
		observedModel = nextModel;
		observedViewport = nextViewport;
		if (!activeController || (!spatialInert && !changed)) return;
		activeController.cancelWheel();
		activeController.escape();
		activeGestureKind = null;
	});

	onMount(() => {
		controller = new TimelineGestureController({
			getCamera: () => camera,
			getViewport: () => viewport,
			callbacks: {
				capturePointer: ({ pointerId, gestureId }) => capturePointer(pointerId, gestureId),
				releasePointer: ({ pointerId }) => releasePointer(pointerId),
				previewAlbum: (preview) => {
					dragPreview = preview;
					activeGestureKind = 'album-drag';
					onAlbumDragPreview?.(preview);
				},
				resolveAlbumDropTarget: (request) => resolveAlbumDropTarget?.(request) ?? null,
				commitAlbum: (commit) => {
					onAlbumDragCommit?.(commit);
					clearAlbumGesture();
				},
				cancelAlbum: (cancel) => {
					onAlbumDragCancel?.(cancel);
					clearAlbumGesture();
				},
				tapAlbum: (tap) => {
					onAlbumTap?.(tap);
					clearAlbumGesture();
				},
				previewCamera: (preview) => onCameraPreview?.(preview),
				commitCamera: (commit) => onCameraCommit?.(commit),
				cancelCamera: (cancel) => onCameraCancel?.(cancel),
				wheelIdle: (idle) => onWheelIdle?.(idle)
			}
		});
		const controls: TimelineCanvasGestureControls = {
			cancelActive: () => controller?.escape() ?? false,
			cancelWheel: () => controller?.cancelWheel(),
			resumeRuntime,
			suspendRuntime
		};
		if (onGestureControls) onGestureControls(controls);
		else resumeRuntime();
		return () => {
			suspendRuntime();
			controller?.dispose();
			controller = null;
			capturedGestureByPointer.clear();
			clearAlbumGesture();
			onGestureControls?.(null);
		};
	});
</script>

<div
	bind:this={viewportElement}
	class="canvas-viewport"
	class:panning={activeGestureKind === 'pan'}
	class:dragging={activeGestureKind === 'album-drag'}
	data-testid="timeline-canvas-viewport"
	data-gesture-kind={activeGestureKind}
	data-rendered-world-objects={worldObjectCount}
	data-rendered-artwork-images={artworkImageCount}
	data-pinned-node-count={Number(branchPinnedId !== null) + Number(basePinnedId !== null)}
	aria-hidden={spatialInert ? 'true' : undefined}
	use:inertSubtree={spatialInert}
	onpointerdown={handlePointerDown}
	onpointermove={handlePointerMove}
	onpointerup={handlePointerUp}
	onpointercancel={handlePointerCancel}
	onlostpointercapture={handleLostPointerCapture}
	onwheel={handleWheel}
>
	<CanvasWorld
		{model}
		{plan}
		{branchLayout}
		{branchPlan}
		{camera}
		{viewport}
		{detailView}
		{detailAnchor}
		{activeAlbumId}
		{dragPreview}
		{albumActivationEnabled}
		{branchActivationEnabled}
		{branchRetryEnabled}
		onAlbumActivate={(albumLocalId) => {
			if (!controller?.consumeCompatibilityClick(albumLocalId)) {
				onAlbumActivate?.(albumLocalId);
			}
		}}
		{onAlbumFocus}
		{onAlbumKeydown}
		{onAlbumActions}
		{onBranchActivate}
		{onBranchFocus}
		{onBranchKeydown}
		{onBranchActions}
		{onBranchRetry}
		{onBranchClose}
		{onOpenTrackInClassic}
	/>
</div>

<style>
	.canvas-viewport {
		position: absolute;
		inset: 0;
		overflow: hidden;
		contain: strict;
		touch-action: none;
		cursor: grab;
	}

	.canvas-viewport.panning,
	.canvas-viewport.dragging {
		cursor: grabbing;
	}
</style>
