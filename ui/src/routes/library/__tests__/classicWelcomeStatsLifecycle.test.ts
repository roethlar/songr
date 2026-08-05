import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/svelte';
import { get } from 'svelte/store';
import { tick } from 'svelte';
import type { BrowseItem, BrowseResult } from '@shared/types';

import { createFakeSocket } from '../../../test/fixtures/socket';

const fakeSocket = createFakeSocket();

vi.mock('$lib/socket/client', () => ({
	getSocket: () => fakeSocket,
	disconnectSocket: vi.fn()
}));

vi.mock('$lib/stores/exploreRailStore', async (importOriginal) => {
	const original = await importOriginal<typeof import('$lib/stores/exploreRailStore')>();
	return {
		...original,
		resolveExploreRail: vi.fn(async () => undefined)
	};
});

import ClassicLibraryMode from '../ClassicLibraryMode.svelte';
import { resetBrowse } from '$lib/stores/browseStore';
import { resetHistory } from '$lib/stores/browseHistoryStore';
import { loadFavorites, resetFavorites } from '$lib/stores/favoritesStore';
import { resetLibraryIntentStore } from '$lib/stores/libraryIntentStore';
import {
	classicBrowseSessionClient
} from '$lib/stores/classicBrowseSessionStore';
import {
	invalidateWelcomeStats,
	welcomeStatsStore
} from '$lib/stores/welcomeStatsStore';

function listResult(over: Partial<BrowseResult> = {}): BrowseResult {
	return {
		title: over.title ?? 'Browse',
		subtitle: over.subtitle,
		level: over.level ?? 0,
		offset: over.offset ?? 0,
		count: over.count ?? 0,
		totalCount: over.totalCount ?? 0,
		items: over.items ?? []
	};
}

function listItem(title: string, itemKey: string): BrowseItem {
	return {
		title,
		itemKey,
		hint: 'list',
		isLoadable: true,
		isPlayable: false
	};
}

function commandResult(options: Record<string, unknown>): BrowseResult {
	if (options.hierarchy === 'artists') return listResult({ totalCount: 1_667 });
	if (options.hierarchy === 'albums') return listResult({ totalCount: 3_962 });
	if (options.hierarchy === 'composers') return listResult({ totalCount: 9_455 });
	if (options.hierarchy === 'browse' && options.popAll === true) {
		return listResult({ items: [listItem('Library', 'library-key')] });
	}
	if (options.hierarchy === 'browse' && options.itemKey === 'library-key') {
		return listResult({ items: [listItem('Tracks', 'tracks-key')] });
	}
	if (options.hierarchy === 'browse' && options.itemKey === 'tracks-key') {
		return listResult({ totalCount: 57_583 });
	}
	throw new Error(`Unexpected Classic browse command: ${JSON.stringify(options)}`);
}

beforeEach(async () => {
	fakeSocket.connected = true;
	fakeSocket.emit.mockReset();
	fakeSocket.timeout.mockClear();
	fakeSocket.on.mockReset();
	fakeSocket.off.mockReset();
	resetBrowse();
	resetHistory();
	resetFavorites();
	resetLibraryIntentStore();
	invalidateWelcomeStats();
	await loadFavorites(
		vi.fn(async () =>
			new Response(JSON.stringify({ entries: [] }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			})
		) as unknown as typeof fetch
	);
});

afterEach(() => {
	invalidateWelcomeStats();
});

describe('Classic welcome statistics lifecycle', () => {
	it('uses the supported Tracks path without retiring or reacquiring the mounted Classic session', async () => {
		let acquisition = 0;
		const browseOptions: Record<string, unknown>[] = [];
		const initialLifecycleGeneration = get(classicBrowseSessionClient).lifecycleGeneration;
		fakeSocket.emit.mockImplementation((event, payload, ack) => {
			if (typeof ack !== 'function') return;
			if (event === 'classic-session:acquire') {
				acquisition += 1;
				if (acquisition > 1) {
					ack({ success: false, error: 'Unexpected Classic reacquire', code: 'SESSION_LOST' });
					return;
				}
				ack({
					success: true,
					data: {
						requestId: payload.requestId,
						session: { handleId: 'welcome-stats-session', generation: 1 }
					}
				});
				return;
			}
			if (event === 'classic-session:release') {
				ack({ success: true, data: { requestId: payload.requestId } });
				return;
			}
			if (event !== 'browse:browse') return;
			browseOptions.push(payload.options);
			if (payload.options.hierarchy === 'tracks') {
				ack({ success: false, error: 'Unsupported hierarchy', code: 'INTERNAL_ERROR' });
				return;
			}
			ack({
				success: true,
				data: {
					requestId: payload.requestId,
					session: payload.session,
					result: commandResult(payload.options)
				}
			});
		});

		const view = render(ClassicLibraryMode, { props: { restoreOnMount: false } });
		const initialShell = view.container.querySelector('.library-shell');
		expect(initialShell).not.toBeNull();

		try {
			await waitFor(() => expect(browseOptions.length).toBeGreaterThanOrEqual(4));
			expect(browseOptions.some((options) => options.hierarchy === 'tracks')).toBe(false);
			await waitFor(() => {
				expect(get(welcomeStatsStore)).toMatchObject({
					tracks: 57_583,
					loading: false,
					loaded: true
				});
			});
			expect(browseOptions).toEqual([
				{ hierarchy: 'artists', popAll: true },
				{ hierarchy: 'albums', popAll: true },
				{ hierarchy: 'composers', popAll: true },
				{ hierarchy: 'browse', popAll: true },
				{ hierarchy: 'browse', itemKey: 'library-key' },
				{ hierarchy: 'browse', itemKey: 'tracks-key' }
			]);
			expect(acquisition).toBe(1);
			expect(
				fakeSocket.emit.mock.calls.filter(([event]) => event === 'classic-session:release')
			).toHaveLength(0);
			const settledSession = get(classicBrowseSessionClient);
			expect(settledSession).toMatchObject({
				owner: 'classic-mode',
				phase: 'live'
			});
			// Claiming authority and acquiring its session are the two expected
			// lifecycle boundaries. The welcome-stat requests must add no more.
			expect(settledSession.lifecycleGeneration).toBe(initialLifecycleGeneration + 2);
			expect(view.container.querySelector('.library-shell')).toBe(initialShell);
			expect(screen.getByText('57,583')).toBeInTheDocument();

			await tick();
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(acquisition).toBe(1);
			expect(get(classicBrowseSessionClient).lifecycleGeneration).toBe(
				settledSession.lifecycleGeneration
			);
			expect(view.container.querySelector('.library-shell')).toBe(initialShell);
		} finally {
			view.unmount();
		}
	});
});
