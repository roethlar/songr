<script lang="ts">
 import LibraryActionIcon from '$lib/components/LibraryActionIcon.svelte';
 let { name }: { name: string } = $props();
</script>

<LibraryActionIcon {name} />
