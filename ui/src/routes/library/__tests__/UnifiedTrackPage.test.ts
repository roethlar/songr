import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import type {
	UnifiedSongAlbumRelationship,
	UnifiedSongRelationship
} from '@shared/unifiedSearchContracts';

import UnifiedTrackPage from '../UnifiedTrackPage.svelte';

const song = {
	resultId: 'song-result-1',
	title: 'Dear Theodosia',
	subtitle: 'Orlando Ballet Chorus',
	imageKey: null
};

function mountPanel(options: {
	zones?: readonly { zoneId: string; name: string }[];
	onAction?: (semantic: 'play-now' | 'add-next' | 'queue', zoneId: string) => void;
	onFavorite?: () => void;
	relationship?: UnifiedSongRelationship;
	onOpenAlbum?: (album: UnifiedSongAlbumRelationship) => void;
	onOpenArtist?: (artistLocalId: string) => void;
	onOpenComposer?: (label: string) => void;
} = {}) {
	const onBack = vi.fn();
	const onClose = vi.fn();
	const onAction = options.onAction;
	const result = render(UnifiedTrackPage, {
		props: {
			song,
			zones: options.zones ?? [{ zoneId: 'zone-1', name: 'Living Room' }],
			onBack,
			onClose,
			relationshipPhase: options.relationship ? 'ready' : 'idle',
			relationship: options.relationship ?? null,
			...(onAction ? { onAction } : {}),
			...(options.onFavorite ? { onFavorite: options.onFavorite } : {}),
			...(options.onOpenAlbum ? { onOpenAlbum: options.onOpenAlbum } : {}),
			...(options.onOpenArtist ? { onOpenArtist: options.onOpenArtist } : {}),
			...(options.onOpenComposer ? { onOpenComposer: options.onOpenComposer } : {})
		}
	});
	return { ...result, onBack, onClose, onAction };
}

describe('UnifiedTrackPage', () => {
	it('renders as a page, not a dialog, and closes the search explicitly', async () => {
		const harness = mountPanel();
		// The terminal dialog is retired (plan §4.1): the track surface is a
		// first-class page — no modal role, no scrim, an explicit close.
		expect(screen.getByTestId('unified-track-page')).toBeInTheDocument();
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(document.querySelector('[aria-modal="true"]')).toBeNull();
		await fireEvent.click(screen.getByTestId('unified-song-close'));
		expect(harness.onClose).toHaveBeenCalledTimes(1);
	});

	it('shows the song-focused destinations and returns to the same search results', async () => {
		const harness = mountPanel();

		expect(screen.getByTestId('unified-song-title')).toHaveTextContent('Dear Theodosia');
		expect(screen.getByTestId('unified-song-subtitle')).toHaveTextContent(
			'Orlando Ballet Chorus'
		);
		expect(screen.getByTestId('unified-song-play-now')).toHaveTextContent('Play Now');
		expect(screen.getByTestId('unified-song-add-next')).toHaveTextContent('Add Next');
		expect(screen.getByTestId('unified-song-queue')).toHaveTextContent('Queue');
		expect(screen.getByTestId('unified-song-favorite')).toHaveTextContent('Favorite');
		expect(screen.getByTestId('unified-song-album-link')).toHaveTextContent('Go to Album');
		expect(screen.getByTestId('unified-song-artist-link')).toHaveTextContent('Go to Artist');

		await fireEvent.click(screen.getByTestId('unified-song-back'));
		expect(harness.onBack).toHaveBeenCalledTimes(1);
	});

	it('favorites only after the explicit Favorite click', async () => {
		const onFavorite = vi.fn();
		mountPanel({ onFavorite });
		expect(onFavorite).not.toHaveBeenCalled();

		await fireEvent.click(screen.getByTestId('unified-song-favorite'));
		expect(onFavorite).toHaveBeenCalledTimes(1);
	});

	it('executes a named action directly when there is one zone', async () => {
		const onAction = vi.fn();
		mountPanel({ onAction });

		await fireEvent.click(screen.getByTestId('unified-song-add-next'));

		expect(onAction).toHaveBeenCalledWith('add-next', 'zone-1');
		expect(screen.queryByTestId('unified-song-zone-picker')).toBeNull();
	});

	it('keeps the chosen semantic while asking for a zone', async () => {
		const onAction = vi.fn();
		mountPanel({
			onAction,
			zones: [
				{ zoneId: 'zone-1', name: 'Living Room' },
				{ zoneId: 'zone-2', name: 'Office' }
			]
		});

		await fireEvent.click(screen.getByTestId('unified-song-queue'));
		expect(screen.getByTestId('unified-song-zone-picker')).toHaveTextContent('Queue on');
		await fireEvent.click(screen.getByRole('button', { name: 'Office' }));

		expect(onAction).toHaveBeenCalledWith('queue', 'zone-2');
	});

	it('opens one album and its artist directly and renders explicit composer links', async () => {
		const onOpenAlbum = vi.fn<(album: UnifiedSongAlbumRelationship) => void>();
		const onOpenArtist = vi.fn<(artistLocalId: string) => void>();
		const onOpenComposer = vi.fn<(label: string) => void>();
		const relationship: UnifiedSongRelationship = {
			songTitle: 'Dear Theodosia',
			albums: [
				{
					albumLocalId: 'album-1',
					artistLocalId: 'artist-1',
					title: 'Hamilton',
					artist: 'Orlando Ballet Chorus',
					editionText: ''
				}
			],
			composerLabels: ['Lio-Marcus Mendel']
		};
		mountPanel({
			relationship,
			onOpenAlbum,
			onOpenArtist,
			onOpenComposer
		});

		await fireEvent.click(screen.getByTestId('unified-song-album-link'));
		expect(onOpenAlbum).toHaveBeenCalledWith(relationship.albums[0]);
		expect(screen.queryByTestId('unified-song-album-chooser')).toBeNull();

		await fireEvent.click(screen.getByTestId('unified-song-artist-link'));
		expect(onOpenArtist).toHaveBeenCalledWith('artist-1');

		await fireEvent.click(screen.getByRole('button', { name: 'Lio-Marcus Mendel' }));
		expect(onOpenComposer).toHaveBeenCalledWith('Lio-Marcus Mendel');
	});

	it('chooses among multiple albums in the song panel and leaves zero matches unavailable', async () => {
		const onOpenAlbum = vi.fn<(album: UnifiedSongAlbumRelationship) => void>();
		const relationship: UnifiedSongRelationship = {
			songTitle: 'River',
			albums: [
				{
					albumLocalId: 'album-original',
					artistLocalId: 'artist-1',
					title: 'Blue',
					artist: 'Joni Mitchell',
					editionText: ''
				},
				{
					albumLocalId: 'album-remaster',
					artistLocalId: 'artist-1',
					title: 'Blue',
					artist: 'Joni Mitchell',
					editionText: 'Remaster'
				}
			],
			composerLabels: []
		};
		const harness = mountPanel({ relationship, onOpenAlbum });

		await fireEvent.click(screen.getByTestId('unified-song-album-link'));
		expect(screen.getByTestId('unified-song-album-chooser')).toBeInTheDocument();
		await fireEvent.click(
			screen.getByTestId('unified-song-album-choice-album-remaster')
		);
		expect(onOpenAlbum).toHaveBeenCalledWith(relationship.albums[1]);

		await harness.rerender({
			song,
			zones: [{ zoneId: 'zone-1', name: 'Living Room' }],
			relationshipPhase: 'ready',
			relationship: { songTitle: 'River', albums: [], composerLabels: [] },
			onBack: harness.onBack,
			onClose: harness.onClose,
			onOpenAlbum
		});
		expect(screen.getByTestId('unified-song-album-link')).toBeDisabled();
		expect(screen.getByTestId('unified-song-relationship-status')).toHaveTextContent(
			'No matching album'
		);
	});
});
