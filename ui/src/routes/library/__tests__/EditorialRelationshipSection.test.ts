import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';

import EditorialRelationshipSection from '../EditorialRelationshipSection.svelte';
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

function artistViewWithRelationships(): EditorialItemView {
	return {
		kind: 'artist',
		title: 'Nils Frahm',
		sections: {},
		relationshipGroups: [
			{
				label: 'Similar artists',
				items: [
					{ title: 'Olafur Arnalds', followTarget: 'bt-0' },
					{ title: 'Peter Broderick' }
				]
			},
			{
				label: 'Members',
				items: [{ title: 'Nonkeen', followTarget: 'bt-1' }]
			}
		]
	};
}

function renderSection(
	editorial: EditorialItemState | null,
	kind: 'album' | 'artist' = 'artist',
	onFollow = vi.fn()
) {
	const rendered = render(EditorialRelationshipSection, {
		props: { editorial, testId: 'related', onFollow, kind }
	});
	return { ...rendered, onFollow };
}

describe('EditorialRelationshipSection', () => {
	it('renders every group with rows in delivered order once expanded', async () => {
		renderSection(
			editorialState({ phase: 'ready', view: artistViewWithRelationships() })
		);
		// Three rows exceed the collapsed two-row reservation (q1-1): the
		// rest arrive through the user-initiated "Show all".
		await fireEvent.click(screen.getByTestId('related-toggle'));
		const section = screen.getByTestId('related');
		expect(
			[...section.querySelectorAll('h3')].map((heading) => heading.textContent)
		).toEqual(['Similar artists', 'Members']);
		const rows = screen.getByTestId('related-group-0').querySelectorAll('.row');
		expect([...rows].map((row) => row.textContent?.trim())).toEqual([
			'Olafur Arnalds',
			'Peter Broderick'
		]);
		// Only rows carrying a follow target render as navigation.
		expect(rows[0].querySelector('button')).not.toBeNull();
		expect(rows[1].querySelector('button')).toBeNull();
	});

	it('hides a failed row thumbnail in place, keeping the slot geometry (q2-3)', async () => {
		const view: EditorialItemView = {
			kind: 'artist',
			title: 'Nils Frahm',
			sections: {},
			relationshipGroups: [
				{
					label: 'Similar artists',
					items: [{ title: 'Olafur Arnalds', artworkKey: 'stale-key' }]
				}
			]
		};
		renderSection(editorialState({ phase: 'ready', view }));
		const thumb = screen.getByTestId('related-art-0-0') as HTMLImageElement;
		expect(thumb.style.visibility).toBe('');
		await fireEvent.error(thumb);
		// The img stays in the layout (its 32px flex slot is unchanged);
		// only its pixels hide, revealing the placeholder tile background.
		expect(thumb.style.visibility).toBe('hidden');
		expect(screen.getByTestId('related-group-0').contains(thumb)).toBe(true);
	});

	it('collapses past the reserved row count and expands on demand (q1-1)', async () => {
		renderSection(
			editorialState({ phase: 'ready', view: artistViewWithRelationships() })
		);
		// Collapsed: exactly the reserved two rows of the first group, in
		// the same fixed box the skeleton held.
		const section = screen.getByTestId('related');
		expect(section).toHaveClass('slot');
		expect(section.querySelectorAll('.row')).toHaveLength(2);
		expect(screen.queryByTestId('related-group-1')).toBeNull();
		const toggle = screen.getByTestId('related-toggle');
		expect(toggle).toHaveTextContent('Show all 3');
		// Expansion is user-initiated and may grow.
		await fireEvent.click(toggle);
		expect(screen.getByTestId('related')).not.toHaveClass('slot');
		expect(screen.getByTestId('related-group-1')).toBeInTheDocument();
		expect(screen.getByTestId('related-toggle')).toHaveTextContent('Show less');
	});

	it('pins the expansion toggle outside the clipped region when the first family has one row (cc-3)', () => {
		// The collapsed clip preserves group boundaries: a 1-row first
		// family pulls a SECOND group heading into the clipped area, so a
		// toggle living inside the overflow-hidden region falls below the
		// fixed slot's visible area — invisible and unclickable.
		renderSection(
			editorialState({
				phase: 'ready',
				view: {
					kind: 'artist',
					title: 'Nils Frahm',
					sections: {},
					relationshipGroups: [
						{ label: 'Members', items: [{ title: 'Nonkeen', followTarget: 'bt-1' }] },
						{
							label: 'Similar artists',
							items: [
								{ title: 'Olafur Arnalds', followTarget: 'bt-0' },
								{ title: 'Peter Broderick' }
							]
						}
					]
				}
			})
		);
		const section = screen.getByTestId('related');
		expect(section).toHaveClass('slot');
		const clip = section.querySelector('.clip');
		expect(clip).not.toBeNull();
		// Both group headings render inside the clip (the shape that used
		// to push the toggle out of view).
		expect(clip?.querySelectorAll('h3')).toHaveLength(2);
		const toggle = screen.getByTestId('related-toggle');
		// The toggle is pinned OUTSIDE the clip: the fixed slot's overflow
		// can never cover it.
		expect(clip?.contains(toggle)).toBe(false);
		expect(toggle.parentElement).toBe(section);
		// The remaining rows are reachable: the toggle still expands.
		expect(toggle).toHaveTextContent('Show all 3');
	});

	it('reserves the identical fixed-height slot in skeleton and collapsed states (q1-1)', () => {
		const { unmount } = renderSection(editorialState({ phase: 'opening' }));
		expect(screen.getByTestId('related-skeleton')).toHaveClass('slot');
		unmount();

		renderSection(
			editorialState({ phase: 'ready', view: artistViewWithRelationships() })
		);
		expect(screen.getByTestId('related')).toHaveClass('slot');
	});

	it('keeps the reserved slot with an honest empty state when the ready view has no groups (q1-1)', () => {
		renderSection(
			editorialState({
				phase: 'ready',
				view: { kind: 'artist', title: 'Nils Frahm', sections: {} }
			})
		);
		const empty = screen.getByTestId('related-empty');
		expect(empty).toHaveTextContent('No related artists available.');
		expect(empty).toHaveClass('slot');
		expect(screen.queryByTestId('related')).toBeNull();
		expect(screen.queryByTestId('related-skeleton')).toBeNull();
	});

	it('renders the album empty state for an album view without groups', () => {
		renderSection(
			editorialState({
				phase: 'ready',
				view: { kind: 'album', title: 'Melody', sections: {} }
			}),
			'album'
		);
		expect(screen.getByTestId('related-empty')).toHaveTextContent(
			'No similar albums available.'
		);
	});

	it('invokes the follow callback with the exact opaque target', async () => {
		const { onFollow } = renderSection(
			editorialState({ phase: 'ready', view: artistViewWithRelationships() })
		);
		// The second group's row sits past the collapsed reservation.
		await fireEvent.click(screen.getByTestId('related-toggle'));
		await fireEvent.click(screen.getByTestId('related-follow-1-0'));
		expect(onFollow).toHaveBeenCalledTimes(1);
		expect(onFollow).toHaveBeenCalledWith('bt-1');
	});

	it('renders nothing without a ready view of the expected kind', () => {
		for (const [editorial, kind] of [
			[null, 'artist'],
			// Idle — no open initiated or no live socket — renders nothing
			// (q1-2): no skeleton without a positively issued open.
			[editorialState(), 'artist'],
			[editorialState({ phase: 'unavailable', code: 'FEATURE_UNAVAILABLE' }), 'artist'],
			[editorialState({ phase: 'canceled' }), 'artist'],
			[
				// An artist view must never feed an album-kind section.
				editorialState({ phase: 'ready', view: artistViewWithRelationships() }),
				'album'
			]
		] as const) {
			const { unmount } = renderSection(editorial, kind);
			expect(screen.queryByTestId('related')).toBeNull();
			expect(screen.queryByTestId('related-skeleton')).toBeNull();
			expect(screen.queryByTestId('related-empty')).toBeNull();
			unmount();
		}
	});

	it('reserves a skeleton slot only while an open is in flight (R3, q1-2)', () => {
		const { unmount } = renderSection(editorialState({ phase: 'opening' }));
		expect(screen.getByTestId('related-skeleton')).toBeInTheDocument();
		expect(screen.queryByTestId('related')).toBeNull();
		unmount();
	});

	it('keeps the reserved slot with a quiet failure note when the read fails after the open (cc-1)', () => {
		renderSection(
			editorialState({
				phase: 'failed',
				sessionId: 'sess-1',
				code: 'ITEM_NOT_FOUND',
				retryable: false,
				error: 'The item could not be resolved.'
			})
		);
		const failed = screen.getByTestId('related-failed');
		// The open reserved the box, so the terminal state keeps it — the
		// grid below must never snap back up (q1-1 on the failure path).
		expect(failed).toHaveClass('slot');
		expect(failed).toHaveTextContent('Related artists could not be loaded.');
		expect(screen.queryByTestId('related-skeleton')).toBeNull();
	});

	it('keeps the reserved slot with an honest absence when the feature vanishes mid-session (cc-1)', () => {
		renderSection(
			editorialState({
				phase: 'unavailable',
				sessionId: 'sess-1',
				code: 'FEATURE_UNAVAILABLE'
			})
		);
		const empty = screen.getByTestId('related-empty');
		expect(empty).toHaveClass('slot');
		expect(empty).toHaveTextContent('No related artists available.');
	});

	it('renders album similar-albums rows with subtitles', () => {
		renderSection(
			editorialState({
				phase: 'ready',
				view: {
					kind: 'album',
					title: 'Melody',
					sections: {},
					relationshipGroups: [
						{
							label: 'Similar albums',
							items: [
								{ title: 'Spaces', subtitle: 'Nils Frahm', followTarget: 'bt-2' }
							]
						}
					]
				}
			}),
			'album'
		);
		const row = screen.getByTestId('related-group-0').querySelector('.row');
		expect(row?.textContent?.trim().replace(/\s+/g, ' ')).toBe('Spaces Nils Frahm');
	});

	it('renders row thumbnails only where the row carries an artwork key', () => {
		renderSection(
			editorialState({
				phase: 'ready',
				view: {
					kind: 'album',
					title: 'Melody',
					sections: {},
					relationshipGroups: [
						{
							label: 'Similar albums',
							items: [
								{ title: 'Spaces', subtitle: 'Nils Frahm', artworkKey: 'row-img-1' },
								{ title: 'Felt', subtitle: 'Nils Frahm' }
							]
						}
					]
				}
			}),
			'album'
		);
		const image = screen.getByTestId('related-art-0-0') as HTMLImageElement;
		expect(image.getAttribute('src')).toBe('/api/image/row-img-1?scale=fit&width=64&height=64');
		// Honest absence: a row with no key renders no image slot at all.
		expect(screen.queryByTestId('related-art-0-1')).toBeNull();
	});
});
