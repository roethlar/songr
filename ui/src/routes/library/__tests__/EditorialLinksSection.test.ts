import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';

import EditorialLinksSection from '../EditorialLinksSection.svelte';
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

function artistViewWithLinks(links: EditorialItemView['links']): EditorialItemView {
	return { kind: 'artist', title: 'Nils Frahm', sections: {}, links };
}

describe('EditorialLinksSection', () => {
	it('renders safe destinations as new-tab links', () => {
		render(EditorialLinksSection, {
			props: {
				editorial: editorialState({
					phase: 'ready',
					view: artistViewWithLinks([
						{ text: 'en.wikipedia.org', url: 'https://en.wikipedia.org/wiki/X' }
					])
				}),
				testId: 'links'
			}
		});
		const link = screen.getByTestId('links-link-0');
		expect(link.tagName).toBe('A');
		expect(link.getAttribute('href')).toBe('https://en.wikipedia.org/wiki/X');
		expect(link.getAttribute('rel')).toBe('noopener noreferrer');
		expect(link.getAttribute('target')).toBe('_blank');
	});

	it('renders an unsafe destination as plain text', () => {
		render(EditorialLinksSection, {
			props: {
				editorial: editorialState({
					phase: 'ready',
					// The contract already rejects this; the section stays safe
					// even if a malformed row ever reached it.
					view: artistViewWithLinks([
						{ text: 'somewhere', url: 'javascript:alert(1)' } as never
					])
				}),
				testId: 'links'
			}
		});
		const row = screen.getByTestId('links-link-0');
		expect(row.tagName).toBe('SPAN');
		expect(row.textContent?.trim()).toBe('somewhere');
	});

	it('renders nothing without a ready view of the expected kind', () => {
		for (const editorial of [
			null,
			// Idle — no open initiated or no live socket — renders nothing
			// (q1-2): no skeleton without a positively issued open.
			editorialState(),
			editorialState({ phase: 'unavailable', code: 'FEATURE_UNAVAILABLE' }),
			editorialState({ phase: 'canceled' }),
			editorialState({
				phase: 'ready',
				view: { ...artistViewWithLinks([{ text: 'x', url: 'https://x.example/' }]), kind: 'album' }
			})
		]) {
			const { unmount } = render(EditorialLinksSection, {
				props: { editorial, testId: 'links' }
			});
			expect(screen.queryByTestId('links')).toBeNull();
			expect(screen.queryByTestId('links-skeleton')).toBeNull();
			expect(screen.queryByTestId('links-empty')).toBeNull();
			unmount();
		}
	});

	it('reserves a skeleton slot only while an open is in flight (R3, q1-2)', () => {
		const { unmount } = render(EditorialLinksSection, {
			props: { editorial: editorialState({ phase: 'opening' }), testId: 'links' }
		});
		expect(screen.getByTestId('links-skeleton')).toBeInTheDocument();
		expect(screen.queryByTestId('links')).toBeNull();
		unmount();
	});

	it('keeps the reserved slot with a quiet failure note when the read fails after the open (cc-1)', () => {
		render(EditorialLinksSection, {
			props: {
				editorial: editorialState({
					phase: 'failed',
					sessionId: 'sess-1',
					code: 'ITEM_NOT_FOUND',
					retryable: false,
					error: 'The item could not be resolved.'
				}),
				testId: 'links'
			}
		});
		const failed = screen.getByTestId('links-failed');
		// The open reserved the box, so the terminal state keeps it — the
		// grid below must never snap back up (q1-1 on the failure path).
		expect(failed).toHaveClass('slot');
		expect(failed).toHaveTextContent('Links could not be loaded.');
		expect(screen.queryByTestId('links-skeleton')).toBeNull();
	});

	it('keeps the reserved slot with an honest absence when the feature vanishes mid-session (cc-1)', () => {
		render(EditorialLinksSection, {
			props: {
				editorial: editorialState({
					phase: 'unavailable',
					sessionId: 'sess-1',
					code: 'FEATURE_UNAVAILABLE'
				}),
				testId: 'links'
			}
		});
		const empty = screen.getByTestId('links-empty');
		expect(empty).toHaveClass('slot');
		expect(empty).toHaveTextContent('No links available.');
	});

	it('collapses past the reserved link count and expands on demand (q1-1)', async () => {
		render(EditorialLinksSection, {
			props: {
				editorial: editorialState({
					phase: 'ready',
					view: artistViewWithLinks([
						{ text: 'en.wikipedia.org', url: 'https://en.wikipedia.org/wiki/X' },
						{ text: 'discogs.com', url: 'https://www.discogs.com/artist/1' },
						{ text: 'musicbrainz.org', url: 'https://musicbrainz.org/artist/2' }
					])
				}),
				testId: 'links'
			}
		});
		// Collapsed: exactly the reserved two links, in the same fixed box
		// the skeleton held.
		const section = screen.getByTestId('links');
		expect(section).toHaveClass('slot');
		expect(section.querySelectorAll('li')).toHaveLength(2);
		expect(screen.queryByTestId('links-link-2')).toBeNull();
		const toggle = screen.getByTestId('links-toggle');
		expect(toggle).toHaveTextContent('Show all 3');
		// Expansion is user-initiated and may grow.
		await fireEvent.click(toggle);
		expect(screen.getByTestId('links')).not.toHaveClass('slot');
		expect(screen.getByTestId('links-link-2')).toBeInTheDocument();
		expect(screen.getByTestId('links-toggle')).toHaveTextContent('Show less');
	});

	it('reserves the identical fixed-height slot in skeleton and collapsed states (q1-1)', () => {
		const { unmount } = render(EditorialLinksSection, {
			props: { editorial: editorialState({ phase: 'opening' }), testId: 'links' }
		});
		expect(screen.getByTestId('links-skeleton')).toHaveClass('slot');
		unmount();

		render(EditorialLinksSection, {
			props: {
				editorial: editorialState({
					phase: 'ready',
					view: artistViewWithLinks([
						{ text: 'en.wikipedia.org', url: 'https://en.wikipedia.org/wiki/X' }
					])
				}),
				testId: 'links'
			}
		});
		expect(screen.getByTestId('links')).toHaveClass('slot');
	});

	it('keeps the reserved slot with an honest empty state when the ready view has no links (q1-1)', () => {
		render(EditorialLinksSection, {
			props: {
				editorial: editorialState({
					phase: 'ready',
					view: { kind: 'artist', title: 'Nils Frahm', sections: {} }
				}),
				testId: 'links'
			}
		});
		const empty = screen.getByTestId('links-empty');
		expect(empty).toHaveTextContent('No links available.');
		expect(empty).toHaveClass('slot');
		expect(screen.queryByTestId('links')).toBeNull();
		expect(screen.queryByTestId('links-skeleton')).toBeNull();
	});
});
