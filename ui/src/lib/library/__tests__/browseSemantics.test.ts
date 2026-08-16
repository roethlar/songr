import { describe, expect, it } from 'vitest';

import type { BrowseItem, SearchResult } from '@shared/types';
import {
	browseBreadcrumbFor,
	browseBreadcrumbMatches,
	findBrowseSearchCategoryRow,
	selectBrowseSearchItem
} from '../browseSemantics';

function item(over: Partial<BrowseItem> = {}): BrowseItem {
	return {
		title: 'Low',
		isLoadable: false,
		isPlayable: false,
		...over
	};
}

describe('browseSemantics', () => {
	it('builds keyless breadcrumbs and matches every persisted disambiguator', () => {
		const live = item({
			title: 'Blue',
			subtitle: 'Joni Mitchell',
			imageKey: 'image-blue',
			itemType: 'Albums',
			itemKey: 'volatile-key'
		});
		const breadcrumb = browseBreadcrumbFor(live);

		expect(breadcrumb).toEqual({
			title: 'Blue',
			subtitle: 'Joni Mitchell',
			imageKey: 'image-blue',
			itemType: 'Albums'
		});
		expect(JSON.stringify(breadcrumb)).not.toContain('volatile-key');
		expect(browseBreadcrumbMatches(item({ ...live, itemType: 'album' }), breadcrumb!)).toBe(
			true
		);
		expect(
			browseBreadcrumbMatches(item({ ...live, subtitle: 'Miles Davis' }), breadcrumb!)
		).toBe(false);
	});

	it('matches search-category history by stable shape rather than volatile count', () => {
		expect(
			browseBreadcrumbMatches(
				item({ title: 'Albums', subtitle: '99 Results', hint: 'list' }),
				{ title: 'Albums', subtitle: '3 Results', searchCategory: true }
			)
		).toBe(true);
		expect(
			browseBreadcrumbMatches(
				item({ title: 'Albums', subtitle: '99 Results', hint: 'action_list' }),
				{ title: 'Albums', searchCategory: true }
			)
		).toBe(false);
	});

	it('prefers the duplicate result with the most concrete semantic agreement', () => {
		const sparse = item({ title: 'Heroes', itemKey: 'sparse' });
		const exact = item({
			title: 'Heroes',
			subtitle: 'David Bowie',
			hint: 'action_list',
			itemType: 'track',
			itemKey: 'exact'
		});
		const original: SearchResult = {
			...item({ title: 'Heroes', subtitle: 'David Bowie', hint: 'action_list' }),
			resultType: 'track'
		};

		expect(selectBrowseSearchItem([sparse, exact], original)?.itemKey).toBe('exact');
	});

	it('uses the shared taxonomy to resolve Stations as radio', () => {
		const station = item({
			title: 'BBC Radio 3',
			resultType: 'radio'
		} as Partial<SearchResult>);
		const category = item({
			title: 'Stations',
			subtitle: '4 Results',
			hint: 'list',
			itemKey: 'stations-key'
		});

		expect(findBrowseSearchCategoryRow([category], station)?.itemKey).toBe('stations-key');
	});
});
