<script lang="ts">
	import { onMount, setContext } from 'svelte';
	import { afterNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import {
		buildUnifiedRootPageState,
		normalizeLibraryPageStateEnvelope,
		type LibraryViewActivationCause
	} from '$lib/libraryPageState';
	import {
		clearPendingLibraryPageStateWrite,
		consumeSelfAuthoredLibraryPageState,
		replaceLibraryPageState
	} from '$lib/libraryPageNavigation';
	import {
		LIBRARY_MODE_ACTIVATION_CONTEXT,
		type CommittedLibraryModeActivation,
		type LibraryModeLifecycle
	} from '$lib/libraryModeActivationContext';
	import { claimLibraryViewHost } from '$lib/stores/libraryViewHostStore';
	import type { LibraryView } from '$lib/stores/libraryViewStore';
	import UnifiedLibraryMode from './UnifiedLibraryMode.svelte';

	let mounted = false;
	let observedPageState: App.PageState = page.state;
	let committedActivation: CommittedLibraryModeActivation = {
		cause: 'initial',
		pageState: normalizeLibraryPageStateEnvelope(page.state) ?? buildUnifiedRootPageState()
	};
	let registeredLifecycle: LibraryModeLifecycle | null = null;
	let initialNavigationHandled = false;

	function commitActivation(cause: LibraryViewActivationCause): void {
		const normalized = normalizeLibraryPageStateEnvelope(page.state);
		const pageState = normalized ?? buildUnifiedRootPageState();
		registeredLifecycle?.suspend();
		committedActivation = { cause, pageState };
		registeredLifecycle?.resume(committedActivation);
		if (!normalized) replaceLibraryPageState(pageState);
	}

	setContext(LIBRARY_MODE_ACTIVATION_CONTEXT, {
		committedActivation: () => committedActivation,
		registerLifecycle(mode: LibraryView, lifecycle: LibraryModeLifecycle): () => void {
			if (mode !== 'unified') throw new TypeError('Only Unified Library can register');
			registeredLifecycle?.suspend();
			registeredLifecycle = lifecycle;
			lifecycle.resume(committedActivation);
			return () => {
				if (registeredLifecycle !== lifecycle) return;
				lifecycle.suspend();
				registeredLifecycle = null;
			};
		}
	});

	afterNavigate(() => {
		if (!mounted || initialNavigationHandled) return;
		initialNavigationHandled = true;
		if (!normalizeLibraryPageStateEnvelope(page.state)) {
			replaceLibraryPageState(committedActivation.pageState);
		}
	});

	$effect(() => {
		const currentPageState = page.state;
		if (!mounted || currentPageState === observedPageState) return;
		observedPageState = currentPageState;
		if (consumeSelfAuthoredLibraryPageState(currentPageState)) return;
		commitActivation('history-pop');
	});

	onMount(() => {
		const host = claimLibraryViewHost();
		mounted = true;
		host.publishActiveMode('unified');

		return () => {
			mounted = false;
			registeredLifecycle?.suspend();
			registeredLifecycle = null;
			clearPendingLibraryPageStateWrite();
			host.release();
		};
	});
</script>

<UnifiedLibraryMode />
