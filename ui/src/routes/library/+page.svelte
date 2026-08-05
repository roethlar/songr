<script lang="ts">
	import { onMount, setContext } from 'svelte';
	import { get } from 'svelte/store';
	import { afterNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import {
		buildClassicRootPageState,
		normalizeLibraryPageStateEnvelope,
		normalizeLibraryViewRequestPageStateEnvelope,
		pageStateForLibraryView,
		type LibraryPageState,
		type LibraryViewRequestPageState,
		type LibraryViewActivationCause
	} from '$lib/libraryPageState';
	import type { LibraryIntent } from '$lib/libraryIntent';
	import {
		clearPendingLibraryPageStateWrite,
		consumeSelfAuthoredLibraryPageState,
		pushLibraryPageState,
		replaceLibraryPageState
	} from '$lib/libraryPageNavigation';
	import {
		LIBRARY_MODE_ACTIVATION_CONTEXT,
		type ClassicTruncationHistoryPolicy,
		type CommittedLibraryModeActivation,
		type LibraryModeLifecycle
	} from '$lib/libraryModeActivationContext';
	import {
		getTimelineSessionPageState,
		persistTimelineSessionPageState,
		readTimelineSessionPageState
	} from '$lib/timelinePageSessionState';
	import {
		getClassicHistorySnapshot,
		replaceHistory
	} from '$lib/stores/browseHistoryStore';
	import {
		commitPreferredLibraryView,
		libraryViewStore,
		type LibraryView
	} from '$lib/stores/libraryViewStore';
	import {
		claimLibraryViewHost,
		type LibraryViewHostActivationOutcome
	} from '$lib/stores/libraryViewHostStore';
	import {
		cancelLibraryIntent,
		publishLibraryIntent
	} from '$lib/stores/libraryIntentStore';
	import { createProductionLibraryViewLoaderController } from './libraryViewLoaders';

	const controller = createProductionLibraryViewLoaderController();
	let ActiveComponent = $derived($controller.activeTarget);
	let renderGeneration = $state(0);
	let mounted = $state(false);
	let initialActivationStarted = false;
	let observedPageState: App.PageState = page.state;
	let retryRequest: ActivationRequest | null = null;
	let latestNavigationType: string | null = null;
	let activationCommitInProgress = false;
	let committedActivation: CommittedLibraryModeActivation | null = null;
	type RegisteredLibraryModeLifecycle = {
		readonly token: number;
		readonly mode: LibraryView;
		readonly lifecycle: LibraryModeLifecycle;
		suspended: boolean;
		activation: CommittedLibraryModeActivation | null;
	};
	let lifecycleToken = 0;
	let registeredLifecycle: RegisteredLibraryModeLifecycle | null = null;
	let errorShell = $state<HTMLElement | null>(null);
	let classicTruncationHistoryPolicy = $state<ClassicTruncationHistoryPolicy>('replace');
	let hostedPendingIntentId: number | null = null;

	function suspendLifecycle(
		registration: RegisteredLibraryModeLifecycle | null = registeredLifecycle
	): RegisteredLibraryModeLifecycle | null {
		if (!registration || registration.suspended) return registration;
		registration.suspended = true;
		registration.lifecycle.suspend();
		return registration;
	}

	function resumeLifecycle(
		registration: RegisteredLibraryModeLifecycle,
		activation: CommittedLibraryModeActivation
	): void {
		if (registration.mode !== activation.pageState.libraryView) return;
		if (!registration.suspended && registration.activation === activation) return;
		registration.suspended = false;
		registration.activation = activation;
		try {
			registration.lifecycle.resume(activation);
		} catch (reason) {
			registration.suspended = true;
			throw reason;
		}
	}

	function registerLifecycle(mode: LibraryView, lifecycle: LibraryModeLifecycle): () => void {
		const registration: RegisteredLibraryModeLifecycle = {
			token: ++lifecycleToken,
			mode,
			lifecycle,
			suspended: true,
			activation: null
		};
		registeredLifecycle = registration;
		const activation = committedActivation;
		if (activation && controller.getState().activeMode === mode) {
			resumeLifecycle(registration, activation);
		}

		let unregistered = false;
		return () => {
			if (unregistered) return;
			unregistered = true;
			try {
				suspendLifecycle(registration);
			} finally {
				if (registeredLifecycle?.token === registration.token) registeredLifecycle = null;
			}
		};
	}

	setContext(LIBRARY_MODE_ACTIVATION_CONTEXT, {
		classicTruncationHistoryPolicy: () => classicTruncationHistoryPolicy,
		committedActivation: () => committedActivation,
		registerLifecycle
	});

	interface ActivationRequest {
		preferredMode: LibraryView;
		cause: LibraryViewActivationCause;
		pageState: LibraryPageState | LibraryViewRequestPageState | null;
		tagUntaggedInitial?: boolean;
		classicIntent?: LibraryIntent;
	}

	function cancelHostedPendingIntent(requestId = hostedPendingIntentId): void {
		if (requestId === null) return;
		cancelLibraryIntent(requestId);
		if (hostedPendingIntentId === requestId) hostedPendingIntentId = null;
	}

	function rollbackPreference(previous: LibraryView): void {
		if (get(libraryViewStore) === previous) return;
		if (!commitPreferredLibraryView(previous)) {
			throw new Error('Library preference rollback failed');
		}
	}

	function stateForCommit(
		mode: LibraryView,
		requestedPageState: LibraryPageState | LibraryViewRequestPageState | null
	): LibraryPageState {
		if (
			requestedPageState?.libraryView === mode &&
			'snapshot' in requestedPageState
		) return requestedPageState;
		if (mode === 'timeline') return getTimelineSessionPageState() ?? pageStateForLibraryView(mode);
		return pageStateForLibraryView(mode, getClassicHistorySnapshot());
	}

	async function activate(
		request: ActivationRequest
	): Promise<'activated' | 'failed' | 'superseded'> {
		if (!request.classicIntent) cancelHostedPendingIntent();
		retryRequest = request;
		const activeModeBefore = controller.getState().activeMode;
		const previousPreference = get(libraryViewStore);
		const previousClassicSnapshot = getClassicHistorySnapshot();
		const previousCommittedActivation = committedActivation;
		const previousClassicTruncationHistoryPolicy = classicTruncationHistoryPolicy;
		let preferenceChanged = false;
		let classicSnapshotChanged = false;
		let suspendedOutgoing: RegisteredLibraryModeLifecycle | null = null;
		let publishedIntentRequestId: number | null = null;

		const result = await controller.activate(request.preferredMode, {
			requireExactMode: request.pageState !== null || request.cause === 'user-switch',
			clearActiveOnFailure: request.cause === 'history-pop',
			beforeClearActive: () => {
				suspendLifecycle();
			},
			beforeCommit: ({ requestedMode }) => {
				if (!mounted) throw new Error('Library host was unmounted');
				const committedPageState = stateForCommit(requestedMode, request.pageState);
				const usedAvailabilityFallback =
					request.pageState === null && request.preferredMode !== requestedMode;
				const timelineSessionRead =
					committedPageState.libraryView === 'timeline'
						? readTimelineSessionPageState()
						: null;
				const preserveInvalidTimelineSessionBytes =
					timelineSessionRead?.status === 'invalid' ||
					timelineSessionRead?.status === 'unavailable';
				activationCommitInProgress = true;
				try {
					const replacesMountedSubtree =
						activeModeBefore !== null &&
						(
							request.cause !== 'user-switch' ||
							request.pageState !== null ||
							activeModeBefore !== requestedMode
						);
					if (replacesMountedSubtree) {
						suspendedOutgoing = registeredLifecycle;
						suspendLifecycle(suspendedOutgoing);
					}
					classicTruncationHistoryPolicy =
						request.cause === 'history-pop' ? 'preserve' : 'replace';
					if (
						!usedAvailabilityFallback &&
						(request.cause !== 'initial' || request.pageState !== null) &&
						previousPreference !== requestedMode
					) {
						if (!commitPreferredLibraryView(requestedMode)) {
							throw new Error('Library preference could not be saved');
						}
						preferenceChanged = true;
					}

					if (committedPageState.libraryView === 'classic') {
						if (!replaceHistory(committedPageState.snapshot)) {
							throw new Error('Classic semantic history could not be restored');
						}
						classicSnapshotChanged = true;
					}

					if (request.cause === 'user-switch') {
						pushLibraryPageState(committedPageState, {
							persistTimelineSession: !preserveInvalidTimelineSessionBytes
						});
					} else if (
						request.cause === 'route-request' ||
						(request.cause === 'initial' && request.tagUntaggedInitial === true)
					) {
						replaceLibraryPageState(committedPageState, {
							persistTimelineSession: !preserveInvalidTimelineSessionBytes
						});
					}
					if (
						committedPageState.libraryView === 'timeline' &&
						!preserveInvalidTimelineSessionBytes
					) {
						persistTimelineSessionPageState(committedPageState);
					}
					if (request.classicIntent) {
						cancelHostedPendingIntent();
						const pending = publishLibraryIntent(request.classicIntent, 'replace');
						if (!pending) throw new Error('Classic Library destination is invalid');
						publishedIntentRequestId = pending.requestId;
						hostedPendingIntentId = pending.requestId;
					}
					committedActivation = {
						cause: request.cause,
						pageState: committedPageState
					};
					if (
						request.cause !== 'user-switch' ||
						request.pageState !== null ||
						activeModeBefore !== requestedMode
					) {
						renderGeneration += 1;
					}
				} catch (reason) {
					try {
						if (publishedIntentRequestId !== null) {
							cancelHostedPendingIntent(publishedIntentRequestId);
							publishedIntentRequestId = null;
						}
						if (classicSnapshotChanged) replaceHistory(previousClassicSnapshot);
						if (preferenceChanged) rollbackPreference(previousPreference);
					} finally {
						committedActivation = previousCommittedActivation;
						classicTruncationHistoryPolicy = previousClassicTruncationHistoryPolicy;
						if (
							request.cause !== 'history-pop' &&
							suspendedOutgoing &&
							previousCommittedActivation
						) {
							resumeLifecycle(suspendedOutgoing, previousCommittedActivation);
						}
					}
					throw reason;
				} finally {
					activationCommitInProgress = false;
				}
			}
		});

		if (result.status !== 'activated' && publishedIntentRequestId !== null) {
			cancelHostedPendingIntent(publishedIntentRequestId);
		}
		return result.status;
	}

	function activateInitial(): void {
		if (initialActivationStarted) return;
		initialActivationStarted = true;
		const requestedPageState = normalizeLibraryPageStateEnvelope(page.state);
		const requestedRouteState =
			requestedPageState ?? normalizeLibraryViewRequestPageStateEnvelope(page.state);
		const navigationCause: LibraryViewActivationCause =
			latestNavigationType === 'popstate'
				? 'history-pop'
				: latestNavigationType !== null && latestNavigationType !== 'enter'
					? 'route-request'
					: 'initial';
		void activate({
			preferredMode: requestedRouteState?.libraryView ?? get(libraryViewStore),
			cause: navigationCause,
			pageState: requestedRouteState,
			// A request-only marker is not a semantic history entry. Replace it
			// with the retained state that the host actually commits.
			tagUntaggedInitial: requestedPageState === null
		});
	}

	async function requestUserSwitch(
		preferredMode: LibraryView
	): Promise<LibraryViewHostActivationOutcome> {
		if (activationCommitInProgress) {
			await new Promise<void>((resolve) => queueMicrotask(resolve));
			if (!mounted) return 'superseded';
			return requestUserSwitch(preferredMode);
		}
		return activate({ preferredMode, cause: 'user-switch', pageState: null });
	}

	async function requestOpenClassic(
		intent: LibraryIntent
	): Promise<LibraryViewHostActivationOutcome> {
		if (activationCommitInProgress) {
			await new Promise<void>((resolve) => queueMicrotask(resolve));
			if (!mounted) return 'superseded';
			return requestOpenClassic(intent);
		}
		return activate({
			preferredMode: 'classic',
			cause: 'user-switch',
			pageState: buildClassicRootPageState(),
			classicIntent: intent
		});
	}

	function retryActivation(): void {
		if (retryRequest) void activate(retryRequest);
	}

	function recoverClassic(): void {
		const safeRoot = buildClassicRootPageState();
		const alreadyPoppedToSafeClassicRoot =
			retryRequest?.pageState?.libraryView === 'classic' &&
			JSON.stringify(retryRequest.pageState) === JSON.stringify(safeRoot);
		void activate({
			preferredMode: 'classic',
			cause: alreadyPoppedToSafeClassicRoot ? 'history-pop' : 'user-switch',
			pageState: safeRoot
		});
	}

	afterNavigate((navigation) => {
		latestNavigationType = navigation.type ?? 'enter';
		if (mounted && !initialActivationStarted) activateInitial();
	});

	$effect(() => {
		const currentPageState = page.state;
		if (!mounted || currentPageState === observedPageState) return;
		observedPageState = currentPageState;
		if (consumeSelfAuthoredLibraryPageState(currentPageState)) return;
		const requestedPageState = normalizeLibraryPageStateEnvelope(currentPageState);
		const requestedRouteState =
			requestedPageState ?? normalizeLibraryViewRequestPageStateEnvelope(currentPageState);
		void activate({
			preferredMode: requestedRouteState?.libraryView ?? get(libraryViewStore),
			cause: 'history-pop',
			pageState: requestedRouteState
		});
	});

	$effect(() => {
		if (ActiveComponent || !$controller.error) return;
		queueMicrotask(() => errorShell?.focus());
	});

	onMount(() => {
		const host = claimLibraryViewHost();
		host.handleRequests(requestUserSwitch);
		host.handleOpenClassicRequests(requestOpenClassic);
		const unsubscribe = controller.subscribe((state) => {
			const pendingMode = state.loading ? state.requestedMode : null;
			const transition =
				pendingMode !== null &&
				state.activeMode !== null &&
				pendingMode !== state.activeMode
					? {
							fromMode: state.activeMode,
							toMode: pendingMode
						}
					: null;
			host.publishActiveMode(state.activeMode, transition, pendingMode);
		});
		mounted = true;
		if (latestNavigationType !== null) activateInitial();

		return () => {
			mounted = false;
			cancelHostedPendingIntent();
			try {
				suspendLifecycle();
			} finally {
				registeredLifecycle = null;
			}
			controller.invalidatePending();
			clearPendingLibraryPageStateWrite();
			unsubscribe();
			host.release();
		};
	});
</script>

{#if ActiveComponent}
	{#key renderGeneration}
		<ActiveComponent />
	{/key}
	{#if $controller.error}
		<section
			class="library-warm-error"
			role="alert"
			data-testid="library-mode-warm-error"
		>
			<span>The requested Library view couldn’t load.</span>
			<button type="button" onclick={retryActivation}>Retry</button>
		</section>
	{/if}
{:else if $controller.error}
	<section
		class="library-load-state"
		role="alert"
		data-testid="library-mode-error"
		tabindex="-1"
		bind:this={errorShell}
	>
		<strong>Library couldn’t load.</strong>
		<span>Retry this history entry, or open a safe Classic root.</span>
		<div class="library-load-actions">
			<button type="button" onclick={retryActivation}>Retry</button>
			<button type="button" onclick={recoverClassic}>Open Classic</button>
		</div>
	</section>
{:else}
	<div
		class="library-load-state"
		role="status"
		aria-live="polite"
		data-testid="library-mode-loading"
	>
		Loading library…
	</div>
{/if}

<style>
	.library-load-state {
		min-height: 12rem;
		display: grid;
		place-content: center;
		justify-items: center;
		gap: 0.65rem;
		padding: 2rem;
		color: var(--text-soft);
		text-align: center;
	}

	.library-load-state strong {
		color: var(--text);
	}

	.library-load-state button {
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 0.55rem 0.9rem;
		background: var(--surface-2);
		color: var(--text);
		font: inherit;
		cursor: pointer;
	}

	.library-load-state button:hover {
		background: var(--surface-3);
	}

	.library-load-actions {
		display: flex;
		gap: 0.55rem;
	}

	.library-warm-error {
		position: fixed;
		inset: auto 1rem 5.5rem auto;
		z-index: 30;
		display: flex;
		align-items: center;
		gap: 0.75rem;
		max-width: min(28rem, calc(100vw - 2rem));
		padding: 0.7rem 0.85rem;
		border: 1px solid var(--border);
		border-radius: 10px;
		background: var(--surface-2);
		color: var(--text);
		box-shadow: 0 12px 30px rgb(0 0 0 / 0.28);
	}
</style>
