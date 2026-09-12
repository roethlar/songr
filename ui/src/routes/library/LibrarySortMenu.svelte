<script lang="ts">
	import type { SortMenuEntry } from '$lib/unifiedLibrarySorts';

	const {
		options,
		value,
		onSort,
		groupByLetter = false,
		onGroupByLetter,
		testId
	}: {
		options: readonly SortMenuEntry[];
		value: string;
		onSort: (value: string) => void;
		groupByLetter?: boolean;
		onGroupByLetter?: (enabled: boolean) => void;
		testId?: string;
	} = $props();

	let open = $state(false);
	let wrap: HTMLDivElement | null = $state(null);
	let trigger: HTMLButtonElement | null = $state(null);
	const menuId = $props.id();
	const canGroup = $derived(value === 'az' || value === 'za' || value === 'by-artist');

	function close(restoreFocus = true): void {
		open = false;
		if (restoreFocus) trigger?.focus({ preventScroll: true });
	}

	$effect(() => {
		if (!open) return;
		const outside = (event: PointerEvent) => {
			if (event.target instanceof Node && !wrap?.contains(event.target)) close(false);
		};
		const escape = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return;
			event.preventDefault();
			event.stopPropagation();
			close();
		};
		window.addEventListener('pointerdown', outside);
		window.addEventListener('keydown', escape, true);
		return () => {
			window.removeEventListener('pointerdown', outside);
			window.removeEventListener('keydown', escape, true);
		};
	});
</script>

<div class="sortc-wrap" bind:this={wrap}>
	<button type="button" class="sortc" data-testid={testId} bind:this={trigger}
		aria-expanded={open} aria-controls={menuId} onclick={() => (open = !open)}>
		Sort: <b>{options.find((option) => option.id === value)?.label ?? ''}</b>
		<span style="color:var(--dim)">▾</span>
	</button>
	<div class="smenu" class:open id={menuId} role="group" aria-label="Sort and grouping">
		{#each options as option (option.id)}
			<button type="button" class="so" class:on={option.id === value}
				aria-pressed={option.id === value}
				data-testid={testId ? `${testId}-option-${option.id}` : undefined}
				onclick={() => { onSort(option.id); close(); }}>
				{option.label}
			</button>
		{/each}
		{#if onGroupByLetter}
			<button type="button" class="so grouping-option" class:on={groupByLetter && canGroup}
				aria-pressed={groupByLetter && canGroup} disabled={!canGroup}
				data-testid={testId ? `${testId}-group-by-letter` : undefined}
				onclick={() => { if (canGroup) onGroupByLetter?.(!groupByLetter); close(); }}>
				Group by letter
			</button>
		{/if}
	</div>
</div>

<style>
	.grouping-option {
		border-top: 1px solid var(--line);
		margin-top: 5px;
	}
	.grouping-option:disabled {
		color: var(--dim);
		cursor: default;
		background: transparent;
	}
</style>
