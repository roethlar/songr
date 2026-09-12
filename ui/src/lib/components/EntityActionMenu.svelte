<script lang="ts">
 import { tick, untrack, type Snippet } from 'svelte';
 import LibraryActionButton from './LibraryActionButton.svelte';
 let { label, disabled = false, children, onOpen, onClose, generation, remoteActive }: {
  label: string; disabled?: boolean; children: Snippet<[() => void]>; onOpen?: () => void; onClose?: () => void; generation?: unknown; remoteActive?: boolean;
 } = $props();
 let open = $state(false);
 let wasRemoteActive = false;
 let surface: HTMLDivElement | null = $state(null);
 let trigger: HTMLButtonElement | null = $state(null);
 let menuElement: HTMLDivElement | null = $state(null);
 let positioned = $state(false);
 let menuLeft = $state(8);
 let menuTop = $state(8);
 $effect(() => {
  if (!open || !menuElement || !trigger) { positioned = false; return; }
  const menu = menuElement, anchor = trigger;
  const position = () => {
   const bounds = menu.getBoundingClientRect(), target = anchor.getBoundingClientRect();
   const width = document.documentElement.clientWidth || window.innerWidth;
   const height = window.innerHeight;
   menuLeft = Math.max(8, Math.min(target.right - bounds.width, width - bounds.width - 8));
   menuTop = Math.max(8, Math.min(target.bottom + 4, height - bounds.height - 8));
   positioned = true;
  };
  const resize = new ResizeObserver(position);
  resize.observe(menu); resize.observe(anchor);
  window.addEventListener('resize', position); document.addEventListener('scroll', position, true);
  position();
  return () => { resize.disconnect(); window.removeEventListener('resize', position); document.removeEventListener('scroll', position, true); };
 });
 function close(focus = true, notify = true) { if (!open) return; open = false; if (notify) onClose?.(); if (focus) trigger?.focus({ preventScroll: true }); }
 $effect(() => { void generation; untrack(() => close(false)); });
 $effect(() => {
  const active = remoteActive;
  if (wasRemoteActive && active === false) untrack(() => close(true, false));
  wasRemoteActive = active === true;
 });
 $effect(() => {
  if (!open) return;
  const outside = (event: PointerEvent) => { if (event.target instanceof Node && !surface?.contains(event.target)) close(false); };
  const escape = (event: KeyboardEvent) => {
   if (event.key === 'Escape') { event.preventDefault(); close(); return; }
   if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !(event.target instanceof Node) || !surface?.contains(event.target)) return;
   const items = Array.from(surface.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)'));
   if (!items.length) return;
   event.preventDefault();
   const current = items.indexOf(document.activeElement as HTMLElement);
   const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? (current + 1) % items.length : (current - 1 + items.length) % items.length;
   items[index]?.focus({ preventScroll: true });
  };
  document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape, true);
  return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true); };
 });
 async function toggle() { if (open) { close(); return; } open = true; onOpen?.(); await tick(); (surface?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? surface?.querySelector<HTMLElement>('[role="menu"]'))?.focus({ preventScroll: true }); }
</script>
<div class="entity-menu" bind:this={surface}>
 <LibraryActionButton icon="more" label="More" aria-label={label} aria-haspopup="menu" aria-expanded={open} disabled={!open && disabled} onclick={toggle} onkeydown={event => { if (!open && event.key === 'ArrowDown') { event.preventDefault(); void toggle(); } }} bind:element={trigger} />
 {#if open}<div class="entity-menu-content" class:positioned bind:this={menuElement} style:left="{menuLeft}px" style:top="{menuTop}px" role="menu" tabindex="-1" aria-label={label}>{@render children(() => close())}</div>{/if}
</div>
<style>
 .entity-menu { position: relative; flex-shrink: 0; }
 .entity-menu-content { position: fixed; visibility: hidden; z-index: 30; display: flex; flex-direction: column; min-width: 180px;
  width: max-content; max-width: min(320px, calc(100vw - 16px)); max-height: min(300px, calc(100dvh - 16px)); overflow-y: auto; padding: 5px; background: var(--songr-control); border: 1px solid var(--line);
  border-radius: 5px; box-shadow: 0 4px 12px var(--songr-scrim); }
 .entity-menu-content.positioned { visibility: visible; }
 .entity-menu-content :global(button) { flex-shrink: 0; text-align: left; justify-content: flex-start; white-space: normal; }
 .entity-menu-content :global(.menu-status) { padding: 7px 10px; font-size: 12px; color: var(--soft); }
</style>
