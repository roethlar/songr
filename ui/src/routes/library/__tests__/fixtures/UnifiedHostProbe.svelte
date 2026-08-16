<script lang="ts">
	import { getContext, onMount } from 'svelte';
	import {
		LIBRARY_MODE_ACTIVATION_CONTEXT,
		type CommittedLibraryModeActivation,
		type LibraryModeActivationContext
	} from '$lib/libraryModeActivationContext';

	const host = getContext<LibraryModeActivationContext>(LIBRARY_MODE_ACTIVATION_CONTEXT);
	const initialActivation = host.committedActivation?.();
	const registerLifecycle = host.registerLifecycle;
	if (!initialActivation || !registerLifecycle) {
		throw new TypeError('Unified host activation context is required');
	}
	let activation = $state<CommittedLibraryModeActivation>(initialActivation);

	onMount(() =>
		registerLifecycle('unified', {
			resume(next) {
				activation = next;
			},
			suspend() {}
		})
	);
</script>

<div
	data-testid="unified-host-probe"
	data-cause={activation.cause}
	data-scope={activation.pageState.snapshot.scope}
></div>
