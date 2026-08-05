<script module lang="ts">
	import type { LibraryView } from '$lib/stores/libraryViewStore';

	export interface FakeLibraryModeLifecycleEvent {
		readonly type: 'mount' | 'resume' | 'suspend' | 'unmount';
		readonly mode: LibraryView;
		readonly instanceId: number;
	}

	let nextInstanceId = 0;
	let lifecycleEvents: FakeLibraryModeLifecycleEvent[] = [];
	let lifecycleObserver: ((event: FakeLibraryModeLifecycleEvent) => void) | null = null;

	function recordLifecycleEvent(event: FakeLibraryModeLifecycleEvent): void {
		lifecycleEvents.push(event);
		lifecycleObserver?.(event);
	}

	export function getFakeLibraryModeLifecycleEvents(): readonly FakeLibraryModeLifecycleEvent[] {
		return [...lifecycleEvents];
	}

	export function resetFakeLibraryModeLifecycleEvents(): void {
		lifecycleEvents = [];
		lifecycleObserver = null;
	}

	export function observeFakeLibraryModeLifecycle(
		observer: ((event: FakeLibraryModeLifecycleEvent) => void) | null
	): void {
		lifecycleObserver = observer;
	}
</script>

<script lang="ts">
	import { getContext, onMount } from 'svelte';
	import {
		LIBRARY_MODE_ACTIVATION_CONTEXT,
		type LibraryModeActivationContext
	} from '$lib/libraryModeActivationContext';

	const activation = getContext<LibraryModeActivationContext>(
		LIBRARY_MODE_ACTIVATION_CONTEXT
	);
	const committed = activation?.committedActivation?.() ?? null;
	const mode = committed?.pageState.libraryView ?? 'classic';
	const instanceId = ++nextInstanceId;

	onMount(() => {
		recordLifecycleEvent({ type: 'mount', mode, instanceId });
		const unregister = activation?.registerLifecycle?.(mode, {
			resume: () => recordLifecycleEvent({ type: 'resume', mode, instanceId }),
			suspend: () => recordLifecycleEvent({ type: 'suspend', mode, instanceId })
		});
		return () => {
			unregister?.();
			recordLifecycleEvent({ type: 'unmount', mode, instanceId });
		};
	});
</script>

<div
	data-testid="library-mode-target"
	data-classic-truncation-policy={activation?.classicTruncationHistoryPolicy() ?? 'replace'}
	data-activation-cause={committed?.cause ?? 'none'}
	data-activation-mode={committed?.pageState.libraryView ?? 'none'}
>
	Fake Library mode
</div>
