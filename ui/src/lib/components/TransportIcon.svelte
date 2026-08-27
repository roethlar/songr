<script lang="ts">
	// Inline SVG transport icons replacing text glyphs (⏮ ▶ ⏸ ⏭), which
	// rendered with platform-dependent metrics and off-center baselines
	// (GitHub issue #5). Paths sit on a 24px grid, fill currentColor.
	let { kind, size = 16 } = $props<{
		kind: 'previous' | 'play' | 'pause' | 'next';
		size?: number;
	}>();
</script>

<svg
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill="currentColor"
	aria-hidden="true"
	focusable="false"
>
	{#if kind === 'previous'}
		<path d="M6 5h2v14H6zM20 5v14L9.5 12z" />
	{:else if kind === 'play'}
		<path d="M8.5 5v14l11-7z" />
	{:else if kind === 'pause'}
		<path d="M7 5h4v14H7zm6 0h4v14h-4z" />
	{:else}
		<path d="M16 5h2v14h-2zM4 5v14l10.5-7z" />
	{/if}
</svg>
