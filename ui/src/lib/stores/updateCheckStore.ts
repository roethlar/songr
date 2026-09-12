import { get, writable } from 'svelte/store';
import type { UpdateCheckResult } from '@shared/updateCheck';

interface UpdateCheckState {
	currentVersion: string | null;
	loadingVersion: boolean;
	checking: boolean;
	result: UpdateCheckResult | null;
	error: string | null;
}
const initial = (): UpdateCheckState => ({ currentVersion: null, loadingVersion: false, checking: false, result: null, error: null });
const failureMessage = 'Could not check for updates. Please try again.';

function isResult(value: unknown): value is UpdateCheckResult {
	if (typeof value !== 'object' || value === null) return false;
	const r = value as Partial<UpdateCheckResult>;
	if (typeof r.currentVersion !== 'string' || !r.currentVersion ||
		typeof r.checkedAt !== 'string' || !Number.isFinite(Date.parse(r.checkedAt)) ||
		!['update-available', 'current', 'ahead', 'no-release', 'unavailable'].includes(r.status ?? '')) return false;
	if (r.message !== undefined && typeof r.message !== 'string') return false;
	if (r.status === 'unavailable' || r.status === 'no-release') return r.latestVersion === null && r.releaseUrl === null;
	return typeof r.latestVersion === 'string' && !!r.latestVersion && typeof r.releaseUrl === 'string' &&
		/^https:\/\/github\.com\/roethlar\/songr\/releases\/(?:latest|tag\/(?:[A-Za-z0-9.+_-]|%2[Bb])+)$/.test(r.releaseUrl);
}

/** This store describes only the connected server. Electron checks itself. */
export function createUpdateCheckStore() {
	const state = writable<UpdateCheckState>(initial());
	let generation = 0;

	async function request(fetchFn: typeof fetch, path: string, method = 'GET'): Promise<Response> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 8_000);
		try {
			// Read the body while the timeout is active, including a stalled body.
			const response = await fetchFn(path, { method, cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
			const body = await response.text();
			return new Response(body, { status: response.status, headers: { 'content-type': 'application/json' } });
		} finally { clearTimeout(timer); }
	}

	return {
		subscribe: state.subscribe,
		async loadVersion(fetchFn: typeof fetch = fetch): Promise<void> {
			if (get(state).checking || get(state).loadingVersion) return;
			const ticket = ++generation;
			state.update(s => ({ ...s, loadingVersion: true }));
			try {
				const response = await request(fetchFn, '/api/updates');
				const value = await response.json();
				if (!response.ok || typeof value?.currentVersion !== 'string' || !value.currentVersion) throw new Error('Missing server version');
				if (ticket !== generation) return;
				state.update(s => ({ ...s, currentVersion: value.currentVersion,
					result: s.currentVersion === value.currentVersion ? s.result : null }));
			} catch {
				if (ticket === generation) state.update(s => ({ ...s, currentVersion: null, result: null }));
			} finally {
				if (ticket === generation) state.update(s => ({ ...s, loadingVersion: false }));
			}
		},
		async check(fetchFn: typeof fetch = fetch): Promise<void> {
			if (get(state).checking) return;
			const ticket = ++generation;
			state.update(s => ({ ...s, checking: true, loadingVersion: false, result: null, error: null }));
			try {
				const response = await request(fetchFn, '/api/updates/check', 'POST');
				const result: unknown = await response.json();
				if (!isResult(result) || (!response.ok && !(response.status === 503 && result.status === 'unavailable'))) throw new Error('Invalid update response');
				if (ticket !== generation) return;
				state.update(s => ({ ...s, currentVersion: result.currentVersion, result,
					error: result.status === 'unavailable' ? result.message || failureMessage : null }));
			} catch {
				if (ticket === generation) state.update(s => ({ ...s, result: null, error: failureMessage }));
			} finally {
				if (ticket === generation) state.update(s => ({ ...s, checking: false }));
			}
		},
		reset(): void { generation++; state.set(initial()); }
	};
}
export type UpdateCheckStore = ReturnType<typeof createUpdateCheckStore>;
export const updateCheckStore = createUpdateCheckStore();
