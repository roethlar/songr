import { effectivePresentationStore } from '$lib/stores/presentationSettingsStore';

export interface ScrollingArtistHeadingsOptions {
	enabled: boolean;
	revision: unknown;
	layoutRevision?: unknown;
}

// One active name across retained views; no observers/listeners per artist.
const readers = new WeakMap<Document, () => void>();
const NAME = 'button[data-artist-name]';

export function scrollingArtistHeadings(root: HTMLElement, initial: ScrollingArtistHeadingsOptions) {
	let options = initial;
	const doc = root.ownerDocument;
	let active: HTMLButtonElement | null = null;
	let animation: Animation | null = null;
	let popup: HTMLDivElement | null = null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let serial = 0;
	let motion: boolean | undefined;
	let lastScroll = -Infinity;
	let keyboard = false;
	let pointerSequence = false;
	const pointers = new Set<number>();
	type Attempt = { id: number; button: HTMLButtonElement; x: number; y: number;
		canceled: boolean; revision: unknown; scroll: { node: Element; top: number; left: number }[] };
	let attempt: Attempt | undefined;
	let released: Attempt | false | undefined;
	const nameAt = (target: EventTarget | null): HTMLButtonElement | null => {
		const button = target instanceof Element ? target.closest<HTMLButtonElement>(NAME) : null;
		return button && root.contains(button) ? button : null;
	};
	const visible = (button: HTMLButtonElement) => options.enabled && button.isConnected &&
		!button.closest('[data-retained-library-panel][aria-hidden="true"]');
	const valid = (value: Attempt) => visible(value.button) && value.revision === options.revision &&
		value.scroll.every(entry => entry.node.scrollTop === entry.top && entry.node.scrollLeft === entry.left);
	const moved = (value: Attempt, event: PointerEvent) => Math.hypot(value.x - event.clientX, value.y - event.clientY) > 8;

	function stop(): void {
		serial++;
		clearTimeout(timer);
		animation?.cancel(); animation = null;
		popup?.remove(); popup = null;
		if (active) { active.removeAttribute('data-reading'); active.setAttribute('aria-pressed', 'false'); }
		active = null;
		if (readers.get(doc) === stop) readers.delete(doc);
	}
	function cancel(): void {
		if (attempt) attempt.canceled = true;
		released = false;
		stop();
	}
	function showFullName(button: HTMLButtonElement, text: HTMLElement): void {
		popup = doc.createElement('div');
		popup.className = 'album-artist-name-popup';
		popup.setAttribute('aria-hidden', 'true'); // The button already exposes the complete name.
		popup.textContent = text.textContent;
		popup.setAttribute('popover', 'manual');
		button.parentElement!.append(popup);
		const rect = button.getBoundingClientRect();
		const viewport = doc.documentElement.clientWidth;
		popup.style.width = `${Math.min(rect.width, viewport - 16)}px`;
		popup.style.left = `${Math.max(8, Math.min(rect.left, viewport - rect.width - 8))}px`;
		popup.style.top = `${rect.bottom + 6}px`;
		popup.showPopover?.();
		const height = popup.getBoundingClientRect().height;
		if (rect.bottom + 6 + height > doc.documentElement.clientHeight - 8)
			popup.style.top = `${Math.max(8, rect.top - height - 6)}px`;
	}
	function start(button: HTMLButtonElement): void {
		if (active === button || !visible(button)) return;
		stop();
		const text = button.querySelector<HTMLElement>('[data-artist-name-text]');
		if (!text) return;
		const distance = text.scrollWidth - button.clientWidth;
		if (distance <= 1) return;
		readers.get(doc)?.();
		readers.set(doc, stop);
		active = button;
		button.setAttribute('aria-pressed', 'true');
		if (!motion || typeof text.animate !== 'function') { showFullName(button, text); return; }
		button.setAttribute('data-reading', '');
		const token = serial;
		const cycle = (): void => {
			if (token !== serial) return;
			if (!visible(button)) { stop(); return; }
			animation?.cancel();
			animation = text.animate([{ transform: 'translateX(0)' }, { transform: `translateX(-${distance}px)` }],
				{ duration: distance / 24 * 1000, delay: 700, easing: 'linear', fill: 'both' });
			animation.finished.then(() => {
				if (token === serial) timer = setTimeout(cycle, 1400);
			}).catch(() => {}); // Canceling a Web Animation rejects its finished promise.
		};
		cycle();
	}
	function over(event: PointerEvent): void {
		const button = nameAt(event.target);
		if (event.pointerType === 'touch' || !button ||
			(event.relatedTarget instanceof Node && button.contains(event.relatedTarget))) return;
		start(button);
	}
	function out(event: PointerEvent): void {
		if (event.pointerType !== 'touch' && active && nameAt(event.target) === active &&
			!(event.relatedTarget instanceof Node && active.contains(event.relatedTarget))) stop();
	}
	function down(event: PointerEvent): void {
		keyboard = false; pointerSequence = true; pointers.add(event.pointerId);
		const button = nameAt(event.target);
		if (!button) { cancel(); attempt = undefined; return; }
		if (pointers.size > 1 || event.isPrimary === false) cancel();
		released = false;
		const scroll: Attempt['scroll'] = [];
		for (let parent: Element | null = button; parent; parent = parent.parentElement)
			scroll.push({ node: parent, top: parent.scrollTop, left: parent.scrollLeft });
		attempt = { id: event.pointerId, button, x: event.clientX, y: event.clientY, revision: options.revision, scroll,
			canceled: !visible(button) || event.button !== 0 || event.isPrimary === false || pointers.size > 1 || Date.now() - lastScroll < 180 };
	}
	function move(event: PointerEvent): void {
		if (attempt?.id === event.pointerId && moved(attempt, event)) cancel();
	}
	function up(event: PointerEvent): void {
		if (attempt?.id === event.pointerId) {
			released = !attempt.canceled && !moved(attempt, event) && valid(attempt) && nameAt(event.target) === attempt.button ? attempt : false;
			attempt = undefined;
		}
		pointers.delete(event.pointerId);
	}
	function canceled(event: PointerEvent): void { pointers.delete(event.pointerId); cancel(); attempt = undefined; }
	function scroll(event: Event): void {
		if (popup && event.target instanceof Node && popup.contains(event.target)) return;
		lastScroll = Date.now(); cancel();
	}
	function blur(): void { pointers.clear(); attempt = undefined; cancel(); }
	function keydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') { cancel(); return; }
		if (nameAt(event.target) && (event.key === 'Enter' || event.key === ' ')) {
			if (event.repeat) event.preventDefault();
			else { keyboard = true; released = undefined; }
		}
	}
	function click(event: MouseEvent): void {
		const button = nameAt(event.target);
		if (!button) return;
		const release = released; released = undefined;
		if (release ? !valid(release) || release.button !== button
			: release === false || attempt || (pointerSequence && !keyboard) || (event.detail !== 0 && !keyboard)) return;
		keyboard = false;
		if (active === button) stop(); else start(button);
	}
	function focusout(event: FocusEvent): void {
		if (active && nameAt(event.target) === active && !(event.relatedTarget instanceof Node && active.contains(event.relatedTarget))) cancel();
	}
	const unsubscribe = effectivePresentationStore.subscribe(settings => {
		if (motion !== undefined && motion !== settings.interfaceMotion) cancel();
		motion = settings.interfaceMotion;
	});
	root.addEventListener('pointerover', over);
	root.addEventListener('pointerout', out);
	root.addEventListener('click', click);
	root.addEventListener('focusout', focusout);
	doc.addEventListener('pointerdown', down, { capture: true, passive: true });
	doc.addEventListener('pointermove', move, { capture: true, passive: true });
	doc.addEventListener('pointerup', up, { capture: true, passive: true });
	doc.addEventListener('pointercancel', canceled, { capture: true, passive: true });
	doc.addEventListener('scroll', scroll, { capture: true, passive: true });
	doc.addEventListener('keydown', keydown, true);
	doc.defaultView?.addEventListener('blur', blur);
	doc.defaultView?.addEventListener('resize', cancel);
	return {
		update(next: ScrollingArtistHeadingsOptions): void {
			if (options.enabled !== next.enabled || options.revision !== next.revision || options.layoutRevision !== next.layoutRevision) cancel();
			options = next;
		},
		destroy(): void {
			cancel(); unsubscribe();
			root.removeEventListener('pointerover', over); root.removeEventListener('pointerout', out);
			root.removeEventListener('click', click); root.removeEventListener('focusout', focusout);
			doc.removeEventListener('pointerdown', down, true); doc.removeEventListener('pointermove', move, true);
			doc.removeEventListener('pointerup', up, true); doc.removeEventListener('pointercancel', canceled, true);
			doc.removeEventListener('scroll', scroll, true); doc.removeEventListener('keydown', keydown, true);
			doc.defaultView?.removeEventListener('blur', blur); doc.defaultView?.removeEventListener('resize', cancel);
		}
	};
}
