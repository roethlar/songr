import { writable, type Readable } from 'svelte/store';
import type { BrowseItem, BrowseResult } from '@shared/types';
import {
	CLASSIC_BROWSE_PAGE_SIZE_MAX,
	type ClassicBrowseCommandOptions,
	type ClassicBrowseOperation
} from '@shared/classicBrowseContracts';
import {
	createClassicBrowseSessionClient,
	type ClassicBrowseSessionClaim,
	type ClassicBrowseSessionClient
} from '$lib/stores/classicBrowseSessionStore';
import { getSocket } from '$lib/socket/client';
import { emitWithAck } from '$lib/socket/emit';
import { createSecureOpaqueId } from '$lib/secureOpaqueId';

export interface RoonSettingsState {
	phase: 'idle' | 'loading' | 'ready' | 'error';
	result: BrowseResult | null;
	message: string | null;
	error: string | null;
}
export interface RoonSettingsController extends Readable<RoonSettingsState> {
	setActive(active: boolean, zoneId?: string, coreId?: string): Promise<void>;
	activate(item: BrowseItem, input?: string): Promise<void>;
	back(): Promise<void>;
	loadMore(): Promise<void>;
	retry(): Promise<void>;
	close(): void;
}
export type SettingsSessionClient = Pick<ClassicBrowseSessionClient, 'claim' | 'release' | 'request'>;

/** A separate lease avoids replacing the Library owner's active claim/cursor. */
export function createRoonSettingsSessionClient(): SettingsSessionClient {
	let identity: string | null = null;
	return createClassicBrowseSessionClient({
		getSocket,
		getTabId: () => identity ??= `settings-${createSecureOpaqueId()}`,
		createRequestId: createSecureOpaqueId,
		emit: emitWithAck
	});
}

export function createRoonSettingsController(
	client: SettingsSessionClient = createRoonSettingsSessionClient()
): RoonSettingsController {
	let state: RoonSettingsState = { phase: 'idle', result: null, message: null, error: null };
	const store = writable(state);
	let claim: ClassicBrowseSessionClaim | null = null;
	let generation = 0;
	let activeIdentity: string | null = null;
	let zone: string | undefined;
	const publish = (next: RoonSettingsState) => { state = next; store.set(next); };
	const options = () => ({ hierarchy: 'settings', ...(zone ? { zoneId: zone } : {}) });

	function close(): void {
		generation += 1;
		activeIdentity = null;
		const retired = claim;
		claim = null;
		if (retired) client.release(retired);
		publish({ phase: 'idle', result: null, message: null, error: null });
	}

	async function run(
		operation: ClassicBrowseOperation,
		request: ClassicBrowseCommandOptions,
		append = false,
		refreshAfterAction = false
	): Promise<void> {
		if (!claim || state.phase === 'loading') return;
		const currentClaim = claim;
		const token = generation;
		const previous = state.result;
		const current = () => token === generation && claim === currentClaim;
		publish({ phase: 'loading', result: previous, message: null, error: null });
		try {
			let result = await client.request<BrowseResult>(currentClaim, operation, 'classic-explore', request);
			if (!current()) return;
			let message: string | null = null;
			let error: string | null = null;
			if (result.action && result.action !== 'list') {
				if (result.isError) error = result.message ?? 'Roon could not apply this setting.';
				else message = result.message ?? (result.action === 'none' ? 'Done.' : null);
				if (refreshAfterAction) {
					// Refresh the current level; never replay the selected action or input.
					result = await client.request<BrowseResult>(currentClaim, 'browse', 'classic-explore', {
						...options(), refresh: true, pageSize: CLASSIC_BROWSE_PAGE_SIZE_MAX
					});
					if (!current()) return;
				}
				if (result.action && result.action !== 'list') {
					const finalError = error ?? (result.isError ? result.message ?? 'Roon Settings unavailable.' : null);
					publish({ phase: finalError ? 'error' : 'ready', result: previous,
						message: finalError ? null : message ?? result.message ?? 'Roon did not return a settings list.',
						error: finalError });
					return;
				}
			}
			if (append && previous) {
				if (result.offset !== previous.items.length || result.items.length === 0) {
					throw new Error('Roon did not return the next settings page.');
				}
				result = { ...result, offset: 0, items: [...previous.items, ...result.items] };
			}
			publish({ phase: error ? 'error' : 'ready', result, message, error });
		} catch (error) {
			if (!current()) return;
			publish({ phase: 'error', result: previous, message: null,
				error: error instanceof Error ? error.message : 'Roon Settings could not be loaded.' });
		}
	}

	async function setActive(active: boolean, zoneId?: string, coreId?: string): Promise<void> {
		if (!active) { if (claim || activeIdentity !== null) close(); return; }
		const identity = JSON.stringify([zoneId ?? null, coreId ?? null]);
		if (identity === activeIdentity) return;
		close();
		activeIdentity = identity;
		zone = zoneId;
		claim = client.claim('normal-shell');
		await run('browse', { ...options(), popAll: true, pageSize: CLASSIC_BROWSE_PAGE_SIZE_MAX });
	}

	return {
		subscribe: store.subscribe,
		setActive,
		close,
		activate: async (item, input) => {
			if (!item.itemKey || item.hint === 'header' || (item.inputPrompt && input === undefined)) return;
			await run('browse', { ...options(), itemKey: item.itemKey,
				...(input !== undefined ? { input } : {}), pageSize: CLASSIC_BROWSE_PAGE_SIZE_MAX }, false, true);
		},
		back: async () => {
			if (!state.result || state.result.level <= 0) return;
			await run('pop', { ...options(), levels: 1, pageSize: CLASSIC_BROWSE_PAGE_SIZE_MAX });
		},
		loadMore: async () => {
			const result = state.result;
			if (!result || result.items.length >= (result.totalCount ?? result.count)) return;
			await run('load', { ...options(), offset: result.items.length, count: CLASSIC_BROWSE_PAGE_SIZE_MAX }, true);
		},
		retry: () => run('browse', { ...options(), popAll: true, pageSize: CLASSIC_BROWSE_PAGE_SIZE_MAX })
	};
}
