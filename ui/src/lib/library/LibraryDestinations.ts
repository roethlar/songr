import { CLASSIC_BROWSE_PAGE_SIZE_MAX, CLASSIC_LOAD_COUNT_MAX } from '@shared/classicBrowseContracts';
import type { BrowseItem, BrowseResult } from '@shared/types';
import {
	createPublicNavigationDestinationId, parsePublicNavigationDestinationId,
	getNavigationDestinationLabel, MAX_CUSTOM_NAVIGATION_DESTINATIONS,
	type NavigationDestinationId, type PublicNavigationDestinationId,
	type NavigationPathSegment
} from '@shared/navigationSettings';
import type { ClassicBrowseApiTransaction } from '$lib/api/client';
import {
	normalizeBrowseHistorySnapshot,
	type BrowseHistorySnapshot
} from '$lib/libraryPageState';
import { browseBreadcrumbMatches } from './browseSemantics';

export type PublicLibraryDestinationId = 'tracks' | 'composers' | 'internet-radio' | 'tags';
export type LibraryCollectionSort = 'original' | 'name-asc' | 'name-desc' | 'artist-asc' | 'artist-desc';
export type LibraryDestinationTransaction = Pick<ClassicBrowseApiTransaction, 'browse' | 'browseLoad'>;

export interface LibraryDestination {
	id: PublicLibraryDestinationId | PublicNavigationDestinationId | 'browse';
	label: string;
	/** Only semantic breadcrumbs survive discovery; live item keys never do. */
	snapshot: BrowseHistorySnapshot;
}

export interface LibraryCollectionDiagnostic {
	message: string;
	isError?: boolean;
	action?: string;
}

export interface LibraryDestinationInventory {
	destinations: LibraryDestination[];
	fallback: LibraryDestination;
	diagnostics: Array<LibraryCollectionDiagnostic & { branch: string }>;
}

export interface LibraryCollectionModel {
	snapshot: BrowseHistorySnapshot;
	result: BrowseResult;
	items: BrowseItem[];
	/** Null means Roon did not provide a valid collection total. */
	totalCount: number | null;
	complete: boolean;
	diagnostic?: LibraryCollectionDiagnostic;
}

export class LibraryCollectionPathError extends Error {}

export interface LibraryCollectionOptions {
	zoneId?: string;
	/** Refuse partial local filtering instead of silently truncating larger lists. */
	maxItems?: number;
}

export const MAX_COLLECTION_ITEMS = 100_000;
const MAX_LOAD_PAGES = 1_000;
const INVENTORY_MAX_ITEMS = 1_000;
const DESTINATIONS = [
	{ id: 'tracks', label: 'Tracks', titles: ['tracks'] },
	{ id: 'composers', label: 'Composers', titles: ['composers'] },
	{ id: 'tags', label: 'Tags', titles: ['tags'] }
] as const;
const RADIO_TITLES = ['my live radio', 'live radio', 'internet radio'];
const textCollator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

function rootSnapshot(): BrowseHistorySnapshot {
	return { context: { hierarchy: 'browse' }, history: [], forward: [] };
}

/** These are destinations, not claims that the current Core returned populated data. */
export const DEFAULT_PUBLIC_LIBRARY_DESTINATIONS: readonly LibraryDestination[] = [
	...DESTINATIONS.map(({ id, label }) => ({ id, label, snapshot: {
		context: { hierarchy: 'browse' as const },
		history: ['Library', label].map((title) => ({ hierarchy: 'browse' as const, breadcrumb: { title } })),
		forward: []
	} })),
	{ id: 'internet-radio', label: 'Live radio', snapshot: {
		context: { hierarchy: 'browse' },
		history: [{ hierarchy: 'browse', breadcrumb: { title: 'My Live Radio' } }], forward: []
	} }
];

export function createDefaultLibraryDestinationInventory(): LibraryDestinationInventory {
	return {
		destinations: DEFAULT_PUBLIC_LIBRARY_DESTINATIONS.map((destination) => ({
			...destination, snapshot: normalizePath(destination.snapshot)
		})),
		fallback: { id: 'browse', label: 'Browse', snapshot: rootSnapshot() },
		diagnostics: []
	};
}

/** Saved public paths remain selectable while their Core is unavailable or reconnecting. */
export function resolveLibraryDestination(
	id: NavigationDestinationId,
	inventory?: LibraryDestinationInventory | null
): LibraryDestination | null {
	const existing = inventory?.destinations.find((destination) => destination.id === id)
		?? DEFAULT_PUBLIC_LIBRARY_DESTINATIONS.find((destination) => destination.id === id);
	if (existing) return { ...existing, snapshot: normalizePath(existing.snapshot) };
	const segments = parsePublicNavigationDestinationId(id);
	if (!segments) return null;
	return {
		id: id as PublicNavigationDestinationId,
		label: getNavigationDestinationLabel(id),
		snapshot: { context: { hierarchy: 'browse' },
			history: segments.map((breadcrumb) => ({ hierarchy: 'browse', breadcrumb })), forward: [] }
	};
}

function normalizePath(snapshot: BrowseHistorySnapshot): BrowseHistorySnapshot {
	const normalized = normalizeBrowseHistorySnapshot(snapshot);
	if (!normalized || normalized.context.hierarchy !== 'browse') {
		throw new TypeError('Library destinations require a semantic Browse path');
	}
	return { ...normalized, forward: [] };
}

function browseOptions(zoneId?: string) {
	return { hierarchy: 'browse', ...(zoneId ? { zoneId } : {}) };
}

function itemLimit(options: LibraryCollectionOptions): number {
	const limit = options.maxItems ?? MAX_COLLECTION_ITEMS;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_COLLECTION_ITEMS) {
		throw new RangeError(`Collection limit must be between 1 and ${MAX_COLLECTION_ITEMS}`);
	}
	return limit;
}

function responseDiagnostic(result: BrowseResult): LibraryCollectionDiagnostic | undefined {
	if (result.action === 'message' || result.message !== undefined || result.isError === true) {
		return {
			message: result.message || (result.isError ? 'Roon reported an error.' : 'Roon returned a message.'),
			...(result.isError !== undefined ? { isError: result.isError } : {}),
			...(result.action !== undefined ? { action: result.action } : {})
		};
	}
	if (result.listHint === 'action_list') return { message: 'Roon returned an action list.' };
	if (result.action !== undefined && result.action !== 'list') {
		return { message: 'Roon did not return a collection.', action: result.action };
	}
	return undefined;
}

function failure(message: string): LibraryCollectionDiagnostic {
	return { message, isError: true };
}

function initialModel(result: BrowseResult, snapshot: BrowseHistorySnapshot): LibraryCollectionModel {
	// BrowseService preserves Roon list.count as the collection size on every
	// page. The items array, not count, measures the returned slice.
	const total = result.totalCount;
	const totalCount = Number.isSafeInteger(total) && (total as number) >= 0 ? total! : null;
	const diagnostic = responseDiagnostic(result)
		?? (totalCount === null ? failure('Roon did not report a valid collection total.') : undefined)
		?? (result.offset !== 0 || result.count !== totalCount || result.items.length > totalCount!
			? failure('Roon returned an inconsistent collection page.') : undefined);
	return {
		snapshot,
		result,
		items: [...result.items],
		totalCount,
		complete: !diagnostic && result.items.length === totalCount,
		...(diagnostic ? { diagnostic } : {})
	};
}

export async function collectLibraryCollectionLevel(
	transaction: LibraryDestinationTransaction,
	result: BrowseResult,
	snapshot: BrowseHistorySnapshot,
	options: LibraryCollectionOptions = {},
	hierarchy: string = snapshot.context.hierarchy
): Promise<LibraryCollectionModel> {
	const model = initialModel(result, snapshot);
	if (model.diagnostic) return model;
	if (model.totalCount! > itemLimit(options)) {
		return { ...model, complete: false, diagnostic: failure('This collection is too large to filter or sort completely.') };
	}
	const seenKeys = new Set<string>();
	const rememberKeys = (items: readonly BrowseItem[]): boolean => {
		for (const item of items) {
			if (!item.itemKey) continue;
			if (seenKeys.has(item.itemKey)) return false;
			seenKeys.add(item.itemKey);
		}
		return true;
	};
	if (!rememberKeys(model.items)) return { ...model, complete: false, diagnostic: failure('Roon repeated an item while loading this collection.') };
	let pageCount = 0;
	while (model.items.length < model.totalCount!) {
		if (++pageCount > MAX_LOAD_PAGES) {
			return { ...model, complete: false, diagnostic: failure('Roon returned too many partial collection pages.') };
		}
		const offset = model.items.length;
		const page = await transaction.browseLoad({
			hierarchy, ...(options.zoneId ? { zoneId: options.zoneId } : {}),
			offset,
			count: Math.min(CLASSIC_LOAD_COUNT_MAX, model.totalCount! - offset)
		});
		const diagnostic = responseDiagnostic(page);
		if (diagnostic) return { ...model, result: page, complete: false, diagnostic };
		if (page.offset !== offset || page.count !== model.totalCount || page.items.length === 0
			|| page.totalCount !== model.totalCount || offset + page.items.length > model.totalCount!
			|| page.level !== result.level || (page.title !== undefined && result.title !== undefined && page.title !== result.title)) {
			return { ...model, complete: false, diagnostic: failure('The collection changed or ended before every item was loaded.') };
		}
		if (!rememberKeys(page.items)) return { ...model, complete: false, diagnostic: failure('Roon repeated an item while loading this collection.') };
		model.items.push(...page.items);
	}
	return {
		...model,
		complete: true,
		result: { ...result, offset: 0, count: model.items.length, items: model.items }
	};
}

function safeListItem(item: BrowseItem): boolean {
	return Boolean(item.itemKey) && Boolean(item.title.trim()) && item.inputPrompt === undefined
		&& !['action', 'action_list', 'header'].includes(item.hint ?? '');
}

/** Re-resolve current authority inside the caller's isolated Browse transaction. */
async function openPath(
	transaction: LibraryDestinationTransaction,
	snapshot: BrowseHistorySnapshot,
	options: LibraryCollectionOptions
): Promise<LibraryCollectionModel> {
	const path = normalizePath(snapshot);
	let result = await transaction.browse({
		...browseOptions(options.zoneId), popAll: true, pageSize: CLASSIC_BROWSE_PAGE_SIZE_MAX
	});
	const resolved = rootSnapshot();
	for (const step of path.history) {
		const parent = await collectLibraryCollectionLevel(transaction, result, resolved, { ...options, maxItems: INVENTORY_MAX_ITEMS });
		if (!parent.complete) return parent;
		const matches = parent.items.filter((item) => browseBreadcrumbMatches(item, step.breadcrumb));
		if (matches.length !== 1 || !safeListItem(matches[0])) {
			throw new LibraryCollectionPathError(matches.length > 1
				? `“${step.breadcrumb.title}” is ambiguous.`
				: `“${step.breadcrumb.title}” is no longer an available collection.`);
		}
		result = await transaction.browse({
			...browseOptions(options.zoneId), itemKey: matches[0].itemKey,
			pageSize: CLASSIC_BROWSE_PAGE_SIZE_MAX
		});
		resolved.history.push(step);
	}
	return initialModel(result, resolved);
}

function childPath(parent: BrowseHistorySnapshot, item: BrowseItem): BrowseHistorySnapshot {
	return {
		context: { hierarchy: 'browse' },
		history: [...parent.history, {
			hierarchy: 'browse',
			// Counts/subtitles and artwork keys can change independently of this branch.
			// Match the unique returned collection title afresh on every restore.
			breadcrumb: { title: item.title }
		}],
		forward: []
	};
}

/**
 * Read the public root and Library container only. A returned destination's empty,
 * loading or error response belongs inside that page, never in navigation policy.
 * No child page, action, prompt or playlist is opened during discovery.
 */
export async function discoverLibraryDestinations(
	transaction: LibraryDestinationTransaction,
	options: Pick<LibraryCollectionOptions, 'zoneId'> = {}
): Promise<LibraryDestinationInventory> {
	const inventory = createDefaultLibraryDestinationInventory();
	const note = (branch: string, model: LibraryCollectionModel) => {
		if (model.diagnostic) inventory.diagnostics.push({ branch, ...model.diagnostic });
	};
	const diagnose = (branch: string, message: string) => inventory.diagnostics.push({ branch, ...failure(message) });
	const find = (items: BrowseItem[], titles: readonly string[], branch: string): BrowseItem | undefined => {
		const matches = items.filter((item) => titles.includes(item.title.trim().toLowerCase()));
		if (matches.length > 1) diagnose(branch, 'Roon returned more than one matching collection.');
		return matches.length === 1 && safeListItem(matches[0]) ? matches[0] : undefined;
	};
	const promote = (parent: BrowseHistorySnapshot, items: BrowseItem[]) => {
		const atRoot = parent.history.length === 0;
		const excluded = new Set(atRoot ? ['library', 'settings', 'genres', 'playlists', 'artists', 'albums', 'search']
			: ['search', 'artists', 'albums', 'genres', 'settings', 'playlists']);
		const knownTitles = new Set<string>([...DESTINATIONS.flatMap((spec) => [...spec.titles]), ...RADIO_TITLES]);
		for (const spec of [...DESTINATIONS, { id: 'internet-radio' as const, label: 'Live radio', titles: RADIO_TITLES }]) {
			const item = find(items, spec.titles, spec.label);
			if (!item) continue;
			const index = inventory.destinations.findIndex((destination) => destination.id === spec.id);
			inventory.destinations[index] = { id: spec.id, label: spec.label, snapshot: childPath(parent, item) };
		}
		for (const item of items) {
			const title = item.title.trim().toLowerCase();
			if (excluded.has(title) || knownTitles.has(title)) continue;
			if (!safeListItem(item)) {
				if (item.itemKey && item.hint !== 'header') diagnose(item.title, 'This public entry requires an action or input rather than opening a collection.');
				continue;
			}
			let snapshot = childPath(parent, item);
			// Same-title sources need returned semantic context; neither order nor
			// session-bound keys may distinguish durable navigation destinations.
			if (items.filter((candidate) => candidate.title === item.title).length > 1) {
				const breadcrumb = { title: item.title, ...(item.subtitle ? { subtitle: item.subtitle } : {}),
					...(item.itemType ? { itemType: item.itemType } : {}) };
				if (items.filter((candidate) => browseBreadcrumbMatches(candidate, breadcrumb)).length !== 1) {
					diagnose(item.title, 'Roon returned ambiguous collection names.');
					continue;
				}
				snapshot = { ...snapshot, history: [...parent.history, { hierarchy: 'browse', breadcrumb }] };
			}
			if (inventory.destinations.filter((destination) => destination.id.startsWith('public:')).length >= MAX_CUSTOM_NAVIGATION_DESTINATIONS) {
				diagnose(item.title, 'Roon returned more custom destinations than navigation can retain.');
				continue;
			}
			try {
				const id = createPublicNavigationDestinationId(snapshot.history.map((step) => step.breadcrumb as NavigationPathSegment));
				if (!inventory.destinations.some((destination) => destination.id === id)) {
					inventory.destinations.push({ id, label: getNavigationDestinationLabel(id), snapshot });
				}
			} catch {
				diagnose(item.title, 'This collection name is too long to retain as a navigation destination.');
			}
		}
	};
	const root = await loadCompleteLibraryCollection(transaction, rootSnapshot(), { ...options, maxItems: INVENTORY_MAX_ITEMS });
	if (!root.complete) { note('root', root); return inventory; }
	promote(rootSnapshot(), root.items);
	const libraryRow = find(root.items, ['library'], 'Library');
	if (libraryRow) {
		const libraryPath = childPath(rootSnapshot(), libraryRow);
		const libraryResult = await transaction.browse({
			...browseOptions(options.zoneId), itemKey: libraryRow.itemKey, pageSize: CLASSIC_BROWSE_PAGE_SIZE_MAX
		});
		const library = await collectLibraryCollectionLevel(transaction, libraryResult, libraryPath, { ...options, maxItems: INVENTORY_MAX_ITEMS });
		if (!library.complete) note('Library', library);
		else promote(libraryPath, library.items);
	}
	return inventory;
}

/** A path may identify a known collection or one of its descendants. */
export function identifyLibraryDestination(
	snapshot: BrowseHistorySnapshot,
	inventory: LibraryDestinationInventory
): PublicLibraryDestinationId | PublicNavigationDestinationId | 'browse' {
	const path = normalizeBrowseHistorySnapshot(snapshot);
	if (!path || path.context.hierarchy !== 'browse') return 'browse';
	const destination = inventory.destinations.find((candidate) => pathMatches(path, candidate.snapshot));
	return destination?.id ?? 'browse';
}

function pathMatches(path: BrowseHistorySnapshot, root: BrowseHistorySnapshot): boolean {
	return path.context.hierarchy === 'browse' && root.context.hierarchy === 'browse'
		&& path.history.length >= root.history.length
		&& root.history.every((step, index) => browseBreadcrumbMatches({
			...path.history[index].breadcrumb, isLoadable: false, isPlayable: false
		}, step.breadcrumb));
}

export function isLibraryDestinationRoot(snapshot: BrowseHistorySnapshot, destination: LibraryDestination): boolean {
	const path = normalizeBrowseHistorySnapshot(snapshot);
	return Boolean(path && path.history.length === destination.snapshot.history.length && pathMatches(path, destination.snapshot));
}

/**
 * Prune public branches represented by top-level destinations. Empty destination
 * contents do not change whether its legacy entry is redundant.
 * Playlists is intentionally unavailable: public Item has no manual/smart flag.
 * This changes visible rows, not Roon's total; callers must label counts honestly.
 */
export function filterRedundantBrowseItems(
	snapshot: BrowseHistorySnapshot,
	items: readonly BrowseItem[],
	inventory: LibraryDestinationInventory | null
): BrowseItem[] {
	const path = normalizeBrowseHistorySnapshot(snapshot);
	if (!path || path.context.hierarchy !== 'browse') return [...items];
	const atRoot = path.history.length === 0;
	const atLibrary = path.history.length === 1 && path.history[0].breadcrumb.title === 'Library';
	if (!atRoot && !atLibrary) return [...items];
	const duplicates = new Set(atRoot ? ['Settings', 'Genres', 'Playlists'] : ['Search', 'Artists', 'Albums']);
	return items.filter((item) => {
		// The documented root Playlists branch cannot establish manual eligibility.
		if (atRoot && item.title === 'Playlists') return false;
		if (duplicates.has(item.title) && (item.hint === 'list' || safeListItem(item))) return false;
		if (!safeListItem(item)) return true;
		return !(inventory?.destinations ?? []).some((destination) => {
			const target = destination.snapshot;
			return target.history.length === path.history.length + 1
				&& pathMatches(target, path)
				&& browseBreadcrumbMatches(item, target.history.at(-1)!.breadcrumb);
		});
	});
}

export async function loadCompleteLibraryCollection(
	transaction: LibraryDestinationTransaction,
	snapshot: BrowseHistorySnapshot,
	options: LibraryCollectionOptions = {}
): Promise<LibraryCollectionModel> {
	itemLimit(options);
	const opened = await openPath(transaction, snapshot, options);
	if (opened.diagnostic) return opened;
	return collectLibraryCollectionLevel(transaction, opened.result, opened.snapshot, options);
}

/** Filter documented display text only; preserve source order for equal names. */
export function filterSortLibraryCollection(
	model: LibraryCollectionModel,
	options: { filter?: string; sort?: LibraryCollectionSort } = {}
): { items: BrowseItem[]; totalCount: number; matchCount: number } {
	if (!model.complete || model.diagnostic || model.totalCount !== model.items.length) {
		throw new Error('Load the complete collection before filtering or sorting it.');
	}
	const query = (options.filter ?? '').trim().toLocaleLowerCase();
	const items = model.items.filter((item) => !query
		|| `${item.title}\n${item.subtitle ?? ''}`.toLocaleLowerCase().includes(query));
	if (options.sort === 'name-asc' || options.sort === 'name-desc') {
		const direction = options.sort === 'name-desc' ? -1 : 1;
		items.sort((a, b) => direction * textCollator.compare(a.title, b.title));
	} else if (options.sort === 'artist-asc' || options.sort === 'artist-desc') {
		const direction = options.sort === 'artist-desc' ? -1 : 1;
		items.sort((a, b) => {
			// Tracks supplies the displayed credit line; keep it intact.
			const artistA = a.subtitle?.trim() ?? '';
			const artistB = b.subtitle?.trim() ?? '';
			if (Boolean(artistA) !== Boolean(artistB)) return artistA ? -1 : 1;
			return direction * textCollator.compare(artistA, artistB) || textCollator.compare(a.title, b.title);
		});
	}
	return { items, totalCount: model.totalCount, matchCount: items.length };
}
