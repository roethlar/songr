<script lang="ts">
	import { setContext } from 'svelte';
	import {
		LIBRARY_MODE_ACTIVATION_CONTEXT,
		type LibraryModeActivationContext
	} from '$lib/libraryModeActivationContext';
	import ClassicLibraryMode from '../../ClassicLibraryMode.svelte';

	const activation: LibraryModeActivationContext = {
		classicTruncationHistoryPolicy: () => 'preserve'
	};
	setContext(LIBRARY_MODE_ACTIVATION_CONTEXT, activation);
</script>

<ClassicLibraryMode restoreOnMount={true} />
