<script lang="ts">
	import type { Snippet } from 'svelte';
	import { prepareRetainedLibraryPanel } from '$lib/retainedLibraryPanel';
	let { active, revision, children, notifyChrome = false }: {
		active: boolean; revision: unknown; children: Snippet; notifyChrome?: boolean;
	} = $props();
	let panel: HTMLDivElement | undefined = $state();
	$effect(() => {
		active;
		if (notifyChrome) panel?.dispatchEvent(new Event('library-panel-visibility', { bubbles: true }));
	});
</script>

<div class="retained-library-panel" data-retained-library-panel aria-hidden={active ? undefined : 'true'}
	bind:this={panel} use:prepareRetainedLibraryPanel={revision}>
	<div class="retained-library-content">{@render children()}</div>
</div>

<style>
	.retained-library-panel { contain: layout style paint; }
	.retained-library-panel[aria-hidden="true"] {
		height: 0;
		overflow: clip;
		content-visibility: hidden;
	}
</style>
