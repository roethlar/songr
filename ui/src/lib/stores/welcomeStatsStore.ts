import { writable } from 'svelte/store';
import type { BrowseResult } from '@shared/types';
import {
	withClassicBrowseRoleTransaction,
	type ClassicBrowseApiTransaction
} from '../api/client';
import {
	classicBrowseSessionClient,
	ClassicBrowseSupersededError,
	type ClassicBrowseSessionClaim
} from './classicBrowseSessionStore';

/**
 * Library-stat tiles for the welcome view (Hi-Michael-style header
 * in native Roon). Roon's public extension API exposes the totals
 * via dedicated hierarchies (`artists`, `albums`, `composers`) — a
 * single `popAll: true` browse call returns `totalCount` at level 0
 * without paginating through items.
 *
 * `tracks` isn't in the documented hierarchy list. Resolve it only through
 * the supported `browse → Library → Tracks` path: a rejected coordinator
 * command retires the whole Classic session, so probing an unsupported
 * hierarchy would turn a harmless statistic into a recovery loop. The
 * Library page renders `—` when a total cannot be resolved.
 *
 * Like exploreRailStore, every browse call uses the coordinator-owned
 * Classic Explore role so the stats fetch cannot disturb the user's
 * main browse or search stacks.
 */

export interface WelcomeStats {
	artists: number | null;
	albums: number | null;
	tracks: number | null;
	composers: number | null;
}

export interface WelcomeStatsState extends WelcomeStats {
	loading: boolean;
	loaded: boolean;
}

const initialState: WelcomeStatsState = {
	artists: null,
	albums: null,
	tracks: null,
	composers: null,
	loading: false,
	loaded: false
};

const internalStore = writable<WelcomeStatsState>(initialState);

let resolveToken = 0;

export const welcomeStatsStore = {
	subscribe: internalStore.subscribe
};

async function fetchTotal(
	claim: ClassicBrowseSessionClaim,
	hierarchy: string
): Promise<number | null> {
	try {
		return await withClassicBrowseRoleTransaction(
			'classic-explore',
			claim,
			async (transaction) => {
				const result: BrowseResult = await transaction.browse({
					hierarchy,
					popAll: true
				});
				return result.totalCount ?? result.count ?? null;
			}
		);
	} catch {
		return null;
	}
}

async function fetchTracksTotal(
	claim: ClassicBrowseSessionClaim
): Promise<number | null> {
	try {
		return await withClassicBrowseRoleTransaction(
			'classic-explore',
			claim,
			async (transaction: ClassicBrowseApiTransaction) => {
				const root = await transaction.browse({
					hierarchy: 'browse',
					popAll: true
				});
				const library = root.items.find((it) => it.title === 'Library');
				if (!library?.itemKey) return null;

				const libContents = await transaction.browse({
					hierarchy: 'browse',
					itemKey: library.itemKey
				});
				const tracks = libContents.items.find((it) => it.title === 'Tracks');
				if (!tracks?.itemKey) return null;

				const tracksList = await transaction.browse({
					hierarchy: 'browse',
					itemKey: tracks.itemKey
				});
				return tracksList.totalCount ?? tracksList.count ?? null;
			}
		);
	} catch {
		return null;
	}
}

/**
 * Load all four library totals in independent Explore-role transactions.
 * Requests are deliberately sequential on the shared coordinator role.
 * Resolve token guards against `core-status` flap producing a stale completion
 * that overwrites a newer success (same pattern as exploreRailStore).
 */
export async function loadWelcomeStats(
	_fetchFn: typeof fetch,
	claim: ClassicBrowseSessionClaim
): Promise<void> {
	const myToken = ++resolveToken;
	internalStore.update((s) => ({ ...s, loading: true }));

	try {
		const artists = await fetchTotal(claim, 'artists');
		const albums = await fetchTotal(claim, 'albums');
		const composers = await fetchTotal(claim, 'composers');
		const tracks = await fetchTracksTotal(claim);

		if (myToken !== resolveToken) return;
		if (!classicBrowseSessionClient.isClaimCurrent(claim)) {
			throw new ClassicBrowseSupersededError();
		}

		internalStore.set({
			artists,
			albums,
			tracks,
			composers,
			loading: false,
			loaded: true
		});
	} catch {
		if (myToken !== resolveToken) return;
		// Session loss can reject before the transaction callback begins.
		// Keep the store retryable and avoid an unhandled rejection from the
		// fire-and-forget lifecycle callers; a later fresh generation reloads it.
		internalStore.update((state) => ({ ...state, loading: false, loaded: false }));
	}
}

export function invalidateWelcomeStats(): void {
	resolveToken++;
	internalStore.set({ ...initialState });
}
