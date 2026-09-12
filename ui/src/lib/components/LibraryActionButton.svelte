<script lang="ts">
 import type { HTMLButtonAttributes } from 'svelte/elements';
 import LibraryActionIcon from './LibraryActionIcon.svelte';
 let { icon, label, element = $bindable(), class: className = '', title, ...attributes }:
  Omit<HTMLButtonAttributes, 'children'> & {
   icon: string;
   label: string;
   element?: HTMLButtonElement | null;
  } = $props();
</script>

<button type="button" {...attributes} bind:this={element}
 class={`library-action-button ${className}`} title={title ?? label} aria-label={attributes['aria-label'] ?? label}>
 <span class="library-action-symbol"><LibraryActionIcon name={icon} /></span>
 <span class="library-action-label">{label}</span>
</button>

<style>
 .library-action-button {
  --library-action-target:36px;
  --library-action-icon:20px;
  display:inline-flex; align-items:center; justify-content:center; flex:none;
  min-width:var(--library-action-target); height:var(--library-action-target);
  box-sizing:border-box; gap:6px; margin:0; padding:0 6px;
  border:0; border-radius:4px; background:transparent; color:var(--songr-accent);
  font:inherit; font-size:13px; line-height:1; white-space:nowrap; cursor:pointer;
 }
 :global([data-density="compact"]) .library-action-button { --library-action-target:32px; --library-action-icon:18px; }
 :global([data-density="pi"]) .library-action-button { --library-action-target:44px; --library-action-icon:22px; }
 .library-action-symbol { display:inline-flex; width:var(--library-action-icon); height:var(--library-action-icon); flex:none; }
 .library-action-symbol :global(svg) { width:100%; height:100%; }
 .library-action-label { display:none; }
 :global([data-action-display="text"]) .library-action-symbol { display:none; }
 :global([data-action-display="text"]) .library-action-label,
 :global([data-action-display="both"]) .library-action-label { display:inline; }
 .library-action-button:hover:not(:disabled) { color:var(--songr-accent-bright); }
 .library-action-button:disabled { opacity:.3; cursor:default; }
 .library-action-button:focus-visible { outline:2px solid var(--songr-accent); outline-offset:-2px; }
 @media (hover:none), (any-pointer:coarse) {
  .library-action-button,
  :global([data-density="compact"]) .library-action-button,
  :global([data-density="pi"]) .library-action-button { --library-action-target:44px; }
 }
</style>
