import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';

import EditorialTextSection from '../EditorialTextSection.svelte';
import type { EditorialItemState } from '$lib/library/EditorialItemController';
import type { EditorialItemView } from '@shared/editorialItemContracts';

function editorialState(overrides: Partial<EditorialItemState> = {}): EditorialItemState {
	return {
		phase: 'idle',
		requestId: null,
		sessionId: null,
		generation: null,
		view: null,
		code: null,
		section: null,
		retryable: false,
		error: null,
		...overrides
	};
}

function albumView(overrides: Partial<EditorialItemView> = {}): EditorialItemView {
	return {
		kind: 'album',
		title: 'Melody',
		subtitle: 'Nils Frahm',
		sections: {
			review: {
				text: 'A quiet, patient record.',
				source: 'AllMusic',
				language: 'en'
			}
		},
		attribution: [{ text: 'AllMusic', url: 'https://example.com/review' }],
		...overrides
	};
}

function renderSection(editorial: EditorialItemState | null, onRetry = vi.fn()) {
	const rendered = render(EditorialTextSection, {
		props: {
			heading: 'Review',
			section: 'review',
			editorial,
			testId: 'editorial-review',
			onRetry
		}
	});
	return { ...rendered, onRetry };
}

describe('EditorialTextSection', () => {
	it('renders the prose and a safe attribution link when ready', () => {
		renderSection(editorialState({ phase: 'ready', view: albumView() }));
		expect(screen.getByTestId('editorial-review-text').textContent).toBe(
			'A quiet, patient record.'
		);
		const link = screen.getByTestId('editorial-review-attribution').querySelector('a');
		expect(link?.getAttribute('href')).toBe('https://example.com/review');
		expect(link?.getAttribute('rel')).toContain('noopener');
	});

	it('renders an unsafe attribution destination as plain text', () => {
		renderSection(
			editorialState({
				phase: 'ready',
				view: albumView({
					// eslint-disable-next-line no-script-url
					attribution: [{ text: 'Somewhere', url: 'javascript:alert(1)' }]
				})
			})
		);
		const attribution = screen.getByTestId('editorial-review-attribution');
		expect(attribution.querySelector('a')).toBeNull();
		expect(attribution.textContent).toContain('Somewhere');
	});

	it('renders nothing while idle, unavailable, or canceled', () => {
		for (const editorial of [
			null,
			// Idle — no open initiated or no live socket — renders nothing
			// (q1-2): no skeleton without a positively issued open.
			editorialState(),
			editorialState({ phase: 'unavailable', code: 'FEATURE_UNAVAILABLE' }),
			editorialState({ phase: 'canceled' })
		]) {
			const { unmount } = renderSection(editorial);
			expect(screen.queryByTestId('editorial-review')).toBeNull();
			expect(screen.queryByTestId('editorial-review-failed')).toBeNull();
			expect(screen.queryByTestId('editorial-review-skeleton')).toBeNull();
			expect(screen.queryByTestId('editorial-review-empty')).toBeNull();
			unmount();
		}
	});

	it('keeps the reserved slot with an honest empty state when the ready view has no prose (q1-1)', () => {
		renderSection(editorialState({ phase: 'ready', view: albumView({ sections: {} }) }));
		const empty = screen.getByTestId('editorial-review-empty');
		expect(empty).toHaveTextContent('No review available.');
		expect(empty).toHaveClass('slot');
		expect(screen.queryByTestId('editorial-review')).toBeNull();
		expect(screen.queryByTestId('editorial-review-skeleton')).toBeNull();
	});

	it('reserves the identical fixed-height slot in skeleton and collapsed states (q1-1)', async () => {
		// Skeleton: the fixed box is reserved from first paint.
		const { unmount } = renderSection(editorialState({ phase: 'opening' }));
		expect(screen.getByTestId('editorial-review-skeleton')).toHaveClass('slot');
		unmount();

		// Resolved collapsed: the same fixed box replaces it, so the page
		// below does not move.
		const longText = `${'Patient phrases repeat and evolve. '.repeat(40)}The final cadence.`;
		renderSection(
			editorialState({
				phase: 'ready',
				view: albumView({
					sections: { review: { text: longText, source: 'AllMusic', language: 'en' } }
				})
			})
		);
		const resolved = screen.getByTestId('editorial-review');
		expect(resolved).toHaveClass('slot');
		expect(screen.getByTestId('editorial-review-text')).toHaveClass('clamped');

		// Only the user-initiated expansion may grow: the slot class drops.
		await fireEvent.click(screen.getByTestId('editorial-review-toggle'));
		expect(screen.getByTestId('editorial-review')).not.toHaveClass('slot');
		expect(screen.getByTestId('editorial-review-text')).not.toHaveClass('clamped');
	});

	it('reserves a skeleton slot only while an open is in flight (R3, q1-2)', () => {
		const { unmount } = renderSection(editorialState({ phase: 'opening' }));
		expect(screen.getByTestId('editorial-review-skeleton')).toBeInTheDocument();
		expect(screen.queryByTestId('editorial-review')).toBeNull();
		expect(screen.queryByTestId('editorial-review-failed')).toBeNull();
		unmount();
	});

	it('renders Roon [Name](id) markup as plain display text with no id anywhere', () => {
		renderSection(
			editorialState({
				phase: 'ready',
				view: albumView({
					sections: {
						review: {
							text: 'Produced by [Brian Eno](1234567) at [Soho Studio](7654321).',
							source: 'AllMusic',
							language: 'en'
						}
					}
				})
			})
		);
		const section = screen.getByTestId('editorial-review');
		expect(screen.getByTestId('editorial-review-text').textContent).toBe(
			'Produced by Brian Eno at Soho Studio.'
		);
		expect(section.textContent).not.toContain('[');
		expect(section.textContent).not.toContain('1234567');
		expect(section.textContent).not.toContain('7654321');
		expect(section.querySelector('a[href*="1234567"]')).toBeNull();
	});

	it('renders malformed markup fail-closed: no id token, no partial run (q1-3)', () => {
		const text = 'An [unclosed run, an empty []() pair, and [[Nested]](9) stay.';
		renderSection(
			editorialState({
				phase: 'ready',
				view: albumView({
					sections: { review: { text, source: 'AllMusic', language: 'en' } }
				})
			})
		);
		const section = screen.getByTestId('editorial-review');
		expect(screen.getByTestId('editorial-review-text').textContent).toBe(
			'An [unclosed run, an empty  pair, and Nested stay.'
		);
		expect(section.textContent).not.toContain('(9)');
		expect(section.querySelector('a[href*="9"]')).toBeNull();
	});

	it('clamps long prose to the fixed slot and expands on demand', async () => {
		const longText = `${'Patient phrases repeat and evolve. '.repeat(40)}The final cadence.`;
		renderSection(
			editorialState({
				phase: 'ready',
				view: albumView({
					sections: {
						review: { text: longText, source: 'AllMusic', language: 'en' }
					}
				})
			})
		);
		// Collapsed: the full text is in the DOM but line-clamped into the
		// fixed slot (q1-1); the toggle offers the user-initiated expansion.
		const text = screen.getByTestId('editorial-review-text');
		expect(text.textContent).toBe(longText);
		expect(text).toHaveClass('clamped');
		expect(screen.getByTestId('editorial-review')).toHaveClass('slot');
		const toggle = screen.getByTestId('editorial-review-toggle');
		expect(toggle).toHaveTextContent('Read more');
		await fireEvent.click(toggle);
		expect(screen.getByTestId('editorial-review-text')).not.toHaveClass('clamped');
		expect(screen.getByTestId('editorial-review')).not.toHaveClass('slot');
		expect(screen.getByTestId('editorial-review-toggle')).toHaveTextContent('Show less');
	});

	it('offers no collapse toggle for short prose and never clamps it (cc-4)', () => {
		renderSection(editorialState({ phase: 'ready', view: albumView() }));
		expect(screen.queryByTestId('editorial-review-toggle')).toBeNull();
		// The clamp without a toggle would hide overflow text on narrow
		// containers with no reveal path (cc-4): short prose renders
		// unclamped. The fixed slot geometry is unaffected — unclamped
		// short prose is SHORTER than the reserved box (q1-1).
		expect(screen.getByTestId('editorial-review-text')).not.toHaveClass('clamped');
		expect(screen.getByTestId('editorial-review')).toHaveClass('slot');
	});

	it('offers retry for a retryable failure and invokes the callback', async () => {
		const { onRetry } = renderSection(
			editorialState({
				phase: 'failed',
				code: 'READ_TIMEOUT',
				retryable: true,
				error: 'The editorial read did not answer in time.'
			})
		);
		await fireEvent.click(screen.getByTestId('editorial-review-retry'));
		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it('stays silent on a foreign-section failure', () => {
		const { unmount } = renderSection(
			editorialState({
				phase: 'failed',
				code: 'READ_TIMEOUT',
				retryable: true,
				section: 'biography'
			})
		);
		expect(screen.queryByTestId('editorial-review-failed')).toBeNull();
		unmount();
	});

	it('keeps the reserved slot with a quiet failure note on a non-retryable failure (cc-1)', () => {
		for (const editorial of [
			// The read failed after the session was established (failed event,
			// e.g. a stale snapshot after a profile switch).
			editorialState({
				phase: 'failed',
				sessionId: 'sess-1',
				code: 'ITEM_NOT_FOUND',
				retryable: false,
				error: 'The item could not be resolved.'
			}),
			// The open acknowledgment itself was malformed — the slot was
			// still reserved for the round trip.
			editorialState({ phase: 'failed', code: 'INVALID_RESPONSE', retryable: false })
		]) {
			const { unmount } = renderSection(editorial);
			const failed = screen.getByTestId('editorial-review-failed');
			// The open reserved the box, so the terminal state keeps it — the
			// grid below must never snap back up (q1-1 on the failure path).
			expect(failed).toHaveClass('slot');
			expect(failed).toHaveTextContent('This section could not be loaded.');
			// Non-retryable: no retry affordance.
			expect(screen.queryByTestId('editorial-review-retry')).toBeNull();
			unmount();
		}
	});

	it('keeps the reserved slot with an honest absence when the feature vanishes mid-session (cc-1)', () => {
		// FEATURE_UNAVAILABLE arriving as a failed EVENT (session established,
		// sessionId present) is not the feature-absent gate of q1-2: the open
		// succeeded, so the reserved slot stays with the empty-state wording.
		renderSection(
			editorialState({
				phase: 'unavailable',
				sessionId: 'sess-1',
				code: 'FEATURE_UNAVAILABLE'
			})
		);
		const empty = screen.getByTestId('editorial-review-empty');
		expect(empty).toHaveClass('slot');
		expect(empty).toHaveTextContent('No review available.');
		expect(screen.queryByTestId('editorial-review-skeleton')).toBeNull();
	});
});
