import { writable } from 'svelte/store';
import type { AddFavoriteRequest } from '@shared/types';

/** Save the user's metadata snapshot in list order, independently of Roon sessions. */
export function createBookmarkActions(saveEntry: (entry: AddFavoriteRequest) => Promise<void>) {
	const state = writable({ busy: false, status: null as string | null });
	let saving = false;
	return {
		subscribe: state.subscribe,
		clearStatus() { if (!saving) state.set({ busy: false, status: null }); },
		async save(entries: readonly AddFavoriteRequest[]): Promise<void> {
			if (saving || entries.length === 0) return;
			const snapshot = entries.map(entry => ({ ...entry }));
			saving = true;
			state.set({ busy: true, status: `Saving ${snapshot.length.toLocaleString()} bookmarks…` });
			let saved = 0;
			try {
				for (const entry of snapshot) {
					await saveEntry(entry);
					saved++;
				}
				state.set({ busy: false, status: saved === 1 ? 'Bookmarked.' : `Bookmarked ${saved.toLocaleString()} items.` });
			} catch (error) {
				state.set({ busy: false, status: `${saved.toLocaleString()} saved. ${error instanceof Error ? error.message : 'Could not save bookmarks.'}` });
			} finally {
				saving = false;
			}
		}
	};
}
