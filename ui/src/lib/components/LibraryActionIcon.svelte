<script lang="ts">
	let { name }: { name: string } = $props();
</script>

<svg class="library-action-icon selection-action-icon" viewBox="0 0 24 24" width="20" height="20" fill="none"
	stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"
	aria-hidden="true" focusable="false">
	{#if name === 'play' || name === 'play-now' || name === 'play-from-here'}
		<path d="M8.5 5v14l11-7z" fill="currentColor" stroke="none" />
	{:else if name === 'next' || name === 'add-next'}
		<path d="M4 5h16M12 12h8M12 19h8M3 9l4 3-4 3M7 12H2" />
	{:else if name === 'queue'}
		<path d="M3 5h17M3 10h17M3 15h8M3 20h8M18 14v8M14 18h8" />
	{:else if name === 'all'}
		<path d="M7 4H3v16h4M10 5h11M10 12h11M10 19h11" />
	{:else if name === 'clear' || name === 'cancel'}
		<path d="m6 6 12 12M18 6 6 18" />
	{:else if name === 'bookmark'}
		<path d="M7 3.5h10v17l-5-3.5-5 3.5z" />
	{:else if name === 'find'}
		<circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 5 5" />
	{:else if name === 'open'}
		<path d="M4 12h16m-6-6 6 6-6 6" />
	{:else if name === 'remove'}
		<path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7" />
	{:else}
		<circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" />
	{/if}
</svg>
