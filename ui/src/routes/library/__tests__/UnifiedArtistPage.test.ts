import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import UnifiedArtistPage from '../UnifiedArtistPage.svelte';
import type { EditorialItemState } from '$lib/library/EditorialItemController';
import type { EditorialItemView } from '@shared/editorialItemContracts';
import type { LibraryAlbumEntry, LibraryArtistEntry } from '$lib/stores/libraryIndexStore';

const artist: LibraryArtistEntry = {
	id: 'artist-1',
	name: 'Nils Frahm',
	searchKey: 'nils frahm',
	countComplete: true
};

const albums: readonly LibraryAlbumEntry[] = [
	{ id: 'album-1', title: 'Melody', artist: 'Nils Frahm', searchKey: 'melody nils frahm' }
];

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

function readyArtistView(overrides: Partial<EditorialItemView> = {}): EditorialItemView {
	return {
		kind: 'artist',
		title: 'Nils Frahm',
		sections: {
			biography: {
				text: 'A pianist and composer from Berlin.',
				source: 'AllMusic',
				language: 'en'
			}
		},
		attribution: [{ text: 'AllMusic' }],
		relationshipGroups: [
			{ label: 'Similar artists', items: [{ title: 'Olafur Arnalds' }] }
		],
		links: [{ text: 'en.wikipedia.org', url: 'https://en.wikipedia.org/wiki/X' }],
		...overrides
	};
}

const discographyGrid = createRawSnippet(() => ({
	render: () =>
		'<div data-testid="discography-grid"><button type="button" data-testid="grid-tile">Album tile</button></div>'
}));

function renderPage(editorial: EditorialItemState | null) {
	return render(UnifiedArtistPage, {
		props: {
			artist,
			albums,
			overlayPhase: 'idle',
			truncated: false,
			backLabel: 'Back',
			onBack: () => {},
			discography: discographyGrid,
			editorial
		}
	});
}

/** Element index of `node` among its parent's element children. */
function siblingIndex(node: Element): number {
	return [...(node.parentElement?.children ?? [])].indexOf(node);
}

/**
 * The wide portrait travels as a namespace-tagged reference, not a bare key
 * (wh-3): the producer that read it out of the library mints the tag. The
 * page never inspects it — it interpolates the value into the portrait URL
 * verbatim — so the fixture is the tagged form and the URL carries it whole.
 */
const WIDE_KEY = 'portrait-ppcbaaaa';
const WIDE_URL = '/api/artist-portrait/wide/portrait-ppcbaaaa';

/** Renders the page with the standard fixture, overriding named props. */
function renderArtist(overrides: Record<string, unknown> = {}) {
	return render(UnifiedArtistPage, {
		props: {
			artist,
			albums,
			overlayPhase: 'idle',
			truncated: false,
			backLabel: 'Back',
			onBack: () => {},
			discography: discographyGrid,
			editorial: null,
			...overrides
		}
	});
}

function withWideKey(): EditorialItemState {
	return editorialState({
		phase: 'ready',
		view: readyArtistView({ wideArtworkKey: WIDE_KEY })
	});
}

describe('UnifiedArtistPage hero artwork (R2)', () => {
	it('renders the hero image through /api/image when the artist carries a key', () => {
		render(UnifiedArtistPage, {
			props: {
				artist: { ...artist, imageKey: 'artist-img-1' },
				albums,
				overlayPhase: 'idle',
				truncated: false,
				backLabel: 'Back',
				onBack: () => {},
				discography: discographyGrid,
				editorial: null
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
				truncated: false,
				backLabel: 'Back',
				onBack: () => {},
				discography: discographyGrid,
				editorial: null
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
				truncated: false,
				backLabel: 'Back',
				onBack: () => {},
				discography: discographyGrid,
				editorial: null
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
		renderPage(null);
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
				truncated: false,
				backLabel: 'Back',
				onBack: () => {},
				discography: discographyGrid,
				editorial: null
			}
		});
		expect(screen.queryByTestId('unified-artist-hero')).toBeNull();
	});
});

describe('UnifiedArtistPage editorial layout stability (R3)', () => {
	it('reserves skeleton slots before the grid from first paint, and the grid never moves when content resolves', async () => {
		const { rerender } = renderPage(editorialState({ phase: 'opening' }));

		// From first paint all three async sections hold their fixed slot
		// BEFORE the synchronously rendered discography grid.
		const biographySkeleton = screen.getByTestId('unified-artist-biography-skeleton');
		const relationshipsSkeleton = screen.getByTestId('unified-artist-relationships-skeleton');
		const linksSkeleton = screen.getByTestId('unified-artist-links-skeleton');
		const grid = screen.getByTestId('discography-grid');
		for (const skeleton of [biographySkeleton, relationshipsSkeleton, linksSkeleton]) {
			expect(
				skeleton.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING
			).toBeTruthy();
		}
		const gridParent = grid.parentElement;
		const gridIndexBefore = siblingIndex(grid);

		// The editorial read resolves: every skeleton is replaced in place.
		await rerender({ editorial: editorialState({ phase: 'ready', view: readyArtistView() }) });

		expect(screen.getByTestId('unified-artist-biography')).toBeInTheDocument();
		expect(screen.getByTestId('unified-artist-relationships')).toBeInTheDocument();
		expect(screen.getByTestId('unified-artist-links')).toBeInTheDocument();
		expect(screen.queryByTestId('unified-artist-biography-skeleton')).toBeNull();

		// The grid is the same element, in the same slot — no clickable
		// control moved when the prose arrived.
		const gridAfter = screen.getByTestId('discography-grid');
		expect(gridAfter).toBe(grid);
		expect(gridAfter.parentElement).toBe(gridParent);
		expect(siblingIndex(gridAfter)).toBe(gridIndexBefore);
	});

	it('renders no editorial section and no skeleton when the feature is absent', () => {
		for (const editorial of [
			null,
			editorialState({ phase: 'unavailable', code: 'FEATURE_UNAVAILABLE' })
		]) {
			const { unmount } = renderPage(editorial);
			expect(screen.queryByTestId('unified-artist-biography')).toBeNull();
			expect(screen.queryByTestId('unified-artist-relationships')).toBeNull();
			expect(screen.queryByTestId('unified-artist-links')).toBeNull();
			expect(screen.queryByTestId('unified-artist-biography-skeleton')).toBeNull();
			expect(screen.queryByTestId('unified-artist-relationships-skeleton')).toBeNull();
			expect(screen.queryByTestId('unified-artist-links-skeleton')).toBeNull();
			expect(screen.getByTestId('discography-grid')).toBeInTheDocument();
			unmount();
		}
	});
});

describe('UnifiedArtistPage wide portrait hero', () => {
	it('promotes the wide portrait to a full-bleed banner once its picture decodes', async () => {
		renderArtist({ editorial: withWideKey() });

		// The key alone changes nothing on screen: the portrait is in flight
		// in a box with no size, and the ordinary header still holds the slot.
		expect(screen.queryByTestId('unified-artist-wide-hero')).toBeNull();
		expect(screen.getByTestId('unified-artist-hero')).toBeInTheDocument();
		const probe = screen.getByTestId('unified-artist-wide-probe') as HTMLImageElement;
		expect(probe.getAttribute('src')).toBe(WIDE_URL);
		// Never lazy: a lazy image in a zero-size box may never be fetched,
		// and a portrait that is never fetched never becomes a banner.
		expect(probe.getAttribute('loading')).toBeNull();

		await fireEvent.load(probe);

		const banner = screen.getByTestId('unified-artist-wide-hero');
		const image = screen.getByTestId('unified-artist-wide-hero-image') as HTMLImageElement;
		expect(banner.contains(image)).toBe(true);
		expect(image.getAttribute('src')).toBe(WIDE_URL);
		// Identity over the photograph, on the legibility scrim.
		expect(banner.textContent).toContain('Nils Frahm');
		expect(banner.textContent).toContain('1 ALBUMS');
		// One hero, not two: the ordinary header and the probe are both gone.
		expect(screen.queryByTestId('unified-artist-hero')).toBeNull();
		expect(screen.queryByTestId('unified-artist-wide-probe')).toBeNull();
	});

	it('keeps the ordinary header when the library holds no wide portrait', async () => {
		const { rerender } = renderArtist({
			editorial: editorialState({ phase: 'ready', view: readyArtistView() })
		});

		expect(screen.queryByTestId('unified-artist-wide-probe')).toBeNull();
		expect(screen.queryByTestId('unified-artist-wide-hero')).toBeNull();
		expect(screen.getByTestId('unified-artist-hero')).toBeInTheDocument();

		// The absence above is the missing key and nothing else: this same
		// mounted page, handed a key, fetches the portrait and shows it.
		await rerender({ editorial: withWideKey() });
		await fireEvent.load(screen.getByTestId('unified-artist-wide-probe'));
		expect(screen.getByTestId('unified-artist-wide-hero')).toBeInTheDocument();
	});

	it('keeps the ordinary header when the portrait cannot be fetched, with nothing to report', async () => {
		renderArtist({ editorial: withWideKey() });
		const heroBefore = screen.getByTestId('unified-artist-hero');

		await fireEvent.error(screen.getByTestId('unified-artist-wide-probe'));

		expect(screen.queryByTestId('unified-artist-wide-hero')).toBeNull();
		// The same header element, untouched — not a replacement rendered
		// into the gap a failed banner left behind.
		expect(screen.getByTestId('unified-artist-hero')).toBe(heroBefore);
		// A missing portrait is an ordinary answer: no alert, no message.
		expect(screen.queryByRole('alert')).toBeNull();
		expect(document.body.textContent ?? '').not.toMatch(
			/could not|couldn't|failed|unavailable|error/i
		);
		// And it is never asked for a second time.
		expect(screen.queryByTestId('unified-artist-wide-probe')).toBeNull();
	});

	it('never moves the discography: the portrait resolves into the header own slot', async () => {
		const { rerender } = renderArtist({
			editorial: editorialState({ phase: 'ready', view: readyArtistView() })
		});

		const grid = screen.getByTestId('discography-grid');
		const gridParent = grid.parentElement;
		const gridIndex = siblingIndex(grid);
		const hero = screen.getByTestId('unified-artist-hero');
		const heroParent = hero.parentElement;
		const heroIndex = siblingIndex(hero);

		// 1. The key arrives. The picture is in flight and the page is
		//    untouched — the header is the same element in the same place.
		await rerender({ editorial: withWideKey() });
		expect(screen.getByTestId('unified-artist-hero')).toBe(hero);
		expect(siblingIndex(hero)).toBe(heroIndex);
		expect(screen.getByTestId('discography-grid')).toBe(grid);
		expect(siblingIndex(grid)).toBe(gridIndex);

		// 2. The picture decodes and the banner is committed — into the slot
		//    the ordinary header held, so the grid is still the same element,
		//    in the same parent, at the index it has had since first paint.
		await fireEvent.load(screen.getByTestId('unified-artist-wide-probe'));
		const banner = screen.getByTestId('unified-artist-wide-hero');
		expect(banner.parentElement).toBe(heroParent);
		expect(siblingIndex(banner)).toBe(heroIndex);
		const gridAfter = screen.getByTestId('discography-grid');
		expect(gridAfter).toBe(grid);
		expect(gridAfter.parentElement).toBe(gridParent);
		expect(siblingIndex(gridAfter)).toBe(gridIndex);
		expect(
			banner.compareDocumentPosition(gridAfter) & Node.DOCUMENT_POSITION_FOLLOWING
		).toBeTruthy();
	});

	it('keeps a banner it has shown, so a later read cannot take it away', async () => {
		const { rerender } = renderArtist({ editorial: withWideKey() });
		await fireEvent.load(screen.getByTestId('unified-artist-wide-probe'));
		expect(screen.getByTestId('unified-artist-wide-hero')).toBeInTheDocument();

		// A retry, or any later read, that comes back without the key must
		// not pull the picture out from under the page.
		await rerender({
			editorial: editorialState({ phase: 'ready', view: readyArtistView() })
		});
		expect(screen.getByTestId('unified-artist-wide-hero')).toBeInTheDocument();
	});

	it('does not carry one artist’s photograph onto the next artist’s page', async () => {
		const { rerender } = renderArtist({ editorial: withWideKey() });
		await fireEvent.load(screen.getByTestId('unified-artist-wide-probe'));
		expect(screen.getByTestId('unified-artist-wide-hero')).toBeInTheDocument();

		// The page moves to another artist. Even handed the previous read
		// verbatim — the controller clears the view on open, but this page
		// does not depend on that — the proven picture belongs to the artist
		// it was proven for and nobody else.
		await rerender({ artist: { ...artist, id: 'artist-2', name: 'Kiasmos' } });
		expect(screen.queryByTestId('unified-artist-wide-hero')).toBeNull();
		expect(screen.getByTestId('unified-artist-hero')).toBeInTheDocument();
	});

	it("ignores a followed related artist's portrait — the hero is the page's artist", async () => {
		const followed = editorialState({
			phase: 'ready',
			view: readyArtistView({ title: 'Olafur Arnalds', wideArtworkKey: WIDE_KEY })
		});
		const { rerender } = renderArtist({
			editorial: followed,
			editorialFollowActive: true
		});

		expect(screen.queryByTestId('unified-artist-wide-probe')).toBeNull();
		expect(screen.queryByTestId('unified-artist-wide-hero')).toBeNull();
		expect(screen.getByTestId('unified-artist-hero')).toBeInTheDocument();

		// The very same view, no longer a followed child, does produce it.
		await rerender({ editorialFollowActive: false });
		expect(screen.getByTestId('unified-artist-wide-probe')).toBeInTheDocument();
	});
});

describe('UnifiedArtistPage wide portrait frame (style contract)', () => {
	const source = readFileSync(
		resolve(process.cwd(), 'src/routes/library/UnifiedArtistPage.svelte'),
		'utf8'
	);

	function ruleBody(selector: string): string {
		const start = source.indexOf(selector);
		if (start < 0) throw new Error(`Missing rule: ${selector}`);
		const bodyStart = source.indexOf('{', start + selector.length - 1) + 1;
		return source.slice(bodyStart, source.indexOf('}', bodyStart));
	}

	it('sizes the banner from its own width and never from the picture', () => {
		// The reservation that makes the promotion safe: the frame's height
		// is a function of its width alone, so the image landing, resizing
		// or re-decoding inside it cannot move a control below it.
		const rule = ruleBody('.artist-banner.wide {');
		expect(rule).toContain('aspect-ratio: 16 / 7');
		expect(rule).toContain('height: auto');
		expect(rule).not.toMatch(/min-height|max-height/);
	});

	it('fits the photograph with cover in a frame of its own shape', () => {
		// 16:7 frame + 16:7 master means `cover` cuts nothing. This is what
		// replaces the rejected top-biased crop and the blurred filler band.
		expect(ruleBody('.artist-banner img {')).toContain('object-fit: cover');
		expect(ruleBody('.artist-banner.wide img {')).toContain('object-position: center');
	});

	it('keeps the in-flight portrait out of the layout entirely', () => {
		const rule = ruleBody('.wide-probe {');
		expect(rule).toContain('position: absolute');
		expect(rule).toContain('width: 0');
		expect(rule).toContain('height: 0');
	});
});
