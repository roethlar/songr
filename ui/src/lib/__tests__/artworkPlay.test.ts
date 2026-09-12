import { afterEach, describe, expect, it, vi } from 'vitest';
import { artworkPlay, type ArtworkPlayOptions } from '../artworkPlay';

describe('artwork Play native release guard', () => {
 const cleanups: (() => void)[] = [];
 afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); document.body.replaceChildren(); vi.restoreAllMocks(); });
 function fixture() {
  const container = document.createElement('div');
  const artwork = document.createElement('div');
  const playButton = document.createElement('button');
  playButton.dataset.artworkPlay = '';
  container.append(artwork); artwork.append(playButton); document.body.append(container);
  let revealed = false;
  const play = vi.fn();
  const options: ArtworkPlayOptions = { generation: {}, disabled: false, revealed: () => revealed, reveal: value => revealed = value, play };
  const binding = artworkPlay(artwork, options);
  cleanups.push(binding.destroy);
  return { container, artwork, playButton, play, options, binding, revealed: () => revealed };
 }
 function pointer(target: Element, type: string, props: { id?: number; x?: number; y?: number; primary?: boolean; pointerType?: string; button?: number } = {}) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: props.x ?? 20, clientY: props.y ?? 20, button: props.button ?? 0 });
  Object.defineProperties(event, { pointerId: { value: props.id ?? 1 }, isPrimary: { value: props.primary ?? true }, pointerType: { value: props.pointerType ?? 'touch' } });
  target.dispatchEvent(event); return event;
 }
 function click(target: Element, detail = 1) { target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail })); }
 function tap(target: Element, pointerType = 'touch') { pointer(target, 'pointerdown', { pointerType }); pointer(target, 'pointerup', { pointerType }); click(target); }
 it('requires separate touch releases to reveal and then play the circular control', () => {
  const f = fixture();
  tap(f.artwork); expect(f.revealed()).toBe(true); expect(f.play).not.toHaveBeenCalled();
  tap(f.playButton); expect(f.play).toHaveBeenCalledTimes(1); expect(f.revealed()).toBe(false);
 });
 it('does not turn the first tap or its duplicate synthesized click into playback', () => {
  const f = fixture();
  pointer(f.playButton, 'pointerdown'); pointer(f.playButton, 'pointerup'); click(f.playButton, 0);
  expect(f.revealed()).toBe(true); expect(f.play).not.toHaveBeenCalled();
  click(f.playButton, 0); click(f.playButton); expect(f.play).not.toHaveBeenCalled();
 });
 it('a second touch on artwork outside the circle does not play', () => {
  const f = fixture(); tap(f.artwork); tap(f.artwork); expect(f.play).not.toHaveBeenCalled(); expect(f.revealed()).toBe(true);
 });
 it('mouse uses the circular Play control after a stationary native release', () => {
  const f = fixture(); tap(f.artwork, 'mouse'); expect(f.play).not.toHaveBeenCalled();
  pointer(f.playButton, 'pointerdown', { pointerType: 'mouse' }); expect(f.play).not.toHaveBeenCalled();
  pointer(f.playButton, 'pointerup', { pointerType: 'mouse' }); expect(f.play).not.toHaveBeenCalled();
  click(f.playButton); expect(f.play).toHaveBeenCalledTimes(1);
 });
 it('movement cancels a tap even after returning to its initial coordinates', () => {
  const f = fixture();
  expect(pointer(f.artwork, 'pointerdown').defaultPrevented).toBe(false);
  expect(pointer(f.artwork, 'pointermove', { y: 70 }).defaultPrevented).toBe(false);
  pointer(f.artwork, 'pointermove'); pointer(f.artwork, 'pointerup'); click(f.artwork);
  expect(f.revealed()).toBe(false); expect(f.play).not.toHaveBeenCalled();
 });
 it('rejects second-step swiping as well as first-step swiping', () => {
  const f = fixture(); tap(f.artwork);
  pointer(f.playButton, 'pointerdown'); pointer(f.playButton, 'pointermove', { y: 60 }); pointer(f.playButton, 'pointerup'); click(f.playButton);
  expect(f.play).not.toHaveBeenCalled();
 });
 it('rejects ancestor scroll changes even when no scroll event was delivered', () => {
  const f = fixture(); pointer(f.artwork, 'pointerdown'); f.container.scrollTop = 5; pointer(f.artwork, 'pointerup'); click(f.artwork);
  expect(f.revealed()).toBe(false); expect(f.play).not.toHaveBeenCalled();
 });
 it('rejects scrolling after release and taps that stop recent momentum', () => {
  let now = 1000; vi.spyOn(Date, 'now').mockImplementation(() => now);
  const f = fixture();
  pointer(f.artwork, 'pointerdown'); pointer(f.artwork, 'pointerup'); f.container.dispatchEvent(new Event('scroll')); click(f.artwork);
  expect(f.revealed()).toBe(false);
  now += 80; tap(f.artwork); expect(f.revealed()).toBe(false); expect(f.play).not.toHaveBeenCalled();
  now += 200; tap(f.artwork); expect(f.revealed()).toBe(true);
 });
 it('rejects extra contacts, pointer cancellation and non-primary buttons', () => {
  const f = fixture();
  pointer(f.artwork, 'pointerdown'); pointer(f.artwork, 'pointerdown', { id: 2, primary: false });
  pointer(f.artwork, 'pointerup', { id: 2 }); pointer(f.artwork, 'pointerup'); click(f.artwork); expect(f.revealed()).toBe(false);
  pointer(f.artwork, 'pointerdown'); pointer(f.artwork, 'pointercancel'); click(f.artwork); expect(f.revealed()).toBe(false);
  pointer(f.artwork, 'pointerdown', { button: 2 }); pointer(f.artwork, 'pointerup', { button: 2 }); click(f.artwork); expect(f.revealed()).toBe(false);
 });
 it('closes on outside touch and ignores stale generation or disabled releases', () => {
  const f = fixture(); tap(f.artwork); pointer(f.container, 'pointerdown'); expect(f.revealed()).toBe(false); pointer(f.container, 'pointerup');
  pointer(f.artwork, 'pointerdown'); pointer(f.artwork, 'pointerup'); f.binding.update({ ...f.options, generation: {} }); click(f.artwork); expect(f.revealed()).toBe(false);
  f.binding.update(f.options); tap(f.artwork); pointer(f.playButton, 'pointerdown'); f.binding.update({ ...f.options, disabled: true }); pointer(f.playButton, 'pointerup'); click(f.playButton); expect(f.play).not.toHaveBeenCalled();
 });
 it('supports native keyboard activation and prevents repeat key activation', () => {
  const f = fixture(); click(f.playButton, 0); expect(f.play).toHaveBeenCalledTimes(1);
  tap(f.artwork);
  f.playButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); click(f.playButton, 0); expect(f.play).toHaveBeenCalledTimes(2);
  const repeat = new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true, cancelable: true });
  f.playButton.dispatchEvent(repeat); expect(repeat.defaultPrevented).toBe(true);
 });
 it('blur discards pending activation and the revealed touch state', () => {
  const f = fixture(); tap(f.artwork); pointer(f.playButton, 'pointerdown'); window.dispatchEvent(new Event('blur')); pointer(f.playButton, 'pointerup'); click(f.playButton);
  expect(f.revealed()).toBe(false); expect(f.play).not.toHaveBeenCalled();
 });
});
