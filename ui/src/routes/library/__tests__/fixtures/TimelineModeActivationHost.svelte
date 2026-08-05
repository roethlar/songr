<script lang="ts">
	import { setContext } from 'svelte';
	import type { TimelineLibraryPageState } from '$lib/libraryPageState';
	import {
		LIBRARY_MODE_ACTIVATION_CONTEXT,
		type LibraryModeActivationContext
	} from '$lib/libraryModeActivationContext';
	import type { TimelineBrowseSessionStore } from '$lib/stores/timelineBrowseSessionStore';
	import TimelineLibraryMode from '../../TimelineLibraryMode.svelte';

	let {
		browseStore,
		pageState
	}: {
		browseStore: TimelineBrowseSessionStore;
		pageState: TimelineLibraryPageState;
	} = $props();

	const context: LibraryModeActivationContext = {
		classicTruncationHistoryPolicy: () => 'preserve',
		committedActivation: () => ({ cause: 'history-pop', pageState })
	};
	setContext(LIBRARY_MODE_ACTIVATION_CONTEXT, context);
</script>

<TimelineLibraryMode {browseStore} />
