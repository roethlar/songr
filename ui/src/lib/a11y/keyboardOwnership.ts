/**
 * One answer to "does this element eat the keystroke?", shared by every
 * app-wide keyboard shortcut.
 *
 * The app has two window-level keyboard captures — the Space play/pause
 * shortcut (`$lib/media/spacebarPlayPause`) and the library's type-to-open
 * palette capture (`routes/library/UnifiedLibraryMode.svelte`) — and both
 * must stand down for the same set of elements. They used to answer the
 * question with two independently written guards, and the two drifted: the
 * Space guard learned that a range slider is not a text field (songr #16),
 * the palette guard did not, so after touching the volume slider typing
 * stopped opening the palette and library type-to-search went dead until the
 * user clicked away. One predicate, two callers, no second copy to forget.
 */

/**
 * Where a printable keystroke becomes text in the element rather than a
 * command to the app.
 *
 * `input:not([type="range"])` rather than a bare `input`: a range slider (the
 * volume control) keeps focus after a drag the way native sliders do, but no
 * printable key types into it or moves it — range inputs are adjusted with
 * the arrow keys, which this predicate deliberately says nothing about — so
 * treating it as a text field just swallows the shortcut with no effect.
 */
const EDITABLE_SELECTOR =
	'input:not([type="range"]), textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';

/**
 * True when typed text belongs to `element` (or to an editable ancestor of
 * it) rather than to the app.
 *
 * `closest` rather than a match on the element itself: a press inside a
 * contenteditable region reports the inner node as the target, and
 * `isContentEditable` catches the inherited-editability cases the attribute
 * selector alone would miss.
 */
export function swallowsTypedText(element: Element | null): boolean {
	if (!element) return false;
	if (element.closest(EDITABLE_SELECTOR) !== null) return true;
	return element instanceof HTMLElement && element.isContentEditable;
}
