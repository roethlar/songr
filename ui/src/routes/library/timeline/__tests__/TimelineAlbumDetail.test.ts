import { fireEvent, render, screen } from '@testing-library/svelte';
import type { AlbumRef, ArtistRef } from '@shared/timelineCatalogContracts';
import { describe, expect, it, vi } from 'vitest';
import type { TimelineAlbumDetailViewModel } from '$lib/timeline/detailView';

import TimelineAlbumDetail from '../TimelineAlbumDetail.svelte';

const album: AlbumRef = {
	localId: 'album-homogenic',
	coreId: 'core-album-homogenic',
	artistLocalId: 'artist-bjork',
	exactTitle: 'Homogenic',
	exactArtist: 'Björk',
	normalizedTitle: 'homogenic',
	normalizedArtist: 'bjork',
	editionText: '',
	firstSeenAt: '2026-07-01T00:00:00.000Z',
	lastSeenAt: '2026-07-01T00:00:00.000Z',
	resolutionStatus: 'resolved'
};

const artist: ArtistRef = {
	localId: 'artist-bjork',
	coreId: 'core-artist-bjork',
	exactName: 'Björk',
	normalizedName: 'bjork',
	firstSeenAt: '2026-07-01T00:00:00.000Z',
	lastSeenAt: '2026-07-01T00:00:00.000Z',
	resolutionStatus: 'resolved'
};

function readyView(trackCount: number): TimelineAlbumDetailViewModel {
	return {
		album,
		detail: {
			artist,
			album,
			orderedTrackTitles: Array.from(
				{ length: trackCount },
				(_, index) => `Track ${index + 1}`
			)
		},
		phase: 'ready',
		message: null
	};
}

describe('TimelineAlbumDetail', () => {
	it('opens the exact track in Classic while retaining forty-row pagination', async () => {
		const onOpenTrackInClassic = vi.fn();
		const view = render(TimelineAlbumDetail, {
			props: {
				view: readyView(45),
				x: 10,
				y: 20,
				onOpenTrackInClassic
			}
		});

		expect(view.container.querySelectorAll('[data-detail-track]')).toHaveLength(40);
		expect(screen.getAllByRole('button', { name: /^Open Track \d+ in Classic$/ })).toHaveLength(40);
		expect(screen.queryByText('Track 41')).toBeNull();
		expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();

		await fireEvent.click(screen.getByRole('button', { name: 'Open Track 40 in Classic' }));
		expect(onOpenTrackInClassic).toHaveBeenCalledTimes(1);
		expect(onOpenTrackInClassic).toHaveBeenLastCalledWith('Track 40');

		await fireEvent.click(screen.getByRole('button', { name: 'Next' }));
		expect(view.container.querySelectorAll('[data-detail-track]')).toHaveLength(5);
		expect(screen.getAllByRole('button', { name: /^Open Track \d+ in Classic$/ })).toHaveLength(5);
		expect(screen.queryByText('Track 40')).toBeNull();
		expect(screen.getByText('Track 41')).toBeInTheDocument();
		expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();

		await fireEvent.click(screen.getByRole('button', { name: 'Open Track 45 in Classic' }));
		expect(onOpenTrackInClassic).toHaveBeenCalledTimes(2);
		expect(onOpenTrackInClassic).toHaveBeenLastCalledWith('Track 45');
	});

	it('does not add dead controls when no Classic fallback is wired', () => {
		render(TimelineAlbumDetail, {
			props: { view: readyView(2), x: 10, y: 20 }
		});

		expect(screen.queryByRole('button', { name: /Open .* in Classic/ })).toBeNull();
	});
});
