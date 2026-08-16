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

	it('renders nothing while idle, opening, unavailable, or honestly absent', () => {
		for (const editorial of [
			null,
			editorialState(),
			editorialState({ phase: 'opening' }),
			editorialState({ phase: 'unavailable', code: 'FEATURE_UNAVAILABLE' }),
			editorialState({ phase: 'ready', view: albumView({ sections: {} }) })
		]) {
			const { unmount } = renderSection(editorial);
			expect(screen.queryByTestId('editorial-review')).toBeNull();
			expect(screen.queryByTestId('editorial-review-failed')).toBeNull();
			unmount();
		}
	});

	it('collapses long prose and expands on demand', async () => {
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
		const shown = screen.getByTestId('editorial-review-text').textContent ?? '';
		expect(shown.length).toBeLessThan(longText.length);
		expect(shown.endsWith('…')).toBe(true);
		await fireEvent.click(screen.getByTestId('editorial-review-toggle'));
		expect(screen.getByTestId('editorial-review-text').textContent).toBe(longText);
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

	it('stays silent on non-retryable and foreign-section failures', () => {
		for (const editorial of [
			editorialState({ phase: 'failed', code: 'INVALID_RESPONSE', retryable: false }),
			editorialState({
				phase: 'failed',
				code: 'READ_TIMEOUT',
				retryable: true,
				section: 'biography'
			})
		]) {
			const { unmount } = renderSection(editorial);
			expect(screen.queryByTestId('editorial-review-failed')).toBeNull();
			unmount();
		}
	});
});
