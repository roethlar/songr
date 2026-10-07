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
	let resumes = $state(0);

	onMount(() =>
		registerLifecycle('unified', {
			resume(next) {
				activation = next;
				resumes += 1;
			},
			suspend() {}
		})
	);
</script>

<div
	data-testid="unified-host-probe"
	data-cause={activation.cause}
	data-scope={activation.pageState.snapshot.scope}
	data-artist-view={activation.pageState.snapshot.artistView}
	data-resumes={resumes}
></div>
