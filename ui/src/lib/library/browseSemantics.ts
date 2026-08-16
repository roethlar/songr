import { searchTypeForToken } from '@shared/searchTypes';
import type { BrowseItem, SearchResult } from '@shared/types';
import type { BrowseBreadcrumb } from '$lib/libraryPageState';

/** Roon's search-category count is volatile; only its shape is semantic. */
export function isBrowseSearchCategorySubtitle(subtitle?: string): boolean {
	return /^\d+\s+results?$/i.test(subtitle ?? '');
}

function itemTypeMatches(actual: string | undefined, expected: string): boolean {
	const normalizedActual = (actual ?? '').toLowerCase().replace(/s$/, '');
	const normalizedExpected = expected.toLowerCase().replace(/s$/, '');
	return normalizedActual === normalizedExpected;
}

/** Build a durable breadcrumb without copying live Roon authority. */
export function browseBreadcrumbFor(item: BrowseItem): BrowseBreadcrumb | undefined {
	if (!item.title?.trim()) return undefined;
	return {
		title: item.title,
		...(item.subtitle?.trim() ? { subtitle: item.subtitle } : {}),
		...(item.imageKey?.trim() ? { imageKey: item.imageKey } : {}),
		...(item.itemType?.trim() ? { itemType: item.itemType } : {})
	};
}

/** Match one live row against a keyless semantic history step. */
export function browseBreadcrumbMatches(
	candidate: BrowseItem,
	breadcrumb: BrowseBreadcrumb
): boolean {
	if (breadcrumb.searchCategory) {
		return (
			candidate.hint === 'list' &&
			candidate.title === breadcrumb.title &&
			isBrowseSearchCategorySubtitle(candidate.subtitle)
		);
	}
	if (candidate.title !== breadcrumb.title) return false;
	if (breadcrumb.subtitle && candidate.subtitle !== breadcrumb.subtitle) return false;
	if (breadcrumb.imageKey && candidate.imageKey !== breadcrumb.imageKey) return false;
	if (breadcrumb.itemType && !itemTypeMatches(candidate.itemType, breadcrumb.itemType)) {
		return false;
	}
	return true;
}

function optionalFieldMatches(left?: string, right?: string): boolean {
	return !left || !right || left === right;
}

function semanticType(item: BrowseItem): string | undefined {
	const resultType = (item as BrowseItem & { resultType?: SearchResult['resultType'] })
		.resultType;
	return item.itemType ?? (resultType && resultType !== 'unknown' ? resultType : undefined);
}

export function browseSearchItemMatches(candidate: BrowseItem, original: BrowseItem): boolean {
	if (candidate.title !== original.title) return false;
	if (!optionalFieldMatches(candidate.subtitle, original.subtitle)) return false;
	if (!optionalFieldMatches(candidate.hint, original.hint)) return false;
	if (!optionalFieldMatches(candidate.imageKey, original.imageKey)) return false;
	if (!optionalFieldMatches(semanticType(candidate), semanticType(original))) return false;
	return true;
}

function concreteMatchScore(candidate: BrowseItem, original: BrowseItem): number {
	let score = 0;
	if (candidate.subtitle && original.subtitle && candidate.subtitle === original.subtitle) score += 1;
	if (candidate.imageKey && original.imageKey && candidate.imageKey === original.imageKey) score += 1;
	if (candidate.hint && original.hint && candidate.hint === original.hint) score += 1;
	const candidateType = semanticType(candidate);
	const originalType = semanticType(original);
	if (candidateType && originalType && candidateType === originalType) score += 1;
	return score;
}

/**
 * Select the best live row for a keyless search descriptor. Optional fields
 * are wildcards, so exact concrete agreement wins before stable first-match.
 */
export function selectBrowseSearchItem(
	items: readonly BrowseItem[],
	original: BrowseItem
): BrowseItem | undefined {
	const candidates = items.filter(
		(candidate) => candidate.itemKey && browseSearchItemMatches(candidate, original)
	);
	if (candidates.length <= 1) return candidates[0];
	return candidates.reduce((best, candidate) =>
		concreteMatchScore(candidate, original) > concreteMatchScore(best, original)
			? candidate
			: best
	);
}

/** Find the live category stub for one grouped, keyless search result. */
export function findBrowseSearchCategoryRow(
	items: readonly BrowseItem[],
	item: BrowseItem
): BrowseItem | undefined {
	const resultType = (item as BrowseItem & { resultType?: SearchResult['resultType'] })
		.resultType;
	if (!resultType || resultType === 'unknown') return undefined;
	return items.find(
		(candidate) =>
			Boolean(candidate.itemKey) &&
			candidate.hint === 'list' &&
			isBrowseSearchCategorySubtitle(candidate.subtitle) &&
			searchTypeForToken(candidate.title) === resultType
	);
}
