<script lang="ts">
 import type { Snippet } from 'svelte';
 import { artworkPlay } from '$lib/artworkPlay';
 import LibraryActionIcon from './LibraryActionIcon.svelte';
 let { children, onclick, disabled = false, generation, label = 'Play album' }: {
  children: Snippet; onclick: () => void; disabled?: boolean; generation: unknown; label?: string;
 } = $props();
 let revealed = $state(false);
</script>
<div class="artwork-play" class:revealed class:disabled use:artworkPlay={{ generation, disabled, revealed: () => revealed, reveal: value => revealed = value, play: onclick }}>
 {@render children()}
 <div class="artwork-shade" aria-hidden="true"></div>
 <button type="button" class="artwork-play-button" data-artwork-play aria-label={label} title={label} {disabled}>
  <span class="play-symbol"><LibraryActionIcon name="play" /></span>
  <span class="play-label">Play</span>
 </button>
</div>
<style>
 .artwork-play { position: relative; width: 196px; height: 196px; }
 .artwork-shade { position: absolute; inset: 0; border-radius: 4px; background: #0008; opacity: 0; pointer-events: none; }
 .artwork-play-button { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); display: grid; place-items: center;
  width: 52px; height: 52px; border-radius: 50%; border: 1px solid var(--songr-accent); background: #0009; color: var(--songr-accent);
  opacity: 0; pointer-events: none; cursor: pointer; }
 .play-symbol { display: inline-flex; }
 .play-label { display: none; font: inherit; font-size: 12px; }
 :global([data-action-display="text"]) .play-symbol { display: none; }
 :global([data-action-display="text"]) .play-label, :global([data-action-display="both"]) .play-label { display: inline; }
 :global([data-action-display="both"]) .artwork-play-button { align-content: center; gap: 1px; }
 :global([data-action-display="both"]) .play-symbol :global(svg) { width: 19px; height: 19px; }
 .artwork-play-button :global(svg) { width: 24px; height: 24px; margin-left: 2px; }
 .artwork-play-button:focus-visible { outline: 2px solid var(--songr-accent); outline-offset: 4px; }
 .artwork-play.revealed:not(.disabled) .artwork-shade,
 .artwork-play.revealed:not(.disabled) .artwork-play-button,
 .artwork-play:has(.artwork-play-button:focus-visible):not(.disabled) .artwork-shade,
 .artwork-play:has(.artwork-play-button:focus-visible):not(.disabled) .artwork-play-button { opacity: 1; }
 .artwork-play.revealed:not(.disabled) .artwork-play-button { pointer-events: auto; }
 @media (hover: hover) { .artwork-play:hover:not(.disabled):not(:global(.touch-interaction)) .artwork-shade, .artwork-play:hover:not(.disabled):not(:global(.touch-interaction)) .artwork-play-button { opacity: 1; }
  .artwork-play:hover:not(.disabled):not(:global(.touch-interaction)) .artwork-play-button { pointer-events: auto; } }
</style>
