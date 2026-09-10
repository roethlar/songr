import type { BrowseItem } from '@shared/types';
import type { NavigationDestinationId } from '@shared/navigationSettings';
import type { UnifiedSongActionSemantic } from '@shared/unifiedSearchContracts';
import type { UnifiedBrowseActionState, UnifiedBrowseState } from './UnifiedBrowseController';

export interface BrowseRowActions {
	enabled: boolean;
	busy: boolean;
	status: string | null;
	error: boolean;
	onAction: (item: BrowseItem, semantic: UnifiedSongActionSemantic) => void;
	onFavorite?: (item: BrowseItem) => void;
	onMore: (item: BrowseItem) => void;
	onCloseMore: () => void;
	menu?: {
		item: BrowseItem;
		state: UnifiedBrowseActionState;
		onChoose: (choice: BrowseItem) => void;
	};
}

export type BrowsePageKind = 'artist' | 'album' | 'composer' | 'work' | 'tracks' | 'recordings' | 'mixed' | 'list';
export interface BrowsePagePresentation {
	kind: BrowsePageKind;
	bulkItems: readonly BrowseItem[];
	contentItems: readonly BrowseItem[];
	sectionLabel: string | null;
}

const structuralPages = new Map<string, BrowsePageKind>([
	['play artist', 'artist'], ['play album', 'album'], ['play composer', 'composer'],
	['play composition', 'work'], ['play work', 'work']
]);
const bulkLabels = new Set([...structuralPages.keys(), 'play genre', 'play tag']);
const text = (value: string | undefined): string => value?.trim().toLowerCase() ?? '';

/** Structural verbs are presentation evidence, never an entity identity or a key match. */
export function isBrowseBulkItem(item: BrowseItem): boolean {
	return (item.hint === 'action' || item.hint === 'action_list') && item.subtitle === undefined && bulkLabels.has(text(item.title));
}

function explicitPageKind(value: string | undefined): BrowsePageKind | null {
	switch (text(value)) {
		case 'artist': case 'album': case 'composer': return text(value) as BrowsePageKind;
		case 'work': case 'composition': return 'work';
		default: return null;
	}
}

/** Classify only this returned page. Descriptors and exact selected rows stay untouched. */
export function classifyBrowsePage(state: UnifiedBrowseState, collectionId?: NavigationDestinationId): BrowsePagePresentation {
	const items = state.result?.items ?? [];
	const bulkItems = items.filter(isBrowseBulkItem);
	const contentItems = items.filter(item => !isBrowseBulkItem(item) && item.hint !== 'header');
	const structural = new Set(bulkItems.flatMap(item => {
		const kind = item.hint === 'action_list' && item.subtitle === undefined ? structuralPages.get(text(item.title)) : undefined;
		return kind ? [kind] : [];
	}));
	const last = state.snapshot.history.at(-1)?.breadcrumb;
	const explicit = explicitPageKind(last?.itemType);
	if (explicit) structural.add(explicit);
	let kind: BrowsePageKind = 'list';
	if (structural.size > 1) kind = 'mixed';
	else if (structural.size === 1) kind = [...structural][0];
	else if (collectionId === 'tracks' || (state.snapshot.context.hierarchy === 'search' && ['tracks', 'songs'].includes(text(last?.title)))) kind = 'tracks';
	else if (contentItems.length > 0 && contentItems.every(item => ['track', 'song'].includes(text(item.itemType)))) kind = 'tracks';
	else if (contentItems.length > 0 && contentItems.every(item => text(item.itemType) === 'recording')) kind = 'recordings';
	else if (state.snapshot.history.some(step => text(step.breadcrumb.title) === 'tags')) kind = 'mixed';

	// An explicit contradictory child type prevents an entity presentation. Missing types
	// are normal public Browse output and are not filled from subtitles or title guesses.
	const expected = kind === 'artist' ? ['album'] : kind === 'album' ? ['track', 'song']
		: kind === 'composer' ? ['composition', 'work'] : kind === 'work' ? ['track', 'recording'] : null;
	if (expected && contentItems.some(item => item.itemType && !expected.includes(text(item.itemType)))) kind = 'mixed';
	if ((kind === 'artist' || kind === 'composer') && contentItems.some(item =>
		!item.itemKey || Boolean(item.inputPrompt) || item.isPlayable || ['action', 'action_list'].includes(item.hint ?? ''))) kind = 'mixed';
	if (kind === 'work' && contentItems.some(item =>
		!item.itemKey || Boolean(item.inputPrompt) || (item.hint !== 'action_list' &&
			!(['track', 'recording'].includes(text(item.itemType)) && item.isPlayable)))) kind = 'mixed';
	return {
		kind, bulkItems, contentItems,
		sectionLabel: kind === 'composer' ? 'Compositions' : kind === 'work' || kind === 'recordings' ? 'Recordings' : null
	};
}

export type BrowseRowPresentation = 'track' | 'recording' | 'navigation' | 'actions' | 'display';
export function classifyBrowseRow(item: BrowseItem, page: BrowsePagePresentation): BrowseRowPresentation {
	if (!item.itemKey || item.hint === 'header') return 'display';
	if (item.inputPrompt) return 'navigation';
	if (page.kind === 'work' || page.kind === 'recordings' || text(item.itemType) === 'recording') return 'recording';
	if (page.kind === 'album' || page.kind === 'tracks' || ['track', 'song'].includes(text(item.itemType))) return 'track';
	if (item.hint === 'action' || item.hint === 'action_list' || item.isPlayable) return 'actions';
	return 'navigation';
}
