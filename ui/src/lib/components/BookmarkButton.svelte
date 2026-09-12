<script lang="ts">
 import LibraryActionButton from './LibraryActionButton.svelte';
 let { onclick, disabled = false, title = 'Bookmark', label = 'Bookmark' }: {
  onclick: () => void; disabled?: boolean; title?: string; label?: string;
 } = $props();
</script>
<LibraryActionButton icon="bookmark" {label} {onclick} {disabled} {title} aria-label={title} />
