import { effectivePresentationStore } from '$lib/stores/presentationSettingsStore';

/** Magnify glyphs only: button hit areas and the library pane never move. */
export function magnifyingAlphabetRail(rail: HTMLElement, _revision: unknown) {
	const host = rail.ownerDocument.defaultView;
	// Magnification is optional when the host cannot report pointer capability.
	if (!host || typeof host.matchMedia !== 'function') return { update() {}, destroy() {} };
	const view = host;
	const finePointer = view.matchMedia('(any-hover: hover) and (any-pointer: fine)');
	let motion = false;
	let pointer: { x: number; y: number } | null = null;
	let frame = 0;
	const glyphs = () => [...rail.querySelectorAll<HTMLElement>('.rail-letter')];

	function clear(): void {
		pointer = null;
		view.cancelAnimationFrame(frame);
		frame = 0;
		for (const glyph of glyphs()) glyph.style.removeProperty('--rail-scale');
	}
	function paint(): void {
		frame = 0;
		if (!pointer || !motion || !finePointer.matches) return;
		// Read the small index before writing transforms; never inspect the list.
		const items = glyphs().map(glyph => ({ glyph, rect: glyph.parentElement!.getBoundingClientRect() }));
		for (const { glyph, rect } of items) {
			const distance = Math.hypot((pointer.y - rect.y - rect.height / 2) / rect.height,
				(pointer.x - rect.x - rect.width / 2) / rect.width);
			const scale = 1 + 0.3 * (1 + Math.cos(Math.PI * Math.min(distance / 2.5, 1)));
			glyph.style.setProperty('--rail-scale', scale.toFixed(3));
		}
	}
	function move(event: PointerEvent): void {
		if (event.pointerType === 'touch' || !motion || !finePointer.matches) { clear(); return; }
		pointer = { x: event.clientX, y: event.clientY };
		if (!frame) frame = view.requestAnimationFrame(paint);
	}
	function preferenceChanged(): void {
		rail.toggleAttribute('data-rail-motion', motion && finePointer.matches);
		clear();
	}
	const unsubscribe = effectivePresentationStore.subscribe(settings => {
		motion = settings.interfaceMotion;
		preferenceChanged();
	});
	finePointer.addEventListener('change', preferenceChanged);
	rail.addEventListener('pointermove', move, { passive: true });
	rail.addEventListener('pointerleave', clear);
	rail.addEventListener('pointercancel', clear);
	rail.addEventListener('scroll', clear, { passive: true });
	rail.addEventListener('keydown', clear);
	view.addEventListener('blur', clear);
	return {
		update(_next: unknown): void { clear(); },
		destroy(): void {
			unsubscribe(); clear();
			finePointer.removeEventListener('change', preferenceChanged);
			rail.removeEventListener('pointermove', move);
			rail.removeEventListener('pointerleave', clear);
			rail.removeEventListener('pointercancel', clear);
			rail.removeEventListener('scroll', clear);
			rail.removeEventListener('keydown', clear);
			view.removeEventListener('blur', clear);
			rail.removeAttribute('data-rail-motion');
		}
	};
}
