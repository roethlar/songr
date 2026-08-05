export type LibraryEntityIntentKind = 'artist' | 'album' | 'track';

export interface LibraryIntentDisplay {
	readonly title: string;
	readonly artist?: string;
	readonly album?: string;
}

export type LibraryIntent =
	| {
			readonly kind: LibraryEntityIntentKind;
			readonly destination: 'search';
			readonly query: string;
			readonly localDescriptorId?: string;
			readonly display?: LibraryIntentDisplay;
	  }
	| {
			readonly kind: 'general';
			readonly destination: 'search';
			readonly query: string;
			readonly display?: Readonly<Pick<LibraryIntentDisplay, 'title'>>;
	  }
	| {
			readonly kind: 'general';
			readonly destination: 'welcome-section';
			readonly section: 'favorites' | 'recently-played';
	  }
	| {
			readonly kind: 'general';
			readonly destination: 'explore-path';
			readonly labelPath: readonly string[];
	  }
	| {
			readonly kind: 'general';
			readonly destination: 'search-category';
			readonly query: string;
			readonly categoryTitle: string;
	  };

type UnknownRecord = Record<string, unknown>;

const ENTITY_KINDS = new Set<LibraryEntityIntentKind>(['artist', 'album', 'track']);
const WELCOME_SECTIONS = new Set(['favorites', 'recently-played']);

function isRecord(value: unknown): value is UnknownRecord {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(
	record: UnknownRecord,
	required: readonly string[],
	optional: readonly string[] = []
): boolean {
	const ownKeys = Reflect.ownKeys(record);
	if (ownKeys.some((key) => typeof key !== 'string')) return false;
	const keys = ownKeys as string[];
	if (keys.length < required.length || keys.length > required.length + optional.length) {
		return false;
	}
	const allowed = new Set([...required, ...optional]);
	return required.every((key) => Object.prototype.hasOwnProperty.call(record, key)) &&
		keys.every((key) => allowed.has(key));
}

function normalizedText(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : null;
}

function normalizeEntityDisplay(value: unknown): LibraryIntentDisplay | null {
	if (!isRecord(value) || !hasExactKeys(value, ['title'], ['artist', 'album'])) return null;
	const title = normalizedText(value.title);
	if (!title) return null;

	const artist = value.artist === undefined ? undefined : normalizedText(value.artist);
	const album = value.album === undefined ? undefined : normalizedText(value.album);
	if (value.artist !== undefined && !artist) return null;
	if (value.album !== undefined && !album) return null;

	return Object.freeze({
		title,
		...(artist ? { artist } : {}),
		...(album ? { album } : {})
	});
}

function normalizeGeneralDisplay(
	value: unknown
): Readonly<Pick<LibraryIntentDisplay, 'title'>> | null {
	if (!isRecord(value) || !hasExactKeys(value, ['title'])) return null;
	const title = normalizedText(value.title);
	return title ? Object.freeze({ title }) : null;
}

/**
 * Convert an untrusted value into the keyless cross-mode Library contract.
 * Exact-key validation prevents stale Roon authority or executable callbacks
 * from hitching a ride beside otherwise-valid semantic fields.
 */
export function normalizeLibraryIntent(value: unknown): LibraryIntent | null {
	if (!isRecord(value)) return null;

	if (ENTITY_KINDS.has(value.kind as LibraryEntityIntentKind)) {
		if (
			value.destination !== 'search' ||
			!hasExactKeys(value, ['kind', 'destination', 'query'], ['localDescriptorId', 'display'])
		) {
			return null;
		}
		const query = normalizedText(value.query);
		if (!query) return null;

		const localDescriptorId =
			value.localDescriptorId === undefined ? undefined : normalizedText(value.localDescriptorId);
		if (value.localDescriptorId !== undefined && !localDescriptorId) return null;

		const display = value.display === undefined ? undefined : normalizeEntityDisplay(value.display);
		if (value.display !== undefined && !display) return null;

		return Object.freeze({
			kind: value.kind as LibraryEntityIntentKind,
			destination: 'search',
			query,
			...(localDescriptorId ? { localDescriptorId } : {}),
			...(display ? { display } : {})
		});
	}

	if (value.kind !== 'general' || typeof value.destination !== 'string') return null;

	switch (value.destination) {
		case 'search': {
			if (!hasExactKeys(value, ['kind', 'destination', 'query'], ['display'])) return null;
			const query = normalizedText(value.query);
			if (!query) return null;
			const display = value.display === undefined ? undefined : normalizeGeneralDisplay(value.display);
			if (value.display !== undefined && !display) return null;
			return Object.freeze({
				kind: 'general',
				destination: 'search',
				query,
				...(display ? { display } : {})
			});
		}
		case 'welcome-section':
			if (
				!hasExactKeys(value, ['kind', 'destination', 'section']) ||
				!WELCOME_SECTIONS.has(value.section as string)
			) {
				return null;
			}
			return Object.freeze({
				kind: 'general',
				destination: 'welcome-section',
				section: value.section as 'favorites' | 'recently-played'
			});
		case 'explore-path': {
			if (
				!hasExactKeys(value, ['kind', 'destination', 'labelPath']) ||
				!Array.isArray(value.labelPath) ||
				value.labelPath.length === 0
			) {
				return null;
			}
			// Array#map preserves holes, and Array#some skips them. Array.from
			// visits every index so sparse arrays cannot masquerade as a
			// readonly string path and later yield `undefined` to the resolver.
			const labelPath = Array.from(value.labelPath, normalizedText);
			if (labelPath.some((label) => label === null)) return null;
			return Object.freeze({
				kind: 'general',
				destination: 'explore-path',
				labelPath: Object.freeze(labelPath as string[])
			});
		}
		case 'search-category': {
			if (!hasExactKeys(value, ['kind', 'destination', 'query', 'categoryTitle'])) {
				return null;
			}
			const query = normalizedText(value.query);
			const categoryTitle = normalizedText(value.categoryTitle);
			if (!query || !categoryTitle) return null;
			return Object.freeze({
				kind: 'general',
				destination: 'search-category',
				query,
				categoryTitle
			});
		}
		default:
			return null;
	}
}
