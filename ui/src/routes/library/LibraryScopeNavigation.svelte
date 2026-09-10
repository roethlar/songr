<script lang="ts">
	import { tick } from 'svelte';
	import type { NavigationDestinationId } from '@shared/navigationSettings';

	let { items, order, pinned, activeId, selectedId = activeId, onSelect }: {
		items: readonly { id: NavigationDestinationId; label: string }[];
		order: readonly NavigationDestinationId[];
		pinned: readonly NavigationDestinationId[];
		activeId: NavigationDestinationId | null;
		selectedId?: NavigationDestinationId | null;
		onSelect: (id: NavigationDestinationId) => void;
	} = $props();
	const ordered = $derived(order.flatMap(id => items.find(item => item.id === id) ?? []));
	const primary = $derived(ordered.filter(item => pinned.includes(item.id)));
	let visibleIds = $state<readonly NavigationDestinationId[] | null>(null);
	const visible = $derived(primary.filter(item => visibleIds === null || visibleIds.includes(item.id)));
	const overflow = $derived(ordered.filter(item => !visible.some(shown => shown.id === item.id)));
	let wrapper = $state<HTMLDivElement>();
	let moreButton = $state<HTMLButtonElement>();
	let menu = $state<HTMLDivElement>();
	let open = $state(false);
	let menuLeft = $state(0);
	let menuMaxHeight = $state(360);

	function fit(): void {
		if (!wrapper) return;
		const width = wrapper.clientWidth;
		if (width <= 0) return;
		const widths = new Map(Array.from(wrapper.querySelectorAll<HTMLButtonElement>('[data-primary-id]'))
			.map(button => [button.dataset.primaryId, button.getBoundingClientRect().width]));
		const allWidth = primary.reduce((sum, item) => sum + (widths.get(item.id) ?? 0), 0)
			+ Math.max(0, primary.length - 1) * 8;
		const hasUnpinned = ordered.length > primary.length;
		const capacity = allWidth <= width && !hasUnpinned ? width : width - (moreButton?.getBoundingClientRect().width ?? 82) - 8;
		let used = 0;
		const next: NavigationDestinationId[] = [];
		for (const item of primary) {
			const cost = (widths.get(item.id) ?? 0) + (next.length ? 8 : 0);
			if (used + cost > capacity) break;
			next.push(item.id);
			used += cost;
		}
		if (visibleIds === null || next.join('|') !== visibleIds.join('|')) visibleIds = next;
		if (moreButton) {
			const rect = wrapper.getBoundingClientRect();
			menuLeft = Math.max(0, Math.min(moreButton.offsetLeft, rect.width - Math.min(264, rect.width)));
			const paneBottom = wrapper.closest<HTMLElement>('[data-library-scroll-pane]')?.getBoundingClientRect().bottom ?? window.innerHeight;
			menuMaxHeight = Math.max(0, Math.min(360, Math.min(window.innerHeight, paneBottom) - rect.bottom - 16));
		}
	}
	$effect(() => {
		order; pinned; items; activeId;
		let canceled = false;
		void tick().then(() => { if (!canceled) fit(); });
		return () => { canceled = true; };
	});
	$effect(() => {
		primary;
		if (!wrapper || typeof ResizeObserver === 'undefined') return;
		const observer = new ResizeObserver(fit);
		observer.observe(wrapper);
		const pane = wrapper.closest<HTMLElement>('[data-library-scroll-pane]');
		if (pane) observer.observe(pane);
		wrapper.querySelectorAll<HTMLButtonElement>('.sc').forEach(button => observer.observe(button));
		return () => observer.disconnect();
	});
	function close(restoreFocus = false): void {
		open = false;
		if (restoreFocus) moreButton?.focus({ preventScroll: true });
	}
	async function showMenu(last = false): Promise<void> {
		if (!overflow.length) return;
		fit(); open = true;
		await tick();
		const buttons = menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
		focusMenuItem(buttons?.[last ? buttons.length - 1 : 0]);
	}
	function focusMenuItem(button: HTMLButtonElement | undefined): void {
		if (!button || !menu) return;
		button.focus({ preventScroll: true });
		const top = button.offsetTop, bottom = top + button.offsetHeight;
		if (top < menu.scrollTop) menu.scrollTop = top;
		else if (bottom > menu.scrollTop + menu.clientHeight) menu.scrollTop = bottom - menu.clientHeight;
	}
	function menuKeys(event: KeyboardEvent): void {
		if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
		if (event.key === 'Tab') { close(true); return; }
		if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
		event.preventDefault();
		const buttons = Array.from(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
		const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
		const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
			: (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
		focusMenuItem(buttons[next]);
	}
	$effect(() => {
		if (!open) return;
		if (!overflow.length) { close(true); return; }
		const outside = (event: PointerEvent) => { if (!wrapper?.contains(event.target as Node)) close(); };
		window.addEventListener('pointerdown', outside);
		return () => window.removeEventListener('pointerdown', outside);
	});
</script>

<div class="scope-navigation" bind:this={wrapper}>
	{#each primary as item (item.id)}
		{@const hidden = !visible.some(shown => shown.id === item.id)}
		<button type="button" class="sc" class:on={activeId === item.id} class:scope-measure={hidden}
			data-primary-id={item.id} data-testid={hidden ? undefined : `unified-scope-${item.id}`}
			aria-hidden={hidden ? true : undefined} tabindex={hidden ? -1 : 0}
			aria-pressed={selectedId === item.id} onclick={() => { close(); onSelect(item.id); }}>{item.label}</button>
	{/each}
	<button type="button" class="sc scope-more" class:scope-measure={!overflow.length}
		class:on={overflow.some(item => item.id === activeId)} bind:this={moreButton}
		aria-hidden={!overflow.length ? true : undefined} tabindex={overflow.length ? 0 : -1}
		aria-haspopup="menu" aria-expanded={open} aria-label="More library pages"
		data-testid={overflow.length ? 'unified-scope-more' : undefined}
		onclick={() => { if (open) close(true); else void showMenu(); }}
		onkeydown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); void showMenu(event.key === 'ArrowUp'); } }}>
		More <span aria-hidden="true">⌄</span>
	</button>
	{#if open && overflow.length}
		<div class="scope-overflow" role="menu" aria-label="More library pages" tabindex="-1"
			bind:this={menu} style:left="{menuLeft}px" style:max-height="{menuMaxHeight}px" onkeydown={menuKeys}>
			{#each overflow as item (item.id)}
				<button type="button" role="menuitem" tabindex="-1" class:on={activeId === item.id}
					aria-current={activeId === item.id ? 'page' : undefined} data-testid="unified-scope-{item.id}"
					onclick={() => { close(true); onSelect(item.id); }}>{item.label}</button>
			{/each}
		</div>
	{/if}
</div>
