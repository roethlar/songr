/**
 * Svelte action: modal focus management for a dialog element that is
 * mounted while open and destroyed on close ({#if}-rendered).
 *
 * - Moves focus into the dialog on mount: the `initialFocus` selector
 *   match if given, else the first focusable, else the node itself.
 * - Keeps Tab / Shift+Tab cycling inside the dialog. The focusable
 *   list is rebuilt per keydown because enable/disable state can
 *   change while the dialog is open.
 * - Restores focus to the previously-focused element on destroy.
 *   Callers with semantic restoration targets can opt out and restore after
 *   their replacement subtree has mounted.
 *
 * Escape handling stays with the caller — closing is the dialog's
 * decision, not the trap's.
 */
const MODAL_SURFACE_SELECTOR = '[aria-modal="true"], dialog[open]';

export function isTopModalOwner(node: HTMLElement): boolean {
	const owner = node.matches(MODAL_SURFACE_SELECTOR)
		? node
		: node.closest<HTMLElement>(MODAL_SURFACE_SELECTOR);
	if (!owner) return true;
	const activeModal = document.activeElement instanceof Element
		? document.activeElement.closest<HTMLElement>(MODAL_SURFACE_SELECTOR)
		: null;
	if (activeModal?.isConnected) return activeModal === owner;
	const modalSurfaces = Array.from(
		document.querySelectorAll<HTMLElement>(MODAL_SURFACE_SELECTOR)
	).filter((surface) => surface.isConnected);
	return modalSurfaces.at(-1) === owner;
}

export function focusTrap(
	node: HTMLElement,
	options: { initialFocus?: string; restoreFocus?: boolean } = {}
): { destroy(): void } {
	const previouslyFocused = document.activeElement as HTMLElement | null;

	const getFocusable = (): HTMLElement[] => {
		const selector =
			'button, [href], input, select, textarea, [tabindex]';
		return Array.from(node.querySelectorAll<HTMLElement>(selector)).filter(
			(element) =>
				element.tabIndex >= 0 &&
				!(element instanceof HTMLButtonElement && element.disabled) &&
				!(element instanceof HTMLInputElement && element.disabled) &&
				!(element instanceof HTMLSelectElement && element.disabled) &&
				!(element instanceof HTMLTextAreaElement && element.disabled) &&
				element.closest('[inert]') === null
		);
	};

	const handleKeydown = (e: KeyboardEvent) => {
		if (e.key !== 'Tab' || !isTopModalOwner(node)) return;
		const focusables = getFocusable();
		if (focusables.length === 0) {
			e.preventDefault();
			node.focus();
			return;
		}
		const first = focusables[0];
		const last = focusables[focusables.length - 1];
		const active = document.activeElement as HTMLElement | null;
		if (e.shiftKey && active === first) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && active === last) {
			e.preventDefault();
			first.focus();
		} else if (active && !node.contains(active)) {
			// Focus escaped the dialog (e.g. external script) — pull it back.
			e.preventDefault();
			first.focus();
		}
	};

	const initial = options.initialFocus
		? node.querySelector<HTMLElement>(options.initialFocus)
		: null;
	(initial ?? getFocusable()[0] ?? node).focus();

	window.addEventListener('keydown', handleKeydown);

	return {
		destroy() {
			window.removeEventListener('keydown', handleKeydown);
			if (
				options.restoreFocus !== false &&
				previouslyFocused &&
				document.body.contains(previouslyFocused)
			) {
				previouslyFocused.focus();
			}
		}
	};
}
