import { derived, writable } from 'svelte/store';
import type { CoreStatusResponse } from '@shared/types';
import { fetchCoreStatus } from '../api/client';

const defaultState: CoreStatusResponse = {
	status: 'discovering'
};

const internalStore = writable<CoreStatusResponse>(defaultState);

export const coreStore = {
	subscribe: internalStore.subscribe
};

export const isCorePaired = derived(coreStore, ($core) => $core.status === 'paired');

export async function loadCoreStatus(fetchFn: typeof fetch): Promise<void> {
	const status = await fetchCoreStatus(fetchFn);
	internalStore.set(status);
}

export function setCoreStatus(status: CoreStatusResponse): void {
	internalStore.set(status);
}
