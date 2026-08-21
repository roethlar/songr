/**
 * App-wide Space shortcut: toggle play/pause on the selected zone.
 *
 * One window-level listener for the whole app, started by the layout next to
 * the media session binding and torn down with it. It sends the very same
 * command the on-screen transport button and the hardware media keys send —
 * `createSocketMediaTransport().playPause(zoneId)` — so there is exactly one
 * play/pause path in the UI, not a second one that could drift.
 *
 * The listener runs in the bubble phase on `window`, which is what makes the
 * guards below sufficient: anything closer to the user (a component that
 * handles Space itself) sees the event first, and its `preventDefault` tells
 * us to stand down.
 */
import { get } from 'svelte/store';
import { hasOpenModalSurface } from '$lib/actions/focusTrap';
import { selectedZoneStore } from '$lib/stores/selectedZoneStore';
import { createSocketMediaTransport } from './mediaSessionBinding';

/** Where Space types a character rather than meaning "play/pause". */
const EDITABLE_SELECTOR =
	'input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';

/**
 * Controls the platform already activates with Space. Hijacking those would
 * break the keyboard contract a focused button carries, so the focused control
 * keeps the key and the shortcut applies everywhere else.
 */
const SPACE_ACTIVATED_SELECTOR =
	'button, summary, a[href], [role="button"], [role="checkbox"], [role="switch"], ' +
	'[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], ' +
	'[role="option"], [role="radio"], [role="tab"]';

function isSpaceKey(event: KeyboardEvent): boolean {
	// "Spacebar" is the legacy name older engines still report.
	return event.key === ' ' || event.key === 'Spacebar';
}

function eventElement(event: KeyboardEvent): Element | null {
	if (event.target instanceof Element) return event.target;
	return typeof document !== 'undefined' ? document.activeElement : null;
}

function ownsTheKey(element: Element | null): boolean {
	if (!element) return false;
	// `closest` rather than a match on the target itself: a press inside a
	// contenteditable region, or on the icon inside a button, reports the
	// inner node as the target.
	if (element.closest(EDITABLE_SELECTOR) !== null) return true;
	return element.closest(SPACE_ACTIVATED_SELECTOR) !== null;
}

/**
 * Start listening for Space. Returns the teardown, which removes the listener.
 * A no-op without a window, which covers SSR.
 */
export function startSpacebarPlayPause(): () => void {
	if (typeof window === 'undefined') return () => {};

	const transport = createSocketMediaTransport();

	const handleKeydown = (event: KeyboardEvent): void => {
		if (!isSpaceKey(event)) return;
		// Held Space would fire a toggle per repeat and strobe the zone.
		if (event.repeat) return;
		// Someone nearer the event already acted on this press.
		if (event.defaultPrevented) return;
		// Ctrl/Cmd/Alt/Shift + Space belong to the browser and the OS.
		if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
		// A dialog or menu owns the keyboard while it is open.
		if (hasOpenModalSurface()) return;
		if (ownsTheKey(eventElement(event))) return;

		const zoneId = get(selectedZoneStore);
		if (!zoneId) return;

		// Only now, with the press actually handled, is it right to take the
		// key away from the page's own scroll/activate behaviour.
		event.preventDefault();
		transport.playPause(zoneId);
	};

	window.addEventListener('keydown', handleKeydown);
	return () => window.removeEventListener('keydown', handleKeydown);
}
