/** Native release guard for artwork reveal/Play. Never captures pointers or prevents scrolling. */
export interface ArtworkPlayOptions {
 generation: unknown;
 disabled: boolean;
 revealed: () => boolean;
 reveal: (value: boolean) => void;
 play: () => void;
}
export function artworkPlay(node: HTMLElement, initial: ArtworkPlayOptions) {
 let options = initial;
 const doc = node.ownerDocument;
 let lastScroll = -Infinity;
 let revision = 0;
 let keyboard = false;
 let pointerSequence = false;
 const pointers = new Set<number>();
 type Attempt = { id: number; x: number; y: number; touch: boolean; revealed: boolean; playTarget: boolean;
  canceled: boolean; generation: unknown; revision: number; scroll: { node: Element; top: number; left: number }[] };
 let attempt: Attempt | undefined;
 let released: Attempt | false | undefined;
 const now = () => Date.now();
 const inside = (target: EventTarget | null) => target instanceof Node && node.contains(target);
 const playTarget = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest('[data-artwork-play]'));
 const moved = (value: Attempt, event: PointerEvent) => Math.hypot(value.x - event.clientX, value.y - event.clientY) > 8;
 const scrollValid = (value: Attempt) => value.scroll.every(entry => entry.node.scrollTop === entry.top && entry.node.scrollLeft === entry.left);
 const current = (value: Attempt) => !options.disabled && value.generation === options.generation && value.revision === revision && scrollValid(value);
 function cancel() { revision++; if (attempt) attempt.canceled = true; released = false; options.reveal(false); }
 function down(event: PointerEvent) {
  keyboard = false;
  pointerSequence = true;
  if (inside(event.target)) node.classList.toggle('touch-interaction', event.pointerType === 'touch');
  pointers.add(event.pointerId);
  if (pointers.size > 1 || event.isPrimary === false) cancel();
  if (!inside(event.target)) { cancel(); return; }
  released = false;
  const scroll: Attempt['scroll'] = [];
  for (let parent: Element | null = node; parent; parent = parent.parentElement) scroll.push({ node: parent, top: parent.scrollTop, left: parent.scrollLeft });
  attempt = { id: event.pointerId, x: event.clientX, y: event.clientY, touch: event.pointerType === 'touch',
   revealed: options.revealed(), playTarget: playTarget(event.target), generation: options.generation, revision, scroll,
   canceled: options.disabled || event.button !== 0 || event.isPrimary === false || pointers.size > 1 || now() - lastScroll < 180 };
 }
 function move(event: PointerEvent) { if (event.pointerType === 'mouse') node.classList.remove('touch-interaction'); if (attempt?.id === event.pointerId && moved(attempt, event)) attempt.canceled = true; }
 function up(event: PointerEvent) {
  if (attempt?.id === event.pointerId) {
   released = !attempt.canceled && !moved(attempt, event) && current(attempt) && inside(event.target) ? attempt : false;
   attempt = undefined;
  }
  pointers.delete(event.pointerId);
 }
 function canceled(event: PointerEvent) { pointers.delete(event.pointerId); cancel(); attempt = undefined; }
 function scroll() { lastScroll = now(); cancel(); }
 function blur() { pointers.clear(); attempt = undefined; cancel(); }
 function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { cancel(); return; }
  if ((event.key === 'Enter' || event.key === ' ') && playTarget(event.target)) {
   if (event.repeat) event.preventDefault(); else { keyboard = true; released = undefined; }
  }
 }
 function click(event: MouseEvent) {
  if (options.disabled) return;
  const release = released;
  released = undefined;
  // A synthesized click from touch must consume its original release, including
  // detail=0: it cannot become keyboard activation or play on the revealing tap.
  if (release) {
   if (!current(release)) return;
   if (release.touch && !release.revealed) { options.reveal(true); return; }
   if (release.playTarget && playTarget(event.target)) { options.reveal(false); options.play(); }
   return;
  }
  if (release === false || attempt || (pointerSequence && !keyboard) || (event.detail !== 0 && !keyboard)) return;
  if (playTarget(event.target)) { keyboard = false; options.reveal(false); options.play(); }
 }
 doc.addEventListener('pointerdown', down, { capture: true, passive: true });
 doc.addEventListener('pointermove', move, { capture: true, passive: true });
 doc.addEventListener('pointerup', up, { capture: true, passive: true });
 doc.addEventListener('pointercancel', canceled, { capture: true, passive: true });
 doc.addEventListener('scroll', scroll, { capture: true, passive: true });
 doc.addEventListener('keydown', keydown, true);
 doc.defaultView?.addEventListener('blur', blur);
 node.addEventListener('click', click);
 return {
  update(next: ArtworkPlayOptions) { if (next.generation !== options.generation || next.disabled !== options.disabled) cancel(); options = next; },
  destroy() {
   doc.removeEventListener('pointerdown', down, true); doc.removeEventListener('pointermove', move, true);
   doc.removeEventListener('pointerup', up, true); doc.removeEventListener('pointercancel', canceled, true);
   doc.removeEventListener('scroll', scroll, true); doc.removeEventListener('keydown', keydown, true);
   doc.defaultView?.removeEventListener('blur', blur); node.removeEventListener('click', click);
  }
 };
}
