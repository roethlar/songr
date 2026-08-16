import { browser } from '$app/environment';
import { writable, type Readable } from 'svelte/store';

export type LibraryView = 'unified';

export const DEFAULT_LIBRARY_VIEW: LibraryView = 'unified';
export const LIBRARY_VIEW_PREFERENCE_VERSION = 1;
export const LIBRARY_VIEW_STORAGE_KEY = 'roon-controller-library-view';

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
	return value === 'unified';
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

export function resolveAvailableLibraryView(_preferred: unknown): LibraryView {
	return DEFAULT_LIBRARY_VIEW;
}

export function getAvailableLibraryViews(): readonly LibraryView[] {
	return Object.freeze([DEFAULT_LIBRARY_VIEW]);
}
