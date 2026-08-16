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
	it('renders every group with rows in delivered order', () => {
		renderSection(
			editorialState({ phase: 'ready', view: artistViewWithRelationships() })
		);
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

	it('invokes the follow callback with the exact opaque target', async () => {
		const { onFollow } = renderSection(
			editorialState({ phase: 'ready', view: artistViewWithRelationships() })
		);
		await fireEvent.click(screen.getByTestId('related-follow-1-0'));
		expect(onFollow).toHaveBeenCalledTimes(1);
		expect(onFollow).toHaveBeenCalledWith('bt-1');
	});

	it('renders nothing without a ready view of the expected kind', () => {
		for (const [editorial, kind] of [
			[null, 'artist'],
			[editorialState(), 'artist'],
			[
				editorialState({
					phase: 'ready',
					view: { kind: 'artist', title: 'N', sections: {} }
				}),
				'artist'
			],
			[
				// An artist view must never feed an album-kind section.
				editorialState({ phase: 'ready', view: artistViewWithRelationships() }),
				'album'
			]
		] as const) {
			const { unmount } = renderSection(editorial, kind);
			expect(screen.queryByTestId('related')).toBeNull();
			unmount();
		}
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
});
