import { effectivePresentationStore } from '$lib/stores/presentationSettingsStore';

export interface OverflowMarqueeOptions {
	/** The complete text, shown stationary when interface motion is off. */
	text: string;
	/**
	 * The box holds controls (the play bar's artist buttons). Without motion,
	 * the stationary reveal then repeats the whole track so every control,
	 * including those cut off at rest, can be clicked from it.
	 */
	actionable?: boolean;
	/** Changing content (a new track) stops any reading in progress. */
	revision: unknown;
}

// The reading pace and pauses of the Library's scrolling artist headings
// (`scrollingArtistHeadings.ts`), so moving text reads the same everywhere.
const PIXELS_PER_SECOND = 24;
const START_DELAY_MS = 700;
const END_PAUSE_MS = 1400;

/**
 * A single-line box whose content may be cut off (the play bar's title and
 * artist credit, #23). At rest the box shows one trailing ellipsis. Pointer
 * hover (not touch) or keyboard focus inside it reveals the whole content:
 * with interface motion, `[data-marquee-track]` scrolls at reading pace to its
 * end, pauses, and starts again; without motion (the app setting or the OS
 * preference), the complete text appears stationary just above the box.
 * Clicks and activation inside the box are never intercepted.
 */
export function overflowMarquee(node: HTMLElement, initial: OverflowMarqueeOptions) {
	let options = initial;
	const doc = node.ownerDocument;
	let animation: Animation | null = null;
	let popup: HTMLDivElement | null = null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let serial = 0;
	let motion = true;

	function stop(): void {
		serial++;
		clearTimeout(timer);
		animation?.cancel();
		animation = null;
		popup?.remove();
		popup = null;
		delete node.dataset.reading;
	}

	function showFullText(): void {
		popup = doc.createElement('div');
		popup.className = 'overflow-marquee-full-text';
		// The box already exposes the complete text and its controls to
		// assistive technology and the keyboard; this is the pointer's view.
		popup.setAttribute('aria-hidden', 'true');
		const track = node.querySelector<HTMLElement>('[data-marquee-track]');
		if (options.actionable && track) {
			const copy = track.cloneNode(true) as HTMLElement;
			copy.removeAttribute('data-marquee-track');
			const originals = [...track.querySelectorAll<HTMLElement>('button, a[href]')];
			const copies = [...copy.querySelectorAll<HTMLElement>('button, a[href]')];
			copies.forEach((control, index) => {
				control.tabIndex = -1;
				// A pointer press must not move focus into the reveal: removing a
				// focused element mid-click disrupts the forwarded activation.
				control.addEventListener('mousedown', event => event.preventDefault());
				control.addEventListener('click', event => {
					event.preventDefault();
					originals[index]?.click();
					stop();
				});
			});
			popup.append(copy);
		} else {
			popup.textContent = options.text;
		}
		popup.setAttribute('popover', 'manual');
		// Inside the box, so moving the pointer onto it is not leaving the box.
		node.append(popup);
		const rect = node.getBoundingClientRect();
		const viewport = doc.documentElement.clientWidth;
		const width = Math.min(Math.max(rect.width, 260), viewport - 16);
		popup.style.width = `${width}px`;
		popup.style.left = `${Math.max(8, Math.min(rect.left, viewport - width - 8))}px`;
		popup.showPopover?.();
		const height = popup.getBoundingClientRect().height;
		// Flush against the box (1px overlap): no gap for the pointer to cross.
		popup.style.top = `${Math.max(8, rect.top - height + 1)}px`;
	}

	function start(): void {
		if (node.dataset.reading !== undefined || popup) return;
		const track = node.querySelector<HTMLElement>('[data-marquee-track]');
		if (!track) return;
		// Measured with the track laid out whole (see the reading styles).
		node.dataset.reading = '';
		const distance = track.scrollWidth - node.clientWidth;
		if (distance <= 1) {
			delete node.dataset.reading;
			return;
		}
		if (!motion || typeof track.animate !== 'function') {
			delete node.dataset.reading;
			showFullText();
			return;
		}
		const token = serial;
		const cycle = (): void => {
			if (token !== serial || !node.isConnected) return;
			animation?.cancel();
			animation = track.animate(
				[{ transform: 'translateX(0)' }, { transform: `translateX(-${distance}px)` }],
				{ duration: (distance / PIXELS_PER_SECOND) * 1000, delay: START_DELAY_MS, easing: 'linear', fill: 'both' }
			);
			animation.finished
				.then(() => {
					if (token === serial) timer = setTimeout(cycle, END_PAUSE_MS);
				})
				.catch(() => {}); // Canceling a Web Animation rejects its finished promise.
		};
		cycle();
	}

	const enter = (event: PointerEvent) => {
		if (event.pointerType !== 'touch') start();
	};
	const leave = (event: PointerEvent) => {
		if (event.pointerType !== 'touch' && !node.contains(doc.activeElement)) stop();
	};
	const focusin = () => start();
	const focusout = (event: FocusEvent) => {
		if (!(event.relatedTarget instanceof Node && node.contains(event.relatedTarget)) && !node.matches(':hover')) stop();
	};
	const keydown = (event: KeyboardEvent) => {
		if (event.key === 'Escape') stop();
	};

	const unsubscribe = effectivePresentationStore.subscribe((settings) => {
		if (settings.interfaceMotion !== motion) stop();
		motion = settings.interfaceMotion;
	});
	node.addEventListener('pointerenter', enter);
	node.addEventListener('pointerleave', leave);
	node.addEventListener('focusin', focusin);
	node.addEventListener('focusout', focusout);
	node.addEventListener('keydown', keydown);
	doc.defaultView?.addEventListener('resize', stop);

	return {
		update(next: OverflowMarqueeOptions): void {
			if (next.revision !== options.revision || next.text !== options.text) stop();
			options = next;
		},
		destroy(): void {
			stop();
			unsubscribe();
			node.removeEventListener('pointerenter', enter);
			node.removeEventListener('pointerleave', leave);
			node.removeEventListener('focusin', focusin);
			node.removeEventListener('focusout', focusout);
			node.removeEventListener('keydown', keydown);
			doc.defaultView?.removeEventListener('resize', stop);
		}
	};
}
