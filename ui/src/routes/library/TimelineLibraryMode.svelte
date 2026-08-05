<script lang="ts">
	import { getContext, onMount, tick, untrack } from 'svelte';
	import { get } from 'svelte/store';
	import { page } from '$app/state';
	import type { LibraryIntent } from '$lib/libraryIntent';
	import type { AlbumActionChoice, AlbumActionSemantic } from '@shared/albumActionContracts';
	import { CATALOG_ARTIST_QUERY_MAX_LENGTH } from '@shared/timelineCatalogContracts';
	import type { Zone } from '@shared/types';
	import {
		createTimelineCanvasModel,
		createTimelineBranchLayout,
		fitCamera,
		orderedTimelineAlbums,
		projectTimelineCanvasModel,
		reduceTimelineManualPlacement,
		semanticZoomTier,
		timelineKeyboardTarget,
		worldToScreen,
		zoomCameraAtPoint,
		type Camera,
		type ScreenViewport,
		type SemanticZoomTier,
		type TimelineAlbumLayoutInput,
		type TimelineAlbumEntity,
		type TimelineBranchAlbumEntity,
		type TimelineCanvasModel,
		type TimelineManualOffset,
		type TimelineManualPlacementCommand
	} from '$lib/timeline';
	import type {
		TimelineAlbumDragPreview,
		TimelineAlbumDragCancel,
		TimelineAlbumDragCommit,
		TimelineAlbumDropHitTest,
		TimelineAlbumDropTarget,
		TimelineAlbumTap,
		TimelineCameraGestureCancel,
		TimelineCameraGestureCommit,
		TimelineCameraGesturePreview,
		TimelineWheelIdle
	} from '$lib/timeline/TimelineGestureController';
	import {
		buildTimelineLibraryPageState,
		buildTimelineRootPageState,
		normalizeLibraryPageStateEnvelope,
		type TimelineLibraryPageState
	} from '$lib/libraryPageState';
	import {
		LIBRARY_MODE_ACTIVATION_CONTEXT,
		type CommittedLibraryModeActivation,
		type LibraryModeActivationContext
	} from '$lib/libraryModeActivationContext';
	import {
		timelineBrowseSessionStore,
		type TimelineBrowseSessionState,
		type TimelineBrowseSessionStore
	} from '$lib/stores/timelineBrowseSessionStore';
	import { coreStore } from '$lib/stores/coreStore';
	import {
		TIMELINE_BRANCH_MAX_DEPTH,
		TIMELINE_BRANCH_MAX_OPEN,
		timelineBranchStore as productionTimelineBranchStore,
		type TimelineArtistBranch,
		type TimelineBranchScope,
		type TimelineBranchSourceRef,
		type TimelineBranchStore
	} from '$lib/stores/timelineBranchStore';
	import { socketStatusStore } from '$lib/stores/socketStatusStore';
	import { zonesStore } from '$lib/stores/zonesStore';
	import { pushCommandFeedback, type CommandSource } from '$lib/stores/commandFeedbackStore';
	import {
		libraryViewHostStore,
		openLibraryIntentInClassic
	} from '$lib/stores/libraryViewHostStore';
	import {
		claimLibraryIntent,
		pendingLibraryIntentStore
	} from '$lib/stores/libraryIntentStore';
	import {
		canvasWorkspaceStore as productionCanvasWorkspaceStore,
		fingerprintCanvasWorkspaceModel,
		type CanvasWorkspaceScope,
		type CanvasWorkspacePlacementToken,
		type CanvasWorkspaceStore
	} from '$lib/stores/canvasWorkspaceStore';
	import { createCanvasNavigationCoordinator } from '$lib/timeline/CanvasNavigationCoordinator';
	import {
		TimelineAlbumActionController,
		type TimelineAlbumActionSocket,
		type TimelineAlbumActionState
	} from '$lib/timeline/TimelineAlbumActionController';
	import type { TimelineAlbumDetailViewModel } from '$lib/timeline/detailView';
	import { getTimelineTabId } from '$lib/timeline/tabId';
	import { getTimelineSessionPageState } from '$lib/timelinePageSessionState';
	import { getSocket } from '$lib/socket/client';
	import { inertSubtree } from '$lib/actions/inertSubtree';
	import CanvasViewport from './timeline/CanvasViewport.svelte';
	import TimelineAlbumActionChooser, {
		type TimelineAlbumActionChooserPhase
	} from './timeline/TimelineAlbumActionChooser.svelte';
	import TimelineAlbumActionsMenu from './timeline/TimelineAlbumActionsMenu.svelte';
	import TimelineOpenInClassicDialog from './timeline/TimelineOpenInClassicDialog.svelte';
	import TimelineBrowseList from './timeline/TimelineBrowseList.svelte';
	import TimelineBranchSearch, {
		type TimelineBranchSearchCandidate
	} from './timeline/TimelineBranchSearch.svelte';
	import TimelineZoneDock, {
		type TimelineZoneDockControls
	} from './timeline/TimelineZoneDock.svelte';

	const DEFAULT_VIEWPORT: ScreenViewport = { x: 0, y: 0, width: 1_400, height: 900 };
	const INITIAL_MAX_SCALE = 1.18;
	const INITIAL_CAMERA = fitCamera(
		{ x: -1, y: -1, width: 2, height: 2 },
		DEFAULT_VIEWPORT,
		{ padding: 160, maxScale: INITIAL_MAX_SCALE }
	);

	type TimelineCanvasGestureControls = {
		cancelActive(): boolean;
		cancelWheel(): void;
		resumeRuntime(): void;
		suspendRuntime(): void;
	};

	type ActivePointerPlacement = {
		gestureId: number;
		albumLocalId: string;
		token: CanvasWorkspacePlacementToken;
		canonicalModel: TimelineCanvasModel;
		viewport: ScreenViewport;
		scale: number;
	};

	type PendingAlbumActionStart = {
		nodeId: string;
		albumLocalId: string;
		albumTitle: string;
		zoneId: string;
		zoneName: string;
		zoneFingerprint: string;
		sessionHandleId: string;
		generation: number;
		coreId: string;
		returnElement: HTMLElement | null;
		returnFocusId: string;
	};

	type AlbumActionContext = PendingAlbumActionStart & {
		selectedChoice: AlbumActionChoice | null;
	};

	type TimelineWorkspaceAlbumEntity = TimelineAlbumEntity | TimelineBranchAlbumEntity;

	let {
		artistName: suppliedArtistName,
		albums: suppliedAlbums,
		onArtistSearch,
		browseStore = timelineBrowseSessionStore,
		branchStore = productionTimelineBranchStore,
		workspaceStore = productionCanvasWorkspaceStore,
		albumActionController: suppliedAlbumActionController
	}: {
		artistName?: string | null;
		albums?: readonly TimelineAlbumLayoutInput[];
		onArtistSearch?: (query: string) => void;
		browseStore?: TimelineBrowseSessionStore;
		branchStore?: TimelineBranchStore;
		workspaceStore?: CanvasWorkspaceStore;
		albumActionController?: TimelineAlbumActionController;
	} = $props();
	const albumActionController = untrack(() => suppliedAlbumActionController) ?? new TimelineAlbumActionController({
		getSocket: () => getSocket() as unknown as TimelineAlbumActionSocket | null
	});
	const activationContext = getContext<LibraryModeActivationContext | undefined>(
		LIBRARY_MODE_ACTIVATION_CONTEXT
	);

	let frame: HTMLElement;
	let searchInput: HTMLInputElement;
	let artistResultList = $state<HTMLUListElement>();
	let query = $state('');
	let lastSynchronizedQuery: string | null = null;
	let viewport = $state<ScreenViewport>({ ...DEFAULT_VIEWPORT });
	let usesInjectedData = $derived(
		suppliedArtistName !== undefined || suppliedAlbums !== undefined || onArtistSearch !== undefined
	);
	let artistName = $derived(
		suppliedArtistName === undefined
			? ($browseStore.selectedArtist?.exactName ?? null)
			: suppliedArtistName
	);
	let albums = $derived(suppliedAlbums ?? $browseStore.albums);
	let searchEnabled = $derived(!usesInjectedData || onArtistSearch !== undefined);
	let artistPickerLanding = $derived(
		!usesInjectedData && $browseStore.selectedArtist === null
	);
	let visibleArtistCandidates = $derived($browseStore.candidates.slice(0, 40));
	let indexedArtistCount = $derived(
		!usesInjectedData && $browseStore.catalogStatus?.available
			? $browseStore.catalogStatus.artistCount
			: null
	);
	let showArtistResults = $derived(
		!usesInjectedData &&
		(
			($browseStore.statusPhase === 'loading' && !$browseStore.catalogStatus) ||
			$browseStore.statusPhase === 'error' ||
			$browseStore.searchPhase !== 'idle' ||
			$browseStore.refreshPhase !== 'idle' ||
			$browseStore.selectionPhase === 'loading' ||
			$browseStore.selectionPhase === 'error' ||
			$browseStore.catalogStatus?.available === false ||
			$browseStore.catalogStatus?.persistence === 'degraded' ||
			$browseStore.catalogStatus?.freshness === 'stale'
		)
	);
	let canonicalModel = $derived(createTimelineCanvasModel(albums));
	let workspaceScope = $derived.by<CanvasWorkspaceScope | null>(() => {
		if (usesInjectedData) {
			return {
				coreId: 'injected-timeline-fixture',
				artistLocalId: artistName ?? 'anonymous-injected-artist'
			};
		}
		const selectedArtist = $browseStore.selectedArtist;
		const catalogCoreId = $browseStore.catalogStatus?.coreId ?? null;
		const discography = $browseStore.discography;
		if (!selectedArtist || !catalogCoreId || !discography) return null;
		if (
			selectedArtist.coreId !== catalogCoreId ||
			discography.status.coreId !== catalogCoreId ||
			discography.artist.coreId !== catalogCoreId ||
			discography.artist.localId !== selectedArtist.localId
		) return null;
		const pairedCoreId = $coreStore.status === 'paired' ? ($coreStore.core?.id ?? null) : null;
		if (pairedCoreId !== null && pairedCoreId !== catalogCoreId) return null;
		return { coreId: catalogCoreId, artistLocalId: selectedArtist.localId };
	});
	let canonicalWorkspaceFingerprint = $derived(
		fingerprintCanvasWorkspaceModel(
			canonicalModel.entities.map((entity) => ({
				id: entity.id,
				x: entity.anchorX,
				y: entity.anchorY
			}))
		)
	);
	let activeManualOffsets = $derived.by(() => {
		if (
			!workspaceScope ||
			$workspaceStore.scope?.coreId !== workspaceScope.coreId ||
			$workspaceStore.scope.artistLocalId !== workspaceScope.artistLocalId ||
			$workspaceStore.modelFingerprint !== canonicalWorkspaceFingerprint
		) return new Map<string, { x: number; y: number }>();
		return new Map(
			$workspaceStore.offsets.map((offset) => [
				offset.albumLocalId,
				{ x: offset.dx, y: offset.dy }
			])
		);
	});
	let model = $derived(projectTimelineCanvasModel(canonicalModel, activeManualOffsets));
	let branchScope = $derived.by<TimelineBranchScope | null>(() => {
		if (usesInjectedData || !workspaceScope || !$browseStore.catalogStatus) return null;
		return {
			coreId: workspaceScope.coreId,
			baseArtistLocalId: workspaceScope.artistLocalId,
			catalogRevision: $browseStore.catalogStatus.revision,
			sourceGeneration: $browseStore.session?.generation ?? 0
		};
	});
	let compatibleBranchPublications = $derived.by<readonly TimelineArtistBranch[]>(() => {
		const scope = branchScope;
		const storedScope = $branchStore.scope;
		if (
			!scope ||
			!storedScope ||
			storedScope.coreId !== scope.coreId ||
			storedScope.baseArtistLocalId !== scope.baseArtistLocalId ||
			storedScope.catalogRevision !== scope.catalogRevision
		) return [];
		const accepted: TimelineArtistBranch[] = [];
		const acceptedById = new Map<string, TimelineArtistBranch>();
		for (const branch of $branchStore.branches) {
			const validSource = branch.source.kind === 'base-album'
				? branch.source.parentBranchId === null && model.entityById.has(branch.source.entityId)
				: branch.source.parentBranchId !== null &&
					acceptedById.get(branch.source.parentBranchId)?.albums.some(
						(album) => album.entityId === branch.source.entityId
					) === true;
			if (!validSource) continue;
			accepted.push(branch);
			acceptedById.set(branch.branchId, branch);
		}
		return accepted;
	});
	let branchLayout = $derived(createTimelineBranchLayout(
		model,
		compatibleBranchPublications.map((branch) => ({
			...branch,
			truncated: branch.catalogTruncated
		}))
	));
	let orderedAlbums = $derived(orderedTimelineAlbums(model.entities));
	let listAlbums = $derived([
		...orderedAlbums,
		...branchLayout.groups.flatMap((group) =>
			group.entities.map((entity) => ({
				...entity,
				provenanceLabel: `Artist search · ${group.header.artistName}`
			}))
		)
	]);
	let selectedWorkspaceEntityId = $derived.by<string | null>(() => {
		const descriptor = $browseStore.selectedAlbumDescriptor;
		if (!descriptor) return null;
		const baseArtistLocalId = $browseStore.selectedArtist?.localId;
		if (
			(!descriptor.artistLocalId || descriptor.artistLocalId === baseArtistLocalId) &&
			model.entityById.has(descriptor.localId)
		) return descriptor.localId;
		return branchLayout.entities.find((entity) =>
			entity.albumLocalId === descriptor.localId &&
			entity.artistLocalId === descriptor.artistLocalId
		)?.id ?? null;
	});
	let detailView = $derived.by<TimelineAlbumDetailViewModel | null>(() => {
		if (usesInjectedData) return null;
		const album = $browseStore.selectedAlbumDescriptor;
		if (!album) return null;
		const baseArtistLocalId = $browseStore.selectedArtist?.localId;
		if (
			album.artistLocalId &&
			album.artistLocalId !== baseArtistLocalId &&
			selectedWorkspaceEntityId === null
		) return null;
		if (
			$browseStore.detailFailureCode === 'ALBUM_NOT_FOUND' ||
			$browseStore.detailFailureCode === 'ALBUM_AMBIGUOUS'
		) {
			return {
				album,
				detail: null,
				phase: 'resolve-required',
				message:
					$browseStore.detailError === 'Resolve required' ? null : $browseStore.detailError
			};
		}
		if ($browseStore.detailPhase === 'loading') {
			return { album, detail: null, phase: 'loading', message: null };
		}
		if ($browseStore.detail && $browseStore.detail.album.localId === album.localId) {
			return { album, detail: $browseStore.detail, phase: 'ready', message: null };
		}
		return {
			album,
			detail: null,
			phase: 'error',
			message: $browseStore.detailError
		};
	});
	let camera = $state<Camera>({ ...INITIAL_CAMERA });
	let tier = $state<SemanticZoomTier>(semanticZoomTier(INITIAL_CAMERA.scale));
	let requestedFocusId = $state<string | null>(null);
	let focusedAlbumId = $derived.by<string | null>(() => {
		if (requestedFocusId && workspaceEntityById(requestedFocusId)) return requestedFocusId;
		if (selectedWorkspaceEntityId && workspaceEntityById(selectedWorkspaceEntityId)) {
			return selectedWorkspaceEntityId;
		}
		return orderedAlbums[0]?.id ?? branchLayout.entities[0]?.id ?? null;
	});
	let focusedAlbum = $derived(
		focusedAlbumId ? workspaceEntityById(focusedAlbumId) : null
	);
	let detailAnchor = $derived(
		selectedWorkspaceEntityId ? workspaceEntityById(selectedWorkspaceEntityId) : null
	);
	let listOpen = $state(false);
	let listReturnFocusId = $state<string | null>(null);
	let actionMenu = $state<{ albumId: string; left: number; top: number } | null>(null);
	let actionMenuReturnFocus: HTMLElement | null = null;
	let branchSearchSource = $state<TimelineBranchSourceRef | null>(null);
	let branchSearchReturnFocusId = $state<string | null>(null);
	let classicFallbackIntent = $state<LibraryIntent | null>(null);
	let classicFallbackReturnFocus: HTMLElement | null = null;
	let classicFallbackReturnFocusId: string | null = null;
	let classicFallbackActivationPending = $state(false);
	let classicFallbackGeneration = 0;
	let classicShortcutsOpen = $state(false);
	let preserveClassicFallbackOnMenuDismiss = false;
	let suppressActionMenuCloseAnnouncement = false;
	let albumActionState = $state<TimelineAlbumActionState>(albumActionController.snapshot());
	let albumActionContext = $state<AlbumActionContext | null>(null);
	let albumActionStartGeneration = 0;
	let albumActionSubscription: (() => void) | null = null;
	let detachedAlbumActionSubscription: (() => void) | null = null;
	let detachedAlbumExecutionPending = false;
	let componentTearingDown = false;
	let zoneDockControls: TimelineZoneDockControls | null = null;
	let highlightedZoneId = $state<string | null>(null);
	let albumActionChooserPhase = $derived.by<TimelineAlbumActionChooserPhase | null>(() => {
		if (
			albumActionState.phase === 'resolving' ||
			albumActionState.phase === 'choosing' ||
			albumActionState.phase === 'executing' ||
			albumActionState.phase === 'outcome-unknown'
		) return albumActionState.phase;
		return albumActionState.phase === 'failed' ? 'error' : null;
	});
	let albumActionModalOpen = $derived(
		albumActionContext !== null && albumActionChooserPhase !== null
	);
	let modalSurfaceOpen = $derived(
		listOpen ||
		actionMenu !== null ||
		branchSearchSource !== null ||
		albumActionModalOpen ||
		classicFallbackIntent !== null
	);
	let announcement = $state({ sequence: 0, text: '' });
	let mounted = $state(false);
	let lifecycleSuspended = $state(true);
	let activeActivation: CommittedLibraryModeActivation | null = null;
	let frameObserver: ResizeObserver | null = null;
	let windowListenersAttached = false;
	let focusGeneration = 0;
	let programmaticFocusId: string | null = null;
	let recoveryPending = false;
	let recoveryCorePublication: unknown = null;
	let recoveryTarget: TimelineLibraryPageState | null = null;
	let acceptedCoreId: string | null = null;
	let pendingAlbumActivationId: string | null = null;
	let gestureControls: TimelineCanvasGestureControls | null = null;
	let activePointerPlacement: ActivePointerPlacement | null = null;
	let albumActivationEnabled = $derived(
		!usesInjectedData &&
		workspaceScope !== null &&
		$socketStatusStore === 'connected' &&
		$coreStore.status === 'paired' &&
		$browseStore.selectedArtist !== null &&
		$browseStore.selectionPhase !== 'loading'
	);
	let branchActivationEnabled = $derived(
		albumActivationEnabled && $branchStore.lifecycle === 'active'
	);
	let branchRetryEnabled = $derived($branchStore.lifecycle === 'active');
	let albumActionBaseReady = $derived(
		!usesInjectedData &&
		workspaceScope !== null &&
		$socketStatusStore === 'connected' &&
		$coreStore.status === 'paired' &&
		$browseStore.sessionPhase === 'live' &&
		$browseStore.session !== null &&
		$browseStore.selectedArtist !== null &&
		$browseStore.discography !== null &&
		$browseStore.selectionPhase !== 'loading' &&
		albumActionState.phase === 'idle' &&
		albumActionContext === null
	);
	let timelineZoneViews = $derived(
		$zonesStore.map((zone) => ({
			id: zone.zone_id,
			name: zone.display_name,
			enabled: albumActionBaseReady
		}))
	);

	function announce(text: string): void {
		announcement = { sequence: announcement.sequence + 1, text };
	}

	function topModalSurface(): HTMLElement | null {
		return Array.from(
			document.querySelectorAll<HTMLElement>('[aria-modal="true"], dialog[open]')
		).filter((surface) => surface.isConnected).at(-1) ?? null;
	}

	function zoneFingerprint(zone: Zone): string {
		return JSON.stringify([
			zone.zone_id,
			(zone.outputs ?? []).map((output) => output.output_id).sort()
		]);
	}

	function workspaceEntityById(nodeId: string): TimelineWorkspaceAlbumEntity | null {
		return model.entityById.get(nodeId) ?? branchLayout.entityById.get(nodeId) ?? null;
	}

	function isBranchEntity(
		entity: TimelineWorkspaceAlbumEntity
	): entity is TimelineBranchAlbumEntity {
		return entity.kind === 'branch-album';
	}

	function stableAlbumLocalId(entity: TimelineWorkspaceAlbumEntity): string {
		return isBranchEntity(entity) ? entity.albumLocalId : entity.id;
	}

	function entityArtistLocalId(entity: TimelineWorkspaceAlbumEntity): string | null {
		return isBranchEntity(entity)
			? entity.artistLocalId
			: ($browseStore.selectedArtist?.localId ?? null);
	}

	function branchSourceForNode(nodeId: string): TimelineBranchSourceRef | null {
		const entity = workspaceEntityById(nodeId);
		if (!entity) return null;
		return isBranchEntity(entity)
			? branchStore.sourceForBranchAlbum(entity.id)
			: branchStore.sourceForBaseAlbum(entity.id, entity.id);
	}

	function branchCanAttachToNode(nodeId: string): boolean {
		const source = branchSourceForNode(nodeId);
		return Boolean(
			source &&
			albumActivationEnabled &&
			$branchStore.lifecycle === 'active' &&
			$branchStore.branches.length < TIMELINE_BRANCH_MAX_OPEN &&
			source.depth < TIMELINE_BRANCH_MAX_DEPTH
		);
	}

	function albumIsResolved(
		browse: TimelineBrowseSessionState,
		albumLocalId: string
	): boolean {
		return browse.discography?.albums.some(
			(album) => album.localId === albumLocalId && album.resolutionStatus === 'resolved'
		) === true;
	}

	function workspaceAlbumIsResolved(
		browse: TimelineBrowseSessionState,
		entity: TimelineWorkspaceAlbumEntity
	): boolean {
		return isBranchEntity(entity)
			? entity.resolutionStatus === 'resolved'
			: albumIsResolved(browse, entity.id);
	}

	function currentAlbumMarker(nodeId: string): HTMLElement | null {
		return [...(frame?.querySelectorAll<HTMLElement>('[data-album-id], [data-timeline-node-id]') ?? [])].find(
			(element) =>
				element.dataset.albumId === nodeId || element.dataset.timelineNodeId === nodeId
		) ?? null;
	}

	function actionCanStartForAlbum(nodeId: string): boolean {
		const browse = get(browseStore);
		const core = get(coreStore);
		const entity = workspaceEntityById(nodeId);
		return (
			!usesInjectedData &&
			workspaceScope !== null &&
			get(socketStatusStore) === 'connected' &&
			core.status === 'paired' &&
			core.core?.id === workspaceScope.coreId &&
			browse.sessionPhase === 'live' &&
			browse.session !== null &&
			browse.selectedArtist !== null &&
			browse.selectionPhase !== 'loading' &&
			entity !== null &&
			workspaceAlbumIsResolved(browse, entity) &&
			albumActionContext === null &&
			albumActionController.snapshot().phase === 'idle'
		);
	}

	function captureAlbumActionStart(
		nodeId: string,
		zoneId: string,
		returnElement: HTMLElement | null,
		returnFocusId: string
	): PendingAlbumActionStart | null {
		if (!actionCanStartForAlbum(nodeId) || !workspaceScope) return null;
		const browse = get(browseStore);
		const album = workspaceEntityById(nodeId);
		const zone = get(zonesStore).find((candidate) => candidate.zone_id === zoneId);
		if (!album || !zone || !browse.session) return null;
		return {
			nodeId,
			albumLocalId: stableAlbumLocalId(album),
			albumTitle: album.title,
			zoneId,
			zoneName: zone.display_name,
			zoneFingerprint: zoneFingerprint(zone),
			sessionHandleId: browse.session.handleId,
			generation: browse.session.generation,
			coreId: workspaceScope.coreId,
			returnElement: returnElement?.isConnected
				? returnElement
				: currentAlbumMarker(nodeId),
			returnFocusId
		};
	}

	function pendingAlbumActionIsCurrent(pending: PendingAlbumActionStart): boolean {
		const current = captureAlbumActionStart(
			pending.nodeId,
			pending.zoneId,
			pending.returnElement,
			pending.returnFocusId
		);
		return (
			current !== null &&
			current.nodeId === pending.nodeId &&
			current.albumLocalId === pending.albumLocalId &&
			current.coreId === pending.coreId &&
			current.sessionHandleId === pending.sessionHandleId &&
			current.generation === pending.generation &&
			current.zoneFingerprint === pending.zoneFingerprint
		);
	}

	function albumActionSource(semantic: AlbumActionSemantic): CommandSource {
		if (semantic === 'play-now') return 'transport';
		if (semantic === 'add-next' || semantic === 'queue') return 'queue';
		return 'browse';
	}

	function publishAlbumActionFeedback(
		state: TimelineAlbumActionState,
		context: AlbumActionContext
	): void {
		const choice = context.selectedChoice;
		if (!choice) return;
		const subject = `${choice.label} for ${context.albumTitle} in ${context.zoneName}`;
		if (state.phase === 'executed') {
			pushCommandFeedback({
				source: albumActionSource(choice.semantic),
				command: `timeline:album-action:${choice.semantic}`,
				message: `${subject} completed.`,
				kind: 'success'
			});
			return;
		}
		if (state.phase === 'failed') {
			pushCommandFeedback({
				source: albumActionSource(choice.semantic),
				command: `timeline:album-action:${choice.semantic}`,
				message: `${subject} failed: ${state.error ?? 'Roon rejected the action.'}`
			});
			return;
		}
		if (state.phase === 'outcome-unknown') {
			pushCommandFeedback({
				source: albumActionSource(choice.semantic),
				command: `timeline:album-action:${choice.semantic}`,
				message: `${subject} has an unknown outcome. Check Roon before trying again.`
			});
		}
	}

	function failAlbumActionStart(
		pending: PendingAlbumActionStart | null,
		message: string
	): void {
		announce(message);
		if (pending) {
			void restoreActionMenuFocus(
				pending.returnElement,
				pending.returnFocusId
			);
		}
	}

	function scheduleAlbumActionStart(
		nodeId: string,
		zoneId: string,
		returnElement: HTMLElement | null,
		returnFocusId: string
	): void {
		const operation = ++albumActionStartGeneration;
		const pending = captureAlbumActionStart(
			nodeId,
			zoneId,
			returnElement,
			returnFocusId
		);
		if (!pending) {
			failAlbumActionStart(null, 'Current Roon actions are unavailable; no command was sent.');
			void restoreActionMenuFocus(returnElement, returnFocusId);
			return;
		}
		void tick().then(() => {
			if (operation !== albumActionStartGeneration || !mounted) return;
			if (!pendingAlbumActionIsCurrent(pending)) {
				failAlbumActionStart(
					pending,
					'The album or target zone changed; no Roon command was sent.'
				);
				return;
			}
			let tabId: string;
			try {
				tabId = getTimelineTabId();
			} catch {
				failAlbumActionStart(
					pending,
					'Secure Timeline action identity is unavailable; no Roon command was sent.'
				);
				return;
			}
			albumActionContext = { ...pending, selectedChoice: null };
			const result = albumActionController.begin({
				albumLocalId: pending.albumLocalId,
				zoneId: pending.zoneId,
				tabId,
				generation: pending.generation
			});
			if (result.started) {
				const phase = albumActionController.snapshot().phase;
				if (phase === 'resolving') {
					announce(`Resolving current actions for ${pending.albumTitle} in ${pending.zoneName}.`);
				} else if (phase === 'choosing') {
					announce(`Choose one current Roon action for ${pending.albumTitle}.`);
				} else if (phase === 'failed' || phase === 'outcome-unknown') {
					announce(`Current Roon actions for ${pending.albumTitle} are unavailable.`);
				}
				return;
			}
			if (albumActionController.snapshot().phase === 'failed') return;
			albumActionContext = null;
			failAlbumActionStart(pending, 'Current Roon actions could not be opened; no command was sent.');
		});
	}

	function handleAlbumDragPreview(preview: TimelineAlbumDragPreview): void {
		const inspection = zoneDockControls?.inspect(preview.clientX, preview.clientY);
		highlightedZoneId = actionCanStartForAlbum(preview.albumLocalId)
			? inspection?.zoneId ?? null
			: null;
	}

	function resolveAlbumDropTarget(request: TimelineAlbumDropHitTest): TimelineAlbumDropTarget | null {
		const inspection = zoneDockControls?.inspect(request.clientX, request.clientY);
		highlightedZoneId = null;
		if (!inspection?.withinDock) return null;
		return {
			zoneId: actionCanStartForAlbum(request.albumLocalId) ? inspection.zoneId : null
		};
	}

	function cancelAlbumAction(message = 'Album action canceled; no Roon command was sent.'): void {
		const context = albumActionContext;
		if (!context || !albumActionController.cancel()) return;
		albumActionStartGeneration += 1;
		albumActionContext = null;
		albumActionController.reset();
		announce(message);
		void restoreActionMenuFocus(context.returnElement, context.returnFocusId);
	}

	function dismissAlbumActionResult(): void {
		const context = albumActionContext;
		const phase = albumActionController.snapshot().phase;
		if (!context || (phase !== 'failed' && phase !== 'outcome-unknown')) return;
		albumActionContext = null;
		albumActionController.reset();
		announce(`${context.albumTitle} action result closed.`);
		void restoreActionMenuFocus(context.returnElement, context.returnFocusId);
	}

	function executeAlbumAction(actionId: string): void {
		const context = albumActionContext;
		const state = albumActionController.snapshot();
		if (!context || state.phase !== 'choosing') return;
		const choice = state.actions.find((candidate) => candidate.actionId === actionId);
		if (!choice) return;
		albumActionContext = { ...context, selectedChoice: choice };
		if (!albumActionController.execute(actionId)) {
			albumActionContext = context;
		}
	}

	function completeExecutedAlbumAction(
		state: TimelineAlbumActionState,
		context: AlbumActionContext
	): void {
		albumActionContext = null;
		publishAlbumActionFeedback(state, context);
		albumActionController.reset();
		announce(`${context.selectedChoice?.label ?? 'Roon action'} completed for ${context.albumTitle}.`);
		void restoreActionMenuFocus(context.returnElement, context.returnFocusId);
	}

	function detachClaimedAlbumExecution(context: AlbumActionContext): void {
		if (detachedAlbumExecutionPending) return;
		albumActionSubscription?.();
		albumActionSubscription = null;
		detachedAlbumExecutionPending = true;
		detachedAlbumActionSubscription = albumActionController.subscribe((state) => {
			if (state.phase === 'executing') return;
			if (
				state.phase !== 'executed' &&
				state.phase !== 'failed' &&
				state.phase !== 'outcome-unknown'
			) return;
			publishAlbumActionFeedback(state, context);
			detachedAlbumActionSubscription?.();
			detachedAlbumActionSubscription = null;
			detachedAlbumExecutionPending = false;
			if (componentTearingDown) albumActionController.dispose();
			else albumActionController.reset();
		});
	}

	function applyCamera(nextCamera: Camera): void {
		tier = semanticZoomTier(nextCamera.scale, untrack(() => tier));
		camera = nextCamera;
	}

	function commitCamera(nextCamera: Camera): void {
		gestureControls?.cancelWheel();
		applyCamera(nextCamera);
	}

	function cancelCanvasGestures(): void {
		gestureControls?.cancelWheel();
		gestureControls?.cancelActive();
	}

	function reconcileCurrentWorkspace(): boolean {
		if (!workspaceScope) return false;
		const reconciled = workspaceStore.reconcile(
			workspaceScope,
			canonicalModel.entities.map((entity) => ({
				id: entity.id,
				x: entity.anchorX,
				y: entity.anchorY
			}))
		);
		if (!reconciled.accepted) return false;
		const current = get(workspaceStore);
		return (
			current.scope?.coreId === workspaceScope.coreId &&
			current.scope.artistLocalId === workspaceScope.artistLocalId &&
			current.modelFingerprint === canonicalWorkspaceFingerprint
		);
	}

	$effect(() => {
		const synchronizedQuery = usesInjectedData
			? (artistName ?? '')
			: ($browseStore.query || artistName || '');
		if (synchronizedQuery === lastSynchronizedQuery) return;
		lastSynchronizedQuery = synchronizedQuery;
		query = synchronizedQuery;
	});

	$effect(() => {
		reconcileCurrentWorkspace();
	});

	$effect(() => {
		page.state;
		albumActionStartGeneration += 1;
		const controls = gestureControls;
		if (!controls) return;
		controls.cancelWheel();
		controls.cancelActive();
	});

	$effect(() => {
		if (!usesInjectedData) return;
		commitCamera(fitCamera(canonicalModel.bounds, viewport, {
			padding: albums.length <= 1 ? 250 : 120,
			maxScale: INITIAL_MAX_SCALE
		}));
	});

	$effect(() => {
		const menuTarget = actionMenu?.albumId ?? null;
		const activeBranchSearchSource = branchSearchSource;
		const branchSearchTarget = activeBranchSearchSource?.entityId ?? null;
		const branchLifecycle = $branchStore.lifecycle;
		const requestedTarget = requestedFocusId;
		const fallback = selectedWorkspaceEntityId ?? orderedAlbums[0]?.id ?? branchLayout.entities[0]?.id ?? null;
		const currentBranchSearchSource = branchSearchTarget
			? branchSourceForNode(branchSearchTarget)
			: null;
		if (
			activeBranchSearchSource &&
			(
				branchLifecycle !== 'active' ||
				!sameBranchSource(currentBranchSearchSource, activeBranchSearchSource)
			)
		) {
			const returnId = branchSearchReturnFocusId;
			branchStore.cancelSearch();
			branchSearchSource = null;
			branchSearchReturnFocusId = null;
			announce(
				branchLifecycle === 'active'
					? 'The artist branch source is no longer in this Timeline.'
					: 'Artist branch search closed because Timeline is unavailable.'
			);
			if (returnId && workspaceEntityById(returnId)) {
				void focusAlbum(returnId, { pan: false });
			}
		}
		if (menuTarget && !workspaceEntityById(menuTarget)) {
			const returnElement = actionMenuReturnFocus;
			actionMenu = null;
			actionMenuReturnFocus = null;
			focusGeneration += 1;
			requestedFocusId = fallback;
			announce('The album actions target is no longer in this Timeline.');
			void restoreActionMenuFocus(returnElement, fallback);
			return;
		}
		if (!requestedTarget || workspaceEntityById(requestedTarget)) return;
		const active = document.activeElement as HTMLElement | null;
		const operation = ++focusGeneration;
		requestedFocusId = fallback;
		if (
			!listOpen &&
			(active === document.body ||
				!active?.isConnected ||
				active.dataset.albumId === requestedTarget ||
				active.dataset.timelineNodeId === requestedTarget ||
				active.matches(':disabled'))
		) {
			if (fallback) void focusAlbum(fallback, { pan: false });
			else {
				void tick().then(() => {
					if (
						operation === focusGeneration &&
						!modalSurfaceOpen &&
						topModalSurface() === null
					) searchInput?.focus();
				});
			}
		}
	});

	$effect(() => {
		const state = albumActionState;
		const context = albumActionContext;
		if (state.phase !== 'executed' || !context) return;
		untrack(() => completeExecutedAlbumAction(state, context));
	});

	$effect(() => {
		const state = albumActionState;
		const context = albumActionContext;
		const socketStatus = $socketStatusStore;
		const core = $coreStore;
		const browse = $browseStore;
		const zones = $zonesStore;
		const currentModel = model;
		const currentBranchLayout = branchLayout;
		const scope = workspaceScope;
		if (
			!context ||
			(state.phase !== 'resolving' && state.phase !== 'choosing')
		) return;
		const zone = zones.find((candidate) => candidate.zone_id === context.zoneId);
		const currentEntity =
			currentModel.entityById.get(context.nodeId) ??
			currentBranchLayout.entityById.get(context.nodeId) ??
			null;
		const remainsCurrent =
			!usesInjectedData &&
			socketStatus === 'connected' &&
			core.status === 'paired' &&
			core.core?.id === context.coreId &&
			scope?.coreId === context.coreId &&
			browse.sessionPhase === 'live' &&
			browse.session?.handleId === context.sessionHandleId &&
			browse.session?.generation === context.generation &&
			currentEntity !== null &&
			stableAlbumLocalId(currentEntity) === context.albumLocalId &&
			workspaceAlbumIsResolved(browse, currentEntity) &&
			zone !== undefined &&
			zoneFingerprint(zone) === context.zoneFingerprint;
		if (remainsCurrent) return;
		untrack(() =>
			cancelAlbumAction(
				'The album, session, or target zone changed; no Roon command was sent.'
			)
		);
	});

	function semanticTimelineTarget(): TimelineLibraryPageState {
		const currentPageState = normalizeLibraryPageStateEnvelope(page.state);
		if (currentPageState?.libraryView === 'timeline') return currentPageState;
		const committed = activationContext?.committedActivation?.()?.pageState;
		if (committed?.libraryView === 'timeline') return committed;
		const sessionTarget = getTimelineSessionPageState();
		if (sessionTarget) return sessionTarget;
		return buildTimelineLibraryPageState({
			...buildTimelineRootPageState().snapshot,
			camera: { x: camera.centerX, y: camera.centerY, scale: camera.scale }
		});
	}

	function currentTimelinePageState(): TimelineLibraryPageState | null {
		const current = normalizeLibraryPageStateEnvelope(page.state);
		return current?.libraryView === 'timeline' ? current : null;
	}

	function recoveryTimelineTarget(): TimelineLibraryPageState {
		const target = semanticTimelineTarget();
		return buildTimelineLibraryPageState({
			...target.snapshot,
			camera: { x: camera.centerX, y: camera.centerY, scale: camera.scale }
		});
	}

	async function focusAlbum(
		nodeId: string,
		options: { pan?: boolean; announceMove?: boolean } = {}
	): Promise<boolean> {
		let entity = workspaceEntityById(nodeId);
		if (!entity) return false;
		const operation = ++focusGeneration;
		requestedFocusId = nodeId;
		if (options.pan !== false) {
			commitCamera({ ...camera, centerX: entity.x, centerY: entity.y });
		}
		await tick();
		if (operation !== focusGeneration || !mounted || modalSurfaceOpen) {
			return false;
		}
		entity = workspaceEntityById(nodeId);
		if (!entity) return false;
		if (
			options.pan !== false &&
			(camera.centerX !== entity.x || camera.centerY !== entity.y)
		) {
			commitCamera({ ...camera, centerX: entity.x, centerY: entity.y });
			await tick();
			if (operation !== focusGeneration || !mounted || modalSurfaceOpen) {
				return false;
			}
			entity = workspaceEntityById(nodeId);
			if (!entity) return false;
		}
		const marker = currentAlbumMarker(nodeId);
		if (!marker) return false;
		programmaticFocusId = nodeId;
		marker.focus({ preventScroll: true });
		if (programmaticFocusId === nodeId) programmaticFocusId = null;
		if (options.announceMove) {
			announce(`${entity.title}, ${entity.chronologyLabel}`);
		}
		return true;
	}

	const navigation = createCanvasNavigationCoordinator({
		browseStore: untrack(() => browseStore),
		viewport: () => viewport,
		camera: () => camera,
		model: () => model,
		currentPageState: currentTimelinePageState,
		beforeSemanticCommit: cancelCanvasGestures,
		applyCamera: commitCamera,
		focusAlbum: async (albumLocalId) => {
			await focusAlbum(albumLocalId, { pan: false });
		}
	});

	function commitUserCamera(nextCamera: Camera): void {
		gestureControls?.cancelActive();
		commitCamera(nextCamera);
		if (!usesInjectedData) navigation.replaceCameraPageState(nextCamera);
	}

	function updateViewport(width: number, height: number): void {
		if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
		viewport = { x: 0, y: 0, width, height };
	}

	function fit(): void {
		commitUserCamera(fitCamera(branchLayout.bounds, viewport, {
			padding: listAlbums.length <= 1 ? 250 : 120,
			maxScale: INITIAL_MAX_SCALE
		}));
		announce('Timeline content fitted in the canvas.');
	}

	function recenter(): void {
		const first = orderedTimelineAlbums(canonicalModel.entities)[0];
		commitUserCamera({
			centerX: first?.anchorX ?? 0,
			centerY: 0,
			scale: Math.max(0.82, Math.min(1.08, camera.scale))
		});
		announce('Timeline recentered on its canonical origin.');
	}

	function zoomBy(factor: number): void {
		commitUserCamera(zoomCameraAtPoint(
			camera,
			camera.scale * factor,
			{ x: viewport.x + viewport.width / 2, y: viewport.y + viewport.height / 2 },
			viewport
		));
	}

	function runArtistSearch(queryValue: string): void {
		const normalized = queryValue.trim();
		if (!normalized) return;
		query = normalized;
		cancelCanvasGestures();
		if (usesInjectedData) {
			onArtistSearch?.(normalized);
			return;
		}
		void browseStore.search(normalized);
	}

	function submitSearch(event: SubmitEvent): void {
		event.preventDefault();
		runArtistSearch(query);
	}

	function enabledArtistResultButtons(): HTMLButtonElement[] {
		return artistResultList
			? [...artistResultList.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
			: [];
	}

	function handleArtistSearchKeydown(event: KeyboardEvent): void {
		if (
			event.key !== 'ArrowDown' ||
			event.altKey ||
			event.ctrlKey ||
			event.metaKey ||
			event.isComposing
		) return;
		const firstResult = enabledArtistResultButtons()[0];
		if (!firstResult) return;
		event.preventDefault();
		firstResult.focus();
	}

	function handleArtistResultKeydown(event: KeyboardEvent): void {
		if (
			!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) ||
			event.altKey ||
			event.ctrlKey ||
			event.metaKey ||
			event.isComposing
		) return;
		const buttons = enabledArtistResultButtons();
		const currentIndex = buttons.indexOf(event.currentTarget as HTMLButtonElement);
		if (currentIndex < 0 || buttons.length === 0) return;
		event.preventDefault();
		if (event.key === 'ArrowUp' && currentIndex === 0) {
			searchInput?.focus();
			return;
		}
		const nextIndex = event.key === 'Home'
			? 0
			: event.key === 'End'
				? buttons.length - 1
				: (currentIndex + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
		buttons[nextIndex]?.focus();
	}

	function classicFallbackTitle(intent: LibraryIntent): string {
		if (intent.destination === 'search') {
			const title = intent.display?.title ?? intent.query;
			if (intent.kind === 'album') return `album “${title}”`;
			if (intent.kind === 'track') return `track “${title}”`;
			if (intent.kind === 'artist') return `artist “${title}”`;
			return `all results for “${title}”`;
		}
		if (intent.destination === 'welcome-section') {
			return intent.section === 'favorites' ? 'Favorites' : 'Recently Played';
		}
		if (intent.destination === 'explore-path') {
			return intent.labelPath.at(-1) ?? 'this Explore path';
		}
		return `${intent.categoryTitle} results`;
	}

	function classicFallbackDescription(intent: LibraryIntent): string {
		if (intent.destination === 'search') {
			if (intent.kind === 'general') {
				return 'Classic will run a fresh full-library search for this query.';
			}
			return `Classic will search for this ${intent.kind}. Choose the matching result there; no live Roon item is transferred.`;
		}
		if (intent.destination === 'welcome-section') {
			return 'Classic will reopen this section from a safe Library root.';
		}
		return 'Classic will re-resolve this destination from a safe Library root. If the Core’s current hierarchy no longer matches, it will stop at a useful surface and explain why.';
	}

	function offerClassicFallback(
		intent: LibraryIntent,
		options: { opener?: HTMLElement | null; returnFocusId?: string | null } = {}
	): void {
		if (classicFallbackActivationPending) return;
		classicFallbackGeneration += 1;
		classicShortcutsOpen = false;
		classicFallbackReturnFocus = options.opener?.isConnected
			? options.opener
			: document.activeElement instanceof HTMLElement && document.activeElement.isConnected
				? document.activeElement
				: null;
		classicFallbackReturnFocusId = options.returnFocusId ?? focusedAlbumId;
		classicFallbackIntent = intent;
		announce(`${classicFallbackTitle(intent)} can be opened in Classic Library view.`);
	}

	function clearClassicFallback(): void {
		classicFallbackGeneration += 1;
		classicFallbackActivationPending = false;
		classicFallbackIntent = null;
		classicFallbackReturnFocus = null;
		classicFallbackReturnFocusId = null;
	}

	async function cancelClassicFallback(): Promise<void> {
		if (classicFallbackActivationPending) return;
		const returnElement = classicFallbackReturnFocus;
		const returnId = classicFallbackReturnFocusId;
		clearClassicFallback();
		announce('Open in Classic cancelled.');
		await tick();
		if (classicFallbackIntent !== null) return;
		if (
			returnElement?.isConnected &&
			returnElement.closest('[inert]') === null &&
			!returnElement.matches(':disabled')
		) {
			returnElement.focus({ preventScroll: true });
			if (document.activeElement === returnElement) return;
		}
		if (returnId && await focusAlbum(returnId, { pan: false })) return;
		searchInput?.focus();
	}

	async function confirmClassicFallback(): Promise<void> {
		const intent = classicFallbackIntent;
		if (!intent || classicFallbackActivationPending) return;
		const title = classicFallbackTitle(intent);
		const requestGeneration = ++classicFallbackGeneration;
		classicFallbackActivationPending = true;
		const activation = openLibraryIntentInClassic(intent);
		if (!activation) {
			if (requestGeneration !== classicFallbackGeneration) return;
			classicFallbackActivationPending = false;
			const message = 'Classic Library view is not ready to open this destination.';
			pushCommandFeedback({
				source: 'browse',
				command: 'open-in-classic',
				message
			});
			announce(message);
			return;
		}
		const outcome = await activation;
		if (requestGeneration !== classicFallbackGeneration) return;
		if (outcome !== 'activated') {
			classicFallbackActivationPending = false;
			const message = outcome === 'failed'
				? 'Classic Library view could not open this destination. Try again.'
				: 'Open in Classic was superseded by a newer Library view request.';
			pushCommandFeedback({
				source: 'browse',
				command: 'open-in-classic',
				message
			});
			announce(message);
			return;
		}
		clearClassicFallback();
		announce(`Opening ${title} in Classic Library view.`);
	}

	function offerSearchEverythingInClassic(opener?: HTMLElement | null): void {
		const normalized = query.trim();
		if (!normalized) return;
		offerClassicFallback({
			kind: 'general',
			destination: 'search',
			query: normalized,
			display: { title: normalized }
		}, { opener });
	}

	function offerAlbumInClassic(entity: TimelineWorkspaceAlbumEntity): void {
		preserveClassicFallbackOnMenuDismiss = true;
		suppressActionMenuCloseAnnouncement = true;
		offerClassicFallback({
			kind: 'album',
			destination: 'search',
			query: entity.title,
			localDescriptorId: stableAlbumLocalId(entity),
			display: { title: entity.title, artist: entity.artist }
		}, { returnFocusId: entity.id });
	}

	function offerTrackInClassic(trackTitle: string): void {
		const album = detailView?.album;
		if (!album) return;
		offerClassicFallback({
			kind: 'track',
			destination: 'search',
			query: trackTitle,
			display: {
				title: trackTitle,
				artist: album.exactArtist,
				album: album.exactTitle
			}
		}, { returnFocusId: selectedWorkspaceEntityId });
	}

	function offerWelcomeInClassic(
		section: 'favorites' | 'recently-played',
		opener: HTMLElement
	): void {
		offerClassicFallback({
			kind: 'general',
			destination: 'welcome-section',
			section
		}, { opener });
	}

	function offerCurrentArtistInClassic(opener: HTMLElement): void {
		const title = artistName?.trim();
		if (!title) return;
		const localDescriptorId = usesInjectedData
			? undefined
			: $browseStore.selectedArtist?.localId;
		offerClassicFallback({
			kind: 'artist',
			destination: 'search',
			query: title,
			...(localDescriptorId ? { localDescriptorId } : {}),
			display: { title }
		}, { opener });
	}

	function handleIncomingLibraryIntent(intent: LibraryIntent): void {
		if (
			intent.destination === 'search' &&
			(intent.kind === 'artist' || intent.kind === 'general') &&
			intent.query.length <= CATALOG_ARTIST_QUERY_MAX_LENGTH
		) {
			runArtistSearch(intent.query);
			announce(
				intent.kind === 'artist'
					? `Searching Timeline artists for ${intent.query}.`
					: `Searching Timeline artists for ${intent.query}; all results remain available in Classic.`
			);
			return;
		}
		offerClassicFallback(intent, { opener: null, returnFocusId: focusedAlbumId });
	}

	function selectCandidate(localId: string): void {
		cancelCanvasGestures();
		void navigation.selectArtist(localId);
	}

	function openBranchSearch(nodeId: string): void {
		const source = branchSourceForNode(nodeId);
		const entity = workspaceEntityById(nodeId);
		if (!source || !entity || !branchCanAttachToNode(nodeId)) {
			announce('Another artist branch cannot be attached from this album.');
			return;
		}
		cancelCanvasGestures();
		branchStore.cancelSearch();
		branchSearchSource = source;
		branchSearchReturnFocusId = nodeId;
		requestedFocusId = nodeId;
		announce(`Artist search opened for ${entity.title}.`);
	}

	function cancelBranchSearch(): void {
		const returnId = branchSearchReturnFocusId;
		branchStore.cancelSearch();
		branchSearchSource = null;
		branchSearchReturnFocusId = null;
		announce('Artist branch search closed.');
		if (returnId) void focusAlbum(returnId, { pan: false });
	}

	function searchBranchArtists(queryValue: string): void {
		const source = branchSearchSource;
		if (!source) return;
		void branchStore.searchArtists(source, queryValue);
	}

	function sameBranchSource(
		left: TimelineBranchSourceRef | null,
		right: TimelineBranchSourceRef
	): boolean {
		return (
			left?.kind === right.kind &&
			left.entityId === right.entityId &&
			left.albumLocalId === right.albumLocalId &&
			left.parentBranchId === right.parentBranchId &&
			left.depth === right.depth &&
			left.sourceGeneration === right.sourceGeneration
		);
	}

	async function focusBranchControl(
		branchId: string,
		action: 'retry' | 'close'
	): Promise<boolean> {
		await tick();
		const header = Array.from(
			frame?.querySelectorAll<HTMLElement>('[data-timeline-branch-id]') ?? []
		).find((candidate) => candidate.dataset.timelineBranchId === branchId);
		const control = header?.querySelector<HTMLButtonElement>(
			`[data-timeline-branch-control="${action}"]`
		);
		if (!control?.isConnected || control.disabled) return false;
		control.focus({ preventScroll: true });
		return document.activeElement === control;
	}

	async function publishReadyBranch(
		branchId: string,
		artistLocalId: string,
		fallbackSourceId: string
	): Promise<void> {
		await tick();
		const group = branchLayout.groupById.get(branchId);
		if (!group) return;
		const target = group.entities[0] ?? workspaceEntityById(fallbackSourceId);
		const nextCamera = target
			? { ...camera, centerX: target.x, centerY: target.y }
			: camera;
		navigation.commitAuxiliaryArtist(artistLocalId, nextCamera);
		const focusId = group.entities[0]?.id ?? fallbackSourceId;
		requestedFocusId = focusId;
		await focusAlbum(focusId, { pan: true });
		announce(
			`${group.header.providerLabel} branch for ${group.header.artistName} attached with ${group.entities.length} ${group.entities.length === 1 ? 'album' : 'albums'}.`
		);
	}

	async function recoverBranchCatalogConflict(returnFocusId: string): Promise<void> {
		const refreshed = await browseStore.loadCatalogStatus();
		announce(
			refreshed
				? 'The music library changed. Open artist branch search again to use the latest catalog.'
				: 'The music library changed, but its latest catalog status could not be loaded.'
		);
		await tick();
		if (!await focusAlbum(returnFocusId, { pan: false })) searchInput?.focus();
	}

	async function chooseBranchArtist(candidate: TimelineBranchSearchCandidate): Promise<void> {
		const source = branchSearchSource;
		if (!source) return;
		const loading = branchStore.attachArtist(
			source,
			candidate.artistLocalId,
			(status, expectedRevision) =>
				browseStore.adoptAuxiliaryArtistHydration(status, expectedRevision)
		);
		branchSearchSource = null;
		branchSearchReturnFocusId = null;
		await tick();
		await focusAlbum(source.entityId, { pan: false });
		const result = await loading;
		if (result.success) {
			await publishReadyBranch(result.branchId, result.branch.artist.localId, source.entityId);
			return;
		}
		if (result.reason === 'catalog-conflict') {
			await recoverBranchCatalogConflict(source.entityId);
			return;
		}
		if (result.reason === 'failed' && result.branchId) {
			announce(`${candidate.name} branch could not be loaded. Retry or close it on the canvas.`);
			if (!await focusBranchControl(result.branchId, 'retry')) {
				if (!await focusBranchControl(result.branchId, 'close')) {
					await focusAlbum(source.entityId, { pan: false });
				}
			}
			return;
		}
		announce('That artist branch is no longer available to attach.');
		await focusAlbum(source.entityId, { pan: false });
	}

	async function retryBranch(branchId: string): Promise<void> {
		const before = $branchStore.branches.find((branch) => branch.branchId === branchId);
		if (!before) return;
		const result = await branchStore.retryBranch(
			branchId,
			(status, expectedRevision) =>
				browseStore.adoptAuxiliaryArtistHydration(status, expectedRevision)
		);
		if (result.success) {
			await publishReadyBranch(branchId, result.branch.artist.localId, result.branch.source.entityId);
			return;
		}
		if (result.reason === 'catalog-conflict') {
			await recoverBranchCatalogConflict(before.source.entityId);
			return;
		}
		if (result.reason !== 'superseded') {
			announce(`${before.artist.exactName} branch could not be loaded.`);
			if (!await focusBranchControl(branchId, 'retry')) {
				if (!await focusBranchControl(branchId, 'close')) {
					await focusAlbum(before.source.entityId, { pan: false });
				}
			}
		}
	}

	async function closeBranch(branchId: string): Promise<void> {
		const before = $branchStore.branches;
		const branch = before.find((candidate) => candidate.branchId === branchId);
		if (!branch) return;
		navigation.quiesce();
		const sourceId = branch.source.entityId;
		const result = branchStore.closeBranch(branchId);
		if (!result.closed) return;
		const closed = before.filter((candidate) => result.branchIds.includes(candidate.branchId));
		const closedArtistIds = new Set(closed.map((candidate) => candidate.artist.localId));
		const closedEntityIds = new Set(
			closed.flatMap((candidate) => candidate.albums.map((album) => album.entityId))
		);
		if (branchSearchSource?.parentBranchId && result.branchIds.includes(branchSearchSource.parentBranchId)) {
			branchSearchSource = null;
			branchSearchReturnFocusId = null;
		}
		const descriptor = get(browseStore).selectedAlbumDescriptor;
		const baseArtistLocalId = get(browseStore).selectedArtist?.localId;
		if (
			(
				(descriptor?.artistLocalId && closedArtistIds.has(descriptor.artistLocalId)) ||
				(pendingAlbumActivationId !== null && closedEntityIds.has(pendingAlbumActivationId))
			) &&
			baseArtistLocalId
		) {
			await browseStore.closeAlbumDetail(baseArtistLocalId);
		}
		const currentAuxiliary = currentTimelinePageState()?.snapshot.activeSemanticPath.find(
			(segment) => segment.kind === 'auxiliary-artist'
		);
		if (currentAuxiliary && closedArtistIds.has(currentAuxiliary.localId)) {
			navigation.replaceBaseArtist(camera);
		}
		if (focusedAlbumId && closedEntityIds.has(focusedAlbumId)) requestedFocusId = sourceId;
		await tick();
		await focusAlbum(sourceId, { pan: true });
		announce(`${branch.artist.exactName} artist branch closed.`);
	}

	async function activateAlbum(nodeId: string): Promise<boolean> {
		cancelCanvasGestures();
		const album = workspaceEntityById(nodeId);
		const enabled = album && isBranchEntity(album)
			? branchActivationEnabled
			: albumActivationEnabled;
		if (usesInjectedData || !album || !enabled) {
			announce('Album detail is unavailable until Timeline reconnects.');
			return false;
		}
		pendingAlbumActivationId = nodeId;
		let opened: boolean;
		try {
			opened = await navigation.openAlbum(
				isBranchEntity(album)
					? {
						albumLocalId: album.albumLocalId,
						detailArtistLocalId: album.artistLocalId,
						anchor: album
					}
					: album.id
			);
		} finally {
			if (pendingAlbumActivationId === nodeId) pendingAlbumActivationId = null;
		}
		announce(
			opened
				? `${album?.title ?? 'Album'} detail opened.`
				: `${album?.title ?? 'Album'} detail could not be opened.`
		);
		return opened;
	}

	function handleAlbumFocus(nodeId: string): void {
		focusGeneration += 1;
		requestedFocusId = nodeId;
		const entity = workspaceEntityById(nodeId);
		if (
			entity &&
			programmaticFocusId !== nodeId &&
			activePointerPlacement?.albumLocalId !== nodeId
		) {
			commitCamera({ ...camera, centerX: entity.x, centerY: entity.y });
		}
	}

	function moveAlbumFocus(
		nodeId: string,
		direction: 'left' | 'right' | 'up' | 'down' | 'home' | 'end'
	): void {
		const target = timelineKeyboardTarget({
			albums: model.entities,
			currentId: nodeId,
			direction,
			branchNodes: branchLayout.groups.flatMap((group) =>
				group.entities.map((entity, siblingOrder) => ({
					id: entity.id,
					x: entity.x,
					y: entity.y,
					branchId: entity.branchId,
					sourceId: entity.sourceEntityId,
					siblingOrder
				}))
			)
		});
		if (!target) return;
		const moved = target !== nodeId;
		if (!moved && (direction === 'up' || direction === 'down')) {
			announce(`No exploration branch ${direction === 'up' ? 'above' : 'below'} this album.`);
		}
		void focusAlbum(target, { pan: true, announceMove: moved });
	}

	function handleAlbumKeydown(nodeId: string, event: KeyboardEvent): void {
		if (event.altKey || event.ctrlKey || event.metaKey) return;
		if (event.shiftKey && event.key === 'F10') {
			event.preventDefault();
			openAlbumActions(nodeId);
			return;
		}
		const direction = ({
			ArrowLeft: 'left',
			ArrowRight: 'right',
			ArrowUp: 'up',
			ArrowDown: 'down',
			Home: 'home',
			End: 'end'
		} as const)[event.key as 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End'];
		if (!direction) return;
		event.preventDefault();
		focusGeneration += 1;
		requestedFocusId = nodeId;
		moveAlbumFocus(nodeId, direction);
	}

	function sameManualOffset(
		left: TimelineManualOffset | null,
		right: TimelineManualOffset | null
	): boolean {
		return left?.dx === right?.dx && left?.dy === right?.dy;
	}

	function beginPointerPlacement(
		gestureId: number,
		albumLocalId: string,
		preOffset: TimelineManualOffset | null
	): boolean {
		if (activePointerPlacement || !canonicalModel.entityById.has(albumLocalId)) return false;
		if (!reconcileCurrentWorkspace()) return false;
		const token = workspaceStore.beginPlacement(albumLocalId);
		if (!token) return false;
		if (!sameManualOffset(token.preOffset, preOffset)) {
			workspaceStore.cancelPlacement(token);
			return false;
		}
		activePointerPlacement = {
			gestureId,
			albumLocalId,
			token,
			canonicalModel,
			viewport: { ...viewport },
			scale: camera.scale
		};
		return true;
	}

	function takePointerPlacement(
		gestureId: number,
		albumLocalId: string
	): ActivePointerPlacement | null {
		const active = activePointerPlacement;
		if (
			!active ||
			active.gestureId !== gestureId ||
			active.albumLocalId !== albumLocalId
		) return null;
		activePointerPlacement = null;
		return active;
	}

	function cancelPointerPlacement(cancel: TimelineAlbumDragCancel | TimelineAlbumTap): void {
		highlightedZoneId = null;
		const active = takePointerPlacement(cancel.gestureId, cancel.albumLocalId);
		if (active) workspaceStore.cancelPlacement(active.token);
	}

	function commitPointerPlacement(commit: TimelineAlbumDragCommit): void {
		highlightedZoneId = null;
		const active = takePointerPlacement(commit.gestureId, commit.albumLocalId);
		if (!active) return;
		const canonical = active.canonicalModel.entityById.get(commit.albumLocalId);
		if (!canonical) {
			workspaceStore.cancelPlacement(active.token);
			return;
		}
		if (commit.dropTarget) {
			const canceled = workspaceStore.cancelPlacement(active.token);
			if (canceled.status !== 'cancelled') {
				announce(`${canonical.title} action target was superseded; no Roon command was sent.`);
				return;
			}
			requestedFocusId = commit.albumLocalId;
			const returnElement = currentAlbumMarker(commit.albumLocalId);
			if (commit.dropTarget.zoneId === null) {
				albumActionStartGeneration += 1;
				announce(`${canonical.title} has no current zone target; no Roon command was sent.`);
				void restoreActionMenuFocus(returnElement, commit.albumLocalId);
				return;
			}
			scheduleAlbumActionStart(
				commit.albumLocalId,
				commit.dropTarget.zoneId,
				returnElement,
				commit.albumLocalId
			);
			return;
		}
		let next: TimelineManualOffset | null;
		try {
			next = reduceTimelineManualPlacement(active.token.preOffset, {
				type: 'place',
				offset: commit.offset
			}, {
				albumLocalId: commit.albumLocalId,
				albums: active.canonicalModel.entities,
				canonicalBounds: active.canonicalModel.bounds,
				viewport: active.viewport,
				scale: active.scale
			});
		} catch {
			workspaceStore.cancelPlacement(active.token);
			announce(`${canonical.title} could not be repositioned.`);
			return;
		}
		const result = workspaceStore.commitPlacement(active.token, {
			dx: next?.dx ?? 0,
			dy: next?.dy ?? 0
		});
		if (result.status !== 'committed') {
			announce(`${canonical.title} placement was superseded.`);
			return;
		}
		requestedFocusId = commit.albumLocalId;
		void focusAlbum(commit.albumLocalId, { pan: false });
		announce(
			next === null
				? `${canonical.title} returned to its canonical timeline anchor.`
				: `${canonical.title} repositioned for this tab only.`
		);
	}

	function handlePointerAlbumTap(tap: TimelineAlbumTap): void {
		cancelPointerPlacement(tap);
		void focusAlbum(tap.albumLocalId, { pan: false }).then((focused) => {
			if (focused && albumActivationEnabled) void activateAlbum(tap.albumLocalId);
		});
	}

	function handleGestureCameraPreview(preview: TimelineCameraGesturePreview): void {
		applyCamera(preview.camera);
	}

	function handleGestureCameraCommit(commit: TimelineCameraGestureCommit): void {
		gestureControls?.cancelWheel();
		applyCamera(commit.camera);
		if (!usesInjectedData && !modalSurfaceOpen) {
			navigation.replaceCameraPageState(commit.camera);
		}
	}

	function handleGestureCameraCancel(cancel: TimelineCameraGestureCancel): void {
		applyCamera(cancel.camera);
	}

	function handleWheelIdle(idle: TimelineWheelIdle): void {
		if (
			!mounted ||
			usesInjectedData ||
			modalSurfaceOpen ||
			camera.centerX !== idle.camera.centerX ||
			camera.centerY !== idle.camera.centerY ||
			camera.scale !== idle.camera.scale
		) return;
		navigation.replaceCameraPageState(idle.camera);
	}

	function applyManualPlacement(
		localId: string,
		command: TimelineManualPlacementCommand
	): void {
		const canonical = canonicalModel.entityById.get(localId);
		if (!canonical) return;
		suppressActionMenuCloseAnnouncement = true;
		if (!reconcileCurrentWorkspace()) {
			announce(`${canonical.title} placement is unavailable until this Timeline context settles.`);
			return;
		}
		const current = workspaceStore.offsetFor(localId);
		let next: TimelineManualOffset | null;
		try {
			next = reduceTimelineManualPlacement(current, command, {
				albumLocalId: localId,
				albums: canonicalModel.entities,
				canonicalBounds: canonicalModel.bounds,
				viewport,
				scale: camera.scale
			});
		} catch {
			announce(`${canonical.title} could not be repositioned.`);
			return;
		}
		const token = workspaceStore.beginPlacement(localId);
		if (!token) {
			announce(`${canonical.title} placement was superseded.`);
			return;
		}
		const result = workspaceStore.commitPlacement(token, {
			dx: next?.dx ?? 0,
			dy: next?.dy ?? 0
		});
		if (result.status !== 'committed') {
			announce(`${canonical.title} placement was superseded.`);
			return;
		}
		if (command.type === 'return' || next === null) {
			announce(`${canonical.title} returned to its canonical timeline anchor.`);
		} else if (command.type === 'float') {
			announce(`${canonical.title} floated for this tab only.`);
		} else if (command.type === 'move') {
			announce(
				`${canonical.title} moved ${command.direction} its chronological neighbor visually; release order is unchanged.`
			);
		} else {
			announce(`${canonical.title} repositioned for this tab only.`);
		}
	}

	function openAlbumActions(nodeId: string, opener: HTMLElement | null = null): void {
		if (albumActionModalOpen) return;
		const entity = workspaceEntityById(nodeId);
		if (!entity) return;
		cancelCanvasGestures();
		focusGeneration += 1;
		requestedFocusId = nodeId;
		actionMenuReturnFocus =
			opener?.isConnected
				? opener
				: document.activeElement instanceof HTMLElement && document.activeElement.isConnected
				? document.activeElement
				: null;
		if (document.activeElement instanceof HTMLElement && frame.contains(document.activeElement)) {
			document.activeElement.blur();
		}
		const screen = worldToScreen({ x: entity.x, y: entity.y }, camera, viewport);
		actionMenu = {
			albumId: nodeId,
			left: Math.max(16, Math.min(viewport.width - 316, screen.x + 20)),
			top: Math.max(92, Math.min(viewport.height - 332, screen.y - 28))
		};
		announce(`${entity.title} actions opened.`);
	}

	async function restoreActionMenuFocus(
		returnElement: HTMLElement | null,
		fallbackId: string | null
	): Promise<void> {
		const operation = ++focusGeneration;
		await tick();
		if (operation !== focusGeneration) return;
		const topModal = topModalSurface();
		if (topModal) return;
		if (
			returnElement?.isConnected &&
			returnElement.closest('[inert]') === null &&
			!returnElement.matches(':disabled')
		) {
			returnElement.focus({ preventScroll: true });
			if (document.activeElement === returnElement) return;
		}
		if (fallbackId && await focusAlbum(fallbackId, { pan: false })) return;
		searchInput?.focus();
	}

	async function dismissAlbumActions(): Promise<void> {
		const returnId = actionMenu?.albumId ?? focusedAlbumId;
		const title = returnId ? workspaceEntityById(returnId)?.title : null;
		const returnElement = actionMenuReturnFocus;
		const preserveClassicFallback = preserveClassicFallbackOnMenuDismiss;
		preserveClassicFallbackOnMenuDismiss = false;
		actionMenu = null;
		actionMenuReturnFocus = null;
		if (!preserveClassicFallback) {
			clearClassicFallback();
		}
		classicShortcutsOpen = false;
		if (!suppressActionMenuCloseAnnouncement) {
			announce(`${title ?? 'Album'} actions closed.`);
		}
		suppressActionMenuCloseAnnouncement = false;
		await restoreActionMenuFocus(returnElement, returnId);
	}

	function openAlbumActionForZone(zoneId: string): void {
		const menu = actionMenu;
		if (!menu) return;
		const returnElement = actionMenuReturnFocus;
		const returnFocusId = menu.albumId;
		actionMenu = null;
		actionMenuReturnFocus = null;
		suppressActionMenuCloseAnnouncement = false;
		requestedFocusId = menu.albumId;
		scheduleAlbumActionStart(
			menu.albumId,
			zoneId,
			returnElement,
			returnFocusId
		);
	}

	function openActionMenuDetail(nodeId: string): void {
		const entity = workspaceEntityById(nodeId);
		const activationEnabled = entity && isBranchEntity(entity)
			? branchActivationEnabled
			: albumActivationEnabled;
		if (
			!entity ||
			!activationEnabled ||
			(selectedWorkspaceEntityId === nodeId && detailView !== null)
		) {
			announce('Album detail is unavailable from this state.');
			return;
		}
		void activateAlbum(nodeId);
	}

	function openList(): void {
		if (albumActionModalOpen || !focusedAlbumId || listAlbums.length === 0) return;
		cancelCanvasGestures();
		focusGeneration += 1;
		actionMenu = null;
		actionMenuReturnFocus = null;
		listReturnFocusId = focusedAlbumId;
		if (document.activeElement instanceof HTMLElement && frame.contains(document.activeElement)) {
			document.activeElement.blur();
		}
		listOpen = true;
		announce(`List view opened with ${listAlbums.length} releases.`);
	}

	function focusListAlbum(nodeId: string): void {
		if (!workspaceEntityById(nodeId)) return;
		focusGeneration += 1;
		requestedFocusId = nodeId;
	}

	async function closeList(): Promise<void> {
		const requested = focusedAlbumId ?? listReturnFocusId;
		const returnId = requested && workspaceEntityById(requested)
			? requested
			: selectedWorkspaceEntityId ?? listAlbums[0]?.id ?? null;
		listOpen = false;
		listReturnFocusId = null;
		if (returnId) {
			await focusAlbum(returnId, { pan: true });
			const album = workspaceEntityById(returnId);
			announce(`Returned to ${album?.title ?? 'the Timeline'}.`);
		} else {
			const operation = ++focusGeneration;
			await tick();
			if (operation === focusGeneration && topModalSurface() === null) searchInput?.focus();
			announce('List view closed.');
		}
	}

	async function chooseListAlbum(nodeId: string): Promise<void> {
		listOpen = false;
		listReturnFocusId = null;
		const focused = await focusAlbum(nodeId, { pan: true });
		if (focused) await activateAlbum(nodeId);
	}

	async function openListAlbumActions(nodeId: string): Promise<void> {
		listOpen = false;
		listReturnFocusId = null;
		const focused = await focusAlbum(nodeId, { pan: true });
		if (focused) openAlbumActions(nodeId);
	}

	function handleWindowKeydown(event: KeyboardEvent): void {
		if (!mounted || event.defaultPrevented || modalSurfaceOpen) return;
		const target = event.target;
		const topModal = topModalSurface();
		const externalModal = topModal && !frame.contains(topModal) ? topModal : null;
		if (externalModal) return;
		if (
			target instanceof HTMLElement &&
			!frame.contains(target) &&
			target.closest('[aria-modal="true"], dialog[open]')
		) return;
		if (
			event.key !== '/' ||
			event.altKey ||
			event.ctrlKey ||
			event.metaKey ||
			event.shiftKey ||
			searchInput?.disabled
		) return;
		if (
			target instanceof HTMLInputElement ||
			target instanceof HTMLTextAreaElement ||
			target instanceof HTMLSelectElement ||
			(target instanceof HTMLElement && target.isContentEditable)
		) return;
		event.preventDefault();
		cancelCanvasGestures();
		focusGeneration += 1;
		searchInput?.focus();
		announce('Artist search focused.');
	}

	function handleWindowFocusIn(event: FocusEvent): void {
		if (!mounted) return;
		const target = event.target;
		if (
			target instanceof HTMLElement &&
			frame?.contains(target) &&
			target.closest('[data-album-id], [data-timeline-node-id]')
		) return;
		focusGeneration += 1;
	}

	function attachTimelineWindowListeners(): void {
		if (windowListenersAttached || typeof window === 'undefined') return;
		window.addEventListener('keydown', handleWindowKeydown);
		window.addEventListener('focusin', handleWindowFocusIn);
		windowListenersAttached = true;
	}

	function detachTimelineWindowListeners(): void {
		if (!windowListenersAttached || typeof window === 'undefined') return;
		window.removeEventListener('keydown', handleWindowKeydown);
		window.removeEventListener('focusin', handleWindowFocusIn);
		windowListenersAttached = false;
	}

	$effect(() => {
		const pending = $pendingLibraryIntentStore;
		const outgoingTransition = $libraryViewHostStore.transition?.fromMode === 'timeline';
		if (
			!mounted ||
			lifecycleSuspended ||
			!pending ||
			outgoingTransition ||
			listOpen ||
			actionMenu !== null ||
			branchSearchSource !== null ||
			classicFallbackIntent !== null ||
			albumActionModalOpen
		) return;
		const intent = claimLibraryIntent(pending.requestId);
		if (intent) handleIncomingLibraryIntent(intent);
	});

	$effect(() => {
		const scope = branchScope;
		const socketStatus = $socketStatusStore;
		const corePublication = $coreStore;
		if (!mounted || usesInjectedData || !scope) return;
		if (socketStatus === 'connected' && corePublication.status === 'paired') {
			branchStore.resume(scope);
		} else {
			branchStore.reconcileScope(scope);
			branchStore.connectionLost();
		}
	});

	$effect(() => {
		const socketStatus = $socketStatusStore;
		const corePublication = $coreStore;
		if (!mounted || usesInjectedData) return;
		if (socketStatus !== 'connected' || corePublication.status !== 'paired') {
			if (!recoveryPending) {
				recoveryTarget = recoveryTimelineTarget();
				recoveryCorePublication = corePublication;
				recoveryPending = true;
				browseStore.connectionLost();
			}
			return;
		}
		const pairedCoreId = corePublication.core?.id ?? null;
		if (acceptedCoreId !== null && pairedCoreId !== null && pairedCoreId !== acceptedCoreId) {
			const target = recoveryTarget ?? recoveryTimelineTarget();
			const alreadyLost = recoveryPending;
			recoveryPending = false;
			recoveryTarget = null;
			recoveryCorePublication = corePublication;
			acceptedCoreId = pairedCoreId;
			if (!alreadyLost) browseStore.connectionLost();
			cancelCanvasGestures();
			void navigation.restore(target);
			return;
		}
		if (!recoveryPending || corePublication === recoveryCorePublication) return;
		const target = recoveryTarget ?? recoveryTimelineTarget();
		recoveryPending = false;
		recoveryTarget = null;
		acceptedCoreId = pairedCoreId;
		cancelCanvasGestures();
		void navigation.restore(target);
	});

	function lifecycleStep(step: () => void): void {
		try {
			step();
		} catch {
			// A mode boundary must finish quiescing even if one advisory cleanup fails.
		}
	}

	function activationTimelineTarget(
		activation: CommittedLibraryModeActivation | null
	): TimelineLibraryPageState {
		return activation?.pageState.libraryView === 'timeline'
			? activation.pageState
			: semanticTimelineTarget();
	}

	function suspendTimeline(): void {
		detachTimelineWindowListeners();
		lifecycleStep(() => gestureControls?.suspendRuntime());
		if (lifecycleSuspended) return;
		lifecycleSuspended = true;
		mounted = false;
		activeActivation = null;
		focusGeneration += 1;
		albumActionStartGeneration += 1;
		highlightedZoneId = null;
		pendingAlbumActivationId = null;
		requestedFocusId = null;
		programmaticFocusId = null;
		listOpen = false;
		listReturnFocusId = null;
		actionMenu = null;
		actionMenuReturnFocus = null;
		preserveClassicFallbackOnMenuDismiss = false;
		clearClassicFallback();
		classicShortcutsOpen = false;
		if (branchSearchSource) lifecycleStep(() => branchStore.cancelSearch());
		branchSearchSource = null;
		branchSearchReturnFocusId = null;
		lifecycleStep(cancelCanvasGestures);
		if (activePointerPlacement) {
			const orphanedPlacement = activePointerPlacement;
			activePointerPlacement = null;
			lifecycleStep(() => workspaceStore.cancelPlacement(orphanedPlacement.token));
		}
		if (frameObserver) lifecycleStep(() => frameObserver?.disconnect());
		frameObserver = null;

		const terminalActionState = albumActionController.snapshot();
		const terminalActionContext = albumActionContext;
		if (detachedAlbumExecutionPending) {
			lifecycleStep(() => albumActionSubscription?.());
			albumActionSubscription = null;
		} else if (
			terminalActionState.phase === 'executing' &&
			terminalActionContext?.selectedChoice
		) {
			lifecycleStep(() => detachClaimedAlbumExecution(terminalActionContext));
		} else {
			lifecycleStep(() => albumActionSubscription?.());
			albumActionSubscription = null;
			if (
				terminalActionContext?.selectedChoice &&
				(
					terminalActionState.phase === 'executed' ||
					terminalActionState.phase === 'failed' ||
					terminalActionState.phase === 'outcome-unknown'
				)
			) {
				lifecycleStep(() => publishAlbumActionFeedback(terminalActionState, terminalActionContext));
			}
			if (
				terminalActionState.phase === 'resolving' ||
				terminalActionState.phase === 'choosing'
			) {
				lifecycleStep(() => albumActionController.quiesce());
			}
			lifecycleStep(() => albumActionController.reset());
		}
		albumActionContext = null;
		recoveryPending = false;
		recoveryTarget = null;
		recoveryCorePublication = null;
		acceptedCoreId = null;
		if (!usesInjectedData) {
			lifecycleStep(() => navigation.quiesce());
			lifecycleStep(() => browseStore.quiesce());
			lifecycleStep(() => branchStore.quiesce());
		}
		lifecycleStep(() => workspaceStore.suspendRuntime());
	}

	function resumeTimeline(activation: CommittedLibraryModeActivation | null = null): void {
		if (!lifecycleSuspended && activeActivation === activation) {
			gestureControls?.resumeRuntime();
			attachTimelineWindowListeners();
			return;
		}
		lifecycleSuspended = false;
		mounted = true;
		activeActivation = activation;
		try {
			if (!usesInjectedData && branchScope) {
				if (get(socketStatusStore) === 'connected' && get(coreStore).status === 'paired') {
					branchStore.resume(branchScope);
				} else {
					branchStore.reconcileScope(branchScope);
					branchStore.connectionLost();
				}
			}
			if (!albumActionSubscription) {
				albumActionSubscription = albumActionController.subscribe((state) => {
					albumActionState = state;
				});
			}
			const bounds = frame.getBoundingClientRect();
			updateViewport(bounds.width, bounds.height);
			reconcileCurrentWorkspace();
			if (!frameObserver && typeof ResizeObserver !== 'undefined') {
				frameObserver = new ResizeObserver(([entry]) => {
					if (mounted && entry) updateViewport(entry.contentRect.width, entry.contentRect.height);
				});
				frameObserver.observe(frame);
			}
			if (!usesInjectedData) {
				void browseStore.loadCatalogStatus();
				const target = activationTimelineTarget(activation);
				const corePublication = get(coreStore);
				if (get(socketStatusStore) === 'connected' && corePublication.status === 'paired') {
					acceptedCoreId = corePublication.core?.id ?? null;
					void navigation.restore(target);
				} else {
					commitCamera({
						centerX: target.snapshot.camera.x,
						centerY: target.snapshot.camera.y,
						scale: target.snapshot.camera.scale
					});
					recoveryTarget = target;
					recoveryCorePublication = corePublication;
					recoveryPending = true;
					browseStore.connectionLost();
				}
			}
			gestureControls?.resumeRuntime();
			attachTimelineWindowListeners();
		} catch {
			suspendTimeline();
		}
	}

	onMount(() => {
		const unregister = activationContext?.registerLifecycle?.('timeline', {
			resume: (activation) => resumeTimeline(activation),
			suspend: suspendTimeline
		});
		if (!unregister) resumeTimeline();
		return () => {
			componentTearingDown = true;
			suspendTimeline();
			unregister?.();
			if (!detachedAlbumExecutionPending) {
				lifecycleStep(() => albumActionController.dispose());
			}
		};
	});
</script>

<section
	bind:this={frame}
	class="timeline-library-mode"
	data-testid="library-mode-target"
	data-library-mode="timeline"
	data-semantic-tier={tier}
	aria-label="Timeline library canvas"
>
	<div
		class="timeline-spatial-underlay"
		data-testid="timeline-spatial-underlay"
		aria-hidden={modalSurfaceOpen ? 'true' : undefined}
		use:inertSubtree={modalSurfaceOpen}
	>
		<CanvasViewport
			{model}
			{branchLayout}
			{camera}
			{viewport}
			previousTier={tier}
			activeAlbumId={focusedAlbumId}
			{detailView}
			{detailAnchor}
			spatialInert={modalSurfaceOpen}
			{albumActivationEnabled}
			{branchActivationEnabled}
			{branchRetryEnabled}
			onAlbumActivate={(localId) => void activateAlbum(localId)}
			onAlbumFocus={handleAlbumFocus}
			onAlbumKeydown={handleAlbumKeydown}
			onAlbumActions={openAlbumActions}
			onBranchActivate={(nodeId) => void activateAlbum(nodeId)}
			onBranchFocus={handleAlbumFocus}
			onBranchKeydown={handleAlbumKeydown}
			onBranchActions={openAlbumActions}
			onBranchRetry={(branchId) => void retryBranch(branchId)}
			onBranchClose={(branchId) => void closeBranch(branchId)}
			onOpenTrackInClassic={offerTrackInClassic}
			onAlbumGestureStart={beginPointerPlacement}
			onAlbumDragPreview={handleAlbumDragPreview}
			{resolveAlbumDropTarget}
			onAlbumDragCommit={commitPointerPlacement}
			onAlbumDragCancel={cancelPointerPlacement}
			onAlbumTap={handlePointerAlbumTap}
			onCameraPreview={handleGestureCameraPreview}
			onCameraCommit={handleGestureCameraCommit}
			onCameraCancel={handleGestureCameraCancel}
			onWheelIdle={handleWheelIdle}
			onGestureControls={(controls) => {
				gestureControls = controls;
				if (controls) {
					if (lifecycleSuspended) controls.suspendRuntime();
					else controls.resumeRuntime();
				}
			}}
		/>

		<TimelineZoneDock
			zones={timelineZoneViews}
			{highlightedZoneId}
			activeZoneId={albumActionContext?.zoneId ?? null}
			onControls={(controls) => {
				zoneDockControls = controls;
			}}
		/>

		<div class="timeline-chrome">
			<div class="path-status" aria-label="Timeline path">
				<span>Library / Timeline</span>
				<strong>{artistName ?? 'Discography order'}</strong>
			</div>

		<div
			class="artist-picker"
			class:artist-picker--landing={artistPickerLanding}
			role={artistPickerLanding ? 'region' : undefined}
			aria-labelledby={artistPickerLanding ? 'timeline-artist-picker-title' : undefined}
			data-artist-picker-state={artistPickerLanding ? 'landing' : 'compact'}
		>
			{#if artistPickerLanding}
				<header class="artist-picker-intro">
					<div class="artist-origin-line">
						<span><i aria-hidden="true"></i>Artist origin</span>
						{#if indexedArtistCount !== null}
							<span>{indexedArtistCount.toLocaleString()} artists indexed</span>
						{/if}
					</div>
					<h1 id="timeline-artist-picker-title">Start with an artist</h1>
					<p id="timeline-artist-picker-description">
						Search your Roon library, then choose an artist to map their releases in chronological order.
					</p>
					{#if $socketStatusStore !== 'connected'}
						<p class="artist-picker-connection" role="status">Timeline connection unavailable</p>
					{:else if $coreStore.status !== 'paired'}
						<p class="artist-picker-connection" role="status">Waiting for Roon Core</p>
					{/if}
				</header>
			{/if}

			<form
				class="artist-lens"
				role="search"
				aria-label={artistPickerLanding ? undefined : 'Artist search'}
				aria-describedby={artistPickerLanding ? 'timeline-artist-picker-description' : undefined}
				onsubmit={submitSearch}
			>
				<span class="lens-mark" aria-hidden="true"></span>
				<label>
					<span>Artist name</span>
					<input
						bind:this={searchInput}
						type="search"
						bind:value={query}
						placeholder="Search artists"
						maxlength={CATALOG_ARTIST_QUERY_MAX_LENGTH}
						autocomplete="off"
						aria-controls={showArtistResults ? 'timeline-artist-results' : undefined}
						onkeydown={handleArtistSearchKeydown}
						disabled={!searchEnabled || (!usesInjectedData && $browseStore.refreshPhase === 'running')}
					/>
				</label>
				<span class="artist-search-shortcut" aria-hidden="true"><kbd>/</kbd></span>
				<button
					type="submit"
					disabled={!searchEnabled || query.trim().length === 0 || (!usesInjectedData && $browseStore.searchPhase === 'loading')}
				>Search</button>
			</form>

			{#if showArtistResults}
				<div
					id="timeline-artist-results"
					class="artist-results"
					role="region"
					aria-label="Artist search results"
				>
					{#if $browseStore.statusPhase === 'loading' && !$browseStore.catalogStatus}
						<p role="status">Loading catalog status…</p>
					{:else if $browseStore.statusPhase === 'error' && !$browseStore.catalogStatus}
						<p role="alert">{$browseStore.statusError ?? 'Catalog status could not be loaded.'}</p>
						<button type="button" onclick={() => void browseStore.loadCatalogStatus()}>Retry catalog status</button>
					{:else if $browseStore.searchPhase === 'loading'}
						<p role="status">Searching artists…</p>
					{:else if $browseStore.searchPhase === 'error'}
						<p role="alert">{$browseStore.searchError ?? 'Artist search failed.'}</p>
					{:else if $browseStore.catalogStatus && !$browseStore.catalogStatus.available}
						<p>The artist catalog is not ready yet.</p>
						<button
							type="button"
							disabled={$browseStore.refreshPhase === 'running'}
							onclick={() => void browseStore.refreshCatalog()}
						>{$browseStore.refreshPhase === 'running' ? 'Scanning library…' : 'Scan library'}</button>
					{:else if visibleArtistCandidates.length > 0}
						<div class="artist-results-summary" role="status">
							<strong>{visibleArtistCandidates.length} {visibleArtistCandidates.length === 1 ? 'match' : 'matches'} shown</strong>
							<span><kbd>↓</kbd> then <kbd>Enter</kbd>, or choose an artist</span>
						</div>
						<ul bind:this={artistResultList} aria-label="Artist matches">
							{#each visibleArtistCandidates as candidate (candidate.localId)}
								<li>
									<button
										type="button"
										data-resolution-status={candidate.resolutionStatus}
										disabled={$browseStore.selectionPhase === 'loading' || $browseStore.catalogStatus?.persistence === 'degraded'}
										onkeydown={handleArtistResultKeydown}
										onclick={() => selectCandidate(candidate.localId)}
									>
										<strong>{candidate.exactName}</strong>
										<span>Open timeline <i aria-hidden="true">›</i></span>
									</button>
								</li>
							{/each}
						</ul>
					{:else if $browseStore.searchPhase === 'ready'}
						<p>No matching artists.</p>
					{/if}
					{#if $browseStore.catalogStatus?.persistence === 'degraded'}
						<p role="alert">Catalog storage is degraded; artist loading is unavailable.</p>
					{:else if $browseStore.catalogStatus?.freshness === 'stale' && $browseStore.catalogStatus.available}
						<button
							type="button"
							disabled={$browseStore.refreshPhase === 'running' || $browseStore.selectionPhase === 'loading'}
							onclick={() => void browseStore.refreshCatalog()}
						>{$browseStore.refreshPhase === 'running' ? 'Refreshing…' : 'Refresh catalog'}</button>
					{/if}
					{#if $browseStore.refreshPhase === 'error'}
						<p role="alert">{$browseStore.refreshError ?? 'Catalog refresh failed.'}</p>
					{/if}
					{#if $browseStore.statusPhase === 'error' && $browseStore.catalogStatus}
						<p role="alert">{$browseStore.statusError ?? 'Catalog status could not be refreshed.'}</p>
						<button type="button" onclick={() => void browseStore.loadCatalogStatus()}>Retry catalog status</button>
					{/if}
					{#if $browseStore.selectionPhase === 'loading'}
						<p role="status">Loading discography…</p>
					{:else if $browseStore.selectionPhase === 'error'}
						<p role="alert">{$browseStore.selectionError ?? 'Discography loading failed.'}</p>
					{/if}
					{#if query.trim().length > 0}
						<button
							type="button"
							class="search-everything-classic"
							onclick={(event) => offerSearchEverythingInClassic(event.currentTarget)}
						>Search everything in Classic</button>
					{/if}
				</div>
			{/if}
		</div>

		{#if !artistPickerLanding}
			<div class="canvas-status">
				<span>{listAlbums.length} {listAlbums.length === 1 ? 'release' : 'releases'}</span>
				{#if branchLayout.groups.length > 0}
					<span>{branchLayout.groups.length} {branchLayout.groups.length === 1 ? 'artist branch' : 'artist branches'}</span>
				{/if}
				<span>{tier} view</span>
				{#if !usesInjectedData && $socketStatusStore !== 'connected'}
					<span>Timeline connection unavailable</span>
				{:else if !usesInjectedData && $coreStore.status !== 'paired'}
					<span>Waiting for Roon Core</span>
				{:else if !usesInjectedData && $browseStore.sessionPhase === 'reconnecting'}
					<span>Reconnecting Timeline…</span>
				{:else if !usesInjectedData && $browseStore.sessionPhase === 'stale'}
					<span>Timeline needs re-resolution</span>
				{/if}
			</div>
		{/if}

		<div class="zoom-controls" aria-label="Timeline zoom controls">
			<button type="button" aria-label="Zoom out" onclick={() => zoomBy(0.82)}>−</button>
			<output aria-label="Current zoom">{Math.round(camera.scale * 100)}%</output>
			<button type="button" aria-label="Zoom in" onclick={() => zoomBy(1.22)}>+</button>
			<button type="button" onclick={fit}>Fit</button>
			<button type="button" onclick={recenter}>Recenter</button>
		</div>

			<div class="keyboard-controls" aria-label="Timeline keyboard controls">
				<span><kbd>←</kbd><kbd>→</kbd> albums · <kbd>Enter</kbd> detail · <kbd>Shift+F10</kbd> actions</span>
				<button
					type="button"
					disabled={!focusedAlbum}
					aria-haspopup="menu"
					aria-expanded={actionMenu !== null}
					onclick={(event) =>
						focusedAlbumId && openAlbumActions(focusedAlbumId, event.currentTarget)}
				>Album actions</button>
				<button type="button" disabled={listAlbums.length === 0} onclick={openList}
					>Browse as list</button
				>
				<details class="classic-shortcuts" bind:open={classicShortcutsOpen}>
					<summary>Classic Library</summary>
					<div aria-label="Classic Library shortcuts">
						<p>Features that remain in Classic</p>
						{#if artistName}
							<button
								type="button"
								onclick={(event) => offerCurrentArtistInClassic(event.currentTarget)}
							>Open current artist in Classic</button>
						{/if}
						<button
							type="button"
							onclick={(event) => offerWelcomeInClassic('favorites', event.currentTarget)}
						>Open Favorites in Classic</button>
						<button
							type="button"
							onclick={(event) => offerWelcomeInClassic('recently-played', event.currentTarget)}
						>Open Recently Played in Classic</button>
					</div>
				</details>
			</div>
		</div>

		{#if albums.length === 0 && !artistPickerLanding}
			<div class="timeline-empty">
				<span class="empty-orbit" aria-hidden="true"></span>
				<strong>{artistName ? `No releases are available for ${artistName}.` : 'No Timeline releases are available.'}</strong>
				<p>Search for another artist to start a different discography timeline.</p>
			</div>
		{/if}
	</div>

	<div class="timeline-announcer" aria-live="polite" aria-atomic="true">
		{#key announcement.sequence}{announcement.text}{/key}
	</div>

	{#if listOpen}
		<TimelineBrowseList
			albums={listAlbums}
			currentId={focusedAlbumId}
			selectedId={selectedWorkspaceEntityId}
			onFocus={focusListAlbum}
			onChoose={(localId) => void chooseListAlbum(localId)}
			onActions={(localId) => void openListAlbumActions(localId)}
			onClose={() => void closeList()}
			onPageChange={(pageNumber, pageCount) =>
				announce(`List page ${pageNumber + 1} of ${pageCount}.`)}
		/>
	{/if}

	{#if branchSearchSource}
		{@const branchSearchSourceEntity = workspaceEntityById(branchSearchSource.entityId)}
		{#if branchSearchSourceEntity}
			<TimelineBranchSearch
				sourceTitle={branchSearchSourceEntity.title}
				phase={$branchStore.search.phase}
				candidates={$branchStore.search.candidates.map((candidate) => ({
					artistLocalId: candidate.localId,
					name: candidate.exactName,
					subtitle: candidate.resolutionStatus
				}))}
				errorMessage={$branchStore.search.error}
				initialQuery={$branchStore.search.query}
				onSearch={searchBranchArtists}
				onChoose={(candidate) => void chooseBranchArtist(candidate)}
				onCancel={cancelBranchSearch}
			/>
		{/if}
	{/if}

	{#if classicFallbackIntent}
		<TimelineOpenInClassicDialog
			title={classicFallbackTitle(classicFallbackIntent)}
			description={classicFallbackDescription(classicFallbackIntent)}
			busy={classicFallbackActivationPending}
			onConfirm={confirmClassicFallback}
			onCancel={() => void cancelClassicFallback()}
		/>
	{/if}

	{#if actionMenu}
		{@const actionAlbum = workspaceEntityById(actionMenu.albumId)}
		{#if actionAlbum}
			{@const actionAlbumIsBranch = isBranchEntity(actionAlbum)}
			{@const actionAlbumIndex = orderedAlbums.findIndex((album) => album.id === actionAlbum.id)}
			{@const actionAlbumDetailIsOpen =
				selectedWorkspaceEntityId === actionAlbum.id && detailView !== null}
			{@const actionAlbumCanOpen =
				(actionAlbumIsBranch ? branchActivationEnabled : albumActivationEnabled) &&
				!actionAlbumDetailIsOpen}
			{@const actionAlbumFloating =
				!actionAlbumIsBranch &&
				(actionAlbum.x !== actionAlbum.anchorX || actionAlbum.y !== actionAlbum.anchorY)}
			{@const actionAlbumCanResolve =
				albumActionBaseReady && workspaceAlbumIsResolved($browseStore, actionAlbum)}
			<TimelineAlbumActionsMenu
				title={actionAlbum.title}
				left={actionMenu.left}
				top={actionMenu.top}
				canOpen={actionAlbumCanOpen}
				openHint={actionAlbumCanOpen ? 'Enter' : actionAlbumDetailIsOpen ? 'Already open' : 'Unavailable'}
				floating={actionAlbumFloating}
				showWorkspaceControls={!actionAlbumIsBranch}
				canMoveBefore={!actionAlbumIsBranch && actionAlbumIndex > 0}
				canMoveAfter={!actionAlbumIsBranch && actionAlbumIndex >= 0 && actionAlbumIndex + 1 < orderedAlbums.length}
				canAttachArtistBranch={branchCanAttachToNode(actionAlbum.id)}
				zones={timelineZoneViews.map((zone) => ({
					...zone,
					enabled: zone.enabled && actionAlbumCanResolve
				}))}
				onOpen={() => openActionMenuDetail(actionAlbum.id)}
				onOpenInClassic={() => offerAlbumInClassic(actionAlbum)}
				onAttachArtistBranch={() => openBranchSearch(actionAlbum.id)}
				onFloat={() => applyManualPlacement(actionAlbum.id, { type: 'float' })}
				onReturn={() => applyManualPlacement(actionAlbum.id, { type: 'return' })}
				onMoveBefore={() =>
					applyManualPlacement(actionAlbum.id, { type: 'move', direction: 'before' })}
				onMoveAfter={() =>
					applyManualPlacement(actionAlbum.id, { type: 'move', direction: 'after' })}
				onSendToZone={openAlbumActionForZone}
				onDismiss={() => void dismissAlbumActions()}
			/>
		{/if}
	{/if}

	{#if albumActionModalOpen && albumActionContext}
		<TimelineAlbumActionChooser
			albumTitle={albumActionContext.albumTitle}
			zoneName={albumActionContext.zoneName}
			phase={albumActionChooserPhase ?? 'error'}
			actions={albumActionState.phase === 'choosing' ? albumActionState.actions : []}
			message={albumActionState.error}
			executingLabel={albumActionContext.selectedChoice?.label ?? null}
			onExecute={executeAlbumAction}
			onCancel={() => cancelAlbumAction()}
			onDismiss={dismissAlbumActionResult}
		/>
	{/if}
</section>

<style>
	.timeline-library-mode {
		position: relative;
		isolation: isolate;
		width: 100%;
		height: 100%;
		min-width: 0;
		min-height: 0;
		overflow: hidden;
		background:
			radial-gradient(circle at 50% 45%, color-mix(in srgb, var(--accent) 8%, transparent), transparent 36%),
			linear-gradient(165deg, color-mix(in srgb, var(--bg) 96%, #090b10), color-mix(in srgb, var(--bg-soft) 90%, #10131a));
		color: var(--text);
		font-family: var(--font-ui);
	}

	.timeline-spatial-underlay {
		position: absolute;
		inset: 0;
	}

	.timeline-chrome {
		position: absolute;
		inset: 0;
		z-index: 3;
		pointer-events: none;
	}

	.path-status,
	.artist-picker,
	.canvas-status,
	.zoom-controls,
	.keyboard-controls {
		position: absolute;
		pointer-events: auto;
	}

	.path-status {
		top: 18px;
		left: 20px;
		display: grid;
		max-width: min(300px, 23vw);
		gap: 3px;
	}

	.path-status span,
	.canvas-status {
		color: var(--text-soft);
		font-size: 11px;
		letter-spacing: 0.04em;
	}

	.path-status strong {
		overflow: hidden;
		font-size: 15px;
		font-weight: 650;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.artist-picker {
		top: 16px;
		left: 50%;
		display: grid;
		width: min(680px, calc(100vw - 520px));
		min-width: 320px;
		translate: -50% 0;
		gap: 8px;
	}

	.artist-picker--landing {
		top: clamp(96px, 16vh, 150px);
		bottom: 166px;
		display: flex;
		flex-direction: column;
		width: min(720px, calc(100vw - 72px));
		gap: 18px;
		pointer-events: none;
	}

	.artist-picker-intro {
		display: grid;
		gap: 8px;
		padding: 0 4px;
	}

	.artist-origin-line {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 20px;
		color: var(--text-soft);
		font-family: var(--font-mono);
		font-size: 10px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	.artist-origin-line span {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}

	.artist-origin-line i {
		display: block;
		width: 9px;
		height: 9px;
		border: 2px solid color-mix(in srgb, var(--accent-2) 72%, var(--surface));
		border-radius: 50%;
		background: var(--accent-2);
		box-shadow: 0 0 0 5px color-mix(in srgb, var(--accent-2) 13%, transparent);
	}

	.artist-picker-intro h1 {
		font-size: clamp(25px, 2.5vw, 31px);
		font-weight: 620;
		letter-spacing: -0.025em;
		line-height: 1.08;
	}

	.artist-picker-intro p {
		max-width: 610px;
		color: var(--text-soft);
		font-size: 15px;
		line-height: 1.5;
	}

	.artist-picker-intro .artist-picker-connection {
		margin: 2px 0 0;
		padding: 5px 0 5px 10px;
		border-left: 2px solid var(--accent-2);
		font-size: 12px;
		line-height: 1.35;
	}

	.artist-lens {
		display: grid;
		grid-template-columns: 20px minmax(0, 1fr) auto auto;
		align-items: center;
		width: 100%;
		min-height: 52px;
		border: 1px solid color-mix(in srgb, var(--border) 88%, transparent);
		border-radius: 14px;
		background: color-mix(in srgb, var(--surface) 94%, transparent);
		box-shadow: 0 8px 24px rgb(0 0 0 / 0.18);
	}

	.artist-picker--landing .artist-lens {
		min-height: 62px;
		border-color: color-mix(in srgb, var(--accent-2) 46%, var(--border));
		border-radius: 17px;
		background: var(--surface);
		box-shadow: var(--shadow-strong);
		pointer-events: auto;
	}

	.lens-mark {
		width: 10px;
		height: 10px;
		margin-left: 13px;
		border: 1.5px solid var(--text-soft);
		border-radius: 50%;
	}

	.lens-mark::after {
		content: '';
		display: block;
		width: 5px;
		height: 1.5px;
		translate: 8px 9px;
		rotate: 45deg;
		background: var(--text-soft);
	}

	.artist-lens label {
		display: grid;
		min-width: 0;
		padding: 5px 12px 5px 9px;
	}

	.artist-lens label span {
		color: var(--text-soft);
		font-size: 10px;
		line-height: 1;
	}

	.artist-lens input {
		min-width: 0;
		border: 0;
		outline: 0;
		background: transparent;
		color: var(--text);
		font: inherit;
		font-size: 15px;
	}

	.artist-picker--landing .artist-lens input {
		font-size: 17px;
	}

	.artist-lens input:disabled {
		opacity: 0.72;
	}

	.artist-lens button,
	.zoom-controls button {
		border: 0;
		background: transparent;
		color: var(--text);
		font: inherit;
		cursor: pointer;
	}

	.artist-lens button {
		align-self: stretch;
		padding: 0 15px;
		border-left: 1px solid var(--border);
		font-size: 12px;
	}

	.artist-picker--landing .artist-lens button {
		padding: 0 20px;
		font-size: 13px;
		font-weight: 650;
	}

	.artist-search-shortcut {
		display: none;
		padding-right: 12px;
		color: var(--text-soft);
		font-size: 11px;
	}

	.artist-picker--landing .artist-search-shortcut {
		display: grid;
		place-items: center;
	}

	.artist-search-shortcut kbd,
	.artist-results-summary kbd {
		font-family: var(--font-mono);
		font-size: 10px;
	}

	.artist-lens button:disabled {
		opacity: 0.35;
		cursor: default;
	}

	.artist-results {
		display: grid;
		width: min(620px, 100%);
		max-height: min(440px, calc(100vh - 180px));
		justify-self: center;
		overflow: auto;
		gap: 8px;
		padding: 10px;
		border: 1px solid var(--border);
		border-radius: 12px;
		background: color-mix(in srgb, var(--surface) 97%, transparent);
		box-shadow: 0 14px 34px rgb(0 0 0 / 0.26);
	}

	.artist-picker--landing .artist-results {
		flex: 0 1 auto;
		width: 100%;
		min-height: 0;
		max-height: 430px;
		padding: 6px 0 8px;
		border-radius: 16px;
		background: var(--surface);
		box-shadow: var(--shadow-strong);
		pointer-events: auto;
	}

	.artist-results-summary {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 16px;
		padding: 7px 10px 8px;
		color: var(--text-soft);
		font-size: 11px;
	}

	.artist-picker--landing .artist-results-summary {
		padding: 9px 16px 11px;
		font-size: 12px;
	}

	.artist-results-summary strong {
		color: var(--text);
		font-weight: 650;
	}

	.artist-results p {
		margin: 3px 6px;
		color: var(--text-soft);
		font-size: 12px;
		line-height: 1.4;
	}

	.artist-results ul {
		display: grid;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.artist-picker--landing .artist-results ul {
		border-top: 1px solid var(--border);
		border-bottom: 1px solid var(--border);
	}

	.artist-picker--landing .artist-results li + li {
		border-top: 1px solid var(--border);
	}

	.artist-results button {
		border: 1px solid transparent;
		border-radius: 9px;
		background: transparent;
		color: var(--text);
		font: inherit;
		cursor: pointer;
	}

	.artist-results > button {
		justify-self: start;
		padding: 7px 10px;
		border-color: var(--border);
	}

	.artist-results > .search-everything-classic {
		border-color: color-mix(in srgb, var(--accent-2) 55%, var(--border));
		color: var(--accent-2);
	}

	.artist-results li button {
		display: flex;
		width: 100%;
		align-items: baseline;
		justify-content: space-between;
		gap: 16px;
		padding: 9px 10px;
		text-align: left;
	}

	.artist-picker--landing .artist-results li button {
		min-height: 54px;
		padding: 12px 16px;
		border-radius: 0;
		font-size: 16px;
	}

	.artist-results li button:hover,
	.artist-results button:focus-visible {
		outline: 0;
		border-color: var(--accent-2);
		background: var(--surface-2);
	}

	.artist-picker--landing .artist-results li button:focus-visible {
		box-shadow: inset 3px 0 0 var(--accent-2);
	}

	.artist-results button:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.artist-results li span {
		color: var(--text-soft);
		font-size: 10px;
	}

	.artist-results li span i {
		font-style: normal;
	}

	.artist-picker--landing .artist-results li span {
		font-size: 12px;
	}

	.canvas-status {
		top: 82px;
		left: 50%;
		display: flex;
		gap: 12px;
		translate: -50% 0;
	}

	.canvas-status span + span::before {
		content: '·';
		margin-right: 12px;
	}

	.zoom-controls {
		bottom: 88px;
		left: 20px;
		display: flex;
		align-items: center;
		overflow: hidden;
		border: 1px solid var(--border);
		border-radius: 12px;
		background: color-mix(in srgb, var(--surface) 94%, transparent);
	}

	.zoom-controls button,
	.zoom-controls output {
		display: grid;
		min-width: 38px;
		height: 38px;
		place-items: center;
		padding: 0 10px;
		border-right: 1px solid var(--border);
		font-size: 12px;
	}

	.zoom-controls button:last-child {
		border-right: 0;
	}

	.zoom-controls button:hover {
		background: var(--surface-2);
	}

	.zoom-controls button:focus-visible,
	.keyboard-controls button:focus-visible,
	.artist-lens input:focus-visible,
	.artist-lens button:focus-visible {
		outline: 2px solid var(--accent-2);
		outline-offset: -2px;
	}

	.keyboard-controls {
		right: 20px;
		bottom: 88px;
		display: grid;
		grid-template-columns: auto auto;
		align-items: center;
		gap: 7px;
		padding: 8px;
		border: 1px solid var(--border);
		border-radius: 12px;
		background: color-mix(in srgb, var(--surface) 94%, transparent);
	}

	.keyboard-controls > span {
		grid-column: 1 / -1;
		color: var(--text-soft);
		font-size: 9px;
	}

	.keyboard-controls kbd {
		font: inherit;
	}

	.keyboard-controls button {
		padding: 7px 9px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--surface-2);
		color: var(--text);
		font: inherit;
		font-size: 10px;
		cursor: pointer;
	}

	.keyboard-controls button:disabled {
		opacity: 0.4;
		cursor: default;
	}

	.classic-shortcuts {
		position: relative;
		font-size: 10px;
	}

	.classic-shortcuts summary {
		padding: 7px 9px;
		border: 1px solid color-mix(in srgb, var(--accent-2) 46%, var(--border));
		border-radius: 8px;
		background: var(--surface-2);
		color: var(--text);
		cursor: pointer;
		list-style: none;
	}

	.classic-shortcuts summary::-webkit-details-marker {
		display: none;
	}

	.classic-shortcuts summary:focus-visible {
		outline: 2px solid var(--accent-2);
		outline-offset: 2px;
	}

	.classic-shortcuts > div {
		position: absolute;
		right: 0;
		bottom: calc(100% + 8px);
		display: grid;
		width: 230px;
		gap: 6px;
		padding: 9px;
		border: 1px solid var(--border);
		border-radius: 11px;
		background: var(--surface);
		box-shadow: 0 14px 34px rgb(0 0 0 / 0.28);
	}

	.classic-shortcuts p {
		margin: 0 2px 2px;
		color: var(--text-soft);
		font-size: 9px;
	}

	.classic-shortcuts button {
		text-align: left;
	}

	.timeline-announcer {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}

	.timeline-empty {
		position: absolute;
		top: 50%;
		left: 50%;
		z-index: 2;
		display: grid;
		width: min(430px, calc(100% - 48px));
		translate: -50% -50%;
		justify-items: center;
		gap: 9px;
		color: var(--text-soft);
		text-align: center;
		pointer-events: none;
	}

	.empty-orbit {
		width: 52px;
		height: 52px;
		margin-bottom: 7px;
		border: 1px solid color-mix(in srgb, var(--accent-2) 58%, transparent);
		border-radius: 50%;
	}

	.empty-orbit::after {
		content: '';
		display: block;
		width: 8px;
		height: 8px;
		translate: 37px 4px;
		border-radius: 50%;
		background: var(--accent-2);
	}

	.timeline-empty strong {
		color: var(--text);
		font-size: 18px;
	}

	.timeline-empty p {
		margin: 0;
		font-size: 13px;
		line-height: 1.45;
	}

	@media (max-width: 900px) {
		.path-status {
			display: none;
		}

		.artist-picker {
			width: calc(100vw - 40px);
			min-width: 0;
		}

		.artist-picker--landing {
			bottom: 150px;
		}

		.artist-results {
			width: 100%;
		}

		.keyboard-controls > span {
			display: none;
		}
	}

	@media (max-width: 600px) {
		.artist-picker--landing {
			top: 72px;
			gap: 13px;
		}

		.artist-origin-line {
			align-items: flex-start;
			flex-direction: column;
			gap: 5px;
		}

		.artist-picker-intro {
			gap: 6px;
		}

		.artist-picker-intro p {
			font-size: 13px;
		}

		.artist-picker--landing .artist-lens {
			grid-template-columns: 20px minmax(0, 1fr) auto;
		}

		.artist-picker--landing .artist-search-shortcut {
			display: none;
		}

		.artist-picker--landing .artist-lens button {
			grid-column: 1 / -1;
			min-height: 44px;
			border-top: 1px solid var(--border);
			border-left: 0;
		}

		.artist-results-summary {
			align-items: flex-start;
			flex-direction: column;
			gap: 3px;
		}
	}

	@media (max-height: 650px) {
		.artist-picker--landing {
			top: 68px;
			gap: 10px;
		}
	}
</style>
