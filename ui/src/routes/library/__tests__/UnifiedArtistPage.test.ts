import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import UnifiedArtistPage from '../UnifiedArtistPage.svelte';
import type { LibraryAlbumEntry, LibraryArtistEntry } from '$lib/libraryEntries';

const artist: LibraryArtistEntry = {
	id: 'artist-1',
	name: 'Nils Frahm',
	searchKey: 'nils frahm'
};

const albums: readonly LibraryAlbumEntry[] = [
	{ id: 'album-1', title: 'Melody', artist: 'Nils Frahm', searchKey: 'melody nils frahm' }
];

const discographyGrid = createRawSnippet(() => ({
	render: () =>
		'<div data-testid="discography-grid"><button type="button" data-testid="grid-tile">Album tile</button></div>'
}));

/** Renders the page with the standard fixture, overriding named props. */
function renderPage(overrides: Record<string, unknown> = {}) {
	return render(UnifiedArtistPage, {
		props: {
			artist,
			albums,
			overlayPhase: 'idle',
			discographyKnown: true,
			truncated: false,
			backLabel: 'Back',
			onBack: () => {},
			discography: discographyGrid,
			...overrides
		}
	});
}

describe('UnifiedArtistPage hero artwork (R2)', () => {
	it('renders the hero image through /api/image when the artist carries a key', () => {
		render(UnifiedArtistPage, {
			props: {
				artist: { ...artist, imageKey: 'artist-img-1' },
				albums,
				overlayPhase: 'idle',
				discographyKnown: true,
				truncated: false,
				backLabel: 'Back',
				onBack: () => {},
				discography: discographyGrid,
			}
		});
		const hero = screen.getByTestId('unified-artist-hero');
		const image = screen.getByTestId('unified-artist-hero-image') as HTMLImageElement;
		expect(hero.contains(image)).toBe(true);
		expect(image.getAttribute('src')).toBe(
			'/api/image/artist-img-1?scale=fit&width=2400&height=1600'
		);
		// The monogram is the permanent placeholder layer beneath the image
		// (q2-3); while the image has not failed, it stays visible on top.
		expect(hero.contains(screen.getByTestId('unified-artist-hero-fallback'))).toBe(true);
		expect(image.style.visibility).toBe('');
		// The hero occupies its slot BEFORE the discography grid from first paint.
		const grid = screen.getByTestId('discography-grid');
		expect(hero.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it('reveals the monogram fallback when the hero image fails to load (q2-3)', async () => {
		render(UnifiedArtistPage, {
			props: {
				artist: { ...artist, imageKey: 'stale-key' },
				albums,
				overlayPhase: 'idle',
				discographyKnown: true,
				truncated: false,
				backLabel: 'Back',
				onBack: () => {},
				discography: discographyGrid,
			}
		});
		const hero = screen.getByTestId('unified-artist-hero');
		const image = screen.getByTestId('unified-artist-hero-image') as HTMLImageElement;
		const fallback = screen.getByTestId('unified-artist-hero-fallback');
		// A stale key or /api/image error hides the img in place (the box's
		// geometry is unchanged) and reveals the monogram beneath.
		await fireEvent.error(image);
		expect(image.style.visibility).toBe('hidden');
		expect(hero.contains(fallback)).toBe(true);
		expect(fallback.textContent?.trim()).toBe('N');
		// A later successful load (e.g. a retried src) restores the image.
		await fireEvent.load(image);
		expect(image.style.visibility).toBe('');
	});

	it('keeps the permanent monogram layer out of the accessibility tree (q2-3)', () => {
		render(UnifiedArtistPage, {
			props: {
				artist: { ...artist, imageKey: 'artist-img-1' },
				albums,
				overlayPhase: 'idle',
				discographyKnown: true,
				truncated: false,
				backLabel: 'Back',
				onBack: () => {},
				discography: discographyGrid,
			}
		});
		// The fallback is decorative in both states — the artist name is the
		// heading — so its stray initial must not reach assistive tech,
		// whether or not the keyed image loads.
		expect(screen.getByTestId('unified-artist-hero-fallback')).toHaveAttribute(
			'aria-hidden',
			'true'
		);
	});

	it('renders the monogram fallback in the same slot when no key exists', () => {
		renderPage();
		const hero = screen.getByTestId('unified-artist-hero');
		expect(screen.queryByTestId('unified-artist-hero-image')).toBeNull();
		const fallback = screen.getByTestId('unified-artist-hero-fallback');
		expect(hero.contains(fallback)).toBe(true);
		expect(fallback.textContent?.trim()).toBe('N');
	});

	it('renders no hero slot when the artist is missing entirely', () => {
		render(UnifiedArtistPage, {
			props: {
				artist: null,
				albums: [],
				overlayPhase: 'idle',
				discographyKnown: true,
				truncated: false,
				backLabel: 'Back',
				onBack: () => {},
				discography: discographyGrid,
			}
		});
		expect(screen.queryByTestId('unified-artist-hero')).toBeNull();
	});
});
