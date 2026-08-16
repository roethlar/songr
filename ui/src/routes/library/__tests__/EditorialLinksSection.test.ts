import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/svelte';

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

	it('renders nothing without a ready view of the expected kind carrying links', () => {
		for (const editorial of [
			null,
			editorialState(),
			editorialState({
				phase: 'ready',
				view: { kind: 'artist', title: 'N', sections: {} }
			}),
			editorialState({
				phase: 'ready',
				view: { ...artistViewWithLinks([{ text: 'x', url: 'https://x.example/' }]), kind: 'album' }
			})
		]) {
			const { unmount } = render(EditorialLinksSection, {
				props: { editorial, testId: 'links' }
			});
			expect(screen.queryByTestId('links')).toBeNull();
			unmount();
		}
	});
});
