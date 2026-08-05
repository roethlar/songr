import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import userEvent from '@testing-library/user-event';
import Search from '../Search.svelte';
import type { SearchResult } from '@shared/types';

const TEST_CLAIM = {
	owner: 'classic-mode' as const,
	claimId: 1,
	ready: Promise.resolve({ handleId: 'test', generation: 1 })
};

const apiBrowseSearch = vi.fn<
	(_fetch: unknown, options: any, claim: typeof TEST_CLAIM, role: string) => Promise<SearchResult[]>
>();
vi.mock('$lib/api/client', () => ({
	browseSearch: (...args: any[]) =>
		apiBrowseSearch(...(args as [unknown, any, typeof TEST_CLAIM, string]))
}));

import {
	setSearchResults,
	setSearchLoading,
	clearSearchResults
} from '$lib/stores/browseStore';
import { setSelectedZone } from '$lib/stores/selectedZoneStore';
import { makeSearchResult } from '../../../test/fixtures/browse';

// Local alias: Search.test was using a one-off `makeResult` shape with
// a fixed `itemKey: 'k'` default. makeSearchResult is more strict
// (matches the shared fixture), so adapt here.
function makeResult(
	over: Partial<SearchResult> & { resultType: SearchResult['resultType'] }
): SearchResult {
	return makeSearchResult({
		title: 'Untitled',
		itemKey: 'k',
		...over
	});
}

beforeEach(() => {
	clearSearchResults();
	setSelectedZone('');
	apiBrowseSearch.mockReset();
	apiBrowseSearch.mockResolvedValue([]);
});

describe('Search component', () => {
	it('renders nothing while no search has run', () => {
		render(Search);
		expect(screen.queryByText(/results/i)).toBeNull();
	});

	it('shows "Searching..." while loading', async () => {
		render(Search);
		setSearchLoading('beatles');
		await tick();
		expect(screen.getByText(/searching/i)).toBeInTheDocument();
	});

	it('groups results by type in the documented order', async () => {
		render(Search);
		setSearchResults([
			makeResult({ resultType: 'track', title: 'T1', itemKey: 't1' }),
			makeResult({ resultType: 'album', title: 'A1', itemKey: 'a1' }),
			makeResult({ resultType: 'artist', title: 'AR1', itemKey: 'ar1' }),
			makeResult({ resultType: 'album', title: 'A2', itemKey: 'a2' })
		]);
		await tick();

		const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
		expect(headings).toEqual(['Artists', 'Albums', 'Tracks']);
	});

	it('leads with "Top results" for untyped direct hits', async () => {
		render(Search);
		setSearchResults([
			makeResult({ resultType: 'track', title: 'T1', itemKey: 't1' }),
			makeResult({ resultType: 'unknown', title: 'Direct Hit', itemKey: 'd1' })
		]);
		await tick();

		const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
		expect(headings).toEqual(['Top results', 'Tracks']);
		expect(screen.queryByText('Other')).toBeNull();
	});

	it('renders tracks as rows, not artwork cards', async () => {
		const onResultClick = vi.fn();
		const { container } = render(Search, { props: { onResultClick } });
		setSearchResults([
			makeResult({
				resultType: 'track',
				title: 'My Shot',
				subtitle: 'Lio-Marcus Mendel',
				itemKey: 't1'
			}),
			makeResult({ resultType: 'album', title: 'Hamilton', itemKey: 'a1' })
		]);
		await tick();

		// The track renders as a row…
		const row = screen.getByRole('button', { name: /My Shot/ });
		expect(row.classList.contains('track-row')).toBe(true);
		// …the album stays a card grid.
		expect(container.querySelector('.items-grid')).toBeTruthy();

		row.click();
		expect(onResultClick).toHaveBeenCalledWith(
			expect.objectContaining({ itemKey: 't1', title: 'My Shot' })
		);
	});

	it('offers "See all N" on a truncated category group and reports the real total (rev-4)', async () => {
		const onSeeAllCategory = vi.fn();
		render(Search, { props: { onSeeAllCategory } });
		setSearchResults([
			makeResult({
				resultType: 'track',
				title: 'T1',
				itemKey: 't1',
				categoryTitle: 'Tracks',
				categoryTotal: 80
			}),
			makeResult({
				resultType: 'track',
				title: 'T2',
				itemKey: 't2',
				categoryTitle: 'Tracks',
				categoryTotal: 80
			})
		]);
		await tick();

		// Header counts against the category total, not the loaded page.
		expect(screen.getByText('2 of 80')).toBeInTheDocument();

		const seeAll = screen.getByRole('button', { name: /See all 80 tracks/i });
		seeAll.click();
		expect(onSeeAllCategory).toHaveBeenCalledWith('Tracks');
	});

	it('still offers "See all" when a direct hit shares the group (rev-4 reopen)', async () => {
		const onSeeAllCategory = vi.fn();
		render(Search, { props: { onSeeAllCategory } });
		setSearchResults([
			// Typed DIRECT hit — no category stamp — sorted first.
			makeResult({ resultType: 'track', title: 'Direct Hit', itemKey: 'd1' }),
			makeResult({
				resultType: 'track',
				title: 'T1',
				itemKey: 't1',
				categoryTitle: 'Tracks',
				categoryTotal: 80
			})
		]);
		await tick();

		const seeAll = screen.getByRole('button', { name: /See all 80 tracks/i });
		seeAll.click();
		expect(onSeeAllCategory).toHaveBeenCalledWith('Tracks');
	});

	it('renders a helpful empty state for zero results instead of a bare count', async () => {
		render(Search);
		setSearchLoading('xyzzy');
		setSearchResults([]);
		await tick();

		expect(screen.getByText(/no results/i)).toBeInTheDocument();
		expect(screen.getByText('"xyzzy"')).toBeInTheDocument();
		expect(screen.getByText(/check the spelling/i)).toBeInTheDocument();
		expect(screen.queryByText(/0 results/i)).toBeNull();
	});

	it('shows the submitted query in the result count', async () => {
		render(Search);
		setSearchLoading('beatles');
		setSearchResults([makeResult({ resultType: 'album', title: 'A1', itemKey: 'a1' })]);
		await tick();

		expect(screen.getByText(/1 results/i)).toBeInTheDocument();
		expect(screen.getByText('"beatles"')).toBeInTheDocument();
	});

	it('paginates per group at 12 with a "Show more" button', async () => {
		const albums = Array.from({ length: 20 }, (_, i) =>
			makeResult({ resultType: 'album', title: `Album ${i + 1}`, itemKey: `a${i}` })
		);
		render(Search);
		setSearchResults(albums);
		await tick();

		// First 12 visible
		expect(screen.getByText('Album 1')).toBeInTheDocument();
		expect(screen.getByText('Album 12')).toBeInTheDocument();
		expect(screen.queryByText('Album 13')).toBeNull();
		expect(screen.getByText(/12 of 20/)).toBeInTheDocument();

		// Show more bumps to 24 (capped at 20)
		await userEvent.click(screen.getByRole('button', { name: /show more albums/i }));
		expect(screen.getByText('Album 20')).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /show more albums/i })).toBeNull();
	});

	it('fires the onResultClick callback with the clicked result', async () => {
		const onResultClick = vi.fn();
		render(Search, { onResultClick });
		const result = makeResult({ resultType: 'album', title: 'Pet Sounds', itemKey: 'k1' });
		setSearchResults([result]);
		await tick();

		await userEvent.click(screen.getByText('Pet Sounds'));
		expect(onResultClick).toHaveBeenCalledWith(expect.objectContaining({ itemKey: 'k1' }));
	});

	it('keeps coordinated keyless results actionable through the resolver callback', async () => {
		const onResultClick = vi.fn();
		render(Search, { onResultClick });
		const result = makeResult({
			resultType: 'album',
			title: 'Keyless Pet Sounds',
			itemKey: undefined
		});
		setSearchResults([result]);
		await tick();

		const button = screen.getByText('Keyless Pet Sounds').closest('button');
		expect(button).toBeEnabled();
		await userEvent.click(button!);
		expect(onResultClick).toHaveBeenCalledWith(
			expect.objectContaining({ title: 'Keyless Pet Sounds', itemKey: undefined })
		);
	});

	it('people groups render uniform rows; artwork grids remain for albums (2026-07-10 redesign)', async () => {
		const { container } = render(Search);
		setSearchResults([
			makeResult({ resultType: 'artist', title: 'Tilda Arlen', subtitle: '9 Albums', itemKey: 'ar1' }),
			makeResult({ resultType: 'album', title: 'Little Aftershocks', itemKey: 'al1' })
		]);
		await tick();

		// The artist renders as a compact row…
		const artistRow = screen.getByText('Tilda Arlen').closest('button');
		expect(artistRow?.classList.contains('result-row')).toBe(true);
		// …while the album keeps its artwork card.
		const albumCard = screen.getByText('Little Aftershocks').closest('button');
		expect(albumCard?.classList.contains('item-card')).toBe(true);
		expect(container.querySelector('.result-rows')).not.toBeNull();
	});

	it('collapses "0 Albums" collaborator entries behind a toggle (2026-07-10 redesign)', async () => {
		render(Search);
		setSearchResults([
			makeResult({ resultType: 'artist', title: 'Lio-Marcus Mendel', subtitle: '11 Albums', itemKey: 'a1' }),
			makeResult({ resultType: 'artist', title: 'LMM, Zion & Lennox', subtitle: '0 Albums', itemKey: 'a2' }),
			makeResult({ resultType: 'artist', title: 'Ben Platt & LMM', subtitle: '0 Albums', itemKey: 'a3' })
		]);
		await tick();

		// Real match visible; empty-library collaborators hidden.
		expect(screen.getByText('Lio-Marcus Mendel')).toBeInTheDocument();
		expect(screen.queryByText('LMM, Zion & Lennox')).toBeNull();
		// The header counts only entries with library content.
		expect(screen.getByText(/1 of 1/)).toBeInTheDocument();

		// The toggle names what it's hiding and reveals on demand.
		await userEvent.click(
			screen.getByRole('button', { name: /Show 2 more not in your library/i })
		);
		expect(screen.getByText('LMM, Zion & Lennox')).toBeInTheDocument();
		expect(screen.getByText('Ben Platt & LMM')).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /not in your library/i })).toBeNull();
	});

	it('track rows render a ⋮ that fires onTrackMore without triggering the row click', async () => {
		const onResultClick = vi.fn();
		const onTrackMore = vi.fn();
		render(Search, { onResultClick, onTrackMore });
		setSearchResults([
			makeResult({ resultType: 'track', title: 'My Shot', itemKey: 't1', subtitle: 'LMM' }),
			makeResult({ resultType: 'album', title: 'Hamilton', itemKey: 'a1' })
		]);
		await tick();

		await userEvent.click(screen.getByRole('button', { name: /More options for My Shot/i }));
		expect(onTrackMore).toHaveBeenCalledWith(expect.objectContaining({ itemKey: 't1' }));
		expect(onResultClick).not.toHaveBeenCalled();

		// Non-track rows get no ⋮.
		expect(screen.queryByRole('button', { name: /More options for Hamilton/i })).toBeNull();
	});

	it('renders no ⋮ when onTrackMore is not provided', async () => {
		render(Search);
		setSearchResults([makeResult({ resultType: 'track', title: 'My Shot', itemKey: 't1' })]);
		await tick();

		expect(screen.queryByRole('button', { name: /More options/i })).toBeNull();
	});

	it('disables result buttons that have no itemKey', async () => {
		render(Search);
		setSearchResults([
			makeResult({ resultType: 'album', title: 'No key', itemKey: undefined })
		]);
		await tick();

		const titleEl = screen.getByText('No key');
		const button = titleEl.closest('button');
		expect(button).toBeDisabled();
	});

	it('uses the correlated Classic search API when the user submits a query', async () => {
		render(Search, { props: { sessionClaim: TEST_CLAIM } });
		const input = screen.getByPlaceholderText(/search artists, albums, tracks/i);
		await userEvent.type(input, 'beatles');
		await userEvent.click(screen.getByRole('button', { name: /^search$/i }));

		expect(apiBrowseSearch).toHaveBeenCalledWith(
			expect.any(Function),
			expect.objectContaining({ input: 'beatles', popAll: true }),
			TEST_CLAIM,
			'classic-search'
		);
	});

	it('routes through onSubmit when provided, skipping the direct socket emit', async () => {
		const onSubmit = vi.fn();
		render(Search, { props: { onSubmit } });
		const input = screen.getByPlaceholderText(/search artists, albums, tracks/i);
		await userEvent.type(input, 'beatles');
		await userEvent.click(screen.getByRole('button', { name: /^search$/i }));

		// Layout's submit interceptor was called…
		expect(onSubmit).toHaveBeenCalledWith('beatles');
		// …and the component did not issue its own request.
		expect(apiBrowseSearch).not.toHaveBeenCalled();
	});

	it('does not emit when the query is whitespace', async () => {
		render(Search);
		const input = screen.getByPlaceholderText(/search artists, albums, tracks/i);
		await userEvent.type(input, '   ');
		const button = screen.getByRole('button', { name: /^search$/i });
		expect(button).toBeDisabled();
		expect(apiBrowseSearch).not.toHaveBeenCalled();
	});

	it('resets per-group pagination when the query changes', async () => {
		const albums = Array.from({ length: 20 }, (_, i) =>
			makeResult({ resultType: 'album', title: `Album ${i + 1}`, itemKey: `a${i}` })
		);
		render(Search);
		setSearchLoading('first');
		setSearchResults(albums);
		await tick();

		await userEvent.click(screen.getByRole('button', { name: /show more albums/i }));
		expect(screen.getByText('Album 20')).toBeInTheDocument();

		// New query lands — group should re-collapse to first page.
		setSearchLoading('second');
		setSearchResults(albums);
		await tick();
		expect(screen.queryByText('Album 20')).toBeNull();
		expect(screen.getByText('Album 12')).toBeInTheDocument();
	});
});
