import { writable, type Readable } from 'svelte/store';
import { buildApiRequestInit } from '@shared/apiRequest';
import {
	DEFAULT_NAVIGATION_SETTINGS,
	MAX_CUSTOM_NAVIGATION_DESTINATIONS,
	isNavigationDestinationId,
	parseNavigationSettingsSnapshot,
	parseNavigationSettingsUpdate,
	type NavigationDestinationId,
	type NavigationSettingsSnapshot
} from '@shared/navigationSettings';

const ENDPOINT = '/api/settings/navigation';
const INITIAL_DESTINATIONS: readonly NavigationDestinationId[] = [
	'artists', 'albums', 'genres', 'tracks', 'composers', 'tags', 'internet-radio', 'recently-played', 'favorites', 'surprise'
];
type Choices = Pick<NavigationSettingsSnapshot, 'order' | 'pinned'>;

export interface NavigationSettingsState {
	readonly snapshot: NavigationSettingsSnapshot | null;
	readonly availableDestinations: readonly NavigationDestinationId[];
	readonly loading: boolean;
	readonly saving: boolean;
	readonly error: string | null;
	readonly notice: string | null;
}

export interface NavigationSettingsStore extends Readable<NavigationSettingsState> {
	load(fetchFn?: typeof fetch): Promise<void>;
	applySnapshot(value: unknown): boolean;
	setAvailableDestinations(ids: readonly NavigationDestinationId[]): void;
	getCapabilities(): readonly NavigationDestinationId[];
	setPinned(id: NavigationDestinationId, pinned: boolean, fetchFn?: typeof fetch): Promise<boolean>;
	move(id: NavigationDestinationId, direction: 'earlier' | 'later', fetchFn?: typeof fetch): Promise<boolean>;
	resetDefaults(fetchFn?: typeof fetch): Promise<boolean>;
	/** Retire pending responses when the server context is discarded. */
	reset(): void;
}

function initialState(): NavigationSettingsState {
	return { snapshot: null, availableDestinations: [...INITIAL_DESTINATIONS],
		loading: false, saving: false, error: null, notice: null };
}

function responseError(body: unknown, fallback: string): string {
	return body !== null && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
		? body.error : fallback;
}

/** Server snapshots are the only authority. This store never writes browser storage. */
export function createNavigationSettingsStore(): NavigationSettingsStore {
	let state = initialState();
	const internal = writable(state);
	let generation = 0, readSequence = 0, messageSequence = 0;
	function publish(update: Partial<NavigationSettingsState>): void {
		state = { ...state, ...update };
		internal.set(state);
	}
	function applySnapshot(value: unknown): boolean {
		const snapshot = parseNavigationSettingsSnapshot(value);
		if (snapshot === null || (state.snapshot !== null && snapshot.revision <= state.snapshot.revision)) return false;
		publish({ snapshot });
		return true;
	}
	async function load(fetchFn: typeof fetch = fetch): Promise<void> {
		const currentGeneration = generation, sequence = ++readSequence;
		const message = state.saving ? null : ++messageSequence;
		publish({ loading: true, ...(!state.saving ? { error: null, notice: null } : {}) });
		try {
			const response = await fetchFn(ENDPOINT, buildApiRequestInit({ cache: 'no-store' }));
			const body: unknown = await response.json().catch(() => null);
			if (!response.ok) throw new Error(responseError(body, 'The server could not load navigation settings.'));
			const snapshot = parseNavigationSettingsSnapshot(body);
			if (snapshot === null) throw new Error('The server returned invalid navigation settings.');
			if (currentGeneration !== generation) return;
			applySnapshot(snapshot);
		} catch (error) {
			if (currentGeneration === generation && sequence === readSequence && message === messageSequence) {
				publish({ error: `Could not load navigation settings. ${error instanceof Error ? error.message : 'Try again.'}` });
			}
		} finally {
			if (currentGeneration === generation && sequence === readSequence) publish({ loading: false });
		}
	}
	async function save(choices: Choices, fetchFn: typeof fetch): Promise<boolean> {
		if (state.saving) return false;
		if (state.snapshot === null) {
			publish({ error: 'Load navigation settings from the server before changing them.' });
			return false;
		}
		const update = parseNavigationSettingsUpdate({ expectedRevision: state.snapshot.revision, order: choices.order, pinned: choices.pinned });
		if (update === null) {
			messageSequence += 1;
			const exceedsCapacity = choices.order.filter(id => id.startsWith('public:')).length > MAX_CUSTOM_NAVIGATION_DESTINATIONS;
			publish({ error: exceedsCapacity
				? `Navigation changes were not saved. You can save up to ${MAX_CUSTOM_NAVIGATION_DESTINATIONS} custom library pages.`
				: 'Navigation changes were not saved. These navigation choices are invalid.', notice: null });
			return false;
		}
		const currentGeneration = generation, message = ++messageSequence;
		publish({ saving: true, error: null, notice: null });
		try {
			const response = await fetchFn(ENDPOINT, buildApiRequestInit({ method: 'PUT', body: JSON.stringify(update) }));
			const body: unknown = await response.json().catch(() => null);
			if (currentGeneration !== generation) return false;
			if (response.status === 409) {
				const current = body !== null && typeof body === 'object' && 'current' in body
					? parseNavigationSettingsSnapshot(body.current) : null;
				if (current === null) throw new Error('The server returned an invalid conflict response. Reload and try again.');
				applySnapshot(current);
				publish({ notice: 'Navigation changed on another client. The current server choices are shown; your change was not saved. Try again.' });
				return false;
			}
			if (!response.ok) throw new Error(responseError(body, 'The server could not save these choices.'));
			const snapshot = parseNavigationSettingsSnapshot(body);
			if (snapshot === null || snapshot.revision < update.expectedRevision) {
				throw new Error('The server did not confirm valid navigation settings.');
			}
			applySnapshot(snapshot);
			return true;
		} catch (error) {
			if (currentGeneration === generation && message === messageSequence) {
				publish({ error: `Navigation changes were not saved. ${error instanceof Error ? error.message : 'Try again.'}` });
			}
			return false;
		} finally {
			if (currentGeneration === generation) publish({ saving: false });
		}
	}
	function setAvailableDestinations(ids: readonly NavigationDestinationId[]): void {
		const availableDestinations = [...new Set(ids.filter(isNavigationDestinationId))];
		if (availableDestinations.length === state.availableDestinations.length &&
			availableDestinations.every((id, index) => id === state.availableDestinations[index])) return;
		publish({ availableDestinations });
	}
	function availableOrder(): NavigationDestinationId[] {
		return [...new Set([...(state.snapshot?.order ?? DEFAULT_NAVIGATION_SETTINGS.order), ...state.availableDestinations])];
	}
	async function setPinned(id: NavigationDestinationId, pinned: boolean, fetchFn: typeof fetch = fetch): Promise<boolean> {
		if (!state.snapshot || !state.availableDestinations.includes(id)) return false;
		const prior = state.snapshot;
		if (prior.pinned.includes(id) === pinned) return true;
		// Discovery is presentation state. Pinning one page must not persist all
		// unrelated discoveries or prevent edits to an already full saved order.
		const order = prior.order.includes(id) ? prior.order : [...prior.order, id];
		return save({ order, pinned: pinned ? [...prior.pinned, id] : prior.pinned.filter(value => value !== id) }, fetchFn);
	}
	async function move(id: NavigationDestinationId, direction: 'earlier' | 'later', fetchFn: typeof fetch = fetch): Promise<boolean> {
		if (!state.snapshot) return false;
		const order = availableOrder();
		const available = order.filter(value => state.availableDestinations.includes(value));
		const index = available.indexOf(id), neighbor = available[index + (direction === 'earlier' ? -1 : 1)];
		if (index === -1 || neighbor === undefined) return false;
		const from = order.indexOf(id), to = order.indexOf(neighbor);
		[order[from], order[to]] = [order[to], order[from]];
		// New destinations appear after the saved order. Retain only the prefix
		// needed for this move, including its neighbor; later discoveries stay
		// unsaved. Keeping earlier new rows prevents a one-row move from also
		// moving every preceding unsaved destination to the end on confirmation.
		const requiredThrough = Math.max(from, to);
		const savedOrder = order.filter((value, position) => position <= requiredThrough || state.snapshot!.order.includes(value));
		return save({ order: savedOrder, pinned: state.snapshot.pinned }, fetchFn);
	}
	function reset(): void {
		generation += 1; readSequence += 1; messageSequence += 1;
		state = initialState(); internal.set(state);
	}
	return { subscribe: internal.subscribe, load, applySnapshot, setAvailableDestinations,
		getCapabilities: () => [...state.availableDestinations], setPinned, move,
		resetDefaults: (fetchFn: typeof fetch = fetch) => save(DEFAULT_NAVIGATION_SETTINGS, fetchFn), reset };
}

export const navigationSettingsStore = createNavigationSettingsStore();
export const loadNavigationSettings = (fetchFn: typeof fetch): Promise<void> => navigationSettingsStore.load(fetchFn);
export const applyNavigationSettings = (value: unknown): boolean => navigationSettingsStore.applySnapshot(value);
