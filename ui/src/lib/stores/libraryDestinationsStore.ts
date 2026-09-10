import { writable, type Readable } from 'svelte/store';
import type { BrowseResult } from '@shared/types';
import { CLASSIC_BROWSE_ID_MAX_LENGTH } from '@shared/classicBrowseContracts';
import {
	ClassicBrowseSupersededError,
	createClassicBrowseSessionClient,
	type ClassicBrowseSessionClaim,
	type ClassicBrowseSessionClient
} from './classicBrowseSessionStore';
import { getSocket } from '$lib/socket/client';
import { emitWithAck } from '$lib/socket/emit';
import { createSecureOpaqueId } from '$lib/secureOpaqueId';
import { getTabId } from '$lib/tabId';
import {
	discoverLibraryDestinations,
	createDefaultLibraryDestinationInventory,
	type LibraryDestinationInventory
} from '$lib/library/LibraryDestinations';

export interface LibraryDestinationsState {
	inventory: LibraryDestinationInventory | null;
	loading: boolean;
	error: string | null;
}

export interface LibraryDestinationsStore extends Readable<LibraryDestinationsState> {
	load(zoneId?: string): Promise<void>;
	/** Invalidate pending discovery and release only this store's separate lease. */
	reset(): void;
}

export type LibraryDestinationsSessionClient = Pick<ClassicBrowseSessionClient, 'claim' | 'release' | 'transaction'>;
export interface LibraryDestinationsDependencies {
	client?: LibraryDestinationsSessionClient;
	loadDestinations?: typeof discoverLibraryDestinations;
}

/** No socket traffic until the returned client is claimed by load(). */
export function createLibraryDestinationsSessionClient(): LibraryDestinationsSessionClient {
	let identity: string | null = null;
	return createClassicBrowseSessionClient({
		getSocket,
		getTabId: () => {
			if (identity) return identity;
			const suffix = `:inventory:${createSecureOpaqueId()}`;
			identity = `${getTabId().slice(0, CLASSIC_BROWSE_ID_MAX_LENGTH - suffix.length)}${suffix}`;
			return identity;
		},
		createRequestId: createSecureOpaqueId,
		emit: emitWithAck
	});
}

/** The owner calls load/reset when pairing, socket, zone, or page lifecycle changes. */
export function createLibraryDestinationsStore(
	dependencies: LibraryDestinationsDependencies = {}
): LibraryDestinationsStore {
	const client = dependencies.client ?? createLibraryDestinationsSessionClient();
	const discover = dependencies.loadDestinations ?? discoverLibraryDestinations;
	let state: LibraryDestinationsState = { inventory: createDefaultLibraryDestinationInventory(), loading: false, error: null };
	const store = writable<LibraryDestinationsState>(state);
	const publish = (next: LibraryDestinationsState) => { state = next; store.set(next); };
	let zoneContext: { zoneId: string | undefined } | null = null;
	let generation = 0;
	let claim: ClassicBrowseSessionClaim | null = null;
	let pending: { zoneId: string | undefined; promise: Promise<void> } | null = null;

	function retire(): void {
		generation++;
		const retired = claim;
		claim = null;
		pending = null;
		if (retired) client.release(retired);
	}

	function reset(): void {
		retire();
		zoneContext = null;
		publish({ inventory: createDefaultLibraryDestinationInventory(), loading: false, error: null });
	}

	function load(zoneId?: string): Promise<void> {
		if (pending && pending.zoneId === zoneId) return pending.promise;
		const retained = zoneContext?.zoneId === zoneId && zoneContext !== null
			? state.inventory : createDefaultLibraryDestinationInventory();
		retire();
		zoneContext = { zoneId };
		const token = generation;
		publish({ inventory: retained, loading: true, error: null });
		const promise = (async () => {
			let owned: ClassicBrowseSessionClaim | null = null;
			const current = () => token === generation && owned !== null && claim === owned;
			try {
				owned = client.claim('normal-shell');
				claim = owned;
				const inventory = await client.transaction(owned, 'classic-explore', async (transaction) => {
					const request = async (operation: 'browse' | 'load', options: Parameters<typeof transaction.request>[1]) => {
						if (!current()) throw new ClassicBrowseSupersededError();
						const result = await transaction.request<BrowseResult>(operation, options);
						if (!current()) throw new ClassicBrowseSupersededError();
						return result;
					};
					return discover({
						browse: (options) => request('browse', options),
						browseLoad: (options) => request('load', options)
					}, { zoneId });
				});
				if (current()) {
					let visibleInventory = inventory;
					if (retained && inventory.diagnostics.some((diagnostic) => diagnostic.branch === 'root')) {
						visibleInventory = { ...retained, diagnostics: inventory.diagnostics };
					} else if (retained && inventory.diagnostics.some((diagnostic) => diagnostic.branch === 'Library')) {
						const destinations = new Map(inventory.destinations.map((destination) => [destination.id, destination]));
						for (const destination of retained.destinations) {
							if (destination.snapshot.history.length !== 2
								|| destination.snapshot.history[0].breadcrumb.title.trim().toLowerCase() !== 'library') continue;
							// A freshly returned root path is authoritative; otherwise retain
							// the previous Library child until its container can be read again.
							if (destinations.get(destination.id)?.snapshot.history.length !== 1) destinations.set(destination.id, destination);
						}
						visibleInventory = { ...inventory, destinations: [...destinations.values()] };
					}
					publish({ inventory: visibleInventory, loading: false, error: null });
				}
			} catch (error) {
				if (token !== generation) return;
				publish({ inventory: retained, loading: false,
					error: error instanceof Error ? error.message : 'Roon collections could not be loaded.' });
			} finally {
				if (owned && claim === owned) { claim = null; client.release(owned); }
				if (token === generation) pending = null;
			}
		})();
		pending = { zoneId, promise };
		// claim() can fail synchronously, before the async body's finally runs.
		void promise.then(() => { if (pending?.promise === promise) pending = null; });
		return promise;
	}

	return { subscribe: store.subscribe, load, reset };
}

/** Shared owner-facing store; creating it does not acquire a session. */
export const libraryDestinationsStore = createLibraryDestinationsStore();
