import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scrollingArtistHeadings } from '../scrollingArtistHeadings';
import { presentationSettingsStore } from '../stores/presentationSettingsStore';
import { DEFAULT_PRESENTATION_SETTINGS } from '@shared/presentationSettings';

describe('scrolling artist heading interaction', () => {
	const cleanups: (() => void)[] = [];
	beforeEach(() => {
		vi.useFakeTimers();
		presentationSettingsStore.reset();
		presentationSettingsStore.applySnapshot(DEFAULT_PRESENTATION_SETTINGS);
	});
	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) cleanup();
		document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks();
		presentationSettingsStore.reset();
	});
	function fixture(overflow = 240) {
		const root = document.createElement('div');
		const heading = document.createElement('h2');
		const button = document.createElement('button'); button.dataset.artistName = ''; button.setAttribute('aria-pressed', 'false');
		const text = document.createElement('span'); text.dataset.artistNameText = ''; text.textContent = 'Long complete artist credit';
		button.append(text); heading.append(button); root.append(heading); document.body.append(root);
		Object.defineProperty(button, 'clientWidth', { value: 100 });
		Object.defineProperty(text, 'scrollWidth', { value: 100 + overflow });
		const animations: { cancel: ReturnType<typeof vi.fn>; finish: () => void }[] = [];
		const animate = vi.fn(() => {
			let finish!: () => void;
			const finished = new Promise<void>(resolve => { finish = resolve; });
			const cancel = vi.fn(); animations.push({ cancel, finish });
			return { cancel, finished } as unknown as Animation;
		});
		text.animate = animate;
		const options = { enabled: true, revision: {} };
		const binding = scrollingArtistHeadings(root, options);
		cleanups.push(binding.destroy);
		return { root, button, text, animate, animations, binding, options };
	}
	function pointer(target: Element, type: string, values: { x?: number; y?: number; id?: number; primary?: boolean; pointerType?: string } = {}) {
		const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: values.x ?? 20, clientY: values.y ?? 20 });
		Object.defineProperties(event, { pointerId: { value: values.id ?? 1 },
			isPrimary: { value: values.primary ?? true }, pointerType: { value: values.pointerType ?? 'touch' } });
		target.dispatchEvent(event); return event;
	}
	function click(target: Element, detail = 1) { target.dispatchEvent(new MouseEvent('click', { bubbles: true, detail })); }
	function tap(target: Element) { pointer(target, 'pointerdown'); pointer(target, 'pointerup'); click(target); }
	function hover(target: Element) { pointer(target, 'pointerover', { pointerType: 'mouse' }); }

	it('scrolls at constant reading speed with start/end pauses and resets on hover exit', async () => {
		const f = fixture(); hover(f.button);
		expect(f.animate).toHaveBeenCalledWith([{ transform: 'translateX(0)' }, { transform: 'translateX(-240px)' }],
			{ duration: 10000, delay: 700, easing: 'linear', fill: 'both' });
		expect(f.button).toHaveAttribute('aria-pressed', 'true');
		f.animations[0].finish(); await Promise.resolve();
		await vi.advanceTimersByTimeAsync(1399); expect(f.animate).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1); expect(f.animate).toHaveBeenCalledTimes(2);
		pointer(f.button, 'pointerout', { pointerType: 'mouse' });
		expect(f.button).not.toHaveAttribute('data-reading');
		expect(f.button).toHaveAttribute('aria-pressed', 'false');
		expect(f.animations[1].cancel).toHaveBeenCalled();
	});
	it('does not animate fitting names and allows only one name to move', () => {
		const short = fixture(0); hover(short.button); expect(short.animate).not.toHaveBeenCalled();
		const first = fixture(), second = fixture(); hover(first.button); hover(second.button);
		expect(first.button).toHaveAttribute('aria-pressed', 'false');
		expect(first.animations[0].cancel).toHaveBeenCalled();
		expect(second.button).toHaveAttribute('aria-pressed', 'true');
	});
	it('touch requires a stationary release and a second tap stops; duplicate clicks do not restart', () => {
		const f = fixture(); pointer(f.button, 'pointerover'); expect(f.animate).not.toHaveBeenCalled();
		pointer(f.button, 'pointerdown'); expect(f.animate).not.toHaveBeenCalled();
		pointer(f.button, 'pointerup'); click(f.button, 0); expect(f.animate).toHaveBeenCalledTimes(1);
		tap(f.button); expect(f.button).toHaveAttribute('aria-pressed', 'false');
		click(f.button, 0); expect(f.animate).toHaveBeenCalledTimes(1);
	});
	it('rejects moved, canceled and multi-touch gestures without blocking native scrolling', () => {
		const f = fixture();
		expect(pointer(f.button, 'pointerdown').defaultPrevented).toBe(false);
		expect(pointer(f.button, 'pointermove', { y: 70 }).defaultPrevented).toBe(false);
		pointer(f.button, 'pointermove'); pointer(f.button, 'pointerup'); click(f.button);
		expect(f.animate).not.toHaveBeenCalled();
		pointer(f.button, 'pointerdown'); pointer(f.button, 'pointercancel'); click(f.button);
		pointer(f.button, 'pointerdown'); pointer(f.button, 'pointerdown', { id: 2, primary: false });
		pointer(f.button, 'pointerup', { id: 2 }); pointer(f.button, 'pointerup'); click(f.button);
		expect(f.animate).not.toHaveBeenCalled();
	});
	it('rejects silent ancestor scroll changes, post-release scroll and momentum-stopping taps', () => {
		const f = fixture(); pointer(f.button, 'pointerdown'); f.root.scrollTop = 10; pointer(f.button, 'pointerup'); click(f.button);
		expect(f.animate).not.toHaveBeenCalled();
		pointer(f.button, 'pointerdown'); pointer(f.button, 'pointerup'); f.root.dispatchEvent(new Event('scroll')); click(f.button);
		vi.advanceTimersByTime(80); tap(f.button); expect(f.animate).not.toHaveBeenCalled();
		vi.advanceTimersByTime(181); tap(f.button); expect(f.animate).toHaveBeenCalledTimes(1);
		f.root.dispatchEvent(new Event('scroll')); expect(f.button).toHaveAttribute('aria-pressed', 'false');
	});
	it('supports keyboard activation and Escape without repeated activation', () => {
		const f = fixture(); click(f.button, 0); expect(f.animate).toHaveBeenCalledTimes(1);
		f.button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		expect(f.button).toHaveAttribute('aria-pressed', 'false');
		f.button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); click(f.button, 0);
		expect(f.animate).toHaveBeenCalledTimes(2);
		const repeat = new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true, cancelable: true });
		f.button.dispatchEvent(repeat); expect(repeat.defaultPrevented).toBe(true);
	});
	it('stops and discards stale releases on outside input, revision, layout, disabled state and focus loss', () => {
		const f = fixture(); tap(f.button); pointer(document.body, 'pointerdown'); pointer(document.body, 'pointerup');
		expect(f.button).toHaveAttribute('aria-pressed', 'false');
		pointer(f.button, 'pointerdown'); pointer(f.button, 'pointerup');
		f.binding.update({ ...f.options, revision: {} }); click(f.button); expect(f.animate).toHaveBeenCalledTimes(1);
		tap(f.button); f.binding.update({ ...f.options, layoutRevision: 'compact' }); expect(f.button).not.toHaveAttribute('data-reading');
		tap(f.button); window.dispatchEvent(new Event('blur')); expect(f.button).not.toHaveAttribute('data-reading');
		tap(f.button); f.button.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); expect(f.button).not.toHaveAttribute('data-reading');
		f.binding.update({ ...f.options, enabled: false }); tap(f.button); expect(f.button).not.toHaveAttribute('data-reading');
	});
	it('honors motion changes with a static complete-name popup and cleans up on destruction', () => {
		const f = fixture(); tap(f.button);
		presentationSettingsStore.applySnapshot({ ...DEFAULT_PRESENTATION_SETTINGS, revision: 1, interfaceMotion: false });
		expect(f.button).not.toHaveAttribute('data-reading');
		tap(f.button); expect(f.animate).toHaveBeenCalledTimes(1);
		expect(f.root.querySelector('.album-artist-name-popup')).toHaveTextContent(f.text.textContent!);
		f.binding.destroy(); expect(f.root.querySelector('.album-artist-name-popup')).toBeNull();
		hover(f.button); expect(f.animate).toHaveBeenCalledTimes(1);
	});
});
