<script lang="ts">
	import { flushSync, onDestroy, onMount, tick } from 'svelte';
	import {
		DESKTOP_FRAME_P95_LIMIT_MS,
		DESKTOP_QUERY_P95_LIMIT_MS,
		FRAME_MAX_LIMIT_MS,
		RECOVERY_TOLERANCE,
		RuntimeResourceLedger,
		WARM_HEAP_LIMIT_BYTES,
		appendTimingSample,
		decodeMountedArtwork,
		exportMetrics as downloadMetrics,
		maxDomBudgets,
		observeLongTasks,
		readHeap,
		runFrameTrace,
		sampleDomBudgets,
		sanitizedBrowserProfile,
		type DecodeSummary,
		type DomBudgetSample,
		type FrameSummary,
		type HeapReading,
		type LedgerSnapshot,
		type LongTaskSummary
	} from './browserMetrics';
	import { chronologyLabel, type ScenarioName, type SyntheticAlbum } from './fixtures/index';
	import {
		MAX_BRANCH_CANDIDATES,
		MAX_OPEN_BRANCHES,
		MAX_RENDERED_ARTWORK_IMAGES,
		MAX_RENDERED_WORLD_OBJECTS,
		createCapSnapshot,
		createInertActionSpy,
		createRenderPlan,
		createWorkspace,
		fitCamera,
		hitTestZone,
		screenToWorld,
		summarizeQueryTimings,
		worldToScreen,
		zoomAtPoint,
		type Camera,
		type InertActionChoiceId,
		type InertChooserState,
		type RenderPlan,
		type ScreenViewport,
		type TimingSummary,
		type TimelineWorkspace,
		type WorkspaceEntity,
		type ZoneTarget
	} from './runtime/index';

	type VisualScenario = 'primary' | 'undated' | 'density';
	type CatalogSize = 'small' | 'medium' | 'large';
	type HarnessCommand =
		| { id: number; kind: 'trace' }
		| { id: number; kind: 'reset' }
		| { id: number; kind: 'export' };

	interface Gesture {
		pointerId: number;
		kind: 'pan' | 'pending-album' | 'album-drag';
		albumId: string | null;
		startClientX: number;
		startClientY: number;
		startCamera: Camera;
	}

	interface ScreenMenu {
		albumId: string;
		x: number;
		y: number;
	}

	interface TraceEvidence {
		durationMs: number;
		capturedAt: string;
		scenario: ScenarioName;
		frames: FrameSummary;
		frameIntervalsMs: number[];
		spatialQueryMs: TimingSummary;
		longTasks: LongTaskSummary;
		domPeak: DomBudgetSample;
		decode: DecodeSummary;
		heap: {
			baseline: HeapReading;
			peakUsedBytes: number | null;
			after: HeapReading;
			incrementalWarmBytes: number | null;
		};
		ledgerAfter: LedgerSnapshot;
		gates: {
			frameP95: boolean;
			frameMax: boolean;
			spatialP95: boolean;
			worldObjectCap: boolean;
			artworkImageCap: boolean;
			warmHeap: boolean | null;
		};
		status: 'pass' | 'fail' | 'partial';
	}

	interface RecoveryEvidence {
		cycles: 20;
		capturedAt: string;
		domPeak: DomBudgetSample;
		subtreeCount: number;
		chooserClosed: boolean;
		gestureCleared: boolean;
		heapBaseline: HeapReading;
		heapAfter: HeapReading;
		heapRecoveryRatio: number | null;
		garbageCollection: {
			available: boolean;
			invokedBefore: boolean;
			invokedAfter: boolean;
			settleDelayMs: number;
		};
		ledgerAfter: LedgerSnapshot;
		status: 'pass' | 'fail' | 'partial';
	}

	export let scenario: VisualScenario = 'primary';
	export let catalogSize: CatalogSize = 'medium';
	export let command: HarnessCommand | null = null;
	export let onExportSummary: (summary: string) => void = () => {};

	const VIEWPORT: ScreenViewport = { x: 0, y: 0, width: 1400, height: 900 };
	const LIST_PAGE_SIZE = 40;
	const TRACE_DURATION_MS = 10_000;

	let canvasElement: HTMLDivElement;
	let viewportElement: HTMLDivElement;
	let searchInput: HTMLInputElement;
	let loadedKey = '';
	let workspace: TimelineWorkspace = createWorkspace('medium');
	let camera: Camera = fitCamera(workspace.bounds, VIEWPORT, { padding: 150, maxScale: 1.18 });
	let renderPlan: RenderPlan = createRenderPlan(workspace, camera, VIEWPORT);
	let selectedAlbumId: string | null = null;
	let focusedAlbumId: string | null = null;
	let draggedAlbumId: string | null = null;
	let detailOpen = false;
	let gesture: Gesture | null = null;
	let dragOffset = { x: 0, y: 0 };
	let manualOffsets: Record<string, { x: number; y: number }> = {};
	let hotZoneId: string | null = null;
	let listOpen = false;
	let listPage = 0;
	let actionMenu: ScreenMenu | null = null;
	let lastAction = 'Actions are inert and recorded locally';
	let queryTimings: number[] = [];
	let domNodeCount = 0;
	let traceRunning = false;
	let tracePercent = 0;
	let traceFrameIntervals: number[] = [];
	let traceAbortController: AbortController | null = null;
	let latestTraceEvidence: TraceEvidence | null = null;
	let latestRecoveryEvidence: RecoveryEvidence | null = null;
	let lastCommandId = 0;
	let actionSpy = createInertActionSpy();
	let chooserState: InertChooserState = actionSpy.getState();
	let releasePointerGesture: (() => void) | null = null;
	const resourceLedger = new RuntimeResourceLedger();

	function effectiveScenarioName(): ScenarioName {
		return scenario === 'density' ? 'stress' : catalogSize;
	}

	function firstBaseAlbum(source: TimelineWorkspace): WorkspaceEntity | null {
		return source.entities.find((entity) => entity.kind === 'album') ?? null;
	}

	function preferredAlbum(source: TimelineWorkspace): WorkspaceEntity | null {
		const base = source.entities.filter((entity) => entity.kind === 'album');
		if (scenario === 'undated') return base.find((entity) => entity.year === null) ?? base[0] ?? null;
		return base[Math.min(base.length - 1, Math.floor(base.length * 0.58))] ?? base[0] ?? null;
	}

	function initialCamera(source: TimelineWorkspace, preferred: WorkspaceEntity | null): Camera {
		if (scenario === 'undated' && preferred) {
			return { centerX: preferred.x - 130, centerY: 0, scale: 1.02 };
		}
		if (source.scenario.id !== 'small' && preferred) {
			return {
				centerX: preferred.x - 180,
				centerY: 0,
				scale: source.scenario.id === 'stress' ? 0.5 : 0.82
			};
		}
		return fitCamera(source.bounds, VIEWPORT, {
			padding: source.scenario.id === 'small' ? 310 : 145,
			maxScale: source.scenario.id === 'small' ? 1.28 : 1.12
		});
	}

	function rebuildWorkspace(nextKey: string) {
		const nextWorkspace = createWorkspace(effectiveScenarioName());
		const preferred = preferredAlbum(nextWorkspace) ?? firstBaseAlbum(nextWorkspace);
		workspace = nextWorkspace;
		selectedAlbumId = preferred?.id ?? null;
		focusedAlbumId = preferred?.id ?? null;
		draggedAlbumId = null;
		detailOpen = scenario !== 'density' && preferred !== null;
		manualOffsets = {};
		endPointerGestureLedger();
		gesture = null;
		hotZoneId = null;
		listOpen = false;
		actionMenu = null;
		actionSpy = createInertActionSpy();
		chooserState = actionSpy.getState();
		camera = initialCamera(nextWorkspace, preferred);
		queryTimings = [];
		lastAction = `${nextWorkspace.scenario.label} loaded from local synthetic fixtures`;
		loadedKey = nextKey;
	}

	function priorityPinnedId(dragged: string | null, focused: string | null, selected: string | null): string[] {
		const id = dragged ?? focused ?? selected;
		return id ? [id] : [];
	}

	function measuredRenderPlan(
		source: TimelineWorkspace,
		activeCamera: Camera,
		pinnedIds: readonly string[]
	): RenderPlan {
		const started = performance.now();
		const plan = createRenderPlan(source, activeCamera, VIEWPORT, pinnedIds);
		const elapsed = performance.now() - started;
		queryTimings = appendTimingSample(queryTimings, elapsed, traceRunning);
		queueMicrotask(() => {
			domNodeCount = canvasElement?.querySelectorAll('*').length ?? 0;
		});
		return plan;
	}

	function artworkSource(index: number | null): string {
		const normalized = ((index ?? 0) % 12) + 1;
		return `/artwork/cover-${String(normalized).padStart(2, '0')}.png`;
	}

	function chronology(entity: WorkspaceEntity | { year: number | null; ordinal?: number }): string {
		const label = chronologyLabel({ originalReleaseYear: entity.year });
		return entity.year === null
			? `Undated${entity.ordinal === undefined ? '' : ` · ordinal #${entity.ordinal + 1}`}`
			: `${label} · original release`;
	}

	function fixtureAlbum(id: string): SyntheticAlbum | null {
		return (
			workspace.scenario.albums.find((album) => album.id === id) ??
			workspace.scenario.branches.flatMap((branch) => branch.candidates).find((album) => album.id === id) ??
			null
		);
	}

	function entityFor(id: string | null): WorkspaceEntity | null {
		return id ? (workspace.entityById.get(id) ?? null) : null;
	}

	function albumOffset(
		id: string,
		offsets: Record<string, { x: number; y: number }>,
		activeDraggedAlbumId: string | null,
		activeDragOffset: { x: number; y: number }
	): { x: number; y: number } {
		const stored = offsets[id] ?? { x: 0, y: 0 };
		return id === activeDraggedAlbumId
			? { x: stored.x + activeDragOffset.x, y: stored.y + activeDragOffset.y }
			: stored;
	}

	function worldTransform(activeCamera: Camera): string {
		const tx = VIEWPORT.width / 2 - activeCamera.centerX * activeCamera.scale;
		const ty = VIEWPORT.height / 2 - activeCamera.centerY * activeCamera.scale;
		return `translate3d(${tx}px, ${ty}px, 0) scale(${activeCamera.scale})`;
	}

	function clientPoint(event: PointerEvent | WheelEvent): { x: number; y: number } {
		const rect = canvasElement.getBoundingClientRect();
		return { x: event.clientX - rect.left, y: event.clientY - rect.top };
	}

	function renderedZoneTargets(): ZoneTarget[] {
		const frameRect = canvasElement.getBoundingClientRect();
		const zoneElements = [...canvasElement.querySelectorAll<HTMLElement>('[data-zone-id]')];
		return workspace.zones.map((zone) => {
			const element = zoneElements.find((candidate) => candidate.dataset.zoneId === zone.id);
			const rect = element?.getBoundingClientRect();
			if (!rect || rect.width === 0 || rect.height === 0) return zone;
			return {
				...zone,
				rect: {
					x: rect.left - frameRect.left,
					y: rect.top - frameRect.top,
					width: rect.width,
					height: rect.height
				}
			};
		});
	}

	function beginPointerGestureLedger() {
		releasePointerGesture?.();
		releasePointerGesture = resourceLedger.acquire('pointerGestures');
	}

	function endPointerGestureLedger() {
		releasePointerGesture?.();
		releasePointerGesture = null;
	}

	function startPan(event: PointerEvent) {
		if (event.button !== 0 && event.button !== 1) return;
		if (listOpen || chooserState.open) return;
		if (
			event.target instanceof Element &&
			event.target.closest(
				'button, a[href], input, select, textarea, [role="button"], [role="menuitem"], [contenteditable="true"]'
			)
		) return;
		beginPointerGestureLedger();
		gesture = {
			pointerId: event.pointerId,
			kind: 'pan',
			albumId: null,
			startClientX: event.clientX,
			startClientY: event.clientY,
			startCamera: camera
		};
		viewportElement.setPointerCapture?.(event.pointerId);
	}

	function armAlbumDrag(entityId: string, event: PointerEvent) {
		if (event.button !== 0 || listOpen || chooserState.open) return;
		event.stopPropagation();
		focusedAlbumId = entityId;
		beginPointerGestureLedger();
		gesture = {
			pointerId: event.pointerId,
			kind: 'pending-album',
			albumId: entityId,
			startClientX: event.clientX,
			startClientY: event.clientY,
			startCamera: camera
		};
		viewportElement.setPointerCapture?.(event.pointerId);
	}

	function movePointer(event: PointerEvent) {
		if (!gesture || event.pointerId !== gesture.pointerId) return;
		const dx = event.clientX - gesture.startClientX;
		const dy = event.clientY - gesture.startClientY;

		if (gesture.kind === 'pending-album' && Math.hypot(dx, dy) > 6) {
			gesture = { ...gesture, kind: 'album-drag' };
			draggedAlbumId = gesture.albumId;
			detailOpen = false;
		}

		if (gesture.kind === 'pan') {
			camera = {
				...gesture.startCamera,
				centerX: gesture.startCamera.centerX - dx / gesture.startCamera.scale,
				centerY: gesture.startCamera.centerY - dy / gesture.startCamera.scale
			};
			return;
		}

		if (gesture.kind === 'album-drag') {
			const rect = canvasElement.getBoundingClientRect();
			const startWorld = screenToWorld(
				{ x: gesture.startClientX - rect.left, y: gesture.startClientY - rect.top },
				gesture.startCamera,
				VIEWPORT
			);
			const currentWorld = screenToWorld(clientPoint(event), gesture.startCamera, VIEWPORT);
			dragOffset = { x: currentWorld.x - startWorld.x, y: currentWorld.y - startWorld.y };
			hotZoneId = hitTestZone(clientPoint(event), renderedZoneTargets())?.id ?? null;
		}
	}

	function openChooser(albumId: string, zone: ZoneTarget) {
		chooserState = actionSpy.open(albumId, zone.id);
		lastAction = `${entityFor(albumId)?.title ?? 'Album'} staged for ${zone.name}; chooser is inert`;
		void focusAfterRender('.zone-chooser button');
	}

	function finishPointer(event: PointerEvent, cancelled = false) {
		if (!gesture || event.pointerId !== gesture.pointerId) return;
		const terminalGesture = gesture;
		const zone = terminalGesture.kind === 'album-drag' && !cancelled
			? hitTestZone(clientPoint(event), renderedZoneTargets())
			: null;

		gesture = null;
		hotZoneId = null;
		if (terminalGesture.kind === 'pending-album' && terminalGesture.albumId && !cancelled) {
			selectedAlbumId = terminalGesture.albumId;
			focusedAlbumId = terminalGesture.albumId;
			detailOpen = true;
		}
		if (terminalGesture.kind === 'album-drag' && terminalGesture.albumId) {
			if (!cancelled && !zone) {
				const previous = manualOffsets[terminalGesture.albumId] ?? { x: 0, y: 0 };
				manualOffsets = {
					...manualOffsets,
					[terminalGesture.albumId]: {
						x: previous.x + dragOffset.x,
						y: previous.y + dragOffset.y
					}
				};
				lastAction = `${entityFor(terminalGesture.albumId)?.title ?? 'Album'} floated for this session`;
			}
			if (zone) openChooser(terminalGesture.albumId, zone);
		}
		draggedAlbumId = null;
		dragOffset = { x: 0, y: 0 };
		endPointerGestureLedger();

		if (viewportElement.hasPointerCapture?.(event.pointerId)) {
			viewportElement.releasePointerCapture(event.pointerId);
		}
	}

	function cancelGesture() {
		if (!gesture) return;
		const pointerId = gesture.pointerId;
		gesture = null;
		draggedAlbumId = null;
		dragOffset = { x: 0, y: 0 };
		hotZoneId = null;
		endPointerGestureLedger();
		if (viewportElement.hasPointerCapture?.(pointerId)) viewportElement.releasePointerCapture(pointerId);
		lastAction = 'Pointer gesture cancelled; album position restored';
	}

	function handleLostPointerCapture(event: PointerEvent) {
		if (gesture?.pointerId === event.pointerId) cancelGesture();
	}

	function handleWheel(event: WheelEvent) {
		if (listOpen || chooserState.open) return;
		event.preventDefault();
		if (event.ctrlKey || event.metaKey) {
			const factor = Math.exp(-event.deltaY * 0.0025);
			camera = zoomAtPoint(camera, camera.scale * factor, clientPoint(event), VIEWPORT);
			return;
		}
		camera = {
			...camera,
			centerX: camera.centerX + event.deltaX / camera.scale,
			centerY: camera.centerY + event.deltaY / camera.scale
		};
	}

	function zoomBy(factor: number) {
		camera = zoomAtPoint(camera, camera.scale * factor, { x: 700, y: 450 }, VIEWPORT);
	}

	function fit() {
		camera = fitCamera(workspace.bounds, VIEWPORT, { padding: 145, maxScale: 1.12 });
		lastAction = 'All logical content fitted to the 1400 × 900 frame';
	}

	function recenter() {
		const base = firstBaseAlbum(workspace);
		camera = {
			centerX: base?.x ?? 0,
			centerY: 0,
			scale: Math.max(0.82, Math.min(1.08, camera.scale))
		};
		lastAction = 'Camera recentered on the selected artist origin';
	}

	function focusEntity(id: string) {
		const entity = entityFor(id);
		if (!entity) return;
		focusedAlbumId = id;
		camera = { ...camera, centerX: entity.x, centerY: entity.kind === 'album' ? 0 : entity.y };
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				const target = [...canvasElement.querySelectorAll<HTMLElement>('[data-entity-id]')].find(
					(node) => node.dataset.entityId === id
				);
				target?.focus();
			});
		});
	}

	async function focusAfterRender(selector: string): Promise<void> {
		await tick();
		canvasElement.querySelector<HTMLElement>(selector)?.focus();
	}

	function orderedBaseAlbums(source: TimelineWorkspace): WorkspaceEntity[] {
		return source.entities
			.filter((entity) => entity.kind === 'album')
			.sort((a, b) => a.x - b.x || a.ordinal - b.ordinal);
	}

	function moveFocus(direction: 'left' | 'right' | 'up' | 'down' | 'home' | 'end') {
		const current = entityFor(focusedAlbumId ?? selectedAlbumId);
		const base = orderedBaseAlbums(workspace);
		if (base.length === 0) return;
		if (direction === 'home') return focusEntity(base[0].id);
		if (direction === 'end') return focusEntity(base[base.length - 1].id);

		if (direction === 'left' || direction === 'right') {
			const index = Math.max(0, base.findIndex((entity) => entity.id === current?.id));
			const next = direction === 'left' ? base[Math.max(0, index - 1)] : base[Math.min(base.length - 1, index + 1)];
			return focusEntity(next.id);
		}

		const branchEntities = workspace.entities.filter((entity) => entity.kind === 'branch-album');
		const candidates = branchEntities
			.filter((entity) => (direction === 'up' ? entity.y < (current?.y ?? 0) : entity.y > (current?.y ?? 0)))
			.sort((a, b) => {
				const ax = Math.abs(a.x - (current?.x ?? 0));
				const bx = Math.abs(b.x - (current?.x ?? 0));
				return ax - bx || Math.abs(a.y) - Math.abs(b.y);
			});
		if (candidates[0]) focusEntity(candidates[0].id);
	}

	function openActionMenu(id: string) {
		const entity = entityFor(id);
		if (!entity) return;
		const screen = worldToScreen(entity, camera, VIEWPORT);
		actionMenu = {
			albumId: id,
			x: Math.min(1128, Math.max(18, screen.x + 22)),
			y: Math.min(660, Math.max(88, screen.y - 30))
		};
		focusedAlbumId = id;
		void focusAfterRender('.action-menu [role="menuitem"]');
	}

	function handleActionMenuKeydown(event: KeyboardEvent) {
		if (!(event.currentTarget instanceof HTMLElement)) return;
		const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
		if (items.length === 0) return;
		const currentIndex = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement));
		let nextIndex: number | null = null;
		if (event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % items.length;
		else if (event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + items.length) % items.length;
		else if (event.key === 'Home') nextIndex = 0;
		else if (event.key === 'End') nextIndex = items.length - 1;
		if (nextIndex === null) return;
		event.preventDefault();
		items[nextIndex].focus();
	}

	function handleAlbumKeydown(entityId: string, event: KeyboardEvent) {
		if (event.key === 'ArrowLeft') {
			event.preventDefault();
			moveFocus('left');
		} else if (event.key === 'ArrowRight') {
			event.preventDefault();
			moveFocus('right');
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			moveFocus('up');
		} else if (event.key === 'ArrowDown') {
			event.preventDefault();
			moveFocus('down');
		} else if (event.key === 'Home') {
			event.preventDefault();
			moveFocus('home');
		} else if (event.key === 'End') {
			event.preventDefault();
			moveFocus('end');
		} else if (event.key === 'Enter') {
			selectedAlbumId = entityId;
			detailOpen = true;
		} else if (event.shiftKey && event.key === 'F10') {
			event.preventDefault();
			openActionMenu(entityId);
		}
	}

	function handleFrameKeydown(event: KeyboardEvent) {
		if (event.key === '/' && !listOpen && !chooserState.open) {
			event.preventDefault();
			searchInput?.focus();
		} else if (event.key === 'Escape') {
			if (gesture) cancelGesture();
			else if (chooserState.open) closeChooser();
			else if (listOpen) closeList();
			else if (actionMenu) {
				const id = actionMenu.albumId;
				actionMenu = null;
				void focusAfterRender(`[data-entity-id="${id}"]`);
			}
			else detailOpen = false;
		}
	}

	function chooseAction(choiceId: InertActionChoiceId) {
		const record = actionSpy.choose(choiceId);
		chooserState = actionSpy.getState();
		const choice = chooserState.choices.find((candidate) => candidate.id === choiceId);
		lastAction = `${choice?.label ?? choiceId} logged locally (sent: ${String(record.sent)})`;
	}

	function closeChooser() {
		actionSpy.cancel();
		chooserState = actionSpy.getState();
		lastAction = 'Inert action chooser closed; no command sent';
	}

	function openChooserForZone(zone: ZoneTarget, albumId = selectedAlbumId ?? focusedAlbumId) {
		if (!albumId) return;
		openChooser(albumId, zone);
	}

	function floatFromMenu(id: string) {
		manualOffsets = { ...manualOffsets, [id]: { x: 46, y: -42 } };
		actionMenu = null;
		lastAction = `${entityFor(id)?.title ?? 'Album'} floated by the keyboard-equivalent command`;
	}

	function returnToTimeline(id: string) {
		const { [id]: _removed, ...remaining } = manualOffsets;
		manualOffsets = remaining;
		actionMenu = null;
		lastAction = `${entityFor(id)?.title ?? 'Album'} returned to its canonical anchor`;
	}

	function openList() {
		listPage = Math.floor(
			Math.max(0, workspace.entities.findIndex((entity) => entity.id === focusedAlbumId)) / LIST_PAGE_SIZE
		);
		listOpen = true;
		void focusAfterRender('.list-overlay button:not([disabled])');
	}

	function closeList() {
		listOpen = false;
		if (focusedAlbumId) focusEntity(focusedAlbumId);
	}

	function chooseFromList(id: string) {
		selectedAlbumId = id;
		focusedAlbumId = id;
		detailOpen = true;
		listOpen = false;
		focusEntity(id);
	}

	function traceStatus(gates: TraceEvidence['gates']): TraceEvidence['status'] {
		const measured = Object.values(gates).filter((value): value is boolean => value !== null);
		if (measured.some((value) => !value)) return 'fail';
		return gates.warmHeap === null ? 'partial' : 'pass';
	}

	function heapPeak(samples: readonly number[]): number | null {
		return samples.length === 0 ? null : Math.max(...samples);
	}

	async function runTrace(): Promise<TraceEvidence | null> {
		if (traceRunning) return null;
		traceAbortController?.abort();
		const controller = new AbortController();
		traceAbortController = controller;
		traceRunning = true;
		tracePercent = 0;
		traceFrameIntervals = [];
		queryTimings = [];
		const startingCamera = { ...camera };
		const tourWidth = Math.min(840, Math.max(180, workspace.bounds.width * 0.12));
		const heapBaseline = readHeap();
		const heapSamples: number[] = [];
		if (heapBaseline.usedBytes !== null) heapSamples.push(heapBaseline.usedBytes);
		const longTaskObserver = observeLongTasks(resourceLedger);

		try {
			const trace = await runFrameTrace({
				durationMs: TRACE_DURATION_MS,
				root: canvasElement,
				ledger: resourceLedger,
				signal: controller.signal,
				onFrame: (progress) => {
					const phase = progress * Math.PI * 4;
					const scaled = zoomAtPoint(
						startingCamera,
						startingCamera.scale * (1 + Math.sin(phase) * 0.2),
						{ x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 },
						VIEWPORT
					);
					flushSync(() => {
						tracePercent = Math.round(progress * 100);
						camera = {
							...scaled,
							centerX: startingCamera.centerX + Math.sin(phase * 0.5) * tourWidth,
							centerY: startingCamera.centerY + Math.sin(phase) * 110
						};
					});
				},
				onSample: () => {
					const heap = readHeap();
					if (heap.usedBytes !== null) heapSamples.push(heap.usedBytes);
				}
			});

			flushSync(() => {
				camera = startingCamera;
				tracePercent = 100;
			});
			traceFrameIntervals = trace.intervals;
			const decode = await decodeMountedArtwork(canvasElement);
			const longTasks = longTaskObserver.stop();
			const heapAfter = readHeap();
			if (heapAfter.usedBytes !== null) heapSamples.push(heapAfter.usedBytes);
			const peakUsedBytes = heapPeak(heapSamples);
			const incrementalWarmBytes =
				heapBaseline.precision === 'precise' &&
				heapAfter.precision === 'precise' &&
				heapBaseline.usedBytes !== null &&
				peakUsedBytes !== null
					? Math.max(0, peakUsedBytes - heapBaseline.usedBytes)
					: null;
			const spatialQueryMs = summarizeQueryTimings(queryTimings);
			const gates: TraceEvidence['gates'] = {
				frameP95:
					trace.frames.p95Ms !== null && trace.frames.p95Ms <= DESKTOP_FRAME_P95_LIMIT_MS,
				frameMax: trace.frames.maxMs !== null && trace.frames.maxMs <= FRAME_MAX_LIMIT_MS,
				spatialP95: spatialQueryMs.p95 <= DESKTOP_QUERY_P95_LIMIT_MS,
				worldObjectCap: trace.domPeak.worldObjects <= MAX_RENDERED_WORLD_OBJECTS,
				artworkImageCap: trace.domPeak.artworkImages <= MAX_RENDERED_ARTWORK_IMAGES,
				warmHeap:
					incrementalWarmBytes === null ? null : incrementalWarmBytes <= WARM_HEAP_LIMIT_BYTES
			};
			const evidence: TraceEvidence = {
				durationMs: TRACE_DURATION_MS,
				capturedAt: new Date().toISOString(),
				scenario: workspace.scenario.id,
				frames: trace.frames,
				frameIntervalsMs: trace.intervals.map((interval) => Number(interval.toFixed(3))),
				spatialQueryMs,
				longTasks,
				domPeak: trace.domPeak,
				decode,
				heap: { baseline: heapBaseline, peakUsedBytes, after: heapAfter, incrementalWarmBytes },
				ledgerAfter: resourceLedger.snapshot(),
				gates,
				status: traceStatus(gates)
			};
			latestTraceEvidence = evidence;
			lastAction = `10s pan/zoom trace ${evidence.status} · p95 frame ${trace.frames.p95Ms?.toFixed(1) ?? 'n/a'}ms · p95 query ${spatialQueryMs.p95.toFixed(2)}ms`;
			onExportSummary(`Trace ${evidence.status}: ${trace.frames.sampleCount} frames sampled`);
			return evidence;
		} catch (error) {
			if (!(error instanceof DOMException && error.name === 'AbortError')) {
				lastAction = `Trace failed locally: ${error instanceof Error ? error.message : 'unknown error'}`;
			}
			return null;
		} finally {
			longTaskObserver.stop();
			traceRunning = false;
			traceAbortController = null;
		}
	}

	function nextPaint(): Promise<void> {
		const release = resourceLedger.acquire('animationFrames');
		return new Promise((resolve) => {
			requestAnimationFrame(() => {
				release();
				resolve();
			});
		});
	}

	function invokeGarbageCollection(): boolean {
		const collect = (globalThis as typeof globalThis & { gc?: () => void }).gc;
		if (typeof collect !== 'function') return false;
		collect();
		return true;
	}

	async function resetTwentyTimes(): Promise<RecoveryEvidence | null> {
		if (traceRunning) return null;
		const invokedBefore = invokeGarbageCollection();
		await nextPaint();
		const heapBaseline = readHeap();
		const samples: DomBudgetSample[] = [];
		for (let cycle = 0; cycle < 20; cycle += 1) {
			flushSync(() => rebuildWorkspace(`${scenario}:${catalogSize}`));
			await nextPaint();
			samples.push(sampleDomBudgets(canvasElement));
		}
		const settleDelayMs = 250;
		await new Promise((resolve) => setTimeout(resolve, settleDelayMs));
		const invokedAfter = invokeGarbageCollection();
		await nextPaint();
		const heapAfter = readHeap();
		const heapRecoveryRatio =
			heapBaseline.precision === 'precise' &&
			heapAfter.precision === 'precise' &&
			heapBaseline.usedBytes !== null &&
			heapAfter.usedBytes !== null &&
			heapBaseline.usedBytes > 0
				? heapAfter.usedBytes / heapBaseline.usedBytes
				: null;
		const domPeak = maxDomBudgets(samples);
		const subtreeCount =
			canvasElement.parentElement?.querySelectorAll('[data-product-frame="1400x900"]').length ?? 0;
		const chooserClosed = !chooserState.open && actionSpy.getRecords().length === 0;
		const gestureCleared = gesture === null && draggedAlbumId === null;
		const ledgerAfter = resourceLedger.snapshot();
		const measuredPass =
			domPeak.worldObjects <= MAX_RENDERED_WORLD_OBJECTS &&
			domPeak.artworkImages <= MAX_RENDERED_ARTWORK_IMAGES &&
			subtreeCount === 1 &&
			chooserClosed &&
			gestureCleared &&
			Object.values(ledgerAfter).every((count) => count === 0);
		const heapPass = heapRecoveryRatio === null ? null : heapRecoveryRatio <= 1 + RECOVERY_TOLERANCE;
		const evidence: RecoveryEvidence = {
			cycles: 20,
			capturedAt: new Date().toISOString(),
			domPeak,
			subtreeCount,
			chooserClosed,
			gestureCleared,
			heapBaseline,
			heapAfter,
			heapRecoveryRatio,
			garbageCollection: {
				available: invokedBefore || invokedAfter,
				invokedBefore,
				invokedAfter,
				settleDelayMs
			},
			ledgerAfter,
			status: !measuredPass || heapPass === false ? 'fail' : heapPass === null ? 'partial' : 'pass'
		};
		latestRecoveryEvidence = evidence;
		lastAction = `20 workspace resets ${evidence.status} · one canvas subtree · resources released`;
		onExportSummary(`Reset ×20 ${evidence.status}: ${subtreeCount} canvas subtree`);
		return evidence;
	}

	function metricsPayload() {
		const querySummary = summarizeQueryTimings(queryTimings);
		return {
			schema: 'roon-controller.timeline-runtime-prototype',
			schemaVersion: 1,
			prototype: 'timeline-canvas-synthetic',
			synthetic: true,
			roonConnection: false,
			browserProfile: sanitizedBrowserProfile(),
			scenario: workspace.scenario.id,
			logicalCatalog: workspace.logicalCatalogCounts,
			camera,
			tier: renderPlan.tier,
			renderCounts: renderPlan.counts,
			accounting: renderPlan.accounting,
			caps: {
				worldObjects: MAX_RENDERED_WORLD_OBJECTS,
				artworkImages: MAX_RENDERED_ARTWORK_IMAGES,
				branches: MAX_OPEN_BRANCHES,
				branchCandidates: MAX_BRANCH_CANDIDATES,
				listRows: LIST_PAGE_SIZE
			},
			queryTimingMs: querySummary,
			domNodes: domNodeCount,
			inertActionRecords: actionSpy.getRecords(),
			resourceLedger: resourceLedger.snapshot(),
			trace: latestTraceEvidence,
			recovery: latestRecoveryEvidence,
			limitations: [
				'synthetic rendering evidence only',
				'no live chronology conclusion',
				'no live action or semantic-outcome conclusion',
				'no timeout or production-release conclusion'
			],
			generatedAt: new Date().toISOString()
		};
	}

	function exportMetrics() {
		const payload = metricsPayload();
		onExportSummary(
			`Metrics ready: ${renderPlan.counts.worldObjects}/${MAX_RENDERED_WORLD_OBJECTS} objects, ${renderPlan.counts.artworkImages}/${MAX_RENDERED_ARTWORK_IMAGES} images`
		);
		lastAction = 'Synthetic metrics exported locally; no network request was made';
		if (typeof URL.createObjectURL === 'function') {
			downloadMetrics(
				`timeline-prototype-${workspace.scenario.id}-metrics.json`,
				payload,
				resourceLedger
			);
		}
	}

	function handleCommand(next: HarnessCommand) {
		if (next.kind === 'trace') void runTrace();
		else if (next.kind === 'reset') void resetTwentyTimes();
		else exportMetrics();
	}

	onMount(() => {
		window.__timelineHarness = { runTrace, resetTwentyTimes, getMetrics: metricsPayload };
	});

	onDestroy(() => {
		traceAbortController?.abort();
		traceAbortController = null;
		endPointerGestureLedger();
		if (window.__timelineHarness?.getMetrics === metricsPayload) delete window.__timelineHarness;
	});

	$: requestedKey = `${scenario}:${catalogSize}`;
	$: if (requestedKey !== loadedKey) rebuildWorkspace(requestedKey);
	$: pinnedIds = priorityPinnedId(draggedAlbumId, focusedAlbumId, selectedAlbumId);
	$: renderPlan = measuredRenderPlan(workspace, camera, pinnedIds);
	$: artworkIds = new Set(renderPlan.artworkIds);
	$: selectedEntity = entityFor(selectedAlbumId);
	$: baseEntities = orderedBaseAlbums(workspace);
	$: axisStart = Math.min(0, ...baseEntities.map((entity) => entity.x)) - 24;
	$: axisEnd = Math.max(220, ...baseEntities.map((entity) => entity.x)) + 150;
	$: axisTicks = baseEntities.filter((_, index) =>
		baseEntities.length <= 12 || index % Math.ceil(baseEntities.length / 10) === 0
	);
	$: listPageCount = Math.max(1, Math.ceil(workspace.entities.length / LIST_PAGE_SIZE));
	$: listPage = Math.min(listPage, listPageCount - 1);
	$: listItems = workspace.entities.slice(listPage * LIST_PAGE_SIZE, (listPage + 1) * LIST_PAGE_SIZE);
	$: querySummary = summarizeQueryTimings(queryTimings);
	$: capSnapshot = createCapSnapshot({
		worldObjects: renderPlan.counts.worldObjects,
		artworkImages: renderPlan.counts.artworkImages
	});
	$: selectedFixtureAlbum = selectedEntity ? fixtureAlbum(selectedEntity.id) : null;
	$: if (command && command.id !== lastCommandId) {
		lastCommandId = command.id;
		handleCommand(command);
	}
</script>

<svelte:window onkeydown={handleFrameKeydown} />

<div
	class="canvas-frame"
	bind:this={canvasElement}
	data-product-frame="1400x900"
	tabindex="-1"
	role="application"
	aria-label="Synthetic draggable Timeline canvas"
>
	<div class="field-grid" aria-hidden="true"></div>

	<div
		class:panning={gesture?.kind === 'pan'}
		class:node-dragging={gesture?.kind === 'album-drag'}
		class="world-viewport"
		bind:this={viewportElement}
		aria-label={`${workspace.scenario.label} canvas`}
		aria-hidden={listOpen || chooserState.open}
		inert={listOpen || chooserState.open}
		onpointerdown={startPan}
		onpointermove={movePointer}
		onpointerup={(event) => finishPointer(event)}
		onpointercancel={(event) => finishPointer(event, true)}
		onlostpointercapture={handleLostPointerCapture}
		onwheel={handleWheel}
	>
		<div class="world-layer" style:transform={worldTransform(camera)}>
			<svg class="world-connector-layer" aria-hidden="true">
				{#each workspace.scenario.branches as branch}
					{@const source = workspace.entityById.get(branch.sourceAlbumId)}
					{@const candidate = workspace.entityById.get(branch.candidates[0]?.id)}
					{#if source && candidate}
						<path
							data-connector
							d={`M ${source.x + 300} ${source.y + 500} C ${source.x + 300} ${candidate.y + 500}, ${candidate.x + 300} ${source.y + 500}, ${candidate.x + 300} ${candidate.y + 500}`}
							fill="none"
							stroke="rgba(244,198,118,.34)"
							stroke-width="1"
						/>
					{/if}
				{/each}
			</svg>

			<div
				class="timeline-axis"
				style:left={`${axisStart}px`}
				style:width={`${axisEnd - axisStart}px`}
				aria-hidden="true"
			>
				<div class="timeline-label">
					<strong>{scenario === 'undated' ? 'Undated tail' : 'Original release timeline'}</strong>
					<span>Explicit synthetic provenance · edition dates never move an anchor</span>
				</div>
				{#each axisTicks as tick}
					<span class="axis-tick" style:left={`${tick.x - axisStart}px`}>
						{tick.year ?? 'Undated'}
					</span>
				{/each}
			</div>

			<article class="artist-origin" style:left={`${axisStart}px`} style:top="0px">
				<div class="artist-monogram" aria-hidden="true">S</div>
				<div>
					<small>Selected artist</small>
					<h1>{workspace.scenario.artist.name}</h1>
					<p>{workspace.scenario.artist.albumCount.toLocaleString()} releases · synthetic fixture</p>
				</div>
			</article>

			{#each workspace.scenario.branches as branch, branchIndex}
				{@const firstCandidate = workspace.entityById.get(branch.candidates[0]?.id)}
				{#if firstCandidate}
					<div
						class="branch-heading"
						style:position="absolute"
						style:left={`${firstCandidate.x - 78}px`}
						style:top={`${firstCandidate.y - 76}px`}
					>
						<strong>{branch.label}</strong>
						<small>Branch {branchIndex + 1} · {branch.candidates.length} of {MAX_BRANCH_CANDIDATES} · depth {branch.depth}</small>
					</div>
				{/if}
			{/each}

			{#each renderPlan.objects as object (object.id)}
				{#if object.kind === 'cluster'}
					<button
						class="cluster-marker"
						data-world-object
						type="button"
						style:left={`${object.x}px`}
						style:top={`${object.y}px`}
						onclick={() => zoomBy(1.5)}
						aria-label={`${object.memberCount} releases, ${object.subtitle}. Zoom in`}
					>
						<strong>{object.memberCount}</strong><small>releases</small>
					</button>
				{:else}
					{@const entity = workspace.entityById.get(object.id)}
					{@const offset = albumOffset(object.id, manualOffsets, draggedAlbumId, dragOffset)}
					{#if entity}
						<article
							class="album-marker"
							data-world-object
							class:marker-above={entity.y <= 0}
							class:marker-below={entity.y > 0}
							class:is-selected={selectedAlbumId === object.id}
							class:is-focused={focusedAlbumId === object.id}
							class:is-dragging={draggedAlbumId === object.id}
							style:left={`${object.x + offset.x}px`}
							style:top={`${object.y + offset.y}px`}
						>
							{#if object.pinned && focusedAlbumId === object.id}
								<span class="focus-pin">Focus pinned</span>
							{/if}
							<button
								class="album-button"
								type="button"
								data-entity-id={object.id}
								tabindex={focusedAlbumId === object.id ? 0 : -1}
								aria-label={`${object.title}, ${chronology(entity)}`}
								onpointerdown={(event) => armAlbumDrag(object.id, event)}
								onkeydown={(event) => handleAlbumKeydown(object.id, event)}
								oncontextmenu={(event) => {
									event.preventDefault();
									openActionMenu(object.id);
								}}
							>
								{#if artworkIds.has(object.id) && object.artworkIndex !== null}
									<img data-artwork class="album-art" src={artworkSource(object.artworkIndex)} alt="" draggable="false" />
								{:else}
									<span class="album-art" aria-hidden="true"></span>
								{/if}
								<span class="album-copy">
									<strong>{object.title}</strong>
									<small>{chronology(entity)}</small>
								</span>
							</button>
						</article>
					{/if}
				{/if}
			{/each}

			{#if detailOpen && selectedEntity}
				<section
					class="detail-slab"
					aria-label={`${selectedEntity.title} synthetic album details`}
					style:left={`${selectedEntity.x + 112}px`}
					style:top={`${selectedEntity.y < 0 ? selectedEntity.y - 64 : selectedEntity.y + 70}px`}
				>
					<div class="detail-header">
						<div class="artist-monogram" aria-hidden="true">{selectedEntity.ordinal + 1}</div>
						<div>
							<small>Selected album · synthetic evidence</small>
							<h2>{selectedEntity.title}</h2>
							<p class="detail-meta">{chronology(selectedEntity)} · edition {selectedFixtureAlbum?.editionReleaseYear ?? 'unknown'} (secondary)</p>
						</div>
						<button class="icon-button" type="button" aria-label="Close album details" onclick={() => (detailOpen = false)}>×</button>
					</div>
					<ol class="track-preview">
						<li><span>01</span><strong>Glass Signal</strong><small>3:57</small></li>
						<li><span>02</span><strong>Quiet Current</strong><small>4:02</small></li>
						<li><span>03</span><strong>North Harbor</strong><small>5:18</small></li>
						<li><span>04</span><strong>Paper Morning</strong><small>3:48</small></li>
					</ol>
					<div class="detail-actions">
						<button type="button" onclick={() => openActionMenu(selectedEntity.id)}>Album actions</button>
						<button class="primary" type="button" onclick={() => openChooserForZone(workspace.zones[0], selectedEntity.id)}>Send to zone…</button>
					</div>
				</section>
			{/if}
		</div>
	</div>

	<div class="screen-chrome" aria-hidden={listOpen || chooserState.open} inert={listOpen || chooserState.open}>
		<button class="path-control" type="button" onclick={recenter}>
			<b aria-hidden="true">‹</b>
			<span><small>Library / Timeline</small><strong>{workspace.scenario.artist.name}</strong></span>
		</button>

		<div class="artist-lens">
			<span class="lens-icon" aria-hidden="true">⌕</span>
			<label>
				<small>Artist lens · local fixture</small>
				<input bind:this={searchInput} value={workspace.scenario.artist.name} aria-label="Artist lens" />
			</label>
			<kbd>/</kbd>
		</div>

		<button class="core-pill" type="button" onclick={() => (lastAction = 'No connection exists in this prototype')}>
			<span class="core-copy"><i></i><strong>Offline by design</strong><small>No Roon connection</small></span>
			<span aria-hidden="true">⚙</span>
		</button>

		<div class="scenario-chip">{scenario.toUpperCase()} · {workspace.scenario.id.toUpperCase()} FIXTURE · {renderPlan.tier.toUpperCase()} ZOOM</div>

		<aside class="metrics-panel" aria-label="Prototype metrics and hard caps">
			<div class="metrics-heading"><span>Live cap monitor</span><span>{capSnapshot.withinCaps ? 'WITHIN CAPS' : 'CAP BREACH'}</span></div>
			<dl class="metrics-grid">
				<dt>World objects</dt><dd class:near-cap={renderPlan.counts.worldObjects > 62}>{renderPlan.counts.worldObjects} / {MAX_RENDERED_WORLD_OBJECTS}</dd>
				<dt>Artwork images</dt><dd class:near-cap={renderPlan.counts.artworkImages > 34}>{renderPlan.counts.artworkImages} / {MAX_RENDERED_ARTWORK_IMAGES}</dd>
				<dt>Logical releases</dt><dd>{workspace.scenario.albums.length.toLocaleString()}</dd>
				<dt>Represented</dt><dd>{renderPlan.accounting.representedIntersectingEntities} / {renderPlan.accounting.expectedIntersectingEntities}</dd>
				<dt>Branches</dt><dd>{workspace.scenario.branches.length} / {MAX_OPEN_BRANCHES}</dd>
				<dt>Query p95</dt><dd>{querySummary.p95.toFixed(2)} ms</dd>
				<dt>Frame p95</dt><dd>{latestTraceEvidence?.frames.p95Ms?.toFixed(1) ?? '—'} ms</dd>
				<dt>Long tasks</dt><dd>{latestTraceEvidence?.longTasks.count ?? '—'}</dd>
				<dt>Reset ×20</dt><dd>{latestRecoveryEvidence?.status ?? 'not run'}</dd>
				<dt>DOM nodes</dt><dd>{domNodeCount}</dd>
			</dl>
		</aside>

		{#if traceRunning}
			<div class="trace-progress" role="status">Capturing local frame intervals… {tracePercent}%</div>
		{/if}

		<aside class="zone-dock" aria-label="Synthetic zone targets">
			<div class="dock-heading"><strong>Send to a zone</strong><small>fixed screen</small></div>
			<div class="zone-list">
				{#each workspace.zones as zone, index}
					<button
						class="zone-port"
						class:drop-hot={hotZoneId === zone.id}
						data-zone-id={zone.id}
						type="button"
						onclick={() => openChooserForZone(zone)}
						aria-label={`Open inert action chooser for ${zone.name}`}
						style:left={`${zone.rect.x - 1204}px`}
						style:top={`${zone.rect.y - 506}px`}
						style:width={`${zone.rect.width}px`}
						style:height={`${zone.rect.height}px`}
					>
						<span class:playing={index === 0} class="zone-pulse"></span>
						<span><strong>{zone.name}</strong><small>{index === 0 ? 'Synthetic selected zone' : 'Synthetic idle zone'}</small></span>
						<b>Drop</b>
					</button>
				{/each}
			</div>
			<p class="dock-note">Drop rolls the card back, then opens a local chooser. Nothing is transmitted.</p>
		</aside>

		<div class="zoom-controls" aria-label="Canvas zoom controls">
			<button type="button" aria-label="Zoom out" onclick={() => zoomBy(0.82)}>−</button>
			<output aria-label="Current zoom">{Math.round(camera.scale * 100)}%</output>
			<button type="button" aria-label="Zoom in" onclick={() => zoomBy(1.22)}>+</button>
			<button type="button" onclick={fit}>Fit</button>
			<button type="button" onclick={recenter}>Recenter</button>
		</div>

		<button class="browse-list-trigger" type="button" onclick={openList}>☷ Browse active set as list</button>
		<div class="action-log" role="status">{lastAction}</div>

		<footer class="transport-island" aria-label="Synthetic compact transport">
			<div class="artist-monogram" aria-hidden="true">S</div>
			<div class="transport-copy">
				<strong>Quiet Current · synthetic now playing</strong>
				<span>{workspace.scenario.artist.name} · inert transport preview</span>
				<div class="transport-progress" aria-hidden="true"></div>
			</div>
			<div class="transport-buttons">
				<button type="button" aria-label="Previous synthetic track" onclick={() => (lastAction = 'Previous logged locally')}>│‹</button>
				<button class="play" type="button" aria-label="Play synthetic track" onclick={() => (lastAction = 'Play logged locally — no command sent')}>▶</button>
				<button type="button" aria-label="Next synthetic track" onclick={() => (lastAction = 'Next logged locally')}>›│</button>
				<button class="queue" type="button" onclick={() => (lastAction = 'Queue preview is inert')}>Queue</button>
			</div>
		</footer>
	</div>

	{#if actionMenu}
		<div class="action-menu" style:left={`${actionMenu.x}px`} style:top={`${actionMenu.y}px`} role="menu" tabindex="-1" aria-label={`${entityFor(actionMenu.albumId)?.title ?? 'Album'} actions`} onkeydown={handleActionMenuKeydown}>
			<header><strong>{entityFor(actionMenu.albumId)?.title}</strong><kbd>Shift+F10</kbd></header>
			<div class="menu-items">
				<button type="button" role="menuitem" onclick={() => { selectedAlbumId = actionMenu?.albumId ?? null; detailOpen = true; actionMenu = null; }}>Open details <span>Enter</span></button>
				{#each workspace.zones as zone}
					<button type="button" role="menuitem" onclick={() => { if (actionMenu) openChooserForZone(zone, actionMenu.albumId); actionMenu = null; }}>Send to {zone.name}… <span>inert chooser</span></button>
				{/each}
				<button type="button" role="menuitem" onclick={() => actionMenu && floatFromMenu(actionMenu.albumId)}>Float from timeline <span>session only</span></button>
				<button type="button" role="menuitem" onclick={() => actionMenu && returnToTimeline(actionMenu.albumId)}>Return to timeline <span>canonical anchor</span></button>
			</div>
		</div>
	{/if}

	{#if chooserState.open}
		<div class="chooser-scrim">
			<dialog open class="zone-chooser" aria-labelledby="chooser-title" aria-modal="true">
				<span class="chooser-eyebrow">Prototype only — no command sent</span>
				<h2 id="chooser-title">{entityFor(chooserState.albumId)?.title} → {workspace.zones.find((zone) => zone.id === chooserState.zoneId)?.name}</h2>
				<p>This is the interaction shape only. Choosing an item records <code>sent: false</code> in a local spy.</p>
				<div class="chooser-list">
					{#each chooserState.choices as choice}
						<button type="button" onclick={() => chooseAction(choice.id)}>
							<strong>{choice.label}</strong><small>INERT · LOCAL SPY</small>
						</button>
					{/each}
				</div>
				<div class="chooser-actions"><button type="button" onclick={closeChooser}>Cancel</button></div>
			</dialog>
		</div>
	{/if}

	{#if listOpen}
		<div class="list-scrim">
			<dialog open class="list-overlay" aria-labelledby="list-title" aria-modal="true">
				<header class="list-toolbar">
					<span><strong id="list-title">Browse active set as list</strong><small>Equivalent bounded surface · at most {LIST_PAGE_SIZE} mounted rows</small></span>
					<button type="button" disabled={listPage === 0} onclick={() => (listPage -= 1)}>Previous</button>
					<small>{listPage + 1} / {listPageCount}</small>
					<button type="button" disabled={listPage >= listPageCount - 1} onclick={() => (listPage += 1)}>Next</button>
					<button type="button" onclick={closeList}>Close</button>
				</header>
				<ol class="bounded-list">
					{#each listItems as entity}
						<li>
							<button class:is-current={focusedAlbumId === entity.id} type="button" onclick={() => chooseFromList(entity.id)}>
								<span class="artist-monogram" aria-hidden="true">{entity.ordinal + 1}</span>
								<span><strong>{entity.title}</strong><small>{entity.kind === 'album' ? chronology(entity) : entity.subtitle}</small></span>
								<em>{entity.kind === 'album' ? 'Timeline' : `Branch depth ${entity.branchDepth}`}</em>
							</button>
						</li>
					{/each}
				</ol>
			</dialog>
		</div>
	{/if}
</div>
