import { browser } from '$app/environment';
import { writable, type Readable } from 'svelte/store';

export type LibraryView = 'classic' | 'timeline' | 'unified';

export const CLASSIC_LIBRARY_VIEW: LibraryView = 'classic';
export const DEFAULT_LIBRARY_VIEW: LibraryView = 'unified';
export const LIBRARY_VIEW_PREFERENCE_VERSION = 1;
export const LIBRARY_VIEW_STORAGE_KEY = 'roon-controller-library-view';

// Release policy, not a user preference. Later release work may enable the
// already-tested path only after every production gate has passed.
export const TIMELINE_LIBRARY_VIEW_AVAILABLE = false;
// Production release gate for the Unified Library surface. Enabled only after
// the plan's owner-acceptance, catalog-refresh, and live-action gates passed.
export const UNIFIED_LIBRARY_VIEW_AVAILABLE = true;

export interface LibraryViewAvailabilityOptions {
	/** `import.meta.env.DEV` at the call site; production builds inline `false`. */
	readonly dev: boolean;
}

const DEFAULT_AVAILABILITY: LibraryViewAvailabilityOptions = Object.freeze({
	dev: import.meta.env.DEV === true
});

/**
 * Reachability combines the production release flag with the retained dev
 * preview path used while a future gated view is under construction.
 */
export function isUnifiedLibraryViewReachable(
	options: LibraryViewAvailabilityOptions = DEFAULT_AVAILABILITY
): boolean {
	return UNIFIED_LIBRARY_VIEW_AVAILABLE || options.dev === true;
}

interface PersistedLibraryViewPreference {
	version: typeof LIBRARY_VIEW_PREFERENCE_VERSION;
	preferred: LibraryView;
}

interface LibraryViewStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

export interface LibraryViewPreferenceStore extends Readable<LibraryView> {
	commit(value: unknown): boolean;
}

interface LibraryViewPreferenceStoreOptions {
	isBrowser: boolean;
	getStorage?: () => LibraryViewStorage;
}

export function isLibraryView(value: unknown): value is LibraryView {
	return value === 'classic' || value === 'timeline' || value === 'unified';
}

function parsePersistedPreference(raw: string | null): LibraryView {
	if (raw === null) return DEFAULT_LIBRARY_VIEW;

	try {
		const value = JSON.parse(raw) as unknown;
		if (value === null || typeof value !== 'object' || Array.isArray(value)) {
			return DEFAULT_LIBRARY_VIEW;
		}

		const record = value as Record<string, unknown>;
		if (Object.keys(record).sort().join(',') !== 'preferred,version') {
			return DEFAULT_LIBRARY_VIEW;
		}
		if (record.version !== LIBRARY_VIEW_PREFERENCE_VERSION) {
			return DEFAULT_LIBRARY_VIEW;
		}
		return isLibraryView(record.preferred) ? record.preferred : DEFAULT_LIBRARY_VIEW;
	} catch {
		return DEFAULT_LIBRARY_VIEW;
	}
}

function serializePreference(preferred: LibraryView): string {
	const value: PersistedLibraryViewPreference = {
		version: LIBRARY_VIEW_PREFERENCE_VERSION,
		preferred
	};
	return JSON.stringify(value);
}

export function createLibraryViewPreferenceStore({
	isBrowser,
	getStorage = () => window.localStorage
}: LibraryViewPreferenceStoreOptions): LibraryViewPreferenceStore {
	function readPersisted(): LibraryView {
		if (!isBrowser) return DEFAULT_LIBRARY_VIEW;
		try {
			return parsePersistedPreference(getStorage().getItem(LIBRARY_VIEW_STORAGE_KEY));
		} catch {
			return DEFAULT_LIBRARY_VIEW;
		}
	}

	const internal = writable<LibraryView>(readPersisted());

	return {
		subscribe: internal.subscribe,
		commit(value: unknown): boolean {
			if (!isBrowser || !isLibraryView(value)) return false;
			// Persist before publishing so the future activation transaction can
			// treat a failed write as a failed preference commit.
			try {
				getStorage().setItem(LIBRARY_VIEW_STORAGE_KEY, serializePreference(value));
			} catch {
				return false;
			}
			internal.set(value);
			return true;
		}
	};
}

const preferredLibraryView = createLibraryViewPreferenceStore({ isBrowser: browser });

export const libraryViewStore: Readable<LibraryView> = {
	subscribe: preferredLibraryView.subscribe
};

export function commitPreferredLibraryView(value: unknown): boolean {
	return preferredLibraryView.commit(value);
}

export function resolveAvailableLibraryView(
	preferred: unknown,
	options: LibraryViewAvailabilityOptions = DEFAULT_AVAILABILITY
): LibraryView {
	if (preferred === 'timeline' && TIMELINE_LIBRARY_VIEW_AVAILABLE) return 'timeline';
	if (preferred === 'unified' && isUnifiedLibraryViewReachable(options)) return 'unified';
	return CLASSIC_LIBRARY_VIEW;
}

export function getAvailableLibraryViews(
	options: LibraryViewAvailabilityOptions = DEFAULT_AVAILABILITY
): readonly LibraryView[] {
	const views: LibraryView[] = ['classic'];
	if (TIMELINE_LIBRARY_VIEW_AVAILABLE) views.push('timeline');
	if (isUnifiedLibraryViewReachable(options)) views.push('unified');
	return Object.freeze(views);
}
