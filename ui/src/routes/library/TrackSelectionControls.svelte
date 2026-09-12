<script lang="ts" generics="T extends object">
 import { onMount, tick } from 'svelte';
 import type { Snippet } from 'svelte';
 import type { TrackSelection } from '$lib/trackSelection';
 import LibraryActionButton from '$lib/components/LibraryActionButton.svelte';
 import { chooseSelectionFocusTarget, fitSelectionToolbar, orderSelectionActions } from '$lib/selectionToolbar';
 type Action = { id: string; label: string; run: (items: T[]) => void; disabled?: boolean };
 let { selection, orderedItems, visibleItems, actions = [], busy = false, status = null,
  onCancel, onBookmark, bookmarkDisabled = false, label, more, hasMore = Boolean(more),
  moreDisabled = false, remoteMenuActive, onOpenMore, onCloseMore, groupLabel = 'Selected tracks' }: {
  selection: TrackSelection<T>;
  orderedItems: readonly T[];
  visibleItems: readonly T[];
  actions?: readonly Action[];
  busy?: boolean;
  status?: string | null;
  onCancel?: () => void;
  onBookmark?: (items: T[]) => void;
  bookmarkDisabled?: boolean;
  label?: (item: T) => string;
  groupLabel?: string;
  more?: Snippet<[T[], () => void]>;
  hasMore?: boolean;
  moreDisabled?: boolean;
  remoteMenuActive?: boolean;
  onOpenMore?: (items: T[]) => void;
  onCloseMore?: () => void;
 } = $props();
 let root: HTMLDivElement;
 let measurements: HTMLDivElement;
 let moreButton = $state<HTMLButtonElement | null>(null);
 let menu = $state<HTMLDivElement | undefined>();
 let statusButton = $state<HTMLButtonElement | undefined>();
 let menuOpen = $state(false);
 let statusOpen = $state(false);
 let fit = $state({ visibleCount: 0, showMore: true, width: 0 });
 let mandatoryWidth = $state<number | null>(null);
 let floatingStatus = $state(false);
 let previousFocusTarget: HTMLElement | null = null;
 let previousRemoteActive = false;
 let previousSelection: readonly T[] = [];
 const count = $derived($selection.count);
 const selected = $derived.by(() => { if (!$selection.count) return []; return selection.ordered(orderedItems); });
 const visibleCount = $derived.by(() => { if (!$selection.count) return 0; const set = $selection.selected; return visibleItems.reduce((count, item) => count + Number(set.has(item)), 0); });
 const hiddenCount = $derived(count - visibleCount);
 const allLabel = $derived(visibleItems.length !== orderedItems.length ? 'Select all matching items' : 'Select all');
 const selectionDescription = $derived(`${count.toLocaleString()} selected${hiddenCount > 0 ? `, ${hiddenCount.toLocaleString()} hidden by the filter` : ''}${selected.length === 1 && label ? `: ${label(selected[0])}` : ''}`);
 const orderedActions = $derived(orderSelectionActions<Action>([
  ...actions,
  ...(onBookmark ? [{ id: 'bookmark', label: 'Bookmark', disabled: bookmarkDisabled, run: (items: T[]) => onBookmark?.(items) }] : [])
 ]));
 const directActions = $derived(orderedActions.slice(0, fit.visibleCount));
 const overflowActions = $derived(orderedActions.slice(fit.visibleCount));

 function findTrackTarget(): HTMLElement | null {
  let scope: HTMLElement | null = root?.parentElement ?? null;
  while (scope) {
   const rows = Array.from(scope.querySelectorAll<HTMLElement>('[data-track-select-row]'));
   if (rows.length) {
    return chooseSelectionFocusTarget(rows.flatMap(row => {
     const target = row.querySelector<HTMLButtonElement>('button[data-track-select-target]');
     return target ? [{ target, selected: row.classList.contains('is-track-selected'),
      visible: target.getClientRects().length > 0 && !target.closest('[inert], [aria-hidden="true"]'), disabled: target.disabled }] : [];
    }));
   }
   scope = scope.parentElement;
  }
  return null;
 }
 function restoreTrackFocus(target = previousFocusTarget) {
  const reachable = target?.isConnected && target.getClientRects().length > 0 && !target.closest('[inert], [aria-hidden="true"]');
  (reachable ? target : findTrackTarget())?.focus({ preventScroll: true });
 }
 function restoreToolbarFocus() {
  if (moreButton?.isConnected && fit.showMore && count > 0 && !moreButton.disabled) {
   moreButton.focus({ preventScroll: true });
  } else {
   const button = root?.querySelector<HTMLButtonElement>('.selection-buttons button:not(:disabled)');
   if (count > 0 && button) button.focus({ preventScroll: true });
   else restoreTrackFocus();
  }
 }
 function closeMore(restoreFocus = true, notifyOwner = true) {
  if (!menuOpen) return;
  menuOpen = false;
  if (notifyOwner) onCloseMore?.();
  if (restoreFocus) void tick().then(restoreToolbarFocus);
 }
 async function toggleMore() {
  if (menuOpen) { closeMore(); return; }
  previousFocusTarget = findTrackTarget();
  statusOpen = false;
  menuOpen = true;
  if (hasMore && !moreDisabled) onOpenMore?.(selection.ordered(orderedItems));
  await tick();
  const first = menu?.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)');
  (first ?? menu)?.focus({ preventScroll: true });
 }
 function clearSelection() {
  const target = findTrackTarget();
  const ownedFocus = root?.contains(document.activeElement);
  closeMore(false);
  selection.clear();
  if (ownedFocus) void tick().then(() => restoreTrackFocus(target));
 }
 function runAction(action: Action) {
  const items = selection.ordered(orderedItems);
  closeMore();
  action.run(items);
 }
 function measureLayout() {
  if (!root || !measurements) return;
  const width = (selector: string) => measurements.querySelector<HTMLElement>(selector)?.getBoundingClientRect().width ?? 0;
  const widths = Array.from(measurements.querySelectorAll<HTMLElement>('[data-measure-action]')).map(element => element.getBoundingClientRect().width);
  const toolsWidth = width('[data-measure-tools]');
  const moreWidth = width('[data-measure-more]');
  const minimum = toolsWidth + (widths.length || hasMore ? 12 + moreWidth : 0);
  if (mandatoryWidth !== minimum) mandatoryWidth = minimum;
  const remaining = root.clientWidth - minimum;
  const floatMessage = Boolean(status && remaining < 52);
  if (floatingStatus !== floatMessage) floatingStatus = floatMessage;
  const statusWidth = status && !floatMessage ? Math.min(200, Math.max(44, root.clientWidth * .25), remaining - 8) + 8 : 0;
  const next = fitSelectionToolbar({ availableWidth: root.clientWidth - statusWidth, toolsWidth,
   actionWidths: widths, moreWidth, hasMore });
  if (next.visibleCount !== fit.visibleCount || next.showMore !== fit.showMore || next.width !== fit.width) fit = next;
 }
 function outsideFocus(event: FocusEvent) {
  if (!root?.contains(event.target as Node)) { closeMore(false); statusOpen = false; }
 }
 function outside(event: PointerEvent) {
  if (!root?.contains(event.target as Node)) { closeMore(false); statusOpen = false; }
 }
 function keys(event: KeyboardEvent) {
  if (event.key === 'Escape') {
   if (menuOpen) { event.preventDefault(); closeMore(); }
   else if (statusOpen) { event.preventDefault(); statusOpen = false; statusButton?.focus(); }
  }
  if (!menuOpen || !menu?.contains(event.target as Node) || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const buttons = Array.from(menu.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)'));
  if (!buttons.length) return;
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
   : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
  event.preventDefault(); buttons[next].focus();
 }
 onMount(() => {
  const observer = new ResizeObserver(measureLayout);
  observer.observe(root);
  if (measurements.firstElementChild) observer.observe(measurements.firstElementChild);
  const attributes = new MutationObserver(measureLayout);
  attributes.observe(document.documentElement, { attributes: true, attributeFilter: ['data-action-display', 'data-density'] });
  const densityScope = root.closest('[data-density]');
  if (densityScope && densityScope !== document.documentElement) attributes.observe(densityScope, { attributes: true, attributeFilter: ['data-density'] });
  measureLayout();
  return () => { observer.disconnect(); attributes.disconnect(); };
 });
 $effect(() => { orderedActions; busy; status; hasMore; void tick().then(measureLayout); });
 $effect(() => {
  if (!count) {
   if (root?.contains(document.activeElement)) restoreTrackFocus();
   closeMore(false);
  } else previousFocusTarget = findTrackTarget();
 });
 $effect(() => {
  if (!fit.showMore && menuOpen) {
   const ownsFocus = menu?.contains(document.activeElement) || document.activeElement === moreButton;
   closeMore(Boolean(ownsFocus));
  }
 });
 $effect(() => {
  const current = selected;
  if (menuOpen && (current.length !== previousSelection.length || current.some((item, index) => item !== previousSelection[index]))) closeMore(false);
  previousSelection = current;
 });
 $effect(() => {
  const active = remoteMenuActive === true;
  if (menuOpen && previousRemoteActive && !active) closeMore(true, false);
  previousRemoteActive = active;
 });
 $effect(() => { if (!status) statusOpen = false; });
</script>

<svelte:document onpointerdown={outside} onfocusin={outsideFocus} onkeydown={keys} />

<div class="track-selection-controls" bind:this={root} style:min-width={mandatoryWidth === null ? undefined : `${mandatoryWidth}px`}>
 <span class="selection-announcement" aria-live="polite" aria-atomic="true">{selectionDescription}</span>
 <div class="selection-buttons" class:selection-empty={count === 0} inert={count === 0}
  aria-hidden={count === 0} role="group" aria-label={groupLabel}>
  <div class="selection-tools" role="group" aria-label="Change selection">
   {#if busy && onCancel}
    <LibraryActionButton icon="cancel" label="Cancel" aria-label="Cancel remaining actions" onclick={onCancel} />
   {:else}
    <LibraryActionButton icon="all" label="All" aria-label={allLabel} title={allLabel}
     disabled={busy || visibleItems.length === 0 || visibleCount === visibleItems.length}
     onclick={() => selection.selectAll(visibleItems)} />
   {/if}
   <LibraryActionButton icon="clear" label="Clear" aria-label="Clear selection" disabled={busy || count === 0} onclick={clearSelection} />
  </div>
  <div class="selection-actions" role="group" aria-label="Actions for selection">
   {#each directActions as action (action.id)}
    <LibraryActionButton icon={action.id} label={action.label} disabled={busy || selected.length === 0 || action.disabled}
     aria-label={action.id === 'bookmark' ? 'Bookmark selected items' : action.label} onclick={() => runAction(action)} />
   {/each}
   {#if fit.showMore}
    <LibraryActionButton icon="more" label="More" class="selection-more-trigger" aria-label="More actions"
     aria-haspopup="menu" aria-expanded={menuOpen} bind:element={moreButton}
     disabled={busy || selected.length === 0 || (overflowActions.length === 0 && moreDisabled)} onclick={toggleMore} />
   {/if}
  </div>
 </div>
 {#if status && !floatingStatus}
  <button type="button" class="selection-status" bind:this={statusButton} aria-label={status}
   aria-expanded={statusOpen} title={status} onclick={() => { statusOpen = !statusOpen; closeMore(false); }}>{status}</button>
 {/if}
 {#if floatingStatus && status}<div class="selection-status-detail floating-status" role="status">{status}</div>
 {:else}<span class="selection-announcement" role="status">{status ?? ''}</span>{/if}
 {#if statusOpen && status && !floatingStatus}<div class="selection-status-detail">{status}</div>{/if}
 {#if menuOpen && count > 0}
  <div class="selection-more-menu" role="menu" aria-label="More actions for selection" tabindex="-1" bind:this={menu}>
   {#each overflowActions as action (action.id)}
    <button type="button" role="menuitem" disabled={busy || action.disabled} onclick={() => runAction(action)}>{action.label}</button>
   {/each}
   {#if hasMore && !moreDisabled && more}
    {#if overflowActions.length}<div class="selection-menu-divider" role="separator"></div>{/if}
    {@render more(selected, () => closeMore())}
   {/if}
  </div>
 {/if}
 <div class="selection-measurements" aria-hidden="true" inert bind:this={measurements}>
  <div class="selection-measurement-line">
  <span data-measure-tools>
   <LibraryActionButton icon={busy && onCancel ? 'cancel' : 'all'} label={busy && onCancel ? 'Cancel' : 'All'} />
   <LibraryActionButton icon="clear" label="Clear" />
  </span>
  {#each orderedActions as action (action.id)}<span data-measure-action><LibraryActionButton icon={action.id} label={action.label} /></span>{/each}
  <span data-measure-more><LibraryActionButton icon="more" label="More" /></span>
  </div>
 </div>
</div>

<style>
 .track-selection-controls {
  --selection-target-size:36px;
  display:flex; align-items:center; gap:8px; flex-wrap:nowrap;
  width:100%; min-width:calc(var(--selection-target-size) * 3 + 12px); height:var(--selection-target-size); flex-shrink:0;
  position:relative; font-size:12px;
 }
 :global([data-density="compact"]) .track-selection-controls { --selection-target-size:32px; }
 :global([data-density="pi"]) .track-selection-controls { --selection-target-size:44px; }
 .selection-buttons, .selection-tools, .selection-actions { display:flex; align-items:center; flex-wrap:nowrap; flex-shrink:0; }
 .selection-buttons { gap:12px; }
 .selection-empty { visibility:hidden; pointer-events:none; }
 .selection-status {
  flex:1; min-width:0; max-width:200px; overflow:hidden; text-overflow:ellipsis;
  border:0; padding:0; background:transparent; color:var(--songr-soft); font:inherit;
  white-space:nowrap; text-align:left; height:100%; cursor:pointer;
 }
 .selection-status:focus-visible { outline:2px solid var(--songr-accent); outline-offset:-2px; }
 .selection-more-menu, .selection-status-detail {
  position:absolute; right:0; top:calc(100% + 4px); z-index:120; width:max-content;
  min-width:min(180px, 100%); max-width:min(360px, 100%); box-sizing:border-box;
  max-height:min(320px, 50dvh); overflow:auto; padding:6px;
  border:1px solid var(--songr-line-strong); border-radius:8px; background:var(--songr-panel);
  box-shadow:0 6px 24px rgb(0 0 0 / .24); color:var(--songr-text);
 }
 .selection-more-menu :global(button[role="menuitem"]) {
  width:100%; display:block; border:0; border-radius:4px; padding:8px 12px;
  min-height:var(--selection-target-size); background:transparent; color:var(--songr-text);
  font:inherit; font-size:13px; text-align:left; white-space:normal; cursor:pointer;
 }
 .selection-more-menu :global(button[role="menuitem"]:hover:not(:disabled)) { background:var(--songr-hover-subtle); color:var(--songr-accent); }
 .selection-more-menu :global(button[role="menuitem"]:disabled) { opacity:.35; cursor:default; }
 .selection-more-menu :global(button[role="menuitem"]:focus-visible) { outline:2px solid var(--songr-accent); outline-offset:-2px; }
 .selection-status-detail { padding:10px 12px; overflow-wrap:anywhere; }
 .floating-status { pointer-events:none; }
 .selection-menu-divider { height:1px; margin:4px; background:var(--songr-line-strong); }
 .selection-measurements { display:flex; width:0; height:0; overflow:hidden; position:absolute; visibility:hidden; pointer-events:none; top:0; left:0; }
 .selection-measurement-line { display:flex; width:max-content; }
 .selection-measurement-line > span { display:inline-flex; flex:none; }
 .selection-announcement { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
 :global(button[data-track-select-target]) { appearance:none; -webkit-appearance:none; background:transparent; border:0; padding:0; margin:0; font:inherit; color:inherit; text-align:left; min-width:0; cursor:pointer; }
 :global(button[data-track-select-target]:disabled) { cursor:default; }
 :global(button[data-track-select-target]:focus-visible) { outline:2px solid var(--songr-accent); outline-offset:3px; }
 :global([data-track-select-row].is-track-selected button[data-track-select-target]) { color:var(--songr-accent); }
 :global([data-track-select-row].is-track-selected [data-track-select-target] .tnm),
 :global([data-track-select-row].is-track-selected [data-track-select-target] [data-track-select-title]) { color:var(--songr-accent); }
 :global([data-track-select-row].is-track-selected [data-track-select-target] .browse-secondary) { color:var(--songr-soft); }
 @media (hover:none), (any-pointer:coarse) {
  .track-selection-controls,
  :global([data-density="compact"]) .track-selection-controls { --selection-target-size:44px; }
 }
</style>
