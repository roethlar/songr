import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';

import EditorialCreditsSection from '../EditorialCreditsSection.svelte';
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

function albumViewWithCredits(): EditorialItemView {
	return {
		kind: 'album',
		title: 'Melody',
		subtitle: 'Nils Frahm',
		sections: {},
		creditGroups: [
			{
				label: 'Album',
				credits: [
					{ role: 'Producer', name: 'Nils Frahm', followTarget: 'bt-0' },
					{ role: 'Engineer', name: 'Olaf Otto Becker', followTarget: 'bt-1' },
					{ role: 'Artwork', name: 'Anonymous Hand' }
				]
			}
		]
	};
}

function renderSection(editorial: EditorialItemState | null, onFollow = vi.fn()) {
	const rendered = render(EditorialCreditsSection, {
		props: { editorial, testId: 'credits', onFollow }
	});
	return { ...rendered, onFollow };
}

describe('EditorialCreditsSection', () => {
	it('renders the credit rows in exact order with verbatim roles', () => {
		renderSection(editorialState({ phase: 'ready', view: albumViewWithCredits() }));
		const rows = screen.getByTestId('credits-group-0').querySelectorAll('.credit-row');
		expect([...rows].map((row) => row.textContent?.trim().replace(/\s+/g, ' '))).toEqual([
			'Producer Nils Frahm',
			'Engineer Olaf Otto Becker',
			'Artwork Anonymous Hand'
		]);
		// Only rows carrying a follow target render as navigation.
		expect(rows[0].querySelector('button')).not.toBeNull();
		expect(rows[2].querySelector('button')).toBeNull();
	});

	it('invokes the follow callback with the exact opaque target', async () => {
		const { onFollow } = renderSection(
			editorialState({ phase: 'ready', view: albumViewWithCredits() })
		);
		await fireEvent.click(screen.getByTestId('credits-follow-0-1'));
		expect(onFollow).toHaveBeenCalledTimes(1);
		expect(onFollow).toHaveBeenCalledWith('bt-1');
	});

	it('renders nothing without a ready album view carrying credits', () => {
		for (const editorial of [
			null,
			editorialState(),
			editorialState({ phase: 'ready', view: { kind: 'album', title: 'M', sections: {} } }),
			editorialState({
				phase: 'ready',
				// A followed performer view must never re-show album credits.
				view: { ...albumViewWithCredits(), kind: 'artist' }
			})
		]) {
			const { unmount } = renderSection(editorial);
			expect(screen.queryByTestId('credits')).toBeNull();
			unmount();
		}
	});

	it('keeps the role label for a single-role track group', () => {
		render(EditorialCreditsSection, {
			props: {
				editorial: editorialState({
					phase: 'ready',
					view: {
						kind: 'track',
						title: 'T',
						sections: {},
						creditGroups: [
							{ label: 'Composer', credits: [{ role: '', name: 'Björk' }] }
						]
					}
				}),
				testId: 'credits',
				onFollow: vi.fn(),
				kind: 'track'
			}
		});
		// The group label carries the role meaning (ri5-3): one group must
		// not hide it.
		expect(screen.getByTestId('credits').querySelector('h4')?.textContent).toBe('Composer');
	});

	it('keeps retained credits rendered through a scoped failure', () => {
		// A section-scoped failure event flips the phase while the retained
		// view still carries valid credits (ri4-2): they must stay visible.
		renderSection(
			editorialState({
				phase: 'failed',
				view: albumViewWithCredits(),
				code: 'INVALID_RESPONSE',
				section: 'review'
			})
		);
		expect(
			screen.getByTestId('credits-group-0').querySelectorAll('.credit-row')
		).toHaveLength(3);
	});
});
