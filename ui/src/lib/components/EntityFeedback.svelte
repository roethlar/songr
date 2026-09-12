<script lang="ts">
 let { message = null, error = false, label = 'Library status' }: { message?: string | null; error?: boolean; label?: string } = $props();
 let node: HTMLDivElement | null = $state(null);
 let bottom = $state(94);
 $effect(() => {
  const player = node?.closest('.unified-surface')?.querySelector<HTMLElement>('.player');
  if (!player) return;
  const position = () => { bottom = Math.max(12, window.innerHeight - player.getBoundingClientRect().top + 12); };
  const resize = new ResizeObserver(position); resize.observe(player); window.addEventListener('resize', position); position();
  return () => { resize.disconnect(); window.removeEventListener('resize', position); };
 });
</script>
<div class="entity-feedback" class:error role={error ? 'alert' : 'status'} aria-label={label} aria-live={error ? 'assertive' : 'polite'} aria-atomic="true"
 bind:this={node} style:bottom="{bottom}px" class:visible={Boolean(message)}>{message ?? ''}</div>
<style>
 .entity-feedback { position: fixed; right: 22px; z-index: 45; max-width: min(420px, calc(100vw - 44px));
  pointer-events: none; padding: 8px 12px; border: 1px solid var(--line); border-radius: 5px; background: var(--songr-control);
  color: var(--songr-text); font-size: 12px; visibility: hidden; }
 .entity-feedback.visible { visibility: visible; }
 .entity-feedback.error { color: var(--songr-error); }
</style>
