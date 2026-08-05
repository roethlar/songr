import type { BrowseItem, BrowseResult, SearchResult } from '@shared/types';

/**
 * Minimal `BrowseResult` for tests. Overrides win; `items.length` drives
 * `count` / `totalCount` unless explicitly overridden.
 */
export function listResult(over: Partial<BrowseResult> = {}): BrowseResult {
	return {
		title: over.title ?? 'Browse',
		subtitle: over.subtitle,
		level: over.level ?? 0,
		offset: over.offset ?? 0,
		count: over.count ?? (over.items?.length ?? 0),
		totalCount: over.totalCount ?? (over.items?.length ?? 0),
		items: over.items ?? []
	};
}

/** Minimal `BrowseItem`. */
export function makeItem(over: Partial<BrowseItem> = {}): BrowseItem {
	return {
		title: over.title ?? 'Item',
		subtitle: over.subtitle,
		itemKey: over.itemKey,
		hint: over.hint ?? 'list',
		imageKey: over.imageKey,
		isLoadable: over.isLoadable ?? true,
		isPlayable: over.isPlayable ?? false,
		itemType: over.itemType,
		inputPrompt: over.inputPrompt
	};
}

/**
 * `SearchResult` is `BrowseItem` + `resultType`. `resultType` is
 * required (a Search result without a type is meaningless), so the
 * caller must always supply it.
 */
export function makeSearchResult(
	over: Partial<SearchResult> & { resultType: SearchResult['resultType'] }
): SearchResult {
	return {
		...makeItem(over),
		resultType: over.resultType,
		categoryTitle: over.categoryTitle,
		categoryTotal: over.categoryTotal
	};
}
